// 认选项（档 A + 档 C）的纯函数回归：请求里到底有没有取值、回答能不能越界、决定怎么并进 plan。
//
// 这一组断言的靶心是两句话：
//  「AI 只能选页面已有的那一项」—— 落笔的文字永远来自页面选项，模型给的任何字符串都不进值；
//  「勾选框没开就没有取值出门」—— 闸写在构造函数里，不靠调用方自觉。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildOptionAlignRequest, parseOptionAlignReply, decideByToken, decisionsFromReply, applyOptionDecisions, findOptionByExpect } from '../core/option-align.js';
import { assertNoProfileValues, AI_FORBIDDEN_KEY } from '../core/ai.js';
import { shareableValue, valueShareBlocked } from '../core/ai-security.js';
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
    'work.0.company', 'certifications.0.name', 'contact.email', 'contact.city']) {
    const f = by.get(path);
    assert.equal(valueShareBlocked(f), '', `${path}（${f.zh}）不该被拦：它不在用户给的清单里`);
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

test('回答越界一律丢：清单外的代号、没问过的栏、页面上没有的下标', () => {
  const req = buildOptionAlignRequest({ targets: [targetWorkAuth, targetGender] });
  const good = JSON.stringify({ fields: [
    { index: 0, task: 'label', options: [{ i: 2, token: 'IANG' }, { i: 0, token: 'HK_PERMANENT_RESIDENT' }] },
    { index: 1, task: 'pick', pick: 1 },
  ] });
  const ok = parseOptionAlignReply(good, { targets: req.targets });
  assert.equal(ok.labels[0].tokens[2], 'IANG');
  assert.equal(ok.picks.length, 1, '下标在范围内的 pick 该被接受');
  const bad = JSON.stringify({ fields: [
    { index: 99, task: 'label', options: [] },
    { index: 0, task: 'label', options: [{ i: 1, token: 'MASTER_OR_SOMETHING' }, { i: 77, token: 'IANG' }] },
    { index: 1, task: 'pick', pick: 9 },
  ] });
  const r = parseOptionAlignReply(bad, { targets: req.targets });
  assert.equal(r.picks.length, 0, '越界下标被接受了');
  assert.equal(r.labels.length, 0);
  const why = r.dropped.map(d => d.why);
  for (const want of ['index_unknown', 'token_unknown', 'option_out_of_range', 'pick_out_of_range']) {
    assert.ok(why.includes(want), `没记下 ${want}：${why.join(',')}`);
  }
  assert.ok(parseOptionAlignReply('模型在那儿讲故事，没有 JSON', { targets: req.targets }).dropped[0].why === 'unparsable');
  const decl = parseOptionAlignReply(JSON.stringify({ fields: [{ index: 0, task: 'label', options: [{ i: 0, token: null }] }] }), { targets: req.targets });
  assert.equal(decl.declined.length, 1, '它说"归不进代号"是有效回答，要记成 declined');
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
});
