// MV3 service worker：跨 frame 汇总、profile 存取、命令下发。
// 本阶段不做任何网络请求（AI 在 P3 才接入，且届时 Key 也只经这里出网）。

const CHANNEL = 'nw-autofill';

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['profile', 'settings'], (data) => {
    if (!data.settings) {
      chrome.storage.local.set({
        settings: {
          mode: 'full',
          fillSensitive: false,   // 证件号/手机号默认不自动写，需显式打开
          autoSubmitNever: true,  // 常量，仅作为可见的"设计承诺"
        },
      });
    }
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel?.open) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/sidepanel.html') });
  }
});

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, { ...msg, __nwFrame: 'all' });
  } catch (err) {
    return { ok: false, error: String(err?.message || err), noContentScript: true };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (msg.type === 'nw:getState') {
      const { profile, settings } = await chrome.storage.local.get(['profile', 'settings']);
      sendResponse({ ok: true, profile: profile || null, settings: settings || {}, tabId });
    } else if (msg.type === 'nw:saveProfile') {
      await chrome.storage.local.set({ profile: msg.profile });
      sendResponse({ ok: true });
    } else if (msg.type === 'nw:saveSettings') {
      await chrome.storage.local.set({ settings: { ...(await chrome.storage.local.get('settings')).settings, ...msg.settings } });
      sendResponse({ ok: true });
    } else if (msg.type === 'nw:scan' || msg.type === 'nw:undo' || msg.type === 'nw:ping' || msg.type === 'nw:clearMarks') {
      const res = await sendToTab(tabId, msg);
      sendResponse(res);
    } else {
      sendResponse({ ok: false, error: 'unknown_message' });
    }
  })();
  return true;
});
