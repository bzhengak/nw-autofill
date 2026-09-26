// 匹配流水线：页面字段描述 × profile → 分配方案（含置信分层与缺口归因）。
// 纯函数，输入是 dom/scanner.js 产出的字段描述对象，不接触 DOM。

import { buildFields, getValueByPath, equivalentsOf } from './profile-schema.js';
import { planFromAdapter, dateFormatOverride } from './adapters.js';
import { assignMaxWeight, scorePair, normalize, core, inferDateFormat, boolLike, signals } from './matching.js';

const AUTO_THRESHOLD = 0.75;   // 绿：直接填
const REVIEW_THRESHOLD = 0.52; // 黄：填了但要求你复核
const TOP_K = 6;

// 绝对不碰的东西。type=file 按你的要求（附件你自己上传）只定位不操作。
const BLOCK_PATTERNS = [
  { re: /(captcha|recaptcha|滑块|验证码|图形验证|人机验证|行为验证)/i, reason: 'captcha' },
  { re: /(password|密码|口令|api\s*key|secret)/i, reason: 'credential' },
  { re: /(上传|附件|简历文件|upload|attachment|portfolio\s*file)/i, reason: 'file', whenFile: true },
  { re: /(自我评价|自我介绍|个人总结|为什么|动机|why\s*(us|you)|cover\s*letter|career\s*plan|职业规划|describe\s*your|short\s*answer|essay)/i, reason: 'subjective' },
  { re: /(测评|笔试|性格测试|认知能力|assessment|aptitude|psychometric)/i, reason: 'assessment' },
  { re: /(电子签名|签名|signature|同意并|授权)/i, reason: 'signature' },
];

const SUBJECTIVE_OK = /(姓名|手机|电话|邮箱|身份证|证件|学历|学位|学校|专业|公司|职位|城市|日期|时间|薪资|到岗|编号|地址)/i;

function blockReason(pageField) {
  const hay = [pageField.label, pageField.name, pageField.id, pageField.placeholder, pageField.ownerText, pageField.className]
    .filter(Boolean).join(' ');
  for (const rule of BLOCK_PATTERNS) {
    if (rule.whenFile && pageField.kind !== 'file') continue;
    if (rule.re.test(hay)) {
      // 主观题规则让位于明确的客观字段（"求职动机说明：期望工作城市"这类混排）
      if (rule.reason === 'subjective' && SUBJECTIVE_OK.test(core(pageField.label || ''))) continue;
      return rule.reason;
    }
  }
  return null;
}

/** 枚举/单选/多选：把 profile 的值映射到页面 option 的原始文本（跨中英等价） */
export function resolveOption(pageField, value) {
  const opts = pageField.options || [];
  if (!opts.length) return null;
  const target = normalize(value);
  if (!target) return null;
  const eqs = equivalentsOf(value).map(x => normalize(x)).filter(Boolean);
  const exact = opts.find(o => eqs.includes(normalize(o.text)) || eqs.includes(core(o.text)));
  if (exact) return exact;
  const targetSig = signals(target);
  let best = null, bestScore = 0;
  for (const o of opts) {
    const ot = normalize(o.text);
    if (!ot) continue;
    if (eqs.some(eq => ot.includes(eq) || eq.includes(ot))) {
      // 包含即视为强匹配：'硕士' → '硕士研究生' / 'Master of Science'
      const eq = eqs.find(e => ot.includes(e) || e.includes(ot)) || target;
      const ratio = Math.min(ot.length, eq.length) / Math.max(ot.length, eq.length);
      const s = 0.62 + 0.38 * ratio;
      if (s > bestScore) { bestScore = s; best = o; }
      continue;
    }
    const shared = [...os_tokens(ot)].filter(t => targetSig.tokens.has(t) && t.length >= 2).length;
    if (shared) {
      const s = shared / Math.max(1, os_tokens(ot).size) * 0.7;
      if (s > bestScore) { bestScore = s; best = o; }
    }
  }
  return bestScore >= 0.5 ? best : null;
}

