// 表单扫描：把页面上"可填写的东西"抽成 core/matcher.js 能消费的描述对象。
// 覆盖 open Shadow DOM、同源 iframe 内的控件、radio/checkbox 分组、重复经历区块。

import { normalize, core, simplify, toHalfWidth, pickLabelCandidate } from '../core/matching.js';

const IGNORE_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset']);
const CONTROL_SELECTOR = 'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"]';

const SECTION_HINTS = [
  { re: /(教育|学历|学校|院校|专业|graduate|education|academic|school)/i, key: 'education' },
  { re: /(实习|intern)/i, key: 'internship' },
  { re: /(工作|任职|职业|经验|experience|employment|work|career)/i, key: 'work' },
  { re: /(项目|project)/i, key: 'projects' },
  { re: /(校园|社团|学生|activity|campus|leadership)/i, key: 'campus' },
  { re: /(获奖|荣誉|奖项|award|honor|scholarship)/i, key: 'awards' },
  { re: /(竞赛|contest|competition|hackathon)/i, key: 'competitions' },
  { re: /(论文|专利|publication|patent)/i, key: 'publications' },
  { re: /(技能|技术栈|skill)/i, key: 'skills' },
  { re: /(语言|language|cet|ielts|toefl)/i, key: 'languages' },
  { re: /(证书|资格|certificat|license)/i, key: 'certifications' },
  { re: /(家庭|父母|成员|family|guardian|emergency)/i, key: 'family' },
  { re: /(联系方式|电话|手机|邮箱|地址|contact|phone|email|address)/i, key: 'contact' },
  { re: /(求职意向|期望|意向|preference|objective|desired)/i, key: 'intent' },
  { re: /(档案|政审|背景调查|无犯罪|犯罪记录|record|background|declaration)/i, key: 'records' },
  { re: /(基本信息|个人|profile|personal|candidate)/i, key: 'basics' },
];

const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,caption,legend,[class*="title"],[class*="head"],[class*="section-name"]';

/** 取 container 内、位于 el 之前且离 el 最近的那个标题文本 */
function headingBefore(container, el) {
  let best = null;
  let bestText = '';
  for (const h of Array.from(container.querySelectorAll?.(HEADING_SELECTOR) || [])) {
    if (h === el || h.contains?.(el)) continue;
    const pos = h.compareDocumentPosition(el);
    if (!(pos & 4)) continue; // 4 = el 在 h 之后
    const t = clean(h.textContent);
    if (!t) continue;
    if (!best || (best.compareDocumentPosition(h) & 4)) { best = h; bestText = t; }
  }
  return bestText;
}

/** 只认真正的小节标题元素。邻近的字段标签（老式表格里的 th "工作单位及职务"）
 *  会被误当成章节，把"家庭主要成员"下的字段判给 work，所以必须按标签名过滤。 */
function prevSiblingHeading(node) {
  let sib = node.previousElementSibling;
  for (let g = 0; g < 8 && sib; g++) {
    if (sib.matches?.(HEADING_SELECTOR)) {
      const t = clean(sib.textContent || '');
      if (t) return t;
    }
    if (sib.querySelector?.(CONTROL_SELECTOR)) break; // 已经碰到另一组表单内容，别再往前找
    sib = sib.previousElementSibling;
  }
  return '';
}

function sectionHintFor(el) {
  let node = el;
  for (let i = 0; i < 8 && node; i++) {
    const own = headingBefore(node, el) || prevSiblingHeading(node);
    if (own) {
      const hit = SECTION_HINTS.find(h => h.re.test(own));
      if (hit) return hit.key;
    }
    const cls = String(node.className || '');
    if (cls) for (const hint of SECTION_HINTS) if (hint.re.test(cls)) return hint.key;
    node = node.parentElement;
  }
  return '';
}

const TRAILING_NOISE = /(必填|选填|限\d+字|\(\d+\/\d+\)|\bmax\b|字符|字$|please\s*enter|例如)/i;

