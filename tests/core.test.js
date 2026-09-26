import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createEmptyProfile, buildFields, getValueByPath, setValueByPath, SECTIONS } from '../core/profile-schema.js';
import { normalize, simplify, core, signals, sniffType, assignMaxWeight, inferDateFormat, formatDate, boolLike, scorePair, typeCompatible } from '../core/matching.js';
import { planFill, resolveOption } from '../core/matcher.js';
import { SUBMIT_TEXT_RE, classifyClick } from '../dom/safety.js';

const profileField = (o) => ({ path: o.path, key: o.key || o.path.split('.').pop(), section: o.section || 'basics', itemIndex: o.itemIndex ?? null, zh: o.zh, labels: [o.zh, ...(o.al || [])].map(s => s.toLowerCase()), type: o.type || 'text', options: o.options || [], sensitive: Boolean(o.sensitive) });
const pageField = (o) => ({ kind: o.kind || 'text', label: o.label || '', name: o.name || '', id: o.id || '', placeholder: o.placeholder || '', currentValue: o.currentValue ?? '', options: o.options || [], required: Boolean(o.required), sectionHint: o.sectionHint || '', itemIndex: o.itemIndex ?? null, nearbyLabels: o.nearbyLabels || [], autocomplete: o.autocomplete || '', type: o.type || '', compositeDate: o.compositeDate, maxLength: o.maxLength });

test('归一化：全半角 / 简繁 / 括号降级', () => {
  assert.equal(normalize('姓　名：'), '姓名:');
  assert.equal(simplify('學歷'), '学历');
  assert.equal(core('最高学历（含在读）'), '最高学历');
  assert.equal(normalize('Email'), 'email');
});

test('词元：CJK 二元组与英文缩写扩展', () => {
  const s = signals('出生日期');
  assert.ok(s.tokens.has('出生'));
  const e = signals('tel no');
  assert.ok(e.tokens.has('telephone'), 'tel 应扩展成 telephone');
});

test('类型嗅探与类型约束', () => {
  assert.equal(sniffType('a@b.co'), 'email');
  assert.equal(sniffType('13800138000'), 'tel');
  assert.equal(sniffType('2026-06-30'), 'date');
  assert.equal(typeCompatible('email', profileField({ path: 'x', zh: 'y' }), '13800138000'), 0);
  assert.equal(typeCompatible('email', profileField({ path: 'email', zh: '邮箱', type: 'email' }), 'a@b.co'), 1);
});

test('打分：中文标签精确命中优先，跨语义不误伤', () => {
  assert.ok(scorePair(pageField({ label: '姓名' }), profileField({ path: 'basics.name', zh: '姓名', al: ['full name'] })) >= 0.95);
  assert.ok(scorePair(pageField({ label: '期望工作地' }), profileField({ path: 'intent.cities', zh: '意向城市', al: ['preferred city', '期望工作地'] })) >= 0.9);
  assert.equal(scorePair(pageField({ label: '邮箱' }), profileField({ path: 'basics.heightCm', zh: '身高', type: 'num' })), 0);
});

test('匈牙利分配：争抢同一个 profile 键时给全局最优解', () => {
  // 朴素贪心会把 row0 的 0.9 分给 col0，导致 row1 只剩 0.85；全局最优是 row0→col1(0.88) + row1→col0(0.95)
  const matrix = [[0.9, 0.88], [0.95, 0.1]];
  const got = assignMaxWeight(matrix, 2).sort((a, b) => a.row - b.row);
  assert.deepEqual(got.map(g => [g.row, g.col]), [[0, 1], [1, 0]]);
});

test('匈牙利分配：允许低分字段不分配（每行有 dummy 退路）', () => {
  const matrix = [[0.99], [0]];
  const got = assignMaxWeight(matrix, 1);
  assert.equal(got.length, 1);
  assert.equal(got[0].row, 0);
});

