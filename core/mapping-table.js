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
export function buildMappingTable({ fields = [], plan, results = [], ledger = {}, origin = '', siteRules = {}, temporaryFps = [], storedRules = null, schemaFields = [] } = {}) {
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
      /**
       * "我们不动这一栏"有两种原因，界面上绝对不能都说成用户的决定（独立审查 I5）：
       *   yours —— 他在映射表勾了「这一栏不自动填」；
       *   kept  —— 已有值（站点预填 / 他自己填的 / 就是我们写的且值没变），按覆盖口径不动。
       * 把 kept 说成 yours，等于把我们自己的保守策略记在他头上，
       * 他下次就会问"我没勾过不填，为什么这栏没写"。
       */
      skipKind: a.skip ? (a.reason === 'user_excluded' ? 'yours' : 'kept') : '',
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
        skipKind: d.skipKind || (d.gap === 'user_excluded' ? 'yours' : ''),
        weak: Boolean(d.weak),
      },
      current: origin ? classify(f || {}, cur, ledger, origin) : (cur ? 'other' : 'empty'),
      currentZh: { us: '我们上一轮写的', edited: '我们写过、被人改过', other: '站点或你自己填的', empty: '空的' }[origin ? classify(f || {}, cur, ledger, origin) : (cur ? 'other' : 'empty')] || '',
      rule: (() => {
        if (!rule) return null;
        // 本轮临时确认压住了已记住的那条：两个都得显示，否则他以为"取消勾选就恢复原状"，
        // 而实际上关页之后旧规则又回来了（独立审查 Minor：只报临时那条会误导）
        const stored = storedRules ? storedRules[fp] : null;
        const shadow = stored && (stored.path !== rule.path || Boolean(stored.skip) !== Boolean(rule.skip))
          ? { path: stored.skip ? '' : clip(stored.path, 60), skip: Boolean(stored.skip) } : null;
        return { path: rule.skip ? '' : clip(rule.path, 60), skip: Boolean(rule.skip), note: clip(rule.note, 120), temporary: Boolean(rule.temporary), alsoStored: shadow };
      })(),
      collision: (fpSeen.get(fp) || 1) > 1 ? fpSeen.get(fp) : 0,
    };
  });

  const count = fn => rows.filter(fn).length;
  const isYours = r => r.decision.skipKind === 'yours' || (r.rule?.skip && r.decision.skip);
  const stats = {
    fields: rows.length,
    decided: count(r => r.decision.path && !r.decision.skip),
    // 「你勾了不填」只数真是他勾的；"已有值所以不动"是我们自己的口径，另算一格（I5）
    excluded: count(r => isYours(r)),
    keptFilled: count(r => r.decision.skip && !isYours(r)),
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
  if (s.keptFilled) bits.push(`${s.keptFilled} 栏已有值所以不动`);
  if (s.unpinned) bits.push(`没定下来 ${s.unpinned} 栏`);
  if (s.alreadyFilled) bits.push(`${s.alreadyFilled} 栏已有别人的值（不动）`);
  if (s.oursToFix) bits.push(`${s.oursToFix} 栏是我们自己写过的（可纠正）`);
  if (s.collisions) bits.push(`注意：${s.collisions} 栏与别的栏自述完全相同，改判会一起生效`);
  return `${bits.join(' · ')}。表里只有页面文字与槽位名，没有你的任何取值。`;
}

/**
 * 导出前的取值自查。两条严格程度不同的检查，各有各的道理：
 *  · 整份文档：只报**长度 ≥6** 的取值。像 '2025' 这种四位年份，页面上本来就常出现
 *    （「2025 届」「毕业年份」），一律拦就会出现"表是干净的却不让你导"的假阳性。
 *  · 说明文字（我们自己写进表里的 note / 用户填的理由）：任何 ≥2 字的取值都报。
 *    这里是唯一可能被人把简历内容手打进导出的口子 —— 用户在理由框里写"这就是我妈的名字"，
 *    那条值就跟着进文件了，而它不出现在 value 字段里。
 */
export function findValueLeaks(view, values = []) {
  const all = JSON.stringify(view ?? null);
  const notes = (view?.rows || [])
    .map(r => `${r.note || ''}\n${r.rule?.note || ''}\n${r.slotGuess || ''}`)
    .join('\n');
  const hits = new Set();
  for (const raw of values) {
    const s = String(raw || '').trim();
    if (s.length >= 6 && all.includes(s)) hits.add(`${s.slice(0, 3)}…（出现在表格正文）`);
    else if (s.length >= 2 && notes.includes(s)) hits.add(`${s.slice(0, 3)}…（出现在说明/理由里）`);
  }
  return [...hits].slice(0, 8);
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
      skipKind: r.decision.skipKind,
      skipReason: r.decision.skipReason,
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
