// 匹配方法重构 M1 的回归：证据要说得出，形状不相容就不能绿字。
// 这一层存在的理由（用户 2026-10-02）："phone number 能填成 id number…你应该审视你的匹配方法。"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { labelEvidence, shapeOfControl, valueShape, shapeMismatch } from '../core/matching.js';
import { planFill, gapReasonLabel } from '../core/matcher.js';
import { scanForm } from '../dom/scanner.js';
import { buildFields, createEmptyProfile, setValueByPath } from '../core/profile-schema.js';

const field = path => buildFields().find(f => f.path === path);

test('labelEvidence：中心词命中与定语命中要分得开', () => {
  const name = field('basics.name');
  const school = field('education.0.school');
  const headOnly = labelEvidence({ label: 'team name', labelRaw: 'Team Name' }, name);
  assert.ok(headOnly.kinds.has('head-only'), `只靠末词 name 命中该记成 head-only：${JSON.stringify([...headOnly.kinds])}`);
  assert.equal(headOnly.strong, false, '中心词证据不能算强证据');
  assert.equal(headOnly.weakOnly, true);

  const exact = labelEvidence({ label: '姓名', labelRaw: '姓名' }, name);
  assert.ok(exact.kinds.has('exact') && exact.strong, '字面相等是最硬的证据');

  const byQual = labelEvidence({ label: 'school name', labelRaw: 'School Name' }, school);
  assert.ok([...byQual.kinds].some(k => k === 'qualifier' || k === 'full-cover'),
    `定语 school 命中学校那一槽要记成定语/全覆盖证据：${JSON.stringify([...byQual.kinds])}`);
  assert.equal(byQual.strong, true);

  // 控件属性单独作为线索时也算弱：name="xq_score" 说不出这是什么分数
  const struct = labelEvidence({ label: '', labelRaw: '', name: 'other_score' }, field('education.0.gpa'));
  assert.equal(struct.strong, false, JSON.stringify([...struct.kinds]));
});

test('形状体检：只认站点自己声明的硬线索（type / autocomplete / maxlength）', () => {
  assert.equal(shapeOfControl({ inputType: 'tel' }), 'tel');
  assert.equal(shapeOfControl({ inputType: 'text', autocomplete: 'email' }), 'email');
  assert.equal(shapeOfControl({ inputType: 'text', maxLength: 11, name: 'mobile' }), 'tel');
  // 只看 placeholder 猜会把正常栏位拦死：placeholder 不是形状证据
  assert.equal(shapeOfControl({ inputType: 'text', placeholder: '请输入手机号' }), '');
  assert.equal(valueShape('330105199912034567'), 'idcard');
  assert.equal(valueShape('13900002222'), 'tel');
  assert.equal(valueShape('138-0000-2222'), 'tel');
  assert.equal(valueShape('ouyang@example.test'), 'email');
  assert.equal(valueShape('欧阳中华'), 'text');
  assert.equal(shapeMismatch({ inputType: 'tel', maxLength: 11 }, '330105199912034567'), 'tel', '18 位证件号写不进电话框');
  assert.equal(shapeMismatch({ inputType: 'email' }, '13900002222'), 'email');
  assert.equal(shapeMismatch({ inputType: 'email' }, 'ouyang@example.test'), '', '相容就别拦');
  assert.equal(shapeMismatch({ inputType: 'text' }, '330105199912034567'), '', '没有硬线索时不猜');
});

test('证据弱（只有中心词）不许绿字：Team Name 不能被当成姓名自动写下去', () => {
  const html = `<form>
    <label for="t">Team Name</label><input id="t" type="text">
    <label for="e">邮箱</label><input id="e" type="email">
  </form>`;
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { pretendToBeVisual: true });
  const fields = scanForm(dom.window.document);
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', '雷霆小队');
  const plan = planFill(fields, p, { mode: 'full', fillSensitive: true });
  const t = plan.assignments.find(a => a.index === fields.findIndex(f => f.label === 'team name'));
  assert.ok(t, `这一栏该有条目（写或不写都要能看见）：${JSON.stringify(plan.gaps)}`);
  assert.equal(t.tier, 'review', `只有中心词证据不许绿字：${JSON.stringify(t)}`);
  assert.equal(t.weakEvidence, true);
  assert.ok(t.evidence.includes('head-only'), `证据要留在条目里：${JSON.stringify(t.evidence)}`);
  assert.match(t.note, /证据弱|映射表/);
});

