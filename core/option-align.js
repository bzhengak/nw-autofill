// 认选项（2026-10-04 用户放行）：把"页面这一栏的选项里，哪一项就是我资料里那个东西"交给模型。
//
// 为什么单独一个文件，不塞进 core/ai.js：ai.js 管的是**槽位映射**（这一栏是什么东西），
// 这里管的是**取值对齐**（这栏该选哪一项）。两件事的隐私面完全不同 ——
// 前者永远不发取值，后者在用户勾了「允许 AI 看取值」时可以发，且有硬排除清单。
// 混在一个文件里，迟早有人改一处注释就以为另一处也放宽了。
//
// 两种任务，同一次请求里逐栏各自声明（一次往返，但每栏只面对一种指令）：
//  · label（档 A，默认）：只发页面选项文字 + 封闭代号词表，模型给每个选项归一个代号；
//    本地再把我资料里的取值折算成同一个代号。**取值一个字节都不出去。**
//  · pick（档 C，勾了「允许 AI 看取值」才出现）：把我打算写进这一栏的取值原文一起发出去，
//    模型直接从页面选项里挑一项（返回下标）。
// 两种任务的输出被同一句话管住：**模型只能指向页面已有的那一项，绝不能自己写文字**。
// 落笔用的永远是页面选项自己的 text/value，不是模型给的任何字符串。
//
// 取值被 core/ai-security.js 的硬排除清单拦下的那一栏，自动退回 label（不是被悄悄丢掉）；
// 连代号空间都没有的枚举（政治面貌、熟练度…）整条不发，理由回给界面念出来。

import { AI_MAX_BYTES } from './ai.js';
import { spaceOf, tokenPromptList, valueToToken } from './value-tokens.js';
import { fingerprint } from './ledger.js';

const BYTES = s => new TextEncoder().encode(s).length;

/**
 * 选项数组的下标就是"第几项"这个坐标，所以**一项只能占一个元素**：
 * 这里把可见文案与码值并成 `文案=码值` 一个字符串发出（与整页映射请求同一种写法）。
 * 回来之后靠 expect 那串文字在真页面里定位真选项，数字下标不当唯一依据。
 */
function optionForm(o) {
  const text = String(o?.text ?? o ?? '').trim();
  const value = String(o?.value ?? '').trim();
  if (!text) return '';
  return value && value !== text ? `${text}=${value}` : text;
}

/**
 * @param {Array} targets 每项 {fp, path, label, section, slotZh, options:[{text,value}｜string], space, ourValue?}
 *        ourValue 缺省 = 这一栏走 label（档 A）；带上 = 这一栏走 pick（档 C）
 * @param {boolean} allowValues 档 C 的闸：**没开就把所有 ourValue 丢掉**（闸写在这里，不靠调用方自觉）
 */
