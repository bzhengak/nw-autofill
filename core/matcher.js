// 匹配流水线：页面字段描述 × profile → 分配方案（含置信分层与缺口归因）。
// 纯函数，输入是 dom/scanner.js 产出的字段描述对象，不接触 DOM。

import { buildFields, getValueByPath, equivalentsOf, isLangNeutral } from './profile-schema.js';
import { planFromAdapter, dateFormatOverride } from './adapters.js';
import { assignMaxWeight, scorePair, normalize, core, inferDateFormat, boolLike, signals, negationMismatch, AMBIGUOUS_SECTIONS, dateParts, isQuestionLabel } from './matching.js';

const AUTO_THRESHOLD = 0.75;   // 绿：直接填
const REVIEW_THRESHOLD = 0.52; // 黄：填了但要求你复核
const TOP_K = 6;

// 绝对不碰的东西。type=file 按你的要求（附件你自己上传）只定位不操作。
const BLOCK_PATTERNS = [
  { re: /(captcha|recaptcha|滑块|验证码|校验码|语音验证码|短信验证码|人机验证|行为验证|图形验证|verif(?:ication)?\s*(?:code|check)|(?<![a-z])otp(?![a-z])|security\s*(?:code|check|question)|check\s*code)/i, reason: 'captcha' },
  { re: /(password|密码|口令|api\s*key|secret)/i, reason: 'credential' },
  // 主观题名单要覆盖英文问句：Sea 自建页的 "Beyond the GMAP program, which functions interest you?"
  // 是动机题，以前只靠 why you / describe your 这些词蹭，漏进来的结果是"没有候选"（看着像我们缺词），
  // 实际是这题根本不该由机器答。归因错了，用户就会去补资料而不是去写答案。
  { re: /(自我评价|自我描述|自我介绍|个人简介|个人总结|个人优势|self[\s-]?introduction|about\s*me|why\s*you|profile\s*summary|为什么|动机|cover\s*letter|career\s*plan|职业规划|describe\s*your|short\s*answer|essay|which\s+\w+\s+(?:interest|appeal|attract)|interest(?:s|ing)?\s+you|(额外|其他|其它)\s*(信息|说明|备注))/i, reason: 'subjective' },
  { re: /(测评|笔试|性格测试|认知能力|assessment|aptitude|psychometric)/i, reason: 'assessment' },
  { re: /(电子签名|签名|signature)/i, reason: 'signature' },
  // 同意类声明必须由本人勾选：某同类开源项目自动勾选"已阅读并同意隐私政策"并自动应答合规声明，
  // 这等于代替用户做法律意思表示，绝不做。
  { re: /(已阅读|已阅读并|同意并|同意本|用户协议|隐私政策|服务条款|知情同意|承诺书|声明与承诺|授权须知|i\s+agree|user\s+agreement|privacy\s+policy|terms\s+(of|and)|accept\s+the\s+terms|consent|cookie)/i, reason: 'consent_declaration' },
];

const SUBJECTIVE_OK = /(姓名|手机|电话|邮箱|身份证|证件|学历|学位|学校|专业|公司|职位|城市|日期|时间|薪资|到岗|编号|地址)/i;

// 问句式标签的判定住在 matching.js：scorePair 也要用它（问句没有"末词即中心词"的结构），
// 两边各写一份必然漂移。这里继续转出它，免得调用方改 import 路径。
export { isQuestionLabel } from './matching.js';

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

/**
 * 年框+月框这一组的"合成提问"。
 * 角色是从标签里读出来的（Workday 的「自」/「至」、Moka 的「硕士开始时间」）→ 保留原标签，
 * 只补规范词，因为原标签本身带着"哪一段经历的哪个时间"这类信息。
 * 角色只是按文档顺序推断的（Moka 把 年/月/年/月 四个框塞在一句「起止时间」下）→ 原标签
 * 必须丢掉：那句"起止时间"同时问着两个框，留着它只会稀释词元，实测把 开始时间 的打分
 * 从 0.91 拖到 0.75，两个日期框会一起掉到待复核线以下，等于什么都没填。
 */
function dateGroupLabel(label, group) {
  const member = group.members.find(m => m.role);
  if (!member) return label;
  const canonical = member.role === 'start' ? '开始时间 start date from' : '结束时间 end date to';
  return member.roleSource === 'label' ? `${label} ${canonical}`.trim() : canonical;
}

/**
 * 缺口原因的中文说明。界面直接印内部 token（`custom_control`、`no_candidate`）时，
 * 用户只知道"这栏没填上"，不知道下一步该做什么 —— 每条都写成"是什么 + 下一步"。
 * 原始 token 由界面放在 title 里，报障时两边都对得上。
 */
