// S6 映射表与计划校验的纯函数层。
//
// 这两份东西是"一律先出映射表再写"（用户 2026-10-02 定的口径）的执行体：
// 表是确认前唯一的读物，校验是落笔前的一次整页算术。
// 所以最要紧的两条性质是：① 表里**绝不能有资料取值**（它是要导出贴给别人看的）；
// ② 校验说的每一条都得是数出来的，不能是"感觉不太对"。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMappingTable, describeMappingTable, plainMappingTable, slotZhFor } from '../core/mapping-table.js';
import { checkPlan, describePlanCheck, filledRecordCount, pageRecordGroups } from '../core/plan-check.js';
import { planFill, gapReasonLabel } from '../core/matcher.js';
import { fingerprint, hashValue, recordWrites } from '../core/ledger.js';
import { buildFields, createEmptyProfile, setValueByPath } from '../core/profile-schema.js';
import { findLeaksInExport } from '../core/ai-security.js';

const SCHEMA = buildFields();
const ORIGIN = 'https://job.example.test';

const pf = (o = {}) => ({
  kind: 'text', label: '', labelRaw: '', name: '', id: '', placeholder: '',
  currentValue: '', options: [], required: false, nearbyLabels: [], description: '',
  sectionHint: '', sectionTitle: '', itemIndex: null, autocomplete: '', type: 'text', labelSource: 'label', ...o,
});

/** 走一遍真·planFill，拿到一份真计划（映射表不是手搓数据能测出来的） */
function scanAndPlan(fields, profile, opts = {}) {
  const plan = planFill(fields, profile, { mode: 'full', ...opts });
  const table = buildMappingTable({ fields, plan, results: [], origin: ORIGIN, schemaFields: SCHEMA, siteRules: opts.siteRules || {} });
  return { plan, table, check: checkPlan({ fields, plan, profile, schemaFields: SCHEMA, table }) };
}

test('映射表一行一栏：页面自述、判给谁、凭什么、现在是谁写的，四样都在', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'education.0.school', '复旦大学');
  const fields = [
    pf({ label: 'School Name', name: 'school', id: 's1', required: true, sectionTitle: '教育经历' }),
    pf({ label: '完全没听过的栏位名', name: 'zzz', id: 'z9' }),
  ];
  const { table } = scanAndPlan(fields, p);
  assert.equal(table.rows.length, 2, '每一栏都要有一行，不能只显示"我们处理得了的"');
  const a = table.rows[0];
  assert.equal(a.page.label, 'School Name');
  assert.equal(a.page.section, '教育经历');
  assert.ok(a.decision.path, '这一栏该有判定');
  assert.equal(a.decision.zh, slotZhFor(SCHEMA, a.decision.path), '槽位名要念得出中文');
  assert.ok(Array.isArray(a.decision.evidence) && a.decision.evidence.length, '判定要带依据，不然用户只能选择信或不信');
  assert.ok(['auto', 'review'].includes(a.decision.tier), `档位要说得清：${a.decision.tier}`);
  assert.equal(a.current, 'empty', '页面是空的就该说 empty');
  const b = table.rows[1];
  assert.equal(b.decision.by, 'none', '没判定的栏别装作判过了');
  assert.ok(b.decision.gap, '没判定要给原因：' + JSON.stringify(b.decision));
  assert.equal(gapReasonLabel(b.decision.gap) === b.decision.gapZh, true, '原因要有中文说明');
});

test('导出的映射表里没有资料取值：手机号/证件号/姓名一个都不许出现', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', '欧阳测试');
  setValueByPath(p, 'contact.phone', '13800001234');
  setValueByPath(p, 'contact.email', 'ouyang@example.test');
  setValueByPath(p, 'basics.idNumber', '110101200103150011');
  const fields = [
    pf({ label: '姓名', name: 'nm' }), pf({ label: '手机号码', name: 'phone' }),
    pf({ label: '邮箱', name: 'email' }), pf({ label: '证件号码', name: 'sfzh' }),
  ];
  const { table } = scanAndPlan(fields, p, { fillSensitive: true });
  const secrets = {
    姓名: '欧阳测试', 手机: '13800001234', 邮箱: 'ouyang@example.test', 证件号: '110101200103150011',
  };
  const txt = JSON.stringify(plainMappingTable(table));
  const leaks = findLeaksInExport(txt, secrets);
  assert.deepEqual(leaks, [], `脱敏视图里出现了资料取值：${JSON.stringify(leaks)}`);
  for (const v of Object.values(secrets)) {
    assert.ok(!txt.includes(v), `明文取值 ${v} 混进了导出`);
  }
});

