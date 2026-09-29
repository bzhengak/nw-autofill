import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createEmptyProfile, buildFields, getValueByPath, setValueByPath, SECTIONS } from '../core/profile-schema.js';
import { normalize, simplify, core, signals, sniffType, assignMaxWeight, inferDateFormat, formatDate, boolLike, scorePair, typeCompatible } from '../core/matching.js';
import { planFill, resolveOption } from '../core/matcher.js';
import { SUBMIT_TEXT_RE, classifyClick } from '../dom/safety.js';

const profileField = (o) => ({ path: o.path, key: o.key || o.path.split('.').pop(), section: o.section || 'basics', itemIndex: o.itemIndex ?? null, zh: o.zh, labels: [o.zh, ...(o.al || [])].map(s => s.toLowerCase()), type: o.type || 'text', options: o.options || [], sensitive: Boolean(o.sensitive) });
const pageField = (o) => ({ kind: o.kind || 'text', label: o.label || '', name: o.name || '', id: o.id || '', placeholder: o.placeholder || '', currentValue: o.currentValue ?? '', options: o.options || [], required: Boolean(o.required), sectionHint: o.sectionHint || '', itemIndex: o.itemIndex ?? null, nearbyLabels: o.nearbyLabels || [], autocomplete: o.autocomplete || '', type: o.type || '', compositeDate: o.compositeDate, datePair: o.datePair, itemIndexSource: o.itemIndexSource, maxLength: o.maxLength, readOnly: Boolean(o.readOnly), className: o.className || '' });

// 扫描器对"年框+月框"的产物，测试里手搓一份，避免依赖 DOM
const dp = (id, part, role, roleSource = 'label', ordinal = 0, size = 1) => ({ id, part, role, roleSource, ordinal, size });

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
  const plan = planFill(fields, p, { fillSensitive: true });
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

test('英文右分支中心词：Current Job Title 问的是 title，不是"是否在职"', () => {
  const mk = label => pageField({ label, sectionHint: 'work' });
  const fs2 = buildFields();
  const title = fs2.find(f => f.path === 'work.0.title');
  const current = fs2.find(f => f.path === 'work.0.current');
  assert.ok(scorePair(mk('Current Most Recent Job Title'), title)
    > scorePair(mk('Current Most Recent Job Title'), current), '带中心词的别名必须赢过只命中修饰词的别名');
});

test('精确别名能扛住错的章节线索，但扛不住可重复列表槽位', () => {
  const fs2 = buildFields();
  // SF 把 Expected Salary 摆在 Employment 小节里：intent.salary（一次性字段）应赢过 work.0.salary
  const exp = pageField({ label: 'Expected Salary', sectionHint: 'work' });
  assert.ok(scorePair(exp, fs2.find(f => f.path === 'intent.salary'))
    > scorePair(exp, fs2.find(f => f.path === 'work.0.salary')));
  // 「政治面貌」在基本信息里：family.0.political 也是字面命中，但它是列表槽位，不得反超
  const pol = pageField({ label: '政治面貌', kind: 'select', sectionHint: 'basics', options: [{ text: '中共党员', value: 'a' }] });
  assert.ok(scorePair(pol, fs2.find(f => f.path === 'basics.politicalStatus'))
    > scorePair(pol, fs2.find(f => f.path === 'family.0.political')));
});

test('SuccessFactors 实测形态：自定义下拉 / 无标签密码框 / cookie 开关都在计划阶段挡下', () => {  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', '张伟');
  const fields = [
    pageField({ label: 'Title', kind: 'combobox', placeholder: 'No Selection' }),
    pageField({ label: 'Country/Region of Residence', kind: 'combobox' }),
    pageField({ label: 'Country', kind: 'text', placeholder: 'No Selection' }),
    pageField({ label: 'Choose Password', type: 'password' }),
    pageField({ label: 'Retype Password', type: 'password' }),
    pageField({ label: 'Required Cookies', kind: 'checkbox', options: [{ text: 'Required Cookies', value: 'on' }] }),
    pageField({ label: 'Consent to all Advertising Cookies', kind: 'checkbox', options: [{ text: 'x', value: 'on' }] }),
  ];
  const plan = planFill(fields, p, {});
  assert.deepEqual(plan.gaps.map(g => g.reason),
    ['custom_control', 'custom_control', 'custom_control', 'credential', 'credential', 'consent_declaration', 'consent_declaration']);
  assert.equal(plan.assignments.length, 0, '这些字段一个都不该进入填写计划');
});