function visible(el, doc) {
  if (!el) return false;
  if (el.disabled) return false;
  const style = (el.ownerDocument || doc).defaultView?.getComputedStyle(el);
  if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
  if (el.type === 'hidden') return false;
  const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  if (rect && rect.width === 0 && rect.height === 0 && !el.closest?.('head')) {
    // 自定义下拉/日期组件的隐藏 input 是常态，保留但降权
    el.__nwZeroSize = true;
  }
  return true;
}

function clean(text) {
  return core(String(text || '').replace(TRAILING_NOISE, ' '));
}

function textOf(node) {
  if (!node) return '';
  return clean(node.textContent || node.innerText || '');
}

/** 卡片/小节标题：Moka 把 "Experience"、"Projects" 这类区块题目放在字段旁边，
 *  当成标签会让整块字段糊到同一个槽位上，必须识别并降权而不是当作普通候选。 */
const BLOCK_TITLE_CLASS_RE = /(card|section|panel|group|page|list|block|form|item)-(title|header|heading|name)|(?:title|header|heading)$/i;

function isBlockTitle(node) {
  if (!node || node.nodeType !== 1) return false;
  if (/^(h[1-6]|legend|caption|summary)$/i.test(node.tagName || '')) return true;
  const cls = node.className && typeof node.className === 'object' ? String(node.className.baseVal || '') : String(node.className || '');
  return BLOCK_TITLE_CLASS_RE.test(cls.trim());
}

/**
 * 标签解析：收集多个候选再打分选优。
 * 单一策略在真实站点必错——招行的日期框"标签"全是 placeholder「请选择时间」，
 * 拼多多有「毕业学院」这种笔误叫法，携程的 SVG 会把 "Created with Sketch." 当文本吐出来。
 */
function labelFor(el, doc) {
  const cands = [];
  const push = (node, source, depth) => {
    if (!node) return;
    if (node.nodeType === 3) {
      const txt = clean(node.nodeValue);
      if (txt) cands.push({ text: txt, raw: normRaw(node.nodeValue), source, depth: depth || 0 });
      return;
    }
    // 含表单控件的兄弟节点是"上一个字段"，不是这个字段的标签
    if (node.querySelector && node.querySelector(CONTROL_SELECTOR)) return;
    if (node.contains && node.contains(el) && node !== el) return;
    const txt = textOf(node);
    if (txt) cands.push({ text: txt, raw: normRaw(node.textContent), source, depth: depth || 0, heading: isBlockTitle(node) });
  };

  const id = el.getAttribute('id');
  if (id) { try { push(doc.querySelector(`label[for="${CSS_escape(id)}"]`), 'label-for', 0); } catch { /* 非法 id */ } }
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const parts = labelledby.split(/s+/).map(x => doc.getElementById(x)).filter(Boolean);
    if (parts.length === 1) push(parts[0], 'aria-labelledby', 0);
    else if (parts.length > 1) {
      const txt = parts.map(x => textOf(x)).filter(Boolean).join(' ');
      if (txt) cands.push({ text: txt, raw: normRaw(txt), source: 'aria-labelledby', depth: 0 });
    }
  }
  push2(el, cands);
  const wrap = el.closest?.('label');
  if (wrap) {
    const clone = wrap.cloneNode(true);
    clone.querySelectorAll(CONTROL_SELECTOR).forEach(n => n.remove());
    const txt = clean(clone.textContent);
    if (txt) cands.push({ text: txt, raw: normRaw(wrap.textContent), source: 'wrapped-label', depth: 0 });
  }

  let node = el;
  for (let hops = 0; hops < 5 && node; hops++) {
    let sib = node.previousSibling, guard = 0;
    while (sib && guard++ < 6) {
      // 碰到兄弟里另一个字段块就收手：再往前是"别人的标签"，跨块取文本会把卡片题目当成标签
      if (sib.nodeType === 1 && sib.querySelector?.(CONTROL_SELECTOR)) break;
      push(sib, 'prev-sibling', hops);
      sib = sib.previousSibling;
    }
    if (node.tagName === 'TD' || node.tagName === 'TH') push(node.previousElementSibling, 'table-cell', hops);
    const holder = node.parentElement;
    if (!holder) break;
    push(holder.querySelector(':scope > label, :scope > [class*="label"], :scope > [class*="title"], :scope > dt, :scope > th'), 'container-label', hops + 1);
    const kids = Array.from(holder.children || []).slice(0, 12);
    for (const k of kids) {
      if (k === node || (k.contains && k.contains(el))) break;
      if (k.querySelector && k.querySelector(CONTROL_SELECTOR)) continue;
      const txt = textOf(k);
      if (txt && txt.length <= 24) cands.push({ text: txt, raw: normRaw(k.textContent), source: 'container-text', depth: hops + 2, heading: isBlockTitle(k) });
    }
    if (kids.length && kids[0] === node && hops >= 2) break;
    node = holder;
  }

  const ph = clean(el.getAttribute('placeholder'));
  if (ph) cands.push({ text: ph, raw: ph, source: 'placeholder', depth: 9 });
  return pickLabelCandidate(cands);
}

