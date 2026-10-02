// S6 改判规则的消息层：把真的 background/service-worker.js 跑起来走一遍
// 「面板存改判 → 扫描时按站点合流下发 → 本轮确认不落盘 → 忘记本站」。
//
// 为什么必须有这一层（本仓库踩过两次的坑）：纯函数测证明 core/site-rules.js 算得对，
// 但四条新消息后台没接、origin 判定写歪、或者规则合流忘了塞进 nw:scan，
// 面板得到的都只是 unknown_message 或"我明明记住了怎么没用"。只有真跑 SW 才照得出来。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RULES_BUCKET } from '../core/site-rules.js';
import { fingerprint } from '../core/ledger.js';

const TUPU = 'https://careersite.tupu360.com/accentureats/resume/applicationView';
const HKEX = 'https://jobs.hkex.example.hk/application';

function makeChrome({ tabUrl = TUPU } = {}) {
  const local = {};
  const session = {};
  const bag = store => ({
    get: async k => (typeof k === 'string' ? { [k]: store[k] } : Array.isArray(k) ? Object.fromEntries(k.map(x => [x, store[x]])) : { ...store }),
    set: async obj => Object.assign(store, obj),
    remove: async keys => (Array.isArray(keys) ? keys : [keys]).forEach(x => delete store[x]),
  });
  const listeners = [];
  const sent = [];          // 内容脚本收到的每一条消息（本轮改判是否真下发了，看这里）
  const tabs = { url: tabUrl };
  const chrome = {
    local, session, listeners, sent, tabs2: tabs,
    runtime: {
      id: 'nwtest',
      getURL: p => 'chrome-extension://nwtest/' + p,
      onMessage: { addListener: fn => listeners.push(fn) },
      onInstalled: { addListener() {} },
      sendMessage: async () => ({ ok: true }),
    },
    action: { onClicked: { addListener() {} } },
    storage: { local: bag(local), session: bag(session) },
    tabs: {
      query: async () => [{ id: 1 }],
      get: async id => ({ id, url: tabs.url }),
      create() {},
      sendMessage: async (id, msg) => { sent.push(msg); return { ok: true, stats: {}, results: [], gaps: [] }; },
    },
    webNavigation: { getAllFrames: async () => [] },
  };
  return chrome;
}

async function boot(opts = {}) {
  const chrome = makeChrome(opts);
  globalThis.chrome = chrome;
  await import('../background/service-worker.js?rules=' + Math.random().toString(36).slice(2));
  // 侧边栏发来的消息：sender 没有 tab（面板不是页面），origin 只能靠 tabId 反查
  const send = (msg, sender = {}) => new Promise(resolve => chrome.listeners[0](msg, sender, resolve));
  return { chrome, send };
}

test('四条规则消息后台真接得住：不是 unknown_message', async () => {
  const { chrome, send } = await boot();
  const got = await send({ type: 'nw:siteRulesGet', tabId: 1 });
  assert.equal(got?.ok, true, JSON.stringify(got));
  assert.equal(got.error, undefined);
  assert.deepEqual(got.rules, {}, '新实例该是空规则');
  assert.equal(got.origin, 'https://careersite.tupu360.com', 'origin 由 tabId 反查，不是消息体自报的');

  const put = await send({ type: 'nw:siteRulesPut', tabId: 1, entries: [{ fp: 'f1', path: 'basics.name', skip: false, note: '这栏是全名' }] });
  assert.equal(put.accepted, 1, JSON.stringify(put));
  assert.equal(put.rejected.length, 0);
  assert.ok(chrome.local[RULES_BUCKET], '规则要落在独立顶层桶');
  assert.ok(!(RULES_BUCKET in (chrome.local.settings || {})), '规则不许混进 settings（settings 会被导出 JSON 带走）');

  const read = await send({ type: 'nw:siteRulesGet', tabId: 1 });
  assert.equal(read.rules.f1.path, 'basics.name');

  const dropped = await send({ type: 'nw:siteRulesDrop', tabId: 1, fps: ['f1'] });
  assert.equal(dropped.count, 0, '点名的那条要没了');
  assert.equal(chrome.local[RULES_BUCKET]['https://careersite.tupu360.com'].f1, undefined);
});

