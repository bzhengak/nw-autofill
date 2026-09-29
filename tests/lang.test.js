// 中英两份取值的底层测试。
// 结构决定：中文值留在原路径，英文值放 profile.en.<同路径>（稀疏，只存真填了的那些）。
// 这么放是因为给 537 个槽位各加一个 *En 字段会让 schema 翻倍，而其中大多数栏位
// （日期、数字、邮箱、下拉选项）在两种语言下本来就是同一个值。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createEmptyProfile, buildFields, countFilled, getValueByPath, setValueByPath,
  isLangNeutral, readLang, writeLang, lacksEnglishValue, englishCoverage,
  englishNameFor, englishOption, EN_BUCKET,
} from '../core/profile-schema.js';

test('英文值与中文值互不覆盖；老资料（只有中文）一个字节都不动', () => {
  const p = createEmptyProfile();
  const before = JSON.stringify({ ...p, [EN_BUCKET]: undefined });
  writeLang(p, 'education.0.school', 'en', 'Nanjing University');
  assert.equal(getValueByPath(p, 'education.0.school'), '', '中文值被英文写入影响了');
  assert.equal(getValueByPath(p, 'en.education.0.school'), 'Nanjing University');
  assert.equal(JSON.stringify({ ...p, [EN_BUCKET]: undefined }), before, '中文那一侧的结构被动过');
  writeLang(p, 'education.0.school', 'zh', '南京大学');
  assert.equal(readLang(p, 'education.0.school', 'zh'), '南京大学');
  assert.equal(readLang(p, 'education.0.school', 'en'), 'Nanjing University');
});

test('中性栏位不要求两份：日期/邮箱/下拉/中文姓 在英文模式下直接用原值', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.birthDate', '2001-03-15');
  setValueByPath(p, 'contact.email', 'a@b.test');
  setValueByPath(p, 'basics.gender', '男');
  setValueByPath(p, 'basics.lastNameZh', '王');
  assert.equal(readLang(p, 'basics.birthDate', 'en', { field: { path: 'basics.birthDate', type: 'date' } }), '2001-03-15');
  assert.equal(readLang(p, 'contact.email', 'en', { field: { path: 'contact.email', type: 'email' } }), 'a@b.test');
  assert.equal(readLang(p, 'basics.gender', 'en', { field: { path: 'basics.gender', type: 'enum' } }), '男');
  assert.equal(readLang(p, 'basics.lastNameZh', 'en', { field: { path: 'basics.lastNameZh', zh: '中文姓', type: 'text' } }), '王');
  assert.ok(isLangNeutral({ type: 'date' }) && isLangNeutral({ type: 'bool' }) && isLangNeutral({ zh: '中文名', type: 'text' }));
  assert.ok(!isLangNeutral({ type: 'text', zh: '学校名称' }), '校名必须能要英文值，否则英文表单只能填中文');
});

test('英文模式下没英文值就是"没有"，不偷偷回退成中文', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'education.0.school', '南京大学');
  const f = { path: 'education.0.school', zh: '学校名称', type: 'text' };
  assert.equal(readLang(p, f.path, 'en', { field: f }), '');
  assert.equal(lacksEnglishValue(p, f), true);
  setValueByPath(p, 'basics.age', '25');
  assert.equal(lacksEnglishValue(p, { path: 'basics.age', zh: '年龄', type: 'num' }), false, '中性栏不该被算成缺英文');
  assert.equal(lacksEnglishValue(p, { path: 'projects.3.name', zh: '项目名', type: 'text' }), false, '中文也没填就不算缺英文');
});

test('英文取值完成度按"中文已填的栏位"算，并给出待补清单', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'education.0.school', '南京大学');
  setValueByPath(p, 'education.0.major', '计算机科学与技术');
  setValueByPath(p, 'education.0.enrollDate', '2021-09');
  writeLang(p, 'education.0.school', 'en', 'Nanjing University');
  const cov = englishCoverage(p, buildFields());
  assert.equal(cov.need, 2, '日期栏不该进"需要英文值"的名单');
  assert.equal(cov.done, 1);
  assert.deepEqual(cov.missing.map(f => f.path), ['education.0.major']);
});

test('每个槽位都有英文显示名，且不含中文（表单编辑区整块要能切英文）', () => {
  const fields = buildFields();
  assert.ok(fields.length > 400, `槽位数 ${fields.length} 不对，schema 读空了？`);
  const bad = [];
  for (const f of fields) {
    const en = englishNameFor(f);
    if (!en || /[\u4e00-\u9fff]/.test(en)) bad.push(`${f.path}(${f.zh})→${en || '(空)'}`);
  }
  assert.deepEqual(bad.slice(0, 8), [], `有 ${bad.length} 个槽位取不到英文名`);
  assert.equal(englishNameFor({ zh: '姓名', labels: ['姓名', 'full name', 'candidate name'] }), 'Full Name');
});

test('下拉选项的英文写法取自中英等价表，取不到就原样返回（不编造）', () => {
  assert.equal(englishOption('男'), 'Male');
  assert.equal(englishOption('是'), 'Yes');
  assert.equal(englishOption('中共党员'), 'CPC Member');
  assert.equal(englishOption('某站点自定义选项'), '某站点自定义选项');
  assert.equal(englishOption(''), '');
});

test('countFilled 与体检不被英文子树重复计数', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'education.0.school', '南京大学');
  const zhCount = countFilled(p);
  writeLang(p, 'education.0.school', 'en', 'Nanjing University');
  assert.equal(countFilled(p), zhCount, '同一栏填了英文不该变成"填了两项"');
});

test('值里本来就没汉字（拼音姓名、China、数字）就不该被催着补第二遍', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.lastName', 'Zhang');
  setValueByPath(p, 'basics.firstName', 'Wei');
  setValueByPath(p, 'basics.nationality', 'China');
  setValueByPath(p, 'education.0.school', '南京大学');
  const nameField = { path: 'basics.lastName', zh: '姓', type: 'text' };
  assert.equal(lacksEnglishValue(p, nameField), false, '拼音姓名被当成"缺英文"是给用户加活');
  assert.equal(readLang(p, 'basics.lastName', 'en', { field: nameField }), 'Zhang', '英文模式下该直接看到这行的既有值');
  assert.equal(readLang(p, 'basics.nationality', 'en', { field: { path: 'basics.nationality', zh: '国籍', type: 'text' } }), 'China');
  const school = { path: 'education.0.school', zh: '学校名称', type: 'text' };
  assert.equal(lacksEnglishValue(p, school), true, '中文校名在英文表单上确实需要另一份写法');
  assert.equal(readLang(p, school.path, 'en', { field: school }), '', '有中文没英文时读英文要读到空，不能读到中文');
});
