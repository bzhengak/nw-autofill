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
import { pickCustomSelect, adapterHints } from '../dom/select-opener.js';
import { applyPlan } from '../dom/filler.js';
import { planFill, gapReasonLabel } from '../core/matcher.js';
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

test('IELTS Score 按资料里的证书列找行，不按顺序落到 languages.0', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'languages.0.language', '粤语');
  setValueByPath(p, 'languages.0.score', '一级甲等');
  setValueByPath(p, 'languages.1.language', '英语');
  setValueByPath(p, 'languages.1.cert', 'IELTS');      // 用户 2026-10-02：考试名存在证书列
  setValueByPath(p, 'languages.1.score', '6.5');
  const { fields } = scan();
  const plan = planFill(fields, p, { mode: 'full', adapter: tupuAdapter });
  const ielts = plan.assignments.find(a => a.path.endsWith('.score'));
  assert.ok(ielts, `IELTS 没写出去：${JSON.stringify(plan.gaps)}`);
  assert.equal(ielts.path, 'languages.1.score', '资料里 IELTS 在第 2 行，写进第 1 行就是把分数塞给粤语');
  assert.equal(ielts.value, '6.5');
});

/**
 * 上一版钉位用子串匹配，'english' 命中了标签 'english name'，
 * 于是 English Name 被钉成"英语那一行的语言列"（置信 1.0，绿字），别名再准也压不过它。
 */
