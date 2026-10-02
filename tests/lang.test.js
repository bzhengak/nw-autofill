// 中英两份取值的底层测试。
// 结构决定：中文值留在原路径，英文值放 profile.en.<同路径>（稀疏，只存真填了的那些）。
// 这么放是因为给 537 个槽位各加一个 *En 字段会让 schema 翻倍，而其中大多数栏位
// （日期、数字、邮箱、下拉选项）在两种语言下本来就是同一个值。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createEmptyProfile, buildFields, countFilled, getValueByPath, setValueByPath,
  isLangNeutral, readLang, writeLang, lacksEnglishValue, englishCoverage,
  englishNameFor, englishOption, enSkeleton, ensureEnSkeleton, EN_BUCKET,
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

/** 区分"这个键不存在"与"存在但是空串"——getValueByPath 把两者都读成 ''，骨架测的正是这个区别 */
function leaf(obj, path) {
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur == null || !(seg in cur)) return { found: false, value: undefined };
    cur = cur[seg];
  }
  return { found: true, value: cur };
}

/**
 * 用户实测反馈的那件事：把模板 JSON 下载下来，en 是 {}，
 * 想手写英文却不知道该写在哪 —— 界面有框、文件没坑，等于英文这一侧只能靠界面补。
 * 所以骨架必须覆盖每一个"真要另一种文字"的栏位。
 */
test('空白模板自带完整英文骨架：每个需要英文写法的栏位在 en 下都有落点', () => {
  const blank = createEmptyProfile();
  const fields = buildFields();
  const need = fields.filter(f => !isLangNeutral(f));
  assert.ok(need.length > 200, `非中性栏位只有 ${need.length} 个，schema 读空了？`);
  assert.ok(need.length < fields.length, '全是非中性栏位说明 isLangNeutral 没生效，骨架会白白翻倍');
  const missing = need.filter(f => !leaf(blank.en, f.path).found).map(f => f.path);
  assert.deepEqual(missing.slice(0, 8), [], `有 ${missing.length} 个栏位在英文骨架里没有落点`);
  assert.ok(need.every(f => leaf(blank.en, f.path).value === ''), '骨架里的落点必须是空串（有键可写），不是 undefined');
  // 反向：中性栏不该冒出来，否则 210 个永远用不到的空框又来骗人
  const leaked = fields.filter(f => isLangNeutral(f) && leaf(blank.en, f.path).found).map(f => f.path);
  assert.deepEqual(leaked.slice(0, 8), [], `中性栏位混进了英文骨架：${leaked.length} 个`);
});

test('英文骨架与中文侧同结构，序列化成 JSON 不留 null 洞', () => {
  const blank = createEmptyProfile();
  const text = JSON.stringify(blank);
  assert.ok(!text.includes('null'), '骨架里出现 null：稀疏数组被序列化成 [null,…]，用户没法照着写');
  for (const [k, v] of Object.entries(blank)) {
    if (k === EN_BUCKET) continue;
    if (Array.isArray(v)) {
      assert.ok(Array.isArray(blank.en[k]), `${k} 在中文侧是列表，英文骨架却给了对象`);
      assert.equal(blank.en[k].length, v.length, `${k} 的列表长度两侧不一致：只能补到中文侧那么多条`);
    }
  }
  // 骨架由 buildFields() 推出来：以后 schema 加一栏，这里不用改代码就该跟着长
  const fewer = enSkeleton(buildFields().filter(f => f.section !== 'family'));
  assert.equal(leaf(fewer, 'family.0.name').found, false, '骨架没跟着传入的栏位集合走');
  assert.ok(leaf(fewer, 'education.0.school').found);
});

