// 资料体检：把"站点会问、但你还没填"的槽位摊到眼前。
// 纯函数，不碰 DOM / chrome API，可在 node --test 下直接覆盖。
// 高频判定来自 core/high-frequency.json（由 tools/gen-high-frequency.mjs 从判分标准生成），不是我凭感觉列的清单。

import { SECTIONS, buildFields, getValueByPath, isLangNeutral, readLang, englishNameFor, englishOption, valueNeedsEnglish } from './profile-schema.js';

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
 *
 * lang='en' 时同一批行改读改写到 profile.en 子树（用户要的"中英两版表单"就是这一层）：
 *  · label 换成英文显示名，下拉选项换成中英等价表里的拉丁写法；
 *  · value 是英文值，altValue 带着中文值当参照（EN 模式下看着中文填英文，不用来回切）；
 *  · needsEnglish 标出"中文填了、英文还空着"的栏 —— 英文表单遇到这些栏位会拒绝写入，
 *    所以它们必须一眼能数清，否则用户要到填写时才发现缺一片。
 */
export function editorModel(profile, { onlyEmpty = false, includeAllSlots = false, lang = 'zh' } = {}) {
  const en = lang === 'en';
  const fields = buildFields();
  return SECTIONS.map(s => {
    const own = fields.filter(f => f.section === s.k);
    let picked = own;
    if (s.maxItems && !includeAllSlots) {
      const lastUsed = Math.max(-1, ...own
        .filter(f => isFilled(String(readPath(profile, f.path) ?? ''))
          || isFilled(String(readPath(profile, `en.${f.path}`) ?? '')))
        .map(f => f.itemIndex ?? -1));
      const allowed = new Set();
      for (let i = 0; i <= Math.min(s.maxItems - 1, lastUsed + 1); i++) allowed.add(i);
      picked = own.filter(f => f.itemIndex == null || allowed.has(f.itemIndex));
    }
    const rows = picked.map(f => {
      const zhValue = String(readPath(profile, f.path) ?? '');
      const enValue = String(readPath(profile, `en.${f.path}`) ?? '');
      const neutral = isLangNeutral(f);
      // 中文值里本来就没汉字（拼音姓名、China、数字）→ 两种语言共用，不该催用户补第二遍
      const needsEnglish = !neutral && valueNeedsEnglish(zhValue) && !enValue.trim();
      return {
        path: f.path,
        label: en
          ? `${englishNameFor(f)}${f.itemIndex == null ? '' : ` #${(f.itemIndex ?? 0) + 1}`}`
          : (f.itemIndex == null ? f.zh : `${f.zh}（第 ${(f.itemIndex ?? 0) + 1} 条）`),
        labelZh: f.zh,
        type: f.type,
        // options 是"看得见的文字"，optionValues 是"真正存进 profile 的规范值"。
        // 枚举/布尔是两种语言同一个值：EN 模式显示 Male，存的仍是 男 ——
        // 把英文写回 profile 会让选项匹配、体检、回读三处一起错乱。
        options: (f.options || []).map(o => (en ? englishOption(o) : o)),
        optionValues: (f.options || []).slice(),
        neutral,
        sensitive: Boolean(f.sensitive),
        value: en ? readLang(profile, f.path, 'en', { field: f }) : zhValue,
        // 中性栏位（日期/邮箱/下拉…）两种语言同一个值，EN 模式下不该显示"缺英文"
        altValue: en ? zhValue : enValue,
        needsEnglish,
        lang,
      };
    });
    return {
      k: s.k, zh: s.zh, en: s.en, isList: Boolean(s.maxItems), lang,
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
