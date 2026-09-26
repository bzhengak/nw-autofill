// 匹配流水线：页面字段描述 × profile → 分配方案（含置信分层与缺口归因）。
// 纯函数，输入是 dom/scanner.js 产出的字段描述对象，不接触 DOM。

import { buildFields, getValueByPath, equivalentsOf } from './profile-schema.js';
import { planFromAdapter, dateFormatOverride } from './adapters.js';
import { assignMaxWeight, scorePair, normalize, core, inferDateFormat, boolLike, signals, negationMismatch } from './matching.js';

const AUTO_THRESHOLD = 0.75;   // 绿：直接填
const REVIEW_THRESHOLD = 0.52; // 黄：填了但要求你复核
const TOP_K = 6;

// 绝对不碰的东西。type=file 按你的要求（附件你自己上传）只定位不操作。
const BLOCK_PATTERNS = [
  { re: /(captcha|recaptcha|滑块|验证码|校验码|语音验证码|短信验证码|人机验证|行为验证|图形验证|verif(?:ication)?\s*(?:code|check)|(?<![a-z])otp(?![a-z])|security\s*(?:code|check|question)|check\s*code)/i, reason: 'captcha' },
  { re: /(password|密码|口令|api\s*key|secret)/i, reason: 'credential' },
  { re: /(上传|附件|简历文件|upload|attachment|portfolio\s*file)/i, reason: 'file', whenFile: true },
  { re: /(自我评价|自我介绍|个人总结|个人优势|self[\s-]?introduction|about\s*me|为什么|动机|why\s*(us|you)|cover\s*letter|career\s*plan|职业规划|describe\s*your|short\s*answer|essay)/i, reason: 'subjective' },
  { re: /(测评|笔试|性格测试|认知能力|assessment|aptitude|psychometric)/i, reason: 'assessment' },
  { re: /(电子签名|签名|signature)/i, reason: 'signature' },
  // 同意类声明必须由本人勾选：某同类开源项目自动勾选"已阅读并同意隐私政策"并自动应答合规声明，
  // 这等于代替用户做法律意思表示，绝不做。
  { re: /(已阅读|已阅读并|同意并|同意本|用户协议|隐私政策|服务条款|知情同意|承诺书|声明与承诺|授权须知|i\s+agree|user\s+agreement|privacy\s+policy|terms\s+(of|and)|accept\s+the\s+terms|consent|cookie)/i, reason: 'consent_declaration' },
];

const SUBJECTIVE_OK = /(姓名|手机|电话|邮箱|身份证|证件|学历|学位|学校|专业|公司|职位|城市|日期|时间|薪资|到岗|编号|地址)/i;

/** 摊平字段里的"归属"等价：站点的「硕士」要能对上资料里的「硕士研究生 / Master」，「父亲」对上 Father */
function slotValueEquivalent(a, b) {
  const x = normalize(a), y = normalize(b);
  if (!x || !y) return false;
  if (x === y || core(x) === core(y)) return true;
  return equivalentsOf(b).some(t => {
    const n = normalize(t);
    return !!n && (x === n || core(x) === core(n));
  });
}

/**
 * 摊平型列表字段（学历：「硕士毕业学校」；家庭成员：「父亲工作单位」）→ profile 里真正属于那个归属的槽位。
 * 定位不到返回 null，交人工；绝不用"最像的那一行"猜，猜错就是把母亲单位填进父亲那行。
 */
function resolveListSlot(profile, schemaFields, slot) {
  const hits = [];
  for (let i = 0; i < 12; i++) {
    const got = String(getValueByPath(profile, `${slot.section}.${i}.${slot.keyField}`) ?? '').trim();
    if (got && slotValueEquivalent(got, slot.want)) hits.push(i);
  }
  if (!hits.length) return null;
  const path = `${slot.section}.${hits[0]}.${slot.subfield}`;
  const field = schemaFields.find(f => f.path === path);
  const value = String(getValueByPath(profile, path) ?? '').trim();
  if (!field || !value) return null;
  return { path, field, value, ambiguous: hits.length > 1, slots: hits };
}