test('钉位只认整条标签：english name 归英文姓名，不被「english」抢走', () => {
  const html = `<div class="text-muted"><span class="field-label">English Name</span>
    <span class="field-value field-editor"><form class="ant-form"><div class="ant-row ant-form-item">
      <span class="ant-form-item-children"><input type="text" data-nw-test="enname"></span></div></form></span></div>`;
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://careersite.tupu360.test/x', pretendToBeVisual: true });
  const fields = scanForm(dom.window.document);
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.nameEn', 'LI WANGSHU');
  setValueByPath(p, 'languages.0.language', '英语');
  const plan = planFill(fields, p, { mode: 'full', adapter: tupuAdapter });
  const a = plan.assignments.find(x => x.index === 0);
  assert.ok(a, `English Name 没落地：${JSON.stringify(plan.gaps)}`);
  assert.equal(a.path, 'basics.nameEn', '被「english」那条钉位子串抢走了');
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

/**
 * 用户 2026-10-02 的导出证实：这一页的 gender 是**三个独立字段**（male / female /
 * prefer not to disclose），因为 AntD v3 的 radio 一个 name 都不写。一题被拆成三栏之后
 * 两栏"候选势均力敌"、第三栏被单独勾上 —— 他看到的"存 male 填成 female"就是这么来的。
 */
test('无名 radio 一题只算一栏：gender 的三个选项是一题，不是三栏', async () => {
  const html = `<div class="text-muted"><span class="field-label">gender</span>
    <span class="field-value field-editor"><form class="ant-form ant-form-horizontal specialSelect">
      <div class="ant-row ant-form-item"><span class="ant-form-item-children">
        <label class="ant-radio-wrapper"><span class="ant-radio"><input type="radio" class="ant-radio-input" value="M" style="opacity: 0"></span><span>Male</span></label>
        <label class="ant-radio-wrapper"><span class="ant-radio"><input type="radio" class="ant-radio-input" value="F" style="opacity: 0"></span><span>Female</span></label>
        <label class="ant-radio-wrapper"><span class="ant-radio"><input type="radio" class="ant-radio-input" value="X" style="opacity: 0"></span><span>Prefer not to disclose</span></label>
      </span></div></form></span></div>`;   // 真实形状：题目在"每栏一个小 form"的外面（导出第 4/5/6 行）
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://careersite.tupu360.test/x', pretendToBeVisual: true });
  const fields = scanForm(dom.window.document);
  const radios = fields.filter(f => f.kind === 'radio');
  assert.equal(radios.length, 1, `一题被拆成 ${radios.length} 栏`);
  assert.deepEqual(radios[0].options.map(o => o.text), ['male', 'female', 'prefer not to disclose']);
  assert.equal(radios[0].label, 'gender');
  const g = radios[0];
  const { results } = await applyPlan(fields, [{ index: fields.indexOf(g), path: 'basics.gender', label: 'gender', value: 'Male', optionValue: 'Male', tier: 'auto' }], {});
  const boxes = [...dom.window.document.querySelectorAll('input[type=radio]')];
  assert.equal(boxes[0].checked, true, 'male 该被勾上');
  assert.equal(boxes[1].checked, false, 'female 被勾了');
  assert.equal(boxes[2].checked, false, 'prefer not to disclose 被勾了');
  assert.ok(results[0].ok ?? results[0].status === 'green', `回读没确认：${JSON.stringify(results[0])}`);
});

/**
 * AntD **v3** 的下拉：选项是 .ant-select-dropdown-menu-item、已选文案在
 * .ant-select-selection-selected-value —— 内置签名只认 v4/v5 的 -item-option，
 * 所以在途普这张页面上"点得开、却匹配不到选项"，用户看到的就是"下拉都不好用"。
 * 适配器现在能把站点自己说出的选择器接进来（controlHints → adapterHints）。
 */
test('AntD v3 下拉：靠适配器的选择器也能点开并选中，回读读到真正的已选文案', async () => {
  const html = `<div class="text-muted"><span class="field-label">highest education</span>
    <span class="field-value field-editor"><form class="ant-form ant-form-horizontal specialSelect">
      <div class="ant-row ant-form-item"><span class="ant-form-item-children">
        <div class="ddf_wrapper"><div class="ant-select ant-select-enabled">
          <div class="ant-select-selection ant-select-selection--single" role="combobox" aria-haspopup="listbox">
            <div class="ant-select-selection__rendered"><span class="ant-select-selection-selected-value"></span></div>
          </div>
          <div class="ant-select-dropdown">
            <ul role="listbox" class="ant-select-dropdown-menu">
              <li class="ant-select-dropdown-menu-item" data-v="Bachelor">Bachelor</li>
              <li class="ant-select-dropdown-menu-item" data-v="Master">Master</li>
            </ul>
          </div>
        </div></div>
      </span></div></form></span></div></div>`;
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://careersite.tupu360.test/x', pretendToBeVisual: true });
  const fields = scanForm(dom.window.document);
  const box = fields.find(f => f.kind === 'combobox');
  assert.ok(box, 'combobox 没被扫到');
  const hints = adapterHints(tupuAdapter);
  assert.ok(hints && /ant-select-dropdown-menu-item/.test(hints.option), '适配器的 v3 选项选择器没接进来');
  const r = await pickCustomSelect(box, 'Master', { hints });
  assert.equal(r.ok, true, `v3 下拉选不中：${JSON.stringify(r)}`);
  assert.match(r.shown, /Master/, `回读要读到 .ant-select-selection-selected-value，实得 ${JSON.stringify(r.shown)}`);
  // 不带适配器提示时必须诚实地失败，而不是"点了就当成功"
  const bad = await pickCustomSelect(box, 'Bachelor', {});
  assert.notEqual(bad.ok, true, '没有选择器提示却报成功 —— 那说明回读在骗人');
});

/**
 * 途普那一页把「区号下拉」和「手机号输入框」共用同一句标签（primary cell number），
 * 于是区号那一格被派去拿证件号 / 备用电话（用户实测：那一栏出现了 '3301…' 这种值）。
 * 一整列选项都是 +86 / +852 时，这个控件的身份是确定的：它就是"电话国家/地区区号"，
 * 除了 contact.dialCode 之外的槽位派来的值一律不许选。
 */
test('区号型下拉只认「电话区号」槽位：别的槽位派来的值一律不选', async () => {
  const html = `<div class="text-muted"><span class="field-label">primary cell number</span>
    <span class="field-value field-editor"><form class="ant-form ant-form-horizontal specialSelect">
      <div class="ant-row ant-form-item"><span class="ant-form-item-children">
        <div class="ddf_wrapper"><div class="ant-select ant-select-enabled">
          <div class="ant-select-selection ant-select-selection--single" role="combobox" aria-haspopup="listbox">
            <div class="ant-select-selection__rendered"><span class="ant-select-selection-selected-value"></span></div>
          </div>
          <div class="ant-select-dropdown"><ul role="listbox" class="ant-select-dropdown-menu">
            <li class="ant-select-dropdown-menu-item" data-v="86">中国大陆 +86</li>
            <li class="ant-select-dropdown-menu-item" data-v="852">中国香港 +852</li>
            <li class="ant-select-dropdown-menu-item" data-v="853">中国澳门 +853</li>
            <li class="ant-select-dropdown-menu-item" data-v="886">中国台湾 +886</li>
          </ul></div>
        </div></div>
      </span></div></form></span></div></div>`;
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://careersite.tupu360.test/x', pretendToBeVisual: true });
  const fields = scanForm(dom.window.document);
  const box = fields.find(f => f.kind === 'combobox');
  assert.ok(box, '区号下拉没被扫成 combobox');
  const hints = adapterHints(tupuAdapter);

  const wrong = await pickCustomSelect(box, '330105199912034567', { hints, path: 'basics.idNumber' });
  assert.equal(wrong.ok, false, '把证件号选进了区号下拉');
  assert.equal(wrong.reason, 'dial_code_only', `要的是"这一格配错了槽位"这条独立原因，实得 ${JSON.stringify(wrong)}`);
  assert.equal(dom.window.document.querySelector('.ant-select-selection-selected-value').textContent.trim(), '',
    '拒绝之后页面还该是空的：不许留下半截选择');

  const ok = await pickCustomSelect(box, '+852', { hints, path: 'contact.dialCode' });
  assert.equal(ok.ok, true, `区号槽派来的值本该能选：${JSON.stringify(ok)}`);
  assert.match(ok.shown, /852/);
});

/** 一路从计划打到写入：错配的槽位在结果里是 manual（不是红），且原因被翻成人话 */
test('区号下拉走完整链路：报告里是待人工，不是假绿也不是误报红', async () => {
  const html = `<div class="text-muted"><span class="field-label">primary cell number</span>
    <span class="field-value field-editor"><form class="ant-form ant-form-horizontal specialSelect">
      <div class="ant-row ant-form-item"><span class="ant-form-item-children">
        <div class="ddf_wrapper"><div class="ant-select ant-select-enabled">
          <div class="ant-select-selection ant-select-selection--single" role="combobox" aria-haspopup="listbox">
            <div class="ant-select-selection__rendered"><span class="ant-select-selection-selected-value"></span></div>
          </div>
          <div class="ant-select-dropdown"><ul role="listbox" class="ant-select-dropdown-menu">
            <li class="ant-select-dropdown-menu-item" data-v="86">中国大陆 +86</li>
            <li class="ant-select-dropdown-menu-item" data-v="852">中国香港 +852</li>
            <li class="ant-select-dropdown-menu-item" data-v="853">中国澳门 +853</li>
          </ul></div>
        </div></div>
      </span></div></form></span></div></div>`;
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://careersite.tupu360.test/x', pretendToBeVisual: true });
  const fields = scanForm(dom.window.document);
  const box = fields.find(f => f.kind === 'combobox');
  const { results } = await applyPlan(fields,
    [{ index: fields.indexOf(box), path: 'contact.phone', label: 'primary cell number', value: '13900002222', optionValue: '13900002222', tier: 'auto' }],
    { allowCustomSelect: true, adapter: tupuAdapter });
  assert.equal(results[0].status, 'manual', `该是待人工，实得 ${JSON.stringify(results[0])}`);
  assert.equal(results[0].failReason, 'dial_code_only');
  assert.match(gapReasonLabel('dial_code_only'), /区号/, '缺口原因要说人话并给出下一步');
});

/**
 * Work Permit 这一类：页面给 Yes/No，资料里存的却是枚举（本地居民 / 需申请工作签证）。
 * 字面永远对不上，相似度与 AI 都只会在"有权工作"和"需要担保"之间拉扯 ——
 * 而这是一句合规声明。用户 2026-10-02 的口径："可以自动选，选不出就放那。"
 * 所以对照写在适配器里，逐条写死，且只在单边命中、页面只落一项时才动手。
 */
function workPermitPlan(value) {
  const html = `<div><span class="field-label">Work Permit</span>
    <span><label><input type="radio" name="wp" value="Y">Yes</label>
      <label><input type="radio" name="wp" value="N">No</label></span></div>`;
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://careersite.tupu360.test/x', pretendToBeVisual: true });
  const fields = scanForm(dom.window.document);
  const p = createEmptyProfile();
  if (value) setValueByPath(p, 'hkGlobal.workAuth', value);
  const plan = planFill(fields, p, { mode: 'full', adapter: tupuAdapter });
  const idx = fields.findIndex(f => f.kind === 'radio');
  return {
    entry: plan.assignments.find(a => a.index === idx),
    gap: plan.gaps.find(g => g.index === idx),
  };
}

test('Work Permit：资料「本地居民」→ 按选项对照选 Yes，不交人工', () => {
  const { entry, gap } = workPermitPlan('本地居民');
  assert.ok(entry, `这一栏该有计划：${JSON.stringify(gap)}`);
  assert.equal(entry.path, 'hkGlobal.workAuth');
  assert.equal(entry.optionValue, 'Y', `该选 Yes（值 Y），实得 ${JSON.stringify(entry)}`);
  assert.equal(entry.tier, 'auto', '用户放行了：这一类可以自动选');
  assert.match(entry.note, /选项对照/, '要写清是按哪条规则选的，别看起来像我们自己推的');
});

test('Work Permit：资料「需申请工作签证」→ 选 No，不会两头都勾', () => {
  const { entry } = workPermitPlan('需申请工作签证');
  assert.equal(entry.optionValue, 'N', `该选 No，实得 ${JSON.stringify(entry)}`);
});

test('Work Permit：资料里的说法不在对照表里 → 照旧交人工，不硬选', () => {
  const { entry } = workPermitPlan('外交人员随行家属');
  assert.ok(!entry.optionValue || entry.needsChoice, `说不清的一律不选：${JSON.stringify(entry)}`);
  assert.equal(entry.tier, 'review');
  assert.equal(entry.needsChoice, true);
});

test('选项对照只管它写明的那个槽位：资料空着时也不会替别人表态', () => {
  const { entry, gap } = workPermitPlan('');
  assert.ok(!entry, `资料空着就不该有落笔：${JSON.stringify(entry)}`);
  assert.ok(gap, '空资料要留一条看得懂的缺口');
});
