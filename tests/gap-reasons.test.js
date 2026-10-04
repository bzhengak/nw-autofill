// 缺口原因要说人话：状态表里直接印 `custom_control` 这种内部 token，
// 用户看到只知道"没填上"，不知道下一步该做什么。这里做一次映射，
// 同时把原始 token 留在 title 里 —— 报 bug 时那两个字符串对得上，比截图好用。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { gapReasonLabel, GAP_REASON_ZH } from '../core/matcher.js';

const root = p => fileURLToPath(new URL(p, import.meta.url));
const html = fs.readFileSync(root('../ui/sidepanel.html'), 'utf8');
const high = JSON.parse(fs.readFileSync(root('../core/high-frequency.json'), 'utf8'));

test('每一条缺口原因都有中文说明，且带"下一步做什么"', () => {
  const reasons = ['file', 'custom_control', 'composite_date', 'credential', 'captcha', 'no_candidate',
    'required_no_candidate', 'conflict_unresolved', 'site_search', 'readonly_control', 'date_picker',
    'consent_declaration', 'declaration', 'conditional_other', 'optional_link', 'subjective',
    'sensitive_withheld', 'ai_empty_slot', 'choice_required'];
  for (const r of reasons) {
    const text = gapReasonLabel(r);
    assert.notEqual(text, r, `${r} 没有中文映射，表格里会直接印内部 token`);
    assert.ok(text.length >= 6 && /[，—]/.test(text), `${r} 的说明太短或没给下一步：${text}`);
  }
  assert.equal(gapReasonLabel('brand_new_token'), 'brand_new_token', '未知原因要原样露出来，不能编一句好听的');
  assert.ok(Object.keys(GAP_REASON_ZH).length >= reasons.length);
});

test('侧边栏缺口表把原因译成中文，原始 token 留在 title 里便于报障', async () => {
  const dom = new JSDOM(html, { url: 'chrome-extension://nwtest/ui/sidepanel.html', pretendToBeVisual: true });
  dom.window.CSS = dom.window.CSS || {};
  dom.window.CSS.escape = s => String(s).replace(/([^\w-])/g, '\\$1');
  dom.window.chrome = {
    runtime: {
      getURL: p => 'chrome-extension://nwtest/' + p,
      sendMessage: async msg => {
        if (msg.type === 'nw:scan') {
          return {
            ok: true, adapterId: '', adapterInfo: null,
            data: {
              stats: { scanned: 3, planned: 0, green: 0, review: 0, red: 0, gaps: 3 },
              results: [],
              gaps: [
                { label: '简历/成绩单', reason: 'file', kind: 'file' },
                { label: '开始时间', reason: 'readonly_control', kind: 'text' },
                { label: '请输入职位或企业名称', reason: 'site_search', kind: 'text' },
              ],
              aiFields: [],
            },
          };
        }
        return { ok: true, profile: {}, settings: {}, tabId: 1 };
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
  await import('../ui/sidepanel.js?reason=' + Math.random().toString(36).slice(2));
  await new Promise(r => setTimeout(r, 40));
  dom.window.document.getElementById('btnPreview').click();
  await new Promise(r => setTimeout(r, 60));

  const text = dom.window.document.getElementById('gaps').textContent;
  assert.match(text, /附件/, 'file 没翻译成人话');
  assert.match(text, /只读|自动推导/, 'readonly_control 没翻译');
  assert.match(text, /搜索框/, 'site_search 没翻译');
  assert.ok(!/custom_control|readonly_control|site_search/.test(text), '表格里还在直接印内部 token');
  // 原始 token 得留着，否则用户报"某栏没填上"时我们无法知道是哪条规则拦的
  const titles = [...dom.window.document.querySelectorAll('#gaps td')].map(td => td.title).filter(Boolean);
  assert.ok(titles.some(t => /site_search/.test(t)), 'title 里没有原始 reason，报障对不上号');
});