function push2(el, cands) {
  const ariaRaw = el.getAttribute('aria-label');
  const aria = clean(ariaRaw);
  if (aria) cands.push({ text: aria, raw: normRaw(ariaRaw), source: 'aria-label', depth: 0 });
}

/**
 * 单选/多选组的"组标签"。直接取包裹 label 的文本会拿到选项本身（"男"），
 * 所以从内向外找第一个"减掉所有选项文本后还剩内容"的祖先容器。
 */
function groupLabelOf(el, groupEls, doc) {
  const optionTexts = groupEls.map(x => normalize(x.parentElement?.textContent || x.nextElementSibling?.textContent || '')).filter(Boolean);
  const name = el.getAttribute('name');
  if (name) {
    const forLabel = doc.querySelector?.(`label[for="${CSS_escape(name)}"]`);
    const t = clean(forLabel?.textContent || '');
    if (t) return { text: t, source: 'label-for-group' };
  }
  let node = el;
  for (let i = 0; i < 7 && node; i++) {
    const rawText = String(node.textContent || '');
    if (rawText.trim()) {
      // 先按词元剔除选项，再归一化：normalize 会吃掉中文字间空格，'男 女' 会粘成 '男女' 删不掉，
      // 性别组标签就会退化成"性别 男女"而失配。
      const loose = s => simplify(toHalfWidth(String(s || ''))).toLowerCase();
      const drop = new Set(optionTexts.map(t => loose(t).trim()).filter(Boolean));
      const residual = loose(rawText).split(/[\s|｜·]+/).filter(w => w && !drop.has(w)).join(' ');
      const v = core(residual);
      if (v && v.length >= 2 && v.length <= 90 && !/^(男|女|是|否|有|无|请选择|必填|限\d+字)$/.test(v)) {
        return { text: v, raw: normRaw(rawText), source: 'group-container' };
      }
    }
    node = node.parentElement;
  }
  return { text: '', source: '' };
}

export function normRaw(s) {
  return String(s || '').replace(/s+/g, ' ').trim();
}

function nearbyLabels(el, doc) {
  const out = [];
  const legend = el.closest?.('fieldset')?.querySelector?.('legend');
  if (legend) out.push(textOf(legend));
  const group = el.getAttribute('name') ? doc.querySelector(`[data-nw-group="${CSS_escape(el.getAttribute('name'))}"]`) : null;
  if (group) out.push(textOf(group));
  const head = el.closest?.('[class*="section"],[class*="block"],[class*="card"],[class*="group"],[class*="form"],table')
    ?.querySelector?.('h1,h2,h3,h4,[class*="title"],caption,th');
  if (head) out.push(textOf(head));
  return out.filter(Boolean).slice(0, 4);
}

function CSS_escape(v) {
  if (!v) return '';
  return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(v) : String(v).replace(/([^\w-])/g, '\\$1');
}

