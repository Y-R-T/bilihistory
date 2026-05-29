// Bilibili Feed History — Background Service Worker
// Manages persistent storage of feed snapshots via chrome.storage.local

const MAX_SNAPSHOTS = 500;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;

let saveQueue = Promise.resolve();

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'SAVE_SNAPSHOT':
      enqueueSaveSnapshot(message.data).then(sendResponse);
      return true; // async response

    case 'GET_HISTORY':
      enqueueStorageRead(() => getHistory(message.page, message.pageSize)).then(sendResponse);
      return true;

    case 'GET_SNAPSHOT':
      enqueueStorageRead(() => getSnapshot(message.id)).then(sendResponse);
      return true;

    case 'GET_ALL_SNAPSHOTS':
      enqueueStorageRead(getAllSnapshots).then(sendResponse);
      return true;

    case 'CLEAR_HISTORY':
      enqueueClearHistory().then(sendResponse);
      return true;

    case 'GET_STATS':
      enqueueStorageRead(getStats).then(sendResponse);
      return true;

    default:
      sendResponse({ success: false, error: 'Unknown message type' });
      return false;
  }
});

async function loadFeedHistory() {
  const result = await chrome.storage.local.get('feedHistory');
  return Array.isArray(result.feedHistory) ? result.feedHistory : [];
}

async function saveFeedHistory(history) {
  await chrome.storage.local.set({ feedHistory: history });
}

function estimateHistoryBytes(history) {
  return new TextEncoder().encode(JSON.stringify({ feedHistory: history })).length;
}

function trimHistory(history) {
  if (history.length > MAX_SNAPSHOTS) {
    history.length = MAX_SNAPSHOTS;
  }

  while (history.length > 0 && estimateHistoryBytes(history) > MAX_HISTORY_BYTES) {
    history.pop();
  }
}

function enqueueStorageWrite(writeJob) {
  const job = saveQueue.then(writeJob);
  saveQueue = job.catch(() => undefined);
  return job;
}

function enqueueStorageRead(readJob) {
  return saveQueue.then(readJob);
}

function enqueueSaveSnapshot(snapshot) {
  return enqueueStorageWrite(() => saveSnapshot(snapshot));
}

function enqueueClearHistory() {
  return enqueueStorageWrite(clearHistory);
}

function clampInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function normalizeSnapshotCards(cards) {
  return Array.isArray(cards)
    ? cards.filter(card => card && typeof card === 'object')
    : [];
}

async function saveSnapshot(snapshot) {
  try {
    const history = await loadFeedHistory();
    const previousLength = history.length;

    const entry = {
      id: generateId(),
      timestamp: Date.now(),
      cards: normalizeSnapshotCards(snapshot?.cards)
    };

    history.unshift(entry); // newest first
    trimHistory(history);

    if (!history.some((item) => item.id === entry.id)) {
      return { success: false, error: 'Snapshot exceeds storage budget' };
    }

    await saveFeedHistory(history);
    return {
      success: true,
      id: entry.id,
      timestamp: entry.timestamp,
      total: history.length,
      trimmed: Math.max(0, previousLength + 1 - history.length)
    };
  } catch (err) {
    console.error('[BiliHistory] Save failed:', err);
    return { success: false, error: err.message };
  }
}

async function getHistory(page, pageSize) {
  try {
    const history = await loadFeedHistory();
    const safePage = clampInteger(page, 0, { min: 0 });
    const safePageSize = clampInteger(pageSize, 20, { min: 1, max: 100 });
    const start = safePage * safePageSize;
    const end = start + safePageSize;
    const items = history.slice(start, end).map(entry => {
      const cards = normalizeSnapshotCards(entry.cards);
      return {
        id: entry.id,
        timestamp: entry.timestamp,
        cardCount: cards.length
      };
    });

    return {
      success: true,
      items,
      total: history.length,
      hasMore: end < history.length,
      page: safePage,
      pageSize: safePageSize
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getSnapshot(id) {
  try {
    if (typeof id !== 'string' || id.length === 0) {
      return { success: false, error: 'Invalid snapshot id' };
    }

    const history = await loadFeedHistory();
    const snapshot = history.find(entry => entry.id === id);
    if (!snapshot) {
      return { success: false, error: 'Snapshot not found' };
    }

    return {
      success: true,
      snapshot: {
        ...snapshot,
        cards: normalizeSnapshotCards(snapshot.cards)
      }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getAllSnapshots() {
  try {
    const history = await loadFeedHistory();
    const snapshots = history.map(entry => ({
      ...entry,
      cards: normalizeSnapshotCards(entry.cards)
    }));
    return { success: true, snapshots };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function clearHistory() {
  try {
    await chrome.storage.local.remove('feedHistory');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getStats() {
  try {
    const history = await loadFeedHistory();
    const totalCards = history.reduce((sum, entry) => {
      const cards = normalizeSnapshotCards(entry.cards);
      return sum + cards.length;
    }, 0);
    return {
      success: true,
      totalSnapshots: history.length,
      totalCards,
      oldestTimestamp: history.length > 0 ? history[history.length - 1].timestamp : null,
      newestTimestamp: history.length > 0 ? history[0].timestamp : null
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}
