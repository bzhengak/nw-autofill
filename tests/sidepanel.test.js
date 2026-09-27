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
