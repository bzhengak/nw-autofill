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
