// 只读页面结构探针：导出字段结构给适配器编写用。
// 纪律：不读 el.value / textarea 内容 / 用户输入文本。要新增读取项之前先想清楚是不是用户数据。
// 与 core/matching.js 一样是纯 DOM 函数，可在 jsdom 下单测。

import { core, normalize } from '../core/matching.js';
import { labelFor } from './scanner.js';

const CONTROL_SELECTOR = 'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="spinbutton"], [role="listbox"]';
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
// 导出物自带版本号：用户贴回来的 JSON 能直接证明"他浏览器里跑的是哪一版探针"，
// 不用再靠"你是不是重载了扩展"这种对话去猜。
const PROBE_BUILD = '2026-09-29-5';

function escapeId(id) {
  return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : String(id).replace(/([^\w-])/g, '\\$1');
}

function walkComposed(root, depth, via, out) {
  if (!root || depth > 20) return;
  const all = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
  for (const e of all) {
    if (e.__nwProbeSeen) continue;
    e.__nwProbeSeen = 1;
    const tag = e.tagName ? e.tagName.toLowerCase() : '';
    if (e.matches && e.matches(CONTROL_SELECTOR)) out.push({ e, via });
    if (e.shadowRoot) walkComposed(e.shadowRoot, depth + 1, `${via}>${tag}#shadow`, out);
  }
}

function labelOf(el, doc) {
  // 顺手记下"考虑过但没采纳"的候选：没有这行日志，"这个字段为什么拿到这个标签"
  // 在维护者这边永远是黑盒（tupu 那 25 个无标签字段就是例子）。
  const alts = [];
  const note = (t, v) => { if (t && alts.length < 6) alts.push(`${v}:${t.slice(0, 24)}`); };
  const out = rawLabelOf(el, doc, note);
  return { ...out, alts };
}

function rawLabelOf(el, doc, note) {
  const id = el.getAttribute('id');
  if (id) {
    try {
      const l = doc.querySelector(`label[for="${escapeId(id)}"]`);
      if (l && norm(l.textContent)) return { t: norm(l.textContent).slice(0, 40), v: 'for' };
    } catch { /* 非法选择器 */ }
  }
  const ab = el.getAttribute('aria-labelledby');
  if (ab) {
    const t = ab.split(/\s+/).map(x => { const n = doc.getElementById(x); return n ? norm(n.textContent) : ''; }).filter(Boolean).join(' ');
    if (t) return { t: t.slice(0, 40), v: 'labelledby' };
  }
  const al = el.getAttribute('aria-label');
  if (al) return { t: norm(al).slice(0, 40), v: 'aria' };
  const wrap = el.closest && el.closest('label');
  if (wrap && norm(wrap.textContent)) return { t: norm(wrap.textContent).slice(0, 40), v: 'wrapped' };

  let n = el.parentElement, hops = 0;
  const trace = [];
  while (n && hops < 6) {
    const lab = n.querySelector(':scope > label, :scope > [class*="label"], :scope > [class*="title"], :scope > dt, :scope > [class*="name"]');
    if (lab) {
      const t = norm(lab.textContent);
      if (t && t.length <= 40) { note(t, 'container'); return { t, v: 'container', trace }; }
      trace.push(`container-label 被拒（长度 ${t.length}）`);
    }
    let p = n.previousElementSibling, g = 0;
    while (p && g < 4) {
      const cls = norm(String(p.className || '')).slice(0, 40);
      const t = norm(p.textContent);
      // 兄弟里那个"自定义下拉的显示区"不是标签：北京银行实测把区号下拉的
      // "中国大陆"当成了手机号的标签。含控件或长得像选择壳子的，一律往前收手。
      if (p.querySelector('input,textarea,select')) { trace.push(`hop${hops} 停在含控件的 .${p.tagName.toLowerCase()}.${cls}`); break; }
      if (/(^|\s|-)(select|picker|cascader|dropdown|combobox)/i.test(cls)) { trace.push(`hop${hops} 停在字段壳子 .${cls}`); break; }
      if (t && t.length <= 24) { note(t, 'prev'); return { t, v: 'prev', trace }; }
      if (t) trace.push(`hop${hops} 跳过 .${p.tagName.toLowerCase()}.${cls}（文本 ${t.length} 字）`);
      p = p.previousElementSibling; g++;
    }
    if (!p && hops >= 3) trace.push(`hop${hops} 到头没有可用兄弟`);
    n = n.parentElement; hops++;
  }
  const ph = norm(el.getAttribute('placeholder'));
  if (ph) { note(ph, 'placeholder'); return { t: ph.slice(0, 40), v: 'placeholder', trace }; }
  return { t: '', v: '', trace };
}

