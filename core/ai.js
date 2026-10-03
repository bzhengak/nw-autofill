// 混合 AI 兜底：只在本地词典卡住时，请外部模型"从我们已有的槽位里挑一个"。
//
// 三条不可谈判的边界（REQUIREMENTS §3.3 / §3.7，写代码前先定死）：
//  1. 请求里只允许出现页面字段名、控件类型、页面选项文本，以及 profile 的**槽位路径与中文名**。
//     任何简历取值都不许离开本机 —— 所以本模块只吃 plan，不吃 profile 的值。
//     assertNoProfileValues() 是这条边界的运行时自证：一旦取值出现在待发送文本里就拒绝发送。
//  2. AI 只能"选路径"，不能"造值"。返回的 path 必须在白名单里，值永远由本地从 profile 取。
//  3. AI 只能指认槽位，不能造值：非敏感栏按正常档位（用户 2026-10-02 改判，不再一律黄字），
//     敏感/声明/附件/验证码类控件根本不进候选。

import { buildFields, getValueByPath } from './profile-schema.js';
import { CONCEPTS, isKnownConcept, slotConcept } from './canonical.js';
import { normalize } from './matching.js';
import { fingerprint } from './ledger.js';

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

/**
 * "还是不是同一栏"的宽松比对：面板递回来的标签是**页面原文**（labelRaw，'Awarding Body'），
 * 而计划里的缺口标签是归一化过的（'awarding body'）。直接字符串相等会把每一条答案
 * 都判成"标签漂移"，于是整条 AI 通路在真实页面上静默变成死的 ——
 * 这条判据的目的只是防"两次扫描之间页面自己增删了控件"，不是比字节。
 * 两边都空时按"认不出来"处理（放行由白名单与敏感闸把关），不因为缺标签就丢弃答案。
 */
export function samePageLabel(a, b) {
  // 注意先判空再归一化：normalize(undefined) 会给出字符串 'undefined'，
  // 那样"这一侧压根没带标签"会被当成一个真的标签去比，把不带标签的候选全误杀。
  const norm = s => (s == null ? '' : String(s).replace(/…$/u, '').trim()).toLowerCase();
  const raw = s => (norm(s) ? norm(normalize(s)) : '');
  const x = raw(a);
  const y = raw(b);
  return !x || !y || x === y;
}

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
      // 描述与板块：标签只有 'Name' / 'Other' 时，说明文字是唯一线索
      desc: String(pf.description || '').slice(0, labelCap),
      section: String(pf.sectionTitle || pf.sectionHint || '').slice(0, 40),
    };
    // 选项文本是页面自己的内容，离开本机不涉及隐私；带上它能显著减少"猜错分组"
    if (optCap) q.options = (pf.options || []).map(o => {
      const t = String(o?.text ?? o ?? '').slice(0, optChars);
      const v = String(o?.value ?? '').slice(0, 20);
      return v && v !== t ? t + '=' + v : t;
    }).filter(Boolean).slice(0, optCap);
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
 *    带 + 与括号的也一样（'+86' 是国际区号，页面自己的选项里就写着它，
 *    第一次整页映射就是被它假拦下一次，差点把"零取值"的自检变成永远拒发）；
 *  - 长数字串仍然是身份：手机号 11 位、证件号 15~18 位照样拦。
 *  - 两三个字的中文姓名（'张伟'）是身份，不放宽。
 */
