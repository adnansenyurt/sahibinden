// background.js (MV3, "type": "module")

/**
 * Utility: find all open sahibinden tabs.
 */
async function getSahibindenTabs() {
  return await chrome.tabs.query({ url: "*://www.sahibinden.com/*" });
}

/**
 * Relay a message to all sahibinden tabs (content scripts).
 */
async function broadcastToSahibindenTabs(message) {
  const tabs = await getSahibindenTabs();
  for (const t of tabs) {
    try {
      if (t.id) await chrome.tabs.sendMessage(t.id, message);
    } catch (e) {
      // Content script may not be injected yet on some pages.
      // It's okay to ignore.
      console.debug("broadcast error:", e?.message);
    }
  }
}

/**
 * Lifecycle hooks
 */
chrome.runtime.onInstalled.addListener(async () => {
  // Set initial defaults if needed
  const init = await chrome.storage.local.get(["lastSyncAt"]);
  if (!init.lastSyncAt) {
    await chrome.storage.local.set({ lastSyncAt: null });
  }
  console.log("Sahibinden Notes: background installed.");
});

chrome.runtime.onStartup.addListener(() => {
  console.log("Sahibinden Notes: background started.");
});

/**
 * Message router
 * - Popup can either talk directly to contentScript, or via background.
 * - We keep this as a reliable fallback/broadcast point.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "SYNC_NOTES_NOW":
        // Forward to all sahibinden tabs; contentScript handles REST pull.
        await broadcastToSahibindenTabs({ type: "SYNC_NOTES_NOW" });
        sendResponse({ ok: true });
        break;

      case "PING_BACKGROUND":
        sendResponse({ ok: true, ts: Date.now() });
        break;

      default:
        // No-op for unknown messages (keeps background lean).
        sendResponse({ ok: false, reason: "UNKNOWN_MESSAGE" });
    }
  })();
  // Indicate we will respond async
  return true;
});

/**
 * Optional: If you later add auto-sync, you can enable alarms here.
 * (Requires adding "alarms" to manifest permissions.)
 *
 * Example:
 *
 * chrome.alarms.create("autoSync", { periodInMinutes: 1 });
 * chrome.alarms.onAlarm.addListener(async (alarm) => {
 *   if (alarm.name === "autoSync") {
 *     await broadcastToSahibindenTabs({ type: "SYNC_NOTES_NOW" });
 *   }
 * });
 */

let ports = new Set();

// Handle connection attempts
chrome.runtime.onConnect.addListener(port => {
    ports.add(port);
    port.onDisconnect.addListener(() => {
        ports.delete(port);
    });
});

// Recovery handler
chrome.runtime.onInstalled.addListener(() => {
    ports.clear();
});

// Error handler
chrome.runtime.onSuspend.addListener(() => {
    ports.forEach(port => port.disconnect());
    ports.clear();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.includes('sahibinden.com')) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['injected.js']
      });
    } catch (err) {
      console.error('Injection failed:', err);
    }
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.url.includes('sahibinden.com')) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    
    chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['content.css']
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background received message:', message);
  sendResponse({ received: true });
});
