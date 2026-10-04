// 认选项的装配层测试：真的起 background/service-worker.js（假 chrome + 假 fetch），
// 再真的在 jsdom 里跑 dom/content.js 把决定落进页面控件。
//
// 为什么必须两层都真跑（这个仓库已经栽过三次：web_accessible_resources 漏登记、
// fillSensitive 面板有勾但没人读、AI 体积上限与使用者被拆开）：
//  · "勾选框开了到底有没有把取值发出去" —— 判据在后台那一段穿线里，纯函数测照不到；
//  · "AI 认下了一项，最后写进 select 的是不是页面自己的码值" —— 一半在 DOM 里。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { fingerprint } from '../core/ledger.js';
import { scanForm } from '../dom/scanner.js';

const BASE = 'https://api.llm.test/v1';
const KEY = 'sk-test-key-1234567890';
const PAGE = `<form>
  <div class="ant-form-item"><label for="nm">姓名</label><input id="nm" name="name"></div>
  <div class="ant-form-item"><label for="wa">工作许可身份</label>
    <select id="wa" name="workAuth">
      <option value="">请选择</option>
      <option value="1">Hong Kong Permanent Resident</option>
      <option value="2">Employer-tied Employment Visa</option>
      <option value="3">Returnee Undergraduate Scheme</option>
    </select>
  </div>
</form>`;

function profile() {
  return {
    basics: { name: '欧唯一测试', gender: '女' },
    contact: { phone: '13800001111' },
    hkGlobal: { workAuth: 'IANG（内地应届毕业生留港计划）' },
    education: [], work: [], projects: [], campus: [], awards: [], internship: [],
    competitions: [], publications: [], certifications: [], languages: [], skills: {},
    family: [], intent: {}, others: {}, records: {}, declaration: {},
  };
}

const bag = store => ({
  get: async k => (typeof k === 'string' ? { [k]: store[k] }
    : Array.isArray(k) ? Object.fromEntries(k.map(x => [x, store[x]])) : { ...store }),
  set: async obj => Object.assign(store, obj),
  remove: async keys => (Array.isArray(keys) ? keys : [keys]).forEach(x => delete store[x]),
});

/** 起一次真的 SW：假标签页固定成 job.example.test，AI 上游由 replies 决定 */
async function bootSw(replies = []) {
  const local = { profile: profile() };
  const session = {};
  const chrome = {
    local, session, calls: [],
    runtime: {
      id: 'nwtest', getURL: p => 'chrome-extension://nwtest/' + p,
      onMessage: { addListener() {} }, onInstalled: { addListener() {} },
      sendMessage: async () => ({ ok: true }),
    },
    action: { onClicked: { addListener() {} } },
    storage: { local: bag(local), session: bag(session) },
    tabs: {
      query: async () => [{ id: 1 }],
      get: async id => ({ id, url: 'https://job.example.test/apply' }),
      create() {},
      sendMessage: async () => ({ ok: true }),
    },
    webNavigation: { getAllFrames: async () => [] },
  };
  const listeners = [];
  chrome.runtime.onMessage.addListener = fn => listeners.push(fn);
  globalThis.chrome = chrome;
  globalThis.fetch = async (url, init) => {
    chrome.calls.push({ url, init });
    const content = typeof replies[chrome.calls.length - 1] === 'string' ? replies[chrome.calls.length - 1] : (replies.at(-1) || '{}');
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
      text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
    };
  };
  await import('../background/service-worker.js?align=' + Math.random().toString(36).slice(2));
  const send = msg => new Promise(resolve => listeners[0](msg, {}, resolve));
  await send({ type: 'nw:saveAiKey', key: KEY, baseUrl: BASE, persist: false });
  await send({ type: 'nw:saveSettings', settings: { aiBaseUrl: BASE, aiModel: 'some-model', aiConsentOrigin: new URL(BASE).origin } });
  await send({ type: 'nw:aiConsentSite', tabId: 1 });
  return { chrome, send, calls: chrome.calls, body: i => String(chrome.calls[i]?.init?.body || '') };
}

