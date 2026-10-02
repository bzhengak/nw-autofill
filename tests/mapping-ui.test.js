// S6 映射表在侧边栏里的行为。
// 这一层为什么必须真点一遍（本仓库的老账）：core 的纯函数全绿、消息契约也测过，
// 但"面板把表画出来了却没有一个钮会写"这种失败，只有 jsdom 里真点才现形。
// 上一轮 nw:unfilledMap 的 `build is not defined`、自检白名单，都是这么抓出来的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { planFill } from '../core/matcher.js';
import { buildMappingTable, plainMappingTable } from '../core/mapping-table.js';
import { checkPlan } from '../core/plan-check.js';
import { fingerprint } from '../core/ledger.js';
import { buildFields, createEmptyProfile, setValueByPath } from '../core/profile-schema.js';

const root = path => fileURLToPath(new URL(path, import.meta.url));
const html = fs.readFileSync(root('../ui/sidepanel.html'), 'utf8');
const high = JSON.parse(fs.readFileSync(root('../core/high-frequency.json'), 'utf8'));
const SCHEMA = buildFields();

const pf = (o = {}) => ({
  kind: 'text', label: '', labelRaw: '', name: '', id: '', placeholder: '', currentValue: '',
  options: [], required: false, nearbyLabels: [], description: '', sectionHint: '', sectionTitle: '',
  itemIndex: null, autocomplete: '', type: 'text', labelSource: 'label', ...o,
});

/** 造一份真·扫描回包（映射表与校验都由真函数算出来，不手搓形状） */
function scanData(profile, fields, opts = {}) {
  const plan = planFill(fields, profile, { mode: 'preview', ...opts });
  const mapping = buildMappingTable({ fields, plan, results: [], origin: 'https://job.example.test', schemaFields: SCHEMA, siteRules: opts.siteRules || {} });
  return {
    stats: { scanned: fields.length, planned: mapping.stats.decided, auto: 0, review: 0, gaps: plan.gaps.length, profileFilled: 4 },
    results: [],
    gaps: plan.gaps.map(g => ({ index: g.index, label: g.label, reason: g.reason, kind: g.kind, note: g.note || '' })),
    mapping,
    planCheck: checkPlan({ fields, plan, profile, schemaFields: SCHEMA, table: mapping }),
  };
}

function boot({ data, rules = {}, putResult = null } = {}) {
  const dom = new JSDOM(html, { url: 'chrome-extension://nwtest/ui/sidepanel.html', pretendToBeVisual: true });
  const sent = [];
  dom.window.CSS = dom.window.CSS || {};
  if (!dom.window.CSS.escape) dom.window.CSS.escape = s => String(s).replace(/([^\w-])/g, '\\$1');
  dom.window.chrome = {
    runtime: {
      getURL: p => 'chrome-extension://nwtest/' + p,
      sendMessage: async msg => {
        sent.push(msg);
        if (msg.type === 'nw:scan') return { ok: true, data, siteRuleCount: Object.keys(rules).length };
        if (msg.type === 'nw:siteRulesGet') return { ok: true, rules, origin: 'https://job.example.test', count: Object.keys(rules).length };
        if (msg.type === 'nw:siteRulesPut') return putResult || { ok: true, accepted: (msg.entries || []).length, rejected: [], count: (msg.entries || []).length };
        if (msg.type === 'nw:siteRulesForgetSite') return { ok: true, count: 0 };
        return { ok: true, profile: createEmptyProfile(), settings: {}, tabId: 1 };
      },
      onMessage: { addListener() {} },
    },
    tabs: { query: async () => [{ id: 1 }] },
    storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } },
  };
  dom.window.fetch = async () => ({ json: async () => high });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.CSS = dom.window.CSS;
  globalThis.fetch = dom.window.fetch;
  globalThis.chrome = dom.window.chrome;
  return { dom, doc: dom.window.document, sent };
}

async function loadSidePanel() {
  await import('../ui/sidepanel.js?run=' + Math.random().toString(36).slice(2));
}

const click = (doc, id) => doc.getElementById(id).dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

