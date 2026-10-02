// S1 写入台账：分清"这一栏的值是我们写的"还是"站点预填 / 用户手填"。
// 存在的理由（用户 2026-10-02）："AI 填写不能修改已填过的错误的" ——
// 旧行为是"框里有字就跳过"，于是上一轮我们写错的那一栏永久留着，连导出里都不出现。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  fingerprint, hashValue, classify, recordWrites, forgetWrites, ledgerRecord,
  LEDGER_CAP_PER_ORIGIN,
} from '../core/ledger.js';
import { planFill, gapReasonLabel } from '../core/matcher.js';
import { scanForm } from '../dom/scanner.js';
import { applyPlan } from '../dom/filler.js';
import { createEmptyProfile, setValueByPath } from '../core/profile-schema.js';

const ORIGIN = 'https://careersite.tupu360.test';
const doc = html => new JSDOM(`<!doctype html><html><body>${html}</body></html>`,
  { url: `${ORIGIN}/x`, pretendToBeVisual: true }).window.document;

test('指纹稳定：同一栏描述换个写法也算同一栏；题目或板块变了就是另一栏', () => {
  const a = fingerprint({ label: 'school name', labelRaw: 'School Name', kind: 'text', name: 'school', id: '' });
  const b = fingerprint({ label: 'school name', labelRaw: 'SCHOOL  NAME', kind: 'text', name: 'school', id: '' });
  assert.equal(a, b, '大小写与多余空白不该改变身份');
  const c = fingerprint({ label: 'certificate name', labelRaw: 'Certificate Name', kind: 'text', name: 'school', id: '' });
  assert.notEqual(a, c, '题目变了就是另一栏');
  const withSection = fingerprint({ label: 'school name', kind: 'text', name: 'school', sectionTitle: 'Education' });
  assert.notEqual(a, withSection, '同题不同板块必须是两栏（否则证书的学校会盖掉学历的学校）');
});

test('hashValue 只回答"变没变"，不还原取值', () => {
  assert.equal(hashValue('张三'), hashValue('张三'));
  assert.notEqual(hashValue('张三'), hashValue('张 三'));
  assert.equal(hashValue(''), hashValue(undefined), '空值与缺失该是同一个哈希');
});

test('classify：us / edited / other / empty 四种归属，账本按站点分桶', () => {
  const f = { label: 'name', labelRaw: 'Name', kind: 'text', name: 'nm' };
  const ledger = recordWrites({}, ORIGIN, [{ fp: fingerprint(f), path: 'basics.name', valueHash: hashValue('欧阳') }]);
  assert.ok(ledger[ORIGIN], '账本必须按 origin 分桶（别的站点的写入不能算数）');
  assert.equal(classify(f, '', ledger, ORIGIN), 'empty', '空框就是待填');
  assert.equal(classify(f, '欧阳', ledger, ORIGIN), 'us', '与我们写的一致 → 是我们的');
  assert.equal(classify(f, '用户自己改的', ledger, ORIGIN), 'edited', '值被人改过就别再当我们的');
  assert.equal(classify(f, '欧阳', ledger, 'https://other.test'), 'other', '换个站点这条账不作数');
  assert.equal(classify({ label: 'email', kind: 'text' }, 'a@b.test', ledger, ORIGIN), 'other', '没写过的非空值 = 别人填的');
});

test('账本有上限，且不把明文取值留在里面；撤销能擦干净', () => {
  let ledger = {};
  for (let i = 0; i < LEDGER_CAP_PER_ORIGIN + 30; i++) {
    ledger = recordWrites(ledger, ORIGIN, [{ fp: `fp${i}`, path: 'basics.name', valueHash: hashValue(`值${i}`) }]);
  }
  const mine = ledger[ORIGIN];
  assert.equal(Object.keys(mine).length, LEDGER_CAP_PER_ORIGIN, '投过的栏位不能无限涨');
  assert.ok(mine[`fp${LEDGER_CAP_PER_ORIGIN + 29}`], '留最新的');
  assert.ok(!mine.fp0, '最旧的先丢');
  assert.ok(!JSON.stringify(ledger).includes('值12'), '账本里不许出现明文取值');
  const cleared = forgetWrites(ledger, ORIGIN, [`fp${LEDGER_CAP_PER_ORIGIN + 29}`]);
  assert.ok(!cleared[ORIGIN][`fp${LEDGER_CAP_PER_ORIGIN + 29}`], '撤销后这条账要真的擦掉');
});

