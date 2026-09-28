// 写入层的"假绿"回归：这一组钉的是"报成功但实际填错"的最坏失败模式。
// 上游社区项目栽过的地方：整组勾满、跨区块同名控件被一起改、站点渲染值 ≠ 我们写的值仍报绿。
// 注意 applyPlan 的 assignment.index 是"完整扫描结果里的下标"，所以这里一律不先过滤 fields。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { applyPlan } from '../dom/filler.js';
import { scanForm } from '../dom/scanner.js';

function dom(html) {
  const d = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://example.test/apply', pretendToBeVisual: true });
  return { d, doc: d.window.document };
}
const fieldsOf = doc => scanForm(doc);
const fieldFor = (fields, el) => fields.find(f => f.el === el);
const entry = (index, over = {}) => ({ index, path: 'x.y', label: 'L', value: '男', tier: 'auto', ...over });
const okOf = r => (r ? (r.ok ?? r.status === 'green') : false);

test('选项标签为空时不许"整组勾满"，宁可报失败', async () => {
  const { doc } = dom(`<form><input type="checkbox" name="agree"><input type="checkbox" name="agree"></form>`);
  const fields = fieldsOf(doc);
  const boxes = [...doc.querySelectorAll('input[name="agree"]')];
  const f = fieldFor(fields, boxes[0]) || fieldFor(fields, boxes[1]);
  assert.ok(f, '扫描没抓到 checkbox 组');
  const { results } = await applyPlan(fields, [entry(fields.indexOf(f), { optionValue: '男' })], {});
  const r = results.find(x => x.index === fields.indexOf(f));
  assert.ok(r, '没有回读结果');
  assert.equal(okOf(r), false, '空标签不能算写成功');
  assert.ok(boxes.every(b => !b.checked), '空标签时一个都不该被勾');
});

test('选项集合只在同一个 form 内取：跨表单同名控件不被牵连', async () => {
  const { doc } = dom(`
    <form id="a"><label><input type="checkbox" name="hobby" value="read">阅读</label><label><input type="checkbox" name="hobby" value="run">跑步</label></form>
    <form id="b"><label><input type="checkbox" name="hobby" value="read">阅读</label><label><input type="checkbox" name="hobby" value="run">跑步</label></form>`);
  const fields = fieldsOf(doc);
  const aRead = doc.querySelector('#a input[value="read"]');
  const f = fieldFor(fields, aRead);
  assert.ok(f, '扫描没抓到 a 表单的 checkbox 组');
  await applyPlan(fields, [entry(fields.indexOf(f), { optionValue: '阅读' })], {});
  assert.equal(aRead.checked, true, '目标项该被勾上');
  assert.equal(doc.querySelector('#a input[value="run"]').checked, false, '同表单里不该被顺带勾上');
  assert.equal(doc.querySelector('#b input[value="read"]').checked, false, '另一个表单里的同名控件不该被改');
});

test('回读比对渲染值：站点把 20000 显示成 20000-30000 不算写成功', async () => {
  const { doc } = dom(`<form><input type="text" name="salary"></form>`);
  const el = doc.querySelector('input[name="salary"]');
  let inner = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: () => (inner ? `${inner}-30000` : ''),
    set: v => { inner = v; },
  });
  const fields = fieldsOf(doc);
  const { results } = await applyPlan(fields, [entry(0, { value: '20000', path: 'work.0.salary' })], {});
  assert.equal(okOf(results[0]), false, '渲染值和意图不一致必须报失败');
});

test('maxlength 截断要说明原因，不能静默当成功', async () => {
  const { doc } = dom(`<form><input type="text" name="addr" maxlength="6"></form>`);
  const fields = fieldsOf(doc);
  const { results } = await applyPlan(fields, [entry(0, { value: '南京市鼓楼区汉口路22号' })], {});
  assert.equal(okOf(results[0]), false);
  assert.equal(results[0].reason || results[0].failReason, 'truncated_by_maxlength');
});

