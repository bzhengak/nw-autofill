// service worker 的 AI 链路集成测：把真的 background/service-worker.js 装进 Node，
// 用假 chrome + 假 fetch 走一遍「配 Key → 预览 → 问 AI」。
//
// 为什么要这一层：core/ai-endpoint.js 的单测证明"函数本身对"，界面测证明"错误文案对"，
// 但中间那段（SW 到底把 attempted/endpoint 带回侧边栏没有、Key 到底有没有走进 session）
// 只有把 SW 真跑起来才测得到 —— 而 2026-09-30 的 http_404 就断在这一层。

import { test } from 'node:test';
import assert from 'node:assert/strict';

const KEY = 'sk-ABCDEFGHIJ0123456789';
const BASE = 'https://api.example.test/gateway';

function makeChrome() {
  const local = {};
  const session = {};
  const store = bag => ({
    get: async (k) => {
      if (typeof k === 'string') return { [k]: bag[k] };
      if (Array.isArray(k)) return Object.fromEntries(k.map(x => [x, bag[x]]));
      return { ...bag };
    },
    set: async (obj) => Object.assign(bag, obj),
    remove: async (keys) => (Array.isArray(keys) ? keys : [keys]).forEach(x => delete bag[x]),
  });
  const listeners = [];
  return {
    local, session, listeners,
    runtime: {
      id: 'nwtest',
      getURL: p => 'chrome-extension://nwtest/' + p,
      onMessage: { addListener: fn => listeners.push(fn) },
      onInstalled: { addListener() {} },
      sendMessage: async () => ({ ok: true }),
    },
    action: { onClicked: { addListener() {} } },
    storage: { local: store(local), session: store(session) },
    tabs: { query: async () => [{ id: 1 }], get: async () => ({ id: 1, url: 'https://job.example.test/apply' }), create() {}, sendMessage: async () => ({ ok: true }) },
    webNavigation: { getAllFrames: async () => [] },
  };
}

/** 起一次独立的 SW 实例（模块有模块级状态，每个场景都要重新 import） */
async function bootSw(replies) {
  const chrome = makeChrome();
  globalThis.chrome = chrome;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const r = replies[calls.length - 1] ?? replies.at(-1);
    if (typeof r === 'function') return r(url, init);
    if (r instanceof Error) throw r;
    return r;
  };
  // SW 里有模块级 listener 注册，每次换 query 让它重新求值
  await import('../background/service-worker.js?sw=' + Math.random().toString(36).slice(2));
  const send = msg => new Promise(resolve => chrome.listeners[0](msg, {}, resolve));
  return { chrome, send, calls };
}

const http = (status, body = '') => ({
  ok: false, status, text: async () => body, json: async () => { throw new Error('not json'); },
});
/**
 * 一个响应两种形状：后台默认开流式，所以假上游既要有 json()（普通收法走的），
 * 也要有 body.getReader()（流式走的），并且两边内容一致 ——
 * 只给 json() 的桩测的是现实中不存在的分支，以前那条链路就是这么"看着通"的。
 */
const okJson = content => {
  const half = Math.ceil(content.length / 2);
  const frames = [
    { choices: [{ delta: { content: content.slice(0, half) }, finish_reason: null }] },
    { choices: [{ delta: { content: content.slice(half) }, finish_reason: 'stop' }] },
  ];
  const chunks = [...frames.map(f => `data: ${JSON.stringify(f)}\n\n`), 'data: [DONE]\n\n']
    .map(s => new TextEncoder().encode(s));
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
    text: async () => '',
    // 每次 getReader 都是一条新流：退回普通收法时不该接着上次的读数
    body: { getReader: () => {
      let k = 0;
      return {
        read: async () => (k < chunks.length ? { done: false, value: chunks[k++] } : { done: true }),
        cancel: async () => {},
      };
    } },
  };
};

