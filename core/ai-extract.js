// AI 辅助**导入**：把本地解析器认不出来的简历片段，交给外部模型归位。
//
// 这跟 core/ai.js（填写侧兜底）是两条完全不同的边界，别混用：
//  · 填写侧：只发页面字段名，简历取值永不离开本机。
//  · 导入侧：必须把简历原文发出去，否则没法归位 —— 所以这里的护栏是
//    ① 只发"本地判不动的那几段"，不是整份简历；
//    ② 每次运行都要用户先看预览、再明确点确认（不给"记住这次选择"）；
//    ③ 片段里出现证件号一类的号码，整段拒绝外发；
//    ④ 模型**只能逐字摘录**：返回值必须是所发片段里的原样子串，
//       改写、翻译、补全、格式化一律丢弃（用户要求："仅限于从原文取字段，并不改变原文表述"）。
//  ⑤ 落库仍由用户在预览清单上勾选，且默认不覆盖已有值。

import { aiSlotCatalog, AI_FORBIDDEN_KEY as AI_FORBIDDEN_EXTRACT_RE } from './ai.js';
import { getValueByPath } from './profile-schema.js';

const MAX_FRAGMENTS = 40;
const MAX_FRAGMENT_CHARS = 400;
const MAX_TOTAL_CHARS = 6000;
const MAX_SPAN_CHARS = 300;

/**
 * 片段里是不是藏着"号码类"内容？是就整段不外发。
 * 判得宽会误伤，判得窄会漏发身份证 —— 这里的取舍是：
 *  · 15/18 位证件号、护照号（E/D/G/S + 8 位）、13 位以上的连续数字（含 4 位分组的银行卡排版）算号码；
 *  · 「2021 2022 2023 2024」这种**全是年份**的分组不算 —— 简历里列年份太常见，
 *    把它当卡号拦掉，用户只会觉得"AI 辅助导入什么都干不了"。
 *  · 11 位手机号不算：联系方式那几行本地解析已经处理掉了，本来也不该走到这里。
 */
export function looksLikeNumberSecret(text) {
  const s = String(text || '');
  if (/\d{17}[\dXx]|\d{15}/.test(s)) return true;
  if (/[EDGSDgeds]\d{8}(?![\d])/.test(s)) return true;
  for (const run of s.match(/\d[\d\s-]{11,}\d/g) || []) {
    const digits = run.replace(/\D/g, '');
    if (digits.length < 13) continue;
    const groups = run.trim().split(/[\s-]+/);
    const allYears = groups.length > 1 && groups.every(g => /^(19|20)\d\d$/.test(g));
    if (!allYears) return true;
  }
  // 一整串连续数字（没分组）里夹着出生日期样式的段，也当证件号处理：
  // 有些简历把身份证号拆开写，或者在号码后面紧跟日期。
  return /(19|20)\d{2}(0[1-9]|1[0-2])([0-2]\d|3[01])\d{3}(\d|X|x)/.test(s.replace(/[\s-]/g, ''));
}

const normSpace = s => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * 槽位表压缩：白名单有 519 条，其中大半是 work.0./work.1./work.2./work.3. 这种同构重复，
 * 全列出来光"槽位表"就 30KB —— 每次导入都发一遍，又慢又贵还挤掉片段的预算。
 * 归并成 work.N.company + range:"0-3"，让模型自己把 N 换成具体序号；
 * 收回来的路径仍按**完整白名单**校验，所以压缩只改"怎么说"，不改"收不收"。
 */
export function compactSlots(profile) {
  const groups = new Map();
  for (const s of aiSlotCatalog(profile)) {
    if (AI_FORBIDDEN_EXTRACT_RE.test(s.path)) continue;
    const m = /^([a-z]+)\.(\d+)\.(.+)$/i.exec(s.path);
    const key = m ? `${m[1]}.N.${m[3]}` : s.path;
    const g = groups.get(key) || { p: key, zh: s.zh, t: s.type === 'text' ? undefined : s.type, lo: 99, hi: -1 };
    if (m) { const n = Number(m[2]); g.lo = Math.min(g.lo, n); g.hi = Math.max(g.hi, n); }
    groups.set(key, g);
  }
  // 只留 p/zh/t/r：类型默认 text 不写，序号范围压成一个字符串，
  // 519 条白名单本来是 31KB，现在 11KB 左右 —— 每次导入都要用户点确认的载荷，不该拿体积换那点便利。
  return [...groups.values()].map(g => {
    const out = { p: g.p, zh: g.zh };
    if (g.t) out.t = g.t;
    if (g.hi >= 0) out.r = `${g.lo}-${g.hi}`;
    return out;
  });
}

