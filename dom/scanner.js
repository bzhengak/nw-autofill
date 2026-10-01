// 表单扫描：把页面上"可填写的东西"抽成 core/matcher.js 能消费的描述对象。
// 覆盖 open Shadow DOM、同源 iframe 内的控件、radio/checkbox 分组、重复经历区块。

import { normalize, core, simplify, toHalfWidth, pickLabelCandidate } from '../core/matching.js';
// "什么算选择控件触发器"只在 dom/safety.js 定义一次：扫描、点击闸门、opener 三处共用，
// 各写各的迟早漂移（漂移的结果要么是"该点的点不了"，要么是"不该点的点了"）。
import { SELECT_TRIGGER_SELECTOR } from './safety.js';

const IGNORE_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset']);
const CONTROL_SELECTOR = 'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"]';
// "这是一个表单条目"级别的容器：只有类名自己这么写的，才允许往"控件之后的那一支"找标签。
const ITEM_ROW_SELECTOR = '[class*="form-item"],[class*="formItem"],[class*="form-row"],[class*="formRow"],[class*="form-group"],[class*="formGroup"]';

const SECTION_HINTS = [
  { re: /(教育|学历|学校|院校|专业|graduate|education|academic|school)/i, key: 'education' },
  { re: /(实习|intern)/i, key: 'internship' },
  // 裸 'work' 不能算工作经历：SF 的合规块标题是 "Work Authorization"（工作许可），
  // 按 'work' 命中就会拿到 hint=work + 区块序号 0，于是「是否需要签证担保」被章节惩罚 ×0.75、
  // 槽位惩罚 ×0.8，从 0.84 掉到 0.50 而整栏变成"我们没有这个词"。
  { re: /(工作|任职|职业|经验|experience|employment|career|work\b(?![\s（]*(?:authorization|authorisation|permit|visa|status|permissible|mode|day|place)))/i, key: 'work' },
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

/** 一段文本命中的章节关键词。命中 0 个或 ≥2 个都不作数：
 *  步骤导航/页头常常一句里写全"基本信息 教育经历 工作经历"，
 *  拿它当章节证据会让全站 hint 变成第一个匹配到的那种，把多段经历的 itemIndex 全体排错。 */
function hintOfText(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 24) return '';
  const hits = SECTION_HINTS.filter(h => h.re.test(t));
  return hits.length === 1 ? hits[0].key : '';
}

function sectionHintFor(el) {
  let node = el;
  for (let i = 0; i < 8 && node; i++) {
    const own = headingBefore(node, el) || prevSiblingHeading(node);
    const byHeading = hintOfText(own);
    if (byHeading) return byHeading;
    const byClass = hintOfText(String(node.className || '').replace(/[._-]+/g, ' '));
    if (byClass) return byClass;
    node = node.parentElement;
  }
  return '';
}

const TRAILING_NOISE = /(必填|选填|限\d+字|\(\d+\/\d+\)|\bmax\b|字符|字$|please\s*enter|例如)/i;

/**
 * 皮肤可见性：AntD / Element 的 radio、checkbox 真身是
 * `label > span.ant-radio > input.ant-radio-input(opacity:0)`，看得见的方框只是一层装饰 span。
 * 按"input 自己不可见就丢掉"一刀切，途普那张页面 33 个 radio/checkbox 全灭 ——
 * 用户看到的就是"这一页一个选项都填不上"。
 * 只在这种皮肤结构上放行，并要求皮肤本身真的有尺寸（整块被折叠/隐藏时 rect 是 0，照样排除）。
 */
/** 布局能不能用：jsdom 里所有 getBoundingClientRect 都是 0×0，那不代表"看不见"，
 *  只代表这个环境没有排版。真浏览器里 body 一定有尺寸，于是尺寸判据照旧生效。 */
function layoutAvailable(doc) {
  const b = doc && doc.body;
  if (!b || typeof b.getBoundingClientRect !== 'function') return false;
  const r = b.getBoundingClientRect();
  return Boolean(r && (r.width > 0 || r.height > 0));
}