test('自造的槽位路径存不进去，理由要念得出来', async () => {
  const { chrome, send } = await boot();
  const put = await send({ type: 'nw:siteRulesPut', tabId: 1, entries: [
    { fp: 'good', path: 'basics.name' },
    { fp: 'evil', path: 'basics.name; DROP' },
    { fp: 'ghost', path: 'nonexistent.slot' },
    { fp: 'vague' },
  ] });
  assert.equal(put.accepted, 1);
  assert.equal(put.rejected.length, 3, JSON.stringify(put.rejected));
  assert.ok(put.rejected.every(r => /[\u4e00-\u9fff]/.test(r.why)), '被拒的理由必须是中文');
  const stored = chrome.local[RULES_BUCKET]['https://careersite.tupu360.com'];
  assert.deepEqual(Object.keys(stored), ['good'], '没通过校验的一条都不许落盘');
});

test('按站点隔离：途普的改判不会跟着到 HKEX 那一页，忘记本站也只抹本站', async () => {
  const { chrome, send } = await boot();
  await send({ type: 'nw:siteRulesPut', tabId: 1, entries: [{ fp: 'f1', path: 'basics.name' }] });
  chrome.tabs2.url = HKEX;
  const other = await send({ type: 'nw:siteRulesGet', tabId: 1 });
  assert.deepEqual(other.rules, {}, `别的站点读到了这条：${JSON.stringify(other.rules)}`);
  assert.equal(other.origin, 'https://jobs.hkex.example.hk');

  // 在 HKEX 上点「忘记本站」：这一站本来就没规则，途普那条也不许被顺手抹掉
  await send({ type: 'nw:siteRulesForgetSite', tabId: 1 });
  chrome.tabs2.url = TUPU;
  const again = await send({ type: 'nw:siteRulesGet', tabId: 1 });
  assert.equal(again.rules.f1?.path, 'basics.name', '忘记另一站却把这条改判一起清了');

  // 在途普上点「忘记本站」：这一站整桶没了，别的站点仍在
  chrome.tabs2.url = HKEX;
  await send({ type: 'nw:siteRulesPut', tabId: 1, entries: [{ fp: 'h1', path: 'contact.email' }] });
  chrome.tabs2.url = TUPU;
  const gone = await send({ type: 'nw:siteRulesForgetSite', tabId: 1 });
  assert.equal(gone.count, 0);
  const bucket = chrome.local[RULES_BUCKET];
  assert.equal(bucket['https://careersite.tupu360.com'], undefined, '忘记本站要把这一整桶清掉，不留空壳');
  assert.equal(bucket['https://jobs.hkex.example.hk'].h1.path, 'contact.email', '忘记本站清到了别的站点');
});

test('非 http(s) 页面没有规则可存、也无从下发：明说 no_origin', async () => {
  const { send } = await boot({ tabUrl: 'chrome://extensions/' });
  const got = await send({ type: 'nw:siteRulesGet', tabId: 1 });
  assert.equal(got.ok, false);
  assert.equal(got.error, 'no_origin');
  const put = await send({ type: 'nw:siteRulesPut', tabId: 1, entries: [{ fp: 'f1', path: 'basics.name' }] });
  assert.equal(put.ok, false);
});

test('扫描时规则真被合流下发；本轮确认不落盘；被拒的确认带回理由', async () => {
  const { chrome, send } = await boot();
  const field = { label: 'Awarding Body', name: 'ab', id: 'ab1', kind: 'text', options: [] };
  const savedFp = 'saved-fp';
  await send({ type: 'nw:siteRulesPut', tabId: 1, entries: [{ fp: savedFp, path: 'certifications.0.name' }] });

  const tempFp = fingerprint(field);
  const res = await send({
    type: 'nw:scan', tabId: 1, mode: 'preview', dryRun: true,
    confirmed: [
      { fp: tempFp, path: 'basics.name', skip: false, note: '本轮就按这个来，别记本站' },
      { fp: 'oops', path: 'totally.made.up' },
    ],
  });
  assert.equal(res.ok, true);
  const toPage = chrome.sent[chrome.sent.length - 1];
  assert.ok(toPage?.siteRules, '后台没把规则塞进扫描消息：这一轮的改判整条链路是死的');
  assert.equal(toPage.siteRules[savedFp].path, 'certifications.0.name', '已记住的规则要下发');
  assert.equal(toPage.siteRules[tempFp].path, 'basics.name', '本轮确认也要下发');
  assert.equal(toPage.siteRules[tempFp].temporary, true, '临时的要标成临时，界面才说得出"关页就没"');
  assert.deepEqual(toPage.temporaryFps, [tempFp]);
  assert.equal(res.confirmationRejected?.[0]?.fp, 'oops', '被拒的确认要带回面板');
  assert.match(res.confirmationRejected[0].why, /不是资料里真实存在/);
  // 关键：本轮确认**没有**被写进存储
  const bucket = chrome.local[RULES_BUCKET]['https://careersite.tupu360.com'];
  assert.deepEqual(Object.keys(bucket), [savedFp], `没勾"记住到本站"的确认被落盘了：${Object.keys(bucket)}`);
});

