// 安全闸门：把"永不替你提交"从口头承诺变成代码级硬约束。
// 需求 §9-6：白名单之外的元素一律不派发点击事件；form.submit() 被劫持成 no-op。

export const SUBMIT_TEXT_RE = /(提交|投递|确认投递|立即申请|完成申请|发送申请|submit|apply\s*now|finish\s*application|send\s*application|确认并提交)/i;
export const NAV_TEXT_RE = /(下一步|上一步|next|previous|保存并继续|save\s*and\s*continue)/i;
export const EXPAND_TEXT_RE = /(展开|查看更多|添加一条|增加一项|更多|expand|add\s*(another|more)|show\s*more)/i;

// 允许点击的：自定义下拉/日期的触发器与其选项、展开按钮。其余拒绝。
export function classifyClick(el) {
  if (!el) return { allowed: false, reason: 'no_element' };
  const text = String(el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
  const role = (el.getAttribute?.('role') || '').toLowerCase();
  const tag = (el.tagName || '').toLowerCase();
  const type = (el.type || '').toLowerCase();

  if (tag === 'button' && type === 'submit') return { allowed: false, reason: 'submit_button' };
  if (SUBMIT_TEXT_RE.test(text)) return { allowed: false, reason: 'submit_button' };
  if (type === 'file') return { allowed: false, reason: 'file_input' };
  if (el.form && tag === 'button' && type === 'submit') return { allowed: false, reason: 'submit_button' };
  if (NAV_TEXT_RE.test(text)) return { allowed: false, reason: 'navigation' };
  if (role === 'option' || role === 'menuitem' || el.closest?.('[role="listbox"],[role="menu"]')) return { allowed: true, reason: 'option' };
  if (role === 'combobox' || el.getAttribute?.('aria-haspopup')) return { allowed: true, reason: 'control_trigger' };
  if (EXPAND_TEXT_RE.test(text)) return { allowed: true, reason: 'expand' };
  if (el.dataset?.nwTrigger !== undefined) return { allowed: true, reason: 'declared_trigger' };
  return { allowed: false, reason: 'not_in_allowlist' };
}

/** 受闸门保护的点击。被拒时只记录，不抛错打断填写流程。 */
export function guardedClick(el, log = []) {
  const verdict = classifyClick(el);
  if (!verdict.allowed) {
    log.push({ action: 'click_blocked', reason: verdict.reason, text: String(el.textContent || '').trim().slice(0, 40) });
    return false;
  }
  el.click?.();
  return true;
}

/**
 * 装弹：劫持本页面的表单提交路径。
 * 只在 content script 里调用一次；解除可通过 reload 页面。
 */
export function armSubmitGuard(win, log = []) {
  if (!win?.HTMLFormElement?.prototype) return false;
  if (win.__nwSubmitGuardArmed) return true;
  const original = win.HTMLFormElement.prototype.submit;
  win.HTMLFormElement.prototype.submit = function nwBlockedSubmit(...args) {
    log.push({ action: 'form_submit_blocked', at: Date.now() });
    win.dispatchEvent(new win.CustomEvent('nw:submit-blocked', { detail: { via: 'form.submit' } }));
    return undefined;
  };
  win.__nwSubmitGuard = { original };
  win.__nwSubmitGuardArmed = true;

  win.addEventListener('submit', (ev) => {
    const text = String(ev.submitter?.textContent || ev.submitter?.value || '').trim();
    if (SUBMIT_TEXT_RE.test(text) || ev.submitter?.type === 'submit' || true) {
      // 用户自己点的提交我们不动（不 preventDefault）；
      // 这一层只记录，用于事后核对"提交确实是你按的"。
      log.push({ action: 'submit_by_user', text: text.slice(0, 40), at: Date.now() });
    }
  }, true);
  return true;
}

export function disarmSubmitGuard(win) {
  if (win?.__nwSubmitGuard?.original) {
    win.HTMLFormElement.prototype.submit = win.__nwSubmitGuard.original;
    win.__nwSubmitGuardArmed = false;
  }
}

/** 明确不能自动填入的字段类型（验证码/密码/签名），供 matcher 之外的二次防线 */
export function isSensitiveControl(el) {
  const type = (el?.type || '').toLowerCase();
  if (type === 'password' || type === 'file') return true;
  const name = String(el?.name || el?.id || el?.getAttribute?.('aria-label') || '').toLowerCase();
  return /(captcha|vercode|verify_code|sms|otp|password|signature)/.test(name);
}
