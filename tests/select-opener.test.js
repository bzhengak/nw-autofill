// 自定义下拉的点开/选中回归。这里钉的是"我们真的动了页面"之后的最坏情况：
//   点了却没选中却报绿、点错选项（全日制 vs 非全日制）、点到提交/导航按钮、
//   以及最要紧的一条 —— 用户没授权时一个点击都不许发生。
// 仿真表单里的内联 JS 复刻了 Element UI / AntD 的行为（mousedown 展开、选项渲染到 body 末端、
// 选中后回写显示值）。真实站点的实测仍需用户在浏览器里验证，这里保证链路不回归。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { scanForm } from '../dom/scanner.js';
import { applyPlan } from '../dom/filler.js';
import { planFill } from '../core/matcher.js';
import { pickCustomSelect, detectSelectLibraries, isCustomSelect, matchOption } from '../dom/select-opener.js';
import { classifyClick } from '../dom/safety.js';
import { sampleProfile } from './fixtures/sample-profile.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function liveForm(file) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'test-forms', file), 'utf8'), {
    url: 'https://example.test/apply', runScripts: 'dangerously', pretendToBeVisual: true,
  });
  const doc = dom.window.document;
  const clicks = [];
  // 记录页面上发生过的所有真实点击，用来断言"提交/导航按钮从未被点"
  doc.addEventListener('click', e => {
    const el = e.target.closest?.('[data-nw-test]');
    if (el) clicks.push(el.getAttribute('data-nw-test'));
  }, true);
  return { dom, doc, clicks };
}

test('仿真 Element UI 页面：识别出 4 个自定义控件，未授权时一个都不点', async () => {
  const { doc, clicks } = liveForm('element-cn.html');
  const fields = scanForm(doc);
  assert.deepEqual(detectSelectLibraries(doc).map(s => s.name).filter(n => n === 'element-ui').length, 1, '框架签名要认得出 Element UI');
  assert.equal(fields.filter(isCustomSelect).length, 5, '5 个 el-select 都应被认成自定义控件');

  const plan = planFill(fields, sampleProfile(), { mode: 'full', fillSensitive: true });
  await applyPlan(fields, plan.assignments, {});            // 默认：未授权
  assert.equal(clicks.length, 0, '没授权就不该点页面任何控件 —— 这条比命中率重要');
  assert.ok(plan.gaps.every(g => g.reason !== 'no_candidate'), '自定义下拉在计划阶段仍归 custom_control');
});

test('授权后：点开 → 匹配 → 选中 → 回读，且结果只能是黄字', async () => {
  const { doc, clicks } = liveForm('element-cn.html');
  const fields = scanForm(doc);
  const plan = planFill(fields, sampleProfile(), { mode: 'full', fillSensitive: true, allowCustomSelect: true });
  const custom = plan.assignments.filter(a => a.customSelect);
  assert.ok(custom.length >= 3, `授权后至少 3 栏自定义下拉该进入计划，实得 ${custom.length}`);
  assert.ok(custom.every(a => a.tier === 'review'), '真实点击过的栏位一律不许绿字');

  const { results } = await applyPlan(fields, plan.assignments, { allowCustomSelect: true });
  const degree = results.find(r => r.path === 'education.0.degree');
  assert.ok(degree, '学历这一栏应有结果');
  assert.equal(degree.status, 'yellow');
  assert.equal(degree.actual, '硕士', `显示值必须真的变成"硕士"，实得 "${degree.actual}"`);
  const shown = doc.querySelector('[data-nw-test="degree"] input').value;
  assert.equal(shown, '硕士', '页面上的输入框确实被框架更新了才算成');

  // 提交与"下一步"永远不许被点，哪怕授权了
  assert.ok(!clicks.includes('submit_btn'), '点到了提交按钮');
  assert.ok(!clicks.includes('next_step'), '点到了导航按钮');
});

