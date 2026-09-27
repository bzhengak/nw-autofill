// MV3 service worker：跨 frame 汇总、profile 存取、命令下发。
// 本阶段不做任何网络请求（AI 在 P3 才接入，且届时 Key 也只经这里出网）。

const CHANNEL = 'nw-autofill';

/** 适配器加载：以前只有 tests/tools 用得到它们，真实页面上 pins/slotPins/skip/dateFormats 全部没生效。
 *  现在由 worker 读 registry → 逐个 validateAdapter → 按标签页 URL 选一个，随扫描消息下发。 */
let adapterResolver = null;
async function getAdapterResolver() {
  if (adapterResolver) return adapterResolver;
  try {
    const mod = await import(chrome.runtime.getURL('core/adapters.js'));
    const reg = await (await fetch(chrome.runtime.getURL('adapters/registry.json'))).json();
    const files = {};
    for (const f of (reg && reg.files) || []) {
      try { files[f] = await (await fetch(chrome.runtime.getURL(f))).json(); }
      catch { files[f] = null; }
    }
    adapterResolver = mod.compileAdapters(files, m => console.warn('[网申填写]', m));
  } catch (err) {
    console.warn('[网申填写] 适配器加载失败，本次按无适配器运行：', err);
    adapterResolver = { adapters: [], rejected: [], resolve: () => null };
  }
  return adapterResolver;
}

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

/** 一个 frame 的应答包成 Promise：拒绝（无 content script 的 frame）塌成 null，不参与竞争 */
function replyFrom(tabId, frameId, msg) {
  return chrome.tabs.sendMessage(tabId, { ...msg, __nwFrame: 'all' }, { frameId })
    .then(res => (res && typeof res === 'object' ? { ...res, __frameId: frameId } : null))
    .catch(() => null);
}

/** 探针结果"够不够真页"：第三方 iframe（广告 cookie-sync、cookie 同意框）通常是空壳，
 *  靠控件数与 URL 就能区分出来——不能让它抢在慢半拍的真表单前面。 */
function probeQuality(res) {
  if (!res?.ok) return -1;
  const t = res.data?.totals || {};
  const url = String(res.data?.url || '');
  const junk = /(adsrvr|doubleclick|cookie|consent|onetrust|trustarc|quantserve|facebook|analytics)/i.test(url);
  const controls = Number(t.controls) || 0;
  return (junk ? 0 : 1_000_000) + controls * 100 + (res.__frameId === 0 ? 50 : 0);
}

async function sendToTab(tabId, msg) {
  try {
    // 写入选路：只发给顶层框。不广播是因为广播时"谁先答用谁"，第三方 iframe 会抢答；
    // 而把写操作落进广告/同意框更是绝对不可接受的行为。表单在首方 iframe 里的站点，
    // 现状本来就不可靠，宁可明确不支持，也不误写。
    if (msg.type !== 'nw:probe') return await chrome.tabs.sendMessage(tabId, { ...msg, __nwFrame: 'all' }, { frameId: 0 });

    // 探针要遍历该标签页的**全部 frame**再挑一个，而不是"谁先答用谁"：
    // SF/汇丰 这类页面里 match.adsrvr.org 的 cookie-sync 框秒回 0 控件，
    // 真表单框（document_idle + 动态 import）慢半拍，结果导出的是广告框。
    const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
    const ids = frames?.length ? frames.map(f => f.frameId) : [0];
    const urls = new Map((frames || []).map(f => [f.frameId, f.url || '']));
    let best = null, bestQuality = -1;
    const seen = [];
    for (const frameId of ids) {
      const res = await replyFrom(tabId, frameId, msg);
      const q = probeQuality(res);
      seen.push({
        frameId,
        url: String(res?.data?.url || urls.get(frameId) || '').slice(0, 120),
        controls: Number(res?.data?.totals?.controls) || 0,
        usable: q >= 0,
      });
      if (q > bestQuality) { bestQuality = q; best = res; }
    }
    if (best) {
      // 把"从哪个框取的结构、还有哪些框是空的"一起带出去：导出错了框时一眼能看出来
      best.frameReport = { chosen: best.__frameId ?? null, tried: seen };
      delete best.__frameId;
      return best;
    }
    return await chrome.tabs.sendMessage(tabId, { ...msg, __nwFrame: 'all' });
  } catch (err) {
    return { ok: false, error: String(err?.message || err), noContentScript: true };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // tabId 优先取 sender.tab（消息来自哪个标签页就是哪个），消息体里的自报值只作兜底：
    // 侧边栏自己带的 tabId 是它查询到的活动标签页，而内容脚本消息不能由页面随意指名别的标签页
    const tabId = sender.tab?.id ?? msg.tabId;
    const fromSubFrame = Boolean(sender.tab) && sender.frameId !== 0;
    if (fromSubFrame) {
      // 广告/统计 iframe 也注入了内容脚本，但它们不该读到整份简历（身份证、手机号）
      sendResponse({ ok: false, error: 'frame_denied' });
      return;
    }

    if (msg.type === 'nw:getState') {
      const { profile, settings } = await chrome.storage.local.get(['profile', 'settings']);
      sendResponse({ ok: true, profile: profile || null, settings: settings || {}, tabId });
    } else if (msg.type === 'nw:saveProfile') {
      await chrome.storage.local.set({ profile: msg.profile });
      sendResponse({ ok: true });
    } else if (msg.type === 'nw:saveSettings') {
      await chrome.storage.local.set({ settings: { ...(await chrome.storage.local.get('settings')).settings, ...msg.settings } });
      sendResponse({ ok: true });
    } else if (msg.type === 'nw:scan' || msg.type === 'nw:undo' || msg.type === 'nw:ping' || msg.type === 'nw:clearMarks' || msg.type === 'nw:probe') {
      let payload = msg;
      if (msg.type === 'nw:scan' && tabId) {
        // 适配器在这里按标签页 URL 选定后随消息下发：内容脚本自己无法安全地读扩展资源
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const resolver = await getAdapterResolver();
        const adapter = resolver.resolve(tab?.url || '');
        payload = { ...msg, adapter: adapter || null };
      }
      const res = await sendToTab(tabId, payload);
      if (payload.adapter && res && typeof res === 'object') res.adapterId = payload.adapter.id;
      sendResponse(res);
    } else {
      sendResponse({ ok: false, error: 'unknown_message' });
    }
  })();
  return true;
});
