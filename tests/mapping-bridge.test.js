// S6 的装配层：真的把 dom/content.js 跑一遍，确认映射表与计划校验能穿过消息层回到面板。
//
// 为什么要单独一层（本仓库的老教训）：纯函数测证明"算得对"，
// 但"后台把规则发下来了、内容脚本却忘了传进 planFill"、"面板以为有 mapping 其实 undefined"
// 这两类错误只在整条链路真跑时才现形 —— 上一轮 nw:unfilledMap 的 `build is not defined`
// 与自检白名单那两条都是这么抓出来的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';


const PAGE_URL = 'https://careersite.tupu360.com/accentureats/resume/applicationView';
const PAGE = `<form class="ant-form">
  <div class="ant-row ant-form-item"><span class="ant-form-item-label"><label for="e1">Awarding Body</label></span>
    <span class="ant-form-item-children"><input id="e1" type="text" data-nw-test="cert"></span></div>
  <div class="ant-row ant-form-item"><span class="ant-form-item-label"><label for="e2">Expected Graduation</label></span>
    <span class="ant-form-item-children"><input id="e2" type="text" data-nw-test="grad"></span></div>
</form>`;

/**
 * @param {object} opts.profile   资料
 * @param {object} opts.siteRules 后台合流后下发的规则（{fp → rule}）
 * @param {Array}  opts.temporaryFps
 */
async function boot({ profile = {}, siteRules = null, temporaryFps = [], settings = {}, suggestions = null } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${PAGE}</body></html>`, { url: PAGE_URL, pretendToBeVisual: true });
  const listenerBox = { fn: null };
  const base = import.meta.url;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.CSS = dom.window.CSS && dom.window.CSS.escape ? dom.window.CSS : Object.assign(dom.window.CSS || {}, { escape: s => String(s).replace(/([^\w-])/g, '\\$1') });
  globalThis.navigator = dom.window.navigator;
  globalThis.chrome = {
    runtime: {
      getURL: p => new URL(p, new URL('../', base)).href,
      onMessage: { addListener: fn => { listenerBox.fn = fn; } },
      // 内容脚本只会问台账；给它一个空账本（不是 undefined —— 拿不到账本时"保守不覆盖"那条也要真跑到）
      sendMessage: async msg => (msg?.type === 'nw:ledgerGet' ? { ok: true, ledger: {} } : { ok: true }),
    },
    storage: { local: { get: async keys => { const out = {}; for (const k of [].concat(keys)) out[k] = k === 'profile' ? profile : settings; return out; } } },
  };
  await import('../dom/content.js?run=' + Math.random().toString(36).slice(2));
  const send = msg => new Promise(resolve => listenerBox.fn(msg, {}, resolve));
  /** 面板发扫描时不自己带规则（规则由后台按 tabId 合流）；这里直接扮演后台那一跳 */
  const scan = (extra = {}) => send({ type: 'nw:scan', tabId: 1, mode: 'preview', dryRun: true, siteRules, temporaryFps, aiPageMapSuggestions: suggestions, ...extra });
  return { send, scan, dom };
}


test('真跑一次扫描：回包里有 mapping（一栏一行）与 planCheck，且都能过结构化克隆', async () => {
  const profile = { certifications: [{ name: 'CFA Level II' }] };
  const { send } = await boot({ profile });
  const res = await send({ type: 'nw:scan', tabId: 1, mode: 'preview', dryRun: true });
  assert.equal(res?.ok, true, `扫描链路没跑通：${JSON.stringify(res)}`);
  const data = res.data;
  assert.ok(data.mapping && Array.isArray(data.mapping.rows), '回包里没有映射表');
  assert.equal(data.mapping.rows.length, 2, `这一页两栏，表里就该两行：${data.mapping.rows.length}`);
  assert.ok(data.planCheck && Array.isArray(data.planCheck.warnings), '回包里没有计划校验');
  // JSON 往返 = chrome 消息的 structured clone 近似：DOM 节点混进去就会在这里炸
  const round = JSON.parse(JSON.stringify(data.mapping));
  assert.equal(Object.prototype.hasOwnProperty.call(round.rows[0], 'el'), false, '行里不许带 DOM');
  assert.ok(round.rows.every(r => typeof r.fp === 'string' && r.fp), '每一行都要带指纹，改判才认得出是哪一栏');
  assert.match(data.mapping.rows[0].page.label, /Awarding Body|Body/);
});

test('后台下发的改判规则真的进了这一轮的匹配：note 里说得出是你改的', async () => {
  const profile = { certifications: [{ name: 'CFA Level II' }] };
  /**
   * 指纹从**第一次扫描的回包**里取，而不是测试里手搓字段：
   * 面板走的正是这条路（表里那一行带着 fp，改判时原样发回去）。
   * 手搓的字段与扫描器的产物只要差一个 labelRaw 前缀就对不上号 ——
   * 上一版这条测试就是这么假绿的（规则下发了却谁也没命中）。
   */
  const first = await boot({ profile });
  const probe = (await first.scan()).data;
  const fp = probe.mapping.rows[0].fp;
  assert.ok(fp && probe.mapping.rows[0].decision.path === '', '这一栏本来就该是没定下来的，才轮到改判说话');

  const { scan } = await boot({
    profile,
    siteRules: { [fp]: { fp, path: 'certifications.0.name', skip: false, note: '这一栏问的就是证书名' } },
    temporaryFps: [fp],
  });
  const data = (await scan()).data;
  const row = data.mapping.rows[0];
  assert.equal(row.decision.path, 'certifications.0.name', JSON.stringify(row.decision));
  assert.ok(['siteRule', 'confirmed'].includes(row.decision.by), `来历要分得清：${row.decision.by}`);
  assert.match(String(row.decision.note), /改判/);
  assert.match(String(row.rule.note), /证书名/, '用户当时写的理由要回到表里');
  // 预演不许碰页面
  assert.equal(globalThis.document.querySelector('[data-nw-test="cert"]').value, '', 'preview 阶段就把值写进页面了');
});

test('规则一个都不生效时表照样完整：没改判的页不许白屏', async () => {
  const { scan } = await boot({ profile: {} });
  const data = (await scan()).data;
  assert.equal(data.mapping.rows.length, 2);
  assert.equal(data.mapping.stats.byRule, 0);
  assert.ok(data.planCheck.warnings.some(w => w.kind === 'nothing_to_write'), '资料是空的 → 整页不写，该校验要说出来');
});

test('映射表里绝不带资料取值：屏幕上那份与导出那份都要干净', async () => {
  const profile = {
    basics: { name: '欧阳测试', idNumber: '110101200103150011' },
    certifications: [{ name: 'CFA Level II' }],
    contact: { phone: '13800001234' },
  };
  const { scan } = await boot({ profile, settings: { fillSensitive: true } });
  const data = (await scan()).data;
  const txt = JSON.stringify(data.mapping);
  for (const v of ['CFA Level II', '欧阳测试', '13800001234', '110101200103150011']) {
    assert.ok(!txt.includes(v), `映射表里出现了资料取值 ${v} —— 这张表是要导给人看的`);
  }
});

test('登录页被整页目的闸拦下时，回包也带 mapping/planCheck 的空形状（面板不许崩）', async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <form><input type="text" placeholder="用户名" id="u"><input type="password" id="p">
    <label for="r">记住我</label><input type="checkbox" id="r">
    <button type="submit">登录</button></form></body></html>`, { url: 'https://account.tupu360.com/login', pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.CSS = Object.assign(dom.window.CSS || {}, { escape: s => String(s).replace(/([^\w-])/g, '\\$1') });
  globalThis.navigator = dom.window.navigator;
  const listenerBox = { fn: null };
  const base = import.meta.url;
  globalThis.chrome = {
    runtime: {
      getURL: p => new URL(p, new URL('../', base)).href,
      onMessage: { addListener: fn => { listenerBox.fn = fn; } },
      sendMessage: async () => ({ ok: true }),
    },
    storage: { local: { get: async () => ({}) } },
  };
  await import('../dom/content.js?run=' + Math.random().toString(36).slice(2));
  const res = await new Promise(resolve => listenerBox.fn({ type: 'nw:scan', tabId: 1, mode: 'full' }, {}, resolve));
  assert.equal(res?.data?.purposeBlocked, true, `登录页没被拦：${JSON.stringify(res?.data?.pagePurpose)}`);
  assert.deepEqual(res.data.mapping.rows, [], '拦下时映射表应是空数组而不是 undefined');
  assert.ok(Array.isArray(res.data.planCheck.warnings));
});