test('日期格式推断与渲染', () => {
  assert.equal(inferDateFormat({ placeholder: 'yyyy/MM/dd' }), 'yyyy/MM/dd');
  assert.equal(inferDateFormat({ label: '入学年月' }), 'yyyy-MM');
  assert.equal(formatDate('2026-06-30', 'yyyy年MM月'), '2026年06月');
  assert.equal(formatDate('2026-06-30', 'MM/dd/yyyy'), '06/30/2026');
  assert.equal(formatDate('2026-06-30', 'dd/MM/yyyy'), '30/06/2026');
  assert.equal(formatDate('2026-06-30', 'yyyyMMdd'), '20260630');
  assert.equal(formatDate('2026年6月', 'yyyy-MM'), '2026-06');
});

test('布尔折异：是/否、有/无、Yes/No', () => {
  assert.equal(boolLike('是'), true);
  assert.equal(boolLike('无'), false);
  assert.equal(boolLike('No'), false);
  assert.equal(boolLike('Y'), true);
  assert.equal(boolLike('看情况'), null);
});

test('枚举映射：站点 option 文本与资料值不一致时按语义命中', () => {
  const pf = pageField({ kind: 'select', label: '学历', options: [{ text: '硕士研究生', value: '2' }, { text: '本科', value: '3' }] });
  const hit = resolveOption(pf, '硕士');
  assert.equal(hit?.value, '2');
});

test('profile 结构：路径唯一、可写可读、分组非空', () => {
  const fields = buildFields();
  const paths = new Set(fields.map(f => f.path));
  assert.equal(paths.size, fields.length, 'path 不应重复');
  assert.ok(fields.length > 150, `字段覆盖应足够广，实得 ${fields.length}`);
  assert.ok(SECTIONS.length >= 15, '分组数量');
  const p = createEmptyProfile();
  setValueByPath(p, 'education.1.school', '某大学');
  assert.equal(getValueByPath(p, 'education.1.school'), '某大学');
  assert.equal(getValueByPath(p, '不存在的路径'), '');
  for (const f of fields) {
    assert.ok(f.labels.length >= 1 && f.zh, f.path);
  }
});

test('敏感字段标记存在（AI 外发排除依赖它）', () => {
  const sens = buildFields().filter(f => f.sensitive).map(f => f.path);
  assert.ok(sens.includes('basics.idNumber'));
  assert.ok(sens.includes('contact.phone'));
  assert.ok(sens.includes('contact.email'));
});

test('planFill：验证码 / 附件 / 主观题 / 提交按钮 一律不进入分配', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'others.selfIntro', '三年经验');
  setValueByPath(p, 'basics.name', '张伟');
  const fields = [
    pageField({ label: '姓名', name: 'nm' }),
    pageField({ label: '验证码', name: 'code' }),
    pageField({ label: '自我评价', name: 'selfintro', kind: 'textarea' }),
    pageField({ label: '上传简历', name: 'resume_file', kind: 'file' }),
  ];
  const plan = planFill(fields, p, {});
  const reasons = Object.fromEntries(plan.gaps.map(g => [g.index, g.reason]));
  assert.equal(reasons[1], 'captcha');
  assert.equal(reasons[2], 'subjective');
  assert.equal(reasons[3], 'file');
  assert.ok(plan.assignments.some(a => a.index === 0 && a.path === 'basics.name'));
  assert.ok(!plan.assignments.some(a => a.index === 2), '主观题不应被分配');
});

test('planFill：incremental 模式跳过已填字段', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', '张伟');
  const fields = [pageField({ label: '姓名', currentValue: '已有值' }), pageField({ label: '性别', options: [{ text: '男', value: 'M' }] })];
  setValueByPath(p, 'basics.gender', '男');
  const plan = planFill(fields, p, { mode: 'incremental' });
  assert.ok(plan.assignments.find(a => a.index === 0 && a.skip));
  assert.ok(plan.assignments.find(a => a.index === 1 && !a.skip));
});