test('规则与适配器一起下发：面板拿到的 mapping 用的是这一站那一版', async () => {
  const { chrome, send } = await boot();
  await send({ type: 'nw:siteRulesPut', tabId: 1, entries: [{ fp: 'z1', path: 'basics.name' }] });
  await send({ type: 'nw:scan', tabId: 1, mode: 'full' });
  const toPage = chrome.sent[chrome.sent.length - 1];
  assert.ok('adapter' in toPage, '适配器字段不该被规则合流挤掉');
  assert.ok(toPage.siteRules.z1);
  assert.equal(toPage.mode, 'full', '合流时不该顺手改掉扫描模式');
});

/** ── 独立审查 Critical 1：面板的 tabId 可能是旧的，用户已经把那一页翻到别家站点 ── */
test('expectOrigin 与当前页对不上时：拒绝落盘，一条都不写进新站点的桶', async () => {
  const { chrome, send } = await boot();
  const got = await send({
    type: 'nw:siteRulesPut', tabId: 1, expectOrigin: 'https://a-old-recruiter.example',
    entries: [{ fp: 'f1', path: 'basics.name' }],
  });
  assert.equal(got.ok, false, `旧表的改判被存进了当前站点的桶：${JSON.stringify(got)}`);
  assert.equal(got.error, 'origin_changed');
  assert.equal(got.pageOrigin, 'https://careersite.tupu360.com', '要说清现在这一页是谁');
  assert.ok(!chrome.local[RULES_BUCKET], '被拒的落盘却在存储里留下了痕迹');

  // 读取那一侧同样要拒：不然面板会拿着旧表的行去显示别家的规则
  const read = await send({ type: 'nw:siteRulesGet', tabId: 1, expectOrigin: 'https://a-old-recruiter.example' });
  assert.equal(read.ok, false);
  assert.equal(read.error, 'origin_changed');
});

test('扫描时带旧表的确认：确认不套用并说清原因，但本站已记住的规则照旧生效', async () => {
  const { chrome, send } = await boot();
  await send({ type: 'nw:siteRulesPut', tabId: 1, entries: [{ fp: 'saved', path: 'basics.name' }] });
  const res = await send({
    type: 'nw:scan', tabId: 1, mode: 'full',
    expectOrigin: 'https://a-old-recruiter.example',
    confirmed: [{ fp: 'fresh', path: 'contact.email' }],
  });
  const toPage = chrome.sent[chrome.sent.length - 1];
  assert.ok(toPage.siteRules.saved, '本站自己记住的那条不该被牵连');
  assert.ok(!toPage.siteRules.fresh, `旧页面上的确认被套到新站点这一页：${JSON.stringify(toPage.siteRules)}`);
  assert.equal(res.confirmationRejected?.length, 1, '被丢掉的确认必须回话，不能静默');
  assert.match(res.confirmationRejected[0].why, /换到/);
});

test('没有确认项时 expectOrigin 不该制造噪音：正常扫描不回"被拒 1 条"', async () => {
  const { send } = await boot();
  const res = await send({ type: 'nw:scan', tabId: 1, mode: 'preview', expectOrigin: 'https://a-old-recruiter.example' });
  assert.equal(res.ok, true);
  assert.ok(!res.confirmationRejected?.length, JSON.stringify(res.confirmationRejected));
});

test('只读导出也带规则：面板与导出不许各说一套', async () => {
  const { chrome, send } = await boot();
  await send({ type: 'nw:siteRulesPut', tabId: 1, entries: [{ fp: 'z9', path: 'basics.name' }] });
  await send({ type: 'nw:unfilledMap', tabId: 1 });
  const toPage = chrome.sent[chrome.sent.length - 1];
  assert.equal(toPage.type, 'nw:unfilledMap');
  assert.ok(toPage.siteRules?.z9, '导出没带规则 → 表上写着"按你的改判"，导出却说词典没这个词');
});
