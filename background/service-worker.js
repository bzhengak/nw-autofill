// MV3 service worker：跨 frame 汇总、profile 存取、命令下发、AI 兜底的唯一出网点。
//
// AI 出网的四条硬约束（规则本体在 core/ai-security.js / core/ai.js，都有离线单测）：
//  1. Key 只存 chrome.storage.session，且和"录入它时的那个 origin"绑在一起：
//     换了 Base URL 就等于换了收件人，老 Key 不会跟着发出去，必须重新录一次。
//  2. Base URL 必须是 https（本机 127.0.0.1/localhost 例外，供 Ollama/LM Studio 自测），
//     不接受 userinfo、query、非 http 协议。
//  3. 请求体由 core/ai.js 构造，发送前再过一次 assertNoProfileValues —— 漏值就地拒发。
//  4. 响应只当"路径建议"；不写页面、不提交；超时 20s、禁跟跳转、体积上限。

import { compileAdapters } from '../core/adapters.js';
import { buildAiRequest, assertNoProfileValues, parseAiResponse, aiSlotCatalog } from '../core/ai.js';
import { normalizeBaseUrl, sanitizeSettings, sanityCheckKey, maySendKey, redact, findLeaksInExport, SECRETS_BUCKET } from '../core/ai-security.js';

const AI_TIMEOUT_MS = 20000;
const AI_MAX_BYTES = 12000;        // 请求体上限：只发字段名与槽位目录，超量说明构造出了问题
const AI_MAX_OUT = 30;             // 一次最多问 30 个缺口，避免把整页字段都送出去

/**
 * Key 的读取顺序：先看 session（本次会话），再看用户勾了"记住 Key"时写入的 local.aiSecrets。
 * local.aiSecrets 是独立的顶层桶，**不在 settings 里** —— settings 会被导出 JSON 带走。
 */
async function readAiSession() {
  const sess = await chrome.storage.session.get(['aiKey', 'aiKeyOrigin']).catch(() => ({}));
  if (sess.aiKey) return { key: sess.aiKey, keyOrigin: sess.aiKeyOrigin || '', persisted: false };
  const bucket = (await chrome.storage.local.get([SECRETS_BUCKET]))[SECRETS_BUCKET];
  if (bucket?.aiKey) return { key: bucket.aiKey, keyOrigin: bucket.aiKeyOrigin || '', persisted: true };
  return { key: '', keyOrigin: '', persisted: false };
}
async function writeAiSession(key, keyOrigin, persist) {
  // 先清干净两个桶，再按选择写一个 —— 否则会留下"关掉了但 session 里还有一份"的半状态
  await chrome.storage.session.remove(['aiKey', 'aiKeyOrigin']).catch(() => {});
  await chrome.storage.local.remove([SECRETS_BUCKET]);
  if (!key) return;
  if (persist) await chrome.storage.local.set({ [SECRETS_BUCKET]: { aiKey: key, aiKeyOrigin: keyOrigin } });
  else await chrome.storage.session.set({ aiKey: key, aiKeyOrigin: keyOrigin });
}

/** 组装请求；把"取值不许外发"的自检放在真正出网之前 */
async function buildAiCall(profile, plan, pageFields) {
  const req = buildAiRequest({ plan, profile, pageFields, limit: AI_MAX_OUT });
  const leaks = assertNoProfileValues(req.text, profile, { exempt: [req.slotSection] });
  if (leaks.length) return { ok: false, error: 'value_leak', leaks: leaks.slice(0, 8) };
  if (new TextEncoder().encode(req.text).length > AI_MAX_BYTES) return { ok: false, error: 'payload_too_large' };
  return { ok: true, req };
}

async function callAiEndpoint({ baseUrl, model, key, text }) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base.ok) return { ok: false, error: `endpoint_${base.error}` };
  const url = base.url + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      // redirect:'error'：被 302 到别的域时直接失败。fetch 会跟着跳转并把 Authorization 带过去，
      // 不关掉这一条，"Key 只发给这个 origin"就有个现实的后门。
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 800,
        messages: [{ role: 'user', content: text }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const json = await res.json().catch(() => null);
    const content = json?.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: 'empty_response' };
    return { ok: true, content };
  } catch (err) {
    const name = String(err?.name || '');
    // 错误文本可能带上请求 URL 甚至 Header，一律脱敏后再返回
    return { ok: false, error: name === 'AbortError' ? 'timeout' : redact(String(err?.message || 'network_error'), key) };
  } finally { clearTimeout(timer); }
}