test('敏感字段默认不写入，勾了 fillSensitive 才写（设置以前只是界面上骗人）', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.idNumber', '320102200103150011');
  setValueByPath(p, 'contact.phone', '13800138000');
  setValueByPath(p, 'basics.birthDate', '2001-03-15');
  const fields = [
    pageField({ label: '证件号码', name: 'sfzh' }),
    pageField({ label: '手机号码', name: 'sjh' }),
    pageField({ label: '出生日期', name: 'csrq' }),
  ];
  const off = planFill(fields, p, { mode: 'full' });
  assert.equal(off.assignments.length, 0, '证件号/手机号/出生日期都是敏感字段，默认一个都不写');
  assert.deepEqual(off.gaps.map(g => g.reason).sort(), ['sensitive_withheld', 'sensitive_withheld', 'sensitive_withheld']);

  const on = planFill(fields, p, { mode: 'full', fillSensitive: true });
  assert.equal(on.assignments.length, 3);
  assert.ok(on.gaps.every(g => g.reason !== 'sensitive_withheld'));
});

test('列表槽位没有区块证据时不许拿绿字（Moka 双「公司名称」是盲猜）', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'work.0.company', '甲科技');
  setValueByPath(p, 'internship.0.company', '乙银行');

  // 页面上两个同名输入框，既没识别出重复区块序号，也没读到小节标题
  const blind = planFill([
    pageField({ label: '公司名称', name: 'c1' }),
    pageField({ label: '公司名称', name: 'c2' }),
  ], p, { mode: 'full' });
  assert.equal(blind.assignments.length, 2, '两栏都该进计划，不能因为拿不准就整栏丢掉');
  for (const a of blind.assignments) {
    assert.ok(a.score >= 0.75, `这条本来是绿字（score=${a.score}），才会被规则打下来`);
    assert.equal(a.tier, 'review', `${a.path} 凭什么算绿字：页面没给任何「这是第几段」的证据`);
    assert.match(String(a.note), /无法确定这是第 \d+ 段/, '黄字必须说清为什么黄，而不是含糊的「置信度不足」');
  }

  // 给了小节标题 = 有证据，恢复绿字
  const bySection = planFill([
    pageField({ label: '公司名称', name: 'c1', sectionHint: 'work' }),
    pageField({ label: '公司名称', name: 'c2', sectionHint: 'internship' }),
  ], p, { mode: 'full' });
  const tiers = Object.fromEntries(bySection.assignments.map(a => [a.path, a.tier]));
  assert.deepEqual(tiers, { 'work.0.company': 'auto', 'internship.0.company': 'auto' });

  // 给了区块序号 = 同样算证据
  setValueByPath(p, 'work.1.company', '丙集团');
  const byIndex = planFill([pageField({ label: '公司名称', name: 'c1', itemIndex: 1 })], p, { mode: 'full' });
  assert.equal(byIndex.assignments[0]?.tier, 'auto', '页面明确说这是第二段经历，就该是绿字');
});

test('年框+月框 = 一个日期问题：只占一个槽位，落笔才拆成两笔', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'work.0.startDate', '2025-03-15');
  setValueByPath(p, 'work.1.startDate', '2023-07-01');
  const pair = [
    pageField({ label: '开始时间', name: 'fy', placeholder: 'Year', compositeDate: 'year', datePair: dp('dp0', 'year', 'start'), sectionHint: 'work' }),
    pageField({ label: '开始时间', name: 'fm', placeholder: 'Month', compositeDate: 'month', datePair: dp('dp0', 'month', 'start'), sectionHint: 'work' }),
  ];
  const plan = planFill(pair, p, { mode: 'full' });
  assert.equal(plan.assignments.length, 2, '一笔规划要展开成两笔写入');
  assert.deepEqual(plan.assignments.map(a => [a.datePart, a.path, a.dateFormat]),
    [['year', 'work.0.startDate', 'yyyy'], ['month', 'work.0.startDate', 'MM']],
    '两笔必须共用同一个槽位：年框月框各自抢列时会把开始时间填进上一段经历');
  assert.deepEqual(plan.gaps.map(g => g.reason), [], '整组不该再产生 composite_date 缺口');
});