test('单选组正常形态：命中正确选项并回读到可见文本', async () => {
  const { doc } = dom(`<form><label><input type="radio" name="g" value="M">男</label><label><input type="radio" name="g" value="F">女</label></form>`);
  const fields = fieldsOf(doc);
  const m = doc.querySelector('input[value="M"]');
  const f = fieldFor(fields, m) || fields.find(x => x.kind === 'radio');
  assert.ok(f, '扫描没抓到 radio 组');
  const { results } = await applyPlan(fields, [entry(fields.indexOf(f), { optionValue: '男' })], {});
  const r = results.find(x => x.index === fields.indexOf(f));
  assert.equal(okOf(r), true, '正常形态必须成功，别把护栏做成全拒');
  assert.equal(m.checked, true);
  assert.equal(doc.querySelector('input[value="F"]').checked, false);
});

test('回滚只撤销扩展改过的部分：站点/用户原有的勾选必须还在', async () => {
  const { doc } = dom(`
    <form>
      <label><input type="checkbox" name="h" value="read" checked>阅读</label>
      <label><input type="checkbox" name="h" value="run">跑步</label>
      <label><input type="checkbox" name="h" value="code">编程</label>
    </form>`);
  const fields = fieldsOf(doc);
  const code = doc.querySelector('input[value="code"]');
  const f = fieldFor(fields, code) || fields.find(x => x.kind === 'checkbox');
  const idx = fields.indexOf(f);
  const applied = await applyPlan(fields, [entry(idx, { optionValue: '编程' })], {});
  assert.equal(code.checked, true, '先确认写入了');
  const res = await applied.undo();
  assert.equal(res.ok, true);
  assert.equal(doc.querySelector('input[value="read"]').checked, true, '原来就勾着的不能被抹掉');
  assert.equal(code.checked, false, '扩展勾上的那个必须撤掉');
  assert.equal(doc.querySelector('input[value="run"]').checked, false);
});

test('下拉的 option 是码值时（value="2" 共青团员）选对就算成功，不能拿码值去比可见文本', async () => {
  const { doc } = dom(`<form><select name="zzmm">
      <option value="">请选择</option><option value="1">中共党员</option><option value="2">共青团员</option>
    </select></form>`);
  const fields = fieldsOf(doc);
  const r = await applyPlan(fields, [entry(0, { value: '共青团员', optionValue: '2' })], {});
  assert.equal(r.results[0].status, 'green', `以前这里报红：可见文本"共青团员"永远不等于码值"2"（${r.results[0].failReason}）`);
  assert.equal(r.results[0].actual, '共青团员', '报表要显示用户看得见的文本');
});

test('站点把选择改回去时必须报红（受控组件回滚检测）', async () => {
  const { doc } = dom(`<form><select name="ctl">
      <option value="">请选择</option><option value="a">甲</option><option value="b">乙</option>
    </select></form>`);
  const el = doc.querySelector('select');
  el.addEventListener('change', () => { el.selectedIndex = 0; });   // 模拟受控组件把值改回去
  const fields = fieldsOf(doc);
  const r = await applyPlan(fields, [entry(0, { value: '乙', optionValue: 'b' })], {});
  assert.equal(r.results[0].status, 'red');
  assert.equal(r.results[0].failReason, 'selection_reverted');
});

test('计划阶段就知道选项对不上 → 需人工（橙），不是填错了（红）', async () => {
  const { doc } = dom(`<form><select name="ft">
      <option value="">请选择</option><option value="1">全日制</option><option value="2">非全日制</option>
    </select></form>`);
  const fields = fieldsOf(doc);
  const r = await applyPlan(fields, [entry(0, { value: '全日制在职', tier: 'review', needsChoice: true })], {});
  assert.equal(r.results[0].status, 'manual', '这一栏得用户亲手表态，报红会把注意力从真错上引开');
  assert.equal(String(doc.querySelector('select').value), '', '不能顺手替用户选一个');
});

test('单选按码值命中（value="M"）也要报绿：写入口径与回读口径必须一致', async () => {
  const { doc } = dom(`<form>
      <label><input type="radio" name="xb" value="M"> 男</label>
      <label><input type="radio" name="xb" value="F"> 女</label>
    </form>`);
  const fields = fieldsOf(doc);
  const idx = fields.indexOf(fields.find(f => f.kind === 'radio'));
  const r = await applyPlan(fields, [entry(idx, { value: '男', optionValue: 'M' })], {});
  assert.equal(r.results[0].status, 'green', `按 value 勾上、却按可见文本验收 = 假红（${r.results[0].failReason}）`);
  assert.equal(doc.querySelector('input[value="M"]').checked, true);
  assert.equal(doc.querySelector('input[value="F"]').checked, false);
});
