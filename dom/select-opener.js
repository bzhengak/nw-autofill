// 自定义下拉（Element UI / Ant Design / role=combobox 的 div 控件）的点开与选中。
//
// 为什么必须点：这类控件没有 <select>，选项是点击后由框架渲染到 body 末端的弹层里。
// 往那个输入框打字不会选中任何值 —— 以前我们在计划阶段就整栏拒掉（custom_control），
// 于是 9 份判分表单里 27 栏只能人工手点。用户 2026-09-29 批准了"可以点开下拉框"，
// 这个模块就是把它收紧在"只做选择这一件事"的范围内。
//
// 硬边界（不因为授权就放宽）：
//  - 只点 dom/safety.js 的 classifyClick 允许的元素：选项(role=option/menuitem)与
//    选择控件触发器(role=combobox / aria-haspopup)。提交、导航、附件、其它按钮一律不点，
//    点击一律走 guardedClick。
//  - 选中后必须回读校验：显示出来的文本要等于我们要的值，否则算失败（不许"点了就当成功"）。
//  - 匹配复用 negationMismatch：'全日制' 绝不能选中 '非全日制'。这类错在页面上不会报错，
//    站点会安静地把错答案交上去，是最坏的失败模式。
//  - 找不到弹层/选项就原样收起并交人工，绝不"猜一个第一项"。

import { normalize, core, negationMismatch } from '../core/matching.js';
import { guardedClick, classifyClick, SELECT_TRIGGER_SELECTOR, SELECT_WRAPPER_SELECTOR } from './safety.js';

/** 显示值与目标是否等价：全等/主干相等/单向包含（包含要求目标不太短，避免"男"命中"男性未婚"） */
function shownMatches(shown, want) {
  const a = normalize(shown), b = normalize(want);
  if (!a || !b) return false;
  if (a === b || core(a) === core(b)) return true;
  return (a.includes(b) || b.includes(a)) && b.length >= 2;
}

/** 框架签名 → 弹层与选项选择器。顺序有意义：先具体（框架类名）后通用（ARIA）。 */
const LIBRARY_SIGNATURES = [
  { name: 'element-ui', trigger: '.el-select, .el-cascader', option: '.el-select-dropdown__item', panel: '.el-select-dropdown, .el-popper' },
  { name: 'antd', trigger: '.ant-select', option: '.ant-select-item-option', panel: '.ant-select-dropdown' },
  { name: 'next-fusion', trigger: '.next-select', option: '.next-menu-item', panel: '.next-select-popup' },
  { name: 'aria', trigger: SELECT_TRIGGER_SELECTOR, option: '[role="option"], [role="menuitem"]', panel: '[role="listbox"], [role="menu"]' },
];

/** 页面在用什么下拉实现：按 DOM 签名猜，不看站点域名 */
export function detectSelectLibraries(doc) {
  const found = [];
  for (const sig of LIBRARY_SIGNATURES) {
    const hits = doc.querySelectorAll?.(sig.trigger);
    if (hits.length) found.push({ ...sig, count: hits.length });
  }
  return found;
}

/**
 * 一个控件对应的"可点击触发器"。必须优先取框架外层壳：
 * AntD 把 role=combobox 挂在内层搜索 input 上，事件监听与选中后的显示区都在 .ant-select 那一层，
 * 直接用 closest(触发器选择器) 会停在那个 input 上 —— 于是点开没反应、回读读到搜索框残字。
 */
function triggerFor(el) {
  return el.closest?.(SELECT_WRAPPER_SELECTOR) || el.closest?.(SELECT_TRIGGER_SELECTOR) || el;
}

function visible(el) {
  // jsdom 没有布局：零尺寸只在我们自己标注过时才当不可见，真实浏览器按 offsetParent/rect 判
  if (!el || el.__nwZeroSize) return false;
  // AntD 收起弹层是加 .ant-select-dropdown-hidden 类，Element 用 aria-hidden / display:none。
  // 这些容器**一直留在 DOM 里**：不认这几个标记，就会在下一个下拉打开时点到上一个的残留选项。
  const cls = String(el.className || '');
  if (/-hidden\b|is-hidden/.test(cls)) return false;
  if (el.getAttribute?.('aria-hidden') === 'true') return false;
  const style = el.style;
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  const doc = el.ownerDocument;
  if (doc?.defaultView?.getComputedStyle && el.isConnected) {
    const st = doc.defaultView.getComputedStyle(el);
    if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
  }
  if (typeof el.offsetParent === 'undefined') return el.isConnected;
  return el.offsetParent !== null || el.getClientRects?.().length > 0 || el.isConnected;
}

