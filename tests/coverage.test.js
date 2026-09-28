import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { auditProfile, editorModel, advice } from '../core/coverage.js';
import { createEmptyProfile, setValueByPath, SECTIONS } from '../core/profile-schema.js';
import { sampleProfile } from './fixtures/sample-profile.js';

const SECTION_KEYS = new Set(SECTIONS.map(s => s.k));

const HIGH = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../core/high-frequency.json', import.meta.url)), 'utf8'));

test('高频清单本身是生成物，不是手写的空壳', () => {
  assert.ok(Array.isArray(HIGH.forms) && HIGH.forms.length >= 5, '应记录来源判分标准');
  assert.ok(Object.keys(HIGH.paths).length > 40);
  // 频次从判分标准现算，避免加一张仿真表就要回来改常量
  const dir = fileURLToPath(new URL('../tools/expected', import.meta.url));
  const recount = new Map();
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(`${dir}/${file}`, 'utf8'));
    for (const v of Object.values(j.expect || {})) for (const p of Array.isArray(v) ? v : [v]) recount.set(p, (recount.get(p) || 0) + 1);
  }
  assert.equal(HIGH.forms.length, fs.readdirSync(dir).filter(f => f.endsWith('.json')).length, 'HIGH.forms 与判分标准不同步，跑 node tools/gen-high-frequency.mjs');
  for (const [p, n] of recount) assert.equal(HIGH.paths[p], n, `${p} 频次过期了`);
  assert.ok(HIGH.paths['education.0.major'] >= 7, '每张表几乎都问专业');
  for (const [p, n] of Object.entries(HIGH.paths)) {
    assert.ok(Number.isInteger(n) && n > 0, `${p} 的次数非法`);
    assert.match(p, /^[a-zA-Z]+\.\d*\d?\.?[a-zA-Z]+$/, `${p} 形状不像槽位路径`);
    assert.ok(SECTION_KEYS.has(p.split('.')[0]), `${p} 不在已知分组里`);
  }
});

test('空 profile：高频槽位全部列成缺口，并按被问次数排序', () => {
  const a = auditProfile(createEmptyProfile(), HIGH);
  assert.equal(a.filled, 0);
  assert.equal(a.rate, 0);
  assert.equal(a.missingHigh.length, Object.keys(HIGH.paths).length);
  assert.equal(a.missingHigh[0].path, 'education.0.major');
  assert.equal(a.missingHigh[0].label, '专业');
  assert.equal(a.missingHigh[0].sectionZh, '教育经历');
  for (let i = 1; i < a.missingHigh.length; i++) {
    assert.ok(a.missingHigh[i - 1].askedBy >= a.missingHigh[i].askedBy, '缺口必须按被问次数降序');
  }
  assert.match(advice(a), /优先补/);
});

test('有值的槽位不再出现在缺口里，分组统计对得上总数', () => {
  const p = sampleProfile();
  const a = auditProfile(p, HIGH);
  assert.ok(!a.missingHigh.some(m => m.path === 'education.0.major'));
  assert.equal(a.filled, a.sectionStats.reduce((s, x) => s + x.filled, 0));
  assert.equal(a.total, a.sectionStats.reduce((s, x) => s + x.total, 0));
  assert.ok(a.rate > 0 && a.rate < 1);

  // 敏感字段（证件号默认不自动写）空着时必须被标出来，让用户知道要自己补
  setValueByPath(p, 'basics.idNumber', '');
  const gone = auditProfile(p, HIGH).missingHigh.find(m => m.path === 'basics.idNumber');
  assert.ok(gone, '清空证件号后它应出现在缺口里');
  assert.equal(gone.sensitive, true);
});

test('编辑模型：列表分组只展开"已用到 + 一个空槽"，不摊开 526 项', () => {
  const edu = editorModel(createEmptyProfile()).find(s => s.k === 'education');
  assert.ok(edu.rows.every(r => r.path.startsWith('education.0.')), '空资料时只该给第 1 条');
  assert.equal(new Set(edu.rows.map(r => r.path.split('.')[1])).size, 1);

  const p = createEmptyProfile();
  setValueByPath(p, 'education.1.school', '南京大学');
  const edu2 = editorModel(p).find(s => s.k === 'education');
  const slots = new Set(edu2.rows.map(r => r.path.split('.')[1]));
  assert.deepEqual([...slots].sort(), ['0', '1', '2'], '用到第 2 条时给出第 2、3 条（第 1 条空着不该出现）');

  const all = editorModel(createEmptyProfile(), { includeAllSlots: true }).find(s => s.k === 'education');
  assert.equal(new Set(all.rows.map(r => r.path.split('.')[1])).size, 4, '全展开开关要真的全展开');
});

test('只看没填的开关会过滤掉已有值，且枚举行带候选项给 UI', () => {
  const p = sampleProfile();
  const onlyEmpty = editorModel(p, { onlyEmpty: true });
  assert.ok(onlyEmpty.every(s => s.rows.length && s.rows.every(r => !r.value.trim())));
  const basics = editorModel(p).find(s => s.k === 'basics');
  const gender = basics.rows.find(r => r.path === 'basics.gender');
  assert.equal(gender.type, 'enum');
  assert.ok(gender.options.length > 1, '枚举字段要带下拉候选，避免让用户手打错词');
});
