// 计划校验（S6）：落笔前把"这页我们真写得动吗"算一遍。
//
// 为什么必须有：映射表一行一栏看得很清楚，但**整页的形状**看不出来 ——
// 最典型的是分段经历：页面给了三行实习、资料里只有两段，
// 于是第三行永远空着，而每一栏单看都"合理"。这类问题只有把两边数量摆在一起才会现形，
// 用户原话就是这个："name 能填成 last name，phone number 能填成 id number…
// 你应该审视你的匹配方法" —— 审视的落脚点是一页的总量，不是单栏的分数。
//
// 这里的每一条都必须**算得出来**（页面栏数 × 资料段数 × 本轮计划），
// 不允许出现"看起来不太对"这种没有下一步动作的提示。

import { getValueByPath } from './profile-schema.js';
import { fingerprint } from './ledger.js';

/** 资料里某一段列表真正填了几段：一个 itemIndex 下只要有一栏有值就算一段 */
export function filledRecordCount(profile, schemaFields, section) {
  const seen = new Set();
  for (const f of schemaFields) {
    if (f.section !== section || f.itemIndex == null) continue;
    const v = String(getValueByPath(profile, f.path) ?? '').trim();
    if (v) seen.add(f.itemIndex);
  }
  return seen.size;
}

/** 页面上这一节被排成了几组：按扫描器给的重复区块序号数（没有序号就当一组） */
export function pageRecordGroups(fields, indexes) {
  const set = new Set();
  for (const i of indexes) {
    const f = fields[i] || {};
    set.add(f.itemIndex == null ? '·' : String(f.itemIndex));
  }
  return set.size;
}

const sectionOf = path => String(path || '').split('.')[0];

/**
 * @param {object} o.fields      扫描结果
 * @param {object} o.plan        planFill 结果
 * @param {object} o.profile     资料
 * @param {Array}  o.schemaFields buildFields()
 * @param {object} o.table       buildMappingTable 的结果（可选，用来报"这一页一个都不写"）
 */
