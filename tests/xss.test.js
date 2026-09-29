// 界面注入回归：简历里的文字、页面标签、模型返回的内容，统统不许在扩展页面里当 HTML 解析。
// 为什么单独钉一条：侧边栏是 extension 页面，能读 chrome.storage.local 里的整份简历；
// 一旦哪个渲染点漏了转义，一个带 <img onerror> 的表单标签或一行恶意简历就能在插件上下文里执行。
// 那等于"填写内容外传"的真实通道，比样式错乱严重得多。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = p => fileURLToPath(new URL(p, import.meta.url));
const html = fs.readFileSync(root('../ui/sidepanel.html'), 'utf8');
const high = JSON.parse(fs.readFileSync(root('../core/high-frequency.json'), 'utf8'));

const PAYLOAD = '<img src=x onerror="window.__pwned=1"><svg onload="window.__pwned=1">';

function boot(handler) {
  const dom = new JSDOM(html, { url: 'chrome-extension://nwtest/ui/sidepanel.html', pretendToBeVisual: true });
  dom.window.CSS = dom.window.CSS || {};
  if (!dom.window.CSS.escape) dom.window.CSS.escape = s => String(s).replace(/([^\w-])/g, '\\$1');
  dom.window.chrome = {
    runtime: {
      getURL: p => 'chrome-extension://nwtest/' + p,
      sendMessage: async msg => handler(msg) || { ok: true, profile: {}, settings: {}, tabId: 1 },
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
  return { dom, doc: dom.window.document };
}

const PROFILE_WITH_PAYLOAD = {
  basics: { name: PAYLOAD, gender: '男' },
  contact: { email: 'a@b.test', phone: PAYLOAD },
  education: [{ school: PAYLOAD, major: '法', enrollDate: '2021-09', gradDate: '2025-06' }],
  work: [], internship: [], projects: [], campus: [], awards: [], competitions: [],
  publications: [], skills: {}, languages: [], certifications: [], intent: {}, others: {},
};

async function load() {
  await import('../ui/sidepanel.js?xss=' + Math.random().toString(36).slice(2));
  await new Promise(r => setTimeout(r, 40));
}

// 只查"动态渲染区"：面板自己的 HTML 里本来就有 <script type="module"> 和图标 <svg>，
// 把整张页面算进去会永远红；真正危险的是站点标签 / 简历取值 / 模型回显被当 markup 解析。
const SINKS = ['#auditStats', '#auditMissing', '#stats', '#results', '#gaps', '#formBody', '#mdDetail', '#aiPreviewText', '#extractResults'];
const injected = doc => SINKS.reduce((n, sel) => n + (doc.querySelector(sel)?.querySelectorAll('img,svg,script,iframe,object').length || 0), 0);

test('恶意简历取值渲染进界面时不会变成可执行节点（体检区 + 编辑表单）', async () => {
  const { dom, doc } = boot(() => ({ ok: true, profile: PROFILE_WITH_PAYLOAD, settings: {}, tabId: 1 }));
  await load();
  assert.equal(dom.window.__pwned, undefined, '扩展页面里执行了注入脚本');
  assert.equal(injected(doc), 0, '界面里出现了注入节点');
  // 转义不等于丢弃：内容还得看得见，否则用户以为资料没了
  assert.match(doc.getElementById('profileText').value || '', /onerror/, '原始取值被吞掉了');
  // 展开表单编辑再查一次：取值进 input.value 是安全路径，进 innerHTML 就不是
  doc.getElementById('btnForm').click();
  await new Promise(r => setTimeout(r, 60));
  assert.equal(injected(doc), 0, '表单编辑区把取值当 markup 解析了');
  assert.equal(dom.window.__pwned, undefined);
  const vals = [...doc.querySelectorAll('#formBody [data-path]')].map(i => i.value).filter(Boolean);
  assert.ok(vals.some(v => /onerror/.test(v)), '编辑框里没带上原值');
});

test('页面标签 / 回读值 / 缺口原因里有 HTML 时也一律当文字', async () => {
  const { dom, doc } = boot(msg => {
    if (msg.type === 'nw:scan') {
      return {
        ok: true,
        adapterId: '', adapterInfo: null,
        data: {
          stats: { scanned: 2, planned: 1, green: 0, review: 1, red: 0, gaps: 1 },
          results: [{
            status: 'review', label: PAYLOAD, path: PAYLOAD, actual: PAYLOAD,
            note: PAYLOAD, failReason: PAYLOAD, score: 0.6, aiChosen: true,
          }],
          gaps: [{ label: PAYLOAD, reason: PAYLOAD, kind: 'text' }],
        },
      };
    }
    return { ok: true, profile: PROFILE_WITH_PAYLOAD, settings: {}, tabId: 1 };
  });
  await load();
  doc.getElementById('btnPreview').click();
  await new Promise(r => setTimeout(r, 60));
  assert.equal(dom.window.__pwned, undefined, '站点标签或回读值在插件页面里执行了脚本');
  assert.equal(injected(doc), 0, '结果/缺口表里出现了注入节点');
  assert.match(doc.getElementById('results').textContent, /onerror/, '内容被吞掉，用户就看不出这栏到底是什么');
});

test('AI 返回的备注与模型原文也不许当 HTML（回显只进 textContent）', async () => {
  const BASE = 'https://api.example.test/v1';
  const emptyProfile = {
    basics: {}, contact: {}, education: [], work: [], internship: [], projects: [], campus: [],
    awards: [], competitions: [], publications: [], skills: {}, languages: [], certifications: [],
    intent: {}, others: {}, records: {}, family: {}, hkGlobal: {}, declaration: {},
  };
  const { dom, doc } = boot(msg => {
    if (msg.type === 'nw:scan') {
      return {
        ok: true, adapterId: '', adapterInfo: null,
        data: {
          stats: { scanned: 1, planned: 0, green: 0, review: 0, red: 0, gaps: 1 },
          results: [],
          gaps: [{ index: 0, label: PAYLOAD, reason: 'no_candidate', kind: 'text' }],
          aiFields: [{ index: 0, label: PAYLOAD }],
        },
      };
    }
    if (msg.type === 'nw:aiAsk') {
      return {
        ok: true,
        candidates: [{ index: 0, path: 'basics.name', label: PAYLOAD }],
        dropped: [{ reason: 'unknown_path', path: PAYLOAD }],
        rawChars: 20, snippet: PAYLOAD, endpoint: BASE,
      };
    }
    if (msg.type === 'nw:aiPreview') return { ok: true, text: PAYLOAD, bytes: 10, asks: 1, endpoint: BASE };
    return {
      ok: true, tabId: 1,
      profile: emptyProfile,
      settings: { aiBaseUrl: BASE, aiModel: 'some-model', aiConsentOrigin: 'https://api.example.test' },
      hasAiKey: true, aiKeyOrigin: 'https://api.example.test', aiKeyPersisted: false, aiKeyLength: 24,
    };
  });
  await load();
  doc.getElementById('btnPreview').click();
  await new Promise(r => setTimeout(r, 60));
  // 配置齐全（合法 https + Key 在同 origin + 勾过确认）时「问 AI」才是可点的
  assert.equal(doc.getElementById('btnAiAsk').disabled, false, '这条测试的前提是 AI 按钮已解锁');
  doc.getElementById('btnAiPreview').click();
  await new Promise(r => setTimeout(r, 40));
  assert.match(doc.getElementById('aiPreviewText').textContent, /onerror/, '预览原文被吞掉');
  doc.getElementById('btnAiAsk').click();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(dom.window.__pwned, undefined, 'AI 回显在插件页面里执行了脚本');
  assert.equal(injected(doc), 0, 'AI 相关渲染区出现了注入节点');
});
