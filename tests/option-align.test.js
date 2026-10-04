// 认选项（档 A + 档 C）的纯函数回归：请求里到底有没有取值、回答能不能越界、决定怎么并进 plan。
//
// 这一组断言的靶心是两句话：
//  「AI 只能选页面已有的那一项」—— 落笔的文字永远来自页面选项，模型给的任何字符串都不进值；
//  「勾选框没开就没有取值出门」—— 闸写在构造函数里，不靠调用方自觉。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildOptionAlignRequest, parseOptionAlignReply, decideByToken, decisionsFromReply, applyOptionDecisions, findOptionByExpect } from '../core/option-align.js';
import { assertNoProfileValues, AI_FORBIDDEN_KEY } from '../core/ai.js';
import { shareableValue, valueShareBlocked, VALUE_SHARE_NEVER_SECTIONS, PERSON_SECTIONS } from '../core/ai-security.js';
import { buildFields, createEmptyProfile, setValueByPath } from '../core/profile-schema.js';
import { fingerprint } from '../core/ledger.js';

const SCHEMA = buildFields();
const ID = { 'basics.name': '欧唯一测试', 'basics.idNumber': '110101199003079876', 'contact.phone': '13800001111' };

function profile() {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.gender', '女');
  setValueByPath(p, 'basics.degree', '硕士');
  setValueByPath(p, 'hkGlobal.workAuth', 'IANG（内地应届毕业生留港计划）');
  setValueByPath(p, 'education.0.trainingMode', '非全日制');
  for (const [k, v] of Object.entries(ID)) setValueByPath(p, k, v);
  return p;
}
const p0 = profile();

const targetWorkAuth = {
  fp: 'fp_workauth', path: 'hkGlobal.workAuth', slotZh: '工作许可身份', label: 'Right of Work in Hong Kong',
  section: 'Work Authorization', space: 'rightToWork', ourValue: 'IANG（内地应届毕业生留港计划）',
  options: ['Hong Kong Permanent Resident', 'Employment Visa (employer-tied)', 'Returnee Undergraduate Scheme', 'Require Sponsorship'],
};
const targetGender = {
  fp: 'fp_gender', path: 'basics.gender', slotZh: '性别', label: '性别', section: '基本信息',
  space: 'gender', ourValue: '女', options: ['男=1', '女=2', '保密=3'],
};

test('默认（没勾允许看取值）：请求里有页面选项与代号词表，没有我们的取值', () => {
  const req = buildOptionAlignRequest({ targets: [targetWorkAuth, targetGender] });
  assert.equal(req.mode, 'tokens');
  assert.ok(req.text.includes('Returnee Undergraduate Scheme'), '页面选项文字该发出去');
  assert.ok(/IANG/.test(req.text) && req.text.includes('MALE'), '代号词表该在请求里');
  assert.ok(!req.text.includes('女=2') === false, '选项码值也发（这是页面的东西）');
  for (const v of ['IANG（内地应届毕业生留港计划）', '欧唯一测试', '13800001111']) {
    assert.ok(!req.text.includes(v), `待发文本里出现了取值：${v}`);
  }
  assert.equal(req.sharedPaths.length, 0);
  // 同一条文本过一遍外发自检：应当一处泄漏都没有
  assert.deepEqual(assertNoProfileValues(req.text, p0, { exempt: [req.vocabText], pageTokens: req.pageTokens }), []);
});

test('勾了「允许 AI 看取值」：这一栏的取值进了请求，其余照旧不进', () => {
  const req = buildOptionAlignRequest({ targets: [targetGender], allowValues: true });
  assert.equal(req.mode, 'values');
  assert.ok(req.text.includes('"ourValue":"女"'), '取值没进请求，说明勾选框是装饰');
  assert.deepEqual(req.sharedPaths, ['basics.gender']);
  const leaks = assertNoProfileValues(req.text, p0, {
    exempt: [req.vocabText], pageTokens: req.pageTokens, allowValues: ['女'],
  });
  assert.deepEqual(leaks, []);
});