/**
 * 展开一次下拉。事件要打在**最内层可交互元素**上（真实用户的点击就是这么冒泡到壳子的）：
 * AntD 的监听挂在 .ant-select-selector，事件直接发给外层壳根本不会往下传。
 * 但"能不能点"由外层壳决定 —— 只有被认成选择控件的壳子里部才允许落点击，
 * 别的元素（按钮、链接、页面上任何东西）一律不点。
 */
function clickTargetOf(el) {
  const wrapper = triggerFor(el);
  const target = el && wrapper !== el && wrapper.contains?.(el) ? el : wrapper;
  const verdict = classifyClick(wrapper);
  return { wrapper, target, allowed: verdict.allowed, reason: verdict.reason };
}

/** 当前"看得见"的弹层容器 */
function visiblePanels(doc, sig) {
  return Array.from(doc.querySelectorAll?.(sig.panel) || []).filter(visible);
}

/**
 * 点开触发器，返回**属于这个控件的**选项节点。
 * 展开动作要发一串事件：Element/AntD 听 mousedown（不是 click）才弹，
 * 且都要求事件冒泡；只 click 一个 <span> 在部分实现里不会开。
 *
 * 为什么必须先快照再取差集：弹层是挂在 body 末端的，页面上有 N 个下拉就有 N 个容器，
 * 而且上一个失败后它仍然开着。不做差集，"现居城市"会把"意向城市"那 10 个选项一起收进来，
 * '南京' 出现两次 → 判成歧义 → 整栏交人工（实测踩过，还是被 mustNotTouch 兜住才发现）。
 */
export function openOptions(el, doc) {
  const { wrapper, target, allowed, reason } = clickTargetOf(el);
  if (!allowed) return { ok: false, reason, trigger: wrapper, options: [] };
  const sig = pickSignature(wrapper, doc);
  const before = new Set(visiblePanels(doc, sig));
  const win = doc.defaultView;
  const fire = (type, Ctor) => {
    try {
      target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: win }));
    } catch { /* 老环境没有构造器，忽略 */ }
  };
  target.focus?.();
  fire('mousedown', win.MouseEvent);
  fire('mouseup', win.MouseEvent);
  fire('pointerdown', win.PointerEvent || win.MouseEvent);
  fire('pointerup', win.PointerEvent || win.MouseEvent);
  guardedClick(wrapper, []);              // 触发壳上挂的 click 监听（部分实现只听 click）
  if (!classifyClick(wrapper).allowed) return { ok: false, reason: 'click_blocked', trigger: wrapper, options: [] };

  // 新出现的弹层 + 本来就存在但从 hidden 翻回可见的弹层（AntD 复用一个节点只切类名）
  const nowVisible = visiblePanels(doc, sig);
  const fresh = nowVisible.filter(p => !before.has(p));
  const mine = fresh.length ? fresh : nowVisible.filter(p => p.contains?.(wrapper) || wrapper.contains?.(p));
  const pools = mine.length ? mine : nowVisible;
  const options = collectOptions(doc, sig, pools);
  if (!options.length) return { ok: false, reason: 'no_options_rendered', trigger: wrapper, options: [] };
  return { ok: true, trigger: wrapper, options, signature: sig.name, panels: pools };
}

function pickSignature(trigger, doc) {
  const host = trigger.closest?.('.el-select,.ant-select,.next-select');
  const cls = String((host || trigger).className || '');
  if (/el-select/.test(cls)) return LIBRARY_SIGNATURES[0];
  if (/ant-select/.test(cls)) return LIBRARY_SIGNATURES[1];
  if (/next-select/.test(cls)) return LIBRARY_SIGNATURES[2];
  return LIBRARY_SIGNATURES[3];
}

/** 弹层里的选项：只取"看得见的"，且必须属于一个弹层容器（避免把页面其它 role=option 当目标） */
/** 弹层里的选项：只取被指定那几个容器内的（可见性已在容器层判过） */
function collectOptions(doc, sig, panels) {
  const pools = [];
  for (const p of panels || []) pools.push(...Array.from(p.querySelectorAll?.(sig.option) || []));
  // 有些实现不用框架类名的容器，选项直接是 role=option 挂在任意弹层里：退回全局扫描
  if (!pools.length) {
    for (const opt of doc.querySelectorAll?.('[role="option"],[role="menuitem"]') || []) {
      if (visible(opt)) pools.push(opt);
    }
  }
  const seen = new Set();
  return pools.filter(o => {
    if (!o || seen.has(o)) return false;
    seen.add(o);
    return visible(o) && String(o.textContent || '').trim().length > 0;
  });
}

