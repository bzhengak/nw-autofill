// 站点适配器：把"这个域名属于哪个组件家族、哪些字段可以钉死"从代码里挪到数据里。
// 三条硬规矩：
//  1. 每条 adapter 必须写 evidence（怎么得来的），没依据的猜测一律标 verified:false。
//  2. adapter 只允许声明选择器、别名、日期格式与钉位；出现任何远程 URL/脚本字段直接拒绝加载。
//  3. 钉位（pins）优先于匈牙利分配，但必须回读校验，钉错了照样报红。

import { SECTIONS, fieldByPath } from './profile-schema.js';

const FORBIDDEN_KEYS = /(fetch|url|endpoint|remote|script|src|inject|eval|postmessage|request|ajax|href|webhook|payload)/i;
const ALLOWED_KEYS = new Set(['id', 'name', 'domains', 'paths', 'family', 'notes', 'evidence', 'pins', 'degreeSlotPins', 'relationSlotPins', 'languageSlotPins', 'optionRules', 'aliases', 'dateFormats', 'skip', 'controlHints', 'version']);
// 嵌套结构白名单：任何多出来的键（尤其是能发请求的键）都在校验期拒掉
const NESTED_ALLOWED = {
  pins: new Set(['match', 'path', 'note']),
  degreeSlotPins: new Set(['match', 'degree', 'subfield', 'note']),
  relationSlotPins: new Set(['match', 'relation', 'subfield', 'note']),
  languageSlotPins: new Set(['match', 'language', 'cert', 'byKey', 'subfield', 'note']),
  // 「选项 ↔ 资料取值」显式对照：页面问 Yes/No，资料里存的却是一串枚举
  // （工作许可身份 = 本地居民 / 需申请工作签证）。没有这条规则时这一栏只能交人工，
  // 让 AI 或相似度去猜就是把"是否有权工作"这种合规声明猜着替用户表态了。
  // polarity：这一题朝哪个方向问。'same'（默认）= 页面 Yes 就是资料里"有权"那一侧；
  // 'inverted' = 页面问的是"你需不需要担保"，Yes 反而对应资料里的"需要"侧 —— 方向由规则自己声明，
  // 不靠我们从问句里猜（猜错就是替用户说一句反的合规声明）。
  optionRules: new Set(['match', 'path', 'when', 'pick', 'polarity', 'note']),
  skip: new Set(['match', 'reason', 'note']),
  dateFormats: new Set(['match', 'format', 'note']),
  aliases: new Set(['path', 'add']),
  evidence: new Set(['method', 'checkedAt', 'observed', 'publicApis', 'blocked', 'verified', 'verifiedScope', 'todo', 'browserCheck', 'realStructure']),
};

/** Moka 把每段学历摊平成带学位名的字段（「硕士毕业学校（本科无需填写）」「本科毕业学校」），
 *  老式门户把家庭成员摊平成带称谓的字段（「父亲姓名」「母亲工作单位」）。
 *  两类都不能靠标签相似度猜槽位：必须由规则声明"这条属于哪个学位/称谓、哪个子字段"，
 *  再到 profile 的 education.N.degree / family.N.relation 里找实际是那一行的资料。 */
const EDUCATION_SUBFIELDS = new Set((((SECTIONS.find(s => s.k === 'education') || {}).fields) || []).map(t => t[0]));
const FAMILY_SUBFIELDS = new Set((((SECTIONS.find(s => s.k === 'family') || {}).fields) || []).map(t => t[0]));
const LANG_SUBFIELDS = new Set((((SECTIONS.find(s => s.k === 'languages') || {}).fields) || []).map(t => t[0]));
const SLOT_RULE_KINDS = {
  degreeSlotPins: { section: 'education', wantKey: 'degree', subfields: EDUCATION_SUBFIELDS, gapReason: 'degree_slot_unresolved' },
  relationSlotPins: { section: 'family', wantKey: 'relation', subfields: FAMILY_SUBFIELDS, gapReason: 'relation_slot_unresolved' },
  // 途普/埃森哲那张页面：英语、粤语、普通话、IELTS Score、TOEFL Score… 每个板块标题**就是资料里的
  // 那一行语言**。平铺的四个成绩框没有行容器，按标签相似度只能猜第几段（GMAT 拿到 IELTS 的 6.5 就是这么来的）。
  // 所以这里给一种"按资料里该列的值定位第几行"的钉法：先找到 languages.N.language == 这个语言名，
  // 再取它的子字段。找不到就交人工，绝不按顺序轮值。
  languageSlotPins: { section: 'languages', wantKey: 'language', subfields: LANG_SUBFIELDS, gapReason: 'language_slot_unresolved', strict: true },
};

