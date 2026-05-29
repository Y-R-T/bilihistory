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

    const MODES = {
        LIVE_IDLE: 'LIVE_IDLE',
        ROLL_PENDING: 'ROLL_PENDING',
        CAPTURING: 'CAPTURING',
        CACHE_SYNCING: 'CACHE_SYNCING',
        BACKTRACKING: 'BACKTRACKING'
    };

    // Debug bridge is kept for open-source development, but release builds keep it disabled.
    // To use page-console debug helpers in a local development copy, change this to true.
    const ENABLE_PAGE_DEBUG_BRIDGE = false;

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
    let currentMode = MODES.LIVE_IDLE;
    let rollObservationActive = false;
    let rollIdleTimer = null;
    let rollExpectedCardCount = 0;
    let rollSeenFingerprints = new Set();
    let rollSnapshotSaved = false;
    let nextRollSequence = 0;
    let snapshotQueue = [];
    let lastEnqueuedFingerprint = '';
    let cacheDirty = true;
    let backtrackSession = null;
    let debugBridgeInstalled = false;
    let debugAttributeObserver = null;
    let isAppActive = false;
    let routeSyncTimer = null;
    let routeHooksInstalled = false;

    const ALLOWED_HISTORY_HOSTS = [
        'www.bilibili.com',
        'm.bilibili.com',
        'bangumi.bilibili.com',
        'live.bilibili.com'
    ];

    const ALLOWED_HISTORY_PATH_PREFIXES = [
        '/video/',
        '/bangumi/play/',
        '/cheese/play/',
        '/medialist/play/',
        '/festival/',
        '/list/'
    ];

    // ──────────────────────────────────────
    // Feed Card Data Extraction
    // ──────────────────────────────────────

    function extractUrlFromStyle(styleValue) {
        if (!styleValue) return '';

        const match = styleValue.match(/url\((["']?)(.*?)\1\)/i);
        return match?.[2] || '';
    }

    function extractFirstSrcsetUrl(srcsetValue) {
        if (!srcsetValue) return '';

        const firstCandidate = srcsetValue.split(',')[0]?.trim() || '';
        return firstCandidate.split(/\s+/)[0] || '';
    }

    function normalizeCoverUrl(url) {
        const normalized = extractFirstSrcsetUrl(url) || url || '';

        try {
            return new URL(normalized, window.location.href).href;
        } catch (_) {
            return normalized;
        }
    }

    function extractCardData(cardEl) {
        const data = {};

        // Title
        const titleEl = cardEl.querySelector('.bili-video-card__info--tit a') ||
            cardEl.querySelector('.bili-video-card__info--tit') ||
            cardEl.querySelector('[title]');
        data.title = titleEl?.getAttribute('title') || titleEl?.textContent?.trim() || '';

        // URL
        const linkEl = cardEl.querySelector('a[href*="/video/"]') ||
            cardEl.querySelector('a[href*="bilibili.com"]') ||
            cardEl.querySelector('a');
        data.url = sanitizeUrl(linkEl?.href || '');

        // Cover image
        const imgEl = cardEl.querySelector('.bili-video-card__cover img') ||
            cardEl.querySelector('.v-img img') ||
            cardEl.querySelector('img');
        const coverBgEl = cardEl.querySelector('.bili-video-card__cover [style*="background-image"]')
            || cardEl.querySelector('.v-img [style*="background-image"]')
            || cardEl.querySelector('[style*="background-image"]');
        data.cover = normalizeCoverUrl(
            imgEl?.currentSrc
            || imgEl?.src
            || imgEl?.getAttribute('data-src')
            || extractFirstSrcsetUrl(imgEl?.getAttribute('srcset'))
            || extractFirstSrcsetUrl(imgEl?.getAttribute('data-srcset'))
            || extractUrlFromStyle(coverBgEl?.style?.backgroundImage)
            || extractUrlFromStyle(coverBgEl?.getAttribute('style'))
            || ''
        );

        // Author / UP
        const ownerLinkEl = cardEl.querySelector('.bili-video-card__info--owner[href]') ||
            cardEl.querySelector('.bili-video-card__info--author')?.closest('a[href]');
        const authorEl = cardEl.querySelector('.bili-video-card__info--author') ||
            cardEl.querySelector('.bili-video-card__info--owner span');
        data.author = authorEl?.textContent?.trim() || '';
        data.authorUrl = sanitizeAuthorUrl(ownerLinkEl?.href || '');

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
    function normalizeSnapshotCards(cards) {
        return Array.isArray(cards)
            ? cards.filter((card) => card && typeof card === 'object')
            : [];
    }

    function generateFingerprint(cardDataList) {
        return cardDataList.map(c => `${c.title}|${c.url}`).join(';;');
    }

    const ROLL_IDLE_MS = 2000;

    function setMode(mode) {
        currentMode = mode;
    }

    function syncModeWithState() {
        if (isCapturing) return;

        if (snapshotQueue.length > 0 || (rollObservationActive && !rollSnapshotSaved)) {
            setMode(MODES.ROLL_PENDING);
        } else if (backtrackIndex >= 1) {
            setMode(MODES.BACKTRACKING);
        } else {
            setMode(MODES.LIVE_IDLE);
        }
    }

    function isBusyMode() {
        const waitingForFirstRollSnapshot = rollObservationActive && !rollSnapshotSaved;
        return waitingForFirstRollSnapshot
            || snapshotQueue.length > 0
            || isCapturing
            || currentMode === MODES.CAPTURING
            || currentMode === MODES.CACHE_SYNCING;
    }

    function isSupportedHomepage() {
        return window.location.hostname === 'www.bilibili.com'
            && /^(?:\/|\/index\.html)$/.test(window.location.pathname || '/');
    }

    function getFeedParent() {
        return document.querySelector(`${SELECTORS.container} ${SELECTORS.swipe}`)
            || document.querySelector(SELECTORS.container);
    }

    function isRealVisibleFeedCard(cardEl) {
        if (!cardEl) return false;
        if (cardEl.hasAttribute('data-bilihistory-injected')) return false;
        if (cardEl.hasAttribute('data-bilihistory-hidden')) return false;
        if (cardEl.hasAttribute('data-bilihistory-reused')) return false;

        const style = window.getComputedStyle(cardEl);
        if (style.display === 'none' || style.visibility === 'hidden') {
            return false;
        }

        return cardEl.getClientRects().length > 0;
    }

    function getLiveFeedCards() {
        const feedParent = getFeedParent();
        if (!feedParent) return [];

        const scopedCards = Array.from(
            feedParent.querySelectorAll(`:scope > ${SELECTORS.feedCard}`)
        );

        const fallbackCards = scopedCards.length > 0
            ? scopedCards
            : Array.from(document.querySelectorAll(`${SELECTORS.container} ${SELECTORS.feedCard}`));

        return fallbackCards.filter(isRealVisibleFeedCard);
    }

    function restoreLiveFeed() {
        clearBacktrackDOM();
        backtrackIndex = -1;
    }

    function handleHistoryCleared() {
        historyCache = [];
        cacheDirty = true;
        snapshotQueue = [];
        lastCapturedFingerprint = '';
        lastEnqueuedFingerprint = '';
        stopRollObservation(true);
        restoreLiveFeed();
        setMode(MODES.LIVE_IDLE);
        updateBacktrackUI();
    }

    function sendRuntimeMessage(message) {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage(message, (response) => {
                    if (chrome.runtime.lastError) {
                        resolve({ success: false, error: chrome.runtime.lastError.message });
                        return;
                    }

                    resolve(response);
                });
            } catch (error) {
                resolve({ success: false, error: error?.message || String(error) });
            }
        });
    }

    function syncLastEnqueuedFingerprint() {
        lastEnqueuedFingerprint = snapshotQueue.length > 0
            ? snapshotQueue[snapshotQueue.length - 1].fingerprint
            : lastCapturedFingerprint;
    }

    function stopRollObservation(resetSavedState = false) {
        if (rollIdleTimer) {
            clearTimeout(rollIdleTimer);
            rollIdleTimer = null;
        }

        rollObservationActive = false;
        rollExpectedCardCount = 0;
        rollSeenFingerprints = new Set();
        if (resetSavedState) {
            rollSnapshotSaved = false;
        }
    }

    function beginRollObservation(resetSeenFingerprints = false) {
        rollObservationActive = true;

        if (resetSeenFingerprints || rollSeenFingerprints.size === 0) {
            rollSeenFingerprints = new Set();
            rollSnapshotSaved = false;
            const liveCards = getLiveFeedCards();
            const latestHistoryCount = historyCache[0]?.cards?.length || 0;
            rollExpectedCardCount = liveCards.length || latestHistoryCount || rollExpectedCardCount;
        }

        if (rollIdleTimer) {
            clearTimeout(rollIdleTimer);
        }

        rollIdleTimer = setTimeout(() => {
            stopRollObservation();
            syncModeWithState();
            updateBacktrackUI();
        }, ROLL_IDLE_MS);

        syncModeWithState();
        updateBacktrackUI();
    }

    function collectLiveSnapshot(source = 'manual', options = {}) {
        const {
            minCardCount = 0,
            seenFingerprints = null
        } = options;

        const cards = getLiveFeedCards();
        if (cards.length === 0) return null;

        const cardDataList = cards.map(extractCardData).filter(c => c.title);
        if (cardDataList.length === 0) return null;
        if (minCardCount > 0 && cardDataList.length < minCardCount) return null;

        const fingerprint = generateFingerprint(cardDataList);
        if (!fingerprint) return null;
        if (seenFingerprints?.has(fingerprint)) return null;
        if (fingerprint === lastCapturedFingerprint || fingerprint === lastEnqueuedFingerprint) {
            return null;
        }

        return {
            cards: cardDataList,
            fingerprint,
            source,
            rollSeq: ++nextRollSequence,
            observedAt: Date.now()
        };
    }

    function enqueueSnapshot(snapshotJob) {
        snapshotQueue.push(snapshotJob);
        syncLastEnqueuedFingerprint();
        syncModeWithState();
        updateBacktrackUI();
    }

    async function processSnapshotQueue() {
        if (isCapturing || snapshotQueue.length === 0) {
            syncModeWithState();
            updateBacktrackUI();
            return false;
        }

        const snapshotJob = snapshotQueue[0];
        isCapturing = true;
        setMode(MODES.CAPTURING);
        updateBacktrackUI();

        try {
            const response = await sendRuntimeMessage({
                type: 'SAVE_SNAPSHOT',
                data: { cards: snapshotJob.cards }
            });

            snapshotQueue.shift();
            syncLastEnqueuedFingerprint();

            if (!response?.success) {
                cacheDirty = true;
                return false;
            }

            lastCapturedFingerprint = snapshotJob.fingerprint;
            if (snapshotJob.source === 'roll') {
                rollSnapshotSaved = true;
            }
            debugLog('snapshot-saved', {
                cardCount: snapshotJob.cards.length,
                source: snapshotJob.source,
                total: response.total
            });

            setMode(MODES.CACHE_SYNCING);
            updateBacktrackUI();

            return applySavedSnapshotToLocalCache(snapshotJob, response);
        } finally {
            isCapturing = false;
            syncModeWithState();
            updateBacktrackUI();

            if (snapshotQueue.length > 0) {
                processSnapshotQueue();
            }
        }
    }

    async function captureFeedCards(options = {}) {
        const { source = 'manual' } = options;
        const snapshotJob = collectLiveSnapshot(source);

        if (!snapshotJob) {
            syncModeWithState();
            updateBacktrackUI();
            return false;
        }

        enqueueSnapshot(snapshotJob);
        void processSnapshotQueue();
        return true;
    }

    function getMinimumStableCardCount() {
        if (rollExpectedCardCount <= 1) return Math.max(1, rollExpectedCardCount);
        return Math.max(1, rollExpectedCardCount - 1);
    }

    function flushRollSnapshot() {
        if (!rollObservationActive || backtrackIndex >= 1 || currentMode === MODES.BACKTRACKING) return false;

        const snapshotJob = collectLiveSnapshot('roll', {
            minCardCount: getMinimumStableCardCount(),
            seenFingerprints: rollSeenFingerprints
        });

        if (!snapshotJob) return false;

        rollSeenFingerprints.add(snapshotJob.fingerprint);
        enqueueSnapshot(snapshotJob);
        void processSnapshotQueue();
        return true;
    }

    function isFeedRelatedNode(node) {
        const element = node instanceof Element ? node : node?.parentElement;
        if (!element) return false;

        return Boolean(
            element.closest(SELECTORS.container)
            || element.closest(SELECTORS.rollBtn)
            || element.matches?.(SELECTORS.container)
            || element.matches?.(SELECTORS.feedCard)
            || element.querySelector?.(SELECTORS.feedCard)
        );
    }

    function mutationTouchesFeed(mutations) {
        return mutations.some((mutation) => {
            if (isFeedRelatedNode(mutation.target)) return true;

            return [...mutation.addedNodes, ...mutation.removedNodes].some(isFeedRelatedNode);
        });
    }

    // ──────────────────────────────────────
    // Roll Button Interception
    // ──────────────────────────────────────

    function hookRollButton() {
        const rollBtn = document.querySelector(SELECTORS.rollBtn);
        if (!rollBtn || rollBtn.__biliHistoryHooked) return;

        rollBtn.__biliHistoryHooked = true;

        rollBtn.addEventListener('click', () => {
            cacheDirty = true;
            restoreLiveFeed();
            beginRollObservation(true);
        });

        debugLog('roll-button-hooked', {});
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
        btn.classList.add('bilihistory-side-btn');
        const rollHeight = Math.ceil(rollBtn.getBoundingClientRect?.().height || 0);
        if (rollHeight > 0) {
            btn.style.setProperty('--bilihistory-side-button-height', `${rollHeight}px`);
        }
        btn.style.marginTop = '8px';
        btn.style.cursor = 'pointer';
        btn.style.display = 'flex';
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

        debugLog('buttons-injected', {});
    }

    async function refreshHistoryCache() {
        const response = await sendRuntimeMessage({ type: 'GET_ALL_SNAPSHOTS' });

        if (response?.success) {
            historyCache = Array.isArray(response.snapshots) ? response.snapshots : [];
            cacheDirty = false;
            updateBacktrackUI();
            return true;
        }

        return false;
    }

    function applySavedSnapshotToLocalCache(snapshotJob, response) {
        if (!response?.id) {
            cacheDirty = true;
            return false;
        }

        if (!Array.isArray(historyCache)) {
            historyCache = [];
        }

        if (historyCache.some((snapshot) => snapshot.id === response.id)) {
            cacheDirty = false;
            return true;
        }

        historyCache = [
            {
                id: response.id,
                timestamp: response.timestamp,
                cards: snapshotJob.cards
            },
            ...historyCache
        ];

        if (typeof response.total === 'number' && response.total >= 0) {
            historyCache = historyCache.slice(0, response.total);
        }

        cacheDirty = false;
        return true;
    }

    async function doBacktrack() {
        if (isBusyMode()) return;

        stopRollObservation();
        syncModeWithState();

        const shouldRefresh = backtrackIndex === -1 || cacheDirty || historyCache.length === 0;
        if (shouldRefresh) {
            const refreshed = await refreshHistoryCache();
            if (!refreshed) return;
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
        const cards = normalizeSnapshotCards(snapshot?.cards);
        if (cards.length > 0) {
            setMode(MODES.BACKTRACKING);
            renderSnapshotToPage(cards);
            updateBacktrackUI();
        }
    }

    function doForward() {
        if (isBusyMode()) return;

        if (backtrackIndex <= 1) {
            restoreLiveFeed();
            setMode(MODES.LIVE_IDLE);
            updateBacktrackUI();
            return;
        }

        backtrackIndex--;
        const snapshot = historyCache[backtrackIndex];
        const cards = normalizeSnapshotCards(snapshot?.cards);
        if (cards.length > 0) {
            setMode(MODES.BACKTRACKING);
            renderSnapshotToPage(cards);
            updateBacktrackUI();
        }
    }

    function uniqueElements(elements) {
        return [...new Set(elements.filter(Boolean))];
    }

    function resolveCardBindings(cardEl) {
        if (!cardEl) return null;

        const cardRoot = cardEl.matches?.(`${SELECTORS.feedCard}, .bili-video-card`) ? cardEl : cardEl.querySelector('.bili-video-card') || cardEl;
        const titleLink = cardEl.querySelector('.bili-video-card__info--tit > a')
            || cardEl.querySelector('.bili-video-card__info--tit a')
            || cardEl.querySelector('.bili-video-card__title a')
            || cardEl.querySelector('a[href*="/video/"]');
        const titleNode = cardEl.querySelector('.bili-video-card__info--tit')
            || cardEl.querySelector('.bili-video-card__title')
            || titleLink
            || cardEl.querySelector('[title]');
        const coverLink = cardEl.querySelector('.bili-video-card__image--link')
            || cardEl.querySelector('.bili-video-card__cover a')
            || cardEl.querySelector('.v-img a')
            || titleLink
            || cardEl.querySelector('a');
        const coverPicture = cardEl.querySelector('picture.v-img.bili-video-card__cover')
            || cardEl.querySelector('.bili-video-card__cover')
            || cardEl.querySelector('.v-img');
        const imageWrap = cardEl.querySelector('.bili-video-card__image--wrap')
            || coverPicture?.closest('.bili-video-card__image--wrap')
            || coverLink?.querySelector('.bili-video-card__image--wrap')
            || cardEl.querySelector('.bili-video-card__image');
        const coverRoot = coverPicture
            || coverLink?.closest('picture.v-img.bili-video-card__cover')
            || coverLink?.closest('.bili-video-card__cover')
            || coverLink?.closest('.v-img')
            || cardEl;
        const coverImage = coverRoot?.querySelector('img')
            || cardEl.querySelector('.bili-video-card__cover img')
            || cardEl.querySelector('.v-img img')
            || cardEl.querySelector('img');
        const coverImages = uniqueElements([
            coverImage,
            ...(coverRoot ? Array.from(coverRoot.querySelectorAll('img')) : [])
        ]);
        const coverSources = uniqueElements(
            coverRoot ? Array.from(coverRoot.querySelectorAll('source')) : []
        );
        const coverBackgroundNodes = uniqueElements([
            coverRoot?.matches?.('[style*="background-image"]') ? coverRoot : null,
            ...(coverRoot ? Array.from(coverRoot.querySelectorAll('[style*="background-image"]')) : [])
        ]);
        const imageHover = cardEl.querySelector('.bili-video-card__image--hover');
        const watchLaterButton = cardEl.querySelector('.bili-watch-later--wrap .bili-watch-later--pip');
        const maskNode = cardEl.querySelector('.bili-video-card__mask');
        const statsNode = cardEl.querySelector('.bili-video-card__stats');
        const statsLeftNode = cardEl.querySelector('.bili-video-card__stats--left');
        const ownerLink = cardEl.querySelector('.bili-video-card__info--owner');
        const authorNode = cardEl.querySelector('.bili-video-card__info--author')
            || cardEl.querySelector('.bili-video-card__info--owner span');
        const playNode = cardEl.querySelector('.bili-video-card__stats--left .bili-video-card__stats--item:nth-child(1) .bili-video-card__stats--text')
            || cardEl.querySelector('.bili-video-card__stats--item:first-child span')
            || cardEl.querySelector('.bili-video-card__stats--text');
        const danmakuNode = cardEl.querySelector('.bili-video-card__stats--left .bili-video-card__stats--item:nth-child(2) .bili-video-card__stats--text')
            || cardEl.querySelector('.bili-video-card__stats--item:nth-child(2) span');
        const playItem = playNode?.closest('.bili-video-card__stats--item')
            || cardEl.querySelector('.bili-video-card__stats--left .bili-video-card__stats--item:nth-child(1)');
        const danmakuItem = danmakuNode?.closest('.bili-video-card__stats--item')
            || cardEl.querySelector('.bili-video-card__stats--left .bili-video-card__stats--item:nth-child(2)');
        const playIcon = playItem?.querySelector('.bili-video-card__stats--icon')
            || cardEl.querySelector('.bili-video-card__stats--left .bili-video-card__stats--item:nth-child(1) .bili-video-card__stats--icon');
        const danmakuIcon = danmakuItem?.querySelector('.bili-video-card__stats--icon')
            || cardEl.querySelector('.bili-video-card__stats--left .bili-video-card__stats--item:nth-child(2) .bili-video-card__stats--icon');
        const durationNode = cardEl.querySelector('.bili-video-card__stats__duration');
        const videoLinks = uniqueElements([
            ...cardEl.querySelectorAll('a[href*="/video/"]'),
            ...cardEl.querySelectorAll('a[href*="bilibili.com/video/"]'),
            titleLink,
            coverLink
        ]);

        return {
            cardRoot,
            titleNode,
            titleLink,
            coverLink,
            coverPicture,
            imageWrap,
            coverRoot,
            coverImage,
            coverImages,
            coverSources,
            coverBackgroundNodes,
            imageHover,
            watchLaterButton,
            maskNode,
            statsNode,
            statsLeftNode,
            ownerLink,
            authorNode,
            playNode,
            danmakuNode,
            playItem,
            danmakuItem,
            playIcon,
            danmakuIcon,
            durationNode,
            videoLinks
        };
    }

    function hasUsableBindings(bindings) {
        if (!bindings) return false;
        return Boolean(
            (bindings.titleLink || bindings.titleNode)
            && (bindings.coverLink || bindings.videoLinks.length > 0)
            && (
                bindings.coverPicture
                || bindings.coverImages?.length > 0
                || bindings.coverBackgroundNodes?.length > 0
            )
        );
    }

    function getCardStructureSignature(cardEl, bindings = resolveCardBindings(cardEl)) {
        if (!cardEl || !bindings) return '';

        return [
            cardEl.className || '',
            bindings.cardRoot?.className || '',
            bindings.coverPicture ? 'picture' : 'no-picture',
            bindings.coverSources?.length || 0,
            bindings.coverImages?.length || 0,
            bindings.coverBackgroundNodes?.length || 0,
            bindings.titleLink ? 'title-link' : 'title-node',
            bindings.coverLink ? 'cover-link' : 'no-cover-link',
            bindings.statsNode ? 'stats' : 'no-stats',
            bindings.ownerLink ? 'owner' : 'no-owner'
        ].join('|');
    }

    function isDebugMode() {
        return ENABLE_PAGE_DEBUG_BRIDGE
            && document.documentElement?.dataset?.bilihistoryDebug === '1';
    }

    function debugLog(scope, payload) {
        if (!isDebugMode()) return;
        console.log(`[BiliHistory][${scope}]`, payload);
    }

    function captureElementState(element, attrs = [], options = {}) {
        if (!element) return null;

        const snapshot = {
            attrs: Object.fromEntries(attrs.map((attr) => [attr, element.getAttribute(attr)]))
        };

        if (options.includeText) {
            snapshot.textContent = element.textContent;
        }

        return snapshot;
    }

    function restoreElementState(element, snapshot) {
        if (!element || !snapshot) return;

        if (typeof snapshot.textContent === 'string') {
            element.textContent = snapshot.textContent;
        }

        Object.entries(snapshot.attrs || {}).forEach(([attr, value]) => {
            if (value == null) {
                element.removeAttribute(attr);
            } else {
                element.setAttribute(attr, value);
            }
        });
    }

    function captureElementRefStates(elements, attrs = [], options = {}) {
        return (elements || []).map((element) => ({
            element,
            snapshot: captureElementState(element, attrs, options)
        }));
    }

    function restoreElementRefStates(refStates) {
        (refStates || []).forEach(({ element, snapshot }) => {
            restoreElementState(element, snapshot);
        });
    }

    function captureChildNodeState(element) {
        if (!element) return null;
        return {
            snapshot: captureElementState(element, ['style']),
            childNodes: Array.from(element.childNodes)
        };
    }

    function restoreChildNodeState(element, state) {
        if (!element || !state) return;
        restoreElementState(element, state.snapshot);
        element.replaceChildren(...(state.childNodes || []));
    }

    function captureBacktrackCardState(bindings) {
        return {
            titleNode: captureElementState(bindings.titleNode, ['title']),
            titleLink: captureElementState(bindings.titleLink, ['href', 'title'], { includeText: true }),
            coverLink: captureElementState(bindings.coverLink, ['href', 'title']),
            coverImage: captureElementState(bindings.coverImage, ['src', 'data-src', 'srcset', 'data-srcset', 'alt']),
            coverImages: captureElementRefStates(bindings.coverImages, ['src', 'data-src', 'srcset', 'data-srcset', 'alt']),
            coverSources: captureElementRefStates(bindings.coverSources, ['srcset', 'data-srcset', 'src']),
            coverBackgroundNodes: captureElementRefStates(bindings.coverBackgroundNodes, ['style']),
            ownerLink: captureElementState(bindings.ownerLink, ['href', 'title', 'target', 'rel', 'style']),
            authorNode: captureElementState(bindings.authorNode, ['title'], { includeText: true }),
            playNode: captureElementState(bindings.playNode, ['title', 'style'], { includeText: true }),
            danmakuNode: captureElementState(bindings.danmakuNode, ['title', 'style'], { includeText: true }),
            maskNode: captureElementState(bindings.maskNode, ['style']),
            statsNode: captureElementState(bindings.statsNode, ['style']),
            statsLeftNode: captureChildNodeState(bindings.statsLeftNode),
            statsLeftChildren: captureElementRefStates(
                Array.from(bindings.statsLeftNode?.children || []),
                ['style', 'aria-hidden']
            ),
            durationNode: captureElementState(bindings.durationNode, ['title', 'style'], { includeText: true }),
            videoLinks: captureElementRefStates(bindings.videoLinks, ['href', 'title'])
        };
    }

    function restoreBacktrackCardState(bindings, original) {
        if (!bindings || !original) return;

        clearCoverLoadingState(bindings);
        restoreElementState(bindings.titleNode, original.titleNode);
        restoreElementState(bindings.titleLink, original.titleLink);
        restoreElementState(bindings.coverLink, original.coverLink);
        restoreElementState(bindings.coverImage, original.coverImage);
        restoreElementRefStates(original.coverImages);
        restoreElementRefStates(original.coverSources);
        restoreElementRefStates(original.coverBackgroundNodes);
        restoreElementState(bindings.ownerLink, original.ownerLink);
        restoreElementState(bindings.authorNode, original.authorNode);
        restoreElementState(bindings.playNode, original.playNode);
        restoreElementState(bindings.danmakuNode, original.danmakuNode);
        restoreElementState(bindings.maskNode, original.maskNode);
        restoreElementState(bindings.statsNode, original.statsNode);
        restoreElementRefStates(original.statsLeftChildren);
        restoreChildNodeState(bindings.statsLeftNode, original.statsLeftNode);
        restoreElementState(bindings.durationNode, original.durationNode);
        restoreElementRefStates(original.videoLinks);
    }

    function setElementText(element, value) {
        if (!element) return;
        element.textContent = value || '';
    }

    function resetMaskTextIndent(bindings) {
        if (!bindings?.maskNode) return;
        bindings.maskNode.style.textIndent = '0px';
    }

    function setElementAttr(element, attr, value) {
        if (!element) return;

        if (value) {
            element.setAttribute(attr, value);
        } else {
            element.removeAttribute(attr);
        }
    }

    function setImageCandidateAttr(element, url) {
        if (!element) return;

        if (url) {
            element.setAttribute('src', url);
            element.setAttribute('data-src', url);
            element.setAttribute('srcset', '');
            element.setAttribute('data-srcset', '');
        } else {
            element.removeAttribute('src');
            element.removeAttribute('data-src');
            element.removeAttribute('srcset');
            element.removeAttribute('data-srcset');
        }
    }

    function clearSourceCandidateAttr(element) {
        if (!element) return;
        element.removeAttribute('srcset');
        element.removeAttribute('data-srcset');
        element.removeAttribute('src');
    }

    function setBackgroundImage(element, url) {
        if (!element) return;
        element.style.backgroundImage = url ? `url("${url}")` : '';
    }

    function resolveResourceUrl(url) {
        if (!url) return '';

        try {
            return new URL(url, window.location.href).href;
        } catch (_) {
            return url;
        }
    }

    function clearCoverLoadingState(bindings) {
        const loadingRoot = bindings?.cardRoot || bindings?.coverRoot;
        if (!loadingRoot) return;

        loadingRoot.removeAttribute('data-bilihistory-cover-loading');
        delete loadingRoot.dataset.bilihistoryCoverToken;
    }

    function beginCoverLoading(bindings, coverUrl) {
        const loadingRoot = bindings.cardRoot || bindings.coverRoot;
        const imageEl = bindings.coverImages?.[0] || bindings.coverImage;
        if (!loadingRoot || !coverUrl || !imageEl) return () => {};

        const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const targetUrl = resolveResourceUrl(coverUrl);
        let done = false;

        loadingRoot.dataset.bilihistoryCoverToken = token;
        loadingRoot.setAttribute('data-bilihistory-cover-loading', '1');

        const isCurrentToken = () => loadingRoot.dataset.bilihistoryCoverToken === token;
        const isTargetLoaded = () => {
            const currentUrl = resolveResourceUrl(imageEl.currentSrc || imageEl.getAttribute('src') || '');
            return imageEl.complete && imageEl.naturalWidth > 0 && currentUrl === targetUrl;
        };

        const clearLoading = () => {
            if (done) return;
            done = true;
            imageEl.removeEventListener('load', clearIfTargetReady);

            if (!isCurrentToken()) return;
            loadingRoot.removeAttribute('data-bilihistory-cover-loading');
            delete loadingRoot.dataset.bilihistoryCoverToken;
        };

        const clearAfterPaint = () => {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (isCurrentToken() && isTargetLoaded()) {
                        clearLoading();
                    }
                });
            });
        };

        function clearIfTargetReady() {
            if (!isCurrentToken()) {
                clearLoading();
                return;
            }

            if (!isTargetLoaded()) return;

            if (typeof imageEl.decode !== 'function') {
                clearAfterPaint();
                return;
            }

            imageEl.decode()
                .then(clearAfterPaint)
                .catch(() => {
                    if (isTargetLoaded()) {
                        clearAfterPaint();
                    }
                });
        }

        imageEl.addEventListener('load', clearIfTargetReady);
        setTimeout(clearIfTargetReady, 0);
        return clearLoading;
    }

    function patchCoverPicture(bindings, card, title = '') {
        const coverUrl = normalizeCoverUrl(card.cover || '');
        const clearCoverLoading = beginCoverLoading(bindings, coverUrl);

        (bindings.coverSources || []).forEach((sourceEl) => {
            clearSourceCandidateAttr(sourceEl);
        });

        (bindings.coverImages || []).forEach((imageEl) => {
            setImageCandidateAttr(imageEl, coverUrl);
            setElementAttr(imageEl, 'alt', title);
        });

        (bindings.coverBackgroundNodes || []).forEach((bgEl) => {
            setBackgroundImage(bgEl, coverUrl);
        });

        if (!coverUrl) {
            clearCoverLoading();
        }

        debugLog('cover-patch', {
            title: title.slice(0, 30),
            coverUrl,
            imageSrc: bindings.coverImages?.[0]?.getAttribute('src') || '',
            currentSrc: bindings.coverImages?.[0]?.currentSrc || '',
            sources: (bindings.coverSources || []).map((sourceEl) => sourceEl.getAttribute('srcset') || ''),
            hasPicture: Boolean(bindings.coverPicture)
        });
    }

    function createPreviewBlocker() {
        return (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
        };
    }

    function enableBacktrackInteractionGuards(item) {
        if (!item?.bindings || item.previewGuardCleanup) return;

        const targets = uniqueElements([
            item.bindings.imageWrap,
            item.bindings.coverLink,
            item.element
        ]);
        if (targets.length === 0) return;

        const eventTypes = ['mouseenter', 'mouseover', 'mousemove', 'pointerenter', 'pointerover', 'pointermove'];
        const blocker = createPreviewBlocker();

        targets.forEach((target) => {
            eventTypes.forEach((eventType) => {
                target.addEventListener(eventType, blocker, true);
            });
            target.setAttribute('data-bilihistory-preview-disabled', '1');
            target.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
            if (typeof PointerEvent === 'function') {
                target.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
            }
        });

        debugLog('preview-guard', {
            title: item.bindings.titleLink?.textContent?.trim() || item.bindings.titleNode?.textContent?.trim() || '',
            targets: targets.map((target) => ({
                tag: target.tagName,
                className: target.className || '',
                disabled: target.getAttribute('data-bilihistory-preview-disabled') || ''
            }))
        });

        item.previewGuardCleanup = () => {
            targets.forEach((target) => {
                eventTypes.forEach((eventType) => {
                    target.removeEventListener(eventType, blocker, true);
                });
                target.removeAttribute('data-bilihistory-preview-disabled');
            });
            item.previewGuardCleanup = null;
        };
    }

    function applyCardDataToBindings(bindings, card) {
        if (!bindings || !card) return false;

        const safeUrl = sanitizeUrl(card.url);
        const safeAuthorUrl = sanitizeAuthorUrl(card.authorUrl || '');
        const title = card.title || '';

        if (bindings.titleLink) {
            setElementText(bindings.titleLink, title);
            setElementAttr(bindings.titleLink, 'title', title);
        } else {
            setElementText(bindings.titleNode, title);
        }

        if (bindings.titleNode && bindings.titleNode !== bindings.titleLink) {
            setElementAttr(bindings.titleNode, 'title', title);
        }

        uniqueElements([bindings.coverLink, ...bindings.videoLinks]).forEach((linkEl) => {
            setElementAttr(linkEl, 'href', safeUrl);
            if (title) {
                setElementAttr(linkEl, 'title', title);
            }
        });

        patchCoverPicture(bindings, card, title);
        resetMaskTextIndent(bindings);

        setElementText(bindings.authorNode, card.author || '');
        setElementAttr(bindings.authorNode, 'title', card.author || '');
        if (bindings.ownerLink) {
            setElementAttr(bindings.ownerLink, 'href', safeAuthorUrl);
            setElementAttr(bindings.ownerLink, 'title', card.author || '');
            if (safeAuthorUrl) {
                setElementAttr(bindings.ownerLink, 'target', '_blank');
                setElementAttr(bindings.ownerLink, 'rel', 'noopener');
                bindings.ownerLink.style.cursor = '';
            } else {
                bindings.ownerLink.removeAttribute('target');
                bindings.ownerLink.removeAttribute('rel');
                bindings.ownerLink.style.cursor = 'default';
            }
        }
        setElementText(bindings.playNode, card.play || '');
        setElementText(bindings.danmakuNode, card.danmaku || '');
        setElementText(bindings.durationNode, card.duration || '');
        return true;
    }

    function removeIdsRecursively(root) {
        if (!root) return;

        if (root.removeAttribute) {
            root.removeAttribute('id');
        }

        root.querySelectorAll?.('[id]').forEach((el) => el.removeAttribute('id'));
    }

    function createBacktrackSession(liveCards) {
        const items = liveCards.map((element) => {
            const bindings = resolveCardBindings(element);
            return {
                element,
                bindings,
                signature: getCardStructureSignature(element, bindings),
                originalState: captureBacktrackCardState(bindings),
                isPatched: false,
                previewGuardCleanup: null
            };
        });

        return {
            items,
            liveCount: liveCards.length,
            injectedNodes: []
        };
    }

    function isBacktrackSessionValid(session, liveCards) {
        if (!session || session.liveCount !== liveCards.length || session.items.length !== liveCards.length) {
            return false;
        }

        return session.items.every((item, index) => {
            const liveCard = liveCards[index];
            if (!liveCard || !liveCard.isConnected || item.element !== liveCard) {
                return false;
            }

            const bindings = resolveCardBindings(liveCard);
            if (!hasUsableBindings(bindings)) {
                return false;
            }

            return item.signature === getCardStructureSignature(liveCard, bindings);
        });
    }

    function ensureBacktrackSession(liveCards) {
        const sessionReused = isBacktrackSessionValid(backtrackSession, liveCards);
        if (!sessionReused) {
            backtrackSession = createBacktrackSession(liveCards);
        }

        debugLog('session', {
            reused: sessionReused,
            liveCardCount: liveCards.length,
            usableTemplates: backtrackSession.items.filter((item) => hasUsableBindings(item.bindings)).length
        });

        return backtrackSession;
    }

    function cleanupInjectedBacktrackNodes() {
        if (backtrackSession?.injectedNodes?.length) {
            backtrackSession.injectedNodes.forEach((node) => node?.remove());
            backtrackSession.injectedNodes = [];
        }

        document.querySelectorAll('[data-bilihistory-injected]').forEach((el) => el.remove());
    }

    function hideBacktrackLiveCard(element) {
        if (!element) return;
        element.style.display = 'none';
        element.setAttribute('data-bilihistory-hidden', '1');
    }

    function showBacktrackLiveCard(element) {
        if (!element) return;
        element.style.display = '';
        element.removeAttribute('data-bilihistory-hidden');
    }

    function restorePatchedLiveCards(session) {
        if (!session?.items?.length) return;

        session.items.forEach((item) => {
            if (!item?.element) return;

            item.previewGuardCleanup?.();

            if (item.isPatched) {
                restoreBacktrackCardState(item.bindings, item.originalState);
                item.isPatched = false;
            }

            item.element.removeAttribute('data-bilihistory-reused');
            item.element.removeAttribute('data-bilihistory-render-mode');
            showBacktrackLiveCard(item.element);
        });
    }

    function buildTemplateCardElement(card, templateElement) {
        if (!templateElement) return null;

        const clone = templateElement.cloneNode(true);
        removeIdsRecursively(clone);
        clone.removeAttribute('data-bilihistory-hidden');
        clone.removeAttribute('data-bilihistory-reused');
        clone.setAttribute('data-bilihistory-injected', '1');
        clone.setAttribute('data-bilihistory-render-mode', 'template-clone');
        clone.style.display = '';

        const bindings = resolveCardBindings(clone);
        if (!hasUsableBindings(bindings)) {
            return null;
        }

        applyCardDataToBindings(bindings, card);
        debugLog('bindings', {
            title: (card.title || '').slice(0, 30),
            hasPicture: Boolean(bindings.coverPicture),
            coverImages: bindings.coverImages?.length || 0,
            coverSources: bindings.coverSources?.length || 0,
            hasHover: Boolean(bindings.imageHover),
            hasWatchLater: Boolean(bindings.watchLaterButton),
            hasMask: Boolean(bindings.maskNode),
            hasOwner: Boolean(bindings.ownerLink)
        });
        return clone;
    }

    function buildCardElement(card, referenceEl) {
        const templated = buildTemplateCardElement(card, referenceEl);
        if (templated) {
            return templated;
        }

        const wrapper = document.createElement('div');

        if (referenceEl) {
            wrapper.className = referenceEl.className;
        }

        const safeUrl = sanitizeUrl(card.url);
        const safeAuthorUrl = sanitizeAuthorUrl(card.authorUrl || '');
        const coverUrl = normalizeCoverUrl(card.cover || '');
        const authorHtml = card.author
            ? safeAuthorUrl
                ? `<a href="${escapeHtml(safeAuthorUrl)}" target="_blank" rel="noopener" style="font-size:12px;color:#9499a0;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none;display:block">${escapeHtml(card.author)}</a>`
                : `<div style="font-size:12px;color:#9499a0;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(card.author)}</div>`
            : '';
        const coverHtml = coverUrl
            ? `<img src="${escapeHtml(coverUrl)}" style="width:100%;border-radius:8px;display:block;aspect-ratio:16/9;object-fit:cover" loading="lazy">`
            : `<div style="width:100%;aspect-ratio:16/9;background:#e3e5e7;border-radius:8px"></div>`;
        const cardBody = `
                <div style="position:relative">
                    ${coverHtml}
                    ${card.duration ? `<span style="position:absolute;bottom:6px;right:6px;background:rgba(0,0,0,.7);color:#fff;font-size:12px;padding:1px 5px;border-radius:4px">${escapeHtml(card.duration)}</span>` : ''}
                </div>
                <div style="padding:6px 0 2px;font-size:13px;font-weight:500;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden" title="${escapeHtml(card.title)}">${escapeHtml(card.title)}</div>
                ${authorHtml}
                ${card.play ? `<div style="font-size:12px;color:#9499a0">▶ ${escapeHtml(card.play)}${card.danmaku ? ' &nbsp;&#128172; ' + escapeHtml(card.danmaku) : ''}</div>` : ''}`;

        wrapper.innerHTML = safeUrl
            ? `
            <a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;display:block">
                ${cardBody}
            </a>`
            : `
            <div style="text-decoration:none;color:inherit;display:block;cursor:default">
                ${cardBody}
            </div>`;

        wrapper.setAttribute('data-bilihistory-injected', '1');
        wrapper.setAttribute('data-bilihistory-render-mode', 'fallback');
        return wrapper;
    }

    function clearBacktrackDOM() {
        restorePatchedLiveCards(backtrackSession);
        cleanupInjectedBacktrackNodes();

        document.querySelectorAll('[data-bilihistory-hidden]').forEach((el) => {
            el.style.display = '';
            el.removeAttribute('data-bilihistory-hidden');
        });
        document.querySelectorAll('[data-bilihistory-reused]').forEach((el) => {
            el.removeAttribute('data-bilihistory-reused');
        });

        backtrackSession = null;
    }

    function renderSnapshotToPage(cards) {
        cards = normalizeSnapshotCards(cards);
        if (cards.length === 0) return;

        cleanupInjectedBacktrackNodes();
        restorePatchedLiveCards(backtrackSession);

        const feedParent = getFeedParent();
        if (!feedParent) return;

        const realCards = Array.from(
            feedParent.querySelectorAll(`:scope > ${SELECTORS.feedCard}`)
        );

        const liveCards = realCards.length > 0
            ? realCards
            : Array.from(document.querySelectorAll(`${SELECTORS.container} ${SELECTORS.feedCard}`));
        if (liveCards.length === 0) return;

        const session = ensureBacktrackSession(liveCards);
        const templateItems = session.items.filter((item) => hasUsableBindings(item.bindings));
        const reuseCount = Math.min(cards.length, liveCards.length);
        const overflowAnchor = liveCards[reuseCount] || null;
        let reusedCount = 0;
        let cloneCount = 0;
        let fallbackCount = 0;
        let hiddenTailCount = 0;

        const insertRenderedCard = (card, index, anchorEl) => {
            const templateItem = templateItems[index]
                || templateItems[index - reuseCount]
                || templateItems[0]
                || session.items[index]
                || session.items[reuseCount - 1]
                || session.items[0]
                || null;
            const referenceEl = templateItem?.element || liveCards[Math.min(index, liveCards.length - 1)] || liveCards[0] || null;
            const renderedEl = buildCardElement(card, referenceEl);
            if (!renderedEl) return;

            if (renderedEl.getAttribute('data-bilihistory-render-mode') === 'fallback') {
                fallbackCount++;
            } else {
                cloneCount++;
            }

            if (anchorEl?.parentElement) {
                anchorEl.parentElement.insertBefore(renderedEl, anchorEl);
            } else {
                feedParent.appendChild(renderedEl);
            }

            session.injectedNodes.push(renderedEl);
        };

        session.items.forEach((item, index) => {
            const liveCard = item.element;
            if (!liveCard) return;

            if (index < reuseCount) {
                if (hasUsableBindings(item.bindings) && applyCardDataToBindings(item.bindings, cards[index])) {
                    enableBacktrackInteractionGuards(item);
                    liveCard.setAttribute('data-bilihistory-reused', '1');
                    liveCard.setAttribute('data-bilihistory-render-mode', 'live-reused');
                    showBacktrackLiveCard(liveCard);
                    item.isPatched = true;
                    reusedCount++;
                } else {
                    item.previewGuardCleanup?.();
                    item.isPatched = false;
                    hideBacktrackLiveCard(liveCard);
                    hiddenTailCount++;
                    insertRenderedCard(cards[index], index, liveCard);
                }
            } else {
                item.previewGuardCleanup?.();
                item.isPatched = false;
                hideBacktrackLiveCard(liveCard);
                hiddenTailCount++;
            }
        });

        cards.slice(reuseCount).forEach((card, overflowIndex) => {
            insertRenderedCard(card, reuseCount + overflowIndex, overflowAnchor);
        });

        debugLog('render', {
            backtrackIndex,
            snapshotCardCount: cards.length,
            liveCardCount: liveCards.length,
            reusedCount,
            cloneCount,
            fallbackCount,
            hiddenTailCount
        });
    }

    function isAllowedHistoryUrl(parsedUrl) {
        const hostname = parsedUrl.hostname.toLowerCase();
        const pathname = parsedUrl.pathname || '/';

        if (!ALLOWED_HISTORY_HOSTS.includes(hostname)) {
            return false;
        }

        if (hostname === 'live.bilibili.com') {
            return /^\/\d+/.test(pathname);
        }

        return ALLOWED_HISTORY_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
    }

    function sanitizeUrl(url) {
        if (!url) return '';

        try {
            const parsed = new URL(url, window.location.origin);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return '';
            }

            return isAllowedHistoryUrl(parsed)
                ? parsed.href
                : '';
        } catch (_) {
            return '';
        }
    }

    function sanitizeAuthorUrl(url) {
        if (!url) return '';

        try {
            const parsed = new URL(url, window.location.origin);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return '';
            }

            const hostname = parsed.hostname.toLowerCase();
            const pathname = parsed.pathname || '/';
            if (hostname === 'space.bilibili.com' && /^\/\d+\/?/.test(pathname)) {
                return parsed.href;
            }

            return '';
        } catch (_) {
            return '';
        }
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function getElementLayoutDebugInfo(element) {
        if (!element) return null;

        const rect = element.getBoundingClientRect?.();
        const style = getComputedStyle(element);
        return {
            className: element.className || '',
            text: element.textContent?.trim() || '',
            width: rect ? Number(rect.width.toFixed(2)) : 0,
            minWidth: style.minWidth,
            maxWidth: style.maxWidth,
            transform: style.transform,
            display: style.display,
            justifyContent: style.justifyContent,
            gap: style.gap,
            marginLeft: style.marginLeft,
            marginRight: style.marginRight,
            paddingLeft: style.paddingLeft,
            paddingRight: style.paddingRight
        };
    }

    function getCardPreviewDebugInfo(cardEl, bindings) {
        const imageWrap = bindings.imageWrap;
        const previewRoot = imageWrap || bindings.coverLink || cardEl;
        return {
            cardPreviewDisabled: cardEl.getAttribute('data-bilihistory-preview-disabled') || '',
            wrapPreviewDisabled: imageWrap?.getAttribute('data-bilihistory-preview-disabled') || '',
            coverPreviewDisabled: bindings.coverLink?.getAttribute('data-bilihistory-preview-disabled') || '',
            cardClassName: cardEl.className || '',
            wrapClassName: imageWrap?.className || '',
            imageClassName: bindings.coverRoot?.closest('.bili-video-card__image')?.className || cardEl.querySelector('.bili-video-card__image')?.className || '',
            hoverClassName: bindings.imageHover?.className || '',
            previewMediaCount: previewRoot?.querySelectorAll?.('video, canvas')?.length || 0,
            previewMediaTags: Array.from(previewRoot?.querySelectorAll?.('video, canvas') || []).map((el) => ({
                tag: el.tagName,
                className: el.className || ''
            })),
            watchLaterDisplay: bindings.watchLaterButton ? getComputedStyle(bindings.watchLaterButton).display : 'missing',
            maskDisplay: bindings.maskNode ? getComputedStyle(bindings.maskNode).display : 'missing'
        };
    }

    function getCardStatsDebugInfo(bindings) {
        return {
            statsNode: getElementLayoutDebugInfo(bindings.statsNode),
            statsLeftNode: getElementLayoutDebugInfo(bindings.statsLeftNode),
            playItem: getElementLayoutDebugInfo(bindings.playItem),
            danmakuItem: getElementLayoutDebugInfo(bindings.danmakuItem),
            playIcon: getElementLayoutDebugInfo(bindings.playIcon),
            danmakuIcon: getElementLayoutDebugInfo(bindings.danmakuIcon),
            playNode: getElementLayoutDebugInfo(bindings.playNode),
            danmakuNode: getElementLayoutDebugInfo(bindings.danmakuNode),
            durationNode: getElementLayoutDebugInfo(bindings.durationNode)
        };
    }

    function getElementDebugAttrs(element) {
        if (!element?.attributes) return {};

        return Array.from(element.attributes).reduce((attrs, attr) => {
            if (attr.name === 'style' || attr.name.startsWith('data-') || attr.name.startsWith('aria-')) {
                attrs[attr.name] = attr.value;
            }
            return attrs;
        }, {});
    }

    function getCardChainRole(element, cardEl, bindings) {
        if (element === cardEl) return 'feed-card';
        if (element === bindings.cardRoot) return 'card-root';
        if (element === bindings.coverRoot?.closest?.('.bili-video-card__image')) return 'image';
        if (element === bindings.imageWrap) return 'image-wrap';
        if (element === bindings.coverLink) return 'cover-link';
        if (element === bindings.coverRoot) return 'cover-root';
        if (element === bindings.maskNode) return 'mask';
        return '';
    }

    function getElementChainDebugInfo(element, role = '') {
        if (!element) return null;

        const rect = element.getBoundingClientRect?.();
        const style = getComputedStyle(element);
        return {
            role,
            tag: element.tagName,
            className: element.className || '',
            attrs: getElementDebugAttrs(element),
            rect: rect ? {
                width: Number(rect.width.toFixed(2)),
                height: Number(rect.height.toFixed(2)),
                left: Number(rect.left.toFixed(2)),
                top: Number(rect.top.toFixed(2)),
                right: Number(rect.right.toFixed(2)),
                bottom: Number(rect.bottom.toFixed(2))
            } : null,
            computed: {
                display: style.display,
                position: style.position,
                boxSizing: style.boxSizing,
                overflow: style.overflow,
                overflowX: style.overflowX,
                overflowY: style.overflowY,
                transform: style.transform,
                transformOrigin: style.transformOrigin,
                transitionProperty: style.transitionProperty,
                transitionDuration: style.transitionDuration,
                transitionTimingFunction: style.transitionTimingFunction,
                width: style.width,
                height: style.height,
                minWidth: style.minWidth,
                maxWidth: style.maxWidth,
                minHeight: style.minHeight,
                maxHeight: style.maxHeight,
                margin: style.margin,
                padding: style.padding,
                fontSize: style.fontSize,
                lineHeight: style.lineHeight,
                letterSpacing: style.letterSpacing,
                textAlign: style.textAlign,
                justifyContent: style.justifyContent,
                alignItems: style.alignItems,
                gap: style.gap,
                flex: style.flex,
                flexBasis: style.flexBasis,
                flexGrow: style.flexGrow,
                flexShrink: style.flexShrink,
                opacity: style.opacity,
                visibility: style.visibility,
                zIndex: style.zIndex,
                contain: style.contain,
                willChange: style.willChange,
                zoom: style.zoom || ''
            }
        };
    }

    function getCardChainDebugInfo(cardEl, index = 0) {
        if (!cardEl) return null;

        const bindings = resolveCardBindings(cardEl);
        const chain = [];
        let current = bindings.maskNode;

        while (current && cardEl.contains(current)) {
            chain.push(current);
            if (current === cardEl) break;
            current = current.parentElement;
        }

        return {
            index,
            renderMode: cardEl.getAttribute('data-bilihistory-render-mode') || 'live',
            title: bindings.titleLink?.textContent?.trim() || bindings.titleNode?.textContent?.trim() || '',
            hasMask: Boolean(bindings.maskNode),
            chain: chain.reverse().map((element) => getElementChainDebugInfo(
                element,
                getCardChainRole(element, cardEl, bindings)
            ))
        };
    }

    function getCardChainComparable(entry) {
        if (!entry) return null;

        return {
            role: entry.role,
            tag: entry.tag,
            className: entry.className,
            attrs: entry.attrs,
            rect: entry.rect ? {
                width: entry.rect.width,
                height: entry.rect.height
            } : null,
            computed: entry.computed
        };
    }

    function diffDebugObjects(left, right) {
        const diff = {};
        const keys = new Set([
            ...Object.keys(left || {}),
            ...Object.keys(right || {})
        ]);

        keys.forEach((key) => {
            const leftValue = left?.[key];
            const rightValue = right?.[key];
            if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
                diff[key] = { left: leftValue, right: rightValue };
            }
        });

        return diff;
    }

    function compareCardChainDebugInfo(leftCardEl, rightCardEl, leftIndex = 0, rightIndex = 0) {
        const left = getCardChainDebugInfo(leftCardEl, leftIndex);
        const right = getCardChainDebugInfo(rightCardEl, rightIndex);
        const maxLength = Math.max(left?.chain?.length || 0, right?.chain?.length || 0);
        const differences = [];

        for (let index = 0; index < maxLength; index++) {
            const leftEntry = getCardChainComparable(left?.chain?.[index]);
            const rightEntry = getCardChainComparable(right?.chain?.[index]);
            const diff = diffDebugObjects(leftEntry, rightEntry);
            if (Object.keys(diff).length > 0) {
                differences.push({
                    chainIndex: index,
                    leftRole: leftEntry?.role || '',
                    rightRole: rightEntry?.role || '',
                    diff
                });
            }
        }

        return { left, right, differences };
    }

    function getCardDebugInfo(cardEl, index = 0, options = {}) {
        if (!cardEl) return null;

        const bindings = resolveCardBindings(cardEl);
        const imageEl = bindings.coverImages?.[0] || bindings.coverImage || null;
        const result = {
            index,
            injected: cardEl.hasAttribute('data-bilihistory-injected') || Boolean(cardEl.querySelector('[data-bilihistory-injected]')),
            hidden: cardEl.hasAttribute('data-bilihistory-hidden'),
            renderMode: cardEl.getAttribute('data-bilihistory-render-mode') || cardEl.querySelector('[data-bilihistory-render-mode]')?.getAttribute('data-bilihistory-render-mode') || 'live',
            title: bindings.titleLink?.textContent?.trim() || bindings.titleNode?.textContent?.trim() || '',
            href: bindings.coverLink?.href || bindings.titleLink?.href || '',
            imgSrc: imageEl?.getAttribute('src') || '',
            currentSrc: imageEl?.currentSrc || '',
            sources: (bindings.coverSources || []).map((sourceEl) => sourceEl.getAttribute('srcset') || ''),
            pipDisplay: bindings.watchLaterButton ? getComputedStyle(bindings.watchLaterButton).display : 'missing',
            hasHover: Boolean(bindings.imageHover),
            hasMask: Boolean(bindings.maskNode),
            hasOwner: Boolean(bindings.ownerLink)
        };

        if (options.deep) {
            result.preview = getCardPreviewDebugInfo(cardEl, bindings);
            result.stats = getCardStatsDebugInfo(bindings);
        }

        return result;
    }

    function installPageDebugBridge() {
        if (!ENABLE_PAGE_DEBUG_BRIDGE) return;
        if (debugBridgeInstalled || document.documentElement?.dataset?.bilihistoryDebugBridgeInstalled === '1') {
            debugBridgeInstalled = true;
            return;
        }

        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('page-debug-bridge.js');
        script.async = false;
        script.onload = () => {
            debugBridgeInstalled = true;
            script.remove();
        };
        script.onerror = () => {
            debugBridgeInstalled = false;
            document.documentElement?.removeAttribute('data-bilihistory-debug-bridge-installed');
            debugLog('bridge-error', { message: 'Failed to load page debug bridge' });
            script.remove();
        };

        (document.head || document.documentElement || document.body).appendChild(script);
        document.documentElement.dataset.bilihistoryDebugBridgeInstalled = '1';
    }

    function installDebugHelpers() {
        if (!isDebugMode()) return;

        installPageDebugBridge();

        document.removeEventListener('bilihistory:debug-request', window.__BILIHISTORY_DEBUG_REQUEST_HANDLER__);
        window.__BILIHISTORY_DEBUG_REQUEST_HANDLER__ = (event) => {
            const { requestId, type, index = 0, limit = 3, leftIndex = 0, rightIndex = 1 } = event.detail || {};
            let result = null;

            if (type === 'dump-card') {
                const cards = Array.from(document.querySelectorAll(`${SELECTORS.container} ${SELECTORS.feedCard}`));
                result = getCardDebugInfo(cards[index], index);
            } else if (type === 'dump-card-deep') {
                const cards = Array.from(document.querySelectorAll(`${SELECTORS.container} ${SELECTORS.feedCard}`));
                result = getCardDebugInfo(cards[index], index, { deep: true });
            } else if (type === 'dump-render') {
                const cards = Array.from(document.querySelectorAll(`${SELECTORS.container} ${SELECTORS.feedCard}`)).slice(0, limit);
                result = cards.map((cardEl, cardIndex) => getCardDebugInfo(cardEl, cardIndex));
            } else if (type === 'dump-render-deep') {
                const cards = Array.from(document.querySelectorAll(`${SELECTORS.container} ${SELECTORS.feedCard}`)).slice(0, limit);
                result = cards.map((cardEl, cardIndex) => getCardDebugInfo(cardEl, cardIndex, { deep: true }));
            } else if (type === 'dump-card-chain') {
                const cards = Array.from(document.querySelectorAll(`${SELECTORS.container} ${SELECTORS.feedCard}`));
                result = getCardChainDebugInfo(cards[index], index);
            } else if (type === 'compare-card-chain') {
                const cards = Array.from(document.querySelectorAll(`${SELECTORS.container} ${SELECTORS.feedCard}`));
                result = compareCardChainDebugInfo(cards[leftIndex], cards[rightIndex], leftIndex, rightIndex);
            }

            document.dispatchEvent(new CustomEvent('bilihistory:debug-response', {
                detail: { requestId, result }
            }));
        };
        document.addEventListener('bilihistory:debug-request', window.__BILIHISTORY_DEBUG_REQUEST_HANDLER__);

        window.__BILIHISTORY_DEBUG_DUMP_CARD__ = (index = 0) => {
            const cards = Array.from(document.querySelectorAll(`${SELECTORS.container} ${SELECTORS.feedCard}`));
            return getCardDebugInfo(cards[index], index);
        };

        window.__BILIHISTORY_DEBUG_DUMP_CARD_DEEP__ = (index = 0) => {
            const cards = Array.from(document.querySelectorAll(`${SELECTORS.container} ${SELECTORS.feedCard}`));
            return getCardDebugInfo(cards[index], index, { deep: true });
        };

        window.__BILIHISTORY_DEBUG_DUMP_RENDER__ = (limit = 3) => {
            const cards = Array.from(document.querySelectorAll(`${SELECTORS.container} ${SELECTORS.feedCard}`)).slice(0, limit);
            return cards.map((cardEl, index) => getCardDebugInfo(cardEl, index));
        };

        window.__BILIHISTORY_DEBUG_DUMP_RENDER_DEEP__ = (limit = 3) => {
            const cards = Array.from(document.querySelectorAll(`${SELECTORS.container} ${SELECTORS.feedCard}`)).slice(0, limit);
            return cards.map((cardEl, index) => getCardDebugInfo(cardEl, index, { deep: true }));
        };

        window.__BILIHISTORY_DEBUG_DUMP_CARD_CHAIN__ = (index = 0) => {
            const cards = Array.from(document.querySelectorAll(`${SELECTORS.container} ${SELECTORS.feedCard}`));
            return getCardChainDebugInfo(cards[index], index);
        };

        window.__BILIHISTORY_DEBUG_COMPARE_CARD_CHAIN__ = (leftIndex = 0, rightIndex = 1) => {
            const cards = Array.from(document.querySelectorAll(`${SELECTORS.container} ${SELECTORS.feedCard}`));
            return compareCardChainDebugInfo(cards[leftIndex], cards[rightIndex], leftIndex, rightIndex);
        };
    }

    function observeDebugFlag() {
        if (!ENABLE_PAGE_DEBUG_BRIDGE || debugAttributeObserver || !document.documentElement) return;

        debugAttributeObserver = new MutationObserver(() => {
            if (isDebugMode()) {
                installDebugHelpers();
            }
        });

        debugAttributeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-bilihistory-debug']
        });
    }

    function observeHistoryStorageChanges() {
        chrome.storage?.onChanged?.addListener((changes, areaName) => {
            if (areaName === 'local' && changes.feedHistory && !changes.feedHistory.newValue) {
                handleHistoryCleared();
            }
        });
    }

    function updateBacktrackUI() {
        if (!backtrackBtn) return;

        const busy = isBusyMode();
        const inBacktrackMode = currentMode === MODES.BACKTRACKING && backtrackIndex >= 1;
        const setBacktrackStatus = (text, title) => {
            if (backtrackCountEl) {
                backtrackCountEl.textContent = text;
            }
            backtrackBtn.toggleAttribute('data-bilihistory-status-active', Boolean(text));
            backtrackBtn.title = title;
        };

        if (busy) {
            setBacktrackStatus('更新', '正在同步推荐历史');
        } else if (inBacktrackMode && backtrackIndex < historyCache.length) {
            const snapshot = historyCache[backtrackIndex];
            const time = new Date(snapshot.timestamp).toLocaleTimeString('zh-CN', {
                hour: '2-digit', minute: '2-digit'
            });
            const progress = `${backtrackIndex}/${historyCache.length - 1}`;
            setBacktrackStatus(progress, `查看上一批推荐（当前：${time} · ${progress}）`);
        } else {
            setBacktrackStatus('', '查看上一批推荐');
        }

        const canBacktrack = historyCache.length >= 2 && !busy;
        const atOldest = inBacktrackMode && backtrackIndex >= historyCache.length - 1;
        backtrackBtn.disabled = !canBacktrack || atOldest;

        if (forwardBtn) {
            forwardBtn.style.display = inBacktrackMode ? 'flex' : 'none';
            forwardBtn.disabled = busy;
        }
    }

    // ──────────────────────────────────────
    // Initialization
    // ──────────────────────────────────────

    function removeBacktrackButtons() {
        backtrackBtn?.remove();
        forwardBtn?.remove();
        backtrackBtn = null;
        forwardBtn = null;
        backtrackCountEl = null;
    }

    function deactivateApp() {
        if (!isAppActive) return;

        isAppActive = false;
        observer?.disconnect();
        observer = null;

        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }

        stopRollObservation(true);
        snapshotQueue = [];
        syncLastEnqueuedFingerprint();
        restoreLiveFeed();
        removeBacktrackButtons();
        setMode(MODES.LIVE_IDLE);
    }

    function handleActiveMutation(mutations) {
        if (!isAppActive) return;
        if (!isSupportedHomepage()) {
            deactivateApp();
            return;
        }

        if (rollObservationActive && mutationTouchesFeed(mutations)) {
            beginRollObservation();
            flushRollSnapshot();
        }

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            if (!isAppActive) return;

            const container = document.querySelector(SELECTORS.container);
            const feedCards = getLiveFeedCards();

            if (container && feedCards.length > 0 && !initialCaptured) {
                // First capture only — subsequent captures triggered by roll-btn
                initialCaptured = true;
                captureFeedCards({ source: 'initial' });
            }

            // Re-hook UI elements if B站 re-rendered them
            hookRollButton();
            injectBacktrackButton();
        }, 120);
    }

    function activateApp() {
        if (isAppActive || !isSupportedHomepage()) {
            return;
        }

        isAppActive = true;
        initialCaptured = false;

        observer = new MutationObserver(handleActiveMutation);
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        const feedCards = getLiveFeedCards();
        if (feedCards.length > 0) {
            initialCaptured = true;
            captureFeedCards({ source: 'initial' });
            hookRollButton();
            injectBacktrackButton();
            void refreshHistoryCache();
        }
    }

    function syncAppActivation() {
        if (isSupportedHomepage()) {
            activateApp();
        } else {
            deactivateApp();
        }
    }

    function scheduleRouteSync() {
        if (routeSyncTimer) return;

        routeSyncTimer = setTimeout(() => {
            routeSyncTimer = null;
            syncAppActivation();
        }, 0);
    }

    function installRouteHooks() {
        if (routeHooksInstalled) return;
        routeHooksInstalled = true;

        const notifyRouteChange = () => {
            scheduleRouteSync();
        };

        window.addEventListener('popstate', notifyRouteChange);
        window.addEventListener('hashchange', notifyRouteChange);

        const originalPushState = history.pushState;
        history.pushState = function (...args) {
            const result = originalPushState.apply(this, args);
            notifyRouteChange();
            return result;
        };

        const originalReplaceState = history.replaceState;
        history.replaceState = function (...args) {
            const result = originalReplaceState.apply(this, args);
            notifyRouteChange();
            return result;
        };
    }

    function init() {
        observeHistoryStorageChanges();
        observeDebugFlag();
        if (isDebugMode()) {
            installDebugHelpers();
        }

        installRouteHooks();
        syncAppActivation();
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
