// S2 概念层：识别从"519 个槽位里挑分数最高的"改成"先问这一栏是什么东西"。
// 依据：docs/MATCHING-REDESIGN.md 第五、六节（autocomplete 令牌表 + Bitwarden 的两份名单与具体度取胜）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { classifyConcept, conceptFromAutocomplete, slotConcept, conceptFitsControl, CONCEPTS, isKnownConcept } from '../core/canonical.js';
import { planFill } from '../core/matcher.js';
import { scanForm } from '../dom/scanner.js';
import { createEmptyProfile, writeLang, buildFields } from '../core/profile-schema.js';

const doc = html => new JSDOM(`<!doctype html><html><body>${html}</body></html>`,
  { url: 'https://campus.example.test/x', pretendToBeVisual: true }).window.document;

test('概念表自洽：id 合法、槽位表里指向的概念都必须存在', () => {
  const paths = new Set(buildFields().map(f => f.path));
  for (const c of Object.keys(CONCEPTS)) assert.ok(isKnownConcept(c) && /^[a-z0-9.-]+$/.test(c), `概念 id 不合法：${c}`);
  // slotConcept 只能返回表里的概念；表里指向不存在的槽位是死条目
  for (const p of ['basics.name', 'contact.phone', 'contact.dialCode', 'education.0.school', 'work.0.company', 'hkGlobal.workAuth']) {
    assert.ok(paths.has(p), `槽位表基线缺列：${p}`);
    const c = slotConcept({ path: p });
    assert.ok(c && isKnownConcept(c), `${p} 没标到合法概念：${c}`);
  }
});

test('站点写了 autocomplete 就是确定性证据（WCAG 1.3.5 那一族令牌）', () => {
  assert.equal(conceptFromAutocomplete({ autocomplete: 'family-name' }), 'name.family');
  assert.equal(conceptFromAutocomplete({ autocomplete: 'tel-national' }), 'phone');
  assert.equal(conceptFromAutocomplete({ autocomplete: 'tel-country-code' }), 'phone-dial-code');
  assert.equal(conceptFromAutocomplete({ autocomplete: 'work tel' }), 'phone', 'home/work/mobile 是修饰词，不参与判定');
  assert.equal(conceptFromAutocomplete({ autocomplete: 'section-billing address-line1' }), 'address-line');
  assert.equal(conceptFromAutocomplete({ autocomplete: '' }), '');
  assert.deepEqual(classifyConcept({ autocomplete: 'postal-code', label: '任意标签' }), { concept: 'postal-code', source: 'autocomplete' });
});

test('多个概念同时命中时按具体度取胜，而不是判死为歧义', () => {
  const em = classifyConcept({ label: '紧急联系人电话', labelRaw: '紧急联系人电话' });
  assert.equal(em.concept, 'emergency-contact-phone', `长词该赢：${JSON.stringify(em)}`);
  const amb = classifyConcept({ label: 'number', labelRaw: 'Number' });
  assert.ok(!amb || amb.ambiguous || amb.concept === '', `裸词不该定案：${JSON.stringify(amb)}`);
});

test('概念 × 控件：工作许可长不出文本框，电话长不出勾选框', () => {
  assert.equal(conceptFitsControl('work-permit', 'textarea'), false);
  assert.equal(conceptFitsControl('work-permit', 'radio'), true);
  assert.equal(conceptFitsControl('phone', 'checkbox'), false);
  assert.equal(conceptFitsControl('unknown-concept', 'checkbox'), true, '不认识的概念不拦');
});

test('autocomplete 说了算：姓名栏被站点标成 family-name 就不会写成全名', () => {
  const d = doc(`<form>
    <label for="a">Your Name</label><input id="a" name="nm" type="text" autocomplete="family-name">
    <label for="b">Number</label><input id="b" name="no" type="text" autocomplete="tel-national">
  </form>`);
  const fields = scanForm(d);
  const p = createEmptyProfile();
  writeLang(p, 'basics.name', 'zh', '欧阳中华'); writeLang(p, 'basics.name', 'en', 'OUYANG Zhonghua');
  writeLang(p, 'basics.lastName', 'zh', '欧阳'); writeLang(p, 'basics.lastName', 'en', 'OUYANG');
  writeLang(p, 'contact.phone', 'zh', '13900002222');
  writeLang(p, 'basics.idNumber', 'zh', '330105199912034567');
  const plan = planFill(fields, p, { mode: 'full', fillSensitive: true });
  const got = i => plan.assignments.find(a => a.index === i && !a.skip);
  assert.equal(got(0)?.path, 'basics.lastName', `autocomplete=family-name 必须压过 "Your Name" 的字面相似：${JSON.stringify(got(0))}`);
  assert.equal(got(1)?.path, 'contact.phone', `autocomplete=tel-national 不该被"号码"蹭到证件号：${JSON.stringify(got(1))}`);
});

test('概念跨板块时只有页面说了在哪一块才抬举：项目职责不再被抬进工作总结', () => {
  const d = doc(`<form>
    <label for="a">项目职责</label><input id="a" name="duty" type="text">
    <label for="b">Email</label><input id="b" name="e" type="email">
  </form>`);
  const fields = scanForm(d);
  const p = createEmptyProfile();
  writeLang(p, 'work.0.summary', 'zh', '负责电机控制板固件重构');
  writeLang(p, 'projects.0.role', 'zh', '检索召回链路后端负责人');
  const noBlock = planFill(fields, p, { mode: 'full' });
  const hit = noBlock.assignments.find(a => a.index === 0 && !a.skip);
  // 页面没说这块是"项目"，概念层就不许替它决定（不插手 = 保持原打分，而不是硬抬某一个）
  if (hit) assert.ok(hit.path !== 'projects.0.role' || hit.tier === 'review',
    `没有板块证据时概念层不该把这一栏定案到某一块：${JSON.stringify(hit)}`);
  const withBlock = planFill(fields.map((f, i) => (i === 0 ? { ...f, sectionHint: 'projects' } : f)), p, { mode: 'full' });
  const got = withBlock.assignments.find(a => a.index === 0 && !a.skip);
  assert.equal(got?.path, 'projects.0.role', `页面说了这块是项目就该归项目：${JSON.stringify(got)}`);
});