/** 一条"经历"的内部指纹：控件的 name/placeholder/aria-label 序列。
 *  两段真经历会重复同样的字段名（School / Course of Study…），布局壳子不会。 */
function controlSignature(c) {
  const ctl = Array.from(c.querySelectorAll?.(CONTROL_SELECTOR) || []).slice(0, 12);
  return ctl.map(x => normRaw(x.getAttribute('name') || x.getAttribute('placeholder') || x.getAttribute('aria-label') || '')).filter(Boolean).join('|');
}

/** 重复经历区块：同一父级下结构相同、且含 ≥2 个控件的块才算"一条经历"。
 *  老式表格里一行只有一个输入框，那是"字段"而不是"区块"，误判会让 itemIndex 全体错位。 */
function detectRepeatedBlocks(root) {
  const groups = new Map();
  const containers = root.querySelectorAll?.('[class*="item"],[class*="row"],[class*="card"],[class*="list"],li,tr,fieldset,div') || [];
  for (const c of containers) {
    const controls = c.querySelectorAll?.(CONTROL_SELECTOR) || [];
    const own = Array.from(controls).filter(x => x.closest('[class*="item"],[class*="row"],[class*="card"],li,tr,fieldset') === c || x.parentElement === c);
    if (controls.length < 2 && own.length < 2) continue;
    if (controls.length > 12) continue;
    const key = `${c.parentElement ? (c.parentElement.className || c.parentElement.tagName) : ''}::${c.className || c.tagName}::${controls.length}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ c, sig: controlSignature(c) });
  }
  const index = new Map();
  let gid = 0;
  for (const [key, list] of groups) {
    if (list.length < 2 || list.length > 12) continue;
    // 只有"确实像重复记录"才编号：字段指纹在各块之间重复出现，或每块控件足够多。
    // Sea 自研页里三个 .se-field 壳子（各含一个下拉+一个输入）曾被当成"第 0/1/2 段经历"，
    // 于是 Contact Number 这种一次性字段被 ×0.8 罚掉，让位给 family.0.phone。
    const sigs = new Set(list.map(x => x.sig));
    const repeatedEvidence = list.length - sigs.size >= 1 && !sigs.has('');
    const wideBlocks = list.every(x => x.c.querySelectorAll?.(CONTROL_SELECTOR).length >= 3);
    if (!repeatedEvidence && !wideBlocks) continue;
    const group = `${key}#${gid++}`;
    list.forEach((item, i) => index.set(item.c, { index: i, group }));
  }
  return index;
}

/** 找到控件所属的重复区块容器（最里层的那个） */
function blockInfoOf(el, blockIndex) {
  for (const [c, info] of blockIndex) if (c.contains?.(el)) return { container: c, ...info };
  return null;
}

function kindOf(el) {
  if (el.isContentEditable) return 'contenteditable';
  const role = el.getAttribute?.('role');
  // role 先于标签判断：SuccessFactors 的"下拉"是 <input role=combobox>（placeholder「No Selection」），
  // 按标签名判成 text 就会往里打字——不会选中任何值，还会把站点自己的校验搞乱。
  if (role === 'combobox' || role === 'listbox') return 'combobox';
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'input') {
    const t = (el.type || 'text').toLowerCase();
    if (t === 'radio') return 'radio';
    if (t === 'checkbox') return 'checkbox';
    if (t === 'file') return 'file';
    if (t === 'date' || t === 'datetime-local') return 'date';
    if (t === 'month') return 'month';
    if (t === 'number') return 'number';
    if (t === 'email') return 'email';
    if (t === 'tel') return 'tel';
    if (t === 'url') return 'url';
    return 'text';
  }
  const roleAttr = el.getAttribute?.('role');
  if (roleAttr === 'combobox' || roleAttr === 'listbox') return 'combobox';
  return 'text';
}