/** 配好一套"能用 AI"的状态：session Key + Base URL + 模型 + 端点确认 + 本站确认 */
async function configure(send, chrome, { baseUrl = BASE, consent = true, site = true } = {}) {
  await send({ type: 'nw:saveAiKey', key: KEY, baseUrl, persist: false });
  await send({ type: 'nw:saveSettings', settings: { aiBaseUrl: baseUrl, aiModel: 'some-model' } });
  if (consent) await send({ type: 'nw:saveSettings', settings: { aiConsentOrigin: new URL(baseUrl).origin } });
  // 站点级确认走真消息（顺手也测了那个 handler）：假标签页是 https://job.example.test/apply
  if (site) await send({ type: 'nw:aiConsentSite', tabId: 1 });
  return chrome;
}

const ASK_MSG = {
  type: 'nw:aiAsk',
  profile: { basics: { name: '张伟' }, contact: {}, education: [] },
  gaps: [{ index: 0, label: 'Full Name', reason: 'no_candidate' }],
  fields: [{ index: 0, label: 'Full Name', kind: 'text' }],
};

test('真实链路：Base URL 少一段路径时，404 会自动顺延到下一个候选，并把用过的地址带回侧边栏', async () => {
  const { send, calls } = await bootSw([http(404, 'Not Found'), okJson('[{"i":0,"p":"basics.name","why":"标签就是 Full Name"}]')]);
  await configure(send, null, { baseUrl: 'https://api.example.test' });   // 只给到主机名
  const res = await send(ASK_MSG);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(calls.map(c => c.url), [
    'https://api.example.test/v1/chat/completions',
    'https://api.example.test/chat/completions',
  ], 'SW 没有走候选端点，或者顺序不对');
  assert.equal(res.endpoint, 'https://api.example.test/chat/completions', '显示用的地址该是真正成功那一次');
  assert.equal(res.attempted?.length, 2, '回包没带 attempted：界面就列不出试过哪些地址');
  // 候选归并后请求体才装得下：这条断言盯的是"填写侧 AI 链路是活的"
  assert.ok(res.candidates.length >= 1, `AI 候选没落地：${JSON.stringify(res.dropped)}`);
  assert.ok(!res.attempted.some(a => /张伟/.test(a.url)), '请求地址里不该有取值');
});

test('两次都 404：回包带 error=http_404、detail 与全部 attempted（界面靠这三个说话）', async () => {
  const { send } = await bootSw([http(404, 'Not Found'), http(404, 'Not Found')]);
  await configure(send, null, { baseUrl: 'https://api.example.test/gateway' });
  const res = await send(ASK_MSG);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'http_404');
  assert.match(res.detail, /Not Found/);
  assert.equal(res.attempted.length, 2);
});

test('上游回 401 时只发一次：不能因为"再试一个路径"把错误状态下的 Key 再敲一遍', async () => {
  const { send, calls } = await bootSw([http(401, 'invalid api key')]);
  await configure(send, null, { baseUrl: 'https://api.example.test/gateway' });
  const res = await send(ASK_MSG);
  assert.equal(calls.length, 1, '非 404 却重发了');
  assert.equal(res.error, 'http_401');
});

test('粘了完整端点也不会重复拼接：SW 只发一次，URL 就是用户给的那个', async () => {
  const { send, calls } = await bootSw([okJson('[]')]);
  const full = 'https://api.example.test/v1/chat/completions';
  await configure(send, null, { baseUrl: full });
  await send(ASK_MSG);
  assert.deepEqual(calls.map(c => c.url), [full]);
});

test('没勾确认时一个字节都不发（这条在重构后必须仍然成立）', async () => {
  const { send, calls } = await bootSw([okJson('[]')]);
  await configure(send, null, { baseUrl: 'https://api.example.test/gateway', consent: false });
  const res = await send(ASK_MSG);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_consent');
  assert.equal(calls.length, 0, '没确认也发出去了');
});

test('Key 不进 settings、不进回包；预览显示的是真正会 POST 的完整 URL', async () => {
  const { send, chrome } = await bootSw([okJson('[]')]);
  await configure(send, chrome, { baseUrl: 'https://api.example.test/gateway' });
  assert.ok(!JSON.stringify(chrome.local.settings || {}).includes(KEY), 'Key 落进了 settings（settings 会被导出）');

  const prev = await send({
    type: 'nw:aiPreview', profile: ASK_MSG.profile, gaps: ASK_MSG.gaps, fields: ASK_MSG.fields,
  });
  assert.equal(prev.ok, true);
  assert.match(prev.endpoint, /^https:\/\/api\.example\.test\/gateway\/chat\/completions$/, '预览只显示 Base URL，看不到真正要 POST 的地址');
  assert.ok(!JSON.stringify(prev).includes(KEY), '预览回包里带出了 Key');
});