function skinVisible(el, doc) {
  const t = String(el.type || '').toLowerCase();
  if (t !== 'radio' && t !== 'checkbox') return false;
  // 皮肤层从**父级**开始找：input 自己的类名就带 radio/checkbox（AntD 的 .ant-radio-input），
  // 用 el.closest() 会第一时间命中它自己，于是"要求皮肤可见"变成"要求那个 opacity:0 的
  // input 可见" —— 恒假，整组控件照样被丢掉。
  const wrap = (el.parentElement && el.parentElement.closest?.('label,[class*="radio"],[class*="checkbox"],[role="radio"],[role="checkbox"]'))
    || el.closest?.('label');
  if (!wrap) return false;
  const style = (wrap.ownerDocument || doc).defaultView?.getComputedStyle(wrap);
  if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
  if (!layoutAvailable(wrap.ownerDocument || doc)) return true;
  const rect = typeof wrap.getBoundingClientRect === 'function' ? wrap.getBoundingClientRect() : null;
  return Boolean(rect && (rect.width > 0 || rect.height > 0));
}

/**
 * 一个 radio/checkbox 的"可见文案"。
 * 老写法只有 `nextElementSibling || parentElement`：原生裸控件够用，但皮肤结构里
 * input 的下一个兄弟什么都没有、父级又是那层空的装饰 span，取回来是空串 ——
 * 于是字段"选项全是空的"，一个都选不上（用户 2026-10-01 报的就是这个）。
 *
 * 顺序有坑，两条都不能错：
 *  - `<label><input>阅读</label>` 这种最常见：文字是 label 里的**文本节点**，
 *    input 没有元素兄弟；此时"父级的下一个兄弟"是**隔壁选项**（'跑步'），
 *    先取它就等于把别人的标签安在这个框上 —— 会勾错并且回读还是绿的。
 *  - `label > span.ant-radio > input` + `span` 这种皮肤：文字在父级 span **之后**，
 *    而父级自己的文本是空的，所以必须在"父级文本为空"时才走这一步。
 */
export function optionTextOf(box) {
  if (!box) return '';
  const pick = n => clean(String((n && (n.textContent ?? '')) || ''));
  const own = pick(box.nextElementSibling);
  if (own) return own.slice(0, 40);
  const parent = box.parentElement;
  const parentText = pick(parent);
  const parentIsOption = !!parent && (parent.tagName === 'LABEL' || parent.matches?.('[class*="radio"],[class*="checkbox"],[class*="option"],[class*="item"]'));
  if (parentIsOption && parentText) return parentText.slice(0, 40);
  const after = pick(parent && parent.nextElementSibling);
  if (after) return after.slice(0, 40);
  if (parentText) return parentText.slice(0, 40);
  const wrap = box.closest?.('label');   // 只认 <label>：input 自己的类名也带 radio，别用它当兜底
  const inWrap = pick(wrap);
  if (inWrap) return inWrap.slice(0, 40);
  return clean(box.getAttribute('aria-label') || box.getAttribute('title') || box.value || '');
}

function visible(el, doc) {
  if (!el) return false;
  if (el.disabled) return false;
  const style = (el.ownerDocument || doc).defaultView?.getComputedStyle(el);
  if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
    if (style.opacity === '0' && skinVisible(el, doc)) { el.__nwSkinned = true; return true; }
    return false;
  }
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
 *
 * 导出给 dom/probe.js：探针必须报告"填充路径实际看到的标签"，
 * 否则我在导出里读到的失败可能是探针自己的简化实现，而不是用户界面上的真问题。
 */
