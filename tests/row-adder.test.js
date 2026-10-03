// S7 补行代理的判据测试。
// 这一层的价值全在"什么时候不许点"：默认关、上限、点了没长出来就停、
// 文字里带删除/提交/上传一律不碰。所以每一条都是反例优先。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  ROW_CAP, planRowExpansion, isAddRowControl, findAddRowButton, addOneRow, expandRows,
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
