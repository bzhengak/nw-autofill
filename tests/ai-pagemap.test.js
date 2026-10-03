// S6 续：整页概念映射落到计划上的那一步（applyPageMapSuggestions）。
// 这一层的意义是划线：AI 终于能覆盖"我们自己也判得没把握"的那些栏（用户要的就是这个），
// 但**人的决定、站点自述、绿字**三样它一样都不许动，动了也要当场说清是为什么。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyPageMapSuggestions } from '../core/ai.js';
import { planFill } from '../core/matcher.js';
import { fingerprint } from '../core/ledger.js';
import { createEmptyProfile, setValueByPath } from '../core/profile-schema.js';

const pf = (o = {}) => ({
  kind: 'text', label: '', labelRaw: '', name: '', id: '', placeholder: '', currentValue: '',
  options: [], required: false, nearbyLabels: [], sectionHint: '', sectionTitle: '',
  itemIndex: null, autocomplete: '', type: 'text', ...o,
});

function profile() {
  const p = createEmptyProfile();
  setValueByPath(p, 'certifications.0.name', 'CFA Level II');
  setValueByPath(p, 'awards.0.title', '校级一等奖');
  setValueByPath(p, 'languages.0.score', '6.5');
  setValueByPath(p, 'basics.name', '张三');
  return p;
}

test('缺口被 AI 认出来：变成一笔，来历写"AI 认这是…"', () => {
  const p = profile();
  const fields = [pf({ label: 'Awarding Body', name: 'ab', id: 'a1' })];
  const plan = planFill(fields, p, { mode: 'full' });
  assert.equal(plan.gaps[0]?.reason, 'no_candidate', '前提：本地词典认不出这一栏');
  const out = applyPageMapSuggestions(plan, p, [{ index: 0, path: 'certifications.0.name', concept: 'cert-name', reason: '像是证书名', label: 'Awarding Body' }]);
  const hit = out.assignments.find(a => a.index === 0);
  assert.equal(hit?.path, 'certifications.0.name');
  assert.equal(hit.aiChosen, true);
  assert.match(hit.note, /AI 认这是「证书名称」/);
  assert.equal(out.gaps.length, 0, '认出来了还留在缺口里，界面上就会重复出现');
  assert.equal(out.applied, 1, JSON.stringify(out));
});

test('黄字判定可以被 AI 换掉，但要留下原本判给了谁', () => {
  const p = profile();
  const fields = [pf({ label: '语言成绩', name: 'lang', id: 'l1' })];
  const plan = planFill(fields, p, { mode: 'full' });
  assert.equal(plan.assignments[0]?.tier, 'review', '前提：这一栏本地是黄字');
  const out = applyPageMapSuggestions(plan, p, [{ index: 0, path: 'awards.0.title', concept: 'award-name', reason: '像是获奖', label: '语言成绩' }]);
  const a = out.assignments[0];
  assert.equal(a.path, 'awards.0.title');
  assert.equal(out.overridden, 1);
  assert.deepEqual(a.aiOverrode?.path, 'languages.0.score', '覆盖痕迹要能拿给表里念');
  assert.match(a.note, /覆盖了本地那个没把握的判定/);
});

test('绿字不动：AI 不许覆盖已经高置信的本地判定，理由要带回来', () => {
  const p = profile();
  const green = { assignments: [{ index: 0, path: 'awards.0.title', tier: 'auto', label: '奖项名称', value: '校级一等奖' }], gaps: [], stats: {} };
  const out = applyPageMapSuggestions(green, p, [{ index: 0, path: 'languages.0.score', label: '奖项名称' }]);
  assert.equal(out.assignments[0].path, 'awards.0.title', '绿字被 AI 换掉了');
  assert.equal(out.overridden, 0);
  assert.match(out.refused[0].why, /绿字高置信/);
});

test('用户改判与适配器钉位是人的决定与站点的自述，AI 一律不覆盖', () => {
  const p = profile();
  const base = { assignments: [
    { index: 0, path: 'awards.0.title', tier: 'review', pinned: true, pinnedBy: 'siteRule', label: 'A' },
    { index: 1, path: 'awards.0.title', tier: 'review', pinned: true, pinnedBy: 'adapter', label: 'B' },
  ], gaps: [], stats: {} };
  const out = applyPageMapSuggestions(base, p, [
    { index: 0, path: 'languages.0.score', label: 'A' },
    { index: 1, path: 'languages.0.score', label: 'B' },
  ]);
  assert.equal(out.assignments[0].path, 'awards.0.title');
  assert.equal(out.assignments[1].path, 'awards.0.title');
  assert.match(out.refused.find(r => r.index === 0).why, /改过判/);
  assert.match(out.refused.find(r => r.index === 1).why, /站点规则|钉住/);
});