export function labelFor(el, doc) {
  const cands = [];
  const push = (node, source, depth) => {
    if (!node) return;
    if (node.nodeType === 3) {
      const txt = clean(node.nodeValue);
      if (txt) cands.push({ text: txt, raw: normRaw(node.nodeValue), source, depth: depth || 0 });
      return;
    }
    // 注释不是标签。真实页面会留模板注释（SF/CMS 的 <!-- ... -->、构建工具的水印），
    // 而 Comment.textContent 就是注释正文——它曾经把一整句中文注释当成"期望行业"的标签。
    if (node.nodeType === 8) return;
    // 含表单控件的兄弟节点是"上一个字段"，不是这个字段的标签
    if (node.querySelector && node.querySelector(CONTROL_SELECTOR)) return;
    if (node.contains && node.contains(el) && node !== el) return;
    const txt = textOf(node);
    if (txt) cands.push({ text: txt, raw: normRaw(node.textContent), source, depth: depth || 0, heading: isBlockTitle(node) });
  };

  // for / aria-labelledby 是"同一棵 DOM 树内"的引用：open shadow 表单里用外层 document 查永远查不到，
  // 结果整片字段被判成 no_candidate（SF 与多家自研页都有 shadow host）
  const tree = el.getRootNode?.() || doc;
  const id = el.getAttribute('id');
  if (id) { try { push(tree.querySelector(`label[for="${CSS_escape(id)}"]`), 'label-for', 0); } catch { /* 非法 id 或该树不支持 */ } }
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const parts = labelledby.split(/\s+/).map(x => tree.getElementById ? tree.getElementById(x) : null).filter(Boolean);
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
      if (sib.nodeType === 1 && (sib.querySelector?.(CONTROL_SELECTOR) || isFieldShell(sib))) break;
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
      // 同 prev-sibling：自定义下拉的显示区不是标签，两条路径要用同一条判据
      if ((k.querySelector && k.querySelector(CONTROL_SELECTOR)) || isFieldShell(k)) continue;
      const txt = textOf(k);
      if (txt && txt.length <= 24) cands.push({ text: txt, raw: normRaw(k.textContent), source: 'container-text', depth: hops + 2, heading: isBlockTitle(k) });
    }
    if (kids.length && kids[0] === node && hops >= 2) break;
    node = holder;
  }

  // 栅格条目（AntD 的 ant-col 布局）会把"标签那一列"排在"控件那一列"之后，
  // 而且控件外面常套一串单子元素（picker > children > control > wrapper），
  // 主循环里"单子链就走够了"的优化会提前收手，所以这里单独沿祖先找 form-item 级容器，
  // 只取它"不含控件的直接子分支"里的 label/title 节点。判据窄是刻意的：
  // 越过条目边界去前面捞文本，代价是把隔壁字段的标签当成自己的（宁可没有也不假绿）。
  //
  // 深度上限要放宽：国聘(iguopin) 真实导出里"学校名称/专业名称"这类是**条目套条目**——
  // 外层 ant-form-item 带 label 列，内层再套一层 ant-form-item 只放控件，
  // 标签到控件隔了 9~13 层祖先，7 层根本够不着（chain 记满 7 层还没到顶）。
  // 但"最近的那个条目说了算"：一旦某个条目里找到了合格分支就停，不再往上够第二个。
  for (let n = el.parentElement, up = 0; n && up < 16; n = n.parentElement, up++) {
    if (n.tagName === 'FORM' || n.tagName === 'BODY' || n.tagName === 'HTML') break;
    if (!n.matches?.(ITEM_ROW_SELECTOR)) continue;
    let hit = false;
    const branches = Array.from(n.children || []);
    // 只有"标签列 + 控件列"这种两列条目才允许把旁支本身当标签：三列以上更可能是卡片布局，
    // 那里第一个不含控件的分支往往是说明文字而不是这一栏的名字。
    const twoCol = branches.length === 2;
    for (const k of branches) {
      if (!k || (k.contains && k.contains(el))) continue;
      if (k.querySelector && k.querySelector(CONTROL_SELECTOR)) continue;
      if (isFieldShell(k)) continue;
      const lab = k.querySelector(':scope > label, :scope > [class*="label"], :scope > [class*="title"], :scope > dt, :scope > th');
      if (lab) { push(lab, 'item-label', up + 3); hit = true; continue; }
      // 途普这类自研页把标签写成 <span class="field-label">…</span> 本身，里面不再套 <label>，
      // 只认嵌套 label 的旧规则对这种形状整片失效。
      const own = String(k.className || '');
      const t = textOf(k);
      if (twoCol && t && t.length <= 24 && /label|title|caption|name|question|field-/i.test(own)) {
        push(k, 'item-text', up + 4); hit = true;
      }
    }
    if (hit) break;
  }

  // 自研门户会把每个字段单独套一层 <form>，标签写在 form **外面**的那一行壳子里。
  // 真实导出（careersite.tupu360.com/accentureats）的对照很干脆：
  // 同一页里 input 的 chain 顶到 div.field-group 并在 form 内部就拿到 prev 标签，
  // 而 div[role=combobox] 的 chain 只到 span.field-value 就没词了 —— 标签在 form 的上一层。
  // 上面那条循环"遇到 FORM 就 break"是为了不抓页面大标题，代价就是这类页整片判成无标签。
  // 折中：只往上够**两层**（form 的父元素、再上面一行），且只收"不含控件、不是字段壳子、
  // 文本 ≤24 字、不是块级标题"的旁支。真实导出没告诉我们标签落在 .field-value 还是 .field-group，
  // 所以两层都要看；再往上就必然开始捞到页面标题，那就不是找标签而是猜标签了。
  const formEl = el.closest?.('form');
  for (let row = formEl && formEl.parentElement, lvl = 0; row && lvl < 2; row = row.parentElement, lvl++) {
    for (const k of Array.from(row.children || [])) {
      if (!k || (k.contains && k.contains(el))) continue;
      if (k.querySelector && k.querySelector(CONTROL_SELECTOR)) continue;
      if (isFieldShell(k)) continue;
      const t = textOf(k);
      if (t && t.length <= 24 && !isBlockTitle(k)) cands.push({ text: t, raw: normRaw(k.textContent), source: 'outside-form', depth: 8 + lvl });
    }
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
  // 注意是 \s+：写成 /s+/g 匹配的是字母 s，会把 "Security Check" 拆成 "Bu ine"（曾污染安全判定读的 labelRaw）
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * 这个元素是不是"另一个字段的壳子"？
 * 自定义下拉常常只渲染出一段显示文本（`.ant-select-selection-item` 里写着"中国大陆"、
 * `.el-select__placeholder` 里写着"请选择"），里面没有任何 input —— 所以
 * "兄弟里有没有控件"这条判据抓不住它。北京银行(zhiye) 实测：手机国际区号那个下拉的显示区
 * 被当成了手机号字段的标签，导出里该栏 label 就成了"中国大陆"。
 */
function isFieldShell(n) {
  if (!n || n.nodeType !== 1) return false;
  try {
    if (n.matches?.(SELECT_TRIGGER_SELECTOR) || n.querySelector?.(SELECT_TRIGGER_SELECTOR)) return true;
    if (n.getAttribute?.('aria-haspopup')) return true;
    if (n.querySelector?.('.ant-select-selection-item,.ant-select-selection-placeholder,.ant-picker-input,.el-select__wrapper,.el-cascader,.next-select')) return true;
    const c = String(n.className || '');
    return /(^|\s|-)(select|picker|cascader|dropdown|combobox|date-picker)/i.test(c) && !/label|title|caption/i.test(c);
  } catch { return false; }
}

  function nearbyLabels(el, doc) {
  const out = [];
  const legend = el.closest?.('fieldset')?.querySelector?.('legend');
  if (legend) out.push(textOf(legend));
  // 不再按 data-nw-group 找组：那个属性我们从不写入，读它就等于让页面自己声明"这组字段属于谁"
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

/** 容器里是不是只有"年/月"这类日期拆分框（自…至…这种时间行） */
function isDatePartShell(c) {
  const ctl = Array.from(c.querySelectorAll?.(CONTROL_SELECTOR) || []);
  if (ctl.length < 2) return false;
  return ctl.every(x => {
    const t = normRaw(x.getAttribute('placeholder') || x.getAttribute('aria-label') || '');
    return /^(year|年|yyyy|month|月|mm)$/i.test(t);
  });
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
    // 只由年/月框组成的容器是一行"时间段"，不是两条重复经历。给它编号的话，
    // Workday 的「自」会被当成第 0 段、「至」当成第 1 段，一个时间段被拆到两段经历上。
    if (isDatePartShell(c)) continue;
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
        options: groupEls.map(x => ({ text: optionTextOf(x), value: x.value })),
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
        skinned: Boolean(el.__nwSkinned),
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
      skinned: Boolean(el.__nwSkinned),
      el,
    });
  }
  const out = fields.filter(f => f.label || f.name || f.id || f.placeholder || f.testId || f.autocomplete);
  // 结构化判据：是不是"自定义下拉的内层控件"。靠 placeholder 文案（"请选择"）猜不可靠 ——
  // AntD 搜索型的占位符是"搜索城市"，Element 的内层 input 还带 readonly
  // （会被"站点只读框"规则误吞）。wrapper 在不在 SELECT_TRIGGER_SELECTOR 里才是事实。
  for (const f of out) {
    if (f.kind !== 'select' && f.el?.closest?.(SELECT_TRIGGER_SELECTOR)) f.customSelect = true;
  }
  renumberItemIndexBySection(out, blockIndex);
  markCompositeDatePairs(out);
  markRecordOccurrences(out);
  return out;
}

