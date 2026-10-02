// 台账消息层的集成测：把真的 background/service-worker.js 跑起来，用假 chrome 走一遍
// 「内容脚本记账 → 扫描取账 → 撤销擦账」。
//
// 为什么要单独一层：纯函数测（tests/ledger.test.js）证明"算得对"，
// 但 S1 的三条新消息如果后台没接、或 origin 判定写歪，面板只会得到一句 unknown_message ——
// 这个坑本仓库踩过两次（nw:unfilledMap、自检），都只有真跑 SW 才照得出来。

import { test } from 'node:test';
import assert from 'node:assert/strict';

const PAGE_URL = 'https://careersite.tupu360.com/accentureats/resume/applicationView';

function makeChrome() {
  const local = {};
  const session = {};
  const store = bag => ({
    get: async k => {
      if (typeof k === 'string') return { [k]: bag[k] };
      if (Array.isArray(k)) return Object.fromEntries(k.map(x => [x, bag[x]]));
      return { ...bag };
    },
    set: async obj => Object.assign(bag, obj),
    remove: async keys => (Array.isArray(keys) ? keys : [keys]).forEach(x => delete bag[x]),
  });
  const listeners = [];
  return {
    local, session, listeners,
    runtime: {
      id: 'nwtest',
      getURL: p => 'chrome-extension://nwtest/' + p,
      onMessage: { addListener: fn => listeners.push(fn) },
      onInstalled: { addListener() {} },
      sendMessage: async () => ({ ok: true }),
    },
    action: { onClicked: { addListener() {} } },
    storage: { local: store(local), session: store(session) },
    tabs: { query: async () => [{ id: 1 }], get: async id => ({ id, url: PAGE_URL }), create() {}, sendMessage: async () => ({ ok: true }) },
    webNavigation: { getAllFrames: async () => [] },
  };
}

/** 起一次真 SW；send 允许指定 sender（台账的 origin 只认 sender.tab，这是它的安全边界） */
async function bootSw() {
  const chrome = makeChrome();
  globalThis.chrome = chrome;
  await import('../background/service-worker.js?ledger=' + Math.random().toString(36).slice(2));
  const send = (msg, sender = { tab: { id: 1, url: PAGE_URL }, frameId: 0 }) =>
    new Promise(resolve => chrome.listeners[0](msg, sender, resolve));
  return { chrome, send };
}

test('三条台账消息后台真的接得住：不是 unknown_message', async () => {
  const { chrome, send } = await bootSw();
  const got = await send({ type: 'nw:ledgerGet' });
  assert.ok(got?.ok, `台账读取失败：${JSON.stringify(got)}`);
  assert.equal(got.error, undefined);
  assert.deepEqual(Object.keys(got.ledger), ['https://careersite.tupu360.com'],
    '只回本 origin 那一桶（桶形状就是 {origin: {指纹: 记录}}）');
  assert.deepEqual(got.ledger['https://careersite.tupu360.com'], {}, '新实例该是空账本');

  const saved = await send({
    type: 'nw:ledgerSave',
    entries: [{ fp: 'abc', path: 'basics.name', valueHash: '5:x', build: 'test' }],
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.count, 1, '记一笔没进账本');
  assert.ok(chrome.local.nwFillLedger, '台账必须落在独立顶层桶（不是 settings：settings 会被导出 JSON 带走）');
  assert.ok(!('nwFillLedger' in (chrome.local.settings || {})), '台账不许混进 settings');

  const again = await send({ type: 'nw:ledgerGet' });
  assert.deepEqual(Object.keys(again.ledger), ['https://careersite.tupu360.com'],
    '只回本站点那一桶，别把投过的其它站点一起交给内容脚本');
  assert.ok(again.ledger['https://careersite.tupu360.com'].abc, '按 origin 分桶后仍读得到那条');

  const forgot = await send({ type: 'nw:ledgerForget', fps: ['abc'] });
  assert.equal(forgot.ok, true);
  assert.equal(forgot.count, 0, '撤销后这条账要真的擦掉');
});

test('origin 只信 sender.tab：自报的、以及认不出站点的都拒收', async () => {
  const { send } = await bootSw();
  const noTab = await send({ type: 'nw:ledgerSave', entries: [{ fp: 'a', path: 'basics.name', valueHash: '1:x' }] },
    { frameId: 0 });                      // 面板自己发的消息：没有 tab
  assert.equal(noTab.ok, false, '没有页面来源也允许记账，等于任何页面都能伪造归属');
  assert.equal(noTab.error, 'no_origin');

  const chromePage = await send(
    { type: 'nw:ledgerSave', entries: [{ fp: 'a', path: 'basics.name', valueHash: '1:x' }] },
    { tab: { id: 2, url: 'chrome://extensions' }, frameId: 0 });
  assert.equal(chromePage.error, 'no_origin', '非 http(s) 页面不该有台账');

  const otherSite = await send({ type: 'nw:ledgerGet' }, { tab: { id: 3, url: 'https://other.test/x' }, frameId: 0 });
  assert.deepEqual(otherSite.ledger, { 'https://other.test': {} }, 'A 站的写入不能让 B 站读到（分桶必须按 origin 隔离）');
});

test('子框架（广告/统计 iframe）仍然一概不接', async () => {
  const { send } = await bootSw();
  const sub = await send({ type: 'nw:ledgerGet' }, { tab: { id: 1, url: PAGE_URL }, frameId: 3 });
  assert.equal(sub.error, 'frame_denied', '台账不该成为子框架读整页归属信息的新通道');
});