test('增量模式：我们上轮写错的值会被重新计划并覆盖；用户手填的照旧不动', async () => {
  const d = doc(`<form>
    <label for="a">Name</label><input id="a" name="nm" type="text">
    <label for="b">School Name</label><input id="b" name="school" type="text">
  </form>`);
  const fields = scanForm(d);
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', 'OUYANG Zhonghua');
  setValueByPath(p, 'education.0.school', 'South China University of Technology');

  // 现场：姓名栏被"上一轮的我们"写成了学校名（错值），学校栏由用户自己填好了
  const idxName = fields.findIndex(f => f.label === 'name');
  const idxSchool = fields.findIndex(f => f.label === 'school name');
  await applyPlan(fields, [
    { index: idxName, path: 'basics.name', label: 'Name', value: 'South China University of Technology', tier: 'auto' },
    { index: idxSchool, path: 'education.0.school', label: 'School Name', value: '用户自己填的大学', tier: 'auto' },
  ], {});
  const cur = i => String(fields[i].el.value || '').trim();
  assert.equal(cur(idxName), 'South China University of Technology', '铺垫现场失败');

  // 台账里只有姓名那一栏记成"我们写的"
  const ledger = recordWrites({}, ORIGIN, [
    { fp: fingerprint(fields[idxName]), path: 'basics.name', valueHash: hashValue(cur(idxName)) },
  ]);

  // 重新扫一遍：currentValue 必须像用户再次点「扫描」时那样是页面上的现值
  const fields2 = scanForm(d);
  const iName = fields2.findIndex(f => f.label === 'name');
  const iSchool = fields2.findIndex(f => f.label === 'school name');
  assert.equal(String(fields2[iName].currentValue || ''), 'South China University of Technology', '重新扫描没读到现值');
  const plan = planFill(fields2, p, { mode: 'incremental', ledger, pageOrigin: ORIGIN, fillSensitive: true });
  const skipSchool = plan.assignments.find(a => a.index === iSchool && a.skip);
  assert.ok(skipSchool, '用户手填的那栏必须继续跳过：我们不覆盖别人的东西');
  const redo = plan.assignments.find(a => a.index === iName && !a.skip);
  assert.ok(redo, `我们上一轮写错的值必须被重新排入计划：${JSON.stringify(plan.assignments)} / ${JSON.stringify(plan.gaps)}`);
  assert.equal(redo.path, 'basics.name');
  assert.equal(redo.overwrites, 'ours');
  assert.match(redo.note, /上一轮|覆盖/, redo.note);

  // 真写一遍：错的被改成对的，用户手填的纹丝不动
  await applyPlan(fields2, plan.assignments.filter(a => !a.skip), { fillSensitive: true });
  assert.equal(String(fields2[iName].el.value || '').trim(), 'OUYANG Zhonghua', '覆盖没生效');
  assert.equal(String(fields2[iSchool].el.value || '').trim(), '用户自己填的大学', '把用户填的改了：越界');
});

test('值没变就不必再敲一遍：同一槽位同一个值 → already_ours 跳过', () => {
  const d = doc(`<form><label for="a">Name</label><input id="a" name="nm" type="text"></form>`);
  const fields = scanForm(d);
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', 'OUYANG Zhonghua');
  fields[0].currentValue = 'OUYANG Zhonghua';
  const ledger = recordWrites({}, ORIGIN, [
    { fp: fingerprint(fields[0]), path: 'basics.name', valueHash: hashValue('OUYANG Zhonghua') },
  ]);
  const plan = planFill(fields, p, { mode: 'incremental', ledger, pageOrigin: ORIGIN, fillSensitive: true });
  assert.ok(plan.assignments.some(a => a.skip && a.reason === 'already_ours'),
    `已经是对的就不该再敲一遍：${JSON.stringify(plan.assignments)}`);
  assert.equal(plan.assignments.filter(a => !a.skip).length, 0);
  assert.ok(ledgerRecord(ledger, ORIGIN, fingerprint(fields[0])), '账本读回要认得这一栏');
});

test('没有账本时一律按"别人的值"处理：不能因为取不到就随便覆盖', () => {
  const d = doc(`<form><label for="a">Name</label><input id="a" name="nm" type="text"></form>`);
  const fields = scanForm(d);
  fields[0].currentValue = '站点预填的名字';
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', 'OUYANG Zhonghua');
  const plan = planFill(fields, p, { mode: 'incremental' });     // 不给 ledger
  assert.ok(plan.assignments.some(a => a.skip && a.reason === 'already_filled'), '取不到账本就别动别人的框');
});

