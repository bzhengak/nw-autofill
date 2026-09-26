// 表单扫描：把页面上"可填写的东西"抽成 core/matcher.js 能消费的描述对象。
// 覆盖 open Shadow DOM、同源 iframe 内的控件、radio/checkbox 分组、重复经历区块。

import { normalize, core, simplify, toHalfWidth } from '../core/matching.js';

const IGNORE_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset']);
const CONTROL_SELECTOR = 'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"]';

const SECTION_HINTS = [
  { re: /(教育|学历|学校|院校|专业|graduate|education|academic|school)/i, key: 'education' },
  { re: /(实习|intern)/i, key: 'internship' },
  { re: /(工作|任职|职业|experience|employment|work|career)/i, key: 'work' },
  { re: /(项目|project)/i, key: 'projects' },
  { re: /(校园|社团|学生|activity|campus|leadership)/i, key: 'campus' },
  { re: /(获奖|荣誉|奖项|award|honor|scholarship)/i, key: 'awards' },
  { re: /(竞赛|contest|competition|hackathon)/i, key: 'competitions' },
  { re: /(论文|专利|publication|patent)/i, key: 'publications' },
  { re: /(技能|技术栈|skill)/i, key: 'skills' },
  { re: /(语言|language|cet|ielts|toefl)/i, key: 'languages' },
  { re: /(证书|资格|certificat|license)/i, key: 'certifications' },
  { re: /(家庭|父母|成员|family|guardian|emergency)/i, key: 'family' },
  { re: /(联系方式|电话|手机|邮箱|contact|phone|email)/i, key: 'contact' },
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

/** 尽力而为地找一个控件的标签：label[for] → aria → 祖先 label → 前一个兄弟 → 表格单元 → 最近文本 */
function labelFor(el, doc) {
  const id = el.getAttribute('id');
  if (id) {
    const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : id.replace(/([^\w-])/g, '\\$1');
    const lab = doc.querySelector(`label[for="${esc}"]`);
    if (lab) { const t = textOf(lab); if (t) return { text: t, source: 'label-for' }; }
  }
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const parts = labelledby.split(/\s+/).map(x => textOf(doc.getElementById(x))).filter(Boolean);
    if (parts.length) return { text: parts.join(' '), source: 'aria-labelledby' };
  }
  const aria = clean(el.getAttribute('aria-label'));
  if (aria) return { text: aria, source: 'aria-label' };

  const wrap = el.closest?.('label');
  if (wrap) {
    const clone = wrap.cloneNode(true);
    clone.querySelectorAll(CONTROL_SELECTOR).forEach(n => n.remove());
    const t = clean(clone.textContent);
    if (t) return { text: t, source: 'wrapped-label' };
  }

  // 常见结构：<div class="form-item-label">姓名</div><div><input/></div>
  let node = el;
  for (let hops = 0; hops < 4 && node; hops++) {
    let sib = node.previousSibling;
    let guard = 0;
    while (sib && guard++ < 6) {
      if (sib.nodeType === 1) {
        const t = textOf(sib);
        if (t && t.length <= 40) return { text: t, source: 'prev-sibling' };
      } else if (sib.nodeType === 3) {
        const t = clean(sib.nodeValue);
        if (t && t.length <= 40) return { text: t, source: 'prev-text' };
      }
      sib = sib.previousSibling;
    }
    const cell = node.tagName === 'TD' || node.tagName === 'TH' ? node : null;
    if (cell && cell.previousElementSibling) {
      const t = textOf(cell.previousElementSibling);
      if (t) return { text: t, source: 'table-cell' };
    }
    node = node.parentElement;
  }

  const holder = el.closest?.('[class*="item"],[class*="field"],[class*="row"],[class*="form-group"],[class*="Cell"],li,dd');
  if (holder) {
    const lab = holder.querySelector(':scope > label, :scope > .label, :scope > [class*="label"], :scope > [class*="title"], :scope > [class*="name"]');
    const t = textOf(lab);
    if (t) return { text: t, source: 'holder-label' };
  }

  const ph = clean(el.getAttribute('placeholder'));
  if (ph) return { text: ph, source: 'placeholder' };
  return { text: '', source: '' };
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
        return { text: v, source: 'group-container' };
      }
    }
    node = node.parentElement;
  }
  return { text: '', source: '' };
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
    groups.get(key).push(c);
  }
  const index = new Map();
  for (const [, list] of groups) {
    if (list.length < 2 || list.length > 12) continue;
    list.forEach((el, i) => index.set(el, i));
  }
  return index;
}

function kindOf(el) {
  if (el.isContentEditable) return 'contenteditable';
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
  const role = el.getAttribute?.('role');
  if (role === 'combobox' || role === 'listbox') return 'combobox';
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
        labelSource: groupLabel.source,
        name,
        id: el.id || '',
        placeholder: el.getAttribute('placeholder') || '',
        currentValue: (groupEls.find(x => x.checked) || {}).value ?? '',
        options: groupEls.map(x => ({ text: clean(x.nextElementSibling?.textContent || x.parentElement?.textContent || x.value), value: x.value })),
        required: el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(String(el.closest?.('[class*="item"],label')?.textContent || '')),
        sectionHint: sectionHintFor(el),
        itemIndex: blockIndex.has(el) ? blockIndex.get(el) : nullIndexFrom(blockIndex, el),
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
      itemIndex: blockIndex.has(el) ? blockIndex.get(el) : nullIndexFrom(blockIndex, el),
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
  markCompositeDatePairs(out);
  return out;
}

function blockOf(el, blockIndex) {
  for (const [container, i] of blockIndex) if (container.contains?.(el)) return i;
  return -1;
}

function nullIndexFrom(blockIndex, el) {
  for (const [container, i] of blockIndex) if (container.contains?.(el)) return i;
  return null;
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
