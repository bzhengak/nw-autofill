// 写入执行：确定性写值 + 框架兼容 + 写后回读校验。
// setNativeValue 的思路与上游 shared/fill-runtime.js 的"回读匹配"一致，此处独立实现。见 NOTICE.md。

import { normalize, formatDate } from '../core/matching.js';

function dispatch(el, type, extra = {}) {
  const doc = el.ownerDocument;
  const Ctor = type.startsWith('key') ? doc.defaultView.KeyboardEvent
    : type === 'focus' || type === 'blur' ? doc.defaultView.FocusEvent : doc.defaultView.Event;
  let ev;
  try { ev = new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...extra }); }
  catch { ev = doc.createEvent('Event'); ev.initEvent(type, true, true); }
  el.dispatchEvent(ev);
}

/** 绕过 React/Vue 受控组件对 .value 直赋的失效问题 */
export function setNativeValue(el, value) {
  const proto = el instanceof el.ownerDocument.defaultView.HTMLTextAreaElement
    ? el.ownerDocument.defaultView.HTMLTextAreaElement.prototype
    : el.ownerDocument.defaultView.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  const previous = el.value;
  // React 会比较 value 是否变化；先置空再赋值可强制它认账
  if (desc?.set) {
    if (previous !== '') desc.set.call(el, '');
    desc.set.call(el, value);
  } else {
    el.value = value;
  }
  dispatch(el, 'input', { inputType: 'insertReplacementText', data: value });
  dispatch(el, 'change');
  return el.value;
}

export function readBack(el, kind) {
  if (kind === 'contenteditable') return String(el.textContent || '').trim();
  if (kind === 'radio' || kind === 'checkbox') {
    const checked = el.__nwGroup?.filter(x => x.checked).map(x => x.value || normalize(x.nextElementSibling?.textContent || ''));
    return (checked || []).join('|');
  }
  return String(el.value ?? '').trim();
}

function tolerant(actual, desired) {
  const a = normalize(actual), d = normalize(desired);
  if (!a || !d) return false;
  if (a === d) return true;
  // 站点把 2026-06 渲染成 2026/06 或补成 2026-06-01 都算写进去了
  const ka = a.replace(/[^\d]/g, ''), kd = d.replace(/[^\d]/g, '');
  if (ka && kd && (ka === kd || ka.startsWith(kd) || kd.startsWith(ka))) return true;
  return a.includes(d) || d.includes(a);
}

function writeText(el, value) {
  el.focus?.();
  const actual = setNativeValue(el, value);
  if (!tolerant(actual, value)) {
    el.value = value;
    dispatch(el, 'input');
    dispatch(el, 'change');
  }
  return String(el.value ?? '').trim();
}

/**
 * @param {Object} field  scanner 产出的字段描述（含 el）
 * @param {Object} entry  matcher 产出的分配项
 */
export function fillField(field, entry) {
  const el = field.el;
  if (!el) return { ok: false, reason: 'no_element' };
  const kind = field.kind;

  if (kind === 'file') return { ok: false, reason: 'file_manual', actual: '' };

  if (kind === 'select') {
    const target = entry.optionValue ?? entry.value;
    const opt = Array.from(el.options || []).find(o => o.value === target)
      || Array.from(el.options || []).find(o => tolerant(o.textContent, target));
    if (!opt) return { ok: false, reason: 'option_missing', actual: el.value };
    el.focus?.();
    el.value = opt.value;
    dispatch(el, 'change');
    dispatch(el, 'blur');
    return { ok: tolerant(el.value, opt.value) || tolerant(opt.textContent, target), actual: el.value, shown: opt.textContent };
  }

  if (kind === 'radio' || kind === 'checkbox') {
    const group = field.__group || [el];
    const wanted = String(entry.optionValue ?? entry.value ?? '').split(/[,，、|]/).map(s => normalize(s)).filter(Boolean);
    let touched = 0;
    for (const box of group) {
      const label = normalize(box.nextElementSibling?.textContent || box.parentElement?.textContent || box.value || '');
      const should = kind === 'radio'
        ? (wanted.includes(label) || wanted.includes(normalize(box.value)) || label === normalize(wanted[0]))
        : wanted.some(w => label.includes(w) || w.includes(label) || normalize(box.value) === w);
      if (should && !box.checked) { box.checked = true; dispatch(box, 'input'); dispatch(box, 'change'); dispatch(box, 'click'); touched++; }
      else if (!should && kind === 'checkbox' && box.checked && entry.mode === 'full') { box.checked = false; dispatch(box, 'change'); touched++; }
      else if (should && box.checked) touched++;
    }
    const actual = group.filter(x => x.checked).map(x => x.value).join('|');
    return { ok: touched > 0 && group.some(x => x.checked), actual, reason: touched ? '' : 'option_missing' };
  }

  if (kind === 'contenteditable') {
    el.focus?.();
    el.textContent = entry.value;
    dispatch(el, 'input');
    return { ok: tolerant(el.textContent, entry.value), actual: String(el.textContent || '').trim() };
  }

  if (kind === 'combobox') {
    return { ok: false, reason: 'custom_control', actual: '' };
  }

  let value = entry.value ?? '';
  if (entry.dateFormat) value = formatDate(value, entry.dateFormat);
  if (field.maxLength && value.length > field.maxLength) value = value.slice(0, field.maxLength);

  const actual = writeText(el, value);
  if (tolerant(actual, value)) return { ok: true, actual };
  if (el.readOnly) return { ok: false, reason: 'readonly_control', actual };
  return { ok: false, reason: 'value_rejected', actual };
}

/**
 * 执行分配方案。返回每条的状态：green / orange / red，并记录原值供回滚。
 */
export function applyPlan(fields, assignments, opts = {}) {
  const results = [];
  const rollback = [];
  for (const entry of assignments) {
    const field = fields[entry.index];
    if (!field) continue;
    if (entry.skip) { results.push({ ...entry, status: 'skipped' }); continue; }
    if (opts.dryRun) { results.push({ ...entry, status: 'planned' }); continue; }

    const original = field.el ? readBack(field.el, field.kind) : '';
    if (field.kind === 'radio' || field.kind === 'checkbox') field.__group = collectGroup(field);
    const outcome = fillField(field, entry);
    rollback.push({ id: entry.index, el: field.el, kind: field.kind, original, group: field.__group });

    results.push({
      ...entry,
      status: outcome.ok ? (entry.tier === 'auto' ? 'green' : 'yellow') : (outcome.reason === 'file_manual' ? 'manual' : 'red'),
      actual: outcome.actual,
      failReason: outcome.reason || '',
    });
  }
  return {
    results,
    summary: results.reduce((acc, r) => (acc[r.status] = (acc[r.status] || 0) + 1, acc), {}),
    undo: () => {
      for (const item of rollback) {
        if (!item.el?.ownerDocument) continue;
        if (item.kind === 'radio' || item.kind === 'checkbox') {
          for (const box of item.group || [item.el]) { box.checked = false; dispatch(box, 'change'); }
        } else if (item.kind === 'contenteditable') {
          item.el.textContent = item.original; dispatch(item.el, 'input');
        } else {
          writeText(item.el, item.original || '');
        }
      }
      return true;
    },
  };
}

function collectGroup(field) {
  const doc = field.el.ownerDocument;
  const name = field.name;
  if (!name) return [field.el];
  const sel = field.kind === 'radio' ? `input[type="radio"]` : `input[type="checkbox"]`;
  return Array.from(doc.querySelectorAll(`${sel}[name="${(typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(name) : name}"]`));
}
