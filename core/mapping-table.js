// 映射表（S6）：把"这一页每一栏，我们打算怎么对待它"摊成一行一栏的对照表。
//
// 为什么单独一个模块而不是在侧边栏里拼：这张表同时是
//  ① 用户确认前唯一的读物（"一律先出映射表再写"是他定的口径），
//  ② 「导出这张表」的内容（要能贴给别人看），
//  ③ 排障时的诊断表（reason 分布就是诊断表，用户已经会用这两只只读导出回报现象）。
// 三处共用一份构造，才不会"面板上写着有依据、导出来一句空话"。
//
// 隐私：行里只有**页面自己的描述**与**槽位名**，永远没有资料取值。
// 需要看写了什么值的是写入后的 results（那是用户屏幕上的一份，不进导出）。

import { fingerprint, classify } from './ledger.js';
import { gapReasonLabel } from './matcher.js';

/** 槽位路径 → 中文栏名（界面上"这一栏我们判给谁"要念人话，不能只念 `work.0.company`） */
export function slotZhFor(schemaFields = [], path = '') {
  const f = schemaFields.find(x => x.path === path);
  if (!f) return path;
  const base = f.zh || path;
  return f.itemIndex == null ? base : `${base}（第 ${(f.itemIndex ?? 0) + 1} 条）`;
}

/** 一栏的"谁定的"：来历不同，用户下一步动作就不同 */
export const DECISION_BY_ZH = {
  siteRule: '你在本站的改判',
  confirmed: '你本轮在映射表点的',
  adapter: '站点适配器钉位',
  local: '本地词典匹配',
  ai: 'AI 概念映射',
  none: '没定下来',
};