test('闸在构造函数里：调用方把 ourValue 传进来，没开勾选框一样发不出去', () => {
  const req = buildOptionAlignRequest({ targets: [targetWorkAuth], allowValues: false });
  assert.ok(!req.text.includes('IANG（内地应届毕业生留港计划）'));
  assert.ok(!/"ourValue"/.test(req.text), '没开档 C 却带着 ourValue 字段');
  assert.equal(req.mode, 'tokens');
});

test('硬排除清单：姓名/姓/名/证件号/电话/家人那两栏，开了档 C 也不发；项目名照发', () => {
  const by = new Map(SCHEMA.map(f => [f.path, f]));
  for (const path of ['basics.name', 'basics.lastName', 'basics.firstName', 'basics.nameEn', 'basics.idNumber',
    'basics.passportNumber', 'contact.phone', 'contact.altPhone', 'contact.emergencyName', 'contact.emergencyPhone',
    'family.0.name', 'family.0.phone', 'hkGlobal.referenceName1', 'intent.referralName', 'hkGlobal.idForWork',
    'records.noCriminal', 'declaration.something']) {
    const f = by.get(path);
    if (!f) continue;                                    // 不存在的栏位由别的测试管
    assert.ok(valueShareBlocked(f), `${path}（${f.zh}）居然允许外发取值`);
  }
  for (const path of ['basics.gender', 'education.0.degree', 'hkGlobal.visaType', 'projects.0.name',
    'work.0.company', 'certifications.0.name', 'contact.city']) {
    const f = by.get(path);
    assert.equal(valueShareBlocked(f), '', `${path}（${f.zh}）不该被拦：它不在用户给的清单里`);
  }
  // 这一条**比用户的清单严**，是刻意选的：资料里自己标了敏感的栏位不外发。
  // 方向是"少发"，而且每一栏被拦的原因都会逐条报在界面上，不静默；
  // 他要放开哪一栏，改 VALUE_SHARE_NEVER 或改标记即可（不是改调用方）。
  for (const path of ['contact.email', 'basics.birthDate']) {
    const f = by.get(path);
    assert.ok(valueShareBlocked(f), `${path}（${f.zh}）本该被"敏感"这道兜底拦下`);
  }
  // 独立审查（2026-10-04）点出的漏口：别人的名字与各类编号、长正文
  for (const path of ['education.0.supervisor', 'work.0.reportsTo', 'certifications.0.number',
    'education.0.studentNumber', 'work.0.summary', 'others.selfIntro']) {
    // 这里不许 continue：栏位名写错就等于这条断言不存在（上一版就是这么漏过去的）
    const f = by.get(path);
    assert.ok(f, `用例里的栏位 ${path} 在资料结构里不存在：这条断言是空的`);
    assert.ok(valueShareBlocked(f), `${path}（${f.zh}）居然可发：那是别人的名字或一段正文`);
  }
  // 板块名必须真的存在（写错的规则恒不命中，比没写还坏）
  const sections = new Set(SCHEMA.map(f => f.section));
  for (const s of [...VALUE_SHARE_NEVER_SECTIONS, ...PERSON_SECTIONS]) {
    assert.ok(sections.has(s), `排除清单里的板块名 ${s} 在资料结构里不存在（幻影规则）`);
  }
  // 拦下的那一栏即使被塞进 targets，shareableValue 也不给值（SW 靠它决定发不发）
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', '欧唯一测试');
  setValueByPath(p, 'contact.phone', '13800001111');
  setValueByPath(p, 'education.0.degree', '硕士');
  for (const path of ['basics.name', 'contact.phone']) {
    assert.equal(shareableValue(p, path, { schemaFields: SCHEMA }).ok, false, `${path} 的取值居然可发`);
  }
  assert.equal(shareableValue(p, 'education.0.degree', { schemaFields: SCHEMA }).ok, true);
  // 空槽不发：没有值可比，也更少一个字出门
  assert.equal(shareableValue(p, 'basics.preferredName', { schemaFields: SCHEMA }).ok, false);
  // 沿用既有 AI 禁入名单：薪酬期望这类即使形状不在硬清单里，也照样拦
  assert.equal(shareableValue(p, 'intent.salary', { schemaFields: SCHEMA, forbiddenRe: AI_FORBIDDEN_KEY }).ok, false);
});