/**
 * 无标签字段的结构素描：把最近一层的"表单条目"容器克隆下来，只保留
 * 标签名 + 少数结构性属性，长文本一律换成字数。
 * 为什么需要它：tupu 真实导出里 chain 只记祖先、且截到 5 层，
 * "标签到底在 DOM 哪儿"（在控件之前还是之后、隔几层）看不出来，
 * 于是修一次就要用户重导一次。素描能把这个问题一次性说清。
 * 隐私：不复制 value；文本超过 12 字（大概是要填/已填的内容）只留字数；
 *      脚本样式整个删掉；每条上限 600 字。
 */
const SKETCH_KEEP = new Set(['class', 'type', 'role', 'placeholder', 'id', 'name', 'for', 'aria-label', 'data-nw-here']);
function structureSketch(el) {
  // 取"最外面那一层的条目容器"，不是 closest() 的第一个命中：
  // AntD 里 .ant-form-item-children 也带 form-item 字样，用 closest() 素描出来的
  // 那一小块只有控件本身，标签在容器之外，等于什么都没记。
  const ROWISH = '[class*="form-item"],[class*="form-row"],[class*="formRow"],[class*="field"],[class*="form-group"],li,tr,dd,dt';
  let host = null;
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (n.tagName === 'FORM' || n.tagName === 'BODY') break;
    if (n.matches?.(ROWISH) && (n.querySelectorAll('*').length || 0) <= 40) host = n;
  }
  host = host || el.closest(ROWISH) || el.parentElement?.parentElement || el.parentElement;
  if (!host) return undefined;
  // 先把"这个控件自己在容器里的位置"记下来（克隆之后就找不到了），
  // 然后把控件本体换成一个标记：省下的字数正好用来把容器里"标签那一支"完整带出来。
  const path = [];
  for (let n = el; n && n !== host; n = n.parentElement) {
    const kids = n.parentElement ? Array.from(n.parentElement.children) : [];
    path.unshift(kids.indexOf(n));
  }
  let clone;
  try { clone = host.cloneNode(true); } catch { return undefined; }
  let at = clone;
  for (const i of path) { at = at && at.children && at.children[i]; }
  if (at && at !== clone) {
    at.textContent = '';
    at.setAttribute('data-nw-here', at.tagName.toLowerCase());
  }
  const nodes = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (const n of nodes) {
    if (n.nodeType !== 1) continue;
    const tag = n.tagName.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'IMG') { n.remove(); continue; }
    for (const a of Array.from(n.attributes || [])) if (!SKETCH_KEEP.has(a.name)) n.removeAttribute(a.name);
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { try { n.value = ''; } catch { /* 忽略 */ } }
  }
  const texts = [];
  const collect = node => { for (const c of node.childNodes || []) { if (c.nodeType === 3) texts.push(c); else if (c.nodeType === 1) collect(c); } };
  collect(clone);
  for (const t of texts) { const s = norm(t.nodeValue); t.nodeValue = s.length > 12 ? ` [${s.length}字] ` : (s ? ` ${s} ` : ''); }
  return norm(clone.outerHTML).slice(0, 600);
}

