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
  if (ka && kd && ka === kd) return true;
  // 以前这里还有 "a.includes(d) || d.includes(a)" 和数字前缀相等：
  // 于是往 薪资 框写 20000、页面显示 20000-30000 也算"绿"，或被 maxlength 截断成 20 也算"绿"。
  // 回读校验只认"渲染出来的就是我要的那个值"，宁可报红也不假绿。
  return false;
}

/**
 * 社区实测里最高频的失败不是"匹配不到"，而是"值看得见、站点仍报必填"：
 * 受控组件在 focus 之前被写入会被重绘抹掉。所以顺序必须是
 * focus → 让出一个宏任务 → 写值 → input/change → blur → 复查站点自己的校验状态。
 */
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const ERROR_SELECTOR = '.ant-form-item-explain-error,.el-form-item__error,.Validform_wrong,[role="alert"]';

/** 写入后站点亮起的错误提示：存在就说明"填进去了但没被承认" */
function validationErrorNear(el) {
  const item = el.closest?.('[class*="form-item"],[class*="form-row"],[class*="field"],li,tr,dd,p,div');
  if (!item || !item.querySelector) return '';
  const err = item.querySelector(ERROR_SELECTOR);
  const t = (err?.textContent || '').trim();
  return t ? t.slice(0, 40) : '';
}

async function writeText(el, value) {
  el.focus?.();
  await tick(0);
  const actual = setNativeValue(el, value);
  if (!tolerant(actual, value)) {
    el.value = value;
    dispatch(el, 'input');
    dispatch(el, 'change');
  }
  await tick(0);
  el.blur?.();
  dispatch(el, 'blur');
  return String(el.value ?? '').trim();
}

/**
 * @param {Object} field  scanner 产出的字段描述（含 el）
 * @param {Object} entry  matcher 产出的分配项
 */
