// Bilibili Feed History — Popup Script

document.addEventListener('DOMContentLoaded', () => {
    const timeline = document.getElementById('timeline');
    const loading = document.getElementById('loading');
    const detailOverlay = document.getElementById('detail-overlay');
    const detailTitle = document.getElementById('detail-title');
    const detailCards = document.getElementById('detail-cards');
    const detailBack = document.getElementById('detail-back');
    const clearBtn = document.getElementById('clear-btn');
    const loadMoreBtn = document.getElementById('load-more-btn');
    const loadMoreWrapper = document.getElementById('load-more-wrapper');
    const statSnapshots = document.getElementById('stat-snapshots');
    const statCards = document.getElementById('stat-cards');

    let currentPage = 0;
    const PAGE_SIZE = 30;
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

    // ── Init ──

    loadStats();
    loadHistory();

    // ── Event Listeners ──

    clearBtn.addEventListener('click', async () => {
        if (!confirm('确定清空所有推荐历史记录？此操作不可恢复。')) {
            return;
        }

        const res = await sendRuntimeMessage({ type: 'CLEAR_HISTORY' });
        if (res?.success) {
            timeline.innerHTML = '<div class="empty">暂无记录</div>';
            statSnapshots.textContent = '0';
            statCards.textContent = '0';
            loadMoreWrapper.style.display = 'none';
        }
    });

    detailBack.addEventListener('click', () => {
        detailOverlay.classList.remove('visible');
    });

    loadMoreBtn.addEventListener('click', async () => {
        const nextPage = currentPage + 1;
        const loaded = await loadHistory(true, nextPage);
        if (loaded) {
            currentPage = nextPage;
        }
    });

    // ── Data Loading ──

    async function loadStats() {
        const res = await sendRuntimeMessage({ type: 'GET_STATS' });
        if (res?.success) {
            statSnapshots.textContent = res.totalSnapshots.toLocaleString();
            statCards.textContent = res.totalCards.toLocaleString();
        }
    }

    async function loadHistory(append = false, page = currentPage) {
        const res = await sendRuntimeMessage({ type: 'GET_HISTORY', page, pageSize: PAGE_SIZE });
        loading.style.display = 'none';

        if (!res?.success) {
            if (!append) {
                timeline.innerHTML = '<div class="empty">加载失败</div>';
            }
            return false;
        }

        if (res.items.length === 0 && !append) {
            timeline.innerHTML = '<div class="empty">暂无记录<br><span class="empty-hint">访问 bilibili.com 首页开始记录</span></div>';
            return true;
        }

        if (!append) {
            timeline.innerHTML = '';
        }

        // Group by date
        const grouped = groupByDate(res.items);
        for (const [dateStr, items] of Object.entries(grouped)) {
            let dateSection = timeline.querySelector(`[data-date="${dateStr}"]`);
            if (!dateSection) {
                const dateHeader = document.createElement('div');
                dateHeader.className = 'date-header';
                dateHeader.setAttribute('data-date', dateStr);
                dateHeader.textContent = dateStr;
                timeline.appendChild(dateHeader);
                dateSection = dateHeader;
            }

            items.forEach(item => {
                const el = createTimelineItem(item);
                timeline.appendChild(el);
            });
        }

        // Show/hide load more
        loadMoreWrapper.style.display = res.hasMore ? '' : 'none';
        return true;
    }

    // ── Rendering ──

    function groupByDate(items) {
        const grouped = {};
        items.forEach(item => {
            const date = new Date(item.timestamp);
            const dateStr = formatDate(date);
            if (!grouped[dateStr]) grouped[dateStr] = [];
            grouped[dateStr].push(item);
        });
        return grouped;
    }

    function formatDate(date) {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        if (date.toDateString() === today.toDateString()) return '今天';
        if (date.toDateString() === yesterday.toDateString()) return '昨天';

        const year = date.getFullYear();
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const day = date.getDate().toString().padStart(2, '0');

        if (year === today.getFullYear()) return `${month}月${day}日`;
        return `${year}年${month}月${day}日`;
    }

    function formatTime(date) {
        return date.toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    function createTimelineItem(item) {
        const el = document.createElement('div');
        el.className = 'timeline-item';

        const time = new Date(item.timestamp);
        
        // Dot
        const dot = document.createElement('div');
        dot.className = 'timeline-dot';
        el.appendChild(dot);
        
        // Content
        const content = document.createElement('div');
        content.className = 'timeline-content';
        
        const timeSpan = document.createElement('span');
        timeSpan.className = 'timeline-time';
        timeSpan.textContent = formatTime(time);
        content.appendChild(timeSpan);
        
        const countSpan = document.createElement('span');
        countSpan.className = 'timeline-count';
        countSpan.textContent = `${item.cardCount} 个视频`;
        content.appendChild(countSpan);
        
        el.appendChild(content);

        // Arrow icon (SVG is safe static HTML)
        const arrow = document.createElement('div');
        arrow.className = 'timeline-arrow';
        arrow.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
        el.appendChild(arrow);

        el.addEventListener('click', () => showDetail(item.id, time));
        return el;
    }

    async function showDetail(snapshotId, time) {
        detailTitle.textContent = `${formatDate(time)} ${formatTime(time)}`;
        detailCards.innerHTML = '<div class="loading">加载中...</div>';
        detailOverlay.classList.add('visible');

        const res = await sendRuntimeMessage({ type: 'GET_SNAPSHOT', id: snapshotId });
        if (!res?.success) {
            detailCards.innerHTML = '<div class="empty">加载失败</div>';
            return;
        }

        const cards = Array.isArray(res.snapshot?.cards) ? res.snapshot.cards : [];
        detailCards.innerHTML = '';

        if (cards.length === 0) {
            detailCards.innerHTML = '<div class="empty">此快照暂无卡片</div>';
            return;
        }

        cards.forEach(card => {
            const cardEl = createCardElement(card);
            detailCards.appendChild(cardEl);
        });
    }

    function createCardElement(card) {
        const sourceCard = card && typeof card === 'object' ? card : {};
        const safeUrl = sanitizeUrl(sourceCard.url);
        const el = document.createElement(safeUrl ? 'a' : 'div');
        el.className = 'card';

        if (safeUrl) {
            el.href = safeUrl;
            el.target = '_blank';
            el.rel = 'noopener';
        }

        const coverSrc = normalizeCoverUrl(sourceCard.cover || '');
        const hasCover = coverSrc.length > 0;

        const title = sourceCard.title || '';
        const duration = sourceCard.duration || '';
        const author = sourceCard.author || '';
        const play = sourceCard.play || '';

        el.innerHTML = `
      <div class="card-cover">
        ${hasCover ? `<img src="${escapeHtml(coverSrc)}" alt="" loading="lazy">` : '<div class="card-cover-placeholder">无封面</div>'}
        ${duration ? `<span class="card-duration">${escapeHtml(duration)}</span>` : ''}
      </div>
      <div class="card-info">
        <div class="card-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
        <div class="card-meta">
          ${author ? `<span class="card-author">${escapeHtml(author)}</span>` : ''}
          ${play ? `<span class="card-play">▶ ${escapeHtml(play)}</span>` : ''}
        </div>
      </div>
    `;

        return el;
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

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
});