function optionsOf(el, kind) {
  if (kind === 'select') {
    return Array.from(el.options || []).filter(o => o.value !== '' || o.textContent.trim())
      .map(o => ({ text: clean(o.textContent), value: o.value }));
  }
  if (kind === 'combobox') {
    const owner = el.closest?.('[class*="select"],[class*="picker"],[class*="dropdown"]') || el.parentElement;
    const items = owner?.querySelectorAll?.('[role="option"],li,[class*="option"],[class*="item"]') || [];
    return Array.from(items).map(o => ({ text: clean(o.textContent), value: clean(o.textContent) })).filter(o => o.text).slice(0, 80);
  }
  return [];
}

function walk(node, out, doc, depth = 0) {
  if (!node || depth > 40) return;
  const list = node.querySelectorAll ? node.querySelectorAll(CONTROL_SELECTOR) : [];
  for (const el of list) {
    if (IGNORE_INPUT_TYPES.has((el.type || '').toLowerCase())) continue;
    if (!visible(el, doc)) continue;
    out.push(el);
  }
  // open shadow root 递归
  const hosts = node.querySelectorAll ? node.querySelectorAll('*') : [];
  for (const h of hosts) if (h.shadowRoot) walk(h.shadowRoot, out, h.shadowRoot.ownerDocument || doc, depth + 1);
}

export function scanForm(root = document) {
  const doc = root.ownerDocument || root;
  const raw = [];
  walk(root.nodeType === 9 ? root.documentElement : root, raw, doc);

  const blockIndex = detectRepeatedBlocks(root.nodeType === 9 ? root.documentElement : root);
  const fields = [];
  const seenGroups = new Set();

  for (const el of raw) {
    // AntD/五矿/招行式自定义下拉：真身是 div[role=combobox]，里面的 input 没有标签。
    // 若把它当独立文本框打字进去，值根本不会选中，还可能搞乱站点校验。
    if ((el.tagName || '').toLowerCase() === 'input' && el.closest?.('[role="combobox"]') !== null
      && el.closest('[role="combobox"]') !== el) continue;
    let kind = kindOf(el);
    const name = el.getAttribute('name') || '';

    if (kind === 'radio' || kind === 'checkbox') {
      const gkey = `${kind}:${name || el.getAttribute('aria-labelledby') || ''}:${blockOf(el, blockIndex)}`;
      if (name && seenGroups.has(gkey)) continue;
      if (name) seenGroups.add(gkey);
      const groupEls = name ? Array.from(doc.querySelectorAll(`${kind === 'radio' ? 'input[type="radio"]' : 'input[type="checkbox"]'}[name="${CSS_escape(name)}"]`)) : [el];
      const groupLabel = groupLabelOf(el, groupEls, doc);
      fields.push({
        kind,
        label: groupLabel.text || '',
        labelRaw: groupLabel.raw || groupLabel.text || '',
        labelSource: groupLabel.source,
        name,
        id: el.id || '',
        placeholder: el.getAttribute('placeholder') || '',
        currentValue: (groupEls.find(x => x.checked) || {}).value ?? '',
        options: groupEls.map(x => ({ text: clean(x.nextElementSibling?.textContent || x.parentElement?.textContent || x.value), value: x.value })),
        required: el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(String(el.closest?.('[class*="item"],label')?.textContent || '')),
        sectionHint: sectionHintFor(el),
        itemIndex: (blockInfoOf(el, blockIndex) || {}).index ?? null,
        nearbyLabels: nearbyLabels(el, doc),
        autocomplete: el.getAttribute('autocomplete') || '',
        testId: el.getAttribute('data-testid') || el.getAttribute('data-test') || '',
        className: String(el.className || ''),
        ownerText: clean(el.parentElement?.textContent || '').slice(0, 60),
        multi: kind === 'checkbox',
        zeroSize: Boolean(el.__nwZeroSize),
        el,
      });
      continue;
    }

    const label = labelFor(el, doc);
    fields.push({
      kind,
      label: label.text || '',
      labelRaw: label.raw || label.text || '',
      labelSource: label.source,
      name,
      id: el.id || '',
      placeholder: el.getAttribute('placeholder') || '',
      type: (el.type || '').toLowerCase(),
      inputType: (el.type || '').toLowerCase(),
      currentValue: kind === 'contenteditable' ? clean(el.textContent) : (el.value ?? ''),
      sampleValue: el.getAttribute('placeholder') || '',
      options: optionsOf(el, kind),
      required: el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(String(el.closest?.('[class*="item"],label,td,th')?.textContent || '')),
      sectionHint: sectionHintFor(el),
      itemIndex: (blockInfoOf(el, blockIndex) || {}).index ?? null,
      nearbyLabels: nearbyLabels(el, doc),
      autocomplete: el.getAttribute('autocomplete') || '',
      testId: el.getAttribute('data-testid') || el.getAttribute('data-test') || '',
      className: String(el.className || ''),
      ownerText: clean(el.parentElement?.textContent || '').slice(0, 60),
      readOnly: Boolean(el.readOnly),
      maxLength: el.maxLength > 0 ? el.maxLength : null,
      zeroSize: Boolean(el.__nwZeroSize),
      el,
    });
  }
  const out = fields.filter(f => f.label || f.name || f.id || f.placeholder || f.testId || f.autocomplete);
  renumberItemIndexBySection(out, blockIndex);
  markCompositeDatePairs(out);
  return out;
}