const workAuthTarget = {
  fp: 'fp-workauth-1', path: 'hkGlobal.workAuth', label: '工作许可身份', section: 'Work Authorization',
  options: ['Hong Kong Permanent Resident', 'Employer-tied Employment Visa', 'Returnee Undergraduate Scheme'],
};
const nameTarget = { fp: '', path: 'basics.name', label: 'Full name (as in ID)', section: 'Basics', options: ['A', 'B'] };

test('档 A 默认：发出去的字节里没有我的任何取值，回答里的代号能落成决定', async () => {
  const { send, calls } = await bootSw([JSON.stringify({
    fields: [{ index: 0, task: 'label', options: [{ i: 2, token: 'IANG' }, { i: 0, token: 'HK_PERMANENT_RESIDENT' }] }],
  })]);
  const res = await send({ type: 'nw:aiAlignOptions', tabId: 1, targets: [workAuthTarget] });
  assert.equal(res?.ok, true, JSON.stringify(res));
  const body = JSON.stringify(calls[0].init.body);
  for (const secret of ['IANG（内地应届毕业生留港计划）', '欧唯一测试', '13800001111']) {
    assert.ok(!body.includes(secret), `待发请求里出现了取值：${secret}`);
  }
  assert.ok(body.includes('Returnee Undergraduate Scheme'), '页面选项文字该发出去');
  assert.equal(res.mode, 'tokens');
  assert.deepEqual(res.valuesSent, [], '没勾档 C 就不该有取值出门');
  assert.equal(res.decisions.length, 1);
  assert.equal(res.decisions[0].expect, 'Returnee Undergraduate Scheme');
  assert.equal(res.decisions[0].mode, 'tokens');
  assert.equal(res.decisions[0].token, 'IANG');
});

test('勾了「允许 AI 看取值」：这一栏的取值真的出门；姓名那类即使在 targets 里也不出门', async () => {
  const { send, calls } = await bootSw([JSON.stringify({
    fields: [{ index: 0, task: 'pick', pick: 2, reason: '回港就业安排' }, { index: 1, task: 'pick', pick: 0 }],
  })]);
  await send({ type: 'nw:saveSettings', settings: { allowAiValues: true } });
  const res = await send({ type: 'nw:aiAlignOptions', tabId: 1, targets: [workAuthTarget, nameTarget] });
  assert.equal(res?.ok, true, JSON.stringify(res));
  const body = JSON.stringify(calls[0].init.body);
  assert.ok(body.includes('IANG（内地应届毕业生留港计划）'), '开了档 C 却没发取值：勾选框是装饰');
  assert.ok(!body.includes('欧唯一测试'), '姓名被硬排除清单拦下，开了档 C 也不许出门');
  assert.ok(!body.includes('13800001111'), '电话同理');
  assert.deepEqual(res.valuesSent.map(v => v.path), ['hkGlobal.workAuth']);
  assert.ok(res.blocked.length + res.skipped.length >= 1, '被拦下的那一栏必须报告，不能静默丢掉');
  assert.equal(res.decisions[0].mode, 'values', '档 C 的决定要带来源标记，映射表与 note 都靠它');
});

test('没配站点确认 / 全被拦下：各自给出看得见的失败，不发一个字节', async () => {
  const off = await bootSw(['{}']);
  const r1 = await off.send({ type: 'nw:aiAlignOptions', tabId: 1, targets: [] });
  assert.equal(r1.error, 'no_targets');
  assert.equal(off.chrome.calls.length, 0, '连 targets 都没有就已经出了网');
  // 只有"没有代号空间、又没开档 C"的一栏 → 一条都不发
  const r2 = await off.send({ type: 'nw:aiAlignOptions', tabId: 1, targets: [nameTarget] });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'nothing_alignable');
  assert.ok(String(r2.skipped?.[0]?.why || '').length > 0, '跳过必须带原因');
  assert.equal(off.chrome.calls.length, 0, '没一栏可问却还是出了网');
});

