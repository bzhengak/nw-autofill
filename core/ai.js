// 混合 AI 兜底：只在本地词典卡住时，请外部模型"从我们已有的槽位里挑一个"。
//
// 三条不可谈判的边界（REQUIREMENTS §3.3 / §3.7，写代码前先定死）：
//  1. 请求里只允许出现页面字段名、控件类型、页面选项文本，以及 profile 的**槽位路径与中文名**。
//     任何简历取值都不许离开本机 —— 所以本模块只吃 plan，不吃 profile 的值。
//     assertNoProfileValues() 是这条边界的运行时自证：一旦取值出现在待发送文本里就拒绝发送。
//  2. AI 只能"选路径"，不能"造值"。返回的 path 必须在白名单里，值永远由本地从 profile 取。
//  3. AI 的结果永远是 review（黄字），永不自动写；敏感/声明/附件/验证码类控件根本不进候选。

import { buildFields, getValueByPath } from './profile-schema.js';

/** 允许参与 AI 的缺口原因：本地词典答不上来的那三种 */
export const AI_ELIGIBLE_REASONS = new Set(['no_candidate', 'required_no_candidate', 'conflict_unresolved']);

/** 永不让 AI 接触的槽位（即使 AI 提名也直接丢弃）：
 *  证件号/签证/薪酬期望/声明类 —— 要么是高敏感标识，要么必须本人表态。
 *  注意：这拦的是"路径能否被提名"，不是"值能否外发"（值本来就不外发）。
 *  姓名/生日/电话这类 sensitive 槽位允许被提名，但写入仍要走 fillSensitive 那道闸（见 applyAiCandidates）。 */
const AI_FORBIDDEN_SECTION = new Set(['records', 'declaration']);
export const AI_FORBIDDEN_KEY = /(idNumber|passport|visa|credential|signature|consent|agree|salary|expect|criminal|background)/i;

export function aiEligibleGaps(gaps = []) {
  return gaps.filter(g => AI_ELIGIBLE_REASONS.has(g.reason));
}

/** 可提名槽位白名单：只暴露路径 + 中文名 + 分组，不含取值、不含选项枚举 */
export function aiSlotCatalog(profile) {
  const catalog = [];
  for (const f of buildFields()) {
    if (AI_FORBIDDEN_SECTION.has(f.section)) continue;
    if (AI_FORBIDDEN_KEY.test(f.path)) continue;
    // 资料里空的槽位也照列：AI 提名了空槽，本地会给出"该栏你还没填"而不是瞎写一个值
    catalog.push({ path: f.path, zh: f.zh, section: f.section, type: f.type, sensitive: Boolean(f.sensitive) });
  }
  return catalog;
}

/**
 * 构造请求。返回 { payload, text, blocked[] }：
 * text 是**将要原样发出去的那段文本**（UI 预览用它，不做二次加工，避免"预览的和发的不是同一份"）。
 */
export function buildAiRequest({ plan, profile, pageFields, locale = 'zh', limit = 30 }) {
  const eligible = aiEligibleGaps(plan?.gaps || []);
  const gaps = eligible.slice(0, Math.max(1, limit));
  const slots = aiSlotCatalog(profile);
  const questions = gaps.map(g => {
    const pf = pageFields?.[g.index] || {};
    return {
      index: g.index,
      label: String(pf.labelRaw || g.label || '').slice(0, 160),
      kind: pf.kind || g.kind || 'text',
      // 选项文本是页面自己的内容，离开本机不涉及隐私；带上它能显著减少"猜错分组"
      options: (pf.options || []).map(o => String(o.text ?? o).slice(0, 40)).filter(Boolean).slice(0, 24),
      required: Boolean(pf.required),
      nearby: (pf.nearbyLabels || []).slice(0, 3),
    };
  });

  const system = [
    '你在帮助填写一份**求职网申表单**。你看不到候选人的任何真实信息，这是刻意的。',
    '你的任务只有一个：为下面每个页面字段，从"可选槽位"里挑出**语义上最匹配的那一个路径**。',
    '规则：',
    '1) 只能使用可选槽位里出现过的 path，一字不改；不确定就返回 null，不要勉强挑。',
    '2) 绝不生成、猜测、改写任何取值；你不掌握取值。',
    '3) 涉及"是否同意/声明/授权/签名/证件号/薪酬期望"的字段一律返回 null（这些必须由本人处理）。',
    '4) 只输出 JSON：{"matches":[{"index":<数字>,"path":"<槽位path或null>","reason":"<不超过20字>"}]}',
  ].join('\n');

  const slotSection = JSON.stringify(slots.map(s => ({ path: s.path, zh: s.zh, group: s.section })));
  const user = `{"locale":${JSON.stringify(locale)},"fields":${JSON.stringify(questions)},"slots":${slotSection}}`;

  return { system, text: `${system}\n\n${user}`, payload: { system, user }, gaps, slots, slotSection };
}

