// 写入台账：分清"这一栏的值是我们写的"还是"站点预填 / 你自己填的"。
//
// 为什么必须有（用户 2026-10-02："AI 填写不能修改已填过的错误的"）：
// 页面上我们只留了 CSS 描边，重载之后连描边都没了。于是下一轮扫描看见框里有字就
// 一律 `already_filled` 跳过 —— 上一轮我们写错的那一栏从此**永久化**，
// 而且它不在缺口里，连「导出没填的字段与选项」都不会出现。
// 错的值被当成"已经填好"，是这套系统里最隐蔽的一类失败。
//
// 指纹为什么不能用 DOM 路径或 index：网申页面大多是 SPA，节点会重建，第 3 个输入框
// 明天可能排第 5 个。用"这一栏长什么样"当身份（标签 + name/id + 板块 + 序号 + 选项集合）
// 才跨重载稳定；代价是同一页两栏描述完全相同时会共用指纹 —— 这种页面本来就分不清谁是谁，
// 让它们在台账里同进同出，不假装能区分（真要区分靠 M4 映射表的人工改判）。
//
// 隐私：台账**只存取值哈希**，不存明文取值；它是"这一栏我们写过"的证据，不是简历的副本。

import { normalize, core } from './matching.js';

export const LEDGER_BUCKET = 'nwFillLedger';
export const LEDGER_CAP_PER_ORIGIN = 400;
export const LEDGER_CAP_ORIGINS = 40;

/**
 * 稳定哈希（djb2 → base36）：只要"变没变"，不要可逆。
 *
 * 审查提过"要不要加安装期随机盐"（djb2 + 长度对手机号/身份证这类小取值空间可被字典反推）。
 * 结论是不加，理由记在这儿免得下次又讨论一遍：能读到 `chrome.storage.local` 的人
 * 本来就能读到同一份存储里**明文的 profile**（含手机号、证件号）——盐只是把
 * "同一攻击面里的第二个字段"从可反推变成不可反推，边际收益接近 0，
 * 代价却是把盐穿到 content/matcher/filler/SW 四处（那种漂移正是本文件要避免的）。
 * 真要收紧，该收的是"整个 profile 明文落盘"这件事（需要 native host 才能用系统钥匙串，
 * 而"纯浏览器插件"是硬边界），不是这里。
 */
export function hashValue(value) {
  const s = String(value ?? '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `${s.length.toString(36)}:${h.toString(36)}`;
}

/** 栏位指纹：只用页面自己的描述性信息，不 index、不 DOM 路径 */
export function fingerprint(pageField) {
  const f = pageField || {};
  const opts = (f.options || [])
    .map(o => core(normalize(o?.text ?? o ?? ''))).filter(Boolean).slice(0, 12).join('|');
  const bits = [
    core(normalize(f.labelRaw || f.label || '')),
    normalize(f.name || ''),
    normalize(f.id || ''),
    normalize(f.autocomplete || ''),
    normalize(f.placeholder || ''),
    normalize(f.sectionTitle || f.sectionHint || ''),
    f.itemIndex == null ? '' : `i${f.itemIndex}`,
    f.kind || '',
    opts ? `o:${hashValue(opts)}` : '',
  ];
  return hashValue(bits.join('#'));
}

/**
 * 这一栏现在的值是谁写的？
 *   us     —— 台账里有我们写的记录，且页面当前值与我们写进去的一致（可以覆盖/纠正）
 *   edited —— 台账里有记录，但值被人改过了：改的人可能是用户，也可能站点自己算的 → 默认不动
 *   other  —— 没写过，可页面已经有值：站点预填或用户手填 → 默认不动
 *   empty  —— 空的，正常待填
 */
export function classify(pageField, currentValue, ledger, origin) {
  const cur = String(currentValue ?? '').trim();
  const mine = (ledger && origin && ledger[origin]) || {};
  const rec = mine[fingerprint(pageField)];
  if (!rec) return cur ? 'other' : 'empty';
  if (!cur) return 'empty';                                  // 我们写过但现在空了：站点清了，重写即可
  if (String(rec.valueHash) === hashValue(cur)) return 'us';
  return 'edited';
}

/** 记一笔：entries 里每项可以是 {pageField, path, value|valueHash} 或已算好的 {fp, path, valueHash}。
 *  内容脚本走后者（它把指纹算好再发消息，页面上的明文取值不会因此多走一跳）。 */
export function recordWrites(ledger, origin, entries = [], { at = Date.now(), cap = LEDGER_CAP_PER_ORIGIN } = {}) {
  if (!origin) return ledger || {};
  const byOrigin = { ...(ledger || {}) };
  const mine = { ...(byOrigin[origin] || {}) };
  for (const e of entries) {
    const fp = e?.fp || (e?.pageField ? fingerprint(e.pageField) : '');
    const path = e?.path;
    if (!fp || !path) continue;
    const vh = e.valueHash !== undefined ? String(e.valueHash) : hashValue(e.value ?? '');
    mine[fp] = { path, valueHash: vh, at, build: String(e.build || '') };
  }
  const keys = Object.keys(mine);
  if (keys.length > cap) {
    // 超出上限时丢最旧的（`at` 小的）；同一批写入的 at 相同，退化为按插入顺序丢前面的
    keys.sort((a, b) => (mine[a].at || 0) - (mine[b].at || 0))
      .slice(0, keys.length - cap)
      .forEach(k => delete mine[k]);
  }
  byOrigin[origin] = mine;
  const origins = Object.keys(byOrigin);
  if (origins.length > LEDGER_CAP_ORIGINS) {
    origins.sort((a, b) => {
      const la = Math.max(0, ...Object.values(byOrigin[a] || {}).map(x => x.at || 0));
      const lb = Math.max(0, ...Object.values(byOrigin[b] || {}).map(x => x.at || 0));
      return la - lb;
    }).slice(0, origins.length - LEDGER_CAP_ORIGINS).forEach(k => delete byOrigin[k]);
  }
  return byOrigin;
}

/**
 * 撤销之后要把对应记录擦掉，否则"撤销成功"而台账还说这是我们写的。
 * 传进来的就是内容脚本算好的指纹（不在后台重算字段，避免两侧算法漂移）。
 */
export function forgetWrites(ledger, origin, fps = []) {
  if (!origin || !ledger || !ledger[origin]) return ledger || {};
  const mine = { ...ledger[origin] };
  for (const fp of fps) delete mine[String(fp || '')];
  return { ...ledger, [origin]: mine };
}

/** 只读导出用：这一栏是不是我们写的（不导出路径外的任何取值信息） */
export function writtenBy(ledger, origin, pageField) {
  const mine = (ledger && origin && ledger[origin]) || {};
  return mine[fingerprint(pageField)] ? 'us' : '';
}

/** 同上，但直接给指纹（内容脚本已经算过了就别再算一遍） */
export function ledgerRecord(ledger, origin, fp) {
  const mine = (ledger && origin && ledger[origin]) || {};
  return mine[String(fp || '')] || null;
}