const NUMERICISH = /^[\d\s.,:~\-/+()年月日]+$/;
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
  const out = { candidates: [], dropped: [], declined: [] };
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
      // AI 明确说"这一栏我认不出"。这**不是丢弃**，是一次有内容的回答：
      // 用户 2026-10-02 看到的"回了 115 字但一条都没落进白名单（丢弃 0 条）"就是它，
      // 界面把"模型答认不出"说成"没落进白名单"，等于把最有用的线索（哪一栏、为什么）藏掉了。
      out.declined.push({
        index,
        reason: String(pick(WHY_KEYS) || '').slice(0, 60),
      });
      continue;
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
    if (!samePageLabel(c.label, g.label)) {
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
      // 用户 2026-10-02 明确改了判："不用一律黄字，因为我都要检查一遍。"
      // 所以 AI 选的不再自动降级成 review —— 但 aiChosen 标记与"这是 AI 建议"的说明照留，
      // 撤销与审计仍然认得这一笔；敏感字段仍走 review（那是另一道闸，不是置信度问题）。
      score: 0, tier: sf.sensitive ? 'review' : 'auto', aiChosen: true,
      label: g.label, note: `本地词典没有这个词，AI 按语义建议用「${sf.zh}」${c.reason ? `（${c.reason}）` : ''}`
        + (c.nExpanded ? '；这一条属于第几条经历是我们补的（AI 交回的是带 N 的归并路径），不是 AI 定的' : '')
        + (sf.sensitive ? '，请核对' : ''),
    });
  }
  return {
    assignments: [...plan.assignments, ...added],
    gaps: keptGaps,
    stats: {
      ...plan.stats,
      planned: plan.assignments.length + added.length,
      review: (plan.stats.review || 0) + added.filter(a => a.tier === 'review').length,
      gaps: keptGaps.length,
    },
    applied: added.length,
    added,
    stale,
  };
}

/**
 * S5 · 整页概念映射（两层映射的第一跳）。
 *
 * 与"问 AI 补缺口"的区别不只是范围：**AI 交回的不再是 519 条槽位路径，而是约 60 个概念之一**
 * （core/canonical.js）。选择空间小一个数量级，于是三件事同时变好：
 *  ① 模型更容易答对（也不用把整份槽位目录发出去，请求体显著变小）；
 *  ② 概念→槽位由本地确定性展开，"到底准备写哪一栏"永远是我们自己决定的；
 *  ③ 答错了也解释得清 —— 概念名可以印在映射表上，用户一眼看出"它把这一栏当成了 surname"。
 *
 * 取值仍然一个字节都不发：currentValue 只发"这栏现在算谁写的"这一种状态词。
 */
export function buildPageMapRequest({ pageFields = [], concepts = null, maxBytes = AI_MAX_BYTES, valueStates = {} } = {}) {
  const list = concepts || Object.keys(CONCEPTS);
  const system = [
    '你在帮助填写一份**求职网申表单**。你看不到候选人的任何真实信息，这是刻意的。',
    '你的任务只有一个：为下面每个页面字段，选出**它问的是哪一种东西**（概念）。',
    '规则：',
    `1) concept 只能从这份清单里选，一字不改：${JSON.stringify(list)}`,
    '2) 拿不准、清单里没有合适的、或这一栏属于"是否同意/声明/证件号/薪酬期望"，就返回 null（不要勉强挑）。',
    '3) 绝不生成、猜测、改写任何取值；你不掌握取值，也不需要提供取值。',
    '4) 每个字段都带了它自己的说明文字、所在板块、控件类型与页面选项（文案=码值）；请综合这些判断，别只看标签那一个词。',
    '5) 只输出 JSON：{"matches":[{"index":<数字>,"concept":"<概念或null>","reason":"<不超过20字>"}]}',
  ].join('\n');
  const conceptSection = JSON.stringify(list);
  const bytes = s => new TextEncoder().encode(s).length;
  const caps = [{ o: 24, oc: 40, n: 3, d: 160 }, { o: 8, oc: 24, n: 2, d: 90 }, { o: 0, oc: 0, n: 0, d: 48 }];
  let level = 0, questions, text;
  const build = () => {
    const cap = caps[level];
    questions = pageFields.map((f, i) => {
      const q = {
        index: i,
        label: String(f.labelRaw || f.label || '').slice(0, cap.d),
        kind: f.kind || 'text',
        required: Boolean(f.required),
        desc: String(f.description || '').slice(0, cap.d),
        section: String(f.sectionTitle || f.sectionHint || '').slice(0, 40),
        valueState: valueStates[i] || 'empty',
      };
      if (cap.o) q.options = (f.options || []).map(o => {
        const t = String(o?.text ?? o ?? '').slice(0, cap.oc);
        const v = String(o?.value ?? '').slice(0, 20);
        return v && v !== t ? t + '=' + v : t;
      }).filter(Boolean).slice(0, cap.o);
      if (cap.n) q.nearby = (f.nearbyLabels || []).slice(0, cap.n);
      return q;
    });
    text = `${system}\n\n${JSON.stringify({ fields: questions, concepts: conceptSection })}`;
  };
  build();
  while (bytes(text) > maxBytes && level < caps.length - 1) { level++; build(); }
  const dropped = bytes(text) > maxBytes ? pageFields.length : 0;
  if (dropped) { questions = []; text = `${system}\n\n${JSON.stringify({ fields: [], concepts: conceptSection })}`; }
  const pageTokens = questions.flatMap(q => [
    q.label, ...(q.options || []).map(o => String(o).split('=')[0]), ...(q.nearby || []),
  ]).map(t => String(t ?? '').trim()).filter(Boolean);
  return {
    system, text, pageTokens, conceptSection,
    trim: { level, why: ['完整档案', '选项削到 8 条', '只留标签与板块'][level], droppedFields: dropped },
    count: questions.length,
  };
}