/**
 * 独立审查（2026-10-02）的 Critical 1：覆盖口径以前只在增量模式成立，
 * 而面板默认走 full 模式 —— 于是"站点预填/用户手填一律不动"这句在最常走的路上是空的。
 * 修法是把闸下沉到"要落笔"这个动作（filler.applyPlan），full / AI 落地都同守一条规矩。
 */
test('full 模式也不盖别人的值：站点预填与用户手填的栏位在写入入口被拦下', async () => {
  const d = doc(`<form><label for="a">Name</label><input id="a" name="nm" type="text"></form>`);
  const fields = scanForm(d);
  fields[0].el.value = '站点预填：张伟';
  fields[0].currentValue = '站点预填：张伟';
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', 'OUYANG Zhonghua');
  const plan = planFill(fields, p, { mode: 'full', fillSensitive: true });     // 计划里确实有这一笔
  assert.ok(plan.assignments.some(a => a.index === 0 && !a.skip), '前置条件：full 模式排了这一笔');

  const ledger = recordWrites({}, ORIGIN, []);                                 // 我们从没写过
  const { results } = await applyPlan(fields, plan.assignments, { pageOrigin: ORIGIN, ledger });
  assert.equal(results[0].status, 'skipped', `写入入口没拦下：${JSON.stringify(results[0])}`);
  assert.equal(results[0].failReason, 'not_ours');
  assert.equal(fields[0].el.value, '站点预填：张伟', '把站点预填盖掉了');
  assert.match(gapReasonLabel('not_ours'), /不是我们写的/);
});

test('AI 落地那条路同样过两道闸：不能借 AI 之名盖掉别人的框、也不能把证件号写进电话框', async () => {
  const d = doc(`<form>
    <label for="a">Full Name</label><input id="a" name="fn" type="text">
    <label for="b">Cell Number</label><input id="b" name="cell" type="tel" maxlength="11">
  </form>`);
  const fields = scanForm(d);
  fields[0].el.value = '用户自己填的名字'; fields[0].currentValue = '用户自己填的名字';
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', 'OUYANG Zhonghua');
  setValueByPath(p, 'basics.idNumber', '330105199912034567');
  const ledger = recordWrites({}, ORIGIN, []);
  const { results } = await applyPlan(fields, [
    { index: 0, path: 'basics.name', label: 'Full Name', value: 'OUYANG Zhonghua', tier: 'auto', aiChosen: true },
    { index: 1, path: 'basics.idNumber', label: 'Cell Number', value: '330105199912034567', tier: 'auto', aiChosen: true, sensitive: true },
  ], { pageOrigin: ORIGIN, ledger, fillSensitive: true });
  assert.equal(results[0].status, 'skipped', 'AI 指认的路径把用户填的盖了');
  assert.equal(results[0].failReason, 'not_ours');
  assert.equal(results[1].failReason, 'shape_mismatch', `AI 路绕过了形状闸：${JSON.stringify(results[1])}`);
  assert.equal(fields[0].el.value, '用户自己填的名字');
  assert.equal(fields[1].el.value, '', '18 位证件号被写进 11 位电话框');
});

test('"已经对了不用重写"只认相等：上一轮写成「硕士研究生」、资料改成「硕士」必须重写', async () => {
  const d = doc(`<form><label for="a">Highest Education</label><input id="a" name="edu" type="text"></form>`);
  const fields = scanForm(d);
  fields[0].el.value = '硕士研究生'; fields[0].currentValue = '硕士研究生';
  const p = createEmptyProfile();
  setValueByPath(p, 'education.0.degree', '硕士');
  const ledger = recordWrites({}, ORIGIN, [
    { fp: fingerprint(fields[0]), path: 'education.0.degree', valueHash: hashValue('硕士研究生') },
  ]);
  const plan = planFill(fields, p, { mode: 'incremental', ledger, pageOrigin: ORIGIN });
  const redo = plan.assignments.find(a => a.index === 0 && !a.skip);
  assert.ok(redo, `包含关系不能算"已经对了"：${JSON.stringify(plan.assignments)}`);
  assert.equal(redo.overwrites, 'ours');
  await applyPlan(fields, [redo], { pageOrigin: ORIGIN, ledger });
  assert.equal(fields[0].el.value, '硕士', '没被改写');
});
