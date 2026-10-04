// 代号层（档 A 的地基）回归。这里钉的不是"AI 准不准"，而是三件本地的事：
//  ① 每个登记在册的枚举值都必须折得出代号 —— 加了新枚举项忘了配代号，这一栏就永远走不了档 A，
//     而那是**静默**的：界面只会说"没落成"，看不出是词表缺行；
//  ② 折不出/两项都说得通 → 一律 null，不许"最接近的那个"（把 非全日制 折成 FULL_TIME 是最坏的错）；
//  ③ 代号词表是我们手写的词典，里面不许夹带任何身份类取值（姓名/证件号/电话/家属姓名）。
//     用户 2026-10-04 给的清单里，这几类是唯一连"勾了允许看取值"都不许外发的。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OPTION_SETS, buildFields, createEmptyProfile, setValueByPath } from '../core/profile-schema.js';
import { TOKEN_SPACES, OPTION_SET_TO_SPACE, valueToToken, optionSetOf, spaceForSlotField, spaceOf, tokenPromptList, coveredOptionSets } from '../core/value-tokens.js';
import { valueShareBlocked } from '../core/ai-security.js';

const fieldByPath = new Map(buildFields().map(f => [f.path, f]));

test('登记在册的枚举值全都能折出代号（漏一个就红，逼着加字段时一起补词表）', () => {
  for (const [set, space] of Object.entries(OPTION_SET_TO_SPACE)) {
    const list = OPTION_SETS[set] || [];
    assert.ok(list.length, `${set} 这个枚举集不存在，OPTION_SET_TO_SPACE 里是死条目`);
    assert.ok(spaceOf(space), `${set} 指向的代号空间 ${space} 不存在`);
    for (const v of list) {
      const tok = valueToToken(space, v);
      assert.ok(tok, `${set} 的值「${v}」折不出代号（这一栏以后只能走人工）`);
      assert.ok(TOKEN_SPACES[space].tokens.some(t => t.t === tok), `${set}「${v}」折出了不在清单里的代号 ${tok}`);
    }
  }
  assert.ok(coveredOptionSets().length >= 6, `代号空间只覆盖 ${coveredOptionSets().length} 个枚举集，太少`);
});

test('折不出代号与两项都说得通，一律 null：不猜', () => {
  assert.equal(valueToToken('rightToWork', '我不确定我有什么身份'), null);
  assert.equal(valueToToken('rightToWork', ''), null);
  assert.equal(valueToToken('rightToWork', '   '), null);
  // 「居民」既是"永久居民"也是"香港居民"的一半：长度并列 → 歧义 → 不选
  assert.equal(valueToToken('rightToWork', '居民'), null);
  assert.equal(valueToToken('notASpace', '男'), null);
});

test('中英与括注折回同一代号；更具体的那条赢', () => {
  assert.equal(valueToToken('rightToWork', 'IANG（内地应届毕业生留港计划）'), 'IANG');
  assert.equal(valueToToken('rightToWork', 'IANG（非本地毕业生留港／回港就业安排）'), 'IANG');
  assert.equal(valueToToken('rightToWork', 'Permanent Resident'), valueToToken('rightToWork', '永久居民'));
  assert.equal(valueToToken('degreeLevel', 'Master'), valueToToken('degreeLevel', '硕士'));
  // 博士后 ⊃ 博士：不能让"博士"这个短别名把它抢走
  assert.equal(valueToToken('degreeLevel', '博士后'), 'POSTDOC');
  assert.equal(valueToToken('degreeLevel', '博士'), 'DOCTORATE');
});

test('否定词与限定词不许互相折算（这类错页面不会报，站点会安静交上错答案）', () => {
  assert.equal(valueToToken('trainingMode', '非全日制'), 'PART_TIME');
  assert.equal(valueToToken('trainingMode', '全日制'), 'FULL_TIME');
  assert.notEqual(valueToToken('trainingMode', '非全日制'), 'FULL_TIME');
  assert.equal(valueToToken('gender', '男'), 'MALE');
  assert.equal(valueToToken('gender', '女'), 'FEMALE');
  assert.equal(valueToToken('gender', 'Male'), 'MALE', 'female 里含 male 子串，必须整词才算命中');
  assert.equal(valueToToken('gender', 'Female'), 'FEMALE');
  assert.equal(valueToToken('gender', '保密'), 'UNDISCLOSED');
  assert.equal(valueToToken('rightToWork', '需申请工作签证'), 'NEEDS_SPONSORSHIP');
  assert.equal(valueToToken('rightToWork', '持工作签证'), 'EMPLOYMENT_VISA');
});

test('代号空间挂在枚举槽位上：靠 options 反查（buildFields 不带 flags）', () => {
  assert.equal(spaceForSlotField(fieldByPath.get('basics.gender')), 'gender');
  assert.equal(spaceForSlotField(fieldByPath.get('education.0.degree')), 'degreeLevel');
  assert.equal(spaceForSlotField(fieldByPath.get('hkGlobal.workAuth')), 'rightToWork');
  assert.equal(spaceForSlotField(fieldByPath.get('hkGlobal.visaType')), 'rightToWork');
  assert.equal(optionSetOf(fieldByPath.get('hkGlobal.visaType')), 'visaCategory');
  // 自由填写的栏位没有枚举集 → 没有代号空间（它走的是另一条路：直接写文本）
  assert.equal(spaceForSlotField(fieldByPath.get('basics.name')), '');
  assert.equal(spaceForSlotField({ path: 'x', options: ['随便什么'] }), '');
});

test('港站工作许可题按"签证类别"建模：枚举集是入境处那一套，且仍走核对', () => {
  const sf = fieldByPath.get('hkGlobal.visaType');
  assert.equal(sf.type, 'enum', 'visaType 该是枚举，不再是自由文本');
  assert.ok(sf.options.some(o => /IANG/.test(o)), '枚举里没有 IANG');
  assert.ok(sf.options.some(o => /Permanent Resident|永久性居民/.test(o)));
  assert.ok(sf.options.some(o => /学生|Student/.test(o)));
  // 显示名不许撞车：签证类别 vs 工作许可身份 vs 证件类型 是三件事（用户 2026-10-02 的口径）
  const zh = new Set(['当前签证类别', '工作许可身份', '证件类型']);
  assert.equal(sf.zh, '当前签证类别');
  assert.ok(!zh.has('当前签证类型'), '老名字"当前签证类型"与"证件类型"只差一个字');
});

test('代号词表里没有身份类取值：把它们植进 profile 也扫不出来', () => {
  const p = createEmptyProfile();
  const identity = {
    'basics.name': '欧姓测试人',
    'basics.idNumber': '110101199003079876',
    'contact.phone': '13800001111',
    'family.0.name': '欧父测试',
    'family.0.phone': '13900002222',
    'contact.emergencyName': '欧友测试',
    'hkGlobal.visaType': 'IANG（非本地毕业生留港／回港就业安排）',
  };
  for (const [path, v] of Object.entries(identity)) setValueByPath(p, path, v);
  const text = Object.keys(TOKEN_SPACES)
    .map(s => JSON.stringify(tokenPromptList(s))).join('\n');
  for (const [path, v] of Object.entries(identity)) {
    // 签证类别的值**允许**出现在词表里（IANG 是公开计划名，不是身份标识）；
    // 被硬清单拦下的那几类才必须一个都不在。
    if (!valueShareBlocked(fieldByPath.get(path))) continue;
    assert.ok(!text.includes(v), `代号词表里混进了「${path}」的值`);
  }
  assert.ok(text.includes('IANG'), '代号词表该有 IANG：这是港页最常见的一项');
});
