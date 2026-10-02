import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAdapter, matchAdapter, planFromAdapter, dateFormatOverride, compileAdapters } from '../core/adapters.js';
import { planFill, optionRulePick } from '../core/matcher.js';
import { sampleProfile } from './fixtures/sample-profile.js';
import { createEmptyProfile, getValueByPath } from '../core/profile-schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'adapters/registry.json'), 'utf8'));
const ADAPTERS = registry.files.map(f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')));

const pf = o => ({ kind: o.kind || 'text', label: o.label || '', name: o.name || '', id: o.id || '', placeholder: o.placeholder || '', currentValue: o.currentValue ?? '', options: o.options || [], required: !!o.required, sectionHint: '', itemIndex: null, nearbyLabels: [], autocomplete: '', type: o.type || '' });

test('自带适配器全部通过校验', () => {
  for (const a of ADAPTERS) assert.deepEqual(validateAdapter(a), [], `${a.id} 校验失败`);
});

test('校验层拒绝远程链接、未知键与危险正则', () => {
  assert.ok(validateAdapter({ id: 'x', domains: ['a.com'], fetch: 'bad' }).length);
  assert.ok(validateAdapter({ id: 'x', domains: ['a.com' ], unknownKey: 1 }).some(e => e.includes('未知键')));
  assert.ok(validateAdapter({ id: 'x', domains: ['a.com'], skip: [{ match: 're:(a|)', reason: 'r' }] }).some(e => e.includes('危险正则')));
  assert.ok(validateAdapter({ id: 'x', domains: ['a.com'], pins: [{ match: '姓名', path: 'basics.name', endpoint: 'x' }] }).length);
  assert.ok(validateAdapter({ id: 'x', domains: ['a.com'], skip: [{ match: 'x', reason: 'r' }], note: '见 https://evil.test' }).some(e => e.includes('http')));
  assert.ok(validateAdapter({ id: 'x', domains: ['-bad-'] }).length);
});

test('域名匹配：精确与子域', () => {
  assert.equal(matchAdapter('https://wecruit.hotjob.cn/SU123/pb/x.html', ADAPTERS)?.id, 'hkjob-antd');
  assert.equal(matchAdapter('https://app.mokahr.com/campus-recruitment/kpmg/74217', ADAPTERS)?.id, 'moka');
  assert.equal(matchAdapter('https://career10.successfactors.com/careers', ADAPTERS)?.id, 'successfactors');
  assert.equal(matchAdapter('https://example.com/x', ADAPTERS), null);
});

test('回归：re: 规则里的括号不得被当成"要删掉的括号注释"从而退化成匹配一切', () => {
  const adapter = { id: 't', domains: ['a.com'], skip: [{ match: 're:(ethnicity|race|disability)', reason: 'declaration_optional' }] };
  const fields = [pf({ label: 'Ethnicity / Race' }), pf({ label: 'First Name' }), pf({ label: 'Email Address' })];
  const { skip } = planFromAdapter(fields, adapter);
  assert.deepEqual([...skip.keys()], [0]);
  assert.equal(skip.get(0), 'declaration_optional');
});

test('普通（非 re:）匹配仍按归一化文本判断', () => {
  const adapter = { id: 't', domains: ['a.com'], pins: [{ match: '最高学历（含在读）', path: 'education.0.degree' }] };
  const { pins } = planFromAdapter([pf({ label: '最高学历' })], adapter);
  assert.equal(pins.get(0), 'education.0.degree');
});

test('钉位与日期覆盖会进入填写计划', () => {
  const sf = ADAPTERS.find(a => a.id === 'successfactors');
  const fields = [
    pf({ label: 'Date of Birth', name: 'dob', placeholder: 'MM/DD/YYYY' }),
    pf({ label: 'Ethnicity / Race', name: 'ethnic', kind: 'select', options: [{ text: 'Chinese', value: '1' }] }),
    pf({ label: 'Current Work Authorization', name: 'work_auth', kind: 'select', options: [{ text: 'Hong Kong Permanent Resident', value: '2' }, { text: 'Would require sponsorship', value: '3' }] }),
  ];
  const plan = planFill(fields, sampleProfile(), { adapter: sf, fillSensitive: true });
  const byIndex = new Map(plan.assignments.map(a => [a.index, a]));
  assert.equal(byIndex.get(0).dateFormat, 'MM/dd/yyyy', 'adapter 的日期覆盖优先');
  assert.ok(!byIndex.has(1), 'Ethnicity 应被 skip 掉');
  assert.ok(plan.gaps.some(g => g.index === 1 && g.reason === 'declaration_optional'));
  assert.ok(byIndex.has(2), 'Work Authorization 应靠中英等价表命中');
});

test('中英值等价：硕士 ↔ Master，本地居民 ↔ Hong Kong Permanent Resident', () => {
  const fields = [
    pf({ label: 'Highest Qualification', kind: 'select', options: [{ text: 'Bachelor', value: 'b' }, { text: 'Master', value: 'm' }] }),
    pf({ label: 'Do you require sponsorship to work in Hong Kong?', kind: 'radio', options: [{ text: 'Yes', value: 'Y' }, { text: 'No', value: 'N' }] }),
  ];
  const plan = planFill(fields, sampleProfile(), {});
  const got = new Map(plan.assignments.map(a => [a.index, a]));
  assert.equal(got.get(0).path, 'education.0.degree');
  assert.equal(got.get(0).optionValue, 'm');
  assert.equal(got.get(1).path, 'hkGlobal.needSponsorship');
  assert.equal(got.get(1).optionValue, 'N', '资料里的「否」要选到英文 No');
});

test('空 profile 时钉位给出可诊断的缺口而不是静默', () => {
  const adapter = { id: 't', domains: ['a.com'], pins: [{ match: '姓名', path: 'basics.name' }] };
  const plan = planFill([pf({ label: '姓名' })], createEmptyProfile(), { adapter });
  assert.ok(plan.gaps.some(g => g.reason === 'pinned_field_empty'));
});

test('适配器不会改动原始 profile 对象', () => {
  const base = sampleProfile();
  const before = JSON.stringify(base);
  planFill([pf({ label: '姓名' })], base, { adapter: ADAPTERS[0] });
  assert.equal(JSON.stringify(base), before);
});

test('degreeSlotPins：摊平学历按资料里的学位定位槽位，定位不到交人工', () => {
  const moka = ADAPTERS.find(a => a.id === 'moka');
  const fields = [
    pf({ label: '硕士毕业学校（本科无需填写）' }),
    pf({ label: '本科毕业学校' }),
    pf({ label: '高中毕业学校' }),
  ];
  const { slotPins } = planFromAdapter(fields, moka);
  const s0 = slotPins.get(0), s1 = slotPins.get(1);
  assert.deepEqual([s0.section, s0.keyField, s0.want, s0.subfield, s0.gapReason], ['education', 'degree', '硕士', 'school', 'degree_slot_unresolved']);
  assert.deepEqual([s1.want, s1.subfield], ['本科', 'school']);
  const plan = planFill(fields, sampleProfile(), { adapter: moka });
  assert.deepEqual(plan.assignments.map(a => a.path), ['education.0.school', 'education.1.school']);
  assert.deepEqual(plan.gaps.map(g => g.reason), ['degree_slot_unresolved'], '资料里没有高中学位，高中栏必须留在待人工');
});

test('degreeSlotPins 不看 placeholder：「请输入本科学校」不能把硕士栏串到本科槽', () => {
  const moka = ADAPTERS.find(a => a.id === 'moka');
  const fields = [pf({ label: '硕士专业（本科无需填写）', placeholder: '请输入本科专业' })];
  const slot = planFromAdapter(fields, moka).slotPins.get(0);
  assert.deepEqual([slot.want, slot.subfield], ['硕士', 'major']);
});

test('relationSlotPins：「父亲工作单位」按资料里的称谓定位 family 槽位，没有配偶就交人工', () => {
  const hj = ADAPTERS.find(a => a.id === 'hkjob-antd');
  const fields = [
    pf({ label: '父亲姓名' }),
    pf({ label: '父亲工作单位' }),
    pf({ label: '母亲姓名' }),
    pf({ label: '配偶姓名' }),
  ];
  const { slotPins } = planFromAdapter(fields, hj);
  assert.deepEqual([slotPins.get(0).section, slotPins.get(0).want, slotPins.get(0).subfield], ['family', '父亲', 'name']);
  assert.deepEqual([slotPins.get(1).want, slotPins.get(1).subfield], ['父亲', 'employer']);
  const plan = planFill(fields, sampleProfile(), { adapter: hj, fillSensitive: true });
  assert.deepEqual(plan.assignments.map(a => a.path), ['family.0.name', 'family.0.employer', 'family.1.name']);
  assert.deepEqual(plan.gaps.map(g => g.reason), ['relation_slot_unresolved'], '资料里没有配偶这一行，配偶栏必须留在待人工');
});

test('适配器校验拒绝不存在的教育子字段', () => {
  const errs = validateAdapter({ id: 'x', domains: ['a.com'], degreeSlotPins: [{ match: 're:硕士.*学校', degree: '硕士', subfield: 'employer' }] });
  assert.ok(errs.some(e => e.includes('degreeSlotPins')), JSON.stringify(errs));
});

test('槽位规则也要过同一套正则安全检查（它们优先于 pins 生效）', () => {
  const bad = validateAdapter({ id: 'x', domains: ['a.com'], degreeSlotPins: [{ match: 're:(硕士|)', degree: '硕士', subfield: 'school' }] });
  assert.ok(bad.some(e => e.includes('危险正则')), JSON.stringify(bad));
  const redos = validateAdapter({ id: 'x', domains: ['a.com'], relationSlotPins: [{ match: 're:^(a+)+$', relation: '父亲', subfield: 'name' }] });
  assert.ok(redos.some(e => e.includes('ReDoS')), JSON.stringify(redos));
  const long = validateAdapter({ id: 'x', domains: ['a.com'], skip: [{ match: 're:' + 'x'.repeat(260), reason: 'r' }] });
  assert.ok(long.some(e => e.includes('过长')), JSON.stringify(long));
});

test('键名与地址检查按子串拦：apiUrl / //host / data: 都进不来', () => {
  const a = validateAdapter({ id: 'x', domains: ['a.com'], apiUrl: 'x' });
  assert.ok(a.some(e => e.includes('禁止的键')), JSON.stringify(a));
  const b = validateAdapter({ id: 'x', domains: ['a.com'], notes: '见 //evil.co/p' });
  assert.ok(b.some(e => e.includes('协议相对')), JSON.stringify(b));
  const c = validateAdapter({ id: 'x', domains: ['a.com'], notes: 'data:text/html;base64,AA' });
  assert.ok(c.some(e => e.includes('data:')), JSON.stringify(c));
});

test('compileAdapters：校验不过的适配器被丢掉，集合仍能按 URL 选到合适的', () => {
  const warnings = [];
  const good = { id: 'ok-site', domains: ['ok.example.com'], pins: [{ match: '姓名', path: 'basics.name' }] };
  const evil = { id: 'bad-site', domains: ['bad.example.com'], fetch: 'x' };
  const { adapters, rejected, resolve } = compileAdapters({ 'a/ok-site.json': good, 'a/bad-site.json': evil }, m => warnings.push(m));
  assert.equal(adapters.length, 1);
  assert.deepEqual(rejected.map(r => r.name), ['a/bad-site.json']);
  assert.ok(warnings.some(w => w.includes('bad-site')), '被拒绝的适配器必须说明原因，不能静默丢弃');
  assert.equal(resolve('https://ok.example.com/resume')?.id, 'ok-site');
  assert.equal(resolve('https://bad.example.com/resume'), null);
});

test('真实自带的每个适配器都能被 compileAdapters 接受（防止提交进仓库就失效）', () => {
  const files = {};
  for (const [i, raw] of ADAPTERS.entries()) files[registry.files[i]] = raw;
  const { adapters, rejected } = compileAdapters(files, m => { throw new Error(m); });
  assert.deepEqual(rejected, []);
  assert.equal(adapters.length, ADAPTERS.length);
  // 每个已知站点都要能选到适配器，否则线上等于没接
  for (const url of [
    'https://app.mokahr.com/campus-recruitment/kpmg/74217',
    'https://wecruit.hotjob.cn/SU62f3/pb/resumeOperation.html',
    'https://www.hotjob.cn/wt/zyhl/web/index/showNewResume',
    'https://career10.successfactors.com/portalcareer?company=johnswireP2',
    'https://hkex.wd3.myworkdayjobs.com/zh-CN/HKEXCareerPage/job/x',
  ]) assert.ok(matchAdapter(url, adapters), `${url} 选不到适配器`);
});

// 扩展 ID 推导：换目录=换 ID，"我资料怎么没了"的常见真因就藏在这里。
// 只钉算法性质，不钉任何人的真实路径。
test('tools/ext-id.mjs：ID 是路径 UTF-16LE 的 SHA-256 前 32 位，逐位映射到 a-p', async () => {
  const { extensionIdFor } = await import('../tools/ext-id.mjs');
  const { createHash } = await import('node:crypto');
  const pathMod = await import('node:path');
  // 用 join 造带分隔符的路径：测试里的 \ 转义在几个环节极易看错（这次就被写成了单斜杠）
  const win = pathMod.win32.join('D:', 'work', 'demo-ext');
  const id = extensionIdFor(win);
  assert.equal(id.length, 32);
  assert.match(id, /^[a-p]{32}$/, `ID 只能由 a-p 组成：${id}`);
  assert.equal(extensionIdFor(win), id, '同一个路径必须给同一个 ID');
  assert.notEqual(extensionIdFor(pathMod.win32.join('D:', 'work', 'demo-ext-2')), id,
    '换个目录就是另一个 ID（这正是"我资料怎么没了"的真因）');
  assert.equal(extensionIdFor(win + pathMod.win32.sep), id, '结尾斜杠不该改变 ID');
  assert.equal(extensionIdFor('D:/work/demo-ext'), id, '正斜杠与反斜杠该归一');
  // 手算一份固定向量：算法（UTF-16LE / 前 32 位 / a-p 映射）被改坏时要能看见
  const hex = createHash('sha256').update(win, 'utf16le').digest('hex');
  assert.equal(id, hex.slice(0, 32).split('').map(c => String.fromCharCode(97 + parseInt(c, 16))).join(''));
});

/**
 * optionRules 是"替用户勾选项"的规则，形状必须卡死：
 * 一份写歪了的规则（把 yes 写成两边都命中、或 path 指向不存在的槽位）会把整页勾成同一个答案。
 */
const goodRule = {
  match: 're:(work permit|工作许可)', path: 'hkGlobal.workAuth',
  when: { yes: ['本地居民'], no: ['需申请工作签证'] },
  pick: { yes: ['yes', '是'], no: ['no', '否'] },
};
const base = extra => ({ id: 'x', domains: ['a.com'], ...extra });

test('optionRules：合法形状通过，歪的一律拒收', () => {
  assert.deepEqual(validateAdapter(base({ optionRules: [goodRule] })), []);
  const cases = [
    [{ optionRules: [{ ...goodRule, path: 'nope.nothere' }] }, /槽位/],
    [{ optionRules: [{ ...goodRule, path: '' }] }, /槽位/],
    [{ optionRules: [{ ...goodRule, when: { yes: ['a'], maybe: ['b'] } }] }, /只允许 yes\/no/],
    [{ optionRules: [{ ...goodRule, pick: { yes: 'yes', no: ['no'] } }] }, /必须是数组/],
    [{ optionRules: [{ ...goodRule, when: { yes: [], no: [] } }] }, /两边都空/],
    [{ optionRules: [{ ...goodRule, note: 'x'.repeat(60) }] }, null],
    [{ optionRules: [{ ...goodRule, match: '' }] }, /缺少 match/],
    [{ optionRules: [{ ...goodRule, hook: 'x' }] }, /不允许的键/],
  ];
  for (const [extra, re] of cases) {
    const errs = validateAdapter(base(extra));
    if (re) assert.ok(errs.some(e => re.test(e)), `该拒的没拒（${JSON.stringify(extra)}）：${JSON.stringify(errs)}`);
    else assert.deepEqual(errs, [], `不该拒的拒了：${JSON.stringify(errs)}`);
  }
});

test('optionRules 的规则只在"这一栏最后拿到的正是它写的槽位"时才生效', () => {
  const adapter = base({ id: 'rule-x', domains: ['a.com'], optionRules: [goodRule] });
  const fields = [{ index: 0, label: 'work permit', labelRaw: 'Work Permit', kind: 'radio', options: [{ text: 'Yes', value: 'Y' }, { text: 'No', value: 'N' }] }];
  const { optionRules } = planFromAdapter(fields, adapter);
  assert.ok(optionRules.get(0), '标签命中时规则要挂到栏位上');
  // 槽位不是规则写的那个 → 规则当没写过（不能让一条 work permit 规则去管性别）
  assert.equal(optionRulePick({ ...goodRule, path: 'basics.gender' }, '男', fields[0]), null);
});

test('optionRules 的方向要显式声明，非法值与缺声明都拒收/按 same 处理', () => {
  const okInverted = { ...goodRule, polarity: 'inverted' };
  assert.deepEqual(validateAdapter(base({ optionRules: [okInverted] })), [], 'inverted 该合法');
  assert.ok(validateAdapter(base({ optionRules: [{ ...goodRule, polarity: 'flip' }] })).some(e => /polarity/.test(e)),
    '没约束的 polarity 会被当成"随便写点什么都能过"');
});