test('资料里只有年份时：年框照写，月框留空并说明，绝不拿年份凑月份', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'work.0.startDate', '2025');
  const plan = planFill([
    pageField({ label: '开始时间', name: 'fy', placeholder: 'Year', compositeDate: 'year', datePair: dp('dp0', 'year', 'start'), sectionHint: 'work' }),
    pageField({ label: '开始时间', name: 'fm', placeholder: 'Month', compositeDate: 'month', datePair: dp('dp0', 'month', 'start'), sectionHint: 'work' }),
  ], p, { mode: 'full' });
  assert.deepEqual(plan.assignments.map(a => a.datePart), ['year']);
  assert.equal(plan.gaps.length, 1);
  assert.equal(plan.gaps[0].reason, 'composite_date');
  assert.match(plan.gaps[0].note, /只有年份/);
});

test('起止一行：开始与结束必须落在同一段经历，不能一个第 0 段一个第 1 段', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'work.0.startDate', '2025-03-01');
  setValueByPath(p, 'work.0.endDate', '2025-08-01');
  setValueByPath(p, 'work.1.startDate', '2023-07-01');
  setValueByPath(p, 'work.1.endDate', '2023-09-01');
  const mk = (name, ph, part, role, ord) => pageField({
    label: part === 'year' ? '自' : '至', name, placeholder: ph,
    compositeDate: part, datePair: dp(`dp${ord}`, part, role, 'label', ord, 2), sectionHint: 'work',
  });
  const plan = planFill([
    mk('fy', 'Year', 'year', 'start', 0), mk('fm', 'Month', 'month', 'start', 0),
    mk('ty', 'Year', 'year', 'end', 1), mk('tm', 'Month', 'month', 'end', 1),
  ], p, { mode: 'full' });
  const slot = a => a.path.split('.').slice(0, 2).join('.');
  assert.equal(new Set(plan.assignments.map(slot)).size, 1,
    `一行起止应当属于同一段经历，实得 ${plan.assignments.map(a => a.path).join(', ')}`);
});

test('只写了时段的成对框（Study period）不许猜起止，整组退回人工', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'education.0.enrollDate', '2019-09-01');
  setValueByPath(p, 'education.0.gradDate', '2023-06-30');
  const plan = planFill([
    pageField({ label: 'study period', name: 'py', placeholder: 'Year', compositeDate: 'year', datePair: dp('dp0', 'year', null, null, 0, 1) }),
    pageField({ label: 'study period', name: 'pm', placeholder: 'Month', compositeDate: 'month', datePair: dp('dp0', 'month', null, null, 0, 1) }),
  ], p, { mode: 'full' });
  assert.equal(plan.assignments.length, 0, '说不清是入学还是毕业，就不该有任何一笔');
  assert.equal(plan.gaps.length, 2);
  assert.match(plan.gaps[0].note, /没说清是开始还是结束/);
});

test('适配器钉位也必须展开年月组：钉住年框不能把月框弄丢', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'work.0.startDate', '2025-03-15');
  const adapter = { id: 'test-pin', domains: ['x.test'], pins: [{ match: '开始时间', path: 'work.0.startDate' }] };
  const plan = planFill([
    pageField({ label: '开始时间', name: 'fy', placeholder: 'Year', compositeDate: 'year', datePair: dp('dp0', 'year', 'start') }),
    pageField({ label: '开始时间', name: 'fm', placeholder: 'Month', compositeDate: 'month', datePair: dp('dp0', 'month', 'start') }),
  ], p, { mode: 'full', adapter });
  assert.deepEqual(plan.assignments.map(a => [a.datePart, a.path]), [['year', 'work.0.startDate'], ['month', 'work.0.startDate']],
    '月框曾经被当成"已由年框代表"直接丢掉：页面上少填一个框，报表还看不出少了谁');
});