/**
 * 用"同名标签第几次出现"推断这是第几条记录。
 *
 * Moka 把每条经历摊平成若干个"一行一个控件"的 .mk-item，没有小节标题也没有卡片包裹，
 * detectRepeatedBlocks 什么都找不到（每个容器只有 1 个控件），于是同块的 公司名称 / 职位名称 /
 * 起止时间 各自去抢 profile 列，最后可能给出"A 公司的职位名称写进 B 公司那一栏"——
 * 每个字段单独回读都是绿的，事后根本看不出来（Klook 实测：公司名称@11、@21 两次）。
 *
 * 做法：把"同一容器里的年/月对"折成一个单位（起止时间是同一条记录的开始与结束，不算两次出现），
 * 然后按标签记出现次数，第 k 次出现 ⇒ 该章节的第 k 条记录。
 * 只给"完全没有 DOM 区块序号"的字段补这个推断值，且 itemIndexSource 标成 'occurrence'：
 * 它只是"第几条"的证据，不是"哪段经历"的证据（work 还是 internship 仍然不知道），
 * 匹配器据此拒绝给绿字。
 */
function markRecordOccurrences(fields) {
  // 自定义下拉/附件框不参与计数：Sea 的 "Contact Number *" 是一个 div[role=combobox] 加一个真空输入框
  // 共用同一条 aria-labelledby，两个单位都算一次出现的话，真空输入框就成了"第 2 次出现"，
  // 于是它去抢 family.1.phone（实测）。这些控件本来也永远不会被填。
  const countable = f => f.kind !== 'combobox' && f.kind !== 'listbox' && f.kind !== 'file';
  const hostUnit = new Map();          // 容器元素 -> units 下标（一个容器里的多个年月对算一个单位）
  const units = [];
  for (const f of fields) {
    const label = normText(f.label);
    if (!label || !countable(f)) continue;
    if (f.datePair) {
      const host = f.el?.parentElement;
      if (host && hostUnit.has(host)) { hostUnit.get(host).members.push(f); continue; }
      const u = { label, members: [f] };
      if (host) hostUnit.set(host, u);
      units.push(u);
      continue;
    }
    units.push({ label, members: [f] });
  }
  const totals = new Map();
  for (const u of units) totals.set(u.label, (totals.get(u.label) || 0) + 1);
  // 只给"确实重复出现的标签"编号：一次性字段（学校/专业/姓名）本来就没有"第几条"可言，
  // 给它们编 0 反而是无中生有（老式 fieldset 布局里三个不同章节的字段名互不重复，
  // 一旦被编号就会把硕士槽位漂到本科槽位 —— scanner 回归里钉着这条）。
  const seen = new Map();
  for (const u of units) {
    const k = seen.get(u.label) || 0;
    seen.set(u.label, k + 1);
    if ((totals.get(u.label) || 0) < 2) continue;
    for (const f of u.members) f.recordIndex = k;
  }
  for (const f of fields) {
    if (f.recordIndex == null || f.itemIndex != null) continue;
    f.itemIndex = f.recordIndex;
    f.itemIndexSource = 'occurrence';
  }
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
 * 把"年 + 月"成对输入框配成一个逻辑日期（Moka / Workday / 自建门户都这么实现）。
 *
 * 为什么配对必须发生在扫描阶段：单个框装不下一个完整日期，而两个框的标签常常一模一样
 * （Moka 的「起止时间」把 年/月/年/月 四个框塞在同一容器里，标签是同一句话）。
 * 若只打个 compositeDate 标记就交给匹配器，两个框会各自去抢 profile 的日期列，
 * 结果是年份框拿到月份值、或开始/结束对调 —— 所以这里直接给出组号与 start/end 角色，
 * 让匹配器把「一组」当成「一个问题」规划，落笔时再拆成两笔。
 */
const DATE_ROLE_START = /(start|begin|joining|\bfrom\b|入[职学]|开始|起始|起|自)/i;
const DATE_ROLE_END = /(end|\bto\b|until|leaving|expiry|离|结束|截止|止|至)/i;

function markCompositeDatePairs(fields) {
  const partOf = f => {
    if (f.kind !== 'text' && f.kind !== 'number') return null;
    const hay = [f.placeholder, f.label].map(normText);
    if (hay.some(t => /^(year|年|yyyy)$/i.test(t))) return 'year';
    if (hay.some(t => /^(month|月|mm)$/i.test(t))) return 'month';
    return null;
  };
  // 先打标：落了单的框（只有年没有月）也仍然是"日期的一部分"，
  // 不标就会被当成普通文本框，把整个日期写进年份框里。
  const bucketed = [];
  for (const [i, f] of fields.entries()) {
    const part = partOf(f);
    if (!part) continue;
    f.compositeDate = part;
    if (f.el?.parentElement) bucketed.push({ i, f, part });
  }
  // 分桶：同父容器 + 同标签，才认定是"同一句问题拆出来的几个框"
  const buckets = new Map();
  for (const b of bucketed) {
    const key = `${b.f.el.parentElement.tagName}.${b.f.el.parentElement.className}§${normText(b.f.label)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(b);
  }
  let seq = 0;
  for (const bucket of buckets.values()) {
    const years = bucket.filter(b => b.part === 'year');
    const months = bucket.filter(b => b.part === 'month');
    const n = Math.min(years.length, months.length);
    if (!n) continue;
    const labelText = normText(bucket[0].f.label);
    // 标签自己说清了是起还是止（Workday 的「自」/「至」），多组也不含糊；
    // 只说「起止时间」的（Moka）按文档顺序排：第一组是起，第二组是止 —— 顺序是推断出来的，
    // 所以 roleSource 记 'order'，让匹配器降级为待复核。
    const roleFromLabel = !labelText ? null
      : DATE_ROLE_START.test(labelText) && !DATE_ROLE_END.test(labelText) ? 'start'
      : DATE_ROLE_END.test(labelText) && !DATE_ROLE_START.test(labelText) ? 'end' : null;
    for (let k = 0; k < n; k++) {
      const id = `dp${seq++}`;
      const role = roleFromLabel || (years.length > 1 ? (k === 0 ? 'start' : 'end') : null);
      const roleSource = roleFromLabel ? 'label' : (role ? 'order' : null);
      for (const [b, part] of [[years[k], 'year'], [months[k], 'month']]) {
        b.f.datePair = { id, part, role, roleSource, ordinal: k, size: years.length };
      }
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