// ── 内容脚本那一跳：决定 → 页面控件里的真码值 ─────────────────────────
async function bootContent() {
  const dom = new JSDOM(`<!doctype html><html><body>${PAGE}</body></html>`, { url: 'https://job.example.test/apply', pretendToBeVisual: true });
  const d = dom.window.document;
  const box = { fn: null };
  globalThis.window = dom.window;
  globalThis.document = d;
  globalThis.location = dom.window.location;
  globalThis.CSS = Object.assign(dom.window.CSS || {}, { escape: s => String(s).replace(/([^\w-])/g, '\\$1') });
  // globalThis.navigator 在 Node 21+ 是"只有 getter"的全局属性，直接赋值会抛 TypeError
  // （CI 的 Node 22 上 90 条测试就是这么连带红的），defineProperty 才是跨版本写法。
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
  globalThis.chrome = {
    runtime: {
      getURL: p => new URL(p, new URL('../', import.meta.url)).href,
      onMessage: { addListener: fn => { box.fn = fn; } },
      sendMessage: async msg => (msg?.type === 'nw:ledgerGet' ? { ok: true, ledger: {} } : { ok: true }),
    },
    storage: { local: { get: async keys => { const out = {}; for (const k of [].concat(keys)) out[k] = k === 'profile' ? profile() : {}; return out; } } },
  };
  await import('../dom/content.js?run=' + Math.random().toString(36).slice(2));
  const scan = (extra = {}) => new Promise(resolve => box.fn({ type: 'nw:scan', tabId: 1, mode: 'full', dryRun: false, ...extra }, {}, resolve));
  const fp = fingerprint(scanForm(d).find(f => /workAuth|wa$/.test(String(f.id))));
  return { d, scan, fp };
}

test('AI 认下的那一项，最后写进 select 的是页面自己的码值 3（不是模型给的任何文字）', async () => {
  const { d, scan, fp } = await bootContent();
  const before = await scan();
  assert.equal(before?.ok, true, JSON.stringify(before));
  assert.equal(d.getElementById('wa').value, '', '这一栏本该本地认不出（前提不成立就别测了）');
  const row = (before.data.mapping?.rows || []).find(r => r.decision.needsChoice);
  assert.ok(row, '映射表里没出现"需要选一项"的那一栏');
  assert.equal(row.decision.path, 'hkGlobal.workAuth');

  const after = await scan({ aiOptionDecisions: [{ fp, expect: 'Returnee Undergraduate Scheme', mode: 'tokens', token: 'IANG', space: 'rightToWork' }] });
  assert.equal(after?.ok, true, JSON.stringify(after));
  assert.equal(d.getElementById('wa').value, '3', `没落到那一项：${d.getElementById('wa').value}`);
  assert.equal(after.data.aiOption.applied, 1);
  const row2 = (after.data.mapping?.rows || []).find(r => r.index === row.index);
  assert.equal(row2.decision.aiOption, true, '映射表看不出这一栏的选项是 AI 认的');
  assert.ok(/AI 认这一项/.test(row2.decision.note), `来历没写进备注：${row2.decision.note}`);
  assert.ok(!row2.decision.note.includes('IANG（内地'), '备注里不许出现取值（它会随导出离开本机）');
  assert.equal(row2.decision.tier, 'review', '工作权利是一句合规声明：即使非敏感也保持黄字核对');
  // 姓名那一栏一个字都不许被这次动作碰过
  assert.equal(d.getElementById('nm').value, '');
});

test('决定落在别的栏位上（指纹对不上）就整条不写：宁可不动', async () => {
  const { d, scan } = await bootContent();
  const res = await scan({ aiOptionDecisions: [{ fp: 'stale-fingerprint', expect: 'Employer-tied Employment Visa', mode: 'tokens' }] });
  assert.equal(d.getElementById('wa').value, '', '指纹已经不是这一栏了还在写');
  assert.equal(res.data.aiOption.applied, 0);
  assert.equal(res.data.aiOption.refused[0].why, 'fp_gone');
});