test('回答越界一律丢：清单外的代号、没问过的栏、页面上没有的下标、它自己改口的任务', () => {
  const req = buildOptionAlignRequest({ targets: [targetWorkAuth, targetGender] });
  const good = JSON.stringify({ fields: [
    { index: 0, task: 'label', options: [{ i: 2, token: 'IANG' }, { i: 0, token: 'HK_PERMANENT_RESIDENT' }] },
    { index: 1, task: 'label', options: [{ i: 1, token: 'FEMALE' }] },
  ] });
  const ok = parseOptionAlignReply(good, { targets: req.targets });
  assert.equal(ok.labels.length, 2);
  assert.equal(ok.labels[0].tokens[2], 'IANG');
  assert.equal(ok.picks.length, 0);
  // 协议要害：我们没让它 pick（这一栏的取值根本没出门），它自己改口也不许算。
  // 否则"代号相同才落笔"这条规矩由模型决定，档 A 就成了它可以随手写一栏的通道。
  const talked = parseOptionAlignReply(
    JSON.stringify({ fields: [{ index: 0, task: 'pick', pick: 2, reason: '我看着像' }] }), { targets: req.targets });
  assert.equal(talked.picks.length, 0, 'label 任务的栏位接受了模型自己改口的 pick');
  assert.ok(talked.dropped.some(d => d.why === 'task_mismatch'), `没记下任务不符：${JSON.stringify(talked.dropped)}`);
  const bad = JSON.stringify({ fields: [
    { index: 99, task: 'label', options: [] },
    { index: 0, task: 'label', options: [{ i: 1, token: 'MASTER_OR_SOMETHING' }, { i: 77, token: 'IANG' }] },
  ] });
  const r = parseOptionAlignReply(bad, { targets: req.targets });
  assert.equal(r.picks.length, 0, '越界下标被接受了');
  assert.equal(r.labels.length, 0);
  const why = r.dropped.map(d => d.why);
  for (const want of ['index_unknown', 'token_unknown', 'option_out_of_range']) {
    assert.ok(why.includes(want), `没记下 ${want}：${why.join(',')}`);
  }
  assert.ok(parseOptionAlignReply('模型在那儿讲故事，没有 JSON', { targets: req.targets }).dropped[0].why === 'unparsable');
  const decl = parseOptionAlignReply(JSON.stringify({ fields: [{ index: 0, task: 'label', options: [{ i: 0, token: null }] }] }), { targets: req.targets });
  assert.equal(decl.declined.length, 1, '它说"归不进代号"是有效回答，要记成 declined');
});

test('档 C 的 pick 只在"我们让它挑"的栏位上算数；下标按发出去的条数校验（削档不越权）', () => {
  const req = buildOptionAlignRequest({ targets: [targetGender], allowValues: true });
  assert.equal(req.targets[0].askTask, 'pick');
  const ok = parseOptionAlignReply(JSON.stringify({ fields: [{ index: 0, task: 'pick', pick: 1 }] }), { targets: req.targets });
  assert.equal(ok.picks.length, 1);
  assert.equal(ok.picks[0].expect, '女=2', '落成的是我们发出去的那一条原文');
  // 反过来：pick 任务里它改口发 label，也不算
  const off = parseOptionAlignReply(
    JSON.stringify({ fields: [{ index: 0, task: 'label', options: [{ i: 1, token: 'FEMALE' }] }] }), { targets: req.targets });
  assert.equal(off.labels.length, 0);
  assert.ok(off.dropped.some(d => d.why === 'task_mismatch'));
  // 体积削档之后：本地有 30 项、只发出去 2 项，模型指第 5 项必须丢
  const trimmed = {
    fp: 'x', path: 'basics.gender', label: '性别', space: 'gender', askTask: 'label',
    options: Array.from({ length: 30 }, (_, i) => `OPT${i}`),
    sentOptions: ['OPT0', 'OPT1'],
  };
  const r = parseOptionAlignReply(
    JSON.stringify({ fields: [{ index: 0, task: 'label', options: [{ i: 5, token: 'MALE' }] }] }), { targets: [trimmed] });
  assert.equal(r.labels.length, 0, '按本地全量校验下标：削档后模型可以指到我们没发出去的项');
  assert.ok(r.dropped.some(d => d.why === 'option_out_of_range'));
  // 构造函数把"发出去了哪几条"记在 target 上，且与请求体里的确实是同一份
  const built = buildOptionAlignRequest({ targets: [{ ...targetWorkAuth, options: Array.from({ length: 60 }, (_, i) => `OPT${i}`) }] });
  assert.ok(built.targets[0].sentOptions.length <= 30, `没削减时也该有上限：${built.targets[0].sentOptions.length}`);
  assert.ok(built.text.includes(built.targets[0].sentOptions[0]), '发出去的和记下来的不是同一份');
});