function componentLibs(doc) {
  // SuccessFactors 这类页面有 40+ 张样式表、上百个 JS，全量拼字符串会拖到超时

  // （太古、汇丰两页导出失败最可能的原因）。这里做硬性上限，并在结果里如实标 partial。
  let css = '';
  let sheets = 0;
  let truncated = false;
  for (const s of doc.styleSheets || []) {
    if (sheets++ >= 12) { truncated = true; break; }
    try {
      for (const r of s.cssRules || []) {
        css += r.cssText || '';
        if (css.length > 4_000_000) { truncated = true; break; }
      }
    } catch { /* 跨域样式表读不到 */ }
    if (css.length > 4_000_000) break;
  }
  for (const st of doc.querySelectorAll('style')) {
    css += st.textContent || '';
    if (css.length > 4_000_000) { truncated = true; break; }
  }
  const cnt = re => (css.match(re) || []).length;
  return {
    counts: {
      ant: cnt(/\.ant-[a-z-]+/g), element: cnt(/\.el-[a-z-]+/g), vant: cnt(/\.van-[a-z-]+/g),
      arco: cnt(/\.arco-[a-z-]+/g), rc: cnt(/\.rc-[a-z-]+/g), formily: cnt(/formily/gi), mui: cnt(/\.Mui[A-Za-z]+/g),
      naive: cnt(/\.n-[a-z]+-[a-z]/g),
    },
    scannedSheets: sheets,
    cssSampled: css.length,
    truncated,
  };
}

/**
 * 可见性判断以 computed style 为主：jsdom 等无布局环境里 rect 恒为 0，
 * 只靠 rect 会把所有字段误判为不可见；真实浏览器里父级 display:none 会传导到子元素计算样式。
 */
function visible(el) {
  const doc = el.ownerDocument;
  const st = doc?.defaultView?.getComputedStyle ? doc.defaultView.getComputedStyle(el) : null;
  if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) return false;
  if (el.type === 'hidden') return false;
  if (el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length)) return true;
  return !!(st && st.display && st.display !== 'none');
}

/**
 * @param {Document} doc
 * @param {string} locationHref
 * @param {Window} win
 */