function os_tokens(text) {
  return signals(text).tokens;
}

/**
 * @param {Array} pageFields  dom/scanner.js 的字段描述
 * @param {Object} profile    createEmptyProfile() 形状的数据
 * @param {Object} opts       { mode: 'full'|'incremental'|'selection', allowAiCandidates:false }
 */
export function planFill(pageFields, profile, opts = {}) {
  const mode = opts.mode || 'full';
  const schemaFields = buildFields();
  const { pins, skip } = planFromAdapter(pageFields, opts.adapter);
  const pinned = [];
  const assignments = [];
  const gaps = [];
  const considered = [];

  pageFields.forEach((pf, index) => {
    const blocked = blockReason(pf);
    if (blocked) {
      gaps.push({ index, label: pf.label || pf.name || pf.id || '(未命名字段)', reason: blocked, kind: pf.kind });
      return;
    }
    if (skip.has(index)) {
      gaps.push({ index, label: pf.label || '(无标签)', reason: skip.get(index), kind: pf.kind });
      return;
    }
    const pinPath = pins.get(index);
    if (pinPath) {
      const pinField = schemaFields.find(f => f.path === pinPath);
      const pinValue = String(getValueByPath(profile, pinPath) ?? '').trim();
      if (pinField && pinValue) {
        pinned.push({
          index, path: pinPath, label: pf.label || '', score: 1, value: pinValue,
          profileType: pinField.type, sensitive: pinField.sensitive,
          tier: pinField.sensitive ? 'review' : 'auto', pinned: true,
        });
      } else {
        gaps.push({ index, label: pf.label || '(无标签)', reason: 'pinned_field_empty', kind: pf.kind });
      }
      return;
    }
    const hasValue = String(pf.currentValue ?? '').trim() !== '';
    if (mode === 'incremental' && hasValue) {
      assignments.push({ index, skip: true, reason: 'already_filled' });
      return;
    }

    const candidates = [];
    for (let c = 0; c < schemaFields.length; c++) {
      const sf = schemaFields[c];
      const value = String(getValueByPath(profile, sf.path) ?? '').trim();
      if (!value) continue;
      const s = scorePair(pf, sf);
      if (s >= REVIEW_THRESHOLD) candidates.push({ c, sf, value, s });
    }
    candidates.sort((a, b) => b.s - a.s);
    considered.push({ index, top: candidates.slice(0, TOP_K) });
  });

  // 构造稀疏代价矩阵：行 = 有候选的页面字段，列 = 出现过的 profile 索引
  const rows = [];
  const colSet = new Map();
  for (const item of considered) {
    if (!item.top.length) {
      gaps.push({
        index: item.index,
        label: pageFields[item.index].label || '(未命名字段)',
        reason: pageFields[item.index].required ? 'required_no_candidate' : 'no_candidate',
        kind: pageFields[item.index].kind,
      });
      continue;
    }
    const row = { index: item.index, cells: [] };
    for (const cand of item.top) {
      if (!colSet.has(cand.c)) colSet.set(cand.c, colSet.size);
      row.cells.push({ col: colSet.get(cand.c), score: cand.s, cand });
    }
    rows.push(row);
  }

  const nCols = colSet.size;
  const matrix = rows.map(r => {
    const arr = new Array(nCols).fill(0);
    for (const cell of r.cells) arr[cell.col] = cell.score;
    return arr;
  });
  const matched = assignMaxWeight(matrix, nCols);
  const byRow = new Map(matched.map(a => [a.row, a]));

  rows.forEach((row, ri) => {
    const pf = pageFields[row.index];
    const hit = byRow.get(ri);
    const chosen = hit ? row.cells.find(c => c.col === hit.col) : null;
    if (!chosen) {
      gaps.push({ index: row.index, label: pf.label || '(未命名字段)', reason: 'conflict_unresolved', kind: pf.kind });
      return;
    }
    const { sf, value } = chosen.cand;
    const entry = {
      index: row.index,
      path: sf.path,
      label: pf.label || pf.name || '',
      score: Number(chosen.score.toFixed(3)),
      value,
      profileType: sf.type,
      sensitive: Boolean(sf.sensitive),
      tier: chosen.score >= AUTO_THRESHOLD && !sf.sensitive ? 'auto' : 'review',
    };
    if (sf.sensitive && chosen.score >= AUTO_THRESHOLD) entry.reason = 'sensitive_requires_review';

    if (entry.tier === 'review' && chosen.score < AUTO_THRESHOLD) entry.note = '置信度不足，请复核';

    if (pf.kind === 'select' || pf.kind === 'radio' || pf.kind === 'checkbox' || sf.type === 'enum' || sf.type === 'bool') {
      const pageOptions = pf.options || [];
      let option = null;
      if (sf.type === 'bool') {
        const want = boolLike(value);
        if (want === null) {
          option = resolveOption(pf, value);
        } else {
          // 页面上可能是 是/否、有/无、Yes/No、T/F、同意/不同意，统一用 boolLike 折成布尔再比
          option = pageOptions.find(o => boolLike(o.text) === want) || null;
        }
      } else {
        option = resolveOption(pf, value);
      }
      if (option) entry.optionValue = option.value ?? option.text;
      else if (pageOptions.length) { entry.tier = 'review'; entry.note = '页面选项与你的资料无对应，需人工选择'; delete entry.value; }
    }

    const adapterDate = dateFormatOverride(opts.adapter, pf);
    if (adapterDate || sf.type === 'date' || sf.type === 'month' || sf.type === 'year' || pf.type === 'date') {
      entry.dateFormat = adapterDate
        || (sf.type === 'year' ? 'yyyy'
          : sf.type === 'month' ? inferDateFormat({ label: pf.label, placeholder: pf.placeholder, sample: pf.sampleValue, inputType: pf.inputType === 'month' ? 'month' : '' })
            : inferDateFormat({ label: pf.label, placeholder: pf.placeholder, sample: pf.sampleValue, inputType: pf.inputType }));
      if (entry.dateFormat === 'yyyy-MM-dd' && sf.type === 'month') entry.dateFormat = 'yyyy-MM';
    }
    assignments.push(entry);
  });

  // 钉位字段：跳过打分竞争，直接指定路径，但同样要解析 option 与日期格式
  for (const entry of pinned) {
    const pf = pageFields[entry.index];
    if (pf.kind === 'select' || pf.kind === 'radio' || pf.kind === 'checkbox') {
      const opt = resolveOption(pf, entry.value);
      if (opt) entry.optionValue = opt.value ?? opt.text;
      else { entry.tier = 'review'; entry.note = '页面选项与你的资料无对应，需人工选择'; }
    }
    const df = dateFormatOverride(opts.adapter, pf);
    if (df) entry.dateFormat = df;
    else if (entry.profileType === 'date' || entry.profileType === 'month') {
      entry.dateFormat = inferDateFormat({ label: pf.label, placeholder: pf.placeholder, sample: pf.sampleValue, inputType: pf.inputType });
    }
    assignments.push(entry);
  }

  const total = pageFields.length;
  const stats = {
    scanned: total,
    planned: assignments.filter(a => !a.skip).length,
    auto: assignments.filter(a => a.tier === 'auto').length,
    review: assignments.filter(a => a.tier === 'review').length,
    gaps: gaps.length,
    skipped: assignments.filter(a => a.skip).length,
    gapReasons: gaps.reduce((acc, g) => (acc[g.reason] = (acc[g.reason] || 0) + 1, acc), {}),
  };
  return { assignments, gaps, stats, aiPending: gaps.filter(g => ['no_candidate', 'required_no_candidate', 'conflict_unresolved'].includes(g.reason)) };
}