export function buildOptionAlignRequest({ targets = [], allowValues = false, maxBytes = AI_MAX_BYTES } = {}) {
  const usable = targets.map(t => ({
    ...t,
    options: (t.options || []).map(o => (typeof o === 'string' ? o : optionForm(o))).map(String),
  }));
  const shared = allowValues ? usable.filter(t => String(t.ourValue ?? '').trim()) : [];
  const isShared = t => shared.includes(t);
  const spaces = [...new Set(usable.filter(t => !isShared(t)).map(t => t.space).filter(Boolean))];
  const vocab = spaces.map(n => ({ space: n, tokens: tokenPromptList(n) }));
  const system = [
    '你在帮助填写一份**求职网申表单**。',
    '下面每一栏标了自己的任务，两种任务都只做一件事：指向这一栏 options 数组里已经写着的那一项。',
    '任务 label：把该栏每个选项各归进一个代号。代号只能从这份封闭清单里选（代号与释义一起给你，一字不改）：'
      + JSON.stringify(vocab),
    '任务 pick：该栏附了 ourValue（我们决定写进这一栏的那个事实），从 options 里选出与它含义相同的那一项。',
    '规则：',
    '1) 不许改写、不许新造任何文字；下标从 0 起。',
    '2) label 里拿不准的选项给 null；pick 里没有任何一项同义、或有两项以上都说得通，也给 null。不要勉强。',
    '3) 注意否定与限定：非全日制≠全日制；需雇主担保≠已持有工作签证；临时/学生身份≠永久居民。',
    '4) 只输出 JSON：{"fields":[{"index":<数字>,"task":"label","options":[{"i":<下标>,"token":"<代号或null>"}]},',
    '   {"index":<数字>,"task":"pick","pick":<下标或null>,"reason":"<不超过20字>"}]}',
  ].join('\n');

  const caps = [{ o: 30, oc: 48, d: 120 }, { o: 12, oc: 28, d: 60 }, { o: 0, oc: 0, d: 40 }];
  let level = 0;
  let questions = [];
  let text = '';
  const build = () => {
    const cap = caps[level];
    questions = usable.map((t, qi) => {
      const q = {
        index: qi,
        task: isShared(t) ? 'pick' : 'label',
        label: String(t.label || '').slice(0, cap.d),
        section: String(t.section || '').slice(0, 40),
        slot: String(t.slotZh || '').slice(0, 30),
      };
      // 这一栏**到底发出去了哪几条选项**要记在 target 上：削减档位之后，
      // 模型指到第 15 项而本地有 30 项时，那不是"越界"，是我们根本没把第 15 项给它看。
      t.sentOptions = cap.o ? (t.options || []).slice(0, cap.o).map(x => String(x).slice(0, cap.oc)) : [];
      if (cap.o) q.options = t.sentOptions;
      if (q.task === 'pick') q.ourValue = String(t.ourValue ?? '').slice(0, 60);
      else if (t.space) q.space = t.space;
      // 我们问它的是什么任务，就只有那一种回答算数（不看模型自己改口，见 parse）
      t.askTask = q.task;
      return q;
    });
    text = `${system}\n\n${JSON.stringify({ fields: questions, vocabulary: vocab })}`;
  };
  build();
  while (BYTES(text) > maxBytes && level < caps.length - 1) { level++; build(); }
  const droppedTargets = BYTES(text) > maxBytes ? questions.length : 0;
  if (droppedTargets) { questions = []; text = `${system}\n\n${JSON.stringify({ fields: [], vocabulary: vocab })}`; }
  // "这词是页面或我们词典自己说的"清单：泄漏自检拿它免责，免得把 'Master'、'男' 这类枚举词当成泄漏
  const pageTokens = questions.flatMap(q => [q.label, q.section, q.slot, ...(q.options || [])])
    .map(t => String(t ?? '').trim()).filter(Boolean);
  for (const v of vocab) for (const tk of v.tokens) pageTokens.push(tk.t, tk.d);
  if (allowValues) for (const t of shared) { const v = String(t.ourValue ?? '').trim(); if (v) pageTokens.push(v); }
  return {
    system, text, pageTokens, vocabText: JSON.stringify(vocab),
    mode: shared.length ? (shared.length === usable.length ? 'values' : 'mixed') : 'tokens',
    trim: { level, why: ['完整选项', '选项削到 12 条', '只留标签'][level], droppedTargets },
    count: questions.length,
    targets: usable,
    sharedPaths: shared.map(t => t.path || ''),
  };
}