test('代号相同才落笔：一项都对不上、或两项都说得通，都不落', () => {
  const req = buildOptionAlignRequest({ targets: [targetWorkAuth] });
  const t = req.targets[0];
  const uniq = decisionsFromReply({ req, labels: [{ index: 0, fp: t.fp, tokens: { 2: 'IANG', 0: 'HK_PERMANENT_RESIDENT' } }] });
  assert.equal(uniq.decisions.length, 1);
  assert.equal(uniq.decisions[0].expect, 'Returnee Undergraduate Scheme');
  assert.equal(uniq.decisions[0].token, 'IANG');
  const two = decisionsFromReply({ req, labels: [{ index: 0, fp: t.fp, tokens: { 1: 'IANG', 2: 'IANG' } }] });
  assert.equal(two.decisions.length, 0);
  assert.equal(two.unresolved[0].why, 'ambiguous');
  const none = decisionsFromReply({ req, labels: [{ index: 0, fp: t.fp, tokens: { 0: 'HK_PERMANENT_RESIDENT' } }] });
  assert.equal(none.unresolved[0].why, 'none');
  // 取值折不出代号 = 这一栏根本没资格走档 A
  assert.equal(decideByToken({ target: { ...t, ourValue: '说不清' }, tokens: { 2: 'IANG' } }).how, 'no_token');
});

test('落到真页面上：写的是页面选项自己的码值，不是模型给的文字', () => {
  const fields = [{
    kind: 'select', label: 'Right of Work in Hong Kong', name: 'wa', id: 'wa', multi: false,
    options: [{ text: 'Hong Kong Permanent Resident', value: '1' }, { text: 'Employment Visa (employer-tied)', value: '2' },
      { text: 'Returnee Undergraduate Scheme', value: '3' }],
  }];
  const fp = fingerprint(fields[0]);
  const mkPlan = () => ({
    assignments: [{ index: 0, path: 'hkGlobal.workAuth', tier: 'review', needsChoice: true, note: '页面选项与你的资料无对应，需人工选择' }],
    gaps: [], stats: { planned: 1, auto: 0, review: 1 },
  });
  const plan = mkPlan();
  // 起点刻意用 tier:'auto'：这一栏在真流程里也可能是"本地没判成 needsChoice、但也没写出 optionValue"
  // 的形状（例如整页概念映射把槽位改判到一枚下拉上）。从 review 起步的话，
  // "强制核对"那行删掉测试照样绿 —— 本仓库为这种假绿摔过三次。
  plan.assignments[0].tier = 'auto';
  const r = applyOptionDecisions(plan, [{ fp, expect: 'Returnee Undergraduate Scheme', mode: 'values', space: 'rightToWork' }], { fields });
  assert.equal(r.applied, 1, JSON.stringify(r.refused));
  assert.equal(plan.assignments[0].optionValue, '3', '写的必须是页面自己的码值');
  assert.equal(plan.assignments[0].aiOption, true);
  assert.equal(plan.assignments[0].tier, 'review', '工作权利/签证类是一句合规声明，保持核对');
  assert.ok(!plan.assignments[0].needsChoice);
  assert.ok(plan.assignments[0].note.includes('Returnee Undergraduate Scheme'));
  assert.ok(!plan.assignments[0].note.includes('IANG（内地'), 'note 里不许出现取值：它会随诊断导出离开本机');
});