/**
 * 从导入报告里挑出"本地判不动"的片段。
 * @param {Object} report importMarkdown 的 report（需要 unplaced[]，缺失时从 warnings 兜一点）
 * @returns {Array<{i:number, heading:string, text:string, why:string}>}
 */
export function extractFragments(report, { limit = MAX_FRAGMENTS } = {}) {
  const out = [];
  const seen = new Set();
  const push = (heading, text, why) => {
    const t = normSpace(text);
    if (t.length < 2) return;
    const key = `${heading}|${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ i: out.length, heading: normSpace(heading).slice(0, 40), text: t.slice(0, MAX_FRAGMENT_CHARS), why });
  };

  for (const u of report?.unplaced || []) push(u.heading, (u.lines || []).join(' '), u.why || 'unrouted');
  // 联系行里剩下的光秃文字（"北京"、"男"这种）也是本地判不动的，但一条 warning 只有一个片段
  for (const w of report?.warnings || []) {
    const m = /无法归类的片段：「(.+?)」/.exec(String(w));
    if (m) push('联系行', m[1], 'unclassified_token');
  }
  return out.slice(0, Math.max(1, limit));
}

/** 构造请求。text 就是将要原样发出去的那份，预览与发送共用同一个字符串。 */
export function buildExtractRequest({ fragments = [], profile, locale = 'zh' } = {}) {
  const blocked = [];
  const sent = [];
  let budget = MAX_TOTAL_CHARS;
  for (const f of fragments) {
    // 拦下来必须看得见：号码形状是正则判的，"2021 2022 2023 2024"这种正常内容也会被误判成卡号。
    // 宁可误拦（带原文开头回到预览里，用户自己决定要不要手填），不可静默少发一段。
    if (looksLikeNumberSecret(f.text)) { blocked.push({ i: f.i, reason: 'sensitive_in_fragment', head: f.text.slice(0, 24) }); continue; }
    if (budget <= 0) { blocked.push({ i: f.i, reason: 'budget', head: f.text.slice(0, 24) }); continue; }
    const text = f.text.slice(0, Math.min(MAX_FRAGMENT_CHARS, budget));
    budget -= text.length;
    sent.push({ ...f, text });
  }

  const slots = compactSlots(profile);
  const system = [
    '你在帮忙把一份**简历原文**里本地解析器认不出的片段归位到固定槽位。',
    '规则（必须全部遵守）：',
    '1. 只能从我给你的片段里**逐字摘抄**：返回的 value 必须是该片段中连续出现、一字不改的原文。',
    '2. 不许改写、翻译、补全、缩写、统一日期格式，也不许把两个片段拼起来。',
    '3. 只能选我列出的 slot 路径；路径里带 N 的，把 N 换成 r 里的一个数字（例如 work.N.company + "r":"0-3" → work.1.company）。',
    '4. 没有合适的槽位就不要返回，宁缺毋滥；一个片段最多归一个槽位。',
    '5. 不要输出任何解释文字，只输出 JSON 数组。',
    locale === 'en' ? 'Answer with JSON only.' : '只输出 JSON。',
  ].join('\n');

  const payload = {
    slots,
    fragments: sent.map(f => ({ i: f.i, where: f.heading || '', text: f.text })),
  };
  const text = [
    system,
    '',
    '槽位表（p=路径，zh=名称，t=类型（省略即文本），r=N 可取的序号范围）：',
    JSON.stringify(payload.slots),
    '',
    '待归位片段（i=编号，where=它出现在简历的哪一栏下面，text=原文）：',
    JSON.stringify(payload.fragments, null, 0),
    '',
    '请输出形如 [{"i":0,"p":"work.0.company","v":"原文逐字摘抄"}] 的 JSON 数组；无可归项时输出 []。',
  ].join('\n');

  return { system, text, payload, fragments: sent, slots, blocked };
}

/**
 * 逐字判据：返回的 v 必须是所引片段里的连续原文。
 * 允许唯一的例外是空白（简历里常有全角空格/换行造成的空隙）；
 * 除此之外差一个字、差一个标点都算改写 —— 那正是"改变了原文表述"。
 * @returns {string} 命中的原文子串；'' 表示不算逐字
 */
export function verbatimSpan(fragmentText, want) {
  const raw = String(want || '').trim();
  if (!raw) return '';
  if (String(fragmentText || '').includes(raw)) return raw;
  const nf = normSpace(fragmentText);
  const nw = normSpace(raw);
  const at = nf.toLowerCase().indexOf(nw.toLowerCase());
  return at < 0 ? '' : nf.slice(at, at + nw.length);
}

/**
 * 槽位表把同构条目压成了 work.N.company，模型偶尔会原样把 N 交回来。
 * 展开规则：在这段范围内挑**第一个当前为空**的槽位；全都被占了就用第一个，
 * 让后面 applyExtracted 用 'occupied' 挡下来 —— 而不是我们自己猜一条已有记录中间插进去。
 * @returns {{path:string, expanded:boolean}}
 */
export function expandSlotPath(p, allowed, profile, getValue) {
  const m = /^([a-z]+)\.N\.(.+)$/i.exec(String(p || ''));
  if (!m) return { path: p, expanded: false };
  const cands = [];
  for (let n = 0; n <= 12; n++) {
    const cand = `${m[1]}.${n}.${m[2]}`;
    if (allowed.has(cand)) cands.push(cand);
  }
  if (!cands.length) return { path: p, expanded: false };
  const empty = cands.find(c => !String(getValue ? getValue(profile, c) : '' ).trim());
  return { path: empty || cands[0], expanded: true };
}

/**
 * 校验返回。**逐字**是这里的唯一标准：v 不是所引片段的子串就丢，理由写清楚。
 * @returns {{accepted: Array, rejected: Array<{i?:number,p?:string,v?:string,reason:string}>}}
 */
export function parseExtractResponse(raw, { fragments = [], profile } = {}) {
  const accepted = [];
  const rejected = [];
  const byIndex = new Map(fragments.map(f => [f.i, f]));
  const allowed = new Set(aiSlotCatalog(profile).map(s => s.path));
  const claimPath = new Set();

  let list;
  const s = String(raw || '').trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '');
  try {
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    list = start >= 0 && end > start ? JSON.parse(s.slice(start, end + 1)) : JSON.parse(s);
  } catch {
    return { accepted, rejected: [{ reason: 'unparsable' }] };
  }
  if (!Array.isArray(list)) return { accepted, rejected: [{ reason: 'unparsable' }] };

  for (const it of list) {
    const i = Number(it?.i);
    const raw = String(it?.p || it?.path || '');
    const v = String(it?.v ?? it?.value ?? '');
    const f = byIndex.get(i);
    if (!f) { rejected.push({ i, p: raw, v, reason: 'unknown_fragment' }); continue; }
    // 先判禁发槽位再判白名单：白名单本身已经把证件号一类剔掉了，
    // 顺序反过来就只会得到 unknown_path，用户看不出"是被安全规则挡的"。
    if (AI_FORBIDDEN_EXTRACT_RE.test(raw)) { rejected.push({ i, p: raw, v, reason: 'forbidden_slot' }); continue; }
    const exp = expandSlotPath(raw, allowed, profile, getValueByPath);
    // 展不开（陌生路径 / 那段根本没有空位）就当陌生路径拒掉：我们不做"大概放进第几条"的猜测
    if (!raw || !allowed.has(exp.path)) { rejected.push({ i, p: raw, v, reason: 'unknown_path' }); continue; }
    if (AI_FORBIDDEN_EXTRACT_RE.test(exp.path)) { rejected.push({ i, p: raw, v, reason: 'forbidden_slot' }); continue; }
    const span = verbatimSpan(f.text, v);
    if (!span) { rejected.push({ i, p: raw, v, reason: 'not_verbatim' }); continue; }
    if (span.length > MAX_SPAN_CHARS) { rejected.push({ i, p: raw, v, reason: 'bad_length' }); continue; }
    if (claimPath.has(exp.path)) { rejected.push({ i, p: raw, v, reason: 'duplicate_path' }); continue; }
    claimPath.add(exp.path);
    accepted.push({
      i, path: exp.path, value: span, verbatim: true, from: f.heading, sourceText: f.text,
      // 序号是我们补的，不是模型给的 —— 界面上要单独提示这一条属于"第几条记录"由本地决定
      indexFilled: exp.expanded || undefined,
    });
  }
  return { accepted, rejected };
}

/**
 * 落库：默认只填空槽，勾了 overwrite 才覆盖。每一步都记来源，导入后能回放"哪句原文进了哪栏"。
 * @returns {{written: Array, skipped: Array<{path:string, reason:string}>}}
 */
export function applyExtracted(profile, accepted = [], { overwrite = false, setValue, getValue } = {}) {
  const written = [];
  const skipped = [];
  for (const a of accepted) {
    const cur = getValue ? String(getValue(profile, a.path) || '').trim() : '';
    if (cur && !overwrite) { skipped.push({ path: a.path, reason: 'occupied' }); continue; }
    if (!setValue) { written.push({ ...a, replaced: Boolean(cur) }); continue; }
    setValue(profile, a.path, a.value);
    written.push({ ...a, replaced: Boolean(cur) });
  }
  return { written, skipped };
}
