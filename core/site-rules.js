// 站点改判规则：把"这一页的这一栏其实该填哪个资料槽位"记在**这台浏览器的这个站点**上。
//
// 为什么必须有（用户 2026-10-02 定的口径："一律先出映射表再写"）：
// 映射表里人工改判一次，如果只活在这一轮扫描里，下一页、下一次重载又要从头判 ——
// 而网申是分步表单，用户每点一次"下一步"就是一次新扫描。
// 改判沉淀下来之后，同一站点重扫直接命中，这才是"人工确认"能承受的代价。
//
// 为什么按**指纹**而不是按 index：与 core/ledger.js 同一个理由（SPA 会重建节点，
// 第 3 个输入框明天可能排第 5 个）。指纹算法只在 ledger.js 里实现一次，
// 这里直接复用 —— 两处各算一份迟早漂移，漂移的结果是"台账说是我们写的、规则却找不着栏"。
//
// 边界（这几条是本项目的硬约束，改这里之前先读 docs/SCOPE）：
//  · 规则只能指向 schema 里**真实存在的槽位**，或者明确"这一栏不自动填"；不接受自造路径、
//    不接受取值 —— 改判决定的是"这一格是什么"，不是"这一格写什么"。
//  · 按 origin 分桶，永不跨站点生效：途普上把 Name 判成"学校名称"，
//    换一家公司就可能完全相反。
//  · 存的一直是"栏位长什么样 → 槽位名"，里面没有任何简历取值，因此它可以随
//    「导出」一起给人看，也不会因为多存一个桶就把 profile 带出去。

import { fingerprint } from './ledger.js';
import { BUILD } from './build.js';

export const RULES_BUCKET = 'nwSiteRules';
export const RULES_CAP_PER_ORIGIN = 200;
export const RULES_CAP_ORIGINS = 40;
/** 一条规则的说明文字上限：它是给人看的"为什么这么判"，不是记事本 */
export const RULE_NOTE_MAX = 120;