/** 两栏页面：一栏本地能认（学校名称），一栏认不出（Awarding Body） */
function fixture() {
  const p = createEmptyProfile();
  setValueByPath(p, 'education.0.school', '复旦大学');
  const fields = [
    pf({ label: '学校名称', name: 'school', id: 's1', sectionTitle: '教育经历' }),
    pf({ label: 'Awarding Body', name: 'award', id: 'a1', required: true }),
  ];
  return { p, fields };
}

test('扫描后：映射表一栏一行，表头五列都在，且默认这轮没写任何东西', async () => {
  const { p, fields } = fixture();
  const { doc, sent } = boot({ data: scanData(p, fields) });
  await loadSidePanel();
  await settle();
  click(doc, 'btnScan');
  await settle();
  const rows = doc.getElementById('mapTable').querySelectorAll('.mrow');
  assert.ok(rows.length >= 3, `表头 + 两栏该有的行：${rows.length}`);
  assert.match(doc.getElementById('mapTable').textContent, /页面这一栏/);
  assert.match(doc.getElementById('mapTable').textContent, /凭什么/);
  assert.match(doc.getElementById('mapTable').textContent, /现在是谁写的/);
  assert.match(doc.getElementById('mapTable').textContent, /Awarding Body/);
  assert.match(doc.getElementById('mapTable').textContent, /复旦大学|学校名称/);
  // 「映射表先行」开着：扫描钮发的是 preview，且按钮文字不是"填写"
  const scanMsg = sent.filter(m => m.type === 'nw:scan').pop();
  assert.equal(scanMsg.mode, 'preview', '开关开着时点「扫描并填写」竟然直接写了页面');
  assert.equal(scanMsg.dryRun, true);
  assert.match(doc.getElementById('btnScan').textContent, /出映射表/);
  assert.match(doc.getElementById('mapSummary').textContent, /一个字节都没改/);
});

/** 改判下拉里默认只列前 40 个槽位，剩下的靠搜索框捞：这一步顺手把搜索也钉住 */
async function pickSlot(doc, rowIndex, path, query) {
  if (query) {
    const box = doc.getElementById('mapSearch');
    box.value = query;
    box.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
    await settle(20);
  }
  const sel = doc.getElementById('mapTable').querySelectorAll('.mrow')[rowIndex].querySelector('select');
  sel.value = path;
  assert.equal(sel.value, path, `下拉里没有「${path}」这一项（搜索词：${query || '无'}）`);
  sel.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  return sel;
}

test('改判一栏再落笔：confirmed 里带着指纹与槽位，且只有这个钮才会写页面', async () => {
  const { p, fields } = fixture();
  const { doc, sent } = boot({ data: scanData(p, fields) });
  await loadSidePanel();
  await settle();
  click(doc, 'btnScan');
  await settle();
  await pickSlot(doc, 2, 'certifications.0.name', '证书名称');
  assert.match(doc.getElementById('btnMapFill').textContent, /含 1 栏改判/);
  click(doc, 'btnMapFill');
  await settle();
  const write = sent.filter(m => m.type === 'nw:scan').pop();
  assert.equal(write.mode, 'full', '「按此映射填写」没真的发起写入');
  assert.equal(write.dryRun, false);
  assert.deepEqual(write.confirmed, [{ fp: fingerprint(fields[1]), path: 'certifications.0.name', skip: false, note: '' }]);
});

test('「这一栏不自动填」是 skip，不是随便挑一个槽位', async () => {
  const { p, fields } = fixture();
  const { doc, sent } = boot({ data: scanData(p, fields) });
  await loadSidePanel();
  await settle();
  click(doc, 'btnScan');
  await settle();
  await pickSlot(doc, 2, '__skip__');
  click(doc, 'btnMapFill');
  await settle();
  const write = sent.filter(m => m.type === 'nw:scan').pop();
  assert.equal(write.confirmed[0].skip, true);
  assert.equal(write.confirmed[0].path, '', '勾了不填却带槽位路径，等于又判了一次');
  assert.ok(!sent.some(m => m.type === 'nw:siteRulesPut'), '没勾「记住到本站」不该落盘');
});