/** 列表骨架必须是"补到齐"而不是 arr[2] = {} 那种跳着写：后者序列化出来是 [null,null,…] */
test('骨架遇到靠后的列表项会补前面的空项，不留稀疏洞', () => {
  const sk = enSkeleton([{ path: 'education.2.school', section: 'education', key: 'school', zh: '学校名称', type: 'text' }]);
  assert.ok(Array.isArray(sk.education), '列表栏该给数组');
  assert.equal(sk.education.length, 3);
  assert.ok(sk.education.every(it => it && typeof it === 'object'), `前面有空洞：${JSON.stringify(sk.education)}`);
  assert.ok(!JSON.stringify(sk).includes('null'), '骨架序列化出了 null');
  assert.equal(sk.education[2].school, '');
});

test('空骨架不算"填了"：计数、英文完成度、缺口判定都不把空串当值', () => {
  const blank = createEmptyProfile();
  assert.equal(countFilled(blank), 0, '空白模板被报成"已有 N 项有值"');
  assert.equal(englishCoverage(blank, buildFields()).need, 0, '中文没填时不该催用户补英文');
  assert.equal(lacksEnglishValue(blank, { path: 'education.0.school', zh: '学校名称', type: 'text' }), false);
  setValueByPath(blank, 'education.0.school', '南京大学');
  const cov = englishCoverage(blank, buildFields());
  assert.equal(cov.need, 1, '中文校名进了英文需求名单了吗');
  assert.equal(cov.done, 0, '骨架里的空串被当成"英文已补"');
});

test('ensureEnSkeleton 只补空缺：已有英文值、额外键、中性栏一律不动', () => {
  // 模拟用户现有的老资料：en 里只有手写过的两栏，外加一个 schema 里没有的键
  const legacy = { basics: { name: '张伟', birthDate: '2001-03-15' }, education: [{ school: '南京大学' }], en: { basics: { name: 'Zhang Wei' }, noteFromMe: '别丢' } };
  const before = countFilled(legacy);
  const r = ensureEnSkeleton(legacy);
  assert.equal(r, legacy, '应当就地补齐并返回同一份');
  assert.equal(getValueByPath(r, 'en.basics.name'), 'Zhang Wei', '补骨架把用户手写的英文清了');
  assert.equal(r.en.noteFromMe, '别丢', '骨架之外的键被顺带删掉');
  assert.equal(leaf(r.en, 'education.0.school').value, '', '缺的落点没补上');
  assert.equal(leaf(r.en, 'basics.birthDate').found, false, '中性栏不该被补进骨架');
  const once = JSON.stringify(r.en);
  ensureEnSkeleton(r);
  assert.equal(JSON.stringify(r.en), once, '跑两次结果不同 = 骨架不稳定');
  assert.equal(countFilled(r), before, '补骨架不该让"有值栏数"发生变化');
  assert.equal(before, 3, '这条用例的前提：中文侧三栏有值（姓名、出生日期、校名）');
  assert.equal(ensureEnSkeleton(null), null, '没有资料时别凭空造一份');
});

test('在骨架里手写英文 → 存成 JSON 再读回来，英文表单就真填得出来', () => {
  const blank = createEmptyProfile();
  setValueByPath(blank, 'education.0.school', '南京大学');
  setValueByPath(blank, 'others.selfIntro', '三年学生会经历');
  blank.en.education[0].school = 'Nanjing University';
  blank.en.others.selfIntro = 'Three years in the student union.';
  const round = ensureEnSkeleton(JSON.parse(JSON.stringify(blank)));   // 下载→手写→导入这条路的等价形式
  const school = { path: 'education.0.school', zh: '学校名称', type: 'text' };
  const intro = { path: 'others.selfIntro', zh: '自我介绍', type: 'textarea' };
  assert.equal(readLang(round, school.path, 'en', { field: school }), 'Nanjing University');
  assert.equal(readLang(round, intro.path, 'en', { field: intro }), 'Three years in the student union.');
  assert.equal(lacksEnglishValue(round, school), false);
  assert.equal(getValueByPath(round, 'education.0.school'), '南京大学', '写英文把中文盖掉了');
  assert.equal(englishCoverage(round, buildFields()).done, 2);
});

