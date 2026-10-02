// S6a 站点改判规则的底层测试。
//
// 这一层为什么值得单独钉：映射表里点一次「记住到本站」，用户预期是
// "以后这一页的这一栏都按我说的来"。这个预期跨三件事 ——
// ① 按栏位自述（指纹）认出同一栏，跨重载稳定；② 只在**这一个站点**生效；
// ③ 槽位必须真实存在，改判不能自造路径、更不能带取值。
// 三件事每一件都可能被"界面上看着能用"掩盖过去，所以在这里各钉一条。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RULES_BUCKET, RULES_CAP_PER_ORIGIN, normalizeRule, putRules, dropRule, dropSiteRules,
  rulesForOrigin, applySiteRules, slotChoices,
} from '../core/site-rules.js';
import { fingerprint } from '../core/ledger.js';
import { planFill } from '../core/matcher.js';
import { buildFields, createEmptyProfile, setValueByPath } from '../core/profile-schema.js';

const SCHEMA = buildFields();
const pf = (o = {}) => ({
  kind: 'text', label: '', labelRaw: '', name: '', id: '', placeholder: '',
  currentValue: '', options: [], required: false, nearbyLabels: [],
  sectionHint: '', sectionTitle: '', itemIndex: null, autocomplete: '', type: 'text', ...o,
});

const A = 'https://tupu360.example.com';
const B = 'https://workday.example.hk';

test('桶名与栏位身份：改判和台账用同一个指纹算法（两处各算一份迟早对不上）', () => {
  assert.equal(RULES_BUCKET, 'nwSiteRules');
  const field = pf({ label: 'School Name', name: 'school', id: 'f12', kind: 'text' });
  const r = putRules({}, A, [{ fp: fingerprint(field), path: 'education.0.school' }], { schemaFields: SCHEMA });
  assert.equal(r.accepted, 1, JSON.stringify(r.rejected));
  // 同一栏换个 DOM 位置（index 变了、自述没变）仍然认得出
  assert.ok(rulesForOrigin(r.rules, A)[fingerprint(pf({ label: 'School Name', name: 'school', id: 'f12' }))]);
});

test('改判只能选真实槽位：自造路径当场拒绝，并说得出为什么', () => {
  const bad = normalizeRule({ fp: 'x1', path: 'education.99.school' }, SCHEMA);
  assert.equal(bad.ok, false);
  assert.match(bad.why, /不是资料里真实存在的槽位/, `拒绝理由要能念给用户听，实得：${bad.why}`);
  assert.equal(normalizeRule({ fp: 'x1', path: 'basics.name' }, SCHEMA).ok, true);
  assert.equal(normalizeRule({ fp: '', path: 'basics.name' }, SCHEMA).ok, false, '没有指纹的规则认不出是哪一栏');
  assert.equal(normalizeRule({ fp: 'x1' }, SCHEMA).ok, false, '既没槽位也没勾「不自动填」= 空规则');
});

test('「这一栏不自动填」与指定槽位互斥；不填的那一条也要留得下理由', () => {
  const both = normalizeRule({ fp: 'x1', path: 'basics.name', skip: true }, SCHEMA);
  assert.equal(both.ok, false);
  assert.match(both.why, /只能选一个/);
  const skip = normalizeRule({ fp: 'x1', skip: true, note: '这栏是我们自己写的介绍信，别让插件碰' }, SCHEMA);
  assert.equal(skip.ok, true);
  assert.equal(skip.rule.path, '');
  assert.equal(skip.rule.skip, true);
  assert.match(skip.rule.note, /介绍信/);
});

test('规则里不许出现任何取值：存的只有「栏位指纹 → 槽位名」', () => {
  const field = pf({ label: 'Phone Number', name: 'phone', id: 'p1' });
  const { rules } = putRules({}, A, [{ fp: fingerprint(field), path: 'contact.phone', value: '13800000000' }], { schemaFields: SCHEMA });
  const txt = JSON.stringify(rules);
  assert.ok(!txt.includes('13800000000'), `规则桶里出现了简历取值：${txt}`);
  assert.deepEqual(Object.keys(rulesForOrigin(rules, A)[fingerprint(field)]).sort(), ['at', 'build', 'fp', 'note', 'path', 'skip']);
});

test('按站点分桶：在途普改的判不能跑到 Workday 上', () => {
  const field = pf({ label: 'Name', name: 'nm', id: 'n1' });
  const fp = fingerprint(field);
  const { rules } = putRules({}, A, [{ fp, path: 'basics.lastName' }], { schemaFields: SCHEMA });
  assert.ok(rulesForOrigin(rules, A)[fp]);
  assert.deepEqual(rulesForOrigin(rules, B), {}, '别的站点读到了这条改判');
  const nonHttp = putRules(rules, 'chrome-extension://abc', [{ fp, path: 'basics.name' }], { schemaFields: SCHEMA });
  assert.equal(nonHttp.accepted, 0, '非 http(s) 页面没有规则可存的地方');
  assert.match(nonHttp.rejected[0].why, /不是 http/);
});