export async function fillField(field, entry) {
  const el = field.el;
  if (!el) return { ok: false, reason: 'no_element' };
  const kind = field.kind;

  if (kind === 'file') return { ok: false, reason: 'file_manual', actual: '' };

  if (kind === 'select') {
    const target = entry.optionValue ?? entry.value;
    const list = Array.from(el.options || []);
    const opt = list.find(o => o.value === target && String(o.value) !== '')
      || list.find(o => tolerant(o.textContent, target));
    if (!opt) return { ok: false, reason: 'option_missing', actual: el.value };
    el.focus?.();
    // 很多站点的 option 全部 value=""（按文本区分），只设 el.value 会落到第一个空值项
    const idx = list.indexOf(opt);
    if (idx >= 0) el.selectedIndex = idx;
    el.value = opt.value;
    dispatch(el, 'change');
    dispatch(el, 'blur');
    const shown = (el.selectedIndex >= 0 ? el.options[el.selectedIndex]?.textContent : '') || opt.textContent;
    return { ok: tolerant(shown, target) || tolerant(opt.textContent, target), actual: String(shown || '').trim(), shown: String(shown || '').trim(), error: validationErrorNear(el) };
  }

  if (kind === 'radio' || kind === 'checkbox') {
    const group = field.__group || [el];
    const wanted = String(entry.optionValue ?? entry.value ?? '').split(/[,，、|]/).map(s => normalize(s)).filter(Boolean);
    const wantTexts = new Set(wanted);
    let touched = 0;
    for (const box of group) {
      const label = normalize(box.nextElementSibling?.textContent || box.parentElement?.textContent || '');
      const boxValue = normalize(box.value || '');
      // 空标签绝不能算命中：`wanted.some(w => w.includes(label))` 在 label='' 时恒真，
      // 老式表格里"整组被勾满"就是这么来的
      const textHit = !!label && (wantTexts.has(label) || wanted.some(w => w.length >= 2 && label.includes(w)));
      const valueHit = !!boxValue && wantTexts.has(boxValue);
      const should = textHit || valueHit;
      if (should && !box.checked) { box.checked = true; dispatch(box, 'input'); dispatch(box, 'change'); touched++; }
      else if (!should && kind === 'checkbox' && box.checked && entry.mode === 'full') { box.checked = false; dispatch(box, 'change'); touched++; }
      else if (should && box.checked) touched++;
    }
    const chosen = group.filter(x => x.checked).map(x => normalize(x.nextElementSibling?.textContent || x.parentElement?.textContent || x.value));
    const actual = group.filter(x => x.checked).map(x => x.value).join('|');
    // 回读要比对"选中的集合"和"想选的集合"，而不是"有任意一个被勾上"——
    // 后者在错选别人选项时也返回 true，等于把错答案报成绿
    const allWantedChosen = wanted.length > 0 && wanted.every(w => chosen.some(c => c === w || c.includes(w)));
    const noExtra = kind === 'radio' ? chosen.length <= 1 : chosen.every(c => wanted.some(w => c === w || c.includes(w)));
    const ok = touched > 0 && allWantedChosen && noExtra && chosen.length > 0;
    return { ok, actual, reason: ok ? '' : (touched ? 'selection_mismatch' : 'option_missing'), error: ok ? '' : validationErrorNear(el) };
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
  let truncated = false;
  if (field.maxLength && value.length > field.maxLength) { value = value.slice(0, field.maxLength); truncated = true; }

  const actual = await writeText(el, value);
  if (truncated) return { ok: false, reason: 'truncated_by_maxlength', actual, error: '' };
  const error = validationErrorNear(el);
  if (error) return { ok: false, reason: 'validation_not_cleared', actual, error };
  if (tolerant(actual, value)) return { ok: true, actual };
  if (el.readOnly) return { ok: false, reason: 'readonly_control', actual };
  return { ok: false, reason: 'value_rejected', actual };
}

/**
 * 执行分配方案。返回每条的状态：green / orange / red，并记录原值供回滚。
 */
export async function applyPlan(fields, assignments, opts = {}) {
  const results = [];
  const rollback = [];
  for (const entry of assignments) {
    const field = fields[entry.index];
    if (!field) continue;
    if (entry.skip) { results.push({ ...entry, status: 'skipped' }); continue; }
    if (opts.dryRun) { results.push({ ...entry, status: 'planned' }); continue; }

    const original = field.el ? readBack(field.el, field.kind) : '';
    let preChecks = null;
    if (field.kind === 'radio' || field.kind === 'checkbox') {
      field.__group = collectGroup(field);
      // 必须在写入*之前*抄下每个控件的勾选状态：写完再抄就会把"我勾的"记成"原本就勾的"，
      // 于是回滚只恢复了别人的选项、我加的那个永远撤不掉
      preChecks = field.__group.map(b => ({ el: b, was: b.checked }));
    }
    const outcome = await fillField(field, entry);
    // 没写进去就把原值还原：只读框、受控组件可能接受了赋值又被框架改回去，
    // 留半截错误内容比留空更糟（站点校验会把它当已填）。单选/多选保守不动。
    if (!outcome.ok && original) {
      try {
        if (field.kind !== 'radio' && field.kind !== 'checkbox') {
          if (field.kind === 'contenteditable') field.el.textContent = original;
          else if (field.el.value !== original) {
            field.el.value = original;
            dispatch(field.el, 'input');
            dispatch(field.el, 'change');
          }
        }
      } catch { /* 还原失败不影响其余字段 */ }
    }
    // 记录"写之前每个控件的状态"，回滚才可能真实：以前 radio/checkbox 的 undo 是整组清零，
    // 会把用户/站点本来就有的勾选一起抹掉——那不是"撤销我的填写"，是"改了页面别的状态"
    rollback.push({
      id: entry.index, el: field.el, kind: field.kind, original,
      group: preChecks || (field.__group || [field.el]).map(b => ({ el: b, was: b.checked })),
    });

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
    undo: async () => {
      let restored = 0;
      for (const item of rollback) {
        if (!item.el?.ownerDocument) continue;
        if (item.kind === 'radio' || item.kind === 'checkbox') {
          for (const box of item.group || []) {
            if (!box.el || box.el.checked === box.was) continue;
            box.el.checked = box.was;
            dispatch(box.el, 'change');
            restored++;
          }
        } else if (item.kind === 'contenteditable') {
          item.el.textContent = item.original; dispatch(item.el, 'input'); restored++;
        } else {
          await writeText(item.el, item.original || '');
          restored++;
        }
      }
      rollback.length = 0;
      return { ok: true, restored };
    },
  };
}

/** 选项集合只在同一个 form / fieldset 内取。
 *  全文档按 name 取会把两个区块里的同名控件当成一组（招聘页常见 company_1 / company_2 复用 name），
 *  结果是一次勾满别人的选项，而且回读还以为成功了。 */
function collectGroup(field) {
  const el = field.el;
  const name = field.name;
  if (!name) return [el];
  const sel = field.kind === 'radio' ? 'input[type="radio"]' : 'input[type="checkbox"]';
  const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(name) : name;
  const scope = el.form
    || el.closest?.('fieldset, [class*="form-item"], [class*="radio"], tr, li')
    || el.ownerDocument;
  const inScope = scope.querySelectorAll ? Array.from(scope.querySelectorAll(`${sel}[name="${esc}"]`)) : [];
  return inScope.length ? inScope : [el];
}