test('勾了「记住到本站」：先落盘再写，规则从存储那一侧回来', async () => {
  const { p, fields } = fixture();
  const { doc, sent } = boot({ data: scanData(p, fields) });
  await loadSidePanel();
  await settle();
  click(doc, 'btnScan');
  await settle();
  await pickSlot(doc, 2, 'certifications.0.name', '证书');
  const second = doc.getElementById('mapTable').querySelectorAll('.mrow')[2];
  const note = second.querySelector('input[type="text"]');
  note.value = '这一栏问的是证书名';
  note.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
  doc.getElementById('mapRemember').checked = true;
  click(doc, 'btnMapFill');
  await settle();
  const put = sent.filter(m => m.type === 'nw:siteRulesPut').pop();
  assert.ok(put, '勾了记住却没发消息落盘');
  assert.equal(put.entries[0].note, '这一栏问的是证书名', '理由要跟着规则一起存');
  assert.equal(put.tabId, 1, '后台只能按 tabId 反查 origin，面板必须带上它');
  assert.ok(sent.findIndex(m => m.type === 'nw:siteRulesPut') < sent.length - 1,
    '先写页面再落盘的话，这一轮的规则来源就说不清了');
  const write = sent.filter(m => m.type === 'nw:scan').pop();
  assert.equal(write.mode, 'full');
  assert.ok(!write.confirmed, '已记住的规则由后台下发，本轮不必再带一份 confirmed');
  // 写完之后的措辞：不能还说"还没落笔"，也不能把"已记住几条"这句结论抹掉
  const summary = doc.getElementById('mapSummary').textContent;
  assert.match(summary, /已经按这张表写过一次|已记住/, `落笔后表顶那句话还在说"还没落笔"：${summary}`);
});

test('被后台拒了的改判要念出来，并且不会在下一帧渲染里被抹掉', async () => {
  const { p, fields } = fixture();
  const { doc, sent } = boot({
    data: scanData(p, fields),
    putResult: { ok: true, accepted: 0, rejected: [{ fp: 'x', why: '「nope.nope」不是资料里真实存在的槽位 —— 改判只能选已有的槽位，不能自造' }], count: 0 },
  });
  await loadSidePanel();
  await settle();
  click(doc, 'btnScan');
  await settle();
  await pickSlot(doc, 2, 'certifications.0.name', '证书');
  doc.getElementById('mapRemember').checked = true;
  click(doc, 'btnMapFill');
  await settle();
  assert.match(doc.getElementById('mapSummary').textContent, /被拒 1 条/);
  assert.match(doc.getElementById('mapSummary').textContent, /不是资料里真实存在的槽位/);
});

test('计划校验的每条提示都带下一步，写在表上方', async () => {
  const p = createEmptyProfile();
  const fields = [pf({ label: '必填但认不出的栏位', name: 'zz', id: 'z1', required: true })];
  const { doc } = boot({ data: scanData(p, fields) });
  await loadSidePanel();
  await settle();
  click(doc, 'btnScan');
  await settle();
  const warn = doc.getElementById('mapWarn');
  assert.equal(warn.hidden, false, '有校验提示却藏着');
  assert.match(warn.textContent, /一栏都不写|必填/);
  assert.match(warn.textContent, /下一步：/);
});

test('页面标签是不可信输入：映射表里只当文字，不生成元素', async () => {
  const p = createEmptyProfile();
  const evil = '<img src=x onerror=alert(1)>';
  const fields = [pf({ label: evil, name: 'x', id: 'x1' })];
  const { doc } = boot({ data: scanData(p, fields) });
  await loadSidePanel();
  await settle();
  click(doc, 'btnScan');
  await settle();
  const host = doc.getElementById('mapTable');
  assert.equal(host.querySelector('img'), null, '页面标签被当成 HTML 插进了面板');
  assert.equal(host.querySelectorAll('script').length, 0);
  assert.match(host.textContent, /onerror/, '原文要能看见（那是诊断线索），但只能是文字');
});