test('被拒的每一条都带中文理由：静默丢弃等于骗用户"记住了"', () => {
  const { accepted, rejected } = putRules({}, A, [
    { fp: 'ok1', path: 'basics.name' },
    { fp: 'bad1', path: 'nonexistent.slot' },
    { fp: '', path: 'basics.name' },
  ], { schemaFields: SCHEMA });
  assert.equal(accepted, 1);
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every(r => r.why && /[\u4e00-\u9fff]/.test(r.why)), JSON.stringify(rejected));
});

test('上限：一站点超量时丢最旧的，站点数超量时丢最久没用的', () => {
  let rules = {};
  for (let i = 0; i < RULES_CAP_PER_ORIGIN + 20; i++) {
    const r = putRules(rules, A, [{ fp: `fp${i}`, path: 'basics.name' }], { schemaFields: SCHEMA, at: 1000 + i });
    rules = r.rules;
  }
  const mine = rulesForOrigin(rules, A);
  assert.equal(Object.keys(mine).length, RULES_CAP_PER_ORIGIN);
  assert.ok(!mine.fp0, '最旧那条该被丢掉');
  assert.ok(mine[`fp${RULES_CAP_PER_ORIGIN + 19}`], '最新那条必须在');
});

test('删除：单条取消记住、整站忘记、清空全部，各删各的', () => {
  const { rules } = putRules({}, A, [{ fp: 'a1', path: 'basics.name' }, { fp: 'a2', path: 'basics.lastName' }], { schemaFields: SCHEMA });
  const afterOne = dropRule(rules, A, ['a1']);
  assert.equal(rulesForOrigin(afterOne, A).a1, undefined, '点名的那条要没了');
  assert.ok(rulesForOrigin(afterOne, A).a2, '没点名的那条不能顺手删掉');
  assert.deepEqual(rulesForOrigin(dropSiteRules(rules, A), A), {});
  assert.deepEqual(dropSiteRules(rules, ''), {}, 'origin 传空 = 清空全部改判');
});

test('套用到扫描结果：认得出的栏给 pins，自述相同的两栏一起命中并说出来', () => {
  const one = pf({ label: 'Organization Name', name: 'org', id: 'o1' });
  const other = pf({ label: 'Referrer Name', name: 'ref', id: 'r1' });
  // 真站点上出现过的情形：同一个组件复制出来的两栏，id 都叫 "value"、name 都叫 "x"
  const dupA = pf({ label: 'Name', name: 'x', id: 'value' });
  const dupB = pf({ label: 'Name', name: 'x', id: 'value' });
  assert.equal(fingerprint(dupA), fingerprint(dupB), '这两栏自述完全相同才有下面的语义');
  const fp = fingerprint(one);
  const rules = { [fp]: { fp, path: 'projects.0.name' }, [fingerprint(dupA)]: { fp: fingerprint(dupA), path: 'basics.name', skip: true } };
  const { pins, covered } = applySiteRules([one, other, dupA, dupB], rules);
  assert.equal(pins.get(0).path, 'projects.0.name');
  assert.equal(pins.has(1), false, '没改判过的栏不该被牵上');
  assert.equal(pins.get(2).skip, true);
  assert.equal(pins.get(3).skip, true, '两栏自述相同时规则对它们一起生效（不假装能区分）');
  assert.equal(pins.get(3).shared, 2, '撞车要在界面上说得出：' + JSON.stringify(pins.get(3)));
  assert.equal(covered, 3);
});

test('改判下拉的候选只出自真实槽位：搜得出、限得住、造不出来', () => {
  const hits = slotChoices(SCHEMA, '学校', 20);
  assert.ok(hits.length > 0 && hits.every(h => SCHEMA.some(f => f.path === h.path)));
  assert.ok(hits.every(h => /学校|school/i.test(`${h.zh} ${h.path}`)), JSON.stringify(hits.slice(0, 5)));
  assert.equal(slotChoices(SCHEMA, '', 3).length, 3, 'limit 要真起作用（519 个槽位摊成一个下拉是没法的）');
  assert.deepEqual(slotChoices(SCHEMA, '这个资料里绝对没有的词'), []);
});

