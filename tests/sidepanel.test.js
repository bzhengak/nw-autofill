// 侧边栏冒烟测试：把真实 HTML + 真实 sidepanel.js 装进 jsdom，用假的 chrome API 走一遍
// 「体检 → 点开缺口 → 改值 → 保存」这条链路。不追求覆盖样式，只求别把明显的
// 空 id、拼错的选择器、保存丢字段这类问题留到你手动验证时才发现。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path => fileURLToPath(new URL(path, import.meta.url));
const html = fs.readFileSync(root('../ui/sidepanel.html'), 'utf8');
const high = JSON.parse(fs.readFileSync(root('../core/high-frequency.json'), 'utf8'));
const { createEmptyProfile, getValueByPath } = await import('../core/profile-schema.js');

function boot(profile) {
  const dom = new JSDOM(html, { url: 'chrome-extension://nwtest/ui/sidepanel.html', pretendToBeVisual: true });
  const sent = [];
  dom.window.CSS = dom.window.CSS || {};
  if (!dom.window.CSS.escape) dom.window.CSS.escape = s => String(s).replace(/([^\w-])/g, '\\$1');
  dom.window.chrome = {
    runtime: {
      getURL: p => 'chrome-extension://nwtest/' + p,
      sendMessage: async msg => { sent.push(msg); return { ok: true, profile, settings: {}, tabId: 1 }; },
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
  // 每次换个 URL 让模块重新求值（Node 会缓存同 specifier 的 ESM）
  const url = '../ui/sidepanel.js?run=' + Math.random().toString(36).slice(2);
  await import(url);
}

test('体检区渲染出填写率与高频缺口', async () => {
  const { doc } = boot(null);
  await loadSidePanel();
  await new Promise(r => setTimeout(r, 30));
  assert.match(doc.getElementById('auditStats').textContent, /已填/);
  assert.match(doc.getElementById('auditStats').textContent, /高频缺口/);
  assert.ok(doc.getElementById('auditMissing').querySelectorAll('tr').length > 5, '空资料应列出一堆高频缺口');
  assert.match(doc.getElementById('auditAdvice').textContent, /优先补/);
});

test('点开缺口行会展开表单并聚焦到对应输入框', async () => {
  const { doc } = boot(null);
  await loadSidePanel();
  await new Promise(r => setTimeout(r, 30));
  doc.getElementById('auditMissing').querySelector('tr').dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.getElementById('formEditor').style.display, 'block');
  const inputs = doc.getElementById('formBody').querySelectorAll('[data-path]');
  assert.ok(inputs.length > 10, '表单没渲染出输入框');
  assert.ok(doc.activeElement && doc.activeElement.dataset.path, '应聚焦到某个字段');
});

test('改值后保存：写回的 profile 带上新值，且没渲染出来的槽位不丢', async () => {
  const { doc, sent } = boot(createEmptyProfile());
  await loadSidePanel();
  await new Promise(r => setTimeout(r, 30));
  doc.getElementById('btnForm').dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  const box = doc.getElementById('formBody').querySelector('[data-path="basics.name"]');
  assert.ok(box, '表单里应有姓名输入框');
  box.value = '李雷';
  doc.getElementById('btnFormSave').dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 40));
  const saved = sent.filter(m => m.type === 'nw:saveProfile').pop();
  assert.ok(saved, '没发出保存消息');
  assert.equal(getValueByPath(saved.profile, 'basics.name'), '李雷');
  assert.ok(saved.profile.education && saved.profile.education.length === 4, '保存不得把没渲染出来的分组裁掉');
});

test('「解析并填入」必须连 storage 一起写：只填文本框等于没导入', async () => {
  const { doc, sent } = boot(createEmptyProfile());
  await loadSidePanel();
  await new Promise(r => setTimeout(r, 30));
  doc.getElementById('mdText').value = fs.readFileSync(root('../tests/fixtures/dev-resume.md'), 'utf8');
  doc.getElementById('btnImportMd').dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  const saved = sent.filter(m => m.type === 'nw:saveProfile').pop();
  assert.ok(saved, '点导入却没发出保存消息 —— 用户看到的"识别不到字段"就是这么来的');
  assert.equal(getValueByPath(saved.profile, 'basics.name'), '李望舒');
  assert.equal(getValueByPath(saved.profile, 'family.0.relation'), '父亲');
  assert.match(doc.getElementById('mdReport').textContent, /保存/);
});

test('「只看没填的」切换不会炸，且全是空值行', async () => {
  const { doc } = boot(null);
  await loadSidePanel();
  await new Promise(r => setTimeout(r, 30));
  doc.getElementById('btnForm').dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  const only = doc.getElementById('onlyEmpty');
  only.checked = true;
  only.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  const rows = [...doc.getElementById('formBody').querySelectorAll('[data-path]')];
  assert.ok(rows.length > 0);
  assert.ok(rows.every(el => !String(el.value).trim()), '「只看没填的」不该还留着有值的行');
});

test('Key 卫生：录一次就擦掉输入框，只有 saveAiKey 能带它走，界面不回显', async () => {
  const SECRET = 'sk-abcdefghijklmnop1234567890';
  const { dom, doc, sent } = boot(null);
  dom.window.chrome.runtime.sendMessage = async msg => {
    sent.push(msg);
    if (msg.type === 'nw:saveAiKey') return { ok: true, hasAiKey: true, length: String(msg.key || '').length, boundOrigin: 'https://api.openai.com', secure: true };
    return { ok: true, profile: null, settings: {}, tabId: 1 };
  };
  await loadSidePanel();
  await new Promise(r => setTimeout(r, 30));

  doc.getElementById('aiBaseUrl').value = 'https://api.openai.com/v1';
  doc.getElementById('aiModel').value = 'gpt-4o-mini';
  doc.getElementById('aiKey').value = SECRET;
  doc.getElementById('btnSaveKey').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 30));

  assert.equal(doc.getElementById('aiKey').value, '', '保存后输入框必须清空，不能把 Key 留在 DOM 里');
  assert.ok(!doc.body.innerHTML.includes(SECRET), 'Key 的任何一个字符都不该出现在页面上');
  const carriers = sent.filter(m => JSON.stringify(m).includes(SECRET));
  assert.deepEqual(carriers.map(m => m.type), ['nw:saveAiKey'], '除了 saveAiKey，任何消息都不许携带 Key');
  assert.ok(!sent.some(m => m.type === 'nw:saveSettings' && JSON.stringify(m.settings || {}).includes(SECRET)),
    'saveSettings 里出现了 Key —— 那会随导出 JSON 离开本机');

  // 没勾"确认发往这个地址"之前，问 AI 的按钮必须是死的
  doc.getElementById('aiConsent').checked = false;
  doc.getElementById('aiConsent').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(doc.getElementById('btnAiAsk').disabled, true, '未确认收件人就不该发得出 Key');
});

test('Base URL 非法时不保存、不确认、也发不出去', async () => {
  const { dom, doc, sent } = boot(null);
  await loadSidePanel();
  await new Promise(r => setTimeout(r, 30));
  doc.getElementById('aiBaseUrl').value = 'http://api.example.com/v1';   // 明文 http
  doc.getElementById('aiBaseUrl').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  doc.getElementById('aiBaseUrl').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  assert.ok(!sent.some(m => m.type === 'nw:saveSettings' && m.settings?.aiBaseUrl), '不合法的端点不该被存下来');
  assert.match(doc.getElementById('aiStatus').textContent, /https/, '要告诉用户为什么被拒');
  assert.match(doc.getElementById('aiConsentTarget').textContent, /https/, '确认行也要显示同一个原因');
});