test('导出映射表：走的是脱敏视图，屏幕上的回读值不进文件', async () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'contact.phone', '13800001234');
  const fields = [pf({ label: '学校名称', name: 'school', id: 's1' })];
  const data = scanData(p, fields);
  // 模拟写完之后：屏幕上那版表里带着回读值，导出那版必须剥掉
  data.mapping = buildMappingTable({
    fields, plan: planFill(fields, p, { mode: 'full' }), schemaFields: SCHEMA, origin: 'https://job.example.test',
    results: [{ index: 0, status: 'green', path: 'contact.phone', actual: '13800001234' }],
  });
  const { doc } = boot({ data });
  await loadSidePanel();
  await settle();
  click(doc, 'btnScan');
  await settle();
  click(doc, 'btnMapExport');
  await settle();
  const out = doc.getElementById('mapOut').value;
  assert.ok(out, '没导出内容');
  assert.ok(!out.includes('13800001234'), `导出里带了回读值：${out.slice(0, 200)}`);
  const parsed = JSON.parse(out);
  assert.deepEqual(Object.keys(parsed).sort(), ['rows', 'stats']);
  assert.ok(parsed.rows[0].label !== undefined && !('actual' in parsed.rows[0]));
  assert.ok(JSON.stringify(plainMappingTable(data.mapping)) === out.trim() || out.includes('"fp"'), '导出内容应与脱敏视图一致');
});

test('「本站已记住几条」列的是这一页命中的那些，不是整桶', async () => {
  const { p, fields } = fixture();
  const rules = {
    [fingerprint(fields[1])]: { fp: fingerprint(fields[1]), path: 'certifications.0.name', skip: false, note: '题目问的是证书名' },
    'other-site-fp': { fp: 'other-site-fp', path: 'basics.name', skip: false, note: '' },
  };
  const { doc } = boot({ data: scanData(p, fields, { siteRules: rules }), rules });
  await loadSidePanel();
  await settle();
  click(doc, 'btnScan');
  await settle();
  click(doc, 'btnMapRules');
  await settle();
  const warn = doc.getElementById('mapWarn').textContent;
  assert.match(warn, /已记住 2 条/);
  assert.match(warn, /命中 1 条/);
  assert.match(warn, /Awarding Body/);
  assert.match(warn, /题目问的是证书名/);
  assert.ok(!warn.includes('other-site-fp'), '把无关指纹摊给用户看只会添乱');
});

test('「忘记本站的改判」：发消息、清空本轮改判、重扫一次', async () => {
  const { p, fields } = fixture();
  const { doc, sent } = boot({ data: scanData(p, fields) });
  await loadSidePanel();
  await settle();
  click(doc, 'btnScan');
  await settle();
  await pickSlot(doc, 2, 'certifications.0.name', '证书');
  click(doc, 'btnMapForget');
  await settle();
  assert.ok(sent.some(m => m.type === 'nw:siteRulesForgetSite'), '没发忘记本站的消息');
  assert.equal(doc.getElementById('btnMapFill').textContent.trim(), '按此映射填写', '本轮改判没被清空');
  const last = sent.filter(m => m.type === 'nw:scan').pop();
  assert.equal(last.mode, 'preview', '忘记之后应重扫一次出表，而不是留着旧表');
});

test('关掉「映射表先行」：扫描钮回到直接写，且开关状态存进设置', async () => {
  const { p, fields } = fixture();
  const { doc, sent } = boot({ data: scanData(p, fields) });
  await loadSidePanel();
  await settle();
  const box = doc.getElementById('mappingFirst');
  box.checked = false;
  box.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  await settle();
  const saved = sent.filter(m => m.type === 'nw:saveSettings').pop();
  assert.equal(saved.settings.mappingFirst, false, '开关没写进设置：重载后又会变回开着');
  assert.match(doc.getElementById('btnScan').textContent, /扫描并填写/);
  click(doc, 'btnScan');
  await settle();
  const write = sent.filter(m => m.type === 'nw:scan').pop();
  assert.equal(write.mode, 'full');
  assert.equal(write.dryRun, false);
});