test('导入侧同样带上 attempted：两条 AI 链路不能一条修好一条没修', async () => {
  const report = {
    unplaced: [{ heading: 'Miscellaneous', lines: ['校学生会宣传部 副部长 2022.09-2023.06'], why: 'unrouted' }],
  };
  const { send, calls } = await bootSw([http(404, 'Not Found'), http(404, 'Not Found')]);
  await configure(send, null, { baseUrl: 'https://api.example.test/gateway' });
  const res = await send({
    type: 'nw:extractRun', confirm: true, report,
    profile: { basics: {}, education: [], work: [], campus: [] },
  });
  assert.equal(res.error, 'http_404');
  assert.equal(res.attempted.length, 2, '导入侧没带回试过的地址');
  assert.equal(calls.length, 2);
});

// ── 自检与取消：这两条链路只有真跑 SW 才看得到闸门与载荷 ────────────────────
test('自检走同一道闸：没勾确认就不发，勾了也只发写死的 "ping"', async () => {
  const noConsent = await bootSw([okJson('Pong')]);
  await configure(noConsent.send, null, { baseUrl: BASE, consent: false });
  const blocked = await noConsent.send({ type: 'nw:aiPing', timeoutSec: 5 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.verdict, 'gate_needs_consent', '自检绕过了确认闸');
  assert.equal(noConsent.calls.length, 0, '没确认却还是发了');

  const { send, calls } = await bootSw([okJson('Pong')]);
  await configure(send, null, { baseUrl: BASE });
  const res = await send({ type: 'nw:aiPing', timeoutSec: 5 });
  assert.equal(res.verdict, 'ok');
  assert.equal(calls.length, 1, '成功了还多做了一次对照探测');
  assert.equal(JSON.parse(calls[0].init.body).messages[0].content, 'ping', '自检不该发别的东西');
  assert.ok(!JSON.stringify(res).includes(KEY), '自检回包带出了 Key');
});

test('自检发现"域名连不上"时，结论要落在网络上而不是 Key 上', async () => {
  const { send, calls } = await bootSw([new TypeError('Failed to fetch')]);
  await configure(send, null, { baseUrl: BASE });
  const res = await send({ type: 'nw:aiPing', timeoutSec: 5 });
  assert.equal(res.verdict, 'unreachable', JSON.stringify(res));
  // 两次：POST 一次 + 不带凭据的对照 GET 一次
  assert.deepEqual(calls.map(c => c.init.method), ['POST', 'GET']);
  assert.ok(!calls[1].init.headers, '对照 GET 不该带任何头部（Key 绝不能跟着走）');
});

test('「取消等待」真的中止在飞的那次请求，而且报成 cancelled 不是 timeout', async () => {
  // 假 fetch 必须像真 fetch 一样"信号一来就 reject"，否则测的是我自己的桩而不是中止行为
  const neverResolves = (url, init) => new Promise((_resolve, reject) => {
    const sig = init?.signal;
    if (sig?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); return; }
    sig?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const { send } = await bootSw([neverResolves]);
  await configure(send, null, { baseUrl: BASE });
  const pending = send(ASK_MSG);
  await new Promise(r => setTimeout(r, 30));                       // 让 fetch 真的在飞
  const abort = await send({ type: 'nw:aiAbort' });
  assert.equal(abort.ok, true);
  assert.equal(abort.aborted, true, '后台说没有在飞的请求');
  const res = await pending;
  assert.equal(res.ok, false);
  assert.equal(res.error, 'cancelled', '取消被报成了别的东西，用户会以为是超时');
});

test('后台把构建号带回侧边栏：不一致时界面才可能发现"重载没生效"', async () => {
  const { send } = await bootSw([okJson('[]')]);
  const state = await send({ type: 'nw:getState', tabId: 1 });
  const { BUILD } = await import('../core/build.js');
  assert.equal(state.build, BUILD, 'getState 没带 build —— 面板无从判断后台是不是旧的');
  const unknown = await send({ type: 'nw:notARealMessage' });
  assert.equal(unknown.error, 'unknown_message');
  assert.equal(unknown.build, BUILD, '连兜底回包都不带版本号，unknown_message 就没法自证是哪一版');
});

test('设置里的回答长度上限真的进到请求体；没配时用默认 4000（不再写死 2000）', async () => {
  const a = await bootSw([okJson('[]')]);
  await configure(a.send, null, { baseUrl: BASE });
  await a.send(ASK_MSG);
  assert.equal(JSON.parse(a.calls[0].init.body).max_tokens, 4000, '默认上限没生效：reasoning 模型会被砍断');

  const b = await bootSw([okJson('[]')]);
  await configure(b.send, null, { baseUrl: BASE });
  await b.send({ type: 'nw:saveSettings', settings: { aiMaxOutput: 9000 } });
  await b.send(ASK_MSG);
  assert.equal(JSON.parse(b.calls[0].init.body).max_tokens, 9000, '改了设置但请求体还是老数字（穿线断了）');
});

test('自检那一发只给 1 token：它测的是通不通，不是模型能想多久', async () => {
  const { send, calls } = await bootSw([okJson('Pong')]);
  await configure(send, null, { baseUrl: BASE });
  await send({ type: 'nw:aiPing', timeoutSec: 5 });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.max_tokens, 1);
  assert.equal(body.messages[0].content, 'ping');
});

test('流式默认开：真请求那一发带 stream:true；显式关掉才不带', async () => {
  const on = await bootSw([okJson('[]')]);
  await configure(on.send, null, { baseUrl: BASE });
  await on.send(ASK_MSG);
  assert.equal(JSON.parse(on.calls[0].init.body).stream, true, '默认该走流式：非流式要等整段生成完才发第一个字节');

  const off = await bootSw([okJson('[]')]);
  await configure(off.send, null, { baseUrl: BASE });
  await off.send({ type: 'nw:saveSettings', settings: { aiStream: false } });
  await off.send(ASK_MSG);
  assert.ok(!('stream' in JSON.parse(off.calls[0].init.body)), '关了还在发 stream 参数');
  assert.equal(off.calls.length, 1, '关掉流式后不该再多发一发');
});

/**
 * 存资料会把老结构（en 是空对象）补成完整骨架。
 * 放在这里而不是另起一套假 chrome —— 全仓库只有本文件把 service-worker.js 跑起来过，
 * 而用户报的"下载下来的 en 是 {}"根因正在落库这一环（面板里补只活一次显示）。
 */
test('存资料会把老结构（en 是空对象）补成完整骨架，且不盖掉已写的英文', async () => {
  const { chrome, send, calls } = await bootSw([]);
  const r = await send({
    type: 'nw:saveProfile',
    profile: { basics: { name: '张伟' }, education: [{ school: '南京大学' }], en: { basics: { name: 'Zhang Wei' } } },
  });
  assert.equal(r.ok, true);
  const stored = chrome.local.profile;
  assert.equal(stored.en.basics.name, 'Zhang Wei', '补骨架把用户手写的英文值盖掉了');
  assert.equal(stored.en.education[0].school, '', '缺的英文落点没补上');
  assert.equal(stored.basics.name, '张伟', '中文侧被改动');
  assert.equal(stored.en.basics.birthDate, undefined, '中性栏不该出现在骨架里');
  assert.equal(calls.length, 0, '存资料不该打网络');
});

/**
 * 2026-10-01 用户在 tupu360 真实页面上点「问 AI」，被自己的取值自检拦下：
 * 资料里 internship[0].durationMonths = '12'，而页面文本里本来就写着 12。
 * 这条必须真跑 SW 才测得到 —— 判据在 core、豁免表在 core、但"拦不拦"是 SW 那一行决定的。
 */
test('页面文本里的 "12" 与资料撞字时不再误拦：请求真的出网（旧行为是 value_leak 拒发）', async () => {
  const { send, calls } = await bootSw([okJson('[]')]);
  await configure(send, null, { baseUrl: 'https://api.example.test/gateway' });
  const res = await send({
    type: 'nw:aiAsk',
    profile: {
      internship: [{ company: '', title: '', durationMonths: '12' }],
      basics: { nationality: 'China' },
      education: [{ enrollDate: '2021-09', gpa: '3.8' }],
    },
    gaps: [{ index: 0, label: '实习时长（12 个月以内）', reason: 'no_candidate', kind: 'enum' }],
    fields: [{
      index: 0, kind: 'enum', label: '实习时长（12 个月以内）',
      options: [{ text: 'China' }, { text: '12' }], nearbyLabels: ['2021-09'],
    }],
  });
  assert.equal(res.error, undefined, `还是被自检拦下了：${JSON.stringify(res.leaks || res.error)}`);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(calls.length, 1, '误拦时一个字节都不该出门，放行后就必须真发');
});

/**
 * 「每换一个站点问一次」：aiConsentOrigin 只管"发去哪个 AI 地址"，
 * 这一组测的是另一半账——这一页的字段名能不能离开本机。
 * 只有把真 SW 跑起来才测得到：拦截发生在后台，面板只是把错误念出来。
 */
test('没确认过这一站：一个字节都不发出去，且回包说清是哪一站', async () => {
  const { send, calls } = await bootSw([okJson('[]')]);
  await configure(send, null, { site: false });
  const res = await send(ASK_MSG);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_site_consent', `该被站点闸拦下：${JSON.stringify(res)}`);
  assert.equal(res.pageOrigin, 'https://job.example.test', '要把手地址带回去，界面才知道让用户确认什么');
  assert.equal(calls.length, 0, '拦下了还发了请求');
});

test('勾一次记一站：确认之后同一站再问就放行；换站重新问', async () => {
  const { send, calls } = await bootSw([okJson('[{"i":0,"p":"basics.name","why":"标签就是 Full Name"}]')]);
  await configure(send, null, { site: false });
  const granted = await send({ type: 'nw:aiConsentSite', tabId: 1 });
  assert.equal(granted.ok, true, JSON.stringify(granted));
  assert.equal(granted.pageOrigin, 'https://job.example.test');
  const res = await send(ASK_MSG);
  assert.equal(res.ok, true, `确认过了还被拦：${JSON.stringify(res)}`);
  assert.equal(calls.length, 1);
  // 面板再问一次同一站：不必重复确认（这正是"每站一次"而不是"每次一问"）
  const again = await send(ASK_MSG);
  assert.equal(again.ok, true);
  assert.equal(calls.length, 2);
});

test('AI 地址换了：各站点的确认一起作废，端点确认重勾也不等于站点确认', async () => {
  const { send, calls } = await bootSw([okJson('[]')]);
  await configure(send, null);                                  // 旧地址：两道确认都勾过
  assert.equal((await send(ASK_MSG)).ok, true, '起点该是能问通的');
  const OTHER = 'https://other.example.test/v1';
  await send({ type: 'nw:saveAiKey', key: KEY, baseUrl: OTHER, persist: false });
  await send({ type: 'nw:saveSettings', settings: { aiBaseUrl: OTHER } });
  await send({ type: 'nw:saveSettings', settings: { aiConsentOrigin: new URL(OTHER).origin } });
  const before = calls.length;
  const res = await send(ASK_MSG);
  assert.equal(res.ok, false, '端点确认重勾了，但这一站对**新地址**从没确认过，不该放行');
  assert.equal(res.error, 'needs_site_consent', JSON.stringify(res));
  assert.equal(calls.length, before, '被拦下还发了请求');
});

test('反勾撤回本站确认：账本里那条真的删掉', async () => {
  const { chrome, send } = await bootSw([okJson('[]')]);
  await configure(send, null);
  const revoked = await send({ type: 'nw:aiConsentSite', tabId: 1, revoke: true });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.sites, 0, '撤回后账本该空：' + JSON.stringify(chrome.local.aiSiteConsent));
  const res = await send(ASK_MSG);
  assert.equal(res.error, 'needs_site_consent');
});

