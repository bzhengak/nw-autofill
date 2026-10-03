// S7：点「+ 添加一段」把经历行补出来。
//
// 为什么需要：分段经历的页面十有八九先只给一段（旁边一枚「+ 添加一段」），
// 资料里有三段时，后两段就永远没地方写 —— 计划校验把这件事报出来了（records_no_room），
// 这一步是把它做掉：我们替用户点那枚加号，点出新行，再按同一张映射表填。
//
// 三条硬规矩（用户 2026-10-02 授权这一功能时定的口径）：
//  1. **默认关着**：设置里没勾「允许补行」，这个模块一个点击都不发；
//  2. **每轮有上限**（ROW_CAP），需要几段也只点这么多，剩下交给用户；
//  3. **点了没长出来就立刻停**：一次点击必须让那一节里可扫到的栏位变多，
//     否则不再连点 —— 连点没有反馈的按钮是在页面上制造未知状态。
// 另外：只点**能确认是"加一段"**的那枚控件；文字里带"删除/提交/保存/下一步/上传/登录"
// 一律不点（那几类里任何一次误点都比少填一段严重得多）。
//
// 这个模块的 DOM 部分刻意做成"你告诉我怎么点、我来验证长没长出来"：
// 点击动作由调用方注入，这样"停不断"的判据能在 jsdom 里真跑一遍。

/** 每轮最多补几段（补行的代价是页面上凭空多出几栏，宁可让用户自己再来一轮） */
export const ROW_CAP = 3;

/** 明显不是"加一段"的写法：这些词出现就不点（宁可少补一段） */
export const NOT_ADD_ROW_RE = /(附件|文件|简历|推荐人|内推|投递|应聘|下载|删除|去掉|移除|清空|重置|提交|保存|发送|上传|下一步|上一页|下一页|退出|登录|验证|attachment|\bfile\b|resume|referr|applic|delete|remove|clear|reset|submit|save|upload|download|next|prev|logout|sign\s?in|captcha)/i;

/** 像是"加一段/再加一条"的写法 */
// 「段/条/行/记录/经历」这类量词是这一类按钮的身份证：只写「添加」两字的那枚，
// 在真站点上更多是「添加附件」「添加推荐人」，不是「再加一段经历」。
export const ADD_ROW_RE = /((添加|新增|再加|增加|补充)[^。]{0,6}(一段|一条|一行|一项|更多|其他|另一|经历|经验)|再?加?[^。]{0,3}(一段|一条|一行|一条记录)|(?:add|new)[\s-]+(another|more|row|record|entry|experience|section)|\+[\s-]*(添加|一段|一条|经验|经历|row|more))/i;
/** 文字里明确点出"这是一段/一条记录"：优先级高于只写「添加」的那一枚 */
export const ROWISH_RE = /(一段|一条|一行|一项|一条记录|经历|经验|记录|条目|another|[\s->_]row[\s<._-]|[\s->_]record|[\s->_]entry|experience|section)/i;

/**
 * 这一节的容器：从本组第一个栏位往上找"能把整组都装下"的最近祖先。
 * 有了这个边界，加号才只可能是**这一节**的加号（页面每一节各有一个加号是常态）。
 */
export function blockContainerFor(pageFields = []) {
  const els = pageFields.map(f => f?.el).filter(Boolean);
  if (els.length < 2) return null;   // 只有一栏就说不上"这一节的容器"：往上一定会落到 form/body，那是整页
  let node = els[0].parentElement;
  for (let guard = 0; node && guard < 14; guard++, node = node.parentElement) {
    if (els.every(e => node.contains(e))) return node;
  }
  return null;
}

/** 这一组栏位里，落在容器内的那部分（补行后重新数就靠它） */
export function fieldsIn(container, pageFields = []) {
  if (!container) return [];
  return pageFields.filter(f => f?.el && container.contains(f.el));
}

/**
 * 找到加号 → 点下去。点击动作故意做成注入的：
 * 真实浏览器里就是 `el.click()`，测试里换成假实现，这样"点了没长出来"这条判据能被真跑到。
 */
// 最后一道：这一枚如果在 safety.js 的拒绝名单里（type=file、提交文案、会把页面导航走的链接），
// 就不点。判据只有一处（dom/safety.js），这里不另写一份关键词表。
export function defaultClick(el, safety) {
  if (safety?.classifyClick) {
    const gate = safety.classifyClick(el);
    if (['submit_button', 'file_input', 'navigation'].includes(gate?.reason)) return false;
  }
  try { el.scrollIntoView?.({ block: 'center' }); } catch { /* 没有排版也算点了 */ }
  if (typeof el.click === 'function') el.click();
  else el.dispatchEvent?.(new MouseEvent('click', { bubbles: true }));
  return true;
}

/**
 * 哪些**节**页面上备着"加一段"的按钮。
 * 这是 S7 的开关判据，也回喂给计划校验：
 * 只有一行、旁边也没有加号，那一页多半就是只收一段（"最高学历"），不该报"没地方写"；
 * 有加号才说明页面准备收更多段 —— 那才是资料段数超过页面行数的那种故障。
 */