const clip = (s, n) => {
  const t = String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * @param {object}   o.fields        dom/scanner.js 的扫描结果（含 el，本模块不碰 el）
 * @param {object}   o.plan          core/matcher.js 的 planFill 结果
 * @param {object}   o.results       filler.applyPlan 的回读结果（预演时也有 planned 行）
 * @param {object}   o.ledger        写入台账（整桶或本 origin 那一层都行）
 * @param {string}   o.origin        当前站点
 * @param {object}   o.siteRules     {fp → rule}，本站点生效的那份（含本轮临时确认）
 * @param {string}   o.temporaryFps  本轮临时确认的指纹集合（区分"记本站"与"只这一次"）
 * @param {Array}    o.schemaFields  buildFields()：槽位中文名用
 */
export function buildMappingTable({ fields = [], plan, results = [], ledger = {}, origin = '', siteRules = {}, temporaryFps = [], schemaFields = [] } = {}) {
  const byIndex = new Map();
  const put = (index, patch) => {
    if (index == null || index < 0) return;
    byIndex.set(Number(index), { ...(byIndex.get(Number(index)) || {}), ...patch });
  };
  for (const a of (plan?.assignments || [])) {
    put(a.index, {
      path: a.path || '',
      tier: a.skip ? 'skip' : (a.tier || 'auto'),
      note: clip(a.note, 200),
      by: a.pinnedBy === 'siteRule' ? (temporaryFps.includes(fingerprint(fields[a.index] || {})) ? 'confirmed' : 'siteRule')
        : a.pinnedBy === 'adapter' ? 'adapter'
        : a.aiChosen ? 'ai' : a.path ? 'local' : 'none',
      evidence: (a.evidence || []).map(e => clip(typeof e === 'string' ? e : `${e.kind}:${e.detail ?? e.word ?? ''}`, 60)).slice(0, 8),
      score: typeof a.score === 'number' ? Number(a.score.toFixed(3)) : null,
      skip: Boolean(a.skip),
      skipReason: a.skip ? (a.reason || '') : '',
      weak: Boolean(a.weakEvidence),
      shape: a.shapeMismatch || '',
    });
  }
  for (const g of (plan?.gaps || [])) {
    put(g.index, {
      gap: g.reason || '',
      gapZh: clip(gapReasonLabel(g.reason), 200),
      note: clip(g.note, 200) || '',
      by: siteRules[fingerprint(fields[g.index] || {})] && g.reason === 'user_excluded' ? 'siteRule' : 'none',
      // 缺口里也带槽位的（slot_empty / pinned_field_empty / shape_mismatch）要单独显示：
      // "我们知道这一栏该存哪儿，只是那份资料是空的/形状不对" 和 "完全没定下来"
      // 是两种完全不同的下一步，混成"没定"就白找了。
      // 注意这里**不写进 decision.path** —— path 只说"这一栏我们打算写"，
      // 写进缺口行里就会让摘要把没写的栏数成"打算写"。
      slotGuess: g.slotPath || '',
    });
  }
  for (const r of (results || [])) {
    put(r.index, {
      outcome: r.status || '',
      failReason: r.failReason || '',
      actual: r.actual ? clip(r.actual, 40) : '',      // 只给屏幕看：导出前会被剥掉
    });
  }

  const fpSeen = new Map();
  fields.forEach(f => {
    const fp = fingerprint(f || {});
    fpSeen.set(fp, (fpSeen.get(fp) || 0) + 1);
  });

  const rows = fields.map((f, index) => {
    const fp = fingerprint(f || {});
    const d = byIndex.get(index) || {};
    const rule = siteRules[fp] || null;
    const cur = String(f?.currentValue ?? '').trim();
    return {
      index,
      fp,
      page: {
        label: clip(f?.labelRaw || f?.label, 90),
        labelSource: clip(f?.labelSource, 24),
        kind: clip(f?.kind, 20),
        required: Boolean(f?.required),
        multi: Boolean(f?.multi),
        section: clip(f?.sectionTitle || f?.sectionHint, 60),
        nearby: (f?.nearbyLabels || []).map(x => clip(x, 30)).filter(Boolean).slice(0, 6),
        description: clip(f?.description, 120),
        placeholder: clip(f?.placeholder, 60),
        options: (f?.options || []).slice(0, 24).map(o => {
          const t = clip(o?.text ?? o, 40);
          const v = clip(o?.value, 24);
          return v && v !== t ? `${t}=${v}` : t;
        }).filter(Boolean),
        itemIndex: f?.itemIndex ?? null,
        customSelect: Boolean(f?.customSelect),
      },
      decision: {
        path: d.path || '',
        zh: d.path ? clip(slotZhFor(schemaFields, d.path), 40) : '',
        by: d.by || 'none',
        byZh: DECISION_BY_ZH[d.by || 'none'] || d.by || '没定下来',
        tier: d.tier || '',
        score: d.score ?? null,
        note: d.note || '',
        evidence: d.evidence || [],
        gap: d.gap || '',
        gapZh: d.gapZh || '',
        slotGuess: d.slotGuess || '',
        slotGuessZh: d.slotGuess ? clip(slotZhFor(schemaFields, d.slotGuess), 40) : '',
        outcome: d.outcome || '',
        failReason: d.failReason || '',
        actual: d.actual || '',
        skip: Boolean(d.skip),
        skipReason: d.skipReason || '',
        weak: Boolean(d.weak),
      },
      current: origin ? classify(f || {}, cur, ledger, origin) : (cur ? 'other' : 'empty'),
      currentZh: { us: '我们上一轮写的', edited: '我们写过、被人改过', other: '站点或你自己填的', empty: '空的' }[origin ? classify(f || {}, cur, ledger, origin) : (cur ? 'other' : 'empty')] || '',
      rule: rule ? { path: rule.skip ? '' : clip(rule.path, 60), skip: Boolean(rule.skip), note: clip(rule.note, 120), temporary: Boolean(rule.temporary) } : null,
      collision: (fpSeen.get(fp) || 1) > 1 ? fpSeen.get(fp) : 0,
    };
  });

  const count = fn => rows.filter(fn).length;
  const stats = {
    fields: rows.length,
    decided: count(r => r.decision.path && !r.decision.skip),
    excluded: count(r => r.decision.skip || r.decision.gap === 'user_excluded'),
    unpinned: count(r => !r.decision.path && !r.decision.skip),
    byRule: count(r => r.decision.by === 'siteRule' || r.decision.by === 'confirmed'),
    collisions: count(r => r.collision > 1),
    alreadyFilled: count(r => r.current === 'other' || r.current === 'edited'),
    oursToFix: count(r => r.current === 'us' && r.decision.path),
    ai: count(r => r.decision.by === 'ai'),
  };
  return { rows, stats };
}

/**
 * 表头的摘要：一行话说清"这页我们打算动几栏、其中几栏是你定的"。
 * 摘要必须是数出来的，不能是从 stats 抄的 —— 抄一次就漂一次。
 */
export function describeMappingTable(table) {
  const s = table?.stats || {};
  const bits = [`本页 ${s.fields ?? 0} 栏`];
  bits.push(`打算写 ${s.decided ?? 0} 栏`);
  if (s.byRule) bits.push(`其中 ${s.byRule} 栏按你的改判`);
  if (s.excluded) bits.push(`你勾了不填 ${s.excluded} 栏`);
  if (s.unpinned) bits.push(`没定下来 ${s.unpinned} 栏`);
  if (s.alreadyFilled) bits.push(`${s.alreadyFilled} 栏已有别人的值（不动）`);
  if (s.oursToFix) bits.push(`${s.oursToFix} 栏是我们自己写过的（可纠正）`);
  if (s.collisions) bits.push(`注意：${s.collisions} 栏与别的栏自述完全相同，改判会一起生效`);
  return `${bits.join(' · ')}。表里只有页面文字与槽位名，没有你的任何取值。`;
}

/**
 * 导出用的脱敏视图：剥掉屏幕上的回读值，只留"栏位 ↔ 槽位 ↔ 依据"。
 * 「导出这张表」是要贴给别人看的，取值一旦进去就再也收不回来。
 */
export function plainMappingTable(table) {
  return {
    stats: table?.stats || {},
    rows: (table?.rows || []).map(r => ({
      index: r.index,
      label: r.page.label,
      labelSource: r.page.labelSource,
      kind: r.page.kind,
      required: r.page.required,
      section: r.page.section,
      nearby: r.page.nearby,
      options: r.page.options,
      description: r.page.description,
      itemIndex: r.page.itemIndex,
      current: r.current,
      path: r.decision.path,
      slotZh: r.decision.zh,
      by: r.decision.by,
      tier: r.decision.tier,
      gap: r.decision.gap,
      gapZh: r.decision.gapZh,
      slotGuess: r.decision.slotGuess,
      slotGuessZh: r.decision.slotGuessZh,
      evidence: r.decision.evidence,
      note: r.decision.note,
      rule: r.rule,
      collision: r.collision,
      fp: r.fp,
    })),
  };
}