test('认不出站点（chrome:// 这类）就不发：绝不"当作已确认"', async () => {
  const { chrome, send, calls } = await bootSw([okJson('[]')]);
  await configure(send, null, { site: false });
  chrome.tabs.get = async () => ({ id: 1, url: 'chrome://extensions' });
  const res = await send(ASK_MSG);
  assert.equal(res.error, 'no_page_origin', JSON.stringify(res));
  assert.equal(calls.length, 0);
});

/** 模型答"这一栏认不出"时，界面要能说清是哪一栏、它自己给的理由是什么 */
test('declined 一路带回侧边栏：AI 的"认不出"不是丢弃，也不是空回', async () => {
  const { send } = await bootSw([okJson('{"matches":[{"index":0,"path":null,"reason":"这一栏没有任何标签"}]}')]);
  await configure(send, null);
  const res = await send(ASK_MSG);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.candidates.length, 0);
  assert.deepEqual(res.dropped, [], '说不知道不该记成丢弃');
  assert.equal(res.declined.length, 1);
  assert.equal(res.declined[0].reason, '这一栏没有任何标签');
  assert.equal(res.declined[0].label, 'Full Name', '要把标签带回去，用户才知道是哪一栏');
});

/**
 * S5 整页概念映射的后台链路：只发栏位档案与概念清单，
 * 展开成槽位是本地的事，答案没点头也不写页面（那是 S6 映射表的活）。
 */
