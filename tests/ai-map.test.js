// S5 整页概念映射：AI 交回的是"这一栏是哪种东西"（约 60 个概念），不是 519 条槽位路径，
// 更不是任何取值。这一层钉的是三条边界：零取值、概念白名单、展开成槽位时不猜。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPageMapRequest, parsePageMapResponse, expandConceptToSlots, assertNoProfileValues } from '../core/ai.js';
import { CONCEPTS, slotConcept } from '../core/canonical.js';
import { createEmptyProfile, setValueByPath, buildFields } from '../core/profile-schema.js';

const FIELDS = [
  { labelRaw: 'Family Name', label: 'family name', kind: 'text', required: true, description: 'Surname as in passport', sectionTitle: 'Basics', options: [], nearbyLabels: ['Given Name'] },
  { labelRaw: '*Primary Cell Number', label: 'primary cell number', kind: 'combobox', options: [{ text: '中国大陆 +86', value: '86' }, { text: '中国香港 +852', value: '852' }] },
  { labelRaw: 'Do you require sponsorship?', label: 'do you require sponsorship', kind: 'radio', options: [{ text: 'Yes', value: 'Y' }, { text: 'No', value: 'N' }] },
];

function loadedProfile() {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', '欧阳中华');
  setValueByPath(p, 'basics.lastName', '欧阳');
  setValueByPath(p, 'contact.phone', '13900002222');
  setValueByPath(p, 'contact.dialCode', '+86');
  setValueByPath(p, 'basics.idNumber', '330105199912034567');
  setValueByPath(p, 'hkGlobal.needSponsorship', '是');
  return p;
}

test('整页映射的请求体里不许出现任何取值：逐个取值扫一遍，植入了要能抓到', () => {
  const p = loadedProfile();
  const req = buildPageMapRequest({ pageFields: FIELDS, valueStates: { 0: 'empty', 1: 'ours', 2: 'site' } });
  const leaks = assertNoProfileValues(req.text, p, { exempt: [req.conceptSection], pageTokens: req.pageTokens });
  assert.deepEqual(leaks, [], `取值漏进了整页映射的请求体：${JSON.stringify(leaks)}`);
  // 反向证明：把取值写进待发文本，自检必须抓出来（不然"零取值"只是一句承诺）
  const planted = req.text + ' 联系方式：13900002222 证件 330105199912034567';
  const caught = assertNoProfileValues(planted, p, { exempt: [req.conceptSection], pageTokens: req.pageTokens });
  assert.ok(caught.length >= 2, '植入两个取值却没被抓到，闸是假的');
  // 页面自己的文字（标签、选项文案）该在；取值状态只发状态词，不发值本身
  assert.ok(/Family Name/.test(req.text) && /中国大陆 \+86=86/.test(req.text), '栏位档案该带标签与选项码值');
  assert.ok(/"valueState":"ours"/.test(req.text), '"这栏是我们上轮写的"要告诉模型（值本身不发）');
  assert.ok(!/13900002222|欧阳中华/.test(req.text));
});

test('装不下时按档削档案，而不是静默少发整页', () => {
  const fat = Array.from({ length: 40 }, (_, i) => ({
    labelRaw: `Field ${i} name`, label: `field ${i} name`, kind: 'select',
    description: 'D'.repeat(2000), options: Array.from({ length: 60 }, (_, j) => ({ text: `O${j} `.repeat(12) + j, value: String(j) })),
    nearbyLabels: ['邻近标签'.repeat(20)],
  }));
  const full = buildPageMapRequest({ pageFields: fat });
  assert.ok(full.trim.level >= 1, '40 栏满档案本来就超默认预算，必须自动降级');
  assert.ok(new TextEncoder().encode(full.text).length <= 24000, `降级后仍超上限：${new TextEncoder().encode(full.text).length}`);
  assert.equal(full.count, 40, '削的是档案细节，不是把栏位整片丢掉');
  assert.ok(full.trim.level <= 2, `最多降到"只留标签与板块"那一档：${JSON.stringify(full.trim)}`);
  // 40 栏满档案本来就装不下，降到哪一档由 trim 说清；小页面（真实常见）该保留选项码值
  const small = buildPageMapRequest({ pageFields: FIELDS });
  assert.equal(small.trim.level, 0);
  assert.ok(small.text.includes('"options"'), '几栏的页面不该被削掉选项码值');
  const tight = buildPageMapRequest({ pageFields: fat, maxBytes: 6000 });
  assert.ok(tight.trim.level >= 2, `预算更紧时要继续降档：${JSON.stringify(tight.trim)}`);
  assert.ok(new TextEncoder().encode(tight.text).length <= 6000);
});

test('解析：只认清单内的概念；null 是"认不出"，越界概念丢弃并说明', () => {
  const asked = new Set([0, 1, 2]);
  const r = parsePageMapResponse(
    '{"matches":[{"index":0,"concept":"name.family","reason":"标签就是 surname"},'
    + '{"index":1,"concept":"phone-dial-code"},{"index":2,"concept":null,"reason":"合规声明我不替你表态"},'
    + '{"index":9,"concept":"email"},{"index":0,"concept":"not-a-concept"}]}',
    { askedIndexes: asked },
  );
  assert.deepEqual(r.mapping.map(m => [m.index, m.concept]), [[0, 'name.family'], [1, 'phone-dial-code']]);
  assert.equal(r.declined.length, 1, JSON.stringify(r));
  assert.equal(r.declined[0].reason, '合规声明我不替你表态');
  const reasons = r.dropped.map(d => d.reason).sort();
  assert.deepEqual(reasons, ['unknown_concept', 'unknown_index'], `越界该各自丢：${JSON.stringify(r.dropped)}`);
});

test('概念 → 槽位由本地展开：唯一命中才给路径，多命中/空槽一律不猜', () => {
  const p = loadedProfile();
  assert.equal(slotConcept({ path: 'basics.lastName' }), 'name.family', '槽位表是展开的唯一依据');
  const fam = expandConceptToSlots(p, 'name.family');
  assert.equal(fam.path, 'basics.lastName', `唯一命中要给路径：${JSON.stringify(fam)}`);
  const unknown = expandConceptToSlots(p, 'not-a-concept');
  assert.equal(unknown.path, '');
  assert.equal(unknown.candidates.length, 0, '不认识的概念不许兜底挑一个');
  // 概念存在但资料里那一栏空着：标出来，让映射表说"去补资料"，而不是写空值
  const empty = expandConceptToSlots(createEmptyProfile(), 'name.family');
  assert.equal(empty.path, 'basics.lastName');
  assert.equal(empty.empty, true, '空槽要被点名');
  assert.ok(Object.keys(CONCEPTS).length > 40 && Object.keys(CONCEPTS).length < 120,
    `概念集该是封闭且小规模：${Object.keys(CONCEPTS).length}`);
});

test('多段经历同属一个概念时不猜第几条：candidates 交给映射表', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'work.0.company', '甲公司');
  setValueByPath(p, 'work.1.company', '乙公司');
  const r = expandConceptToSlots(p, 'company');
  assert.equal(r.path, '', `两段经历都活着，凭什么叫我们挑一条：${JSON.stringify(r)}`);
  assert.ok(r.candidates.length >= 2 && r.ambiguous, JSON.stringify(r));
});