function scanKeys(node, trail, errors) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (FORBIDDEN_KEYS.test(k)) errors.push(`禁止的键：${trail}${k}`);
    if (Array.isArray(v)) v.forEach((item, i) => scanKeys(item, `${trail}${k}[${i}].`, errors));
    else if (v && typeof v === 'object') scanKeys(v, `${trail}${k}.`, errors);
  }
}

export function validateAdapter(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return ['adapter 不是对象'];
  for (const k of Object.keys(raw)) if (!ALLOWED_KEYS.has(k)) errors.push(`未知键：${k}`);
  scanKeys(raw, '', errors);
  if (!raw.id) errors.push('缺少 id');
  for (const [group, allowed] of Object.entries(NESTED_ALLOWED)) {
    const list = raw[group];
    const items = Array.isArray(list) ? list : (list && typeof list === 'object' ? [list] : []);
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      for (const k of Object.keys(item)) if (!allowed.has(k)) errors.push(`${group} 内不允许的键：${k}`);
    }
  }
  for (const [k, v] of Object.entries(raw.controlHints || {})) {
    if (typeof v !== 'string') errors.push(`controlHints.${k} 必须是选择器字符串`);
    else if (/[<>]|javascript:|expression\(/i.test(v)) errors.push(`controlHints.${k} 含非法选择器内容`);
  }
  if (!Array.isArray(raw.domains) || !raw.domains.length) errors.push('缺少 domains');
  const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
  for (const d of raw.domains || []) {
    if (typeof d !== 'string' || !HOST.test(d)) errors.push(`域名不合法（需形如 a.example.com 或 *.example.com）：${d}`);
  }
  const text = JSON.stringify(raw);
  // 社区导入的适配器最会藏东西：scheme 形式、协议相对写法、data: 全都拒
  if (/https?:\/\//i.test(text)) errors.push('adapter 内不得包含 http(s) 链接（防止把资料发往远端）');
  if (/(^|[^a-z])\/\/[a-z0-9-]+\.[a-z]{2,}/i.test(text)) errors.push('adapter 内不得包含协议相对地址（//host）');
  if (/\bdata:/i.test(text)) errors.push('adapter 内不得包含 data: URI');
  if (/\beval\b|Function\(/.test(text)) errors.push('adapter 内不得包含可执行代码片段');
  const checkRules = (list, kind) => {
    for (const rule of list || []) {
      const m = String(rule.match || '');
      if (!m) { errors.push(`${kind} 规则缺少 match`); continue; }
      if (m.length > 200) errors.push(`${kind} 的 match 过长（>200 字符）：${m.slice(0, 40)}…`);
      if (/(?:\([^)]*[+*][^)]*\)\s*[+*])|(?:[+*]\s*[+*])/.test(m)) errors.push(`疑似嵌套量词（ReDoS 风险）：${m.slice(0, 60)}`);
      if (/^re:/i.test(m)) {
        const body = m.slice(3);
        if (unsafeRegex(body)) { errors.push(`危险正则（空分支会匹配所有字段）：${m}`); continue; }
        try { new RegExp(body, 'i'); } catch { errors.push(`正则无法编译：${m}`); }
      }
      if (kind === 'pins' && !rule.path) errors.push(`pin 缺少 path：${m}`);
      if (kind === 'skip' && !rule.reason) errors.push(`skip 缺少 reason：${m}`);
      if (kind === 'dateFormats' && !rule.format) errors.push(`dateFormats 缺少 format：${m}`);
    }
  };
  checkRules(raw.pins, 'pins');
  checkRules(raw.skip, 'skip');
  checkRules(raw.dateFormats, 'dateFormats');
  // 槽位规则也要过同一套正则安全检查：它们优先于 pins 生效，空分支会把整页指向同一个槽位
  checkRules(raw.degreeSlotPins, 'degreeSlotPins');
  checkRules(raw.relationSlotPins, 'relationSlotPins');
  checkRules(raw.languageSlotPins, 'languageSlotPins');
  // 选项对照规则：形状卡死（when/pick 都只能是 {yes:[…], no:[…]} 的字符串数组），
  // path 必须是资料里真存在的槽位。规则越死，越不存在"一份坏适配器把整页勾成是"的可能。
  const OPT_SIDE = new Set(['yes', 'no']);
  for (const r of raw.optionRules || []) {
    if (!r.match) errors.push('optionRules 规则缺少 match');
    const f = r.path ? fieldByPath(r.path) : null;
    if (!r.path || !f) { errors.push(`optionRules.path 不是资料里的槽位：${r.path}`); continue; }
    for (const side of ['when', 'pick']) {
      const o = r[side];
      if (!o || typeof o !== 'object' || Array.isArray(o)) { errors.push(`optionRules.${side} 需要是 {yes:[],no:[]}`); continue; }
      for (const k of Object.keys(o)) if (!OPT_SIDE.has(k)) errors.push(`optionRules.${side} 只允许 yes/no，来了 ${k}`);
      for (const k of OPT_SIDE) {
        const list = o[k];
        if (!Array.isArray(list)) errors.push(`optionRules.${side}.${k} 必须是数组`);
        else for (const s of list) {
          if (typeof s !== 'string' || !s.trim()) errors.push(`optionRules.${side}.${k} 只能是非空字符串`);
          if (String(s || '').length > 40) errors.push(`optionRules.${side}.${k} 词条过长（>40）：${String(s).slice(0, 40)}…`);
        }
      }
    }
    if (r.when && !(r.when.yes || []).length && !(r.when.no || []).length) errors.push('optionRules.when 两边都空，等于没写');
    if (r.polarity !== undefined && !['same', 'inverted'].includes(String(r.polarity))) {
      errors.push(`optionRules.polarity 只允许 same / inverted：${r.polarity}`);
    }
  }
  for (const [kind, spec] of Object.entries(SLOT_RULE_KINDS)) {
    for (const r of raw[kind] || []) {
      if (!r.match) errors.push(`${kind} 规则缺少 match`);
      const keyed = r.byKey || spec.wantKey;
      if (!String(r[keyed] || '').trim()) errors.push(`${kind} 规则缺少 ${keyed}（硕士/本科、父亲/母亲、IELTS/粤语…）：${r.match}`);
      if (r.byKey && !spec.subfields.has(String(r.byKey)) && r.byKey !== spec.wantKey) errors.push(`${kind}.byKey 不是 ${spec.section} 的字段：${r.byKey}`);
      if (!spec.subfields.has(String(r.subfield || ''))) errors.push(`${kind}.subfield 不是 ${spec.section} 的字段：${r.subfield}`);
    }
  }
  for (const a of raw.aliases || []) if (!a.path || !Array.isArray(a.add)) errors.push(`aliases 条目需要 path 与 add 数组`);
  return errors;
}

