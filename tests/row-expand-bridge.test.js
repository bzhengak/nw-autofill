// S7 补行的装配层测试：真的在 jsdom 里跑 dom/content.js，让"点加号 → 长出新行 → 填上新行"
// 这一整条链走一遍。纯函数测试证明不了这条链 —— 它一半在 DOM 里，一半在扫描器的重扫里。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const PAGE = `<form><div id="intern">
    <h3>实习经历</h3>
    <div class="ant-form-item"><label for="c0">公司名称</label><input id="c0" name="company"></div>
    <div class="ant-form-item"><label for="d0">职责描述</label><input id="d0" name="duty"></div>
    <a id="add" class="ant-btn" href="#">+ 添加一段实习经历</a>
  </div>
  <div class="ant-form-item"><label for="nm">姓名</label><input id="nm" name="name"></div>
</form>`;

const PROFILE = {
  basics: { name: '欧阳测试' },
  internship: [
    { company: '甲科技', summary: '做数据分析' },
    { company: '乙银行', summary: '做风控建模' },
  ],
  certifications: [], education: [], work: [], projects: [], campus: [], awards: [],
  competitions: [], publications: [], skills: {}, languages: [], intent: {}, others: {},
  records: {}, family: {}, hkGlobal: {}, declaration: {},
};

/**
 * @param grow 点一次加号长几行（0 = 这个按钮点了没反应，用来测"停"）
 */
async function boot({ allowAddRows = true, grow = 1, settings = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${PAGE}</body></html>`, { url: 'https://job.example.test/apply', pretendToBeVisual: true });
  const d = dom.window.document;
  let clicks = 0;
  const box = { fn: null };
  const base = import.meta.url;
  d.getElementById('add').addEventListener('click', ev => {
    ev.preventDefault();
    clicks++;
    const n = clicks;
    for (let i = 0; i < grow; i++) {
      const a = d.createElement('div');
      a.className = 'ant-form-item';
      a.innerHTML = `<label for="c${n + i}">公司名称</label><input id="c${n + i}" name="company">`;
      const b = d.createElement('div');
      b.className = 'ant-form-item';
      b.innerHTML = `<label for="d${n + i}">职责描述</label><input id="d${n + i}" name="duty">`;
      d.getElementById('intern').insertBefore(a, d.getElementById('add'));
      d.getElementById('intern').insertBefore(b, d.getElementById('add'));
    }
  });
  globalThis.window = dom.window;
  globalThis.document = d;
  globalThis.location = dom.window.location;
  globalThis.CSS = Object.assign(dom.window.CSS || {}, { escape: s => String(s).replace(/([^\w-])/g, '\\$1') });
  globalThis.navigator = dom.window.navigator;
  globalThis.chrome = {
    runtime: {
      getURL: p => new URL(p, new URL('../', base)).href,
      onMessage: { addListener: fn => { box.fn = fn; } },
      sendMessage: async msg => (msg?.type === 'nw:ledgerGet' ? { ok: true, ledger: {} } : { ok: true }),
    },
    storage: { local: { get: async keys => { const out = {}; for (const k of [].concat(keys)) out[k] = k === 'profile' ? PROFILE : { allowAddRows, ...settings }; return out; } } },
  };
  await import('../dom/content.js?run=' + Math.random().toString(36).slice(2));
  const scan = (extra = {}) => new Promise(resolve => box.fn({ type: 'nw:scan', tabId: 1, mode: 'full', dryRun: false, ...extra }, {}, resolve));
  return { scan, d, clicks: () => clicks };
}

const val = (d, id) => d.getElementById(id)?.value ?? null;

test('勾了允许补行：写的那一跳点一次加号，新行按资料第二段填上', async () => {
  const { scan, d, clicks } = await boot({});
  const res = await scan();
  assert.equal(res?.ok, true, JSON.stringify(res));
  assert.equal(clicks(), 1, `没点或多点：${clicks()}`);
  assert.equal(res.data.rowExpansion?.[0]?.section, 'internship', JSON.stringify(res.data.rowExpansion));
  assert.equal(res.data.rowExpansion[0].added, 1);
  // 补出来的那一行必须真的被写上，并且写的是第二段
  assert.equal(val(d, 'c1'), '乙银行', `新行没拿到第二段经历：c1=${val(d, 'c1')} c0=${val(d, 'c0')}`);
  assert.equal(val(d, 'd1'), '做风控建模');
  assert.equal(val(d, 'c0'), '甲科技', '原有那一行被写坏了');
  // 计划是按"补行之后的页面"重排的（两行都进计划）
  assert.ok(res.data.stats.scanned >= 5, `重扫后的栏位数不对：${res.data.stats.scanned}`);
});

test('只预演不补行：一个点击都不发', async () => {
  const { scan, clicks } = await boot({});
  const res = await scan({ mode: 'preview', dryRun: true });
  assert.equal(clicks(), 0, '预览阶段就点了页面上的加号');
  assert.deepEqual(res.data.rowExpansion, [], '没补行却报告补了');
});

test('没勾「允许补经历行」：段数不够也不许点', async () => {
  const { scan, d, clicks } = await boot({ allowAddRows: false });
  const res = await scan();
  assert.equal(clicks(), 0);
  assert.equal(val(d, 'c1'), null, '没授权却把行补出来了');
  const warn = res.data.planCheck.warnings.find(w => w.kind === 'records_no_room');
  assert.ok(warn, '段数不够这一条要说出来，否则用户不知道后面几段为什么空着');
  assert.match(warn.action, /允许补经历行|填写授权/, '要指到那条开关上去：' + warn.action);
});

test('点了没长出来就停：一次之后不再连点，其余栏照旧写', async () => {
  const { scan, d, clicks } = await boot({ grow: 0 });
  const res = await scan();
  assert.equal(clicks(), 1, `按钮没有反应却还在连点：${clicks()}`);
  assert.equal(res.data.rowExpansion[0].stalled, true);
  assert.equal(res.data.rowExpansion[0].why, 'stalled');
  assert.equal(val(d, 'c0'), '甲科技', '补行失败不该影响本来能写的那些栏');
});

test('dryRun 单独也要挡住补行：mode=full 但 dryRun=true 时一个点击都不发', async () => {
  // 面板现在发的是 mode=preview+dryRun=true，两个条件同时成立；
  // 少了这一条，把 !dryRun 摘掉也不会红 —— 那就是"点了页面上的按钮"这种事没被钉住。
  const { scan, clicks } = await boot({});
  const res = await scan({ mode: 'full', dryRun: true });
  assert.equal(clicks(), 0, 'dryRun 还在点页面控件');
  assert.equal(res.data.rowExpansion.length, 0);
  assert.equal(res.data.stats.planned >= 1, true, '预演仍然要算出计划，只是不落笔');
});