/** 上游可能回信封、数组、裸对象；形状不对整批算 unparsable，绝不半推半就地接受 */
function coerceListReply(raw) {
  const obj = typeof raw === 'string' ? extractBody(raw) : raw;
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return null;
  for (const key of ['fields', 'matches', 'result', 'results', 'items', 'data', 'output']) {
    const v = obj[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') { const inner = coerceListReply(v); if (inner) return inner; }
  }
  if (obj && 'index' in obj) return [obj];
  return null;
}

function extractBody(raw) {
  const s = String(raw || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : s).trim();
  const a = body.indexOf('{'); const b = body.lastIndexOf('}');
  const c = body.indexOf('['); const d = body.lastIndexOf(']');
  for (const [open, close] of [[a, b], [c, d]]) {
    if (open < 0 || close <= open) continue;
    try { return JSON.parse(body.slice(open, close + 1)); } catch { /* 试下一种括号 */ }
  }
  return null;
}

const inRange = (n, max) => Number.isInteger(Number(n)) && Number(n) >= 0 && Number(n) < max;

/**
 * 解析回答：没问过的 index、越界下标、清单外的代号一律丢弃并说明原因。
 * @returns {{picks:Array, labels:Array, dropped:Array, declined:Array}}
 */
export function parseOptionAlignReply(raw, { targets = [] } = {}) {
  const picks = []; const labels = []; const dropped = []; const declined = [];
  const list = coerceListReply(raw);
  if (!list) {
    return { picks, labels, declined, dropped: [{ why: 'unparsable', snippet: String(typeof raw === 'string' ? raw : JSON.stringify(raw) || '').slice(0, 160) }] };
  }
  for (const item of list) {
    const idx = Number(item?.index);
    const target = Number.isInteger(idx) ? targets[idx] : null;
    if (!target) { dropped.push({ why: 'index_unknown', index: item?.index }); continue; }
    // 只认我们**问过**的那种任务：模型自己改口 pick 就等于绕开"代号相同才落笔"的协议
    const asked = target.askTask || (target.ourValue ? 'pick' : 'label');
    const answered = item.task === 'pick' || item.pick !== undefined ? 'pick' : 'label';
    if (answered !== asked) {
      dropped.push({ why: 'task_mismatch', index: idx, asked, answered });
      continue;
    }
    // 校验下标一律按"这一栏实际发出去的条数"：削档之后本地全量是个更大的集合
    const sent = Array.isArray(target.sentOptions) ? target.sentOptions.length : (target.options || []).length;
    if (answered === 'pick') {
      if (item.pick === null || item.pick === undefined || item.pick === '') {
        declined.push({ index: idx, fp: target.fp, task: 'pick', reason: String(item.reason || '').slice(0, 40) });
        continue;
      }
      const p = Number(item.pick);
      if (!inRange(p, sent)) {
        dropped.push({ why: sent ? 'pick_out_of_range' : 'options_trimmed', index: idx, pick: item.pick, options: sent });
        continue;
      }
      const expect = String((target.sentOptions && target.sentOptions[p]) ?? target.options?.[p] ?? '');
      picks.push({ index: idx, fp: target.fp, optionIndex: p, expect, reason: String(item.reason || '').slice(0, 40) });
      continue;
    }
    const known = new Set((spaceOf(target.space)?.tokens || []).map(x => x.t));
    if (!known.size) { dropped.push({ why: 'no_space', index: idx }); continue; }
    const tokens = {};
    let counted = 0;
    for (const o of (Array.isArray(item.options) ? item.options : [])) {
      const oi = Number(o?.i ?? o?.index);
      const tok = String(o?.token ?? o?.t ?? '').trim();
      if (!inRange(oi, sent)) { dropped.push({ why: sent ? 'option_out_of_range' : 'options_trimmed', index: idx, option: o?.i }); continue; }
      if (!tok || tok === 'null') continue;                        // "这项归不进代号"是有效回答，不计数
      if (!known.has(tok)) { dropped.push({ why: 'token_unknown', index: idx, token: tok.slice(0, 24) }); continue; }
      tokens[oi] = tok; counted++;
    }
    if (counted) labels.push({ index: idx, fp: target.fp, tokens });
    else declined.push({ index: idx, fp: target.fp, task: 'label', reason: 'all_declined' });
  }
  return { picks, labels, dropped, declined };
}

/**
 * 档 A 的本地一步：把"我的取值"折算进同一份代号，再看页面哪项落进这个代号。
 * @returns {{how:string, optionIndex:number, token:string}}  how ∈ unique / no_token / none / ambiguous
 */
export function decideByToken({ target, tokens = {} } = {}) {
  if (!target) return { how: 'no_token', optionIndex: -1, token: '' };
  const ourToken = valueToToken(target.space, target.ourValue);
  if (!ourToken) return { how: 'no_token', optionIndex: -1, token: '' };
  const opts = (target.options || []).map((o, i) => ({ i, token: String(tokens[i] ?? tokens[String(i)] ?? '') }));
  const hits = opts.filter(o => o.token === ourToken);
  if (hits.length === 1) return { how: 'unique', optionIndex: hits[0].i, token: ourToken };
  return { how: hits.length ? 'ambiguous' : 'none', optionIndex: -1, token: ourToken };
}

/**
 * 把一次回答变成"要落笔的决定"清单（交给 nw:scan 的 aiOptionDecisions）。
 * 同时给出没落成的原因 —— 拿不准就明说，不静默降级。
 */
export function decisionsFromReply({ req, picks = [], labels = [] } = {}) {
  const targets = req?.targets || [];
  const decisions = [];
  const unresolved = [];
  const seen = new Set();
  for (const p of picks) {
    const t = targets[p.index];
    if (!t || seen.has(t.fp) || !p.expect) continue;
    seen.add(t.fp);
    decisions.push({ fp: t.fp, expect: p.expect, mode: 'values', space: t.space || '', path: t.path || '', reason: p.reason || '' });
  }
  const byIndex = new Map(labels.map(l => [l.index, l]));
  for (const [i, t] of targets.entries()) {
    if (seen.has(t.fp)) continue;
    const l = byIndex.get(i);
    if (!l) continue;
    const d = decideByToken({ target: t, tokens: l.tokens });
    if (d.how !== 'unique') {
      unresolved.push({ fp: t.fp, label: String(t.label || '').slice(0, 40), path: t.path || '', why: d.how, token: d.token });
      continue;
    }
    const expect = String(t.options?.[d.optionIndex] ?? '');
    if (!expect) { unresolved.push({ fp: t.fp, label: String(t.label || '').slice(0, 40), path: t.path || '', why: 'option_blank' }); continue; }
    seen.add(t.fp);
    decisions.push({ fp: t.fp, expect, mode: 'tokens', token: d.token, space: t.space || '', path: t.path || '' });
  }
  return { decisions, unresolved };
}

/**
 * 把发出去的那串选项文字在真页面里找回来：整串相等优先，截断前缀只许唯一命中。
 * 一律小写比：扫描器给出的 option 文案本来就是小写的（`returnee undergraduate scheme`），
 * 而面板/映射表那一路的文字可能带着人写的或站点原文的大写 ——
 * 这个大小写差在"问 AI 补全"那条路上已经咬过一次（'Awarding Body' vs 'awarding body'），
 * 别在第二条链上再咬一次。
 */
export function findOptionByExpect(opts = [], expect = '') {
  const norm = s => String(s ?? '').replace(/[\u0000-\u001f\s]+/g, ' ').trim().toLowerCase();
  // 省略号只可能出现在**切分之后那一段的末尾**（`裁过的文案…=码值`），所以只剥尾部
  const strip = s => norm(s).replace(/…+$/, '');
  const raw = norm(expect);
  if (!raw) return null;
  // `文案=码值` 里再切一刀：文案被裁短时分隔符还在，但"整串前缀"这条判据会失效
  const cut = raw.lastIndexOf('=');
  const valuePart = strip(cut > 0 ? raw.slice(cut + 1) : '');
  const textPart = strip(cut > 0 ? raw.slice(0, cut) : raw);
  if (!textPart) return null;
  const hit = o => {
    const t = strip(o?.text ?? (typeof o === 'string' ? o : ''));
    if (!t || !t.startsWith(textPart)) return false;
    if (!valuePart) return true;
    const v = strip(o?.value ?? '');
    return !v || v === valuePart;                    // 页面上那项没有码值时不拿它为难
  };
  const exact = opts.find(o => strip(o?.text ?? (typeof o === 'string' ? o : '')) === textPart
    && (!valuePart || strip(o?.value ?? '') === valuePart));
  if (exact) return exact;
  const pre = opts.filter(hit);
  return pre.length === 1 ? pre[0] : (pre.length > 1 ? { ambiguous: true } : null);
}

/**
 * 把"AI 认下哪一项"并进 plan。走的是同一条 applyPlan（写入与回读口径不另开一套）。
 *
 * 四条 refusal 是有原因的，不是防御性代码：
 *  · already_local —— 本地词典已经对上眼了，AI 不许回头覆盖（AI 只兜"答不上"的那几栏）；
 *  · ambiguous_fp  —— 同一页两个栏位指纹相同，分不清它说的是哪一栏（宁可不动）；
 *  · option_gone / expect_ambiguous —— 发出去之后页面重扫过，那一项不在了，或截断前缀撞上两项；
 *  · multi —— 多选控件要选的是"一组"，这套协议只承诺"一项"，不顺手扩。
 * 合规声明类（在港工作权利 / 签证类别）即使不算敏感，也一律回到黄字核对。
 */
export function applyOptionDecisions(plan, decisions = [], { fields = [] } = {}) {
  const changed = [];
  const refused = [];
  const list = Array.isArray(decisions) ? decisions : [];
  if (!plan || !list.length) return { applied: 0, changed, refused };
  const fpIndex = new Map();
  const dup = new Set();
  fields.forEach((f, i) => {
    const fp = fingerprint(f || {});
    if (fpIndex.has(fp)) { dup.add(fp); return; }
    fpIndex.set(fp, i);
  });
  const byIndex = new Map();
  for (const a of (plan.assignments || [])) if (a && a.index != null) byIndex.set(Number(a.index), a);

  for (const d of list) {
    const fp = String(d?.fp || '');
    const short = fp.slice(0, 12);
    if (!fp) { refused.push({ fp: '', why: 'no_fp' }); continue; }
    if (dup.has(fp)) { refused.push({ fp: short, why: 'ambiguous_fp' }); continue; }
    if (!fpIndex.has(fp)) { refused.push({ fp: short, why: 'fp_gone' }); continue; }
    const i = fpIndex.get(fp);
    const f = fields[i] || {};
    const a = byIndex.get(i);
    if (!a) { refused.push({ fp: short, why: 'no_assignment', index: i }); continue; }
    if (a.skip) { refused.push({ fp: short, why: 'skipped', index: i }); continue; }
    if (a.optionValue) { refused.push({ fp: short, why: 'already_local', index: i }); continue; }
    if (f.multi || f.el?.multiple) { refused.push({ fp: short, why: f.multi ? 'multi' : 'multi_select', index: i }); continue; }
    const picked = findOptionByExpect(f.options || [], d.expect);
    if (!picked || picked.ambiguous) {
      refused.push({ fp: short, why: picked ? 'expect_ambiguous' : 'option_gone', index: i, expect: String(d.expect || '').slice(0, 40) });
      continue;
    }
    a.optionValue = picked.value ?? picked.text ?? '';
    a.aiOption = true;
    a.optionHow = d.mode === 'values' ? 'ai-value' : 'ai-token';
    delete a.needsChoice;
    // note 里只引用**页面自己的**文字：note 会随诊断导出离开本机，取值原文不能混进来
    const how = d.mode === 'values' ? '按你放行的取值比对' : '按代号归类';
    const tail = String(d.reason || '').slice(0, 24);
    const note = `AI 认这一项：「${String(picked.text ?? picked.value ?? '').slice(0, 40)}」（${how}${d.token ? `，代号 ${d.token}` : ''}${tail ? `；${tail}` : ''}）`;
    a.note = a.note ? `${a.note}；${note}` : note;
    if (String(d.space || '') === 'rightToWork' || a.sensitive) a.tier = 'review';
    changed.push({ index: i, fp, optionValue: a.optionValue, how: a.optionHow, tier: a.tier });
  }

  if (changed.length && plan.stats) {
    const assignments = plan.assignments || [];
    plan.stats.auto = assignments.filter(x => !x.skip && x.tier === 'auto').length;
    plan.stats.review = assignments.filter(x => !x.skip && x.tier === 'review').length;
  }
  return { applied: changed.length, changed, refused };
}
