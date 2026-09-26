// 站点适配器：把"这个域名属于哪个组件家族、哪些字段可以钉死"从代码里挪到数据里。
// 三条硬规矩：
//  1. 每条 adapter 必须写 evidence（怎么得来的），没依据的猜测一律标 verified:false。
//  2. adapter 只允许声明选择器、别名、日期格式与钉位；出现任何远程 URL/脚本字段直接拒绝加载。
//  3. 钉位（pins）优先于匈牙利分配，但必须回读校验，钉错了照样报红。

const FORBIDDEN_KEYS = /^(fetch|url|endpoint|remote|script|src|inject|eval|postMessage|request|ajax|href)$/i;
const ALLOWED_KEYS = new Set(['id', 'name', 'domains', 'family', 'notes', 'evidence', 'pins', 'aliases', 'dateFormats', 'skip', 'controlHints', 'version']);
// 嵌套结构白名单：任何多出来的键（尤其是能发请求的键）都在校验期拒掉
const NESTED_ALLOWED = {
  pins: new Set(['match', 'path', 'note']),
  skip: new Set(['match', 'reason', 'note']),
  dateFormats: new Set(['match', 'format', 'note']),
  aliases: new Set(['path', 'add']),
  evidence: new Set(['method', 'checkedAt', 'observed', 'publicApis', 'blocked', 'verified', 'verifiedScope', 'todo', 'browserCheck', 'realStructure']),
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
  if (/https?:\/\//i.test(text)) errors.push('adapter 内不得包含 http(s) 链接（防止把资料发往远端）');
  if (/\beval\b|Function\(/.test(text)) errors.push('adapter 内不得包含可执行代码片段');
  const checkRules = (list, kind) => {
    for (const rule of list || []) {
      const m = String(rule.match || '');
      if (!m) { errors.push(`${kind} 规则缺少 match`); continue; }
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
  for (const a of raw.aliases || []) if (!a.path || !Array.isArray(a.add)) errors.push(`aliases 条目需要 path 与 add 数组`);
  return errors;
}

export function matchAdapter(url, adapters) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return null; }
  for (const a of adapters) {
    for (const d of a.domains || []) {
      const bare = d.replace(/^\*\./, '');
      const ok = d.startsWith('*.') ? host === bare || host.endsWith('.' + bare) : host === d;
      if (ok) return a;
    }
  }
  return null;
}

/** 危险的 `re:` 写法：空分支（如 `a|`、`|b`、`a||b`）会匹配一切，曾经一整个表单被误判跳过 */
function unsafeRegex(body) {
  const s = String(body || '');
  if (!s.trim()) return true;
  // 空分支：开头/结尾/相邻竖线，以及分组内的 "(a|" 或 "|a)" 或 "(|)"
  return /\|\|/.test(s) || /^\|/.test(s) || /\|$/.test(s) || /\(\|/.test(s) || /\|\)/.test(s) || /\(\s*\)/.test(s);
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
 * @returns {{pins: Map<number,string>, skip: Map<number,string>, aliases: Array, dateFormats: Array}}
 */
export function planFromAdapter(pageFields, adapter) {
  if (!adapter) return { pins: new Map(), skip: new Map(), aliases: [], dateFormats: [] };
  const pins = new Map();
  const skip = new Map();
  pageFields.forEach((f, i) => {
    const hay = [f.label, f.name, f.id, f.placeholder].filter(Boolean).join(' ');
    for (const s of adapter.skip || []) {
      if (labelHits(hay, s.match)) { skip.set(i, s.reason || 'adapter_skip'); return; }
    }
    for (const p of adapter.pins || []) {
      if (pins.has(i)) continue;
      if (labelHits(hay, p.match)) pins.set(i, p.path);
    }
  });
  return { pins, skip, aliases: adapter.aliases || [], dateFormats: adapter.dateFormats || [] };
}

/** 命中 adapter 的日期格式覆盖 */
export function dateFormatOverride(adapter, pageField) {
  if (!adapter) return '';
  const hay = [pageField.label, pageField.placeholder, pageField.name].filter(Boolean).join(' ');
  for (const d of (adapter && adapter.dateFormats) || []) if (labelHits(hay, d.match)) return d.format;
  return '';
}