export const GAP_REASON_ZH = {
  file: '附件得你自己上传 —— 插件不碰文件',
  custom_control: '这是站点自己的下拉/日期面板，打字不会选中；需要你点开手填（已授权的会自动尝试选，选不中还是你来）',
  composite_date: '这一栏是"年 + 月"两个框拼起来的，站点要你自己选；整组交人工',
  credential: '账号/密码类由你本人填，插件不代填',
  captcha: '验证码必须由人点，插件不碰',
  no_candidate: '本地词典没有这个说法；可以在资料里补一个别名，或用「AI 兜底」问一次',
  required_no_candidate: '必填，但本地词典没有这个说法；同上，补别名或问 AI',
  conflict_unresolved: '几个候选势均力敌，不敢替你选；在表格里点一下自己定',
  site_search: '这是站点自己的搜索框（"请输入职位或企业名称"），不是简历字段，故意不填',
  readonly_control: '站点只读或由它自己推导，不需要填',
  date_picker: '这是站点的日期/时间日历控件：打字进不去，需要你点开选（插件不代点日历，避免把日期写错还显示成成功）',
  missing_english_value: '这一页是英文表单，而你这一槽只填了中文写法 —— 已故意不写入：切到「English 表单」补一条英文值再扫（不想补就在设置里开"缺英文时写中文并标黄"）',
  consent_declaration: '同意/授权/声明类必须你本人表态，插件不代勾选',
  declaration: '声明类文本由你本人签，插件不代写',
  conditional_other: '条件题：要先答完前面那一题，这一栏才有意义',
  optional_link: '链接类（个人主页等），资料里没有就不填',
  subjective: '主观题（自我评价、职业规划等）由你写，插件不代生成',
  sensitive_withheld: '敏感字段（证件号等）默认不自动写，勾选「允许填写敏感字段」后才会写',
  ai_empty_slot: 'AI 指认的槽位在你资料里是空的 —— 去资料里补上再扫',
  choice_required: '选项列表里没有和资料对得上的项，需要你人工选一个',
  panel_ambiguous: '点下去之后没能确认"哪个弹层属于这一栏"（这一屏同排着好几个下拉）—— 为了不误点到别栏的选项，这一栏交给你手点',
  dial_code_only: '这一整列选项都是电话区号（+86 / +852…），说明它是"国家/地区区号"下拉，不是资料里那个值该去的地方 —— 已故意不选，去检查这一格配的是哪个槽位',
  empty_value: '这一栏我们没拿到要写的值（资料里是空的），已跳过 —— 不会往页面写 undefined 之类的占位文字',
  slot_empty: '页面这一栏最匹配的资料位是空的：我们没有拿别的栏位顶替（顶替就是错填），去资料里补上再扫',
  pinned_field_empty: '这一栏被站点题目钉死到某个资料位，而那个资料位是空的 —— 去资料里补这一栏，我们不拿别的东西顶',
  block_ambiguous: '这一栏的标签在资料里好几个板块都有同名位，页面上又没有板块标题可依 —— 按资料顺序轮值是猜，交给你手动选',
  language_slot_unresolved: '这一栏的标题是一种语言或考试名（IELTS / 粤语…），但你资料的语言栏里没有对应那一行 —— 去「分类编辑 · 语言」补一行，我不按顺序猜',
};

export function gapReasonLabel(reason) {
  const key = String(reason || '');
  return GAP_REASON_ZH[key] || key || '未知原因';
}