test('形状不相容直接不写，并说清是配错了槽位（不是"我们填不上"）', () => {
  // 站点把"证件号码"这一栏做成了 type=tel maxlength=11：18 位写进去会被截断，
  // 而回读只看"框里的字 == 要写的字"→ 截断后的错值照样绿。这一类必须在写入前拦下。
  const html = `<form>
    <label for="i">证件号码</label><input id="i" type="tel" maxlength="11">
    <label for="e">邮箱</label><input id="e" type="email">
  </form>`;
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://campus.example.test/x', pretendToBeVisual: true });
  const fields = scanForm(dom.window.document);
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.idNumber', '330105199912034567');
  setValueByPath(p, 'contact.email', '这不是邮箱');
  const plan = planFill(fields, p, { mode: 'full', fillSensitive: true });
  const gaps = plan.gaps.filter(g => g.reason === 'shape_mismatch');
  assert.ok(gaps.length >= 1, `该至少拦下一次：${JSON.stringify(plan.assignments)} / ${JSON.stringify(plan.gaps)}`);
  assert.ok(plan.assignments.every(a => a.path !== 'basics.idNumber' || a.index !== 0), '证件号仍被写进电话框');
  assert.match(gapReasonLabel('shape_mismatch'), /形状/);
  assert.match(gaps[0].note, /配错了槽位|形状对不上/, gaps[0].note);
});

/**
 * 含糊词名单（学 Bitwarden 的 AmbiguousTotpFieldNames）：
 * `code / number / type / other…` 这类词单独出现不足以定性，必须有旁证。
 * 我们的裸词 name 之病与它的裸词 code 之病是同一个病。
 */
test('含糊词单独命中不定性：Number / Code / 名称 都不能算强证据', () => {
  const num = labelEvidence({ label: 'number', labelRaw: 'Number' }, field('contact.phone'));
  assert.equal(num.strong, false, `裸词 number 蹭到"联系电话"不该算强证据：${JSON.stringify([...num.kinds])}`);
  // 2026-10-04 收紧之后更强：裸词连"弱证据"都不再产生（'contact number' 里的 number 不算它说了是谁的）。
  // 原来这里断言的是 weakOnly=true —— 那是"有证据但没定性"，而用户四次报的同一件事要求的是"别给证据"。
  assert.equal(num.kinds.size, 0, `裸词 number 仍留了证据：${JSON.stringify([...num.kinds])}`);
  assert.equal(num.weakOnly, false, '没有任何证据时不该叫"弱证据"');
  const code = labelEvidence({ label: 'code', labelRaw: 'Code' }, field('basics.idNumber'));
  assert.equal(code.strong, false, JSON.stringify([...code.kinds]));
  const cname = labelEvidence({ label: '名称', labelRaw: '名称' }, field('certifications.0.name'));
  assert.equal(cname.strong, false, `光秃秃"名称"说不出是谁的名称：${JSON.stringify([...cname.kinds])}`);
  // 有旁证时照常算强：autocomplete 是站点自己声明的，比任何文本启发都硬
  const evAc = labelEvidence({ label: 'code', labelRaw: 'Code', autocomplete: 'one-time-code' }, field('basics.idNumber'));
  assert.equal(evAc.strong, true, JSON.stringify([...evAc.kinds]));
  // 定语齐全时也该算强：'cell phone' 说清了是谁的电话
  assert.equal(labelEvidence({ label: 'cell phone', labelRaw: 'Cell Phone' }, field('contact.phone')).strong, true);
});
