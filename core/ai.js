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

/**
 * 填写侧请求体的体积上限。
 * 它是"构造出了问题"的哨兵（比如哪天误把整份资料拼进了 prompt），**不是配额** ——
 * 真正拦取值外发的是 assertNoProfileValues，那条才是硬闸。
 * 上限必须待在 core 里并由测试盯住：以前它写在 service worker 里是 12000，
 * 而未压缩的槽位目录本身就有 36KB，于是「问 AI」每次都在本机被判超限，整条链路是死的，
 * 单元测（只看函数）和界面测（只看文案）都照不出来。
 */
export const AI_MAX_BYTES = 24000;

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
 * 槽位表压缩（发给模型的"可选槽位"那一段）。
 *
 * 为什么必须有这一段：白名单有 519 条，全列出来光是目录就 **36KB**，
 * 而 service worker 里的体积上限本来是 12KB —— 结果每次「问 AI」都在本机被判
 * `payload_too_large`，一个字节都没发出去过（2026-09-30 用 service worker 集成测才抓出来：
 * 单元层测的是"函数对不对"，只有真跑一遍 SW 才发现这条链路一直是死的）。
 *
 * 归并方式：`work.0.company / work.1.company / …` 这种同构重复收成 `work.N.company` + `r:"0-3"`，
 * 519 条 → 206 条、36KB → 10.8KB。慢模型少等 25KB，配额也少烧 25KB。
 * **收回来的路径仍按完整白名单校验**（parseAiResponse 用的是 aiSlotCatalog 的具体路径），
 * 所以压缩只改"怎么对模型说"，不改"我们收不收"。
 */
export function compactSlotCatalog(slots = []) {
  const groups = new Map();
  for (const s of slots) {
    const m = /^([a-z]+)\.(\d+)\.(.+)$/i.exec(s.path);
    const key = m ? `${m[1]}.N.${m[3]}` : s.path;
    const g = groups.get(key) || { p: key, zh: s.zh, lo: 99, hi: -1 };
    if (m) { const n = Number(m[2]); g.lo = Math.min(g.lo, n); g.hi = Math.max(g.hi, n); }
    groups.set(key, g);
  }
  return [...groups.values()].map(g => {
    const out = { p: g.p, zh: g.zh };
    if (g.hi >= 0) out.r = `${g.lo}-${g.hi}`;
    return out;
  });
}

/**
 * 把模型给的 `work.N.company` 落成具体第几条。
 * 我们**不猜**它是第几段经历：按 r 的范围从前往后取第一个存在于白名单里的路径，
 * 并在结果的 note 里写明"序号由本地补"（同 AI 辅助导入的口径）。
 */
export function expandSlotPath(rawPath, allowedPaths) {
  const p = String(rawPath || '').trim();
  if (allowedPaths.has(p)) return { path: p, expanded: false };
  const m = /^([a-z]+)\.N\.(.+)$/i.exec(p);
  if (!m) return { path: null, expanded: false };
  for (let i = 0; i < 10; i++) {
    const cand = `${m[1]}.${i}.${m[2]}`;
    if (allowedPaths.has(cand)) return { path: cand, expanded: true };
  }
  return { path: null, expanded: false };
}

/**
 * 构造请求。返回 { payload, text, gaps, slots, slotSection, trim }：
 * text 是**将要原样发出去的那段文本**（UI 预览用它，不做二次加工，避免"预览的和发的不是同一份"）。
 *
 * `maxBytes` 是**构造阶段的硬预算**，不是发送阶段的拒绝条件：
 * 超了就先削辅助信号（选项文本、邻近标签），再不够才少问几栏，并把削了什么写在 `trim` 里，
 * 界面能如实说"这次没带选项文本"。以前只有"超了就不发"，而目录一长就必然超 —— 于是整条链路哑掉。
 */
