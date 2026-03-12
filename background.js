// Bilibili Feed History — Background Service Worker
// Manages persistent storage of feed snapshots via chrome.storage.local

const MAX_SNAPSHOTS = 500;

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'SAVE_SNAPSHOT':
      saveSnapshot(message.data).then(sendResponse);
      return true; // async response

    case 'GET_HISTORY':
      getHistory(message.page || 0, message.pageSize || 20).then(sendResponse);
      return true;

    case 'GET_SNAPSHOT':
      getSnapshot(message.id).then(sendResponse);
      return true;

    case 'GET_ALL_SNAPSHOTS':
      getAllSnapshots().then(sendResponse);
      return true;

    case 'CLEAR_HISTORY':
      clearHistory().then(sendResponse);
      return true;

    case 'GET_STATS':
      getStats().then(sendResponse);
      return true;
  }
});

async function loadFeedHistory() {
  const result = await chrome.storage.local.get('feedHistory');
  return result.feedHistory || [];
}

async function saveFeedHistory(history) {
  await chrome.storage.local.set({ feedHistory: history });
}

async function saveSnapshot(snapshot) {
  try {
    const history = await loadFeedHistory();

    const entry = {
      id: generateId(),
      timestamp: Date.now(),
      cards: snapshot.cards || []
    };

    history.unshift(entry); // newest first

    // Enforce storage limit
    if (history.length > MAX_SNAPSHOTS) {
      history.length = MAX_SNAPSHOTS;
    }

    await saveFeedHistory(history);
    return { success: true, id: entry.id, timestamp: entry.timestamp, total: history.length };
  } catch (err) {
    console.error('[BiliHistory] Save failed:', err);
    return { success: false, error: err.message };
  }
}

async function getHistory(page, pageSize) {
  try {
    const history = await loadFeedHistory();
    const start = page * pageSize;
    const end = start + pageSize;
    const items = history.slice(start, end).map(entry => ({
      id: entry.id,
      timestamp: entry.timestamp,
      cardCount: entry.cards.length
    }));

    return {
      success: true,
      items,
      total: history.length,
      hasMore: end < history.length
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getSnapshot(id) {
  try {
    const history = await loadFeedHistory();
    const snapshot = history.find(entry => entry.id === id);
    return snapshot
      ? { success: true, snapshot }
      : { success: false, error: 'Snapshot not found' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getAllSnapshots() {
  try {
    const history = await loadFeedHistory();
    return { success: true, snapshots: history };
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
    const totalCards = history.reduce((sum, entry) => sum + entry.cards.length, 0);
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