test('四条 refusal 各自会红：本地已认出的不覆盖、多选的不动、指纹撞车与选项消失都不落', () => {
  const one = { kind: 'select', label: 'L1', name: 'a', id: 'a', multi: false, options: [{ text: '甲', value: 'A' }, { text: '乙', value: 'B' }] };
  const same = { ...one };                                   // 指纹只由页面文字算：两栏同标签同属性 → 撞车
  const multi = { ...one, multi: true, id: 'c', name: 'c' };
  const decided = { ...one, id: 'd', name: 'd' };
  const fields = [one, same, multi, decided];
  const plan = {
    assignments: [
      { index: 0, path: 'p.a', tier: 'auto' },
      { index: 2, path: 'p.m', tier: 'auto' },
      { index: 3, path: 'p.d', tier: 'auto', optionValue: 'A' },
    ],
    gaps: [], stats: { planned: 3, auto: 3, review: 0 },
  };
  const d = fpn => ({ mode: 'tokens', expect: '甲', fp: fpn });
  const r = applyOptionDecisions(plan, [d(fingerprint(one)), d(fingerprint(multi)), d(fingerprint(decided))], { fields });
  const why = r.refused.map(x => x.why);
  assert.equal(r.applied, 0, `一条都不该落成：${JSON.stringify(r.changed)}`);
  assert.ok(why.includes('ambiguous_fp'), `没认出指纹撞车：${why.join(',')}`);
  assert.ok(why.includes('multi'), `没拒多选：${why.join(',')}`);
  assert.ok(why.includes('already_local'), `覆盖了本地已认出的那一栏：${why.join(',')}`);
  const gone = applyOptionDecisions({ assignments: [{ index: 0, path: 'p', tier: 'auto' }], gaps: [], stats: {} },
    [{ fp: 'not-on-this-page', expect: '甲', mode: 'tokens' }], { fields: [one] });
  assert.deepEqual(gone.refused[0].why, 'fp_gone');
  const stale = applyOptionDecisions({ assignments: [{ index: 0, path: 'p', tier: 'auto' }], gaps: [], stats: {} },
    [{ fp: fingerprint(one), expect: '丙（重扫之后没了）', mode: 'tokens' }], { fields: [one] });
  assert.deepEqual(stale.refused[0].why, 'option_gone');
});

test('按截断过的文字回找选项：撞成两项就不落，唯一命中才落', () => {
  const opts = [{ text: '全日制统招（普通）' }, { text: '全日制自考本科' }];
  assert.equal(findOptionByExpect(opts, '全日制')?.ambiguous, true);
  assert.equal(findOptionByExpect(opts, '全日制自考本科')?.text, '全日制自考本科');
  assert.equal(findOptionByExpect(opts, '半吊子'), null);
  assert.equal(findOptionByExpect(opts, ''), null, '空文字等于"任意一项"，必须拒');
  // 自定义选项没有 value 时取文案本身
  assert.equal(findOptionByExpect(opts, '全日制自…')?.text, '全日制自考本科');
  /**
   * 真实链路上的 expect 是从映射表那一栏来的：那里文案裁到 40 字、码值裁到 24 字，
   * 省略号落在**中间**（`长文案…=码值`）。只剥尾省略号的写法在这类栏上永远比不中，
   * 表现是"AI 认出来了、页面却没动静"（独立审查 I5）。
   */
  const long = [{ text: 'Immigration Arrangements for Non-local Graduates (Returnee)', value: 'R' },
    { text: 'Employment Visa tied to sponsor', value: 'S' }];
  const clipped = 'Immigration Arrangements for Non-local Grad…=R';
  assert.equal(findOptionByExpect(long, clipped)?.value, 'R', '裁过的文案对中不了真选项');
  assert.equal(findOptionByExpect(long, 'Immigration Arrangements for Non-local Grad…')?.value, 'R');
  assert.equal(findOptionByExpect(long, 'E…=S')?.value, 'S');
});