/**
 * 域名匹配；同一系统家族下不同公司措辞可能不同，所以支持 paths 做租户级覆盖：
 * 带 paths 的适配器优先于只带 domains 的家族适配器。
 */
export function matchAdapter(url, adapters) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname;
  const where = a => (a.domains || []).some(d => {
    const bare = d.replace(/^\*\./, '');
    return d.startsWith('*.') ? (host === bare || host.endsWith('.' + bare)) : host === d;
  });
  const scored = [];
  for (const a of adapters) {
    if (!where(a)) continue;
    const hit = (a.paths || []).some(p => typeof p === 'string' && p && (parsed.pathname + parsed.hash).includes(p));
    scored.push({ a, rank: hit ? 2 : (a.paths && a.paths.length ? -1 : 1) });
  }
  const usable = scored.filter(s => s.rank >= 0);
  if (!usable.length) return null;
  return usable.sort((x, y) => y.rank - x.rank)[0].a;
}

/**
 * 把"文件名 → 解析后的 JSON"编译成可用的适配器集合。
 * 校验不过的直接丢掉并说明原因：宁可这一页没有适配器，也不执行一份没审过的规则集。
 * 纯函数（fetch 由调用方注入），所以能在 node --test 下覆盖。
 */
export function compileAdapters(files, warn = () => {}) {
  const adapters = [];
  const rejected = [];
  for (const [name, raw] of Object.entries(files || {})) {
    const errors = validateAdapter(raw);
    if (errors.length) {
      rejected.push({ name, errors });
      warn(`适配器 ${name} 被拒绝：${errors.join('；')}`);
      continue;
    }
    adapters.push(raw);
  }
  return { adapters, rejected, resolve: url => matchAdapter(url, adapters) };
}

/** 危险的 `re:` 写法：空分支（如 `a|`、`|b`、`a||b`）会匹配一切，曾经一整个表单被误判跳过 */
function unsafeRegex(body) {
  const s = String(body || '');
  if (!s.trim()) return true;
  // 空分支：开头/结尾/相邻竖线，以及分组内的 "(a|" 或 "|a)" 或 "(|)"
  return /\|\|/.test(s) || /^\|/.test(s) || /\|$/.test(s) || /\(\|/.test(s) || /\|\)/.test(s) || /\(\s*\)/.test(s);
}