const CHANNEL = 'nw-autofill';

/** 适配器加载：以前只有 tests/tools 用得到它们，真实页面上 pins/slotPins/skip/dateFormats 全部没生效。
 *  踩过的坑：classic service worker 里 `import()` 不可用，所以第一版接线在浏览器里
 *  每次都掉进 catch，页面看到的是"本页适配器：无"。manifest 里必须声明 type:"module"，
 *  并且失败要把原因带回侧边栏，不能再静默。 */
let adapterResolver = null;
let adapterError = '';
export function adapterDiagnostics() {
  return { loaded: Boolean(adapterResolver), error: adapterError, count: adapterResolver?.adapters?.length || 0, rejected: (adapterResolver?.rejected || []).map(r => r.name) };
}
async function getAdapterResolver() {
  if (adapterResolver) return adapterResolver;
  try {
    const reg = await (await fetch(chrome.runtime.getURL('adapters/registry.json'))).json();
    const files = {};
    for (const f of (reg && reg.files) || []) {
      try { files[f] = await (await fetch(chrome.runtime.getURL(f))).json(); }
      catch { files[f] = null; }
    }
    const warns = [];
    adapterResolver = compileAdapters(files, m => warns.push(m));
    adapterError = warns.length ? warns.join('；') : '';
    if (!adapterResolver.adapters.length) adapterError = adapterError || 'registry 里没有任何通过校验的适配器';
  } catch (err) {
    adapterError = String(err && err.message ? err.message : err);
    console.warn('[网申填写] 适配器加载失败，本次按无适配器运行：', err);
    adapterResolver = { adapters: [], rejected: [], resolve: () => null };
  }
  return adapterResolver;
}