test('否定式陷阱：选项列表把"非全日制"放在第一位，也必须选中"全日制"', async () => {
  const { doc } = liveForm('element-cn.html');
  const fields = scanForm(doc);
  const f = fields.find(x => x.el.closest?.('[data-nw-test="training_mode"]'));
  const r = await pickCustomSelect(f, '全日制');
  assert.equal(r.ok, true);
  assert.equal(r.shown, '全日制', `选了 "${r.shown}" 就是把学习形式填反了`);
  assert.equal(doc.querySelector('[data-nw-test="training_mode"] input').value, '全日制');
});

test('选项里没有对应值：报失败并交人工，绝不"点第一个"糊过去', async () => {
  const { doc } = liveForm('element-cn.html');
  const fields = scanForm(doc);
  const f = fields.find(x => x.el.closest?.('[data-nw-test="degree"]'));
  const r = await pickCustomSelect(f, '博士后研究员');     // 弹层里没有这一项
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'option_missing');
  assert.equal(doc.querySelector('[data-nw-test="degree"] input').value, '', '失败后不能留下半截值');
});

test('两个下拉接连处理：上一个失败留下的弹层不能污染下一个的选项集', async () => {
  const { doc } = liveForm('element-cn.html');
  const fields = scanForm(doc);
  const byLabel = l => fields.find(f => f.label === l);
  // 先让"意向城市"（多值资料对单选，选不上）打开后失败，弹层仍留在 DOM 里
  const bad = await pickCustomSelect(byLabel('意向城市'), '上海、杭州');
  assert.equal(bad.ok, false, '多值资料对上单选下拉就该拒绝，不替用户挑一个');
  assert.ok(doc.querySelectorAll('.el-select-dropdown').length, '此时页面上确实留着未收起的弹层');

  // "现居城市"的选项里有同名项：若把两个弹层的选项混在一起，'南京' 会出现两次被判歧义 → 交人工
  const r = await pickCustomSelect(byLabel('现居城市'), '南京市');
  assert.equal(r.ok, true, `残留弹层污染了选项集：${r.reason} / shown="${r.shown}"`);
  assert.equal(doc.querySelector('[data-nw-test="home_city"] input').value, '南京');
});

test('AntD 仿真页：搜索型 select 也是点开才有选项，同样要能选中并回读', async () => {
  const { doc } = liveForm('antd-cn.html');
  const fields = scanForm(doc);
  assert.ok(detectSelectLibraries(doc).some(s => s.name === 'antd'), 'AntD 签名没认出来');
  const city = fields.find(x => x.el.closest?.('[data-nw-test="city"]'));
  const r = await pickCustomSelect(city, '上海');
  assert.equal(r.ok, true);
  assert.match(r.shown, /上海/);
});

/**
 * 'female'.includes('male') 是 true —— 埃森哲那一页的性别下拉因此被点成 Female，
 * 而且回读还报"已填 female，请核对"：错值被包装成"待复核"，比报红危险得多。
 * 拉丁词必须整词匹配（中文没有词边界，仍走子串）。
 */
test('拉丁选项整词匹配：要 Male 绝不点成 Female', () => {
  const els = texts => Array.from(new JSDOM(
    `<ul role="listbox">${texts.map(t => `<li role="option">${t}</li>`).join('')}</ul>`
  ).window.document.querySelectorAll('li'));
  const textOf = o => String(o.textContent || '').trim();

  assert.equal(textOf(matchOption(els(['Male', 'Female']), 'Male')), 'Male', 'Male 被匹配成了别的项');
  assert.equal(textOf(matchOption(els(['Male', 'Female']), 'Female')), 'Female');
  assert.equal(textOf(matchOption(els(['Software Engineer', 'Engineer']), 'engineer')), 'Engineer', '完整词序列仍要能命中');
  assert.equal(matchOption(els(['Male']), 'man'), null, 'man ≠ male：词边界不该放宽成模糊匹配');
});