const MAP_MSG = {
  type: 'nw:aiMapPage',
  profile: { basics: { name: '欧阳中华', lastName: '欧阳', idNumber: '330105199912034567' }, contact: { phone: '13900002222' }, hkGlobal: {} },
  fields: [
    { labelRaw: 'Family Name', label: 'family name', kind: 'text', required: true, description: 'Surname as in passport', sectionTitle: 'Basics', options: [], nearbyLabels: [] },
    { labelRaw: 'Work Permit', label: 'work permit', kind: 'radio', options: [{ text: 'Yes', value: 'Y' }, { text: 'No', value: 'N' }] },
  ],
  valueStates: { 0: 'empty', 1: 'site' },
};

test('整页映射：AI 交回概念，本地展开成槽位；说认不出的那栏带着它自己的理由回来', async () => {
  const { send } = await bootSw([okJson('{"matches":[{"index":0,"concept":"name.family","reason":"passport surname"},{"index":1,"concept":null,"reason":"合规声明需本人表态"}]}')]);
  await configure(send, null);
  const res = await send(MAP_MSG);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.mapping.length, 1);
  assert.equal(res.mapping[0].concept, 'name.family');
  assert.equal(res.mapping[0].path, 'basics.lastName', '概念→槽位是本地展开的，AI 从没见过这条路径');
  assert.equal(res.mapping[0].label, 'Family Name');
  assert.equal(res.declined.length, 1);
  assert.equal(res.declined[0].reason, '合规声明需本人表态');
  assert.equal(res.declined[0].label, 'Work Permit');
});