/**
 * 「学校英文名 / 英文姓名 / 英文地址」这些 *En 栏位的取值本身就是英文：
 * 给它们再套一层 en.xxxEn，等于在英文栏旁边又开一个英文栏，
 * 而英文表单会去读那个空壳 —— 已经填好的英文名反倒被判成"缺英文"留空。
 */
test('*En 栏位（学校英文名等）不再要第二份：英文模式直接读原值，骨架里也不出现', () => {
  const p = createEmptyProfile();
  const fields = buildFields();
  const enFields = fields.filter(f => /En$/.test(f.path.split('.').pop()));
  assert.equal(enFields.length, 10, `*En 栏位数变成 ${enFields.length}，这条前提要看一眼 schema`);
  for (const f of enFields) {
    assert.equal(isLangNeutral(f), true, `${f.path} 的取值本来就是英文，不该再要一份`);
    assert.equal(leaf(p.en, f.path).found, false, `骨架里还留着 ${f.path} 这个空壳`);
  }
  setValueByPath(p, 'education.0.schoolEn', 'Nanjing University');
  setValueByPath(p, 'basics.nameEn', 'Zhang Wei');
  const schoolEn = fieldFor(fields, 'education.0.schoolEn');
  assert.equal(readLang(p, schoolEn.path, 'en', { field: schoolEn }), 'Nanjing University', '英文表单该直接用这一栏的既有值');
  assert.equal(lacksEnglishValue(p, schoolEn), false, '填了英文名还被催着补英文');
  assert.equal(englishCoverage(p, fields).need, 0, '只填了 *En 栏时被算成需要英文');
  assert.equal(lacksEnglishValue(p, fieldFor(fields, 'basics.nameEn')), false);
});

function fieldFor(fields, path) {
  const f = fields.find(x => x.path === path);
  assert.ok(f, `schema 里没有 ${path}`);
  return f;
}

/**
 * 槽位显示名不许重复（用户 2026-10-02 的要求："资料中字段名不能重复，避免产生歧义，
 * 比如紧急联系人的电话和我的电话就不能混淆……en 和 zh 都要做好这一步"）。
 * 规则是**只在会歧义时才改名**：裸名留给最典型的主人（「开始时间」= 工作，
 * 「姓名」= 本人），另一个加限定（实习开始时间 / 家属姓名）。
 * 这条测试是长期闸：以后加字段撞名，CI 当场红。
 */
test('槽位显示名（zh 与 en）互不重复，电话类尤其要分清是谁的', () => {
  const fields = buildFields();
  const collect = pick => {
    const map = new Map();
    for (const f of fields) {
      const unit = `${f.section}.${f.key}`;
      const name = pick(f);
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(unit);
    }
    return [...map].filter(([, s]) => s.size > 1).map(([n, s]) => `${n} → ${[...s].join(', ')}`);
  };
  assert.deepEqual(collect(f => f.zh), [], '有中文显示名重复');
  assert.deepEqual(collect(englishNameFor), [], '有英文显示名重复');
  const byPath = p => fields.find(f => f.path === p);
  const names = ['contact.phone', 'contact.altPhone', 'contact.emergencyPhone', 'family.0.phone']
    .map(p => byPath(p).zh);
  assert.equal(new Set(names).size, names.length, `电话类栏位没分清：${names.join(' / ')}`);
  assert.match(byPath('contact.emergencyPhone').zh, /紧急/, '紧急联系人电话要一眼看出不是本人的');
  assert.match(byPath('family.0.phone').zh, /家属|联系电话/, '家属的电话要能看出是家属的');
  assert.match(englishNameFor(byPath('family.0.phone')), /family/i, '英文名同样要分清是谁的电话');
  // 裸名留给最典型的主人，别把「开始时间」这种改成谁都不像
  assert.equal(byPath('work.0.startDate').zh, '开始时间');
  assert.equal(byPath('internship.0.startDate').zh, '实习开始时间');
  assert.equal(byPath('campus.0.summary').zh, '校园活动内容');
});