/** 整条标签相等（去空白、去括号注释、去必填星号）：语言/考试名这类钉位专用 */
function labelEquals(pageLabel, matcher) {
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[（(].*?[）)]/g, '').replace(/[*＊:：]/g, '');
  const a = norm(pageLabel), b = norm(matcher);
  return !!a && !!b && a === b;
}

function labelHits(pageLabel, matcher) {
  const src = String(matcher || '');
  if (/^re:/i.test(src)) {
    const body = src.slice(3);
    if (unsafeRegex(body)) return false;
    try { return new RegExp(body, 'i').test(String(pageLabel || '')); } catch { return false; }
  }
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[（(].*?[）)]/g, '');
  const target = norm(src);
  const label = norm(pageLabel);
  if (!target || !label) return false;
  return label === target || label.includes(target);
}

/**
 * 把 adapter 应用到扫描结果上。
 * @returns {{pins: Map<number,string>, skip: Map<number,string>, slotPins: Map<number,{degree:string,subfield:string}>, optionRules: Map<number,object>, aliases: Array, dateFormats: Array}}
 */
export function planFromAdapter(pageFields, adapter) {
  if (!adapter) return { pins: new Map(), skip: new Map(), slotPins: new Map(), optionRules: new Map(), aliases: [], dateFormats: [] };
  const pins = new Map();
  const skip = new Map();
  const slotPins = new Map();
  const optionRules = new Map();
  pageFields.forEach((f, i) => {
    const hay = [f.label, f.name, f.id, f.placeholder].filter(Boolean).join(' ');
    const slotHay = [f.label, f.name, f.id].filter(Boolean).join(' ');
    for (const s of adapter.skip || []) {
      if (labelHits(hay, s.match)) { skip.set(i, s.reason || 'adapter_skip'); return; }
    }
    // 选项对照规则按标签挂到栏位上；真正用不用得看 matcher 那边
    // "这一栏最后拿到的槽位 == 规则写的槽位"，标签像但资料对不上时规则不生效。
    // 存成**数组**：同一道题常有正问/反问两种写法（Yes 的含义相反），
    // 谁先命中就用谁会让另一种写法永远撞不上（实测：'work permit' 的正问规则吃掉了反问题面）。
    for (const r of adapter.optionRules || []) {
      if (r.match && labelHits(hay, r.match)) optionRules.set(i, [...(optionRules.get(i) || []), r]);
    }
    // 摊平型槽位规则优先于普通钉位：学历（硕士/本科）与家庭成员（父亲/母亲）都是
    // "标签里写着 belonging，槽位号却要去看资料"的字段，猜错就是把母亲单位填进父亲那行。
    // 只在标签/name/id 上判定（placeholder 常写"请输入本科学校"这种示例，拿它定槽位会串档）；
    // 一条标签同时提到两个归属时（"硕士毕业学校（本科无需填写）"），取字样出现最早的那个。
    let bestSlot = null;
    for (const [kind, spec] of Object.entries(SLOT_RULE_KINDS)) {
      for (const sp of adapter[kind] || []) {
        // strict 类（语言/考试名）只认**整条标签相等**：'english' 不许命中 'english name'。
        // 上一版用子串，结果 English Name 被钉成"英语那一行的语言列"（置信 1.0，绿字），
        // 而它本该是 basics.nameEn —— 钉位分数是 1.0，别名再准也压不过它。
        const okHit = spec.strict
          ? labelEquals(f.label, sp.match)
          : labelHits(slotHay, sp.match);
        if (!okHit) continue;
        const keyField = sp.byKey || spec.wantKey;
        const want = String(sp[keyField] || sp[spec.wantKey] || '');
        const at = slotHay.toLowerCase().indexOf(want.toLowerCase());
        const rank = at < 0 ? 999 : at;
        if (!bestSlot || rank < bestSlot.rank) {
          bestSlot = { rank, slot: { section: spec.section, keyField, want, subfield: sp.subfield, gapReason: spec.gapReason } };
        }
      }
    }
    if (bestSlot) { slotPins.set(i, bestSlot.slot); return; }
    for (const p of adapter.pins || []) {
      if (pins.has(i)) continue;
      if (labelHits(hay, p.match)) pins.set(i, p.path);
    }
  });
  return { pins, skip, slotPins, optionRules, aliases: adapter.aliases || [], dateFormats: adapter.dateFormats || [] };
}

/** 命中 adapter 的日期格式覆盖 */
export function dateFormatOverride(adapter, pageField) {
  if (!adapter) return '';
  const hay = [pageField.label, pageField.placeholder, pageField.name].filter(Boolean).join(' ');
  for (const d of (adapter && adapter.dateFormats) || []) if (labelHits(hay, d.match)) return d.format;
  return '';
}
