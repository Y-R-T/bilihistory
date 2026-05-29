(() => {
    if (window.__BILIHISTORY_PAGE_DEBUG_BRIDGE__) return;
    window.__BILIHISTORY_PAGE_DEBUG_BRIDGE__ = true;

    const request = (type, payload = {}) => new Promise((resolve) => {
        const requestId = 'bilihistory-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        let settled = false;
        const cleanup = () => {
            document.removeEventListener('bilihistory:debug-response', onResponse);
            clearTimeout(timeoutId);
        };
        const onResponse = (event) => {
            if (event.detail?.requestId !== requestId || settled) return;
            settled = true;
            cleanup();
            resolve(event.detail.result);
        };
        const timeoutId = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(null);
        }, 3000);

        document.addEventListener('bilihistory:debug-response', onResponse);
        document.dispatchEvent(new CustomEvent('bilihistory:debug-request', {
            detail: { requestId, type, ...payload }
        }));
    });

    Object.defineProperty(window, '__BILIHISTORY_DEBUG__', {
        configurable: true,
        get() {
            return document.documentElement.dataset.bilihistoryDebug === '1';
        },
        set(value) {
            document.documentElement.dataset.bilihistoryDebug = value ? '1' : '0';
            return value;
        }
    });

    window.__BILIHISTORY_DEBUG_DUMP_CARD__ = (index = 0) => request('dump-card', { index });
    window.__BILIHISTORY_DEBUG_DUMP_CARD_DEEP__ = (index = 0) => request('dump-card-deep', { index });
    window.__BILIHISTORY_DEBUG_DUMP_RENDER__ = (limit = 3) => request('dump-render', { limit });
    window.__BILIHISTORY_DEBUG_DUMP_RENDER_DEEP__ = (limit = 3) => request('dump-render-deep', { limit });
    window.__BILIHISTORY_DEBUG_DUMP_CARD_CHAIN__ = (index = 0) => request('dump-card-chain', { index });
    window.__BILIHISTORY_DEBUG_COMPARE_CARD_CHAIN__ = (leftIndex = 0, rightIndex = 1) => request('compare-card-chain', { leftIndex, rightIndex });
})();
