// 写入执行：确定性写值 + 框架兼容 + 写后回读校验。
// setNativeValue 的思路与上游 shared/fill-runtime.js 的"回读匹配"一致，此处独立实现。见 NOTICE.md。

import { normalize, formatDate } from '../core/matching.js';
import { pickCustomSelect, isCustomSelect } from './select-opener.js';
// 选项可见文案的取法只留一处：扫描、写入、回读三边必须同口径，
// 否则会出现"扫描看见的选项和写入时认的选项不是一套字"，皮肤结构（AntD/Element 的
// label > span 装饰 > opacity:0 的 input）下尤其容易各写各的。
import { optionTextOf } from './scanner.js';

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
    const checked = el.__nwGroup?.filter(x => x.checked).map(x => x.value || normalize(optionTextOf(x)));
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
 * @param {Object} opts   { allowCustomSelect } —— 点开自定义下拉需要用户显式授权，默认关
 */
export async function fillField(field, entry, opts = {}) {
  const el = field.el;
  if (!el) return { ok: false, reason: 'no_element' };
  const kind = field.kind;

  if (kind === 'file') return { ok: false, reason: 'file_manual', actual: '' };

  // 自定义下拉：没有 <select>，选项是点击后渲染到 body 末端的弹层，打字不会选中任何值。
  // 用户授权（allowCustomSelect）后才走"点开 → 匹配 → 选中 → 回读校验"，
  // 任何一步不确定就交人工，绝不"点了就当成功"。
  if (opts.allowCustomSelect && kind !== 'select' && isCustomSelect(field)) {
    const want = entry.optionValue ?? entry.value ?? '';
    const picked = await pickCustomSelect(field, want);
    if (picked.ok) return { ok: true, actual: picked.shown, shown: picked.shown, viaCustomSelect: true, error: '' };
    // 「站点选项里没有我们资料中的值」不是填写失败，是必须本人表态：
    // 报红会把用户的注意力从真错上引开（与 needsChoice 同一口径）。
    const manual = picked.reason === 'option_missing' || picked.reason === 'no_options_rendered';
    return {
      ok: false, reason: manual ? 'choice_required' : (picked.reason || 'custom_control'),
      actual: '', shown: picked.shown || '', error: '', viaCustomSelect: true,
    };
  }

  if (kind === 'select') {
    const target = entry.optionValue ?? entry.value;
    const list = Array.from(el.options || []);
    const opt = list.find(o => o.value === target && String(o.value) !== '')
      || list.find(o => tolerant(o.textContent, target));
    if (!opt) return { ok: false, reason: entry.needsChoice ? 'choice_required' : 'option_missing', actual: el.value };
    el.focus?.();
    // 很多站点的 option 全部 value=""（按文本区分），只设 el.value 会落到第一个空值项
    const idx = list.indexOf(opt);
    if (idx >= 0) el.selectedIndex = idx;
    el.value = opt.value;
    dispatch(el, 'change');
    dispatch(el, 'blur');
    const shown = String((el.selectedIndex >= 0 ? el.options[el.selectedIndex]?.textContent : '') || opt.textContent || '').trim();
    // 验收只能问一句："我们选中的还是不是刚才那个 option？"
    // 以前拿可见文本去比 target，而 target 常常是码值（政治面貌 <option value="2">共青团员</option>）：
    // 共青团员 vs "2" 永远不等 → 明明选对了却报红。站点把选择改回去（受控组件）才算失败。
    const nowOpt = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
    const landed = !!nowOpt && (nowOpt === opt || (!!opt.value && nowOpt.value === opt.value));
    return {
      ok: landed, actual: shown, shown,
      reason: landed ? '' : 'selection_reverted',
      error: validationErrorNear(el),
    };
  }

  if (kind === 'radio' || kind === 'checkbox') {
    const group = field.__group || [el];
    const wanted = String(entry.optionValue ?? entry.value ?? '').split(/[,，、|]/).map(s => normalize(s)).filter(Boolean);
    const wantTexts = new Set(wanted);
    // 一个框"是不是我们要的"只能算一次：写入时按 value 命中（optionValue 常是 M/1/0 这种码值），
    // 回读却拿可见文本比，两边口径不同就会把已经选对的框报成红色 selection_mismatch
    // （plain-cn 的 性别/政治面貌/婚姻状况 全中，判分其实是对的，红字纯属假警报）。
    const hitOf = box => {
      const label = normalize(optionTextOf(box));
      const boxValue = normalize(box.value || '');
      // 空标签绝不能算命中：`wanted.some(w => w.includes(label))` 在 label='' 时恒真，
      // 老式表格里"整组被勾满"就是这么来的
      const textHit = !!label && (wantTexts.has(label) || wanted.some(w => w.length >= 2 && label.includes(w)));
      const valueHit = !!boxValue && wantTexts.has(boxValue);
      return { label, boxValue, wantedBy: textHit ? label : (valueHit ? boxValue : ''), hit: textHit || valueHit };
    };
    let touched = 0;
    for (const box of group) {
      const { hit, label, boxValue } = hitOf(box);
      if (hit && !box.checked) { box.checked = true; dispatch(box, 'input'); dispatch(box, 'change'); touched++; }
      else if (!hit && kind === 'checkbox' && box.checked && entry.mode === 'full') { box.checked = false; dispatch(box, 'change'); touched++; }
      else if (hit && box.checked) touched++;
    }
    const chosenBoxes = group.filter(x => x.checked);
    const chosen = chosenBoxes.map(x => hitOf(x));
    // 回读要比对"选中的集合"和"想选的集合"，而不是"有任意一个被勾上"——
    // 后者在错选别人选项时也返回 true，等于把错答案报成绿。
    // 判"选中的这个框是不是我们要的"直接复用 hitOf：与写入同一口径，
    // 不会出现"按 value 选中、按 label 验收"这种自己验不过自己的红字。
    const allWantedChosen = wanted.length > 0 && wanted.every(w => chosen.some(c => c.hit && (c.wantedBy === w || c.wantedBy.includes(w) || w.includes(c.wantedBy))));
    const noExtra = kind === 'radio' ? chosenBoxes.length <= 1 : chosen.every(c => c.hit);
    const actual = chosenBoxes.map(x => x.value).join('|');
    const shown = chosen.map(c => c.label || c.boxValue).filter(Boolean).join('|');
    const ok = touched > 0 && allWantedChosen && noExtra && chosenBoxes.length > 0;
    return { ok, actual: shown || actual, reason: ok ? '' : (touched ? 'selection_mismatch' : (entry.needsChoice ? 'choice_required' : 'option_missing')), error: ok ? '' : validationErrorNear(el) };
  }

  if (kind === 'contenteditable') {
    el.focus?.();
    el.textContent = entry.value;
    dispatch(el, 'input');
    return { ok: tolerant(el.textContent, entry.value), actual: String(el.textContent || '').trim() };
  }

/*
 * 没被授权走点开选中的自定义控件，一律在这里拒掉，**不许回落到打字硬填**：
 * 这类控件打字不会选中任何值，还可能把站点自己的校验搞乱（以前就是靠这条挡住的）。
 */
if (kind === 'combobox' || kind === 'listbox' || (!opts.allowCustomSelect && isCustomSelect(field))) {
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
    const outcome = await fillField(field, entry, opts);
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
      // 'choice_required'：计划阶段就知道页面选项跟资料对不上（entry.needsChoice）。
      // 这不是"我们填错了"，是"这一栏得你亲手表态"，报红会把用户的注意力从真错上引开。
      status: outcome.ok ? (entry.tier === 'auto' ? 'green' : 'yellow')
        : (outcome.reason === 'file_manual' || outcome.reason === 'choice_required') ? 'manual' : 'red',
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