chrome.runtime.onInstalled.addListener(async () => {
  // 显式声明 session 存储只信任扩展自身上下文（这是默认值，但写死在这里，
  // 免得将来谁为了调试方便改成 CONTENTS_SCRIPTS，把 Key 暴露给注入到页面的模块）。
  try { await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch { /* 老版本没有这个 API，默认即 TRUSTED_CONTEXTS */ }
  const data = await chrome.storage.local.get(['settings']);
  if (!data.settings) {
    await chrome.storage.local.set({
      settings: {
        mode: 'full',
        fillSensitive: false,   // 证件号/手机号默认不自动写，需显式打开
        autoSubmitNever: true,  // 常量，仅作为可见的"设计承诺"
      },
    });
  }
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
      const sess = await readAiSession();
      // Key 本身永不回传，只回"有没有"、"绑在哪个 origin"、"是否已持久化"
      sendResponse({
        ok: true, profile: profile || null, settings: settings || {},
        hasAiKey: Boolean(sess.key), aiKeyLength: sess.key ? sess.key.length : 0,
        aiKeyOrigin: sess.keyOrigin, aiKeyPersisted: sess.persisted,
        tabId,
      });
    } else if (msg.type === 'nw:aiPreview' || msg.type === 'nw:aiAsk') {
      // 预览与真正发送共用同一次构造：看到的就必须是发出去的，不能两套逻辑
      const { profile, gaps, fields } = msg;
      const plan = { gaps: gaps || [], assignments: [] };
      const pageFields = fields || [];
      const built = await buildAiCall(profile, plan, pageFields);
      if (!built.ok) { sendResponse({ ok: false, error: built.error, leaks: built.leaks }); return; }
      const settings = (await chrome.storage.local.get('settings')).settings || {};
      const target = normalizeBaseUrl(settings.aiBaseUrl);
      if (msg.type === 'nw:aiPreview') {
        sendResponse({
          ok: true, text: built.req.text, bytes: new TextEncoder().encode(built.req.text).length,
          asks: built.req.gaps.length,
          // 预览必须把"这东西会发去哪儿"一起显示，否则用户核对了内容却不知道收件人
          endpoint: target.ok ? target.url : '', endpointError: target.ok ? '' : target.error,
        });
        return;
      }
      const sess = await readAiSession();
      if (!target.ok) { sendResponse({ ok: false, error: `endpoint_${target.error}` }); return; }
      if (!settings.aiModel || !sess.key) { sendResponse({ ok: false, error: 'ai_not_configured' }); return; }
      // Key 与 origin 绑定 + 明确的收件人确认：Base URL 被改动后老 Key 不会跟着发出去，
      // 而且用户没勾过"确认发往这个地址"时一律拒发。
      const gate = maySendKey({ keyOrigin: sess.keyOrigin, targetOrigin: target.origin, consentOrigin: settings.aiConsentOrigin });
      if (!gate.ok) { sendResponse({ ok: false, error: gate.error }); return; }
      const call = await callAiEndpoint({ baseUrl: settings.aiBaseUrl, model: settings.aiModel, key: sess.key, text: built.req.text });
      if (!call.ok) { sendResponse({ ok: false, error: call.error }); return; }
      const parsed = parseAiResponse(call.content, {
        allowedPaths: new Set(aiSlotCatalog(profile).map(s => s.path)),
        askedIndexes: new Set(built.req.gaps.map(g => g.index)),
      });
      // 把标签带回去，让内容脚本落地时能复核下标有没有漂
      const labelOf = new Map((fields || []).map(f => [f.index, f.label]));
      sendResponse({
        ok: true,
        candidates: parsed.candidates.map(c => ({ ...c, label: labelOf.get(c.index) || '' })),
        dropped: parsed.dropped,
        endpoint: target.url,
        rawChars: String(call.content || '').length,
      });
    } else if (msg.type === 'nw:saveAiKey') {
      // Key 只进 session 或独立的 local.aiSecrets 桶；传空串就是"两个桶都清掉"
      const key = String(msg.key || '').trim();
      if (!key) { await writeAiSession('', '', false); sendResponse({ ok: true, hasAiKey: false }); return; }
      const shape = sanityCheckKey(key);
      if (!shape.ok) { sendResponse({ ok: false, error: shape.error }); return; }
      const target = normalizeBaseUrl(msg.baseUrl);
      if (!target.ok) { sendResponse({ ok: false, error: `endpoint_${target.error}` }); return; }
      await writeAiSession(key, target.origin, msg.persist === true);
      // 只回长度与 origin，绝不回任何 Key 字符
      sendResponse({
        ok: true, hasAiKey: true, length: shape.length, boundOrigin: target.origin,
        secure: target.secure, persisted: msg.persist === true,
      });
    } else if (msg.type === 'nw:saveProfile') {
      await chrome.storage.local.set({ profile: msg.profile });
      sendResponse({ ok: true });
    } else if (msg.type === 'nw:saveSettings') {
      // 白名单过滤：以前这里是无脑 merge，谁都能往 settings 里塞任意键。
      // settings 会随「导出 JSON」离开本机，所以名字像 Key/Token 的一律拒收，
      // 并把丢弃原因带回侧边栏 —— 静默吞掉只会让人以为"Key 保存成功了"。
      const { clean, dropped } = sanitizeSettings(msg.settings);
      const prev = (await chrome.storage.local.get('settings')).settings || {};
      const next = { ...prev, ...clean };
      // 端点一旦被改动，之前对旧端点的确认立即作废（必须重新勾选，Key 也要重录）
      if (clean.aiBaseUrl) {
        const t = normalizeBaseUrl(clean.aiBaseUrl);
        if (!t.ok) { sendResponse({ ok: false, error: `endpoint_${t.error}`, dropped }); return; }
        if (normalizeBaseUrl(prev.aiBaseUrl || '').origin !== t.origin) next.aiConsentOrigin = '';
      }
      await chrome.storage.local.set({ settings: next });
      sendResponse({ ok: true, dropped, consentCleared: Boolean(clean.aiBaseUrl) && next.aiConsentOrigin === '' });
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
      // 适配器没生效时不能只安静地"按通用规则匹配"：把加载诊断带回去，侧边栏直接说原因
      if (msg.type === 'nw:scan' && res && typeof res === 'object') res.adapterInfo = adapterDiagnostics();
      sendResponse(res);
    } else {
      sendResponse({ ok: false, error: 'unknown_message' });
    }
  })();
  return true;
});