export function probePageStructure(doc, locationHref = '', win = doc.defaultView) {
  const found = [];
  walkComposed(doc, 0, '', found);

  // 结构素描比字段清单大得多，一页最多给 10 条：够看清"标签到底在哪"，又不会把导出撑爆。
  let sketchBudget = 10;
  const fields = found.map(({ e, via }) => {
    const L = labelOf(e, doc);
    const tag = e.tagName.toLowerCase();
    const w = e.closest('[class*="form-item"],[class*="formily"],[class*="field"],[class*="formRow"],[class*="form-row"],[class*="item"]');
    const wrapCls = w ? String(w.className).slice(0, 80) : '';
    // 祖先类名链 + 被否掉的候选标签：缺了这两样，"这个字段为什么没标签"只能靠猜。
    // 都是站点自己的 DOM 元数据，不含用户填的任何内容。
    const chain = [];
    for (let n = e.parentElement; n && chain.length < 7; n = n.parentElement) {
      const cls = norm(String(n.className || '')).slice(0, 60);
      if (cls) chain.push(`${n.tagName.toLowerCase()}.${cls}`);
    }
    // 素描给两类字段：① 缺标签的（找标签）；② 只读的日历/时间控件（找面板长什么样）。
    // 国聘一份导出里 12 栏是 readonly 的日期框，要不要、能不能替用户点开面板，得先看 DOM 证据；
    // 判据与 core/matcher.js 的 date_picker 保持一致：看 placeholder 与类名，不看标签字面。
    const phText = norm(e.getAttribute('placeholder') || '');
    const picker = /^(请选择|请选取|选择|pick|select)/i.test(phText)
      || /(picker|calendar|date-|_date|时间|日期)/i.test(`${norm(String(e.className || ''))} ${e.id || ''} ${e.name || ''}`);
    const wantSketch = !L.t || (e.readOnly === true && picker);
    const sketch = (wantSketch && sketchBudget > 0) ? structureSketch(e) : undefined;
    if (sketch) sketchBudget--;
    // 填充路径（scanner.labelFor）看到的标签，和探针自己的简化实现并列导出。
    // 没有这一列，"某字段没标签"到底是页面的问题还是探针抄漏了规则，分不开。
    let S = null;
    try { S = labelFor(e, doc); } catch { /* 探针不能因为取标签失败而整页失败 */ }
    const req = e.required === true || e.getAttribute('aria-required') === 'true' || /required|必填/.test(wrapCls);
    const opts = tag === 'select' ? Array.from(e.options).slice(0, 14).map(o => norm(o.textContent).slice(0, 24)) : null;
    return {
      tag,
      type: e.getAttribute('type') || undefined,
      name: e.getAttribute('name') || undefined,
      id: e.getAttribute('id') || undefined,
      role: e.getAttribute('role') || undefined,
      label: L.t || undefined,
      labelVia: L.v || undefined,
      labelAlts: (L.alts || []).slice(0, 3),
      labelTrace: (L.alts?.length || L.t) ? undefined : (L.trace || []).slice(0, 5),
      scanLabel: S?.text ? norm(S.text).slice(0, 40) : undefined,
      scanVia: S?.text ? (S.source || undefined) : undefined,
      sketch: sketch || undefined,
      chain: chain.length ? chain : undefined,
      ph: e.getAttribute('placeholder') || undefined,
      required: req || undefined,
      readonly: e.readOnly || undefined,
      disabled: e.disabled || undefined,
      accept: e.getAttribute('accept') || undefined,
      maxLength: e.maxLength > 0 && e.maxLength < 999 ? e.maxLength : undefined,
      hasPopup: e.getAttribute('aria-haspopup') || undefined,
      options: opts && opts.length ? opts : undefined,
      inShadowOrFrame: via || undefined,
      vis: visible(e),
    };
  });

  const libScan = componentLibs(doc);
  const libs = libScan.counts;
  let shadowHosts = 0;
  doc.querySelectorAll('*').forEach(e => { if (e.shadowRoot) shadowHosts++; });
  const ranked = Object.entries(libs).sort((a, b) => b[1] - a[1]);

  // 子框地图：导出取到 0 控件时，这份地图就是"表单藏在哪个框里"的证据。
  // 同源判定按 origin 比对（不能只靠"访问 contentDocument 会不会抛"——jsdom 不实施同源隔离，
  // 真浏览器会抛，两者行为不一致会让这里的诊断失真）。
  const here = (() => { try { return new URL(String(locationHref)).origin; } catch { return ''; } })();
  const iframeMap = Array.from(doc.querySelectorAll('iframe')).slice(0, 24).map(f => {
    const rawSrc = String(f.src || f.getAttribute('data-src') || '');
    let src = '';
    try { const u = new URL(rawSrc, locationHref); src = (u.origin + u.pathname).slice(0, 110); } catch { src = rawSrc.split('?')[0].slice(0, 110); }
    let sameOrigin = false, controls = null;
    try {
      const iwin = f.contentWindow;
      const idoc = f.contentDocument;
      const there = iwin && iwin.location ? iwin.location.origin : '';
      const childUrl = iwin && iwin.location ? String(iwin.location.href || '') : '';
      // about:blank / srcdoc 由父页派生，真浏览器里同源（jsdom 会把 origin 报成 'null'，所以按 URL 判）
      const isBlank = !childUrl || /^about:(blank|srcdoc)/.test(childUrl);
      sameOrigin = isBlank || Boolean(here && there && there === here);
      if (sameOrigin && idoc && idoc.querySelectorAll) {
        controls = idoc.querySelectorAll('input,textarea,select,[role="combobox"],[contenteditable="true"]').length;
      }
    } catch { /* 跨源访问会抛：这正是我们要报告的边界，不重试 */ }
    return { src, frameName: f.getAttribute('name') || undefined, sameOrigin, controls };
  });

  // 导出物会被用户复制/下载并发给维护者，所以它本身也是外发面：
  // 网申链接的 query 里常带 memberId / token / 内推码，title 里可能带候选人姓名 → 一律不带出去。
  const safe = (() => {
    try {
      const u = new URL(String(locationHref));
      const hash = String(u.hash || '').split(/[?&]/)[0].slice(0, 40);
      return { origin: u.origin, path: u.pathname, hash };
    } catch { return { origin: '', path: '', hash: '' }; }
  })();

  return {
    probeBuild: PROBE_BUILD,
    isTopFrame: (() => { try { return win ? win.top === win : true; } catch { return false; } })(),
    at: new Date().toISOString(),
    url: `${safe.origin}${safe.path}${safe.hash}`.slice(0, 120),
    origin: safe.origin,
    path: safe.path,
    hash: safe.hash,
    // 站点标题在候选人门户里常直接含姓名（'张伟 的简历'），不外发；只留长度做页面识别用
    titleChars: norm(doc.title).length,
    framework: {
      react: !!(win && (win.React || win.__REACT_DEVTOOLS_GLOBAL_HOOK__)),
      vue: !!(win && (win.Vue || win.__VUE__ || doc.querySelector('[data-v-]'))),
    },
    componentLibs: libs,
    cssScan: { scannedSheets: libScan.scannedSheets, sampledChars: libScan.cssSampled, truncated: libScan.truncated },
    topLibrary: (ranked[0]?.[1] || 0) > 20
      ? ranked[0][0] : 'none/自定义组件',
    totals: {
      controls: fields.length,
      visible: fields.filter(f => f.vis).length,
      selects: fields.filter(f => f.tag === 'select').length,
      radios: fields.filter(f => f.type === 'radio').length,
      checkboxes: fields.filter(f => f.type === 'checkbox').length,
      fileInputs: fields.filter(f => f.type === 'file').length,
      customWidgets: fields.filter(f => f.tag !== 'input' && f.tag !== 'textarea' && f.tag !== 'select').length,
      iframes: doc.querySelectorAll('iframe').length,
      shadowHosts,
    },
    sections: [...new Set([...doc.querySelectorAll('h1,h2,h3,h4,legend,caption,[class*="step"],[role="tab"]')]
      .map(e => norm(e.textContent)).filter(t => t && t.length <= 16))].slice(0, 24),
    iframeMap,
    // 扫到 0 个控件时，"为什么"必须自己说出来。多页向导（智联校园、SF 的分步简历）
    // 要先点『填写/继续填写』才渲染表单；这类情况以前只回一个空数组，
    // 用户以为是扩展坏了，其实是这一页还没到表单那一步。
    emptyHints: (() => {
      const gate = /(填写|继续|下一步|去完善|开始|编辑|添加|上传|next|continue|edit|fill|get started)/i;
      const clickables = [...doc.querySelectorAll('button, [role="button"], a[href], .btn, [class*="button"]')]
        .map(b => norm(b.textContent).slice(0, 20))
        .filter(t => t && t.length <= 20 && gate.test(t));
      const customHosts = [...doc.querySelectorAll('*')].filter(e => e.tagName.includes('-') && !e.shadowRoot).length;
      return {
        gateButtons: [...new Set(clickables)].slice(0, 8),
        customElementHosts: customHosts,
        readyState: doc.readyState,
        bodyChildren: doc.body ? doc.body.children.length : 0,
        loginWall: /登录|请先登录|sign in|log in/i.test(norm(doc.title + ' ' + (doc.body ? doc.body.textContent.slice(0, 400) : ''))),
      };
    })(),
    fields: fields.filter(f => f.vis).slice(0, 200),
    note: '本输出不含任何已填写内容，只有字段结构与站点自带候选项文案。',
  };
}

/** 精简版：只给适配器编写真正需要的信息，便于直接贴给我 */
export function summarizeProbe(p) {
  const pick = f => ({ label: f.label, via: f.labelVia, tag: f.tag, type: f.type, name: f.name, role: f.role, ph: f.ph, req: f.required, ro: f.readonly, opts: f.options && f.options.length ? f.options : undefined });
  return {
    site: p.url.replace(/^https?:\/\//, '').split(/[?#]/)[0],
    libs: p.componentLibs, topLibrary: p.topLibrary, framework: p.framework,
    totals: p.totals, sections: p.sections,
    fields: p.fields.map(pick),
  };
}

export { normalize, core };