test('回读值只活在屏幕上那一版：rows 里有，脱敏视图里一个字节都不留', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'contact.phone', '13800001234');
  const field = pf({ label: '手机号码', name: 'phone' });
  const { plan, table } = scanAndPlan([field], p);
  const withWrite = buildMappingTable({
    fields: [field], plan, schemaFields: SCHEMA, origin: ORIGIN,
    results: [{ index: 0, status: 'green', path: 'contact.phone', actual: '13800001234' }],
  });
  assert.equal(withWrite.rows[0].decision.actual, '13800001234', '用户屏幕上要看得见写进去的是什么');
  assert.ok(!JSON.stringify(plainMappingTable(withWrite)).includes('13800001234'), '导出视图不许带它');
});

test('判定来历分得清：本站改判 / 本轮确认 / 适配器钉位 / 本地匹配 / 没定', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'certifications.0.name', 'CFA Level II');
  const field = pf({ label: 'Awarding Body', name: 'ab', id: 'ab1' });
  const fp = fingerprint(field);
  const rules = { [fp]: { fp, path: 'certifications.0.name', skip: false, note: '' } };
  const byRule = scanAndPlan([field], p, { siteRules: rules });
  assert.equal(byRule.table.rows[0].decision.by, 'siteRule');
  assert.equal(byRule.table.rows[0].rule.path, 'certifications.0.name', '已记住的规则要能在表里看到');

  const confirmed = scanAndPlan([field], p, { siteRules: rules });
  // 同一份规则，但标记为"本轮临时确认"时说法不同（关页就没了）
  const t2 = buildMappingTable({
    fields: [field], plan: confirmed.plan, results: [], origin: ORIGIN,
    schemaFields: SCHEMA, siteRules: rules, temporaryFps: [fp],
  });
  assert.equal(t2.rows[0].decision.by, 'confirmed');

  const adapter = { id: 'x', pins: [{ match: 'Awarding Body', path: 'certifications.0.name' }] };
  const byAdapter = scanAndPlan([field], p, { adapter });
  assert.equal(byAdapter.table.rows[0].decision.by, 'adapter', '适配器钉的不能被说成用户改的');

  const local = scanAndPlan([pf({ label: '证书名称', name: 'cert' })], p);
  assert.equal(local.table.rows[0].decision.by, 'local', '本地词典匹配上的也要说得出来源');

  // 钉住了位置、但那份资料是空的：不能和"完全没定下来"混成一句
  const guessField = pf({ label: 'Awarding Body', name: 'ab2', id: 'ab2' });
  const guessFp = fingerprint(guessField);
  const guess = scanAndPlan([guessField], createEmptyProfile(), {
    siteRules: { [guessFp]: { fp: guessFp, path: 'certifications.0.name', skip: false } },
  });
  assert.ok(!guess.table.rows[0].decision.path, '资料空着就不算"打算写"');
  assert.equal(guess.table.rows[0].decision.gap, 'pinned_field_empty');
  assert.equal(guess.table.rows[0].decision.slotGuess, 'certifications.0.name', '要说得出我们判它是什么：' + JSON.stringify(guess.table.rows[0].decision));
  assert.match(guess.table.rows[0].decision.slotGuessZh, /证书名称/);
  assert.equal(scanAndPlan([pf({ label: '闻所未闻的名字甲', name: 'q1' })], p).table.rows[0].decision.slotGuess, '', '真没定下来时别装作判过');
});

