/**
 * 只读页面结构诊断器（不读取任何已填写内容）
 *
 * 用途：在你已登录的网申页面上运行，把"字段结构"导出成 JSON，用来生成/校准站点适配器。
 * 设计上不碰用户数据：全程不读 el.value、不读 textarea 内容、不读用户输入的任何文本。
 * 你可以自己确认：本文件里对表单元素只读取 name/id/role/placeholder/aria-*/type/required/
 * readOnly/disabled/accept/maxLength，以及 select 的 option 文案（那是站点提供的候选项，不是你的答案）。
 *
 * 用法：F12 打开 DevTools → Console → 整段粘贴本文件内容并回车 → 输出会自动进剪贴板，
 *       同时在控制台打印一份，直接复制给我即可。
 * 想少给点信息：贴之前删掉你不想要的字段（比如 label 里有公司内部叫法）。
 */
(() => {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const found = [];
  const walk = (root, depth, via) => {
    if (!root || depth > 20) return;
    for (const e of (root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [])) {
      if (e.__structSeen) continue;
      e.__structSeen = 1;
      const tag = e.tagName ? e.tagName.toLowerCase() : '';
      const isControl = ['input', 'textarea', 'select'].includes(tag)
        || (e.getAttribute && (e.getAttribute('contenteditable') === 'true'
          || e.getAttribute('role') === 'combobox' || e.getAttribute('role') === 'spinbutton'));
      if (isControl) found.push({ e, via });
      if (e.shadowRoot) walk(e.shadowRoot, depth + 1, via + '>' + tag + '#shadow');
    }
  };
  walk(document, 0, '');

  const labelOf = e => {
    const id = e.getAttribute('id');
    if (id) {
      try {
        const l = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (l && norm(l.textContent)) return { t: norm(l.textContent).slice(0, 40), v: 'for' };
      } catch (_) { /* ignore */ }
    }
    const ab = e.getAttribute('aria-labelledby');
    if (ab) {
      const t = ab.split(/\s+/).map(x => { const n = document.getElementById(x); return n ? norm(n.textContent) : ''; }).filter(Boolean).join(' ');
      if (t) return { t: t.slice(0, 40), v: 'labelledby' };
    }
    const al = e.getAttribute('aria-label');
    if (al) return { t: norm(al).slice(0, 40), v: 'aria' };
    const wrap = e.closest('label');
    if (wrap && norm(wrap.textContent)) return { t: norm(wrap.textContent).slice(0, 40), v: 'wrapped' };
    let n = e.parentElement, hops = 0;
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
    const ph = norm(e.getAttribute('placeholder'));
    if (ph) return { t: ph.slice(0, 40), v: 'placeholder' };
    return { t: '', v: '' };
  };

  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  const items = found.map(({ e, via }) => {
    const L = labelOf(e);
    const tag = e.tagName.toLowerCase();
    const w = e.closest('[class*="form-item"],[class*="formily"],[class*="field"],[class*="formRow"],[class*="form-row"],[class*="item"]');
    const cls = w ? String(w.className).slice(0, 80) : '';
    const req = e.required === true || e.getAttribute('aria-required') === 'true' || /required|必填/.test(cls);
    const opts = tag === 'select' ? Array.from(e.options).slice(0, 14).map(o => norm(o.textContent).slice(0, 24)) : null;
    return {
      tag,
      type: e.type || undefined,
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
      vis: visible(e)
    };
  });

  let css = '';
  for (const s of document.styleSheets) { try { css += [...s.cssRules].map(r => r.cssText).join('\n'); } catch (_) { /* 跨域样式表读不到，跳过 */ } }
  for (const st of document.querySelectorAll('style')) css += st.textContent || '';
  const cnt = re => (css.match(re) || []).length;

  let shadowHosts = 0;
  document.querySelectorAll('*').forEach(e => { if (e.shadowRoot) shadowHosts++; });

  const out = {
    at: new Date().toISOString(),
    url: location.href.slice(0, 110),
    title: norm(document.title).slice(0, 40),
    framework: {
      react: !!(window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__),
      vue: !!(window.Vue || window.__VUE__ || !!document.querySelector('[data-v-]'))
    },
    componentLibs: {
      ant: cnt(/\.ant-[a-z-]+/g), element: cnt(/\.el-[a-z-]+/g), vant: cnt(/\.van-[a-z-]+/g),
      arco: cnt(/\.arco-[a-z-]+/g), rc: cnt(/\.rc-[a-z-]+/g), formily: cnt(/formily/gi), mui: cnt(/\.Mui[A-Za-z]+/g)
    },
    totals: {
      controls: items.length,
      visible: items.filter(i => i.vis).length,
      selects: items.filter(i => i.tag === 'select').length,
      radios: items.filter(i => i.type === 'radio').length,
      checkboxes: items.filter(i => i.type === 'checkbox').length,
      fileInputs: items.filter(i => i.type === 'file').length,
      iframes: document.querySelectorAll('iframe').length,
      shadowHosts
    },
    sections: [...new Set([...document.querySelectorAll('h1,h2,h3,h4,legend,caption,[class*="step"],[role="tab"]')]
      .map(e => norm(e.textContent)).filter(t => t && t.length <= 16))].slice(0, 24),
    fields: items.filter(i => i.vis).slice(0, 160),
    note: '本输出不包含任何你填写的内容，只有字段结构与站点自带的候选项文案。'
  };

  const json = JSON.stringify(out, null, 1);
  console.log(json);
  try { if (typeof copy === 'function') { copy(json); console.log('%c→ JSON 已复制到剪贴板', 'color:#22a06b'); } } catch (_) { /* copy 只在 DevTools 控制台可用 */ }
  window.__nwProbe = out;
  return out;
})();