export function buildAiRequest({ plan, profile, pageFields, locale = 'zh', limit = 30, maxBytes = AI_MAX_BYTES }) {
  const eligible = aiEligibleGaps(plan?.gaps || []);
  const asked = eligible.slice(0, Math.max(1, limit));
  const slots = aiSlotCatalog(profile);
  const system = [
    '你在帮助填写一份**求职网申表单**。你看不到候选人的任何真实信息，这是刻意的。',
    '你的任务只有一个：为下面每个页面字段，从"可选槽位"里挑出**语义上最匹配的那一个路径**。',
    '规则：',
    '1) 只能使用可选槽位里出现过的 path，一字不改；不确定就返回 null，不要勉强挑。',
    '2) 绝不生成、猜测、改写任何取值；你不掌握取值。',
    '3) 涉及"是否同意/声明/授权/签名/证件号/薪酬期望"的字段一律返回 null（这些必须由本人处理）。',
    // 目录里 work.N.company 这类带 N 的是"同一路径的第几条经历"折叠写法，r 给出可选序号。
    // 说清这一点，模型才会回填具体序号（work.2.company）；就算它原样交回 N，本地也会补成第一条。
    '4) 路径里的 N 是"第几条经历"的占位符，r 是可选序号范围：知道是第几条就把 N 换成那个数字，不知道就原样保留 N。',
    '5) 只输出 JSON：{"matches":[{"index":<数字>,"path":"<槽位path或null>","reason":"<不超过20字>"}]}',
  ].join('\n');

  const slotSection = JSON.stringify(compactSlotCatalog(slots));
  const bytes = s => new TextEncoder().encode(s).length;
  const qOf = (g, level) => {
    const pf = pageFields?.[g.index] || {};
    const labelCap = [160, 120, 80, 48][level];
    const optCap = [24, 8, 0, 0][level];
    const optChars = [40, 24, 0, 0][level];
    const nearCap = [3, 2, 0, 0][level];
    const q = {
      index: g.index,
      label: String(pf.labelRaw || g.label || '').slice(0, labelCap),
      kind: pf.kind || g.kind || 'text',
      required: Boolean(pf.required),
    };
    // 选项文本是页面自己的内容，离开本机不涉及隐私；带上它能显著减少"猜错分组"
    if (optCap) q.options = (pf.options || []).map(o => String(o.text ?? o).slice(0, optChars)).filter(Boolean).slice(0, optCap);
    if (nearCap) q.nearby = (pf.nearbyLabels || []).slice(0, nearCap);
    return q;
  };
  const textOf = qs => `${system}\n\n{"locale":${JSON.stringify(locale)},"fields":${JSON.stringify(qs)},"slots":${slotSection}}`;

  const TRIM_WHY = ['带上了页面选项与邻近标签', '选项文本削到 8 条 / 24 字', '省略了选项与邻近标签', '只留标签与前缀'];
  let trim = { level: 0, why: TRIM_WHY[0], droppedQuestions: 0 };
  let questions = asked.map(g => qOf(g, 0));
  let text = textOf(questions);
  for (let level = 1; bytes(text) > maxBytes && level <= 3; level++) {
    questions = asked.map(g => qOf(g, level));
    text = textOf(questions);
    trim = { level, why: TRIM_WHY[level], droppedQuestions: 0 };
  }
  // 削完描述还是装不下（缺口极多 + 标签极长）：才真的少问几栏，并如实报告少了几个
  while (bytes(text) > maxBytes && questions.length > 1) {
    questions = questions.slice(0, -1);
    text = textOf(questions);
    trim = { ...trim, droppedQuestions: asked.length - questions.length };
  }

  // 页面自己提供的词（标签、选项文本、邻近标签）——自检拿它做"这词不是我们从资料里带出去的"判据。
  // 在最终 questions（削到某一档之后）上取，别把没发出去的词算成豁免范围。
  const pageTokens = questions.flatMap(q => [
    q.label, ...(q.options || []).map(o => (o && o.text) ?? o), ...(q.nearby || []),
  ]).map(t => String(t ?? '').trim()).filter(Boolean);

  return {
    system, text, payload: { system, user: text.slice(text.indexOf('\n\n') + 2) },
    // gaps 保持"实际问出去的那几栏"的原对象（不是下标数组）：
    // 调用方用 built.req.gaps.map(g => g.index) 组 askedIndexes，形状一改就会静默把白名单放宽。
    gaps: asked.slice(0, questions.length), slots, slotSection, pageTokens, trim,
  };
}