/**
 * 运行时自证：待发送文本里只要出现任何一个"资料里已经填过的值"（长度 ≥2），就拒绝发送。
 *
 * exempt 用来屏蔽"我们自己的词表"：槽位目录里的中文名（掌握程度、与推荐人关系…）是必须发出去的，
 * 而它们会和资料里的短值（'熟练'、'导师'）撞字。不屏蔽的话每次请求都会被自己拦下，
 * 这条闸门就变成"永远拒绝"，等于没有。屏蔽只针对**构造出来的目录文本**，其余区域一律不豁免。
 */
export function assertNoProfileValues(text, profile, { exempt = [] } = {}) {
  let hay = String(text || '');
  for (const e of exempt) { if (e) hay = hay.split(String(e)).join('【槽位目录】'); }
  const leaks = [];
  const walk = (node, pathSoFar) => {
    if (node == null) return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${pathSoFar}[${i}]`)); return; }
    if (typeof node === 'object') { for (const [k, v] of Object.entries(node)) walk(v, pathSoFar ? `${pathSoFar}.${k}` : k); return; }
    const s = String(node).trim();
    if (s.length >= 2 && hay.includes(s)) leaks.push({ path: pathSoFar, sample: s.slice(0, 6) });
  };
  walk(profile, '');
  return leaks;
}

/**
 * 把上游 JSON 拆成"正文 + 诊断"。放在 core 里是因为这是最容易出错的一段，
 * 必须能在 Node 里跑：真实浏览器里它只表现为"点了没反应"。
 * 覆盖三种兼容层：chat.completions、老 completion、Responses API(output_text)。
 */
export function interpretAiReply(json) {
  if (!json || typeof json !== 'object') return { ok: false, error: 'not_json' };
  if (json.error) {
    return {
      ok: false,
      error: 'upstream_' + String(json.error.code || json.error.type || 'error'),
      detail: String(json.error.message || '').slice(0, 300),
    };
  }
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  const content = choice?.message?.content ?? choice?.text
    ?? (typeof json.output_text === 'string' ? json.output_text : '');
  const reasoning = String(choice?.message?.reasoning_content || choice?.message?.reasoning
    || choice?.reasoning_content || '');
  const finish = String(choice?.finish_reason || '');
  if (!String(content || '').trim()) {
    // "空输出"必须自证是哪一种空：这三种成因的修法完全不同
    return {
      ok: false,
      error: reasoning ? 'reasoning_only' : (finish === 'length' ? 'truncated' : 'empty_content'),
      detail: reasoning
        ? `模型只输出了思考过程（${reasoning.length} 字），正文为空 —— 换非 reasoning 模型，或在请求里关掉思考`
        : `正文为空（finish_reason=${finish || '无'}）`,
      finishReason: finish,
      reasoningChars: reasoning.length,
    };
  }
  return {
    ok: true,
    content: String(content),
    finishReason: finish,
    rawChars: String(content).length,
    // 一条都没解析出来时，原样前 200 字是唯一线索（填写侧请求里没有取值，回显也不会有）
    snippet: String(content).replace(/\s+/g, ' ').trim().slice(0, 200),
  };
}

const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * 把模型给的各种"信封"拆平成数组。只认结构不改语义，路径白名单在后面照样逐条判。
 * 为什么必须容错：不同兼容层/模型给的形状不一样 —— 有的直接回数组，
 * 有的回 {"result":[...]}，有的把 index/path 写成 i/p/slot。
 * 以前只认 {"matches":[...]}，形状不对就整批 unparsable，界面显示成"AI 没给建议"，
 * 看起来就像"空输出"，其实是解析器太窄。
 */
function coerceList(obj) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return null;
  for (const key of ['matches', 'result', 'results', 'fields', 'items', 'data', 'output']) {
    const v = obj[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') { const inner = coerceList(v); if (inner) return inner; }
  }
  // 只答了一条时常见的是裸对象 {"index":0,"path":"..."}
  if ('index' in obj || 'i' in obj) return [obj];
  return null;
}

const IDX_KEYS = ['index', 'i', 'field', 'gap', 'fieldIndex'];
const PATH_KEYS = ['path', 'slot', 'p', 'profilePath', 'slotPath'];
const WHY_KEYS = ['reason', 'why', 'note'];

/** 解析响应：只接受白名单 path、只接受本次问过的 index；其余全部丢弃并说明原因 */
export function parseAiResponse(raw, { allowedPaths, askedIndexes }) {
  const out = { candidates: [], dropped: [] };
  let parsed = null;
  if (typeof raw === 'string') {
    const fenced = raw.match(JSON_FENCE);
    const body = fenced ? fenced[1] : raw;
    for (const [open, close] of [['{', '}'], ['[', ']']]) {
      const start = body.indexOf(open);
      const end = body.lastIndexOf(close);
      if (start < 0 || end <= start) continue;
      try { parsed = JSON.parse(body.slice(start, end + 1)); break; } catch { /* 试下一种 */ }
    }
  } else if (raw && typeof raw === 'object') parsed = raw;

  const list = coerceList(parsed);
  if (!Array.isArray(list)) {
    out.dropped.push({ reason: 'unparsable', detail: '响应里没有可解析的 JSON 数组或 {"matches":[...]}' });
    return out;
  }
  for (const m of list) {
    const pick = keys => { for (const k of keys) if (m?.[k] !== undefined) return m[k]; return undefined; };
    const index = Number(pick(IDX_KEYS));
    const rawPath = pick(PATH_KEYS);
    const path = typeof rawPath === 'string' ? rawPath.trim() : null;
    if (!Number.isInteger(index) || !askedIndexes.has(index)) {
      out.dropped.push({ index: Number.isInteger(index) ? index : null, reason: 'unknown_index', detail: '返回的 index 不在本次问过的缺口里' });
      continue;
    }
    if (path === null || path === 'null' || path === '' || path === 'none' || path === '不确定') {
      continue;                                        // AI 明确说"不知道"，正常
    }
    if (!allowedPaths.has(path)) {
      out.dropped.push({ index, path, reason: 'unknown_path', detail: '这个 path 不在我们的槽位白名单里' });
      continue;
    }
    out.candidates.push({ index, path, reason: String(pick(WHY_KEYS) || '').slice(0, 60) });
  }
  return out;
}

/**
 * 把 AI 候选并进 plan：命中就变成 review 的一笔；槽位是空的就留一条说明清楚的缺口。
 * sensitive 槽位仍要走「允许填写敏感字段」那道闸 —— AI 选的路径不能绕过它。
 */
export function applyAiCandidates(plan, profile, candidates = [], opts = {}) {
  const slots = new Map(aiSlotCatalog(profile).map(s => [s.path, s]));
  const allowSensitive = opts.fillSensitive === true;
  const byIndex = new Map(candidates.map(c => [c.index, c]));
  const keptGaps = [];
  const added = [];
  const stale = [];
  for (const g of plan.gaps) {
    const c = byIndex.get(g.index);
    if (!c) { keptGaps.push(g); continue; }
    // 索引是"上一次扫描时的下标"。页面在两次扫描之间自己插掉/新增了控件，
    // 下标就会漂到别的栏位上 —— 那等于把 A 栏的答案写进 B 栏。用标签复核，不符就整条丢弃。
    if (c.label && String(c.label).slice(0, 60) !== String(g.label || '').slice(0, 60)) {
      stale.push({ index: g.index, expected: c.label, found: g.label });
      keptGaps.push(g);
      continue;
    }
    const sf = slots.get(c.path);
    if (!sf) { keptGaps.push(g); continue; }
    const value = String(getValueByPath(profile, sf.path) ?? '').trim();
    if (sf.sensitive && !allowSensitive) {
      keptGaps.push({ ...g, reason: 'sensitive_withheld', note: `AI 建议这一栏用「${sf.zh}」，但它属于敏感字段，勾选「允许填写敏感字段」后才会写` });
      continue;
    }
    if (!value) {
      keptGaps.push({ ...g, reason: 'ai_empty_slot', note: `AI 建议这一栏用「${sf.zh}」，但你资料里那栏是空的 —— 去资料里补上再扫` });
      continue;
    }
    added.push({
      index: g.index, path: sf.path, value, profileType: sf.type, sensitive: sf.sensitive,
      score: 0, tier: 'review', aiChosen: true,
      label: g.label, note: `本地词典没有这个词，AI 按语义建议用「${sf.zh}」${c.reason ? `（${c.reason}）` : ''}，请核对`,
    });
  }
  return {
    assignments: [...plan.assignments, ...added],
    gaps: keptGaps,
    stats: {
      ...plan.stats,
      planned: plan.assignments.length + added.length,
      review: (plan.stats.review || 0) + added.length,
      gaps: keptGaps.length,
    },
    applied: added.length,
    added,
    stale,
  };
}
