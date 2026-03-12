// Bilibili Feed History — Content Script
// Captures feed cards from Bilibili homepage and injects backtrack controls

(function () {
    'use strict';

    const SELECTORS = {
        container: '.container.is-version8',
        swipe: '.recommended-swipe',
        feedCard: '.feed-card',
        rollBtn: '.primary-btn.roll-btn'
    };

    let backtrackIndex = -1; // -1 = showing live feed
    let historyCache = [];
    let isCapturing = false;
    let observer = null;
    let backtrackBtn = null;
    let forwardBtn = null;
    let backtrackCountEl = null;
    let lastCapturedFingerprint = ''; // dedup: skip identical snapshots
    let initialCaptured = false;       // only auto-capture once on page load
    let debounceTimer = null;          // debounce MutationObserver

    // ──────────────────────────────────────
    // Feed Card Data Extraction
    // ──────────────────────────────────────

    function extractCardData(cardEl) {
        const data = {};

        // Raw HTML — for pixel-perfect backtrack restoration
        data.html = cardEl.outerHTML;

        // Title
        const titleEl = cardEl.querySelector('.bili-video-card__info--tit a') ||
            cardEl.querySelector('.bili-video-card__info--tit') ||
            cardEl.querySelector('[title]');
        data.title = titleEl?.getAttribute('title') || titleEl?.textContent?.trim() || '';

        // URL
        const linkEl = cardEl.querySelector('a[href*="/video/"]') ||
            cardEl.querySelector('a[href*="bilibili.com"]') ||
            cardEl.querySelector('a');
        data.url = linkEl?.href || '';

        // Cover image
        const imgEl = cardEl.querySelector('.bili-video-card__cover img') ||
            cardEl.querySelector('.v-img img') ||
            cardEl.querySelector('img');
        data.cover = imgEl?.src || imgEl?.getAttribute('data-src') || '';

        // Author / UP
        const authorEl = cardEl.querySelector('.bili-video-card__info--author') ||
            cardEl.querySelector('.bili-video-card__info--owner span');
        data.author = authorEl?.textContent?.trim() || '';

        // Play count
        const playEl = cardEl.querySelector('.bili-video-card__stats--item:first-child span') ||
            cardEl.querySelector('.bili-video-card__stats--text');
        data.play = playEl?.textContent?.trim() || '';

        // Danmaku count
        const danmakuEl = cardEl.querySelector('.bili-video-card__stats--item:nth-child(2) span');
        data.danmaku = danmakuEl?.textContent?.trim() || '';

        // Duration
        const durationEl = cardEl.querySelector('.bili-video-card__stats__duration');
        data.duration = durationEl?.textContent?.trim() || '';

        return data;
    }

    /**
     * Generate a fingerprint from card data for deduplication.
     * Uses titles + URLs to detect identical feed sets.
     */
    function generateFingerprint(cardDataList) {
        return cardDataList.map(c => `${c.title}|${c.url}`).join(';;');
    }

    function captureFeedCards() {
        if (isCapturing) return;
        isCapturing = true;

        const cards = document.querySelectorAll(
            `${SELECTORS.container} ${SELECTORS.feedCard}`
        );

        if (cards.length === 0) {
            isCapturing = false;
            return;
        }

        const cardDataList = Array.from(cards).map(extractCardData).filter(c => c.title);

        if (cardDataList.length === 0) {
            isCapturing = false;
            return;
        }

        // Dedup: skip if identical to the last captured snapshot
        const fingerprint = generateFingerprint(cardDataList);
        if (fingerprint === lastCapturedFingerprint) {
            isCapturing = false;
            return;
        }

        // Send to background for persistence
        chrome.runtime.sendMessage(
            { type: 'SAVE_SNAPSHOT', data: { cards: cardDataList } },
            (response) => {
                if (response?.success) {
                    lastCapturedFingerprint = fingerprint;
                    console.log(`[BiliHistory] Saved ${cardDataList.length} cards (total: ${response.total})`);
                    backtrackIndex = -1;
                    refreshHistoryCache();
                    updateBacktrackUI();
                }
                isCapturing = false;
            }
        );
    }

    // ──────────────────────────────────────
    // Roll Button Interception
    // ──────────────────────────────────────

    function hookRollButton() {
        const rollBtn = document.querySelector(SELECTORS.rollBtn);
        if (!rollBtn || rollBtn.__biliHistoryHooked) return;

        rollBtn.__biliHistoryHooked = true;

        rollBtn.addEventListener('click', () => {
            // Remove our injected cards and restore original feed nodes
            // synchronously, so B站's JS finds a clean DOM when it updates.
            clearBacktrackDOM();

            // Wait for the DOM to update after the roll
            setTimeout(() => {
                captureFeedCards();
            }, 1500);
        });

        console.log('[BiliHistory] Roll button hooked');
    }

    // ──────────────────────────────────────
    // Backtrack Button
    // ──────────────────────────────────────

    /**
     * Copy computed styles from a source element to a target element.
     * Only copies visual properties — skips layout-breaking and
     * position/animation properties that could cause side effects.
     */
    function cloneComputedStyles(source, target) {
        const computed = window.getComputedStyle(source);
        // Properties to explicitly skip to avoid layout/logic interference
        const skipProps = new Set([
            'position', 'left', 'right', 'top', 'bottom',
            'z-index', 'float', 'clear',
            'animation', 'animation-name', 'animation-duration',
            'animation-delay', 'animation-iteration-count',
            'animation-direction', 'animation-fill-mode',
            'animation-play-state', 'animation-timing-function',
            'transition', 'transition-property', 'transition-duration',
            'transition-delay', 'transition-timing-function',
            'width', 'min-width', 'max-width',
            'height', 'min-height', 'max-height',
        ]);

        for (let i = 0; i < computed.length; i++) {
            const prop = computed[i];
            if (skipProps.has(prop)) continue;
            try {
                target.style.setProperty(prop, computed.getPropertyValue(prop));
            } catch (_) { /* skip un-settable props */ }
        }
    }

    function createStyledButton(rollBtn, id, title) {
        const btn = document.createElement('button');
        btn.id = id;
        cloneComputedStyles(rollBtn, btn);
        btn.style.marginTop = '8px';
        btn.style.cursor = 'pointer';
        btn.style.display = 'inline-flex';
        btn.style.flexDirection = 'column';
        btn.style.alignItems = 'center';
        btn.style.justifyContent = 'center';
        btn.style.gap = '2px';
        btn.style.lineHeight = '1.2';
        btn.title = title;
        return btn;
    }

    function injectBacktrackButton() {
        const rollBtn = document.querySelector(SELECTORS.rollBtn);
        if (!rollBtn || document.querySelector('#bilihistory-backtrack-btn')) return;

        const wrapper = rollBtn.parentElement;
        if (!wrapper) return;

        // ── Backtrack button (go older) ──
        backtrackBtn = createStyledButton(rollBtn, 'bilihistory-backtrack-btn', '查看上一批推荐');

        const backIcon = document.createElement('span');
        backIcon.textContent = '⏪';
        backIcon.style.fontSize = '1.1em';
        backtrackBtn.appendChild(backIcon);

        const backLabel = document.createElement('span');
        backLabel.textContent = '回溯';
        backLabel.style.fontSize = '0.85em';
        backtrackBtn.appendChild(backLabel);

        backtrackCountEl = document.createElement('span');
        backtrackCountEl.className = 'bilihistory-backtrack-count';
        backtrackCountEl.textContent = '';
        backtrackBtn.appendChild(backtrackCountEl);

        backtrackBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            doBacktrack();
        });

        wrapper.insertBefore(backtrackBtn, rollBtn.nextSibling);

        // ── Forward button (go newer, hidden by default) ──
        forwardBtn = createStyledButton(rollBtn, 'bilihistory-forward-btn', '查看下一批推荐');
        forwardBtn.style.display = 'none'; // hidden until backtrack is active

        const fwdIcon = document.createElement('span');
        fwdIcon.textContent = '⏩';
        fwdIcon.style.fontSize = '1.1em';
        forwardBtn.appendChild(fwdIcon);

        const fwdLabel = document.createElement('span');
        fwdLabel.textContent = '前进';
        fwdLabel.style.fontSize = '0.85em';
        forwardBtn.appendChild(fwdLabel);

        forwardBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            doForward();
        });

        // Insert forward button after backtrack button
        backtrackBtn.parentElement.insertBefore(forwardBtn, backtrackBtn.nextSibling);

        console.log('[BiliHistory] Backtrack & Forward buttons injected');
    }

    async function refreshHistoryCache() {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'GET_ALL_SNAPSHOTS' }, (response) => {
                if (response?.success) {
                    historyCache = response.snapshots;
                }
                resolve();
            });
        });
    }

    async function doBacktrack() {
        if (historyCache.length === 0) {
            await refreshHistoryCache();
        }

        if (historyCache.length === 0) return;

        // Move deeper into history.
        // Skip index 0 (= current live feed) on first backtrack.
        if (backtrackIndex === -1) {
            // First backtrack: jump to index 1 (the previous snapshot)
            if (historyCache.length < 2) return; // need at least 2 snapshots
            backtrackIndex = 1;
        } else if (backtrackIndex < historyCache.length - 1) {
            backtrackIndex++;
        } else {
            return; // already at oldest
        }

        const snapshot = historyCache[backtrackIndex];
        if (snapshot) {
            renderSnapshotToPage(snapshot.cards);
            updateBacktrackUI();
        }
    }

    function doForward() {
        if (backtrackIndex <= 1) {
            // Return to live feed — remove injected cards, restore real ones
            backtrackIndex = -1;
            clearBacktrackDOM();
            updateBacktrackUI();
            return;
        }

        backtrackIndex--;
        const snapshot = historyCache[backtrackIndex];
        if (snapshot) {
            renderSnapshotToPage(snapshot.cards);
            updateBacktrackUI();
        }
    }

    /**
     * Remove all injected history card nodes and un-hide the real .feed-card elements.
     */
    function clearBacktrackDOM() {
        // Remove injected cards
        document.querySelectorAll('[data-bilihistory-injected]').forEach(el => el.remove());

        // Restore hidden real feed cards
        document.querySelectorAll('[data-bilihistory-hidden]').forEach(el => {
            el.style.display = '';
            el.removeAttribute('data-bilihistory-hidden');
        });
    }

    /**
     * Hide real .feed-card elements and inject cloned history cards as siblings
     * in the same parent. B站's DOM nodes are preserved intact.
     */
    function renderSnapshotToPage(cards) {
        // First, clean up any previously injected cards from a prior backtrack step
        document.querySelectorAll('[data-bilihistory-injected]').forEach(el => el.remove());

        // Find the parent that holds .feed-card elements
        const feedParent = document.querySelector(`${SELECTORS.container} ${SELECTORS.swipe}`) ||
            document.querySelector(SELECTORS.container);
        if (!feedParent) return;

        const realCards = Array.from(
            feedParent.querySelectorAll(`:scope > ${SELECTORS.feedCard}`)
        );

        // If no scoped children found, try a broader query
        const liveCards = realCards.length > 0
            ? realCards
            : Array.from(document.querySelectorAll(`${SELECTORS.container} ${SELECTORS.feedCard}`));

        // Hide real cards (preserve them in DOM so B站's JS still owns them)
        liveCards.forEach(el => {
            el.style.display = 'none';
            el.setAttribute('data-bilihistory-hidden', '1');
        });

        // Use the first real card as a style reference
        const refCard = liveCards[0] || null;
        const insertAnchor = liveCards[0] || null;
        const parent = insertAnchor ? insertAnchor.parentElement : feedParent;

        // Inject cloned history cards
        cards.forEach(card => {
            const el = buildCardElement(card, refCard);
            el.setAttribute('data-bilihistory-injected', '1');
            if (insertAnchor) {
                parent.insertBefore(el, insertAnchor);
            } else {
                parent.appendChild(el);
            }
        });
    }

    /**
     * Build a visual card element from stored card data,
     * using a real .feed-card as layout/class reference.
     */
    function buildCardElement(card, referenceEl) {
        // If we have the raw HTML, parse and use it directly (best fidelity)
        if (card.html) {
            const temp = document.createElement('div');
            temp.innerHTML = card.html;
            const parsed = temp.firstElementChild;
            if (parsed) return parsed;
        }

        // Fallback: build from parsed fields
        const wrapper = document.createElement('div');

        if (referenceEl) {
            wrapper.className = referenceEl.className;
        }

        const coverHtml = card.cover
            ? `<img src="${escapeHtml(card.cover)}" style="width:100%;border-radius:8px;display:block;aspect-ratio:16/9;object-fit:cover" loading="lazy">`
            : `<div style="width:100%;aspect-ratio:16/9;background:#e3e5e7;border-radius:8px"></div>`;

        wrapper.innerHTML = `
            <a href="${escapeHtml(card.url)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;display:block">
                <div style="position:relative">
                    ${coverHtml}
                    ${card.duration ? `<span style="position:absolute;bottom:6px;right:6px;background:rgba(0,0,0,.7);color:#fff;font-size:12px;padding:1px 5px;border-radius:4px">${escapeHtml(card.duration)}</span>` : ''}
                </div>
                <div style="padding:6px 0 2px;font-size:13px;font-weight:500;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden" title="${escapeHtml(card.title)}">${escapeHtml(card.title)}</div>
                ${card.author ? `<div style="font-size:12px;color:#9499a0;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(card.author)}</div>` : ''}
                ${card.play ? `<div style="font-size:12px;color:#9499a0">▶ ${escapeHtml(card.play)}${card.danmaku ? ' &nbsp;&#128172; ' + escapeHtml(card.danmaku) : ''}</div>` : ''}
            </a>`;

        return wrapper;
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function updateBacktrackUI() {
        if (!backtrackBtn) return;

        const inBacktrackMode = backtrackIndex >= 1;

        if (inBacktrackMode && backtrackIndex < historyCache.length) {
            const snapshot = historyCache[backtrackIndex];
            const time = new Date(snapshot.timestamp).toLocaleTimeString('zh-CN', {
                hour: '2-digit', minute: '2-digit'
            });
            backtrackCountEl.textContent = `${time} · ${backtrackIndex}/${historyCache.length - 1}`;
        } else {
            backtrackCountEl.textContent = '';
        }

        // Disable backtrack when at oldest record
        const atOldest = backtrackIndex >= historyCache.length - 1;
        backtrackBtn.disabled = atOldest;

        // Show/hide forward button
        if (forwardBtn) {
            forwardBtn.style.display = inBacktrackMode ? 'inline-flex' : 'none';
        }
    }

    // ──────────────────────────────────────
    // Initialization
    // ──────────────────────────────────────

    function init() {
        // Debounced handler for MutationObserver
        function onMutation() {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const container = document.querySelector(SELECTORS.container);
                const feedCards = document.querySelectorAll(
                    `${SELECTORS.container} ${SELECTORS.feedCard}`
                );

                if (container && feedCards.length > 0 && !initialCaptured) {
                    // First capture only — subsequent captures triggered by roll-btn
                    initialCaptured = true;
                    captureFeedCards();
                }

                // Re-hook UI elements if B站 re-rendered them
                hookRollButton();
                injectBacktrackButton();
            }, 500); // wait 500ms of DOM quiet before acting
        }

        observer = new MutationObserver(onMutation);

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Also try immediately
        const feedCards = document.querySelectorAll(
            `${SELECTORS.container} ${SELECTORS.feedCard}`
        );
        if (feedCards.length > 0) {
            initialCaptured = true;
            captureFeedCards();
            hookRollButton();
            injectBacktrackButton();
            refreshHistoryCache();
        }
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