export function sectionsWithAddButton(pageFields = []) {
  const bySection = new Map();
  for (const f of pageFields) {
    const s = f?.sectionHint;
    if (!s) continue;
    if (!bySection.has(s)) bySection.set(s, []);
    bySection.get(s).push(f);
  }
  const hit = new Set();
  for (const [section, group] of bySection) {
    const container = blockContainerFor(group);
    if (container && findAddRowButton(container)) hit.add(section);
  }
  return hit;
}

/**
 * 纯算术：从计划校验的提示里算出"每一节还要补几行"。
 * 只认 records_no_room（资料比页面多），并且每节最多 ROW_CAP 行。
 */
export function planRowExpansion(warnings = [], cap = ROW_CAP) {
  const out = [];
  for (const w of warnings || []) {
    if (w?.kind !== 'records_no_room') continue;
    const need = Math.max(0, (w.have || 0) - (w.page || 0));
    if (!need) continue;
    out.push({ section: w.section, have: w.have, page: w.page, need, willTry: Math.min(need, cap) });
  }
  return out;
}

/** 这一枚控件像不像是"加一段"（文字、aria-label、title 三个来源任一命中即可，但黑名单一票否决） */
export function isAddRowControl(el) {
  if (!el || el.nodeType !== 1) return false;
  const text = [
    el.textContent, el.getAttribute?.('aria-label'), el.getAttribute?.('title'),
    el.getAttribute?.('data-tip'), el.value,
  ].map(x => String(x ?? '').trim()).filter(Boolean).join(' | ');
  if (!text) return false;
  if (NOT_ADD_ROW_RE.test(text)) return false;
  if (!ADD_ROW_RE.test(text)) return false;
  // 只允许锚点型的 <a>：href 指向别处的"加号"点下去会把标签页导航走，未保存的网申就没了。
  // 判据刻意取严（不是"同源就行"）：同源带路径的链接同样会跳走页面。
  if (String(el.tagName || '').toLowerCase() === 'a') {
    const href = String(el.getAttribute?.('href') || '').trim();
    if (href && !/^(#|javascript:|$)/i.test(href)) return false;
  }
  // 得是能点的东西（真站点的加号常是 <a>、<span>、<i> 包一个 role=button）
  const tag = String(el.tagName || '').toLowerCase();
  const clickable = tag === 'button' || tag === 'a' || el.getAttribute?.('role') === 'button'
    || el.getAttribute?.('tabindex') != null || Boolean(el.onclick)
    || /(^|[\s-])(btn|button|link|add|plus)/i.test(String(el.className || ''));
  return Boolean(clickable);
}

/** 在一节范围内找那枚加号：容器内（含容器自身）所有能确认的元素，按文字长度升序取第一个 */
export function findAddRowButton(container) {
  if (!container || container.nodeType !== 1) return null;
  const cands = [];
  const walk = el => {
    if (!el || el.nodeType !== 1) return;
    if (isAddRowControl(el)) cands.push(el);
    for (const k of Array.from(el.children || [])) walk(k);
  };
  walk(container);
  // 排序判据：① 文字里点明"一段/一条/记录"的先（这一档能压过「添加附件」那种只写「添加」的）；
  // ② 同档再按文字短的优先（短的多半就是那枚加号本体）。
  const rank = el => (ROWISH_RE.test(String(el.textContent || '')) ? 0 : 1);
  cands.sort((a, b) => rank(a) - rank(b) || String(a.textContent || '').length - String(b.textContent || '').length);
  return cands[0] || null;
}

/**
 * 补一段：点一次，然后核对"这一节里可扫到的栏位确实变多了"。
 * 没变多就返回 stalled —— 调用方必须停下来（不许连点没有反馈的按钮）。
 *
 * @param o.container  这一节的容器
 * @param o.count      () => 当前这一节里扫得到的栏位数
 * @param o.click      (el) => void，真实点击（测试里注入假实现）
 * @param o.settleMs   点击后等多久再数（SPA 渲染新行要时间）
 */
export async function addOneRow({ container, count, click, settleMs = 260 }) {
  const before = Number(count?.()) || 0;
  const btn = findAddRowButton(container);
  if (!btn) return { ok: false, reason: 'no_add_button', before, after: before };
  try { click(btn); } catch { return { ok: false, reason: 'click_threw', before, after: before }; }
  if (settleMs) await new Promise(r => setTimeout(r, settleMs));
  const after = Number(count?.()) || 0;
  if (after <= before) return { ok: false, reason: 'stalled', before, after };
  return { ok: true, before, after, grew: after - before };
}

/** 按算术一行一行补；任何一次没长出来就停，并把停在哪一步原样报告 */
export async function expandRows({ container, count, click, willTry = 1, settleMs = 260 }) {
  const tries = Math.max(0, Math.min(Number(willTry) || 0, ROW_CAP));
  const log = [];
  let added = 0;
  for (let i = 0; i < tries; i++) {
    const r = await addOneRow({ container, count, click, settleMs });
    log.push(r);
    if (!r.ok) return { added, stalled: true, why: r.reason, log };
    added++;
  }
  return { added, stalled: false, why: '', log };
}