/**
 * 这串取值值不值得当"身份"来拦。
 *
 * 真实浏览器里第一次把它跑通的是误报：资料里 `internship.0.durationMonths = '12'`，
 * 而页面自己的文本里到处是 12（选项「12 个月」、年份下拉、"Duration: 12"）——
 * 于是每次「问 AI」都被自己拦下，闸门从"保护"变成"永远拒绝"，等于没有 AI 兜底。
 *
 * 判据（放宽的只有"不构成身份"的那一类）：
 *  - 纯数字/日期形状的短值（≤8 位：'12'、'2021-09'、'3.8'、'175'）不算身份；
 *  - 长数字串仍然是身份：手机号 11 位、证件号 15~18 位照样拦。
 *  - 两三个字的中文姓名（'张伟'）是身份，不放宽。
 */
const NUMERICISH = /^[\d\s.,:~\-/年月日]+$/;
export function isIdentifyingValue(s) {
  const v = String(s ?? '').trim();
  if (v.length < 2) return false;
  if (NUMERICISH.test(v) && v.length <= 8) return false;
  return true;
}

/**
 * 运行时自证：待发送文本里只要出现任何一个"资料里已经填过的值"，就拒绝发送。
 *
 * exempt 用来屏蔽"我们自己的词表"：槽位目录里的中文名（掌握程度、与推荐人关系…）是必须发出去的，
 * 而它们会和资料里的短值（'熟练'、'导师'）撞字。不屏蔽的话每次请求都会被自己拦下，
 * 这条闸门就变成"永远拒绝"，等于没有。屏蔽只针对**构造出来的目录文本**，其余区域一律不豁免。
 *
 * pageTokens 是"这一词是页面自己说的"：资料值与页面标签/选项**整串相同**时（国籍 'China'
 * 对上拉里的选项 'China'），这个词不因为我们外发而泄露任何东西 —— 它本来就在页面上。
 * 只认整串相等，不做子串匹配：真泄漏通常是把值拼进了更长的句子。
 */
export function assertNoProfileValues(text, profile, { exempt = [], pageTokens = [] } = {}) {
  let hay = String(text || '');
  for (const e of exempt) { if (e) hay = hay.split(String(e)).join('【槽位目录】'); }
  const pageSaid = new Set(pageTokens.map(t => String(t ?? '').trim().toLowerCase()).filter(Boolean));
  const leaks = [];
  const walk = (node, pathSoFar) => {
    if (node == null) return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${pathSoFar}[${i}]`)); return; }
    if (typeof node === 'object') { for (const [k, v] of Object.entries(node)) walk(v, pathSoFar ? `${pathSoFar}.${k}` : k); return; }
    const s = String(node).trim();
    if (!isIdentifyingValue(s) || !hay.includes(s)) return;
    if (pageSaid.has(s.toLowerCase())) return;
    leaks.push({ path: pathSoFar, sample: s.slice(0, 6) });
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
    // 目录是归并过的（work.N.company），模型可能原样交回带 N 的路径。
    // 这里补成该段第一条，并把"序号是我们补的"记在候选上 —— 白名单本身一个字节都没放宽。
    let finalPath = path;
    let nExpanded = false;
    if (!allowedPaths.has(finalPath)) {
      const exp = expandSlotPath(finalPath, allowedPaths);
      if (!exp.path) {
        out.dropped.push({ index, path, reason: 'unknown_path', detail: '这个 path 不在我们的槽位白名单里' });
        continue;
      }
      finalPath = exp.path;
      nExpanded = exp.expanded;
    }
    const cand = { index, path: finalPath, reason: String(pick(WHY_KEYS) || '').slice(0, 60) };
    // 只在真的补过序号时才带这个字段：候选会被 JSON 化传给内容脚本，多一个恒等字段就是多一处噪音
    if (nExpanded) cand.nExpanded = true;
    out.candidates.push(cand);
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
      label: g.label, note: `本地词典没有这个词，AI 按语义建议用「${sf.zh}」${c.reason ? `（${c.reason}）` : ''}`
        + (c.nExpanded ? '；这一条属于第几条经历是我们补的（AI 交回的是带 N 的归并路径），不是 AI 定的' : '') + '，请核对',
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
