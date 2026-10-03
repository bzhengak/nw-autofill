// S7 补行代理的判据测试。
// 这一层的价值全在"什么时候不许点"：默认关、上限、点了没长出来就停、
// 文字里带删除/提交/上传一律不碰。所以每一条都是反例优先。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  ROW_CAP, planRowExpansion, isAddRowControl, findAddRowButton, addOneRow, expandRows,
  blockContainerFor, sectionsWithAddButton, defaultClick,
} from '../dom/row-adder.js';

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="block">
    <div class="row"><input name="company0"></div>
    <a href="#" class="ant-btn">+ 添加一段实习经历</a>
  </div>
  <div id="bad"><button>删除这一段</button><button>提交</button></div>
  <div id="bare"><span>添加</span></div>
  <div id="outside"><button aria-label="Add another experience">+</button></div>
</body></html>`);
const doc = dom.window.document;
const $ = id => doc.getElementById(id);

test('算术：只对"资料比页面多"那种提示补行，并且每轮有上限', () => {
  const plan = planRowExpansion([
    { kind: 'records_no_room', section: 'internship', have: 4, page: 1 },
    { kind: 'records_missing', section: 'work', have: 1, page: 3 },
    { kind: 'nothing_to_write', section: 'awards', have: 0, page: 0 },
  ]);
  assert.equal(plan.length, 1, JSON.stringify(plan));
  assert.equal(plan[0].section, 'internship');
  assert.equal(plan[0].need, 3);
  assert.equal(plan[0].willTry, 3);
  // 差 10 段也最多点 ROW_CAP 次：剩下的交给人，不在页面上连点十下
  const big = planRowExpansion([{ kind: 'records_no_room', section: 'work', have: 12, page: 1 }]);
  assert.equal(big[0].willTry, ROW_CAP);
  assert.deepEqual(planRowExpansion([{ kind: 'records_no_room', section: 'work', have: 2, page: 2 }]), [], '一样的段数不该补行');
});

test('认加号：文字命中才算，黑名单一票否决，光有文字没有"能点"的样子也不算', () => {
  assert.equal(isAddRowControl(findAddRowButton($('block'))), true);
  assert.equal(isAddRowControl($('bad').children[0]), false, '「删除这一段」长得再像也不点');
  assert.equal(isAddRowControl($('bad').children[1]), false, '「提交」是永不代做的东西');
  assert.equal(isAddRowControl($('bare').firstElementChild), false, '一个没有任何可点迹象的 span 不当它是按钮（宁可少补一段）');
  assert.equal(isAddRowControl($('outside').firstElementChild), true, 'aria-label 写清楚的英文按钮也算');
});

test('只在**这一节**的容器里找加号：别处的加号不许误点', () => {
  const found = findAddRowButton($('block'));
  assert.ok(found && $('block').contains(found));
  assert.ok(!$('outside').contains(found), '把别的容器里的按钮当成了本节的加号');
  assert.equal(findAddRowButton($('bare')), null);
});

test('点了没长出来就停：一次卡住就不再连点，并说清卡在哪', async () => {
  const probe = await addOneRow({ container: $('block'), count: () => 1, click: () => {}, settleMs: 1 });
  assert.equal(probe.ok, false);
  assert.equal(probe.reason, 'stalled');

  let clicks = 0;
  const out = await expandRows({ container: $('block'), count: () => 1, click: () => { clicks++; }, willTry: ROW_CAP, settleMs: 1 });
  assert.equal(out.added, 0);
  assert.equal(out.stalled, true);
  assert.equal(out.why, 'stalled');
  assert.equal(clicks, 1, `第一次没反应还继续点，点了 ${clicks} 次`);
  assert.equal(out.log.length, 1);
});

test('上限真的生效：需要 99 段也只点 ROW_CAP 次', async () => {
  let rows = 1;
  let clicks = 0;
  const out = await expandRows({
    container: $('block'),
    count: () => rows,
    click: () => { clicks++; rows += 1; },
    willTry: 99,
    settleMs: 1,
  });
  assert.equal(clicks, ROW_CAP);
  assert.equal(out.added, ROW_CAP);
  assert.equal(out.stalled, false);
});

test('真 DOM 上能补出行：每次点击插一行，count 跟着长', async () => {
  const host = $('block');
  let rows = host.querySelectorAll('input').length;
  const out = await expandRows({
    container: host,
    count: () => host.querySelectorAll('input').length,
    click: () => {
      const div = doc.createElement('div');
      div.className = 'row';
      const input = doc.createElement('input');
      input.name = `company${++rows}`;
      div.appendChild(input);
      host.insertBefore(div, host.querySelector('a'));
    },
    willTry: 2,
    settleMs: 1,
  });
  assert.equal(out.added, 2);
  assert.equal(host.querySelectorAll('input').length, 3, '说补了两行，DOM 里却没多出来');
  assert.match(host.querySelector('a').textContent, /添加一段/);
});

test('找不到加号就说找不到，不猜别的按钮', async () => {
  const r = await addOneRow({ container: $('bare'), count: () => 1, click: () => { assert.fail('不该有任何点击'); }, settleMs: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_add_button');
});

/** ── 独立审查 2026-10-03（第二轮）：能点错什么按钮 ────────────────── */
test('「添加附件」不是「加一段」：既不被认出来，也不会在同屏竞争里赢', () => {
  const d2 = new JSDOM(`<!doctype html><html><body><div class="ant-form-item">
      <input type="file" id="f">
      <a href="javascript:void(0)" class="add" id="att">添加附件</a>
      <a href="javascript:void(0)" class="ant-btn" id="row">+ 添加一段实习经历</a>
    </div></body></html>`).window.document;
  assert.equal(isAddRowControl(d2.getElementById('att')), false, '附件那一类点了就是替用户传东西（硬边界）');
  assert.equal(findAddRowButton(d2.querySelector('.ant-form-item')), d2.getElementById('row'),
    '「添加」两字的按钮排在了「一段经历」前面');
});

test('黑名单与"必须像加一段"各自独立生效（摘掉任一条都要红）', () => {
  const d3 = new JSDOM(`<!doctype html><html><body>
    <button id="both">添加一段并删除空行</button>
    <button id="plain">点击这里</button>
    <span id="weird" class="add-btn">添加一段</span></body></html>`).window.document;
  assert.equal(isAddRowControl(d3.getElementById('both')), false, '文字里带"删除"就该一票否决（它同时也命中"添加"，所以这条只测黑名单）');
  assert.equal(isAddRowControl(d3.getElementById('plain')), false, '没有"添加/一段"这类字样就不该被当成加号（这条只测必须像加一段）');
  assert.equal(isAddRowControl(d3.getElementById('weird')), true, 'class 里带 add 的 span 是能点的加号');
});

test('会把标签页导航走的 <a> 不算加号：未保存的网申不能丢', () => {
  const d4 = new JSDOM(`<!doctype html><html><body>
    <a href="https://other.example.test/add" class="ant-btn" id="nav">+ 添加一段</a>
    <a href="#add" class="ant-btn" id="hash">+ 添加一段</a></body></html>`).window.document;
  assert.equal(isAddRowControl(d4.getElementById('nav')), false, '这是个会把页面换掉的链接');
  assert.equal(isAddRowControl(d4.getElementById('hash')), true, '锚点型的链接按钮照旧能点');
});

test('容器只认本节：整页共用一个容器时宁可说"找不到"，也不去点页面中间的按钮', () => {
  const d5 = new JSDOM(`<!doctype html><html><body><form>
    <div class="ant-form-item"><label>公司名称</label><input id="only"></div>
    <td class="add-row" id="anywhere">添加</td>
  </form></body></html>`).window.document;
  // 只有一栏时不该往上退成整个 <form>（那等于"整页任何加号都算本节的"）
  assert.equal(blockContainerFor([{ el: d5.getElementById('only') }]), null);
  assert.equal(sectionsWithAddButton([{ el: d5.getElementById('only'), sectionHint: 'work' }]).size, 0);
});

test('sectionsWithAddButton 只认容器里有的那一节，别处的加号不算', () => {
  const d6 = new JSDOM(`<!doctype html><html><body>
    <div id="edu"><div class="fi"><input id="e1"></div><div class="fi"><input id="e2"></div><button id="ea">+ 添加一段</button></div>
    <div id="other"><div class="fi"><input id="o1"></div><div class="fi"><input id="o2"></div><button id="oa">+ 添加一段</button></div>
  </body></html>`).window.document;
  const edu = [d6.getElementById('e1'), d6.getElementById('e2')].map(el => ({ el, sectionHint: 'education' }));
  assert.deepEqual([...sectionsWithAddButton(edu)], ['education'], '教育块里就有一枚加号，却说没有');
  assert.deepEqual([...sectionsWithAddButton([{ el: d6.getElementById('e1'), sectionHint: 'education' }])], [],
    '只有一栏时定不出容器，不该往上够到整页去认加号');
  assert.equal(sectionsWithAddButton([...edu, { el: d6.getElementById('o1'), sectionHint: 'work' }, { el: d6.getElementById('o2'), sectionHint: 'work' }]).size, 2);
  assert.deepEqual([...sectionsWithAddButton([{ el: d6.getElementById('e1'), sectionHint: '' }, { el: d6.getElementById('e2'), sectionHint: '' }])], [],
    '没有板块归属就别报节名（报了也没法补行）');
});

test('真点击前过一遍 safety 的拒绝名单：type=file / 提交文案的控件不点（审查 C1）', async () => {
  let clicked = 0;
  const el = { click: () => { clicked++; }, getAttribute: () => '', tagName: 'BUTTON', textContent: '+ 添加一段', className: 'ant-btn' };
  const blocked = { classifyClick: () => ({ allowed: false, reason: 'file_input' }) };
  assert.equal(defaultClick(el, blocked), false, 'safety 说不许点，还是点了');
  assert.equal(clicked, 0);
  // 没带 safety（老调用方）时行为不变：照常点
  assert.equal(defaultClick(el), true);
  assert.equal(clicked, 1);
});

// 单独引一次，避免上面的 helper 影响其它用例的阅读顺序
function dom2RowAdderDefaultClick(el, safety) {
  if (safety?.classifyClick) {
    const gate = safety.classifyClick(el);
    if (['submit_button', 'file_input', 'navigation'].includes(gate?.reason)) return false;
  }
  el.click();
  return true;
}
