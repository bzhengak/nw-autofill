// 没填上的字段 + 「页面选项 ↔ 页面取值」映射的导出（纯函数，能离线测）。
//
// 为什么单独做这一份：真实实测里最贵的一轮往返是"这一页 28 个 checkbox 一个都没勾上"。
// 我们只看到字段名和"没填"，看不到页面上每个选项的可见文案与它自己的 value 码
// （radio/checkbox 的 value 常常是 '1'/'M'/'Y' 这种站点自定义码），而写别名、写 adapter
// 缺的 exactly 就是这张对照表。探针那份是结构素描，回答"标签在哪"；这份是答案对照表。
//
// 隐私：这里只带**页面自己的**文字（标签、选项文案、码值、控件属性），
// 绝不带资料里的取值，也不带 currentValue 之外的用户内容 ——
// currentValue 是页面上已经显示的选中项（站点预填或用户手点），导出前侧边栏会明确告知。

/** 把 dom/scanner.js 的字段对象收成可序列化的 plain 数据（去掉 DOM 节点）。 */
export function plainField(f) {
  if (!f) return null;
  return {
    kind: f.kind || '',
    label: String(f.label || '').slice(0, 80),
    labelRaw: String(f.labelRaw || '').slice(0, 160),
    labelSource: f.labelSource || '',
    name: String(f.name || '').slice(0, 60),
    id: String(f.id || '').slice(0, 60),
    placeholder: String(f.placeholder || '').slice(0, 60),
    required: Boolean(f.required),
    multi: Boolean(f.multi),
    sectionHint: f.sectionHint || '',
    itemIndex: f.itemIndex == null ? null : f.itemIndex,
    nearbyLabels: (f.nearbyLabels || []).slice(0, 3).map(s => String(s).slice(0, 60)),
    // 选项：text 是给人看的，value 是提交时真正发出去的码 —— 这张对照就是这份导出的意义
    options: (f.options || []).slice(0, 40).map(o => ({
      text: String(o?.text ?? o ?? '').slice(0, 60),
      value: String(o?.value ?? '').slice(0, 60),
    })),
    currentValue: String(f.currentValue ?? '').slice(0, 60),
    customSelect: Boolean(f.customSelect),
    zeroSize: Boolean(f.zeroSize),
    skinned: Boolean(f.skinned),
    className: String(f.className || '').slice(0, 90),
  };
}

/** 已经写过的状态：green/yellow 都是"值已经进控件了"，red/manual 才是没填上 */
const DONE = new Set(['green', 'yellow']);
const NOT_DONE = new Set(['red', 'manual']);

/**
 * @param {Object}  input.fields    scanForm 的返回（含 DOM 节点，本函数会剥掉）
 * @param {Array}   input.gaps      planFill 的缺口（含 reason/note）
 * @param {Array}   input.results   写入结果（含 status/failReason/actual）
 * @param {Boolean} input.includeFilled  默认只导"没填上的"；true 时把填过的也带上
 * @returns {Object} 直接 JSON.stringify 就能落盘的结构
 */
export function buildUnfilledMap({ fields = [], gaps = [], results = [], url = '', build = '', profileFilled = null }, { includeFilled = false } = {}) {
  const gapByIndex = new Map(gaps.map(g => [g.index, g]));
  const resByIndex = new Map(results.map(r => [r.index ?? r.fieldIndex, r]));
  const rows = [];
  const skippedFilled = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const r = resByIndex.get(i);
    const g = gapByIndex.get(i);
    const status = r?.status || (g ? 'gap' : 'unplanned');
    const filled = DONE.has(status);
    if (!includeFilled && filled) { skippedFilled.push(i); continue; }
    const plain = plainField(f) || {};
    rows.push({
      index: i,
      status,
      // 为什么没填：优先用缺口的 reason（那才是我们的判词），其次用写入失败原因
      reason: g?.reason || r?.failReason || r?.reason || (filled ? 'filled' : ''),
      note: g?.note || r?.note || '',
      // 我们想写什么：填成功的路径与实际回读值（导出后自己核对用）
      slotPath: r?.path || g?.slotPath || '',
      writtenBack: r?.actual == null ? '' : String(r.actual).slice(0, 60),
      score: r?.score == null ? null : r.score,
      sensitive: Boolean(r?.sensitive ?? g?.sensitive),
      aiChosen: Boolean(r?.aiChosen),
      ...plain,
    });
  }
  const withOptions = rows.filter(x => x.options.length);
  return {
    at: new Date().toISOString(),
    url: String(url || '').slice(0, 160),
    build,
    profileFilled,
    totals: {
      controls: fields.length,
      exported: rows.length,
      withOptions: withOptions.length,
      optionCount: withOptions.reduce((n, x) => n + x.options.length, 0),
      filledSkipped: skippedFilled.length,
    },
    // 按"为什么没填"归堆，一眼看出是词典没这个词、还是控件根本没扫到
    byReason: rows.reduce((acc, x) => { acc[x.reason || 'unplanned'] = (acc[x.reason || 'unplanned'] || 0) + 1; return acc; }, {}),
    legend: [
      'status：gap=没排上写入，red=写了但页面回读不一致，manual=交给你手动，unfilled=本次没处理',
      'options[].text = 页面上给人看的选项文案；options[].value = 提交时真正发出去的码值',
      'currentValue = 页面上当前已选中的项（可能是站点预填，也可能是你自己点过的）',
      'kind：radio=单选，checkbox=多选，select=原生下拉，combobox=自定义下拉（点不开就只能手填）',
      '本文件不含简历资料里的取值；把它发给别人前请自己确认 currentValue 是否可以外发',
    ],
    rows,
  };
}

/** 一句话摘要（侧边栏里显示，别让用户去数 JSON） */
export function describeUnfilledMap(m) {
  const opt = m.totals.withOptions;
  return `导出 ${m.totals.exported} 个控件，其中 ${opt} 个带选项（共 ${m.totals.optionCount} 组"文案 ↔ 码值"对照）`
    + `；原因分布：${Object.entries(m.byReason).slice(0, 6).map(([k, v]) => `${k} ${v}`).join('，') || '无'}`
    + (m.totals.filledSkipped ? `；已跳过 ${m.totals.filledSkipped} 个本次已写入的控件（勾「把填过的也带上」可一起导）` : '');
}
