// 埃森哲（途普 tupu360）真实页面形状的回归。
// 依据：用户 2026-10-02 的真实导出（page-structure-2026-10-02.json，probeBuild 2026-10-02-1）
// 与他自己逐项核对出来的选项/码值表。这一页把我们四个假设都打穿了：
//   ① 一栏一个小 <form>，标题在 form 外面；② radio/checkbox 真身 opacity:0；
//   ③ 选项面板 ul[role=listbox] 和触发器 div[role=combobox] 是同一个组件的两个节点；
//   ④ 语言名/考试名就是栏位标题（english / cantonese / IELTS Score / GMAT Score…），
//      四个成绩框平铺、没有行容器 —— 按标签相似度只能猜第几行。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { scanForm } from '../dom/scanner.js';
import { applyPlan } from '../dom/filler.js';
import { planFill } from '../core/matcher.js';
import { createEmptyProfile, setValueByPath } from '../core/profile-schema.js';
import tupuAdapter from '../adapters/tupu-antd.json' with { type: 'json' };

/** 真实 DOM 的等比缩样：text-muted 一行一栏，里面套小 form，组件壳 ddf_wrapper 里有触发器和面板 */
const PAGE = `<div class="deliver-form">
  <div class="text-muted">
    <span class="field-label">current location</span>
    <span class="field-value field-editor"><form class="ant-form ant-form-horizontal specialSelect">
      <div class="ant-row ant-form-item"><span class="ant-form-item-children"><div class="ddf_wrapper">
        <div class="ant-select ant-select-enabled"><div class="ant-select-selection ant-select-selection--single"
             role="combobox" aria-haspopup="listbox" data-nw-test="loc"></div>
          <div class="ant-select-dropdown"><ul role="listbox" class="ant-select-dropdown-menu" data-nw-test="loc_panel">
            <li role="option">南京市</li><li role="option">上海市</li></ul></div>
      </div></div></span></div></form></span>
  </div>

  <div class="text-muted">
    <span class="field-label">IELTS Score</span>
    <span class="field-value field-editor"><form class="ant-form"><div class="ant-row ant-form-item">
      <span class="ant-form-item-children"><input type="text" data-nw-test="ielts"></span>
    </div></form></span>
  </div>

  <div class="text-muted">
    <span class="field-label">GMAT Score</span>
    <span class="field-value field-editor"><form class="ant-form"><div class="ant-row ant-form-item">
      <span class="ant-form-item-children"><input type="text" data-nw-test="gmat"></span>
    </div></form></span>
  </div>

  <div class="text-muted">
    <span class="field-label">english</span>
    <span class="field-value field-editor"><form class="ant-form"><div class="ant-row ant-form-item">
      <span class="ant-form-item-children"><div class="ddf_wrapper">
        <div class="ant-select-selection" role="combobox" aria-haspopup="listbox" data-nw-test="en_box"></div>
      </div></span></div></form></span>
  </div>
</div>`;

function scan() {
  const dom = new JSDOM(`<!doctype html><html><body>${PAGE}</body></html>`, { url: 'https://careersite.tupu360.com/accentureats/resume/applicationView', pretendToBeVisual: true });
  return { doc: dom.window.document, fields: scanForm(dom.window.document) };
}
const at = (fields, key) => fields.find(f => f.el.getAttribute('data-nw-test') === key);

test('选项面板不算第二栏：ul[role=listbox] 与它同壳的 combobox 只算一栏', () => {
  const { fields } = scan();
  assert.ok(at(fields, 'loc'), '触发器本身该被扫到');
  assert.equal(at(fields, 'loc_panel'), undefined, '下拉的选项面板被当成独立字段了 —— 同一个标签会被计划两次');
  const panels = fields.filter(f => f.kind === 'combobox' && f.el.tagName.toLowerCase() === 'ul');
  assert.equal(panels.length, 0, `还有 ${panels.length} 个 listbox 面板混进字段里`);
});

test('板块标题在字段的小 form 外面：current location 这一栏要有名字', () => {
  const { fields } = scan();
  const loc = at(fields, 'loc');
  assert.equal(loc.label, 'current location', `实得「${loc.label}」via=${loc.labelSource}`);
  assert.equal(loc.labelSource, 'outside-form', '名字是从字段那个小 form 外面取到的，来源要写清（导出里靠它分辨）');
  assert.ok(!loc.sectionHint, '这一块的容器里没有板块标题时不许编一个出来 —— 假 hint 会把整页归到同一块');
});

test('IELTS Score 按资料里的语言行定位，不按顺序落到 languages.0', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'languages.0.language', '粤语');
  setValueByPath(p, 'languages.0.score', '一级甲等');
  setValueByPath(p, 'languages.1.language', '英语');
  setValueByPath(p, 'languages.1.score', '6.5');
  const { fields } = scan();
  const plan = planFill(fields, p, { mode: 'full', adapter: tupuAdapter });
  const ielts = plan.assignments.find(a => a.path.endsWith('.score'));
  assert.ok(ielts, `IELTS 没写出去：${JSON.stringify(plan.gaps)}`);
  assert.equal(ielts.path, 'languages.1.score', '资料里英语是第 2 行，写进第 1 行就是把雅思分数塞给粤语');
  assert.equal(ielts.value, '6.5');
});

test('GMAT 不是语言成绩：资料里没有 GMAT 那一行就交人工，绝不借用英语行的分数', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'languages.0.language', '英语');
  setValueByPath(p, 'languages.0.score', '6.5');
  const { fields } = scan();
  const plan = planFill(fields, p, { mode: 'full', adapter: tupuAdapter });
  const gmat = at(fields, 'gmat');
  assert.ok(!plan.assignments.some(a => a.index === fields.indexOf(gmat)),
    `GMAT 被写了：${JSON.stringify(plan.assignments.find(a => a.index === fields.indexOf(gmat)))}`);
  const gap = plan.gaps.find(g => g.index === fields.indexOf(gmat));
  assert.equal(gap?.reason, 'language_slot_unresolved', JSON.stringify(gap));
});

test('单选 Male/Female：要 male 就勾 male，词边界不能放过 female', async () => {
  const html = `<form><div class="text-muted"><span class="field-label">gender</span>
    <span class="field-value field-editor">
      <label class="ant-radio-wrapper"><span class="ant-radio"><input type="radio" class="ant-radio-input" name="gender" value="M" style="opacity: 0"></span><span>Male</span></label>
      <label class="ant-radio-wrapper"><span class="ant-radio"><input type="radio" class="ant-radio-input" name="gender" value="F" style="opacity: 0"></span><span>Female</span></label>
    </span></div></div>`;
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://careersite.tupu360.test/x', pretendToBeVisual: true });
  const fields = scanForm(dom.window.document);
  const g = fields.find(f => f.kind === 'radio');
  assert.ok(g, '皮肤 radio 组没被扫到');
  const { results } = await applyPlan(fields, [{ index: fields.indexOf(g), path: 'basics.gender', label: 'gender', value: 'Male', optionValue: 'Male', tier: 'auto' }], {});
  const male = dom.window.document.querySelector('input[value="M"]');
  const female = dom.window.document.querySelector('input[value="F"]');
  assert.equal(male.checked, true, 'male 没勾上');
  assert.equal(female.checked, false, '勾成 female 了：' + JSON.stringify(results[0]));
  assert.ok(results[0].ok ?? results[0].status === 'green', `回读没确认成功：${JSON.stringify(results[0])}`);
});