/** ── planFill 穿线：规则进得了计划，也越不过硬边界 ───────────────── */
test('planFill 认改判：钉到用户点的槽位，来历写进 note；资料空着就说空着', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'certifications.0.name', 'CFA Level II');
  // 挑一个本地词典本来就认不出来的说法（'Awarding Body' 单栏页面 → no_candidate），
  // 否则"改判生效"这件事没法和"反正也猜对了"区分开
  const field = pf({ label: 'Awarding Body', name: 'award', id: 'a1' });
  const alone = planFill([field], p, { mode: 'full' });
  assert.equal(alone.assignments.find(a => a.index === 0)?.path, undefined, '这条用例的前提没了：不打改判它现在也能认出来');

  const rules = { [fingerprint(field)]: { fp: fingerprint(field), path: 'certifications.0.name', skip: false, note: '这里问的是证书名称不是颁发机构' } };
  const withRule = planFill([field], p, { mode: 'full', siteRules: rules });
  const hit = withRule.assignments.find(a => a.index === 0);
  assert.equal(hit?.path, 'certifications.0.name', `改判没生效（实得 ${hit?.path}）`);
  assert.equal(hit?.pinnedBy, 'siteRule', '来历要写清楚，导出里不能混成"适配器说的"');
  assert.match(String(hit?.note || ''), /按你在这站点的改判/);
  assert.match(String(hit?.note || ''), /证书名称/, '用户当时写的理由要带回来');

  const empty = planFill([field], createEmptyProfile(), { mode: 'full', siteRules: rules });
  const gap = empty.gaps.find(g => g.index === 0);
  assert.equal(gap?.reason, 'pinned_field_empty', '改判钉住槽位但不造值：资料空着照旧说空着');
  assert.match(String(gap?.note || ''), /改判/);
});

test('「不自动填」的规则：这一栏进缺口、带 user_excluded，且一个字节都不写', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', '张三');
  const field = pf({ label: 'Full Name', name: 'nm', id: 'z1' });
  const rules = { [fingerprint(field)]: { fp: fingerprint(field), path: '', skip: true, note: '' } };
  const plan = planFill([field], p, { mode: 'full', siteRules: rules });
  assert.equal(plan.assignments.length, 0, '勾了不填还写，就是没把用户的决定当回事');
  assert.equal(plan.gaps.find(g => g.index === 0)?.reason, 'user_excluded');
});

test('硬边界压过改判：验证码/声明/附件这类栏，用户点了也不填', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', '张三');
  const captcha = pf({ label: '输入右侧验证码', name: 'captcha', id: 'c1' });
  const rules = { [fingerprint(captcha)]: { fp: fingerprint(captcha), path: 'basics.name', skip: false } };
  const plan = planFill([captcha], p, { mode: 'full', siteRules: rules });
  assert.equal(plan.assignments.length, 0, `改判绕过了"永不代做"：${JSON.stringify(plan.assignments)}`);
  assert.ok(['captcha', 'consent_declaration', 'subjective', 'file'].includes(plan.gaps[0]?.reason) || plan.gaps[0], '至少要给出拒绝的理由');
});

test('敏感槽位的改判仍要「允许填写敏感字段」：点一下不等于授权', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.idNumber', '110101200103150011');
  const field = pf({ label: 'ID Number', name: 'idno', id: 'i1' });
  const rules = { [fingerprint(field)]: { fp: fingerprint(field), path: 'basics.idNumber', skip: false } };
  const off = planFill([field], p, { mode: 'full', siteRules: rules });
  assert.equal(off.assignments.length, 0, '没勾授权就把证件号写进页面');
  assert.equal(off.gaps.find(g => g.index === 0)?.reason, 'sensitive_withheld');
  const on = planFill([field], p, { mode: 'full', fillSensitive: true, siteRules: rules });
  assert.equal(on.assignments.find(a => a.index === 0)?.path, 'basics.idNumber', '勾了就该按改判写');
});

test('适配器钉位与人工改判同时存在时：改判说了算（人来过就不必先验）', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.lastName', '张');
  setValueByPath(p, 'basics.name', '张三');
  const field = pf({ label: 'Name', name: 'nm', id: 'n9' });
  const adapter = {
    id: 'test-site',
    pins: [{ match: 'Name', path: 'basics.name', note: '适配器说这是全名' }],
  };
  const rules = { [fingerprint(field)]: { fp: fingerprint(field), path: 'basics.lastName', skip: false, note: '这一栏其实是姓' } };
  const plan = planFill([field], p, { mode: 'full', adapter, siteRules: rules, fillSensitive: true });
  assert.equal(plan.assignments.find(a => a.index === 0)?.path, 'basics.lastName', '改判没压过适配器');
  assert.match(String(plan.assignments.find(a => a.index === 0)?.note || ''), /改判/, '压过适配器这件事要在来历里看得见');
});
