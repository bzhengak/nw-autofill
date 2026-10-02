// 内容脚本的消息层要"真跑一次"。
// 为什么单独开这个文件：dom/content.js 里的模块是 chrome.runtime.getURL 动态 import 进来的，
// 静态检查看不出"用了没解构的变量"这一类错误 —— 用户实测点「导出没填的字段与选项」拿到的
// `build is not defined` 就是这么漏出去的：分支里写 build.BUILD，解构里却没有 build。
// 这里把 getURL 指回仓库里的真实文件，在 jsdom 里把消息处理函数跑起来，ReferenceError 当场就红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const PAGE = `<div class="text-muted">
  <span class="field-label">*Name</span>
  <span class="field-value field-editor"><form class="ant-form"><div class="ant-row ant-form-item">
    <span class="ant-form-item-children"><input type="text" data-nw-test="name"></span></div></form></span>
  <span class="field-label">IELTS Score</span>
  <span class="field-value field-editor"><form class="ant-form"><div class="ant-row ant-form-item">
    <span class="ant-form-item-children"><input type="text" data-nw-test="ielts"></span></div></form></span>
</div>`;

async function boot(profile) {
  const dom = new JSDOM(`<!doctype html><html><body>${PAGE}</body></html>`, { url: 'https://careersite.tupu360.com/accentureats/resume/applicationView', pretendToBeVisual: true });
  const listenerBox = { fn: null };
  const base = import.meta.url;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.CSS = dom.window.CSS && dom.window.CSS.escape ? dom.window.CSS : Object.assign(dom.window.CSS || {}, { escape: s => String(s).replace(/([^\w-])/g, '\\$1') });
  globalThis.navigator = dom.window.navigator;
  globalThis.chrome = {
    runtime: {
      // 把扩展资源路径指回仓库文件：动态 import 才跑得起来（浏览器里这一步由 Chrome 完成）
      getURL: p => new URL(p, new URL('../', base)).href,
      onMessage: { addListener: fn => { listenerBox.fn = fn; } },
      sendMessage: async () => ({ ok: true }),
    },
    storage: { local: { get: async keys => { const out = {}; for (const k of [].concat(keys)) out[k] = k === 'profile' ? profile : {}; return out; } } },
  };
  await import('../dom/content.js?run=' + Math.random().toString(36).slice(2));
  const send = msg => new Promise(resolve => listenerBox.fn(msg, {}, resolve));
  return { send, dom };
}

test('nw:unfilledMap 真的能跑完并返回对照表（以前这里是 ReferenceError）', async () => {
  const { send } = await boot({ basics: { name: '' } });
  const res = await send({ type: 'nw:unfilledMap', tabId: 1 });
  assert.equal(res?.ok, true, `没跑通：${JSON.stringify(res)}`);
  assert.ok(res.data && Array.isArray(res.data.rows), '回包里没有 rows');
  assert.match(res.data.build, /^\d{4}-\d{2}-\d{2}-\d+$/, 'build 必须是 core/build.js 里那个号');
  assert.ok(res.data.rows.length > 0, '这一页有两个字段，导出却是空的');
  // 只读：这条链路一个字节都不该改页面
  for (const el of ['name', 'ielts']) {
    const box = globalThis.document.querySelector(`[data-nw-test="${el}"]`);
    assert.equal(box.value, '', `导出这一步把值写进页面了：${el}`);
  }
});

test('nw:probe 与 nw:ping 也在同一套桩里跑得动（消息层不能只有面板那半边有测试）', async () => {
  const { send } = await boot({ basics: { name: '张伟' } });
  const probe = await send({ type: 'nw:probe', tabId: 1 });
  assert.equal(probe?.ok, true);
  assert.equal(typeof probe.data.totals.controls, 'number');
  const ping = await send({ type: 'nw:ping', tabId: 1 });
  assert.equal(ping?.ok, true);
});
