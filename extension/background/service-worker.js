/**
 * Background service worker: badge, downloads, full dashboard tab.
 */
const DASHBOARD_PATH = "dashboard/dashboard.html";

function openDashboard() {
  const url = chrome.runtime.getURL(DASHBOARD_PATH);
  chrome.tabs.query({}, (tabs) => {
    const existing = tabs.find((t) => t.url === url);
    if (existing) {
      chrome.tabs.update(existing.id, { active: true }).catch(() => {});
      if (existing.windowId != null) {
        chrome.windows
          .update(existing.windowId, { focused: true })
          .catch(() => {});
      }
      return;
    }
    chrome.tabs.create({ url }).catch(() => {});
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "XFC_BADGE") {
    const n = msg.count || 0;
    const text = n > 9999 ? "9999+" : n > 0 ? String(n) : "";
    chrome.action.setBadgeText({ text, tabId: sender.tab?.id }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: "#1d9bf0" });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "XFC_DOWNLOAD") {
    const { filename, content, mime } = msg;
    const blobUrl =
      "data:" +
      (mime || "text/plain") +
      ";charset=utf-8," +
      encodeURIComponent(content);
    chrome.downloads.download(
      { url: blobUrl, filename: filename || "followers.json", saveAs: true },
      (id) => {
        sendResponse({ ok: !!id, id });
      },
    );
    return true;
  }

  if (msg.type === "XFC_OPEN_DASHBOARD" || msg.type === "XFC_OPEN_POPUP_HINT") {
    openDashboard();
    sendResponse({ ok: true });
    return true;
  }
});

// Toolbar icon opens the full-screen dashboard tab (no tiny popup).
chrome.action.onClicked.addListener(() => {
  openDashboard();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: "#1d9bf0" });
});