test('现状归属来自台账：我们写的=可纠正，别人写的=不动', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'contact.phone', '13800001234');
  const ours = pf({ label: '手机号码', name: 'phone', id: 'ph', currentValue: '13800001234' });
  const theirs = pf({ label: '电子邮箱', name: 'email', id: 'em', currentValue: 'x@y.test' });
  setValueByPath(p, 'contact.email', 'x@y.test');
  const ledger = recordWrites({}, ORIGIN, [{ pageField: ours, path: 'contact.phone', value: '13800001234' }]);
  const fields = [ours, theirs];
  const plan = planFill(fields, p, { mode: 'full', ledger, pageOrigin: ORIGIN });
  const table = buildMappingTable({ fields, plan, results: [], ledger, origin: ORIGIN, schemaFields: SCHEMA });
  assert.equal(table.rows[0].current, 'us');
  assert.match(table.rows[0].currentZh, /我们上一轮/);
  assert.equal(table.rows[1].current, 'other');
  assert.match(table.rows[1].currentZh, /站点或你自己/);
  assert.ok(table.stats.alreadyFilled >= 1);
  assert.ok(!JSON.stringify(plainMappingTable(table)).includes('13800001234'), '台账参与算归属，但值不进导出');
  assert.equal(hashValue('13800001234').length > 0, true);
});

test('自述相同的两栏：表里标出撞车，摘要与校验都说出来（改判会一起生效）', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', '张三');
  const a = pf({ label: 'Name', name: 'x', id: 'value' });
  const b = pf({ label: 'Name', name: 'x', id: 'value' });
  const { table, check } = scanAndPlan([a, b], p, { fillSensitive: true });
  assert.ok(table.rows[0].collision >= 2 && table.rows[1].collision >= 2, JSON.stringify(table.rows.map(r => r.collision)));
  assert.ok(table.stats.collisions >= 2);
  assert.match(describeMappingTable(table), /自述完全相同/);
  const w = check.warnings.find(x => x.kind === 'fingerprint_collision');
  assert.ok(w, `校验没把撞车的栏位说出来：${JSON.stringify(check.warnings)}`);
  assert.match(w.action, /当作一组|别记本站/, '要说下一步怎么对待它，不能只报现象');
});

test('摘要里的每个数字都是数出来的，不是抄来的文案', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'contact.phone', '13800001234');
  const fields = [pf({ label: '手机号码', name: 'phone' }), pf({ label: '闻所未闻的名字', name: 'q' })];
  const { table } = scanAndPlan(fields, p);
  const line = describeMappingTable(table);
  assert.match(line, new RegExp(`本页 ${table.stats.fields} 栏`));
  assert.match(line, new RegExp(`打算写 ${table.stats.decided} 栏`));
  assert.match(line, /没有你的任何取值/, '导出前这句话是承诺，要在摘要里');
});

/** ── 计划校验：整页的算术 ─────────────────────────────────────── */
test('段数校验双向都报：资料多了说"没地方写"，页面多了说"后面几组留空"', () => {
  const p = createEmptyProfile();
  for (let i = 0; i < 3; i++) setValueByPath(p, `internship.${i}.company`, `甲公司${i}`);
  const oneGroup = [pf({ label: '实习公司名称', name: 'ic', id: 'i1', sectionHint: 'internship' })];
  const plan1 = planFill(oneGroup, p, { mode: 'full' });
  const c1 = checkPlan({ fields: oneGroup, plan: plan1, profile: p, schemaFields: SCHEMA });
  const w1 = c1.warnings.find(w => w.kind === 'records_no_room');
  assert.ok(w1, `资料有 3 段、页面只有一组，却没报"没地方写"：${JSON.stringify(c1.warnings)}`);
  assert.match(w1.zh, /3 段/);
  assert.match(w1.action, /添加一段|扩行/, '下一步动作要说得出（那是 S7 的开关）');

  const p2 = createEmptyProfile();
  setValueByPath(p2, 'internship.0.company', '甲公司');
  const threeGroups = [0, 1, 2].map(i => pf({ label: '实习公司名称', name: 'ic', id: `i${i}`, sectionHint: 'internship', itemIndex: i }));
  const plan2 = planFill(threeGroups, p2, { mode: 'full' });
  const c2 = checkPlan({ fields: threeGroups, plan: plan2, profile: p2, schemaFields: SCHEMA });
  const w2 = c2.warnings.find(w => w.kind === 'records_missing');
  assert.ok(w2, `页面有 3 组、资料只有 1 段，却没报"后面会空着"：${JSON.stringify(c2.warnings)}`);
  assert.match(w2.zh, /只填了 1 段/);
});