function blockReason(pageField) {
  // 附件按控件类型拒，不看标签：Sea 的 label 是 "Resume"/"Transcript"、Workday 是「简历履历」，
  // 用关键词名单永远漏一批，漏进来的会被报成"我们没有这个词"（no_candidate），
  // 用户于是去补资料，而真正的答案是"这一栏得你自己上传"。
  if (pageField.kind === 'file') return 'file';
  // Moka 这类站点的下拉框是"placeholder=Please select 的普通文本框"，没有 select 元素。
  // 往里打字不会选中任何值，反而可能把站点自己的校验搞乱 → 一律标为待人工处理。
  const ph = String(pageField.placeholder || '').trim();
  if (pageField.compositeDate) return 'composite_date';
  // 自定义下拉的首选判据是扫描器给的结构化标记（在框架 wrapper 里）；
  // placeholder 文案那条只作为兜底 —— AntD 搜索型占位符写的是"搜索城市"，靠文案会漏。
  if (pageField.customSelect) return 'custom_control';
  // 日期/日历控件要单独一条原因：它和下拉同属"打字进不去"，但下一步动作不一样 ——
  // 下拉是「点开选一项」，日历是「点开选年月」，混在一起用户照着提示找不到北。
  // 判据看 placeholder + 类名（"请选择开始时间"、.ant-picker），不看标签字面，
  // 免得 Moka 那种「出生日期（年龄）」由身份证推导的只读框也被提示去点日历。
  const dateTimeish = /(时间|日期|年月|date|time|birthday)/i.test(`${pageField.label || ''} ${ph} ${pageField.id || ''} ${pageField.className || ''}`);
  if (dateTimeish && (/^(请选择|请选取|选择|pick|select)/i.test(ph) || /(picker|calendar)/i.test(String(pageField.className || '')))) return 'date_picker';
  if (pageField.kind === 'text' && /^(please\s+select|no\s+selection|请选择|选择|pick\s+an?|请选取|select\s+an?)/i.test(ph)) return 'custom_control';
  // 站点自己的搜索框（简历页顶部几乎必有）。判据两条形之一：
  //  · placeholder 是搜索语气（"请输入职位或企业名称"、"搜索城市"），且这一栏没有真标签；
  //  · name/id 里带 search|query|keyword，且这一栏没有真标签。
  // 为什么必须先看"有没有真标签"：带标签的输入框是表单字段，哪怕它的 placeholder 也写着"请输入"。
  // 国聘真实导出里「请输入职位或企业名称」被当成槽位，抢走了 intent.position，
  // 于是页面里真正的「期望岗位」只能去抢 internship.0.title —— 一个搜索框打乱了整条分配链。
  const searchish = /(搜索|查找|search|keyword|关键词)/i.test(ph) || /^请(输入|填写).{0,20}(或|\/|、).{0,20}$/.test(ph);
  const searchMeta = /(search|query|keyword)/i.test(`${pageField.name || ''} ${pageField.id || ''}`);
  if ((pageField.kind === 'text' || pageField.kind === 'search') && !core(pageField.label) && (searchish || searchMeta)) return 'site_search';
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
 * 站点自己说出来的「资料取值 → 页面选项」对照（adapter.optionRules）。
 *
 * 为什么需要它，而不是让 resolveOption 或 AI 去够：Work Permit 那一栏页面给的是 Yes/No，
 * 资料里存的却是枚举（本地居民 / 需申请工作签证）。两边字面永远对不上，
 * 相似度会把"需申请工作签证"和"需要担保"这类词互相拉扯 —— 而这是一句合规声明，
 * 猜错等于替用户表态。所以对照表由适配器**逐条写死**，且：
 *  · 资料取值只在 yes 侧或只在 no 侧出现才作数（两边都提或都没提 → 不选）；
 *  · 页面选项里必须恰好一项落进该侧（两项都命中同样说不清 → 不选）；
 *  · 只有这一栏最后拿到的槽位等于规则声明的槽位时才生效（见调用处）。
 * 任何一条不满足就返回 null，让这一栏照旧交人工。
 */
export function optionRulePick(rule, value, pageField) {
  if (!rule || !pageField) return null;
  const opts = (pageField.options || []).filter(o => o && (o.text || o.value));
  if (!opts.length) return null;
  const sq = s => String(normalize(s) || '').replace(/\s+/g, '');
  const v = sq(value);
  if (!v) return null;
  const list = side => ((rule.when && rule.when[side]) || []).map(sq).filter(Boolean);
  const hits = side => list(side).some(t => v === t || v.includes(t));
  const yes = hits('yes');
  const no = hits('no');
  if (yes === no) return null;
  const polarity = yes ? 'yes' : 'no';
  const aliases = ((rule.pick && rule.pick[polarity]) || []).map(x => ({ raw: sq(x), src: String(x || '') }))
    .filter(a => a.raw);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const landing = opts.filter(o => {
    const t = sq(o.text);
    if (!t) return false;
    return aliases.some(a => {
      // '有' 不能落进 '没有'、'yes' 不能落进 'not yet'：被否定的那种写法一律不算
      if (negationMismatch(o.text, a.src)) return false;
      if (t === a.raw) return true;
      if (!t.includes(a.raw)) return false;
      // 拉丁词要整词命中：别名 'no' 不该落进 'Note' / 'nationwide'
      return /^[a-z0-9]+$/.test(a.raw) ? new RegExp(`(^|[^a-z0-9])${esc(a.raw)}([^a-z0-9]|$)`, 'i').test(t) : true;
    });
  });
  return landing.length === 1 ? landing[0] : null;
}

/** 规则只允许管它自己写明的那个槽位：这一栏最后拿到的是别的路径，规则就当没写过 */
function rulePickFor(entry, pageField, optionRules) {
  const rule = (optionRules || new Map()).get(entry.index);
  if (!rule || String(rule.path || '') !== String(entry.path || '')) return null;
  return optionRulePick(rule, entry.value ?? entry.optionValue, pageField);
}

/**
 * @param {Array} pageFields  dom/scanner.js 的字段描述
 * @param {Object} profile    createEmptyProfile() 形状的数据
 * @param {Object} opts       { mode: 'full'|'incremental'|'selection', allowAiCandidates:false }
 */
/**
 * 这一页是英文表单还是中文表单。
 * 判据只用"页面自己的标签文字"，不看域名也不看站点 id（自建门户什么域名都有）：
 *  · 任何一栏标签里出现中日韩字符 → 中文页（中英并排的"姓名 Name"本来就接受中文写法）；
 *  · 否则有 ≥2 栏纯拉丁标签 → 英文页。
 * 门槛定在 2 而不是 1：一个孤立英文标签（中文门户上"Name / Email"混着放）就把整页判成英文，
 * 会让一屏栏位集体变成"缺英文值"，那种误伤比漏判更烦人。
 * 向导式站点每步栏位很少，所以 2 栏足够触发 —— 分步填写正是英文站的常态。
 * @returns {'en'|'zh'}
 */
export function detectPageLanguage(pageFields = []) {
  const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
  let latin = 0;
  for (const pf of pageFields) {
    const t = String(pf?.label || '').trim();
    if (!t) continue;
    if (CJK.test(t)) return 'zh';
    if (/[A-Za-z]{2,}/.test(t)) latin++;
  }
  return latin >= 2 ? 'en' : 'zh';
}

/**
 * 页面这一栏自己就要中文（KPMG/Moka 的 "Chinese name"、"中文姓名"）。
 * 这时"英文页面上不写中文"是错的直觉 —— 它问的就是中文，写拼音才是填错。
 * 判分工具与填写用同一个函数，避免两边各判一次判出两个结果。
 */
export function pageRequestsChinese(pf) {
  return /中文|汉语|chinese/i.test(`${pf?.labelRaw || ''} ${pf?.label || ''} ${pf?.placeholder || ''}`);
}

/** 取值里还留着中日韩字符（日期/数字/纯拉丁不算） */
export function hasCjk(value) {
  return /[\u3400-\u9fff]/.test(String(value || ''));
}

export function planFill(pageFields, profile, opts = {}) {
  const mode = opts.mode || 'full';
  const schemaFields = buildFields();
  // ── 中英两份取值：这一页要的是哪一份 ────────────────────────────────
  // 英文页面（SF / Workday / 港企自建）拿 profile.en.<路径>；中文页面拿原路径。
  // 缺英文值时默认**不写**（用户明确要求"不写，列入待你处理"）：
  // 把「南京大学」写进英文名栏位是看起来填好了、实际全错的典型事故。
  // enMissingMode='zh_yellow' 才允许退回中文值，且强制黄字。
  const pageLang = opts.lang || detectPageLanguage(pageFields);
  const zhFallback = String(opts.enMissingMode || '') === 'zh_yellow';
  const fieldByPath = new Map(schemaFields.map(f => [f.path, f]));
  const missingEnglish = new Set();     // 中文有值、英文没值
  const viaZhFallback = new Set();      // 本轮真的用了中文兜底的槽位
  const valueOf = (path, pf) => {
    const base = String(getValueByPath(profile, path) ?? '').trim();
    if (pageLang !== 'en' || isLangNeutral(fieldByPath.get(path) || { path })) return base;
    if (pageRequestsChinese(pf)) return base;
    // 值里本来就没有中日韩字符（拼音姓名 Zhang/Wei、China、178、GPA…）：
    // 英文表单要的就是它，不需要用户再抄一遍。要求"每栏填两遍"是把功能做成负担。
    if (base && !hasCjk(base)) return base;
    const en = String(getValueByPath(profile, `en.${path}`) ?? '').trim();
    if (en) return en;
    if (!base) return '';
    missingEnglish.add(path);
    if (zhFallback) {
      viaZhFallback.add(path);
      return base;
    }
    return '';
  };
  const { pins, skip, slotPins, optionRules } = planFromAdapter(pageFields, opts.adapter);
  const pinned = [];
  const assignments = [];
  const gaps = [];
  const considered = [];
  // 「年框 + 月框」是同一个问题拆出来的两个框：整组只能占一个 profile 槽位，
  // 否则两个框会各自去抢日期列（把月份写进年份框、或把开始/结束对调）。
  // 所以这里把组收敛成"组长行"（年框），成员在落笔时再展开成两笔。
  const pairGroups = new Map();
  pageFields.forEach((pf, index) => {
    const dp = pf.datePair;
    if (!dp) return;
    if (!pairGroups.has(dp.id)) pairGroups.set(dp.id, { id: dp.id, members: [] });
    const g = pairGroups.get(dp.id);
    g.members.push({ index, part: dp.part, role: dp.role, roleSource: dp.roleSource });
  });
  const groupOfIndex = new Map();
  for (const g of pairGroups.values()) {
    const year = g.members.find(m => m.part === 'year');
    const month = g.members.find(m => m.part === 'month');
    g.complete = Boolean(year && month);
    g.leader = year ? year.index : (month ? month.index : -1);
    // 角色是照标签读的（Workday 的「自」/「至」）还是只按文档顺序推的（Moka 四个框同一句标签）：
    // 后者是我们猜的，必须降级为待复核
    g.inferredRole = g.members.some(m => m.role && m.roleSource === 'order');
    g.roleSource = (g.members.find(m => m.roleSource) || {}).roleSource || null;
    for (const m of g.members) groupOfIndex.set(m.index, g);
  }
  // 组里任何一个成员被适配器钉住 = 整组钉住：年框和月框问的是同一件事，
  // 只钉月框（Moka 的 data-nw-test 常两个框各有一条规则）也必须让组长拿到那个槽位。
  for (const g of pairGroups.values()) {
    if (!g.complete || pins.has(g.leader) || (slotPins || new Map()).has(g.leader)) continue;
    for (const m of g.members) {
      if (pins.has(m.index)) { pins.set(g.leader, pins.get(m.index)); break; }
      if ((slotPins || new Map()).has(m.index)) { slotPins.set(g.leader, slotPins.get(m.index)); break; }
    }
  }
  // 敏感字段（证件号/手机号等）默认不写入：设置项 fillSensitive 明确打开才写。
  // 这条以前只是界面上一个复选框，没人读它——等于承诺了但没做。
  const allowSensitive = opts.fillSensitive === true;
  // 用户授权"可以点开自定义下拉"时，这类控件不再在计划阶段整栏拒掉；
  // 但选项文本在计划时还不存在于 DOM（点了才渲染），所以匹配交给写入层现场做，
  // 这里只负责把语义打分跑完、并给这一笔打上 customSelect 标记。
  const allowCustomSelect = opts.allowCustomSelect === true;
  const withheld = field => Boolean(field && field.sensitive) && !allowSensitive;

  pageFields.forEach((pf, index) => {
    const group = groupOfIndex.get(index);
    if (group && group.complete && index !== group.leader) return;   // 成员由组长代表，不单独出行
    const asDate = Boolean(group && group.complete);
    const blocked = blockReason(asDate ? { ...pf, compositeDate: undefined } : pf);
    if (blocked && !(allowCustomSelect && blocked === 'custom_control')) {
      gaps.push({ index, label: pf.label || pf.name || pf.id || '(未命名字段)', reason: blocked, kind: pf.kind });
      return;
    }
    // 只读框是站点自己算出来的（Moka 的"出生日期 (年龄)"由身份证推导、账号带出的姓名手机等）：
    // 计划里出现它就注定一条红，还会让人以为是我们填不动。
    // 例外：Element/AntD 的下拉内层 input 天生 readonly —— 那是"不让你打字"，
    // 不是"站点算好了不让你改"，混在一起会把整个下拉误判成只读控件。
    if (pf.readOnly && pf.kind !== 'contenteditable' && !pf.customSelect) {
      // 只读框要分两种，因为下一步动作完全不同：
      //  · 日期/时间控件：真的要填，但要你点开日历面板选（打字进不去）；
      //  · 站点自己算出来的（身份证推出生日期、账号带出姓名）：本来就不该填。
      // 判据不能只看标签里有"日期"两字 —— Moka 的「出生日期（年龄）」也是只读，
      // 但它是身份证推出来的，提示用户"去点开选"就是误导。日历控件的特征在 placeholder 与类名上。
      const picker = /^(请选择|请选取|选择|pick|select)/i.test(String(pf.placeholder || '').trim())
        || /(picker|calendar|date-|_date|时间|日期)/i.test(`${pf.className || ''} ${pf.id || ''} ${pf.name || ''}`);
      gaps.push({
        index,
        label: pf.label || pf.name || pf.id || '(未命名字段)',
        reason: picker ? 'date_picker' : 'readonly_control',
        kind: pf.kind,
        note: picker ? '' : '站点只读/自动推导，无需填写',
      });
      return;
    }
    if (skip.has(index)) {
      gaps.push({ index, label: pf.label || '(无标签)', reason: skip.get(index), kind: pf.kind });
      return;
    }
    const slot = (slotPins || new Map()).get(index);
    if (slot) {
      const hit = resolveListSlot(profile, schemaFields, slot);
      if (hit && withheld(hit.field)) {
        gaps.push({ index, label: pf.label || '(无标签)', reason: 'sensitive_withheld', kind: pf.kind, note: `敏感字段（${hit.path}）默认不自动写，勾选「允许填写敏感字段」后再来` });
        return;
      }
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
      if (pinField && pinValue && withheld(pinField)) {
        gaps.push({ index, label: pf.label || '(无标签)', reason: 'sensitive_withheld', kind: pf.kind, note: '敏感字段默认不自动写，勾选后才填' });
        return;
      }
      if (pinField && pinValue) {
        pinned.push({
          index, path: pinPath, label: pf.label || '', score: 1, value: pinValue,
          profileType: pinField.type, sensitive: pinField.sensitive,
          tier: pinField.sensitive ? 'review' : 'auto', pinned: true,
        });
      } else {
        gaps.push({
          index, label: pf.label || '(无标签)', reason: 'pinned_field_empty', kind: pf.kind,
          slotPath: pinPath,
          note: `这一栏按站点题目对应到「${pinField.zh || pinPath}」，但你资料里那一栏是空的 —— 补上再扫（适配器钉住了槽位，我们没有拿别的栏位顶替）`,
        });
      }
      return;
    }
    const memberFilled = m => String(pageFields[m.index].currentValue ?? '').trim() !== '';
    const hasValue = group && group.complete
      ? group.members.every(memberFilled)          // 拆开的日期框：只填了年不算填过这一栏
      : String(pf.currentValue ?? '').trim() !== '';
    if (mode === 'incremental' && hasValue) {
      if (group && group.complete) for (const m of group.members) assignments.push({ index: m.index, skip: true, reason: 'already_filled' });
      else assignments.push({ index, skip: true, reason: 'already_filled' });
      return;
    }

    // 日期组用一个"合成提问"去打标：标签补上起止角色词、占位符清空
    // （占位符是「年」「月」，留着会把 inferDateFormat 带偏成单段格式）
    const scoring = asDate ? { ...pf, compositeDate: undefined, placeholder: '', label: dateGroupLabel(pf.label, group) } : pf;
    const dateish = sf => sf.type === 'date' || sf.type === 'month' || sf.type === 'year';
    const candidates = [];
    const nearMissEn = [];
    let emptyBest = null;      // 按标签最匹配、但资料里是空的那个槽位（见下面"空槽优先"）
    const questionish = isQuestionLabel(pf.labelRaw || pf.label);
    for (let c = 0; c < schemaFields.length; c++) {
      const sf = schemaFields[c];
      if (asDate && !dateish(sf)) continue;        // 年框+月框问的就是一个日期，别让它去抢文本栏
      const s = scorePair(scoring, sf);
      const value = valueOf(sf.path, scoring);
      if (!value) {
        if (s >= REVIEW_THRESHOLD && (!emptyBest || s > emptyBest.s)) emptyBest = { sf, s };
        // 英文页面上"这一槽只有中文值"不能算"我们没有这个词"：
        // 先记下按标签本来能匹配到（near miss），缺口就报成 missing_english_value，
        // 用户看到的下一步是"去 EN 表单补这一栏的英文写法"，而不是"去补别名"。
        if (pageLang === 'en' && missingEnglish.has(sf.path) && s >= REVIEW_THRESHOLD) {
          nearMissEn.push({ sf, s });
        }
        continue;
      }
      // 问句式标签：港企/SF 里"Do you require sponsorship?"这类是合规判断题（bool/enum），该填；
      // 而"which functions interest you?"这类动机题靠词元重合能蹭到"兴趣爱好"，必须挡住。
      // 折中：问句只允许 bool/enum 目标，或字面/主干命中（≥0.95）的文本目标。
      if (questionish && s < 0.95 && sf.type !== 'bool' && sf.type !== 'enum') continue;
      if (s >= REVIEW_THRESHOLD) candidates.push({ c, sf, value, s });
    }
    candidates.sort((a, b) => b.s - a.s);
    /**
     * 「定语说了算」：英文标签是右分支结构，School Name / Referrer Name / Organization Name
     * 的中心词都是那个通用词 name，但**问的是定语那一个**。scorePair 是成对打分、看不见对手，
     * 于是裸词 name 的槽位（姓名 0.695）会压过真正被点名的槽位（学校 0.553）——
     * 用户在埃森哲页连说四遍的"school name 就是 school name"就是这个现象。
     * 这里在候选之间补这一刀：标签是纯拉丁多词、末词是通用词时，谁的别名里带着那个**定语**，
     * 谁抬到 auto 档；只靠通用词蹭上的压回 review 以下。定语谁都不命中时完全不动（保持原行为），
     * 避免把"Organization Name"这种我们没词的栏位硬塞进某个槽位 —— 那种照旧走缺口/AI，不猜。
     */
    {
      const lc = core(normalize(pf.labelRaw || pf.label));
      const lw = lc.split(' ').filter(Boolean);
      const head = lw[lw.length - 1] || '';
      const GENERIC_HEAD = new Set(['name', 'number', 'score', 'date', 'type', 'level', 'status', 'title', 'location']);
      if (/^[a-z0-9 ]+$/.test(lc) && lw.length >= 2 && GENERIC_HEAD.has(head)) {
        const quals = lw.slice(0, -1).filter(t => t.length >= 3);
        const coversQual = sf => (sf.labels || []).some(al => {
          const aw = core(normalize(al)).split(' ').filter(Boolean);
          return quals.some(q => aw.some(w => w === q || w.startsWith(q) || q.startsWith(w)));
        }) || quals.some(q => core(normalize(sf.zh || '')).includes(q));
        const hitters = candidates.filter(c => coversQual(c.sf));
        if (hitters.length === 1) {
          for (const c of candidates) {
            if (c === hitters[0]) c.s = Math.max(c.s, 0.86);
            else c.s = Math.min(c.s, 0.7);
          }
          candidates.sort((a, b) => b.s - a.s);
        }
      }
    }
    // 空槽优先于"退而求其次"：这一栏按标签最匹配的槽位在资料里是空的，就绝不能拿别的栏位顶上。
    // 用户 2026-10-02 看到的「Name 被写成 AWS Certified AI Practitioner」正是这条缺失造成的：
    // basics.name 没填 → 它根本不进候选 → 谁有值就用谁（证书名称 0.855 赢）。
    // 只在"本来会写出去"时拦（有候选）；一个候选都没有仍走下面的章节放宽，别把老用例做窄。
    {
      const bestFilled = candidates[0];
      // "同一板块同一栏位的另一条"（工作第 2 段没写内容）不算顶替，那是记录序号问题，
      // 老规矩是照写第 1 条 + 黄字说清错位；只有**跨板块/跨栏位**的空槽压过有值候选时，
      // 写下去才是拿别的东西顶替（姓名 ← 证书名称就是这么发生的）。
      // 只在**标签就是在点名下那个空栏**时才拦（分数 ≥0.9 = 字面/主干命中）：
      // 'Name' ≡ 姓名(0.95) 空着 → 绝不能拿证书名称顶；
      // 而 'Certificate Name' 对 姓名 只有 0.65（靠 'name' 这个词蹭上的），
      // 那种情况拦下来就是把本来对的栏位做没了 —— 判分器会立刻告诉我。
      const substitution = bestFilled && emptyBest
        && emptyBest.s >= 0.9
        && (emptyBest.sf.section !== bestFilled.sf.section || emptyBest.sf.key !== bestFilled.sf.key);
      if (substitution && emptyBest.s >= bestFilled.s + 0.05) {
        const zh = emptyBest.sf.zh || emptyBest.sf.path;
        // 「空」有两种，下一步完全不同：资料里真没写 vs 只写了中文、这页是英文表单。
        // 用户 2026-10-02 的导出里同一页就同时出现两种归因：index 0「name」报 slot_empty、
        // index 25「referrer name」报 missing_english_value —— 都是 basics.name 只有中文值。
        // 只写中文的人被告知"去资料里补上"会再补一遍中文，正确动作是切到 English 表单。
        const onlyChinese = pageLang === 'en' && missingEnglish.has(emptyBest.sf.path);
        gaps.push({
          index,
          label: pf.label || '(未命名字段)',
          reason: onlyChinese ? 'missing_english_value' : 'slot_empty',
          kind: pf.kind,
          slotPath: emptyBest.sf.path,
          note: onlyChinese
            ? `这一栏按标签对应到「${zh}」，但你只填了中文写法；英文表单需要英文写法 —— 在侧边栏切到 English 表单补齐（没有拿别的栏位顶替）`
            : `这一栏按标签最匹配的是「${zh}」，但你资料里那一栏是空的 —— 没有拿别的栏位的值顶上（顶替就是错填）`,
        });
        return;
      }
    }
    // 章节线索是启发式证据，不该变成一票否决：Moka/Klook 把"工作职责"放在 工作经历 区块里，
    // 而这份简历只有实习经历（work.* 全空）→ 实习的 summary 被 0.55 罚下后一个候选都不剩，
    // 页面就变成"我们没有词"。这里放宽一次章节惩罚重算，命中就降级为待复核，绝不自动写。
    if (!candidates.length && pf.sectionHint) {
      const relaxed = { ...scoring, sectionHint: '' };
      for (let c = 0; c < schemaFields.length; c++) {
        const sf = schemaFields[c];
        if (asDate && !dateish(sf)) continue;
        if (sf.section !== pf.sectionHint && !AMBIGUOUS_SECTIONS.has(sf.section)) continue;
        const value = valueOf(sf.path, scoring);
        if (!value) {
          if (pageLang === 'en' && missingEnglish.has(sf.path)) {
            const s0 = scorePair(relaxed, sf);
            if (s0 >= REVIEW_THRESHOLD) nearMissEn.push({ sf, s: s0 * 0.95 });
          }
          continue;
        }
        const s = scorePair(relaxed, sf);
        if (s >= REVIEW_THRESHOLD) candidates.push({ c, sf, value, s: s * 0.95, relaxedHint: true });
      }
      candidates.sort((a, b) => b.s - a.s);
    }
    if (!candidates.length && asDate) {
      // 一个日期候选都没有：整组退回人工，别只说"没词"
      const why = (group.members.find(m => m.role) || {}).role
        ? '没能确定这一对年/月框对应资料里的哪个时间，请人工填写'
        : '这一对年/月框只写了时段（如「Study period」），没说清是开始还是结束，无法对应到资料里的时间，请人工填写';
      for (const m of group.members) {
        gaps.push({
          index: m.index, label: pageFields[m.index].label || '(未命名字段)',
          reason: 'composite_date', kind: pageFields[m.index].kind, note: why,
        });
      }
      return;
    }
    considered.push({ index, top: candidates.slice(0, TOP_K), nearMissEn: nearMissEn.sort((a, b) => b.s - a.s).slice(0, TOP_K), emptyBest });
  });

  // 构造稀疏代价矩阵：行 = 有候选的页面字段，列 = 出现过的 profile 索引
  const rows = [];
  const colSet = new Map();
  for (const item of considered) {
    if (!item.top.length) {
      const pf = pageFields[item.index];
      const miss = (item.nearMissEn || [])[0];
      // 一个候选都没有，但标签其实**点名**要某个栏位、只是资料里那一栏空着：
      // 报"我们没有这个词"会把人赶去补别名，而真正该补的是资料本身
      // （途普那张页面上 Address / Name 空着时就是这种情况）。
      if (item.emptyBest && item.emptyBest.s >= 0.9 && !missingEnglish.has(item.emptyBest.sf.path)) {
        const ebZh = item.emptyBest.sf.zh || item.emptyBest.sf.path;
        gaps.push({
          index: item.index, label: pf.label || '(未命名字段)',
          reason: 'slot_empty', kind: pf.kind, slotPath: item.emptyBest.sf.path,
          note: `这一栏要的是「${ebZh}」，你资料里还没填`,
        });
        continue;
      }
      if (miss) {
        // 按标签本来能对上、只是这一槽没英文写法：把它说成"缺英文值"而不是"我们没有这个词"，
        // 否则用户会去补别名，而真正该补的是 EN 表单里的这一栏
        gaps.push({
          index: item.index, label: pf.label || '(未命名字段)',
          reason: 'missing_english_value', kind: pf.kind,
          note: `这一栏按标签对应到「${miss.sf.zh}」，但你只填了中文值；英文表单需要英文写法 —— 在侧边栏切到 English 表单补齐。`,
          slotPath: miss.sf.path,
        });
        continue;
      }
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
    if (withheld(sf)) {
      gaps.push({ index: row.index, label: pf.label || '(无标签)', reason: 'sensitive_withheld', kind: pf.kind, note: '敏感字段（' + sf.path + '）默认不自动写' });
      return;
    }
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
    // 英文页面上用中文值兜底（用户显式开了 enMissingMode）→ 一律黄字并说明写的是中文。
    // 这种写法有风险（可能把中文塞进英文栏），所以绝不给绿字，哪怕分数很高。
    if (pageLang === 'en' && viaZhFallback.has(sf.path)) {
      entry.tier = 'review';
      entry.note = entry.note
        ? `${entry.note}；这一栏没有英文写法，写进去的是中文值，请核对`
        : '这一栏没有英文写法，写进去的是中文值，请核对（或在 English 表单补英文值）';
    }
    // 判断题（是/否、单选合规项）永远黄字：这类栏填下去是对雇主的一句话（"我不需要签证担保"），
    // 而资料里的值可能早就过时了 —— 打字的代价是一次改正，猜错的代价是一次不实陈述。
    if ((sf.type === 'bool' || pf.kind === 'radio' || pf.kind === 'checkbox') && entry.tier === 'auto') {
      entry.tier = 'review';
      entry.note = '这是你的选择而不是抄写，请核对再提交';
    }
    if (chosen.cand.relaxedHint) { entry.tier = 'review'; entry.note = '章节线索与资料分组不一致，请确认这一栏到底算哪段经历'; }
    // 列表槽位要有"页面自己给的证据"才许绿字，两种证据：
    // ① DOM 里的重复区块序号（卡片/fieldset 边界，itemIndexSource='dom' 或没标来源）；
    // ② 页面小标题的章节归属跟 profile 的分组一致。
    // 按"同名标签第几次出现"推断出来的序号（'occurrence'）不算证据①：它只说得出"第几条"，
    // 说不出"是工作还是实习"，让它开绿字就等于允许"A 公司的职位写进 B 公司那一栏"，
    // 而每个字段单独回读都是绿的，事后根本发现不了。
    const domEvidence = pf.itemIndex != null && pf.itemIndexSource !== 'occurrence';
    const sectionEvidence = Boolean(pf.sectionHint) && pf.sectionHint === sf.section;
    // 跨板块同名栏位：这一页可能有 N 个都叫「Name」的框（项目名、实习公司名、组织名、证书名、推荐人名…）。
    // 用户 2026-10-02 的诊断很准："你把 name 识别成为 姓名，而不是 name" —— 别名表里 'name' 这种
    // 一个词的通用词，落到哪个板块就是哪个东西的"名字"，光看标签永远分不开。
    // 所以：**光秃秃一个词的标签 + 跨板块并列 + 页面上没有板块证据** → 不猜，退成交给人工，
    // 并把候选板块念出来。判据只收"一个拉丁单词"或"一两个汉字"：Moka 的「公司名称」是 4 个汉字、
    // "公司"本身有区分度，那种按老规矩写+黄字（有测试钉着"两栏都该进计划"）。
    const bareLabel = normalize(pf.label || '');
    const bareGeneric = (/^[a-z][a-z.'-]{1,15}$/.test(bareLabel) && !bareLabel.includes(' '))
      || /^[\u4e00-\u9fff]{1,2}$/.test(bareLabel);
    // 只在"这个光秃秃的词在页面上出现不止一次"时才拒。只问一次就没有"哪个框属于哪个板块"
    // 的问题（Klook 一整个表单里「职责」只出现一次，按最像的板块写是对的，判分钉过这条）；
    // 出现两次以上才说明同一页有多个板块都在问同名的一栏。
    const sameBareLabel = pageFields.filter(x => normalize(x.label || '') === bareLabel).length;
    const tiedSections = [...new Set(row.cells
      .filter(c => c.score >= chosen.score - 0.12 && c.cand?.sf?.itemIndex != null)
      .map(c => c.cand.sf.section))];
    if (bareGeneric && sameBareLabel >= 2 && sf.itemIndex != null && tiedSections.length >= 2 && !domEvidence && !sectionEvidence) {
      gaps.push({
        index: row.index,
        label: pf.label || '(未命名字段)',
        reason: 'block_ambiguous',
        kind: pf.kind,
        slotPath: sf.path,
        note: `这一栏只写了「${sf.key}」，而资料里有 ${tiedSections.length} 个板块都有同名位（${tiedSections.join(' / ')}）；页面上找不到能判断归属的板块标题`,
      });
      return;
    }
    if (sf.itemIndex != null && !domEvidence && !sectionEvidence && tiedSections.length >= 2) {
      // 不够"光秃秃"但仍跨板块并列：照写，但黄字 + 把候选板块念出来，让用户一眼知道我们在猜
      const why = `这一栏按标签能对上 ${tiedSections.length} 个板块的同名位（${tiedSections.join(' / ')}），按最像的那个写了，请核对`;
      entry.tier = 'review';
      entry.note = entry.note ? `${entry.note}；${why}` : why;
    }
    if (sf.itemIndex != null && !domEvidence && !sectionEvidence) {
      entry.tier = 'review';
      // 追加而不是覆盖：一栏可以同时有两个问题（既是"第几段说不清"，又是"写的是中文值"），
      // 后面那条被前面那条顶掉过，用户就少知道一件事
      const why = `无法确定这是第 ${(sf.itemIndex ?? 0) + 1} 段「${sf.section}」经历，请核对`;
      entry.note = entry.note ? `${entry.note}；${why}` : why;
    }
    // 配对错位检测：页面这一栏是"某个标签的第 k 次出现"，却被派到资料里序号不等于 k 的条目上，
    // 说明同块内的字段来自不同条目（Klook 两个「公司名称」互相换位就是这么发生的）。
    if (sf.itemIndex != null && pf.itemIndexSource === 'occurrence' && pf.itemIndex != null && sf.itemIndex !== pf.itemIndex) {
      entry.tier = 'review';
      const swapNote = `这一栏是页面上第 ${pf.itemIndex + 1} 次出现的「${pf.label || pf.name}」，却拿到了资料里第 ${sf.itemIndex + 1} 条，配对可能错位`;
      entry.note = entry.note ? `${entry.note}；${swapNote}` : swapNote;
    }

    if (entry.tier === 'review' && chosen.score < AUTO_THRESHOLD && !entry.note) entry.note = '置信度不足，请复核';

    const isCustomChoice = Boolean(pf.customSelect) || pf.kind === 'combobox' || pf.kind === 'listbox';
    if (isCustomChoice) {
      // 选项要点了才渲染，计划阶段无从预解析：打上标记交给写入层现场匹配，
      // 且一律黄字——"点开选中"是我们主动操作了页面，必须让你看见动了哪些栏。
      entry.customSelect = true;
      entry.tier = 'review';
      entry.note = '这是自定义下拉，已按授权点开选中；请核对显示值';
    } else if (pf.kind === 'select' || pf.kind === 'radio' || pf.kind === 'checkbox' || sf.type === 'enum' || sf.type === 'bool') {
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
      else {
        const byRule = rulePickFor(entry, pf, optionRules);
        if (byRule) {
          entry.optionValue = byRule.value ?? byRule.text;
          const ruleNote = `按站点选项对照：资料里「${value}」→ 选「${byRule.text}」`;
          entry.note = entry.note ? `${entry.note}；${ruleNote}` : ruleNote;
        }
        else if (pageOptions.length) { entry.tier = 'review'; entry.note = '页面选项与你的资料无对应，需人工选择'; entry.needsChoice = true; delete entry.value; }
      }
    }

    const adapterDate = dateFormatOverride(opts.adapter, pf);
    if (adapterDate || sf.type === 'date' || sf.type === 'month' || sf.type === 'year' || pf.type === 'date') {
      entry.dateFormat = adapterDate
        || (sf.type === 'year' ? 'yyyy'
          : sf.type === 'month' ? inferDateFormat({ label: pf.label, placeholder: pf.placeholder, sample: pf.sampleValue, inputType: pf.inputType === 'month' ? 'month' : '' })
            : inferDateFormat({ label: pf.label, placeholder: pf.placeholder, sample: pf.sampleValue, inputType: pf.inputType }));
      if (entry.dateFormat === 'yyyy-MM-dd' && sf.type === 'month') entry.dateFormat = 'yyyy-MM';
      // 纯数字样例两段都 ≤12 时月/日顺序不可知：宁可黄字让你看一眼，也不要反着写进生日框
      if (sf.type === 'date' && !entry.dateFormat) {
        entry.tier = 'review';
        entry.note = '日期顺序未确认（站点没给可判读的格式线索），请核对';
      }
    }
    assignments.push(entry);
  });

  // 钉位字段：跳过打分竞争，直接指定路径，但同样要解析 option 与日期格式
  for (const entry of pinned) {
    const pf = pageFields[entry.index];
    if (pf.kind === 'select' || pf.kind === 'radio' || pf.kind === 'checkbox') {
      const opt = resolveOption(pf, entry.value);
      if (opt) entry.optionValue = opt.value ?? opt.text;
      else {
        const byRule = rulePickFor(entry, pf, optionRules);
        if (byRule) {
          entry.optionValue = byRule.value ?? byRule.text;
          entry.note = `按站点选项对照：资料里「${entry.value}」→ 选「${byRule.text}」${byRule.value ? `（提交值 ${byRule.value}）` : ''}`;
        } else { entry.tier = 'review'; entry.note = '页面选项与你的资料无对应，需人工选择'; entry.needsChoice = true; }
      }
    }
    const df = dateFormatOverride(opts.adapter, pf);
    if (df) entry.dateFormat = df;
    else if (entry.profileType === 'date' || entry.profileType === 'month') {
      entry.dateFormat = inferDateFormat({ label: pf.label, placeholder: pf.placeholder, sample: pf.sampleValue, inputType: pf.inputType });
    }
    assignments.push(entry);
  }

  // 成对日期在落笔前展开：组长那一笔（打分行或适配器钉位行都算）换成每个成员一笔。
  // 必须在最后统一做：以前只在打分行里展开，Moka 适配器一钉位，年框带着整组的槽位号走，
  // 月框被当成"已由组长代表"直接丢掉，页面上就少填一个框，而且报表里看不出少了谁。
  const expanded = [];
  for (const a of assignments) {
    const g = groupOfIndex.get(a.index);
    if (!g || !g.complete || g.leader !== a.index) { expanded.push(a); continue; }
    if (a.skip) { for (const m of g.members) expanded.push({ ...a, index: m.index }); continue; }
    const parts = dateParts(a.value ?? '');
    const needOf = m => (m.part === 'year' ? parts.year : m.part === 'month' ? parts.month : parts.day);
    for (const m of g.members) {
      if (needOf(m)) continue;
      const el = pageFields[m.index];
      gaps.push({
        index: m.index, label: el.label || '(未命名字段)', reason: 'composite_date', kind: el.kind,
        note: `资料里「${a.path}」只有${parts.month ? '年月' : '年份'}，${m.part === 'month' ? '月份' : '日期'}这一框请手填`,
      });
    }
    for (const m of g.members) {
      if (!needOf(m)) continue;
      const copy = {
        ...a,
        index: m.index,
        label: pageFields[m.index].label || a.label,
        datePart: m.part,
        dateFormat: m.part === 'year' ? 'yyyy' : m.part === 'month' ? 'MM' : 'dd',
      };
      if (g.inferredRole) {
        copy.tier = 'review';
        // 两条理由都要留：一处黄字说明盖掉另一处，用户看到的永远是后写的那句，
        // 于是"不知道是第几段经历"和"不知道是开始还是结束"同时存在时只提醒了后者。
        const roleNote = '开始/结束是按页面里出现的先后顺序推的，请核对';
        copy.note = a.note ? `${a.note}；${roleNote}` : roleNote;
      }
      expanded.push(copy);
    }
  }
  assignments.splice(0, assignments.length, ...expanded);

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