test('枚举选项比对：option 是 {text,value} 对象时不能一律判"对不上"', () => {
  const schema = buildFields();
  const gender = schema.find(f => f.path === 'basics.gender');
  const match = scorePair(pageField({ label: '性别', kind: 'select', options: [{ text: '男', value: 'M' }, { text: '女', value: 'F' }] }), gender);
  const miss = scorePair(pageField({ label: '性别', kind: 'select', options: [{ text: 'X', value: '1' }] }), gender);
  assert.ok(match > miss, `选项文本能对上就该加权、对不上才罚（实得 ${match} vs ${miss}）`);
});

test('标签证据不许撞到 1.0：否则结尾的封顶会把章节/槽位惩罚一起抹平', () => {
  const schema = buildFields();
  const pf = pageField({ label: '学校', sectionHint: 'education' });
  const s0 = scorePair(pf, schema.find(f => f.path === 'education.0.school'));
  const s1 = scorePair(pf, schema.find(f => f.path === 'education.1.school'));
  assert.ok(s0 > s1, `别名精确命中时第 0 条必须严格高于第 1 条（实得 ${s0} vs ${s1}）`);
  // 打平会让匈牙利按列顺序随便挑，legacy 表单的「最高学历」就是这样拿到了 education.1.degree（本科）
  const pf2 = pageField({ label: '学位', kind: 'select', sectionHint: 'education', options: [{ text: '学士' }, { text: '硕士' }] });
  const d0 = scorePair(pf2, schema.find(f => f.path === 'education.0.degree'));
  const d1 = scorePair(pf2, schema.find(f => f.path === 'education.1.degree'));
  assert.ok(d0 > d1, `带选项的枚举字段同样要保住槽位顺序（实得 ${d0} vs ${d1}）`);
});

test('附件按控件类型归因：标签叫 Resume / Transcript / 上传附件 都是 file', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'others.selfIntro', '三年经验');
  const plan = planFill([
    pageField({ label: 'Resume', name: 'resume', kind: 'file' }),
    pageField({ label: 'Transcript', name: 'transcript', kind: 'file' }),
    pageField({ label: '上传附件', name: 'att', kind: 'file' }),
  ], p, { mode: 'full' });
  assert.deepEqual(plan.gaps.map(g => g.reason), ['file', 'file', 'file'],
    '以前只靠"上传/附件"关键词，英文站的 resume/transcript 漏进来后被报成 no_candidate，用户会去补资料而不是自己上传');
  assert.equal(plan.assignments.length, 0);
});

test('英文动机问句归 subjective：which functions interest you 不是"我们没有词"', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'interests.hobbies', '跑步、篮球');
  const plan = planFill([
    pageField({ label: 'Beyond the GMAP program, which functions interest you?', name: 'beyond' }),
  ], p, { mode: 'full' });
  assert.equal(plan.gaps[0]?.reason, 'subjective');
  assert.equal(plan.assignments.length, 0, '动机题不能让机器代答，哪怕资料里有"兴趣"能蹭上');
});

test('合规问句能对上自己的槽位：Do you require sponsorship 不是工作城市', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'hkGlobal.needSponsorship', '否');
  setValueByPath(p, 'work.0.city', '上海');
  const schema = buildFields();
  const pf = pageField({
    label: 'do you require sponsorship to work in hong kong',
    labelRaw: '* Do you require sponsorship to work in Hong Kong? Yes No',
    kind: 'radio', name: 'sponsorship',
    options: [{ text: 'Yes', value: 'Y' }, { text: 'No', value: 'N' }],
  });
  const sponsorship = scorePair(pf, schema.find(f => f.path === 'hkGlobal.needSponsorship'));
  const city = scorePair(pf, schema.find(f => f.path === 'work.0.city'));
  assert.ok(sponsorship > city, `问句的中心词不是末词，别按"右分支"罚它（${sponsorship} vs ${city}）`);
  const plan = planFill([pf], p, { mode: 'full', fillSensitive: true });
  assert.equal(plan.assignments[0]?.path, 'hkGlobal.needSponsorship');
  assert.equal(plan.assignments[0]?.tier, 'review', '签证担保这类合规答复至少要你亲眼过一遍');
});