export function checkPlan({ fields = [], plan, profile = {}, schemaFields = [], table = null } = {}) {
  const warnings = [];
  const assignments = (plan?.assignments || []).filter(a => !a.skip && a.path);
  const gaps = plan?.gaps || [];

  // ── ① 段数对不上（双向都报，因为下一步动作完全不同）────────────────
  const bySection = new Map();
  for (const a of assignments) {
    const s = sectionOf(a.path);
    if (!bySection.has(s)) bySection.set(s, []);
    bySection.get(s).push(a.index);
  }
  const listSections = [...new Set(schemaFields.filter(f => f.itemIndex != null).map(f => f.section))];
  for (const s of listSections) {
    const idx = bySection.get(s) || [];
    if (!idx.length) continue;
    /**
     * "页面把这一节排成了几组"是**页面的事实**，不是我们计划的事实。
     * 只数已分配的行会漏掉最典型的一种失败：页面给了三行实习、资料只有一段，
     * 于是后两行根本没进计划（栏栏都"合理"，整页却在漏），算出来反而是"对得上"。
     * 所以这一节里有章节线索的栏位一起数进来。
     */
    const inSection = new Set(idx);
    fields.forEach((f, i) => { if (f && f.sectionHint === s) inSection.add(i); });
    const members = [...inSection];
    const have = filledRecordCount(profile, schemaFields, s);
    const page = pageRecordGroups(fields, members);
    const planned = members.filter(i => fields[i]?.itemIndex != null).map(i => fields[i].itemIndex);
    const maxPlanned = planned.length ? Math.max(...planned) + 1 : 0;
    const zh = SECTION_ZH[s] || s;
    if (have > page) {
      warnings.push({
        kind: 'records_no_room', section: s, have, page,
        zh: `资料里有 ${have} 段「${zh}」，这一页只排了 ${page} 组：至少有 ${have - page} 段没地方写。`,
        action: '要么这一页本来就只收一段（"最高学历""最近一份工作"很常见），要么它有个「+ 添加一段」要点下去才出得了新行 —— 后者是 S7 的扩行代理，默认关着，要我们代点就去设置里打开。',
      });
    } else if (page > have && maxPlanned > have - 1) {
      warnings.push({
        kind: 'records_missing', section: s, have, page,
        zh: `这一页有 ${page} 组「${zh}」，资料里只填了 ${have} 段：从第 ${have + 1} 组开始的框我们会留着不写。`,
        action: '去「资料」里把后面几段补上再扫；补不了就说明这一页确实只有这么几段，忽略本条。',
      });
    }
  }

  // ── ② 同一个非列表槽位被两栏认领 ────────────────────────────────
  const claimed = new Map();
  for (const a of assignments) {
    const key = a.path;
    if (!claimed.has(key)) claimed.set(key, []);
    claimed.get(key).push(a.index);
  }
  for (const [path, indexes] of claimed) {
    const isList = schemaFields.some(f => f.path === path && f.itemIndex != null);
    if (indexes.length < 2) continue;
    if (!isList) {
      warnings.push({
        kind: 'duplicate_slot', path, indexes,
        zh: `页面上有 ${indexes.length} 栏都判给了「${zhOf(schemaFields, path)}」，但那是个只能填一次的位置。`,
        action: '在映射表里把多余那一栏改判到正确的槽位，或勾「这一栏不自动填」。',
      });
    } else {
      const same = indexes.filter(i => (fields[i] || {}).itemIndex == null).length;
      if (same >= 2) {
        warnings.push({
          kind: 'duplicate_record_slot', path, indexes,
          zh: `「${zhOf(schemaFields, path)}」被同一节的 ${same} 栏认领，而页面上没给出「这是第几段」的证据。`,
          action: '在映射表里逐栏改判到第 1 / 第 2 条；不确定就只填第一条、其余勾不填。',
        });
      }
    }
  }

  // ── ③ 必填栏没安排值 ────────────────────────────────────────────
  const plannedIndexes = new Set(assignments.map(a => a.index));
  const requiredEmpty = fields
    .map((f, i) => ({ f, i }))
      .filter(({ f, i }) => f?.required && !plannedIndexes.has(i));
  if (requiredEmpty.length) {
    warnings.push({
      kind: 'required_unplanned', count: requiredEmpty.length,
      labels: requiredEmpty.slice(0, 6).map(x => String(x.f.label || x.f.name || x.f.id || '(未命名)').slice(0, 30)),
      zh: `有 ${requiredEmpty.length} 栏站点标了必填，但我们没能安排值 —— 提交会被它拦下来。`,
      action: '在映射表里对着这些栏点「改判」指定槽位，或直接手填。缺口原因每栏都写在表里了。',
    });
  }

  // ── ④ 整页一个都不写 ────────────────────────────────────────────
  if (fields.length && !assignments.length) {
    const reasons = gaps.reduce((acc, g) => (acc[g.reason] = (acc[g.reason] || 0) + 1, acc), {});
    warnings.push({
      kind: 'nothing_to_write', count: fields.length, reasons,
      zh: `这一页 ${fields.length} 栏，我们一栏都不写。`,
      action: `最常见的原因是标签没采到或说法不在词典里（本轮原因分布：${Object.entries(reasons).map(([k, v]) => `${k}×${v}`).join('、') || '无'}）。先「导出没填的字段与选项」，那份表就是诊断表。`,
    });
  }

  // ── ⑤ 指纹撞车：一条改判会同时落到好几栏 ─────────────────────────
  const fpCount = new Map();
  fields.forEach(f => {
    const fp = fingerprint(f || {});
    fpCount.set(fp, (fpCount.get(fp) || 0) + 1);
  });
  const colliding = [...fpCount.values()].filter(n => n > 1);
  if (colliding.length) {
    warnings.push({
      kind: 'fingerprint_collision', count: colliding.reduce((a, b) => a + b, 0),
      zh: `有 ${colliding.length} 组栏位的页面自述完全相同（共 ${colliding.reduce((a, b) => a + b, 0)} 栏），它们的归属判定与「记住到本站」会一起生效。`,
      action: '这种页面本来就分不清谁是谁：逐栏确认时把它们当作一组看，或者只本轮确认、别记本站。',
    });
  }

  return { warnings, ok: !warnings.some(w => ['nothing_to_write', 'duplicate_slot', 'required_unplanned'].includes(w.kind)) };
}

function zhOf(schemaFields, path) {
  const f = schemaFields.find(x => x.path === path);
  return f?.zh || path;
}

const SECTION_ZH = {
  education: '教育经历', work: '工作经历', internship: '实习经历', projects: '项目经历',
  certifications: '证书', languages: '语言', awards: '获奖', campus: '校园活动',
  family: '家庭成员', publications: '论文/专利', competitions: '竞赛', skills: '技能',
};

/** 摘要一句话：把校验结果压成能读的一行（导出与界面都用它） */
export function describePlanCheck(result) {
  const w = result?.warnings || [];
  if (!w.length) return '计划校验：段数、槽位占用、必填栏都对得上，没有需要你先处理的。';
  const must = w.filter(x => ['nothing_to_write', 'duplicate_slot', 'required_unplanned'].includes(x.kind));
  return `计划校验：${w.length} 条提示${must.length ? `，其中 ${must.length} 条建议落笔前先看` : ''}。`;
}
