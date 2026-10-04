// 整页概念映射（AI 认栏位）在面板里的完整一跳：预览 → 问一次 → 进映射表 → 才落笔。
// 为什么单独一个装配层测试（本仓库的老账）：core 的 applyPageMapSuggestions 与后台的
// nw:aiMapPage 各自都有测试，但"面板拼出的栏位档案里漏了 description"、
// "AI 的回答没跟着写入那一跳"这类错误只在整条链路真跑时才现形。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { planFill } from '../core/matcher.js';
import { applyPageMapSuggestions } from '../core/ai.js';
import { buildMappingTable } from '../core/mapping-table.js';
import { checkPlan } from '../core/plan-check.js';
import { buildFields, createEmptyProfile, setValueByPath } from '../core/profile-schema.js';

const root = path => fileURLToPath(new URL(path, import.meta.url));
const html = fs.readFileSync(root('../ui/sidepanel.html'), 'utf8');
const high = JSON.parse(fs.readFileSync(root('../core/high-frequency.json'), 'utf8'));
const SCHEMA = buildFields();
const BASE = 'https://api.example.test/v1';

const pf = (o = {}) => ({
  kind: 'text', label: '', labelRaw: '', name: '', id: '', placeholder: '', currentValue: '',
  options: [], required: false, nearbyLabels: [], description: '', sectionHint: '', sectionTitle: '',
  itemIndex: null, autocomplete: '', type: 'text', labelSource: 'label', ...o,
});

function fixture() {
  const p = createEmptyProfile();
  setValueByPath(p, 'education.0.school', '复旦大学');
  setValueByPath(p, 'certifications.0.name', 'CFA Level II');
  setValueByPath(p, 'basics.name', '欧阳测试');
  setValueByPath(p, 'contact.phone', '13800001234');
  const fields = [
    pf({ label: '学校名称', name: 'school', id: 's1', sectionTitle: '教育经历' }),
    pf({ label: 'Awarding Body', name: 'award', id: 'a1', required: true, description: '发证的机构或证书本身' }),
  ];
  return { p, fields };
}

/** 一次"扫描"：可选先把整页映射的回答并进计划（走真 core 函数，不手搓结果） */
function scanResult({ profile, fields, suggestions, mode }) {
  const plan = planFill(fields, profile, { mode: mode === 'full' ? 'full' : 'preview' });
  let aiMap = null;
  let merged = plan;
  if (suggestions?.length) {
    merged = applyPageMapSuggestions(plan, profile, suggestions, { fillSensitive: false });
    aiMap = { filledGaps: merged.filledGaps, overridden: merged.overridden, refused: merged.refused };
  }
  const mapping = buildMappingTable({ fields, plan: merged, results: [], origin: 'https://job.example.test', schemaFields: SCHEMA });
  return {
    stats: { scanned: fields.length, planned: merged.assignments.filter(a => !a.skip).length, auto: 0, review: 0, gaps: merged.gaps.length, profileFilled: 4, aiApplied: suggestions?.length || 0 },
    results: [], gaps: merged.gaps, mapping, aiMap,
    planCheck: checkPlan({ fields, plan: merged, profile, schemaFields: SCHEMA, mapping }),
    pageOrigin: 'https://job.example.test',
  };
}

function boot({ ai = true } = {}) {
  const { p, fields } = fixture();
  const dom = new JSDOM(html, { url: 'chrome-extension://nwtest/ui/sidepanel.html', pretendToBeVisual: true });
  const sent = [];
  dom.window.CSS = dom.window.CSS || {};
  if (!dom.window.CSS.escape) dom.window.CSS.escape = s => String(s).replace(/([^\w-])/g, '\\$1');
  dom.window.chrome = {
    runtime: {
      getURL: x => 'chrome-extension://nwtest/' + x,
      sendMessage: async msg => {
        sent.push(msg);
        if (msg.type === 'nw:scan') {
          return { ok: true, data: scanResult({ profile: p, fields, suggestions: msg.aiPageMapSuggestions, mode: msg.mode }) };
        }
        if (msg.type === 'nw:aiMapPage') {
          if (msg.preview) return { ok: true, preview: true, text: '{"fields":…}', bytes: 812, count: msg.fields.length, trim: { why: '完整档案' } };
          return {
            ok: true,
            mapping: [{ index: 1, concept: 'cert-name', path: 'certifications.0.name', reason: '像是证书名', label: 'Awarding Body' }],
            declined: [{ index: 0, reason: '看不懂' }],
            dropped: [], bytes: 812, count: msg.fields.length, timing: { upBytes: 812, headersMs: 40 },
          };
        }
        if (msg.type === 'nw:siteRulesPut') return { ok: true, accepted: (msg.entries || []).length, rejected: [], count: (msg.entries || []).length };
        return {
          ok: true, tabId: 1, profile: p,
          settings: ai ? { aiBaseUrl: BASE, aiModel: 'r1', aiConsentOrigin: 'https://api.example.test' } : {},
          hasAiKey: ai, aiKeyOrigin: 'https://api.example.test', aiKeyPersisted: false, aiKeyLength: 24,
        };
      },
      onMessage: { addListener() {} },
    },
    tabs: { query: async () => [{ id: 1 }] },
    storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } },
  };
  dom.window.fetch = async () => ({ json: async () => high });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // globalThis.navigator 在 Node 21+ 是"只有 getter"的全局属性，直接赋值会抛 TypeError
  // （CI 的 Node 22 上 90 条测试就是这么连带红的），defineProperty 才是跨版本写法。
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
  globalThis.CSS = dom.window.CSS;
  globalThis.fetch = dom.window.fetch;
  globalThis.chrome = dom.window.chrome;
  return { dom, doc: dom.window.document, sent, profile: p, fields };
}