test('推断出来的记录序号不能开绿字，只能用来对齐槽位', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'work.0.company', '甲科技');
  setValueByPath(p, 'work.1.company', '乙银行');
  // 页面上第二次出现的「公司名称」，扫描器按出现次数给出 itemIndex=1（source='occurrence'）
  const second = planFill([pageField({ label: '公司名称', name: 'c2', itemIndex: 1, itemIndexSource: 'occurrence' })], p, { mode: 'full' });
  assert.equal(second.assignments[0].path, 'work.1.company', '出现次数要把槽位对齐到第 2 条');
  assert.equal(second.assignments[0].tier, 'review', '第几条知道了，"是工作还是实习"仍然不知道 → 不许绿字');
  // 同样数据，但页面自己说了这块是 work（小标题证据）→ 才允许绿字
  const titled = planFill([pageField({ label: '公司名称', name: 'c2', sectionHint: 'work', itemIndex: 1 })], p, { mode: 'full' });
  assert.equal(titled.assignments[0].tier, 'auto', 'DOM 区块序号 + 章节标题是两种真证据');
});

test('同块配对错位要说出来：第 2 次出现的标签拿到了资料里第 1 条', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'work.0.summary', '第一条的工作内容');
  setValueByPath(p, 'basics.name', '张伟');
  const plan = planFill([pageField({ label: '工作职责', name: 'duty2', itemIndex: 1, itemIndexSource: 'occurrence', sectionHint: 'work' })], p, { mode: 'full' });
  const a = plan.assignments[0];
  assert.equal(a.path, 'work.0.summary');
  assert.match(String(a.note), /第 2 次出现/, '章节标题对得上但记录序号对不上，同样是一种错位，不能只报"无法确定"');
  assert.equal(a.tier, 'review');
});

test("站点搜索框不许抢槽位：它一抢，真正的「期望岗位」就被顶到别处", () => {
  const p = createEmptyProfile();
  setValueByPath(p, "intent.position", "算法工程师");
  setValueByPath(p, "intent.cities", "上海、杭州、南京");
  setValueByPath(p, "internship.0.title", "算法实习生");
  const fields = [
    // 国聘真实形态：页面顶部的职位搜索框，没有 label，只有这种 placeholder
    pageField({ id: "job-search", placeholder: "请输入职位或企业名称" }),
    pageField({ label: "期望岗位" }),
    pageField({ label: "期望城市" }),
  ];
  const plan = planFill(fields, p, { mode: "full", fillSensitive: true });
  assert.ok(!plan.assignments.some(a => a.index === 0), "搜索框还是拿到了槽位");
  const want = plan.assignments.find(a => a.index === 1);
  assert.equal(want?.path, "intent.position", "「期望岗位」应落在求职意向，不该被当成某段经历的职位");
  assert.equal(plan.assignments.find(a => a.index === 2)?.path, "intent.cities");
  const gap = plan.gaps.find(g => g.index === 0);
  assert.equal(gap?.reason, "site_search", "搜索框要作为\"故意不填\"出现在缺口清单里，而不是静默消失");
});

test("只读框分两种：日历控件提示你去点选，站点自己算的提示无需填写", () => {
  const p = createEmptyProfile();
  setValueByPath(p, "basics.birthDate", "2001-03-15");
  const fields = [
    pageField({ label: "开始时间", placeholder: "请选择开始时间", readOnly: true }),
    pageField({ label: "出生日期（年龄）", placeholder: "", readOnly: true, id: "birth-auto" }),
  ];
  const plan = planFill(fields, p, { mode: "full" });
  assert.equal(plan.gaps.find(g => g.index === 0)?.reason, "date_picker", "日历控件要说清\"要点开选\"");
  assert.equal(plan.gaps.find(g => g.index === 1)?.reason, "readonly_control", "身份证推导出来的只读框不该提示用户去点日历");
  assert.equal(plan.assignments.length, 0, "两种都不该产生写入");
});