test('aiPageMapSuggestions 穿得过内容脚本：表里出现 〔AI 概念映射〕，且预演不写页面', async () => {
  const profile = { certifications: [{ name: 'CFA Level II' }], awards: {} };
  const first = await boot({ profile });
  const probe = (await first.scan()).data;
  const row = probe.mapping.rows.find(r => /Awarding/.test(r.page.label));
  assert.ok(row && !row.decision.path, '前提：这一栏本地认不出');
  const { scan } = await boot({
    profile,
    suggestions: [{ index: row.index, path: 'certifications.0.name', concept: 'cert-name', reason: '像是证书名', label: row.page.label }],
  });
  const data = (await scan({ aiPageMapSuggestions: [{ index: row.index, path: 'certifications.0.name', concept: 'cert-name', reason: '像是证书名', label: row.page.label }] })).data;
  const after = data.mapping.rows[row.index];
  assert.equal(after.decision.path, 'certifications.0.name', JSON.stringify(after.decision));
  assert.equal(after.decision.by, 'ai', '来历要写成 AI，不是本地词典');
  assert.equal(data.aiMap.filledGaps, 1);
  assert.equal(globalThis.document.querySelector('[data-nw-test="cert"]').value, '', '预演阶段就把 AI 的答案写进页面了');
});

test('旧「问 AI 补缺口」那条路在真实扫描产物上也认得标签（回归：整条路曾静默为死）', async () => {
  const profile = { certifications: [{ name: 'CFA Level II' }] };
  const first = await boot({ profile });
  const probe = (await first.scan()).data;
  const aiField = probe.aiFields.find(f => /Awarding/i.test(f.label));
  assert.ok(aiField, '前提：这一栏要出现在"可以问 AI"的清单里');
  const { scan } = await boot({ profile });
  const data = (await scan({ aiCandidates: [{ index: aiField.index, path: 'certifications.0.name', label: aiField.label }] })).data;
  assert.equal(data.stats.aiApplied, 1, '拿面板自己给的标签回来都还不认，说明判据仍然过严');
  const row = data.mapping.rows[aiField.index];
  assert.equal(row.decision.path, 'certifications.0.name');
  assert.equal(row.decision.by, 'ai');
});