function blockReason(pageField) {
  // Moka 这类站点的下拉框是"placeholder=Please select 的普通文本框"，没有 select 元素。
  // 往里打字不会选中任何值，反而可能把站点自己的校验搞乱 → 一律标为待人工处理。
  const ph = String(pageField.placeholder || '').trim();
  if (pageField.compositeDate) return 'composite_date';
  if (pageField.kind === 'text' && /^(please\s+select|no\s+selection|请选择|选择|pick\s+an?|请选取|select\s+an?)/i.test(ph)) return 'custom_control';
  // 真身是自定义控件（<a role=combobox>、AntD 的 div[role=combobox]）：打字不会选中任何值。
  // 在计划阶段就拒，而不是等 filler 写失败——用户看到的应该是橙色"需人工"，不是红色"填错了"。
  if (pageField.kind === 'combobox' || pageField.kind === 'listbox') return 'custom_control';
  // 密码类：label 可能为空而只靠 type=password 识别（汇丰 SF 注册面板里 "Choose Password" 的
  // 显隐按钮就是 label 空 + type=password 的形态）
  if (String(pageField.type || pageField.inputType || '').toLowerCase() === 'password') return 'credential';
  // labelRaw 是未清洗的原文：安全规则必须看到它，否则 "Security Check (CAPTCHA)"
  // 会被为匹配而做的括号剥离把 captcha 关键词洗掉
  const hay = [pageField.label, pageField.labelRaw, pageField.name, pageField.id, pageField.placeholder, pageField.ownerText, pageField.className]
    .filter(Boolean).join(' ');
  for (const rule of BLOCK_PATTERNS) {
    if (rule.whenFile && pageField.kind !== 'file') continue;
    if (rule.re.test(hay)) {
      // 主观题规则让位于明确的客观字段（"求职动机说明：期望工作城市"这类混排）
      if (rule.reason === 'subjective' && SUBJECTIVE_OK.test(core(pageField.label || ''))) continue;
      return rule.reason;
    }
  }
  // 兜底：标签没写"验证码"但形态是短码框（tel + 极短 maxLength，或 name/id 含 code）
  const meta = [pageField.name, pageField.id, pageField.testId, pageField.className].filter(Boolean).join(' ');
  const shortCode = (pageField.maxLength && pageField.maxLength <= 8) || /^(tel|number)$/i.test(pageField.type || pageField.inputType || '');
  if (shortCode && !/(zip|post|area|country|phone)\s*code|(邮编|区号)/i.test(meta) && /(^|[^a-z])(code|verif|otp|captcha)/i.test(meta)) return 'captcha';
  if (pageField.maxLength && pageField.maxLength <= 6 && /^(tel|number)$/i.test(pageField.type || pageField.inputType || '')) return 'captcha';
  return null;
}

/** 枚举/单选/多选：把 profile 的值映射到页面 option 的原始文本（跨中英等价） */
export function resolveOption(pageField, value) {
  const opts = pageField.options || [];
  if (!opts.length) return null;
  // 站点选项里夹空格是常态（"前 10%"、"1 年以内"、"GPA 3.5"），归一化不去内嵌空格就会选不中
  const sq = s => String(s || '').replace(/\s+/g, '');
  const target = sq(normalize(value));
  if (!target) return null;
  const eqs = [...new Set([target, ...equivalentsOf(value).map(x => sq(normalize(x)))])].filter(Boolean);
  const exact = opts.find(o => eqs.includes(sq(normalize(o.text))) || eqs.includes(sq(core(o.text))));
  if (exact) return exact;
  const targetSig = signals(target);
  let best = null, bestScore = 0;
  for (const o of opts) {
    const ot = sq(normalize(o.text));
    if (!ot) continue;
    if (eqs.some(eq => !negationMismatch(o.text, eq) && (ot.includes(eq) || eq.includes(ot)))) {
      // 包含即视为强匹配：'硕士' → '硕士研究生' / 'Master of Science'
      const eq = eqs.find(e => !negationMismatch(o.text, e) && (ot.includes(e) || e.includes(ot))) || target;
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
  const { pins, skip, slotPins } = planFromAdapter(pageFields, opts.adapter);
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
    const slot = (slotPins || new Map()).get(index);
    if (slot) {
      const hit = resolveListSlot(profile, schemaFields, slot);
      if (hit) {
        pinned.push({
          index, path: hit.path, label: pf.label || '', score: 1, value: hit.value,
          profileType: hit.field.type, sensitive: hit.field.sensitive,
          tier: hit.ambiguous || hit.field.sensitive ? 'review' : 'auto', pinned: true,
          note: hit.ambiguous ? `资料里有 ${hit.slots.length} 行「${slot.want}」，取第一行，请复核` : `按「${slot.want}」定位槽位`,
        });
      } else {
        gaps.push({ index, label: pf.label || '(无标签)', reason: slot.gapReason, kind: pf.kind, note: `资料里没有「${slot.want}」这一行（或该栏为空），需人工填写` });
      }
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