/**
 * 解析整页概念映射：概念必须在封闭清单内，越界一律丢弃（宁可这一栏没结论，
 * 也不接受一个我们不认识的词 —— 那等于把白名单放宽）。
 * null 是有效回答，单独记 declined，界面能念出"模型说这一栏认不出"。
 */
export function parsePageMapResponse(raw, { askedIndexes = null, concepts = null } = {}) {
  const known = new Set(concepts || Object.keys(CONCEPTS));
  const out = { mapping: [], dropped: [], declined: [] };
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
    const index = Number(m?.index ?? m?.i ?? m?.field);
    if (!Number.isInteger(index) || (askedIndexes && !askedIndexes.has(index))) {
      out.dropped.push({ index: Number.isInteger(index) ? index : null, reason: 'unknown_index' });
      continue;
    }
    const c = String(m?.concept ?? m?.c ?? m?.type ?? '').trim();
    const reason = String(m?.reason ?? m?.why ?? '').slice(0, 60);
    if (!c || c === 'null' || c === 'none') { out.declined.push({ index, reason }); continue; }
    if (!known.has(c)) { out.dropped.push({ index, concept: c.slice(0, 40), reason: 'unknown_concept' }); continue; }
    out.mapping.push({ index, concept: c, reason });
  }
  return out;
}

/** 概念 → 本地槽位（有值优先，多命中就交映射表，绝不自己挑一个） */
export function expandConceptToSlots(profile, concept) {
  if (!concept || !isKnownConcept(concept)) return { path: '', candidates: [] };
  const pool = buildFields().filter(f => !AI_FORBIDDEN_SECTION.has(f.section) && !AI_FORBIDDEN_KEY.test(f.path));
  const hit = pool.filter(f => slotConcept(f) === concept);
  const filled = hit.filter(f => String(getValueByPath(profile, f.path) ?? '').trim());
  const chosen = filled.length ? filled : hit;
  if (chosen.length === 1) return { path: chosen[0].path, candidates: chosen.map(f => f.path), empty: !filled.length };
  return { path: '', candidates: chosen.map(f => f.path), ambiguous: chosen.length > 1, empty: !filled.length };
}