test('两个槽位占用检查：同一非列表槽位被两栏认领要报出来', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', '张三');
  const f1 = pf({ label: 'Candidate Name', name: 'n1', id: 'n1' });
  const f2 = pf({ label: 'Legal Name', name: 'n2', id: 'n2' });
  // 本地分配不会让两栏抢同一个非列表槽位（匈牙利那一层拦住了），
  // 但两条人工改判会 —— 这正是校验要盯的通路
  const rules = {
    [fingerprint(f1)]: { fp: fingerprint(f1), path: 'basics.name', skip: false },
    [fingerprint(f2)]: { fp: fingerprint(f2), path: 'basics.name', skip: false },
  };
  const { check } = scanAndPlan([f1, f2], p, { siteRules: rules, fillSensitive: true });
  const w = check.warnings.find(x => x.kind === 'duplicate_slot');
  assert.ok(w, `两条改判撞到同一个槽位却没报：${JSON.stringify(check.warnings)}`);
  assert.match(w.zh, /basics\.name|姓名/);
  assert.match(w.action, /映射表/);
});

test('必填栏没安排值：报数量、报是谁，并说清提交会被拦', () => {
  const p = createEmptyProfile();
  const fields = [pf({ label: '闻所未闻的必填栏', name: 'weird', id: 'w1', required: true })];
  const { check } = scanAndPlan(fields, p);
  const w = check.warnings.find(x => x.kind === 'required_unplanned');
  assert.ok(w, '必填却没安排值，必须报');
  assert.equal(w.count, 1);
  assert.deepEqual(w.labels, ['闻所未闻的必填栏']);
  assert.equal(check.ok, false, '这种警告算"落笔前该看一眼"');
});

test('整页一个都不写：单独一条，并带上原因分布（这就是诊断表）', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', '张三');
  const fields = [
    pf({ label: '验证码', name: 'captcha', id: 'c1' }),
    pf({ label: '上传附件', type: 'file', kind: 'file', name: 'f', id: 'f1' }),
  ];
  const { check } = scanAndPlan(fields, p);
  const w = check.warnings.find(x => x.kind === 'nothing_to_write');
  assert.ok(w, `一栏都不写却没报：${JSON.stringify(check.warnings)}`);
  assert.equal(w.count, 2);
  assert.ok(Object.keys(w.reasons).length >= 2, JSON.stringify(w.reasons));
  assert.match(w.action, /导出没填的字段与选项/);
});

test('干净的一页不该有噪音：能写的都写上时，校验说"对得上"', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'education.0.school', '复旦大学');
  setValueByPath(p, 'education.0.major', '工程');
  const { check } = scanAndPlan([pf({ label: '学校名称', name: 'school' }), pf({ label: '专业名称', name: 'major' })], p);
  assert.deepEqual(check.warnings.filter(w => ['nothing_to_write', 'duplicate_slot', 'required_unplanned'].includes(w.kind)), []);
  assert.match(describePlanCheck(check), /没有需要你先处理的|^计划校验/);
});

test('计数函数自己也算得对：filledRecordCount / pageRecordGroups', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'education.0.school', 'Fudan University');
  setValueByPath(p, 'education.2.school', '某大学');   // 第 1 段空着、第 2 段有 → 算 2 段
  assert.equal(filledRecordCount(p, SCHEMA, 'education'), 2);
  const fields = [
    pf({ label: '学校', itemIndex: 0 }), pf({ label: '专业', itemIndex: 0 }), pf({ label: '学校', itemIndex: 1 }),
  ];
  assert.equal(pageRecordGroups(fields, [0, 1, 2]), 2);
  assert.equal(pageRecordGroups(fields, [0, 1]), 1);
});
