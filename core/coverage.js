// 资料体检：把"站点会问、但你还没填"的槽位摊到眼前。
// 纯函数，不碰 DOM / chrome API，可在 node --test 下直接覆盖。
// 高频判定来自 core/high-frequency.json（由 tools/gen-high-frequency.mjs 从判分标准生成），不是我凭感觉列的清单。

import { SECTIONS, buildFields, getValueByPath } from './profile-schema.js';

const isFilled = v => typeof v === 'string' && v.trim() !== '';

function readPath(profile, path) {
  return getValueByPath(profile, path);
}

/** 体检总览：填写率 + 高频缺口 + 分组统计 */
export function auditProfile(profile, highFreq = {}) {
  const paths = highFreq?.paths || {};
  const fields = buildFields();
  let filled = 0;
  for (const f of fields) if (isFilled(String(readPath(profile, f.path) ?? ''))) filled++;

  const missingHigh = Object.entries(paths)
    .map(([p, askedBy]) => ({ path: p, askedBy }))
    .filter(({ path }) => !isFilled(String(readPath(profile, path) ?? '')))
    .map(({ path, askedBy }) => {
      const meta = fields.find(f => f.path === path);
      const section = SECTIONS.find(s => path.split('.')[0] === s.k);
      return {
        path, askedBy,
        label: meta ? meta.zh : path,
        sectionZh: section ? section.zh : path.split('.')[0],
        sensitive: meta ? Boolean(meta.sensitive) : false,
        type: meta ? meta.type : 'text',
      };
    })
    .sort((a, b) => b.askedBy - a.askedBy || a.path.localeCompare(b.path));

  const sectionStats = SECTIONS.map(s => {
    const list = fields.filter(f => f.section === s.k);
    const n = list.filter(f => isFilled(String(readPath(profile, f.path) ?? ''))).length;
    return { k: s.k, zh: s.zh, en: s.en, filled: n, total: list.length, isList: Boolean(s.maxItems) };
  });

  return {
    total: fields.length,
    filled,
    rate: fields.length ? Number((filled / fields.length).toFixed(3)) : 0,
    highFreqTotal: Object.keys(paths).length,
    missingHigh,
    sectionStats,
  };
}

/**
 * 结构化编辑要渲染的行。
 * 列表分组（教育/工作/家庭…）只展开"已用到 + 一个空槽"：
 * 526 个槽位一次摊开会让人直接放弃，而尾部空槽也不会被填到。
 */
export function editorModel(profile, { onlyEmpty = false, includeAllSlots = false } = {}) {
  const fields = buildFields();
  return SECTIONS.map(s => {
    const own = fields.filter(f => f.section === s.k);
    let picked = own;
    if (s.maxItems && !includeAllSlots) {
      const lastUsed = Math.max(-1, ...own
        .filter(f => isFilled(String(readPath(profile, f.path) ?? '')))
        .map(f => f.itemIndex ?? -1));
      const allowed = new Set();
      for (let i = 0; i <= Math.min(s.maxItems - 1, lastUsed + 1); i++) allowed.add(i);
      picked = own.filter(f => f.itemIndex == null || allowed.has(f.itemIndex));
    }
    const rows = picked.map(f => ({
      path: f.path,
      label: f.itemIndex == null ? f.zh : `${f.zh}（第 ${(f.itemIndex ?? 0) + 1} 条）`,
      type: f.type,
      options: f.options || [],
      sensitive: Boolean(f.sensitive),
      value: String(readPath(profile, f.path) ?? ''),
    }));
    return {
      k: s.k, zh: s.zh, en: s.en, isList: Boolean(s.maxItems),
      rows: onlyEmpty ? rows.filter(r => !isFilled(r.value)) : rows,
    };
  }).filter(sec => sec.rows.length);
}

/** 给"这一页为什么大面积标橙"的一句话结论 */
export function advice(audit) {
  if (!audit.highFreqTotal) return '缺少高频槽位清单，先运行 node tools/gen-high-frequency.mjs';
  const top = audit.missingHigh.slice(0, 3).map(m => `${m.sectionZh}·${m.label}`).join('、');
  if (!top) return `高频槽位都已填写（共填写 ${audit.filled}/${audit.total}）`;
  return `优先补这几项：${top}。它们被最多的真实站点问到，空着就会标橙交人工。`;
}