test('敏感槽位与空槽位两道闸照旧：AI 只有权说"这一格是什么"', () => {
  const p = profile();
  const fields = [pf({ label: 'Awarding Body', name: 'ab', id: 'a2' })];
  const plan = planFill(fields, p, { mode: 'full' });
  const off = applyPageMapSuggestions(plan, p, [{ index: 0, path: 'basics.name', label: 'Awarding Body' }]);
  assert.equal(off.gaps.find(g => g.index === 0)?.reason, 'sensitive_withheld', '没勾授权就被 AI 建议写进姓名列');
  assert.equal(off.assignments.length, 0);

  const on = applyPageMapSuggestions(plan, p, [{ index: 0, path: 'basics.name', label: 'Awarding Body' }], { fillSensitive: true });
  assert.equal(on.assignments[0]?.path, 'basics.name');
  assert.equal(on.assignments[0].tier, 'review', '敏感字段即便 AI 认了也仍是黄字');

  const emptyPlan = planFill(fields, createEmptyProfile(), { mode: 'full' });
  const empty = applyPageMapSuggestions(emptyPlan, createEmptyProfile(), [{ index: 0, path: 'awards.0.title', label: 'Awarding Body' }]);
  assert.equal(empty.gaps.find(g => g.index === 0)?.reason, 'ai_empty_slot', '资料里空着就不许凭空写');
  assert.equal(empty.assignments.length, 0);
});

test('标签对不上或路径不存在：整条丢弃并说清，绝不静默', () => {
  const p = profile();
  const fields = [pf({ label: 'Awarding Body', name: 'ab', id: 'a3' })];
  const plan = planFill(fields, p, { mode: 'full' });
  const drifted = applyPageMapSuggestions(plan, p, [{ index: 0, path: 'awards.0.title', label: '完全不同的一栏' }]);
  assert.equal(drifted.gaps[0]?.reason, 'no_candidate', '页面在两次扫描之间变了，答案却不丢');
  assert.equal(drifted.refused[0]?.reason, 'stale_label');

  const bogus = applyPageMapSuggestions(plan, p, [{ index: 0, path: 'nonexistent.0.path', label: 'Awarding Body' }]);
  assert.equal(bogus.gaps[0]?.reason, 'no_candidate');
  assert.equal(bogus.refused[0]?.reason, 'unknown_path');
});

test('改了判定的那一栏仍然认得自己的指纹：改判与台账不受 AI 影响', () => {
  const p = profile();
  const field = pf({ label: '语言成绩', name: 'lang', id: 'l2' });
  const plan = planFill([field], p, { mode: 'full' });
  const fp = fingerprint(field);
  const rules = { [fp]: { fp, path: 'awards.0.title', skip: false } };
  const ruled = planFill([field], p, { mode: 'full', siteRules: rules });
  const out = applyPageMapSuggestions(ruled, p, [{ index: 0, path: 'languages.0.score', label: '语言成绩' }]);
  assert.equal(out.assignments[0].path, 'awards.0.title', '用户点过的改判被 AI 建议换掉了');
  assert.equal(out.assignments[0].pinnedBy, 'siteRule', '来历也不许被 AI 抹掉');
});

test('stats 是重算出来的，且缺口与覆盖不会被双计', () => {
  const p = profile();
  const fields = [pf({ label: '奖项名称', name: 'awd', id: 'a4' }), pf({ label: '语言成绩', name: 'lang', id: 'a5' })];
  const plan = planFill(fields, p, { mode: 'full' });
  const out = applyPageMapSuggestions(plan, p, [
    { index: 0, path: 'certifications.0.name', label: 'Awarding Body' },
    { index: 1, path: 'certifications.0.name', label: '语言成绩' },
  ]);
  assert.equal(out.stats.gaps, out.gaps.length);
  assert.equal(out.stats.planned, out.assignments.filter(a => !a.skip).length);
  assert.equal(out.filledGaps + out.overridden, out.applied, JSON.stringify(out));
  assert.equal(out.assignments.filter(a => a.aiChosen).length, out.applied);
});

/**
 * 回答里带上下标是按"上一次扫描"算的，页面自己插掉一个控件就会漂到别的栏位上。
 * 标签复核只能挡住"标签变了"的那种；两栏标签一模一样时（真站点上一整排 id="value"）挡不住。
 * 所以答案带指纹时按指纹重新对号 —— 这一条是把那最后一格缝隙关掉。
 */
test('答案带指纹时按指纹重新对号；对不上号宁可不动', () => {
  const p = profile();
  const fields = [
    pf({ label: 'Awarding Body', name: 'a', id: 'q1' }),
    pf({ label: 'Awarding Body', name: 'b', id: 'q2' }),   // 与上一栏标签完全相同，只有 id 不同
  ];
  const plan = planFill(fields, p, { mode: 'full' });
  assert.equal(plan.gaps.length, 2, '前提：两栏都认不出');
  const fpOf = f => fingerprint(f);
  // 面板以为答案是给第 0 栏的，但它的指纹其实是第 1 栏那格的
  const out = applyPageMapSuggestions(plan, p, [
    { index: 0, fp: fpOf(fields[1]), path: 'certifications.0.name', label: 'Awarding Body' },
  ], { fields });
  assert.equal(out.filledGaps, 1);
  assert.equal(out.assignments[0].index, 1, '按指纹重新对号后，答案该落在第 2 栏');
  assert.equal(out.assignments[0].path, 'certifications.0.name');

  // 指纹在这一页已经找不到了（页面变了）：不许按旧下标硬套
  const gone = applyPageMapSuggestions(plan, p, [
    { index: 0, fp: 'stale-fp-not-on-this-page', path: 'certifications.0.name', label: '完全不同的另一栏' },
  ], { fields });
  assert.equal(gone.filledGaps, 0);
  assert.equal(gone.refused[0]?.reason, 'stale_label');
});
