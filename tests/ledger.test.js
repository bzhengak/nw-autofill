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
import { planFill } from '../core/matcher.js';
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
