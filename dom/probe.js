// 只读页面结构探针：导出字段结构给适配器编写用。
// 纪律：不读 el.value / textarea 内容 / 用户输入文本。要新增读取项之前先想清楚是不是用户数据。
// 与 core/matching.js 一样是纯 DOM 函数，可在 jsdom 下单测。

import { core, normalize } from '../core/matching.js';

const CONTROL_SELECTOR = 'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="spinbutton"], [role="listbox"]';
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

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
  while (n && hops < 6) {
    const lab = n.querySelector(':scope > label, :scope > [class*="label"], :scope > [class*="title"], :scope > dt, :scope > [class*="name"]');
    if (lab) { const t = norm(lab.textContent); if (t && t.length <= 40) return { t, v: 'container' }; }
    let p = n.previousElementSibling, g = 0;
    while (p && g < 4) {
      const t = norm(p.textContent);
      if (t && t.length <= 24 && !p.querySelector('input,textarea,select')) return { t, v: 'prev' };
      p = p.previousElementSibling; g++;
    }
    n = n.parentElement; hops++;
  }
  const ph = norm(el.getAttribute('placeholder'));
  if (ph) return { t: ph.slice(0, 40), v: 'placeholder' };
  return { t: '', v: '' };
}

function componentLibs(doc) {
  let css = '';
  for (const s of doc.styleSheets || []) { try { css += [...s.cssRules].map(r => r.cssText).join('\n'); } catch { /* 跨域样式表读不到 */ } }
  for (const st of doc.querySelectorAll('style')) css += st.textContent || '';
  const cnt = re => (css.match(re) || []).length;
  return {
    ant: cnt(/\.ant-[a-z-]+/g), element: cnt(/\.el-[a-z-]+/g), vant: cnt(/\.van-[a-z-]+/g),
    arco: cnt(/\.arco-[a-z-]+/g), rc: cnt(/\.rc-[a-z-]+/g), formily: cnt(/formily/gi), mui: cnt(/\.Mui[A-Za-z]+/g),
    naive: cnt(/\.n-[a-z]+-[a-z]/g),
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

  const fields = found.map(({ e, via }) => {
    const L = labelOf(e, doc);
    const tag = e.tagName.toLowerCase();
    const w = e.closest('[class*="form-item"],[class*="formily"],[class*="field"],[class*="formRow"],[class*="form-row"],[class*="item"]');
    const wrapCls = w ? String(w.className).slice(0, 80) : '';
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

  const libs = componentLibs(doc);
  let shadowHosts = 0;
  doc.querySelectorAll('*').forEach(e => { if (e.shadowRoot) shadowHosts++; });

  return {
    at: new Date().toISOString(),
    url: String(locationHref).slice(0, 110),
    title: norm(doc.title).slice(0, 40),
    framework: {
      react: !!(win && (win.React || win.__REACT_DEVTOOLS_GLOBAL_HOOK__)),
      vue: !!(win && (win.Vue || win.__VUE__ || doc.querySelector('[data-v-]'))),
    },
    componentLibs: libs,
    topLibrary: Object.entries(libs).sort((a, b) => b[1] - a[1])[0][1] > 20
      ? Object.entries(libs).sort((a, b) => b[1] - a[1])[0][0] : 'none/自定义组件',
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