test('整页映射不认越界概念，也不接受我们清单外的路径', async () => {
  const { send } = await bootSw([okJson('{"matches":[{"index":0,"concept":"basics.lastName","reason":"直接给路径"},{"index":1,"concept":"made-up-thing"}]}')]);
  await configure(send, null);
  const res = await send(MAP_MSG);
  assert.equal(res.mapping.length, 0, '越界概念被当成有效结论了');
  assert.deepEqual(res.dropped.map(d => d.reason).sort(), ['unknown_concept', 'unknown_concept']);
});

test('整页映射同一道站点闸：没确认过这一站就一个字节都不发', async () => {
  const { send, calls } = await bootSw([okJson('{"matches":[]}')]);
  await configure(send, null, { site: false });
  const res = await send(MAP_MSG);
  assert.equal(res.error, 'needs_site_consent');
  assert.equal(calls.length, 0, '整页映射绕过了站点确认');
});

test('整页映射的预览不发请求，但把要发出去的全文给出来', async () => {
  const { send, calls } = await bootSw([okJson('{"matches":[]}')]);
  await configure(send, null);
  const res = await send({ ...MAP_MSG, preview: true });
  assert.equal(res.ok, true);
  assert.equal(res.preview, true);
  assert.ok(/Family Name/.test(res.text) && /name\.family/.test(res.text), '预览里没有栏位档案或概念清单');
  assert.ok(!/欧阳中华|330105199912034567/.test(res.text), '预览文本里出现了取值');
  assert.equal(calls.length, 0, '预览不该出网');
});