const optionText = o => String(o.textContent || o.getAttribute?.('aria-label') || o.value || '').trim();

/**
 * 在选项里找目标值。分层：精确 → 去括号主干 → 包含；
 * 每一层都要过 negationMismatch，且"包含"层要求候选文本不比目标短一半（防止长句吞短句）。
 */
export function matchOption(options, want) {
  const target = normalize(want);
  if (!target) return null;
  const exact = options.find(o => normalize(optionText(o)) === target);
  if (exact) return exact;
  const trunk = core(target);
  const byCore = options.find(o => core(normalize(optionText(o))) === trunk && trunk.length >= 2);
  if (byCore) return byCore;
  const contains = options.filter(o => {
    const t = normalize(optionText(o));
    if (negationMismatch(optionText(o), want)) return false;
    return (t.includes(target) || target.includes(t)) && Math.min(t.length, target.length) >= Math.max(2, target.length * 0.5);
  });
  return contains.length === 1 ? contains[0] : null;   // 多个就说不清，交人工
}

/**
 * 完整一次选择：点开 → 匹配 → 点选项 → 回读校验。
 * 返回 { ok, reason, shown, expected } —— 调用方（filler）用 shown/expected 决定是否给绿字。
 */
export async function pickCustomSelect(field, want, { sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const doc = field.el.ownerDocument;
  const opened = openOptions(field.el, doc);
  if (!opened.ok) return { ok: false, reason: opened.reason, shown: '', expected: want };

  let opt = matchOption(opened.options, want);
  // 有些实现首屏只渲染前 N 项（虚拟列表）：等一帧后在**同一批容器**里再找一次，仍找不到就交人工
  if (!opt && opened.panels?.length) {
    await sleep(0);
    opt = matchOption(collectOptions(doc, { option: `[role="option"],[role="menuitem"],.el-select-dropdown__item,.ant-select-item-option,.next-menu-item` }, opened.panels.filter(visible)), want);
  }
  if (!opt) return { ok: false, reason: 'option_missing', shown: '', expected: want };

  const cls = classifyClick(opt);
  if (!cls.allowed) return { ok: false, reason: cls.reason, shown: '', expected: want };
  const fired = guardedClick(opt, []);
  if (!fired) return { ok: false, reason: 'click_blocked', shown: '', expected: want };
  await sleep(0);

  const shown = readShown(field.el, opt);
  const ok = shownMatches(shown, want) || normalize(shown) === normalize(optionText(opt));
  return { ok, reason: ok ? '' : 'value_rejected', shown, expected: want, options: opened.options.length };
}

/**
 * 选完之后"页面上显示的是什么"。顺序很关键：
 * 显示区 > aria-valuetext > wrapper 文本 > 输入框 value。
 * AntD 选中后把值写进 .ant-select-selection-item，而搜索框里留着过滤用的残字；
 * 先读 input.value 就会把"搜索城市"当成已选值报给用户（仿真页里埋了这个坑，实测踩过同类）。
 */
const PLACEHOLDERISH = /^(please\s+select|no\s+selection|请选择|选择|请输入|搜索)/i;
function readShown(el, opt) {
  const trigger = triggerFor(el);
  const text = n => String(n?.value ?? n?.textContent ?? '').trim();
  const displayArea = trigger.querySelector?.(
    '.ant-select-selection-item, .el-select__placeholder:not(.is-transparent), .el-cascader span, .next-select em, [class*="selection-item"]'
  );
  const input = trigger.querySelector?.('input,textarea');
  for (const c of [displayArea, el.getAttribute?.('aria-valuetext'), trigger.querySelector?.('[aria-valuetext]'),
    input?.getAttribute?.('aria-valuetext'), trigger, input]) {
    const s = typeof c === 'string' ? c.trim() : text(c);
    if (s && !PLACEHOLDERISH.test(s)) return s;
  }
  return '';
}

/** 供 filler 判断"这个控件值没落到 <select> 上，得走点开选中这条路" */
export function isCustomSelect(field) {
  if (!field) return false;
  if (field.customSelect) return true;              // 扫描器给的结构化判据（首选）
  if (field.kind === 'combobox' || field.kind === 'listbox') return true;
  const el = field.el;
  if (!el) return false;
  return Boolean(el.closest?.(SELECT_TRIGGER_SELECTOR))
    && field.kind !== 'select';
}