test('真实站点教出来的三条拦截：自定义下拉 / 年月成对 / 语音验证码', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.gender', '男');
  setValueByPath(p, 'education.0.enrollDate', '2023-09-01');
  setValueByPath(p, 'basics.idNumber', '320102200103150011');
  const fields = [
    pageField({ label: 'Highest degree', placeholder: 'Please select' }),
    pageField({ label: 'Study period', placeholder: 'Year', compositeDate: 'year' }),
    pageField({ label: 'Study period', placeholder: 'Month', compositeDate: 'month' }),
    { ...pageField({ label: 'Security check', placeholder: 'Enter the verification code you hear', type: 'tel' }), maxLength: 10 },
  ];
  const plan = planFill(fields, p, {});
  const reasons = Object.fromEntries(plan.gaps.map(g => [g.index, g.reason]));
  assert.equal(reasons[0], 'custom_control', 'placeholder=Please select 的自定义下拉不得打字硬填');
  assert.equal(reasons[1], 'composite_date');
  assert.equal(reasons[2], 'composite_date');
  assert.equal(reasons[3], 'captcha', '英文 "verification code" 也要当验证码拦下');
  assert.equal(plan.assignments.length, 0, '四个字段都不应产生写入');
});

test('安全规则必须看到未清洗的原文（括号里的 CAPTCHA 不能被剥掉）', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'records.backgroundOk', '是');
  setValueByPath(p, 'intent.salary', '15000');
  const fields = [{
    ...pageField({ label: 'security check', name: 'security' }),
    labelRaw: 'Security Check (CAPTCHA)',
    maxLength: 6,
  }];
  const plan = planFill(fields, p, {});
  assert.equal(plan.gaps[0]?.reason, 'captcha', '括号里的 captcha 关键词被 core() 剥掉后仍要拦住');
  assert.equal(plan.assignments.length, 0);
});

test('同意与声明类勾选永不代做', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'intent.acceptOvertime', '是');
  const fields = [
    pageField({ label: '我已阅读并同意隐私政策', kind: 'checkbox' }),
    pageField({ label: 'I agree to the terms of service', kind: 'checkbox' }),
    pageField({ label: '知情同意书', kind: 'checkbox' }),
  ];
  const plan = planFill(fields, p, {});
  assert.deepEqual(plan.gaps.map(g => g.reason), ['consent_declaration', 'consent_declaration', 'consent_declaration']);
  assert.equal(plan.assignments.length, 0);
});

test('否定护栏：全日制绝不落到「非全日制」选项上', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'education.0.trainingMode', '全日制');
  const fields = [pageField({
    label: '学习形式',
    kind: 'select',
    options: [{ text: '非全日制', value: 'a' }, { text: '全日制', value: 'b' }],
  })];
  const plan = planFill(fields, p, {});
  assert.equal(plan.assignments[0].optionValue, 'b');
  const only = [pageField({ label: '学习形式', kind: 'select', options: [{ text: '非全日制', value: 'a' }] })];
  const p2 = planFill(only, p, {});
  assert.notEqual(p2.assignments[0]?.optionValue, 'a', '只有否定式选项时不能选它');
});

test('安全闸门：提交类按钮与导航按钮都在拒绝名单', () => {
  assert.ok(SUBMIT_TEXT_RE.test('提交申请'));
  assert.ok(SUBMIT_TEXT_RE.test('Apply Now'));
  assert.ok(SUBMIT_TEXT_RE.test('确认投递'));
  assert.equal(classifyClick(null).allowed, false);
});

test('别名补丁里没有重复键（对象字面量会静默覆盖，加一条就丢一片别名）', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../core/profile-schema.js', import.meta.url)), 'utf8');
  const start = src.indexOf('export const EXTRA_ALIASES');
  const block = src.slice(start, src.indexOf('\n};', start));
  const keys = [...block.matchAll(/^ {2}'([^']+)':/gm)].map(m => m[1]);
  const dup = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
  assert.deepEqual(dup, [], `EXTRA_ALIASES 重复键：${dup.join(', ')}`);
  assert.ok(keys.length > 30, `别名补丁块没抓到内容（keys=${keys.length}）`);
});