async function load() { await import('../ui/sidepanel.js?run=' + Math.random().toString(36).slice(2)); }
const click = (doc, id) => doc.getElementById(id).dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
const settle = (ms = 80) => new Promise(r => setTimeout(r, ms));

test('没预览就不许问；预览之后按钮解锁，并说清要发多少字节', async () => {
  const { doc } = boot();
  await load();
  await settle();
  click(doc, 'btnScan');
  await settle();
  assert.equal(doc.getElementById('btnMapAi').disabled, true, '没预览就能直接问，等于少一道确认');
  click(doc, 'btnMapAiPreview');
  await settle();
  assert.equal(doc.getElementById('btnMapAi').disabled, false);
  assert.match(doc.getElementById('mapAiStatus').textContent, /812 字节/);
  assert.match(doc.getElementById('mapAiStatus').textContent, /没有任何取值/);
});

test('发出去的栏位档案里有页面文字与状态词，但没有一条资料取值', async () => {
  const { doc, sent, profile } = boot();
  await load();
  await settle();
  click(doc, 'btnScan');
  await settle();
  click(doc, 'btnMapAiPreview');
  await settle();
  const msg = sent.filter(m => m.type === 'nw:aiMapPage').pop();
  assert.equal(msg.fields.length, 2, '整页映射的范围是全页，不是只有缺口');
  assert.match(JSON.stringify(msg.fields), /Awarding Body/);
  assert.match(JSON.stringify(msg.fields), /发证的机构或证书本身/, 'description 是判断依据之一，拼漏了这一栏就白问');
  assert.deepEqual(Object.values(msg.valueStates), ['empty', 'empty'], 'valueState 只给状态词');
  const txt = JSON.stringify(msg);
  for (const v of ['欧阳测试', '13800001234', 'CFA Level II', '复旦大学']) {
    assert.ok(!txt.includes(v), `档案里带了取值 ${v}`);
  }
  assert.equal(profile && true, true);
});

test('AI 的回答进的是映射表：来历写 〔AI 概念映射〕，写入仍要另一个钮', async () => {
  const { doc, sent } = boot();
  await load();
  await settle();
  click(doc, 'btnScan');
  await settle();
  const before = doc.getElementById('mapTable').querySelectorAll('.mrow')[2].textContent;
  assert.match(before, /没定下来|本地词典没有这个说法/);
  click(doc, 'btnMapAiPreview');
  await settle();
  click(doc, 'btnMapAi');
  await settle(120);
  const after = doc.getElementById('mapTable').querySelectorAll('.mrow')[2].textContent;
  assert.match(after, /证书名称/, `AI 的答案没进表：${after}`);
  assert.match(after, /AI 概念映射/);
  assert.match(doc.getElementById('mapAiStatus').textContent, /补缺口 1/);
  assert.match(doc.getElementById('mapAiStatus').textContent, /看不懂/, '它说认不出的那些要连原话一起念');
  // 问过一次之后授权作废：下一次要重新预览
  assert.equal(doc.getElementById('btnMapAi').disabled, true, '一次预览被用完之后还留着解锁状态');
  // 表还没被"确认"过：不许已经写页面
  const last = sent.filter(m => m.type === 'nw:scan').pop();
  assert.equal(last.mode, 'preview', '问完 AI 就直接写了页面');
});

test('「按此映射填写」把整页映射的回答一起带上，否则表上看得见的答案会凭空消失', async () => {
  const { doc, sent } = boot();
  await load();
  await settle();
  click(doc, 'btnScan');
  await settle();
  click(doc, 'btnMapAiPreview');
  await settle();
  click(doc, 'btnMapAi');
  await settle(120);
  click(doc, 'btnMapFill');
  await settle();
  const write = sent.filter(m => m.type === 'nw:scan').pop();
  assert.equal(write.mode, 'full');
  assert.deepEqual(write.aiPageMapSuggestions?.map(s => [s.index, s.path]), [[1, 'certifications.0.name']]);
});

test('重新扫描会让上一轮的整页回答作废（index 可能对不上新页面）', async () => {
  const { doc, sent } = boot();
  await load();
  await settle();
  click(doc, 'btnScan');
  await settle();
  click(doc, 'btnMapAiPreview');
  await settle();
  click(doc, 'btnMapAi');
  await settle(120);
  click(doc, 'btnScan');
  await settle();
  click(doc, 'btnMapFill');
  await settle();
  const write = sent.filter(m => m.type === 'nw:scan').pop();
  assert.equal(write.aiPageMapSuggestions, undefined, '换了新的一轮还带着旧答案，等于拿别的页面的判定写这一页');
  assert.equal(doc.getElementById('btnMapAi').disabled, true, '重新扫描后没预览就能问');
});

test('AI 三项没配齐时，预览先说缺什么，不发请求', async () => {
  const { doc, sent } = boot({ ai: false });
  await load();
  await settle();
  click(doc, 'btnScan');
  await settle();
  click(doc, 'btnMapAiPreview');
  await settle();
  assert.match(doc.getElementById('mapAiStatus').textContent, /还没配好/);
  assert.ok(!sent.some(m => m.type === 'nw:aiMapPage'), '没配好却仍然发出了请求');
});