const httpOrigin = o => {
  const s = String(o || '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  try { return new URL(s).origin; } catch { return ''; }
};

/**
 * 单条规则的形状体检。返回 `{ ok:true, rule }` 或 `{ ok:false, why }`，
 * `why` 是要念给用户听的中文（"这条改判为什么没存进去"不能只留一个 false）。
 *
 * 校验放在这里而不是 UI：UI 给的是下拉框，但消息层谁都能发
 * （内容脚本、旧版面板、手搓的控制台），落库前必须自己拦得住。
 */
export function normalizeRule(entry, schemaFields = []) {
  const fp = String(entry?.fp || '').trim();
  if (!fp) return { ok: false, why: '没有栏位指纹（这一栏的页面描述读不到，存了也认不出是谁）' };
  const skip = entry?.skip === true;
  const path = String(entry?.path || '').trim();
  if (skip) {
    if (path) return { ok: false, why: '「这一栏不自动填」不能再同时指定槽位，两者只能选一个' };
    return { ok: true, rule: { fp, path: '', skip: true, note: cleanNote(entry.note) } };
  }
  if (!path) return { ok: false, why: '既没选槽位也没勾「不自动填」，这条改判没内容' };
  if (!schemaFields.length) return { ok: false, why: '资料槽位清单没传进来，无法核对这个路径是否真实存在' };
  if (!schemaFields.some(f => f.path === path)) {
    return { ok: false, why: `「${path}」不是资料里真实存在的槽位 —— 改判只能选已有的槽位，不能自造` };
  }
  return { ok: true, rule: { fp, path, skip: false, note: cleanNote(entry.note) } };
}

function cleanNote(note) {
  return String(note || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, RULE_NOTE_MAX);
}

/** 读某一站点的规则（返回的永远是新对象，调用方改不动存储里那份） */
export function rulesForOrigin(rules, origin) {
  const o = httpOrigin(origin);
  return o ? { ...((rules || {})[o] || {}) } : {};
}

/**
 * 写规则：`entries` = `[{ fp, path|skip, note }]`。
 * 返回 `{ rules, accepted, rejected }` —— **每一条被拒的都要带中文理由**，
 * 界面把它念出来。静默丢弃是这套系统里最招人烦的失败：
 * 用户点了"记住到本站"，第二天发现根本没记住，还以为是我们偷偷改了判。
 */
export function putRules(rules, origin, entries = [], opts = {}) {
  const o = httpOrigin(origin);
  if (!o) return { rules: rules || {}, accepted: 0, rejected: [{ fp: '', why: '当前页面不是 http(s) 站点，规则没地方存' }] };
  const at = Number(opts.at) || Date.now();
  const build = String(opts.build || BUILD);
  const byOrigin = { ...(rules || {}) };
  const mine = { ...(byOrigin[o] || {}) };
  const rejected = [];
  let accepted = 0;
  for (const entry of entries) {
    const r = normalizeRule(entry, opts.schemaFields || []);
    if (!r.ok) { rejected.push({ fp: String(entry?.fp || ''), why: r.why }); continue; }
    mine[r.rule.fp] = { ...r.rule, at, build };
    accepted++;
  }
  const keys = Object.keys(mine);
  if (keys.length > RULES_CAP_PER_ORIGIN) {
    keys.sort((a, b) => (mine[a].at || 0) - (mine[b].at || 0))
      .slice(0, keys.length - RULES_CAP_PER_ORIGIN)
      .forEach(k => delete mine[k]);
  }
  byOrigin[o] = mine;
  const origins = Object.keys(byOrigin);
  if (origins.length > RULES_CAP_ORIGINS) {
    origins.sort((a, b) => {
      const la = Math.max(0, ...Object.values(byOrigin[a] || {}).map(x => x.at || 0));
      const lb = Math.max(0, ...Object.values(byOrigin[b] || {}).map(x => x.at || 0));
      return la - lb;
    }).slice(0, origins.length - RULES_CAP_ORIGINS).forEach(k => delete byOrigin[k]);
  }
  return { rules: byOrigin, accepted, rejected };
}

/** 撤掉某一条改判（映射表里"取消记住"） */
export function dropRule(rules, origin, fps = []) {
  const o = httpOrigin(origin);
  if (!o || !rules || !rules[o]) return rules || {};
  const mine = { ...rules[o] };
  for (const fp of fps) delete mine[String(fp || '')];
  return { ...rules, [o]: mine };
}

/** 抹掉整一站点（「忘记本站的改判」/「清空所有改判」用；origin 传空就是全清） */
export function dropSiteRules(rules, origin) {
  if (!origin) return {};
  const o = httpOrigin(origin);
  if (!o || !rules) return rules || {};
  const out = { ...rules };
  delete out[o];
  return out;
}

/**
 * 把规则套到扫描结果上：`{ index → { path | skip, rule } }`。
 *
 * 只在这里把指纹换回 index —— 规则本身不知道 index，也不该知道。
 * 指纹撞车（同一页两栏自述完全相同）时**两栏一起命中**：
 * 那种页面本来就分不清谁是谁，规则层不假装能区分，但一定要说出来，
 * 否则映射表上会出现"我明明只改了一栏"的幻觉（界面上用 collision 计数提示）。
 */
export function applySiteRules(pageFields = [], rulesByFp = {}) {
  const byIndex = new Map();
  const byFpCount = new Map();
  pageFields.forEach(pf => {
    const fp = fingerprint(pf);
    byFpCount.set(fp, (byFpCount.get(fp) || 0) + 1);
  });
  pageFields.forEach((pf, index) => {
    const fp = fingerprint(pf);
    const rule = rulesByFp[fp];
    if (!rule) return;
    byIndex.set(index, {
      fp,
      path: rule.skip ? '' : String(rule.path || ''),
      skip: Boolean(rule.skip),
      note: String(rule.note || ''),
      shared: (byFpCount.get(fp) || 1) > 1 ? byFpCount.get(fp) : 0,
    });
  });
  return { pins: byIndex, covered: byIndex.size };
}

/**
 * 改判下拉框的选项：按板块分组的**真实槽位**清单。
 *
 * 为什么要带 search 与 limit：519 个槽位摊成一个 <select> 是没法用的，
 * 而"随便输一个词"又会把 AI 那套模糊匹配请回来 —— 这里只做
 * 槽位名/别名的字面过滤，且永远限定在 buildFields() 给出的封闭集合内。
 */
export function slotChoices(schemaFields = [], query = '', limit = 60) {
  const q = String(query || '').trim().toLowerCase();
  const pool = schemaFields.filter(f => f && f.path);
  const hit = (q ? pool.filter(f => {
    const hay = [f.zh, f.path, ...(f.labels || [])].map(x => String(x || '').toLowerCase()).join(' ');
    return hay.includes(q);
  }) : pool);
  return hit.slice(0, limit).map(f => ({
    path: f.path,
    zh: f.zh || f.path,
    section: f.section || '',
    itemIndex: f.itemIndex ?? null,
    sensitive: Boolean(f.sensitive),
  }));
}