/**
 * 整页概念映射的结果落到计划上（S5 的回答 → S6 的表）。
 *
 * 为什么单独一个函数，而不是复用 applyAiCandidates：那一套只处理**缺口**，
 * 而整页映射的价值恰恰在于"我们自己判得也没把握的那些栏"——
 * 用户 2026-10-02 的原话是"我希望 AI 可以直接填写所有的，最主要是获取的页面信息要完整清晰"。
 * 但"能动哪些"必须划线，越靠后的判定越该尊重：
 *   · **永远不动**：用户在映射表里的改判（pinnedBy='siteRule'）、适配器钉位/摊平规则（'adapter'）、
 *     绿字（证据足、置信过线）—— 那是人的决定或站点的自述，不是一个更聪明的猜测；
 *   · **可以动**：黄字（置信不足或只有弱证据）与冲突未决的那些栏，以及缺口；
 *   · 敏感字段与空槽位的两道闸与缺口那条路一字不差（AI 只有权说"这一格是什么"）。
 * 覆盖留下的痕迹（aiOverrode）是给表里"来历"那一列念的，不是日志里埋着的。
 */
export function applyPageMapSuggestions(plan, profile, suggestions = [], opts = {}) {
  const slots = new Map(aiSlotCatalog(profile).map(s => [s.path, s]));
  const allowSensitive = opts.fillSensitive === true;
  const byIndex = new Map();
  /**
   * 回答是"上一次扫描的下标 + 那一栏的指纹"发回来的。页面在两次扫描之间自己增删了控件，
   * 下标就会漂到别的栏位上 —— 那等于把 A 栏的答案写进 B 栏。所以能按指纹重新对号就按指纹对，
   * 指纹认不出来（调用方没给 fields，或这一栏自述变了）才退回下标 + 标签复核那一道。
   */
  const fpToIndex = new Map();
  if (Array.isArray(opts.fields)) {
    opts.fields.forEach((f, idx) => {
      const fp = fingerprint(f);
      if (fp && !fpToIndex.has(fp)) fpToIndex.set(fp, idx);
    });
  }
  for (const s of (Array.isArray(suggestions) ? suggestions : [])) {
    const i0 = Number(s?.index);
    const anchored = s?.fp && fpToIndex.has(s.fp) ? fpToIndex.get(s.fp) : i0;
    if (Number.isInteger(anchored) && s?.path) {
      if (Number.isInteger(i0) && anchored !== i0) byIndex.set(anchored, { ...s, reanchored: { from: i0, to: anchored } });
      else byIndex.set(anchored, s);
    }
  }
  const refused = [];
  /**
   * 标签漂移的复核：面板那一侧递过来的标签是**页面原文**（labelRaw，'Awarding Body'），
   * 而计划里的缺口标签是归一化过的（'awarding body'）。直接字符串相等会把这一路的
   * 每一条答案都判成"标签对不上"——整页映射当场变成死代码。归一化之后再比，
   * 并容忍导出/表格里常见的省略号截断。
   */
  const labelSame = samePageLabel;
  const mkNote = (s, sf) => `AI 认这是「${sf.zh}」（概念 ${s.concept}${s.reason ? `；原话：${s.reason}` : ''}）`;

  const gaps = [];
  let added = 0;
  for (const g of (plan?.gaps || [])) {
    const s = byIndex.get(g.index);
    if (!s) { gaps.push(g); continue; }
    if (!labelSame(s.label, g.label)) {
      refused.push({ index: g.index, why: `标签对不上（这一页在两次扫描之间变了：期望「${s.label}」、现在是「${g.label}」）`, reason: 'stale_label' });
      gaps.push(g); continue;
    }
    const sf = slots.get(s.path);
    if (!sf) { refused.push({ index: g.index, path: s.path, why: 'AI 给的槽位不在资料清单里，已丢弃', reason: 'unknown_path' }); gaps.push(g); continue; }
    const value = String(getValueByPath(profile, sf.path) ?? '').trim();
    if (sf.sensitive && !allowSensitive) {
      gaps.push({ ...g, reason: 'sensitive_withheld', note: `${mkNote(s, sf)}，但它属于敏感字段，勾选「允许填写敏感字段」后才会写` });
      continue;
    }
    if (!value) {
      gaps.push({ ...g, reason: 'ai_empty_slot', note: `${mkNote(s, sf)}，但你资料里那栏是空的 —— 去资料里补上再扫` });
      continue;
    }
    gaps.push({ ...g, resolvedBy: sf.path });      // 计数与成笔都在下面 resolved 那一趟
    byIndex.set(g.index, { ...s, _gap: g, _value: value, _sf: sf });
  }

  const assignments = [];
  let overridden = 0;
  for (const a of (plan?.assignments || [])) {
    const s = byIndex.get(a.index);
    if (!s) { assignments.push(a); continue; }
    // 覆盖既有判定时更要确认"还是同一栏"：漂移了就是把 A 栏的答案写进 B 栏
    if (!labelSame(s.label, a.label)) {
      refused.push({ index: a.index, path: s.path, was: a.path, reason: 'stale_label',
        why: `标签对不上（期望「${s.label}」、现在是「${a.label}」），保留本地判定` });
      assignments.push(a); continue;
    }
    const untouched = a.pinnedBy || a.tier === 'auto' || a.skip;
    if (untouched) {
      refused.push({ index: a.index, path: s.path, was: a.path,
        why: a.skip ? '这一栏我们本来就不动（已填过/不写）'
          : a.pinnedBy ? (a.pinnedBy === 'siteRule' ? '你在映射表里改过判，AI 不覆盖人的决定' : '站点规则钉住了这一栏，AI 不覆盖')
          : '这一栏本地已经是绿字高置信，AI 不覆盖' });
      assignments.push(a);
      continue;
    }
    const sf = slots.get(s.path);
    if (!sf) { refused.push({ index: a.index, path: s.path, why: 'AI 给的槽位不在资料清单里，保留本地判定', reason: 'unknown_path' }); assignments.push(a); continue; }
    const value = String(getValueByPath(profile, sf.path) ?? '').trim();
    if (!value) {
      refused.push({ index: a.index, path: sf.path, why: 'AI 给的槽位在资料里是空的，保留本地判定', reason: 'empty_slot' });
      assignments.push(a); continue;
    }
    if (sf.sensitive && !allowSensitive) {
      refused.push({ index: a.index, path: sf.path, why: '敏感字段需要「允许填写敏感字段」才动，保留本地判定', reason: 'sensitive_withheld' });
      assignments.push(a); continue;
    }
    overridden++;
    assignments.push({
      ...a,
      path: sf.path, value, profileType: sf.type, sensitive: sf.sensitive,
      score: 0, tier: sf.sensitive ? 'review' : 'auto', aiChosen: true,
      aiOverrode: { path: a.path, zh: a.zh || a.path, why: a.note || '' },
      note: `${mkNote(s, sf)}；覆盖了本地那个没把握的判定`,
    });
  }

  // 缺口里被 AI 解决的，换成正式一笔（顺序无关紧要，分配层已经跑完了）
  const resolved = new Map(gaps.filter(g => g.resolvedBy).map(g => [g.index, g]));
  const keptGaps = gaps.filter(g => !g.resolvedBy);
  for (const [index, g] of resolved) {
    const s = byIndex.get(index);
    added++;
    assignments.push({
      index, path: s._sf.path, value: s._value, profileType: s._sf.type, sensitive: s._sf.sensitive,
      label: g.label, score: 0, tier: s._sf.sensitive ? 'review' : 'auto', aiChosen: true,
      note: `${mkNote(s, s._sf)}`,
    });
  }
  return {
    assignments,
    gaps: keptGaps,
    stats: {
      ...plan.stats,
      planned: assignments.filter(a => !a.skip).length,
      auto: assignments.filter(a => !a.skip && a.tier === 'auto').length,
      review: assignments.filter(a => !a.skip && a.tier === 'review').length,
      gaps: keptGaps.length,
    },
    applied: added + overridden,
    filledGaps: added,
    overridden,
    refused,
  };
}