/**
 * itemIndex 必须是"同一章节里的第几块"，不能是"全页面第几个区块"。
 * 老式 <fieldset> 布局的 Basics/Education/Work 结构相似，会被 detectRepeatedBlocks 归成一组重复区块，
 * 于是教育经历带着 itemIndex=1 去对齐 profile，把硕士槽位漂移成本科槽位（SF 仿真表单实测踩过）。
 */
function renumberItemIndexBySection(fields, blockIndex) {
  const seen = new Map();            // `${组}||${章节}` -> 该组合内按文档顺序出现的容器
  for (const f of fields) {
    const info = blockInfoOf(f.el, blockIndex);
    if (!info) continue;
    f.__block = info;
    const key = `${info.group}||${f.sectionHint || ''}`;
    if (!seen.has(key)) seen.set(key, []);
    const list = seen.get(key);
    if (!list.includes(info.container)) list.push(info.container);
  }
  for (const f of fields) {
    if (!f.__block) continue;
    const key = `${f.__block.group}||${f.sectionHint || ''}`;
    const local = (seen.get(key) || []).indexOf(f.__block.container);
    if (local >= 0) f.itemIndex = local;
    delete f.__block;
  }
}

function blockOf(el, blockIndex) {
  const info = blockInfoOf(el, blockIndex);
  return info ? info.index : -1;
}


/**
 * 标记"年 + 月"成对输入框（Moka 等的日期实现）：同一容器里既有 year 框又有 month 框时，
 * 单个框无法承载一个完整日期值，必须整组交给人工，否则会出现两个框被填成同一个值。
 */
function markCompositeDatePairs(fields) {
  const byParent = new Map();
  for (const f of fields) {
    if (!f.el?.parentElement) continue;
    const key = f.el.parentElement;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(f);
  }
  for (const group of byParent.values()) {
    const isYear = f => /^(year|年|yyyy)$/i.test(normText(f.placeholder)) || /^(year|年|yyyy)$/i.test(normText(f.label));
    const isMonth = f => /^(month|月|mm)$/i.test(normText(f.placeholder)) || /^(month|月|mm)$/i.test(normText(f.label));
    const years = group.filter(f => f.kind === 'text' && isYear(f));
    const months = group.filter(f => f.kind === 'text' && isMonth(f));
    if (years.length && months.length) {
      for (const f of years) f.compositeDate = 'year';
      for (const f of months) f.compositeDate = 'month';
    }
  }
}

function normText(s) {
  return String(s || '').trim().toLowerCase();
}

export function describeForDebug(fields) {
  return fields.map(f => ({
    kind: f.kind, label: f.label, source: f.labelSource, name: f.name, id: f.id,
    options: (f.options || []).length, required: Boolean(f.required),
    section: f.sectionHint, item: f.itemIndex,
  }));
}

export { normalize };
