// 代号层（档 A，2026-10-04 用户放行）：让 AI 把**页面自己的选项文案**归进一份封闭代号，
// 再由本地把"我资料里的取值"折算成同一个代号 —— 两边代号相同才落这一项。
//
// 为什么这样分：这一类失败（判分语料实测 28 个带选项栏位里 2 例）的成因不是"AI 不知道我的值"，
// 而是"页面换了一种问法/另一种语言说同一件事"：
//   · 「是否全日制」页面上给 是/否，资料里存的是 全日制；
//   · 港页写 Right of Abode Holder / Holder of IANG，资料里写 永久居民 / IANG（内地应届毕业生留港计划）。
// 缺的是**读页面文案**的能力，而页面文案本来就在请求里 —— 不需要用我的隐私去换。
//
// 三条不因为方便而放宽的规矩：
//  1) AI 只见代号词表与页面文字，**永不见资料取值**（档 C 是另一条路，由勾选框控制、有硬排除清单）；
//  2) 代号必须落在封闭清单内，越界回答整条丢弃（与 core/canonical.js 的概念集同理）；
//  3) 词表是我们手写的词典，绝不能把 profile 里的取值抄进来当词表项 —— 有长期测试钉着，
//     抄进来就等于把"姓名/证件号"这类值经词典名义发出去。
//
// 学历代号只到层级（用户口径："学历不区分全日制等，那是另外的栏位"）：
// 培养方式由 trainingMode 那一栏自己管，混进代号就会替学校判断"我读的是不是研究型硕士"。

import { OPTION_SETS, equivalentsOf } from './profile-schema.js';
import { normalize, core } from './matching.js';

/**
 * 代号空间：一个空间 = 一组互斥的封闭代号。
 * 每个代号带一句英文释义（gloss）：模型靠它区分 NEEDS_SPONSORSHIP 与 NO_RIGHT_TO_WORK。
 * 释义刻意用英文写，避免与资料里那些中文枚举值整串相同（`assertNoProfileValues` 的判据是整串包含）。
 */
export const TOKEN_SPACES = {
  rightToWork: {
    zh: '在港工作权利 / 签证或进入许可类别',
    tokens: [
      { t: 'CITIZEN', d: 'A citizen (e.g. PRC national without HK residence)', v: ['公民', '中国公民（持外国签证不适用）', 'Citizen'] },
      { t: 'HK_PERMANENT_RESIDENT', d: 'Hong Kong permanent resident with right of abode, no work restriction', v: ['永久居民', '香港永久性居民', 'Permanent Resident'] },
      { t: 'HK_RESIDENT', d: 'Hong Kong resident holder of a HKID card (non-permanent)', v: ['本地居民', '香港居民', 'Hong Kong Resident'] },
      { t: 'IANG', d: 'Immigration Arrangements for Non-local Graduates: allowed to work and change employer freely', v: ['IANG（内地应届毕业生留港计划）', 'IANG（非本地毕业生留港／回港就业安排）', 'IANG Visa', '非本地毕业生', '留港／回港就业'] },
      { t: 'TTPS', d: 'Top Talent Pass Scheme holder', v: ['高端人才通行证计划（TTPS）', 'Top Talent Pass (TTPS)', '高端人才通行证'] },
      { t: 'GEP', d: 'Employment under General Employment Policy, tied to the sponsoring employer', v: ['一般就业政策（GEP）', 'Employment under GEP', '一般就业政策'] },
      { t: 'ASMTP', d: 'Admission Scheme for Mainland Talents and Professionals, tied to the sponsoring employer', v: ['输入内地人才计划（ASMTP）', 'ASMTP Visa', '输入内地人才'] },
      { t: 'QMAS', d: 'Quality Migrant Admission Scheme grantee', v: ['优秀人才入境计划（QMAS）', 'QMAS', '优秀人才入境'] },
      { t: 'TECHTAS', d: 'Technology Talent Admission Scheme', v: ['科技人才入境计划（TechTAS）', 'TechTAS', '科技人才入境'] },
      { t: 'EMPLOYMENT_VISA', d: 'Any other employment / work visa already held, tied to the employer', v: ['持工作签证', 'Holder of Employment Visa', '其他工作签证', 'Other Employment Visa'] },
      { t: 'DEPENDANT', d: 'Dependant visa holder (normally permitted to work in Hong Kong)', v: ['受养人（Dependant）', 'Dependant Visa', '受养人'] },
      { t: 'STUDENT_PART_TIME', d: 'Student visa / student label, only limited part-time work allowed', v: ['学生签证（可兼职/OPT/CPT）', '学生签证／进入许可（兼职受限）', 'Student Label (Part-time Limited)', '学生签'] },
      { t: 'NEEDS_SPONSORSHIP', d: 'Does not yet hold any visa that allows work; an employer must sponsor', v: ['需申请工作签证', 'Require Sponsorship', '需雇主担保才能工作', '需要担保'] },
      { t: 'NO_RIGHT_TO_WORK', d: 'No right to work in Hong Kong at all (e.g. visitor)', v: ['无香港工作签证', '没有工作权利', '无工作权利'] },
    ],
  },
  gender: {
    zh: '性别',
    tokens: [
      { t: 'MALE', d: 'Male', v: ['男', 'Male'] },
      { t: 'FEMALE', d: 'Female', v: ['女', 'Female'] },
      { t: 'UNDISCLOSED', d: 'Prefers not to disclose', v: ['保密', 'Prefer not to say', '不愿透露'] },
      { t: 'OTHER_GENDER', d: 'Another gender identity or non-binary', v: ['其他性别', '非二元', 'Other gender'] },
    ],
  },
  degreeLevel: {
    zh: '最高学历（只到层级）',
    tokens: [
      { t: 'SENIOR_HIGH', d: 'High school / secondary school graduate', v: ['高中/中专', '高中', '中专', '中技', 'Secondary School'] },
      { t: 'VOCATIONAL', d: 'Vocational or junior-college diploma, below bachelor', v: ['大专', '高职', '专科', 'Diploma'] },
      { t: 'BACHELOR', d: "Bachelor's degree, including double bachelor", v: ['本科', 'Bachelor', '学士', '双学士', 'Undergraduate'] },
      { t: 'MASTER', d: "Master's degree (any mode: taught or research)", v: ['硕士', 'Master', '硕士研究生', 'Postgraduate'] },
      { t: 'DOCTORATE', d: 'Doctoral degree (PhD)', v: ['博士', 'PhD', 'Doctorate', '博士研究生'] },
      { t: 'POSTDOC', d: 'Post-doctoral researcher position (not a degree)', v: ['博士后', 'Postdoc'] },
      { t: 'OTHER_LEVEL', d: 'Another level not listed above', v: ['其他', '无'] },
    ],
  },
  idType: {
    zh: '证件类型',
    tokens: [
      { t: 'MAINLAND_ID', d: 'PRC resident identity card', v: ['中国居民身份证', '居民身份证', '身份证'] },
      { t: 'HKID', d: 'Hong Kong identity card', v: ['HKID', '香港身份证'] },
      { t: 'PASSPORT', d: 'Passport of any country', v: ['护照', 'Passport'] },
      { t: 'HOME_RETURN_PERMIT', d: 'Mainland Resident Travel Permit to/for HK & Macao', v: ['港澳居民来往内地通行证', '回乡证'] },
      { t: 'TAIWAN_PERMIT', d: 'Mainland Travel Permit for Taiwan residents', v: ['台湾居民来往大陆通行证', '台胞证'] },
      { t: 'DRIVING_LICENSE', d: 'Driving licence used as ID', v: ['Driver License', '驾驶证', '驾照'] },
      { t: 'OTHER_DOC', d: 'Another document', v: ['其他'] },
    ],
  },
  marital: {
    zh: '婚姻状况',
    tokens: [
      { t: 'SINGLE', d: 'Unmarried', v: ['未婚', 'Single', '单身'] },
      { t: 'MARRIED', d: 'Married', v: ['已婚', 'Married'] },
      { t: 'DIVORCED', d: 'Divorced', v: ['离异', '离过婚', 'Divorced'] },
      { t: 'WIDOWED', d: 'Widowed', v: ['丧偶', 'Widowed'] },
      { t: 'UNDISCLOSED', d: 'Prefers not to disclose', v: ['保密', 'Prefer not to say'] },
    ],
  },
  trainingMode: {
    zh: '学习形式（全日制与否）',
    tokens: [
      { t: 'FULL_TIME', d: 'Full-time study', v: ['全日制', '统招全日制', 'Full-time', '全日制统招'] },
      { t: 'PART_TIME', d: 'Part-time or non-full-time study', v: ['非全日制', 'Part-time', '兼读'] },
      { t: 'ON_JOB', d: 'On-the-job / while employed study mode', v: ['在职', '在职读研', 'On-the-job'] },
      { t: 'SELF_STUDY_EXAM', d: 'Self-taught examination programme', v: ['自考', '高等教育自学', 'Self-taught'] },
      { t: 'OPEN_UNIV', d: 'Open / distance university programme', v: ['开放大学', '电大', '远程教育'] },
      { t: 'OTHER_MODE', d: 'Another study mode', v: ['其他'] },
    ],
  },
};

/** OPTION_SETS 的名字 → 代号空间。没列进来的枚举（政治面貌、熟练度、渠道…）走不了档 A，
 *  只能交人工或（开了档 C 时）由取值直对。 */
export const OPTION_SET_TO_SPACE = {
  workAuth: 'rightToWork',
  visaCategory: 'rightToWork',
  gender: 'gender',
  degree: 'degreeLevel',
  degreeTitle: 'degreeLevel',
  idType: 'idType',
  marital: 'marital',
  trainingMode: 'trainingMode',
};

export function spaceOfOptionSet(setName = '') {
  return OPTION_SET_TO_SPACE[String(setName || '')] || '';
}

export function spaceOf(name = '') {
  return TOKEN_SPACES[name] || null;
}

/** 发给模型的代号清单（代号 + 释义，不含任何资料取值） */
export function tokenPromptList(spaceName = '') {
  const sp = spaceOf(spaceName);
  if (!sp) return [];
  return sp.tokens.map(x => ({ t: x.t, d: x.d }));
}

const sq = s => String(normalize(s) || '').replace(/\s+/g, '');
const CJK = /[㐀-鿿぀-ヿ가-힯]/;
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 一次命中判定。刻意不用"互为背景就算"：
 * 老写法下 'male' 落进 'female'（'female'.includes('male') 为真），
 * 于是性别 '男' 同时命中 MALE 与 FEMALE、判成歧义返回 null —— 性别这一栏就永远走不了档 A。
 * 规则：相等 > 拉丁词整词命中 > 中文串互相包含（中文没有词边界，包含是这里唯一可用的判断）。
 */
function hitForm(form, alias) {
  if (!form || !alias) return false;
  if (form === alias) return true;
  const cjk = CJK.test(alias) || CJK.test(form);
  if (cjk) return alias.length >= 2 && (form.includes(alias) || alias.includes(form));
  const word = (hay, needle) => new RegExp(`(^|[^a-z0-9])${escRe(needle)}([^a-z0-9]|$)`, 'i').test(hay);
  return word(form, alias) || (alias.length >= 3 && word(alias, form));
}

/** 命中长度：拿它比"哪条代号说得更准"（'全日制' 该赢过泛词 '研究生'，'博士后' 该赢过 '博士'） */
function hitLength(form, alias) {
  if (!hitForm(form, alias)) return 0;
  if (form === alias) return Math.max(form.length, alias.length);
  const shorter = Math.min(form.length, alias.length);
  return CJK.test(form) || CJK.test(alias) ? shorter : Math.max(shorter, 4);
}

/**
 * 我资料里的某个取值 → 封闭代号。
 * 折不出代号返回 null（这一栏就走人工或档 C），**绝不返回"最接近的那个"**：
 * 把 非全日制 折算成 FULL_TIME 这种错，页面不会报错、站点会安静地把错答案交上去。
 * 命中多个代号且长度并列 → 也返回 null（歧义不是我们该替站点解决的事）。
 */
export function valueToToken(spaceName = '', value = '') {
  const sp = spaceOf(spaceName);
  if (!sp) return null;
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const forms = [...new Set([raw, ...equivalentsOf(raw)].map(sq).filter(Boolean))];
  let best = null;
  for (const tok of sp.tokens) {
    let hitLen = 0;
    for (const alias of [...tok.v, tok.t]) {
      const a = sq(alias);
      if (!a) continue;
      for (const f of forms) hitLen = Math.max(hitLen, hitLength(f, a));
    }
    if (!hitLen) continue;
    if (!best || hitLen > best.len) best = { token: tok.t, len: hitLen };
    else if (hitLen === best.len && best.token !== tok.t) return null;   // 歧义：不猜
  }
  return best ? best.token : null;
}

/** 页面选项 → 代号（AI 的回答经 parse 后交回来，本地用它挑选） */
export function tokenListForField(spaceName = '', optionTexts = [], aiTokens = {}) {
  const known = new Set(TOKEN_SPACES[spaceName]?.tokens.map(x => x.t) || []);
  return optionTexts.map((text, i) => {
    const t = String(aiTokens?.[i] ?? aiTokens?.[String(i)] ?? '').trim();
    return { i, text: String(text ?? ''), token: known.has(t) ? t : '' };
  });
}

/**
 * 拿"我的代号"去对"页面选项的代号"。
 * @returns {{optionIndex:number, token:string, how:'unique'}|{optionIndex:-1,token:string,how:'none'|'ambiguous'}}
 */
export function pickOptionByToken(ourToken, optionTokens = []) {
  if (!ourToken) return { optionIndex: -1, token: '', how: 'none' };
  const hits = optionTokens.filter(o => o && o.token === ourToken);
  if (hits.length === 1) return { optionIndex: hits[0].i, token: ourToken, how: 'unique' };
  return { optionIndex: -1, token: ourToken, how: hits.length ? 'ambiguous' : 'none' };
}

/** 代号词表整段文本：请求构造方拿它去 exempt（词表里的词典词可能和短值撞字） */
export function tokenVocabularyText(spaceNames = []) {
  const seen = new Set();
  for (const n of spaceNames) {
    const sp = spaceOf(n);
    if (!sp) continue;
    for (const t of sp.tokens) seen.add(JSON.stringify([t.t, t.d, t.v]));
  }
  return JSON.stringify([...seen]);
}

/** 这一栏能不能走档 A：要看它最后落到的槽位用的是哪个枚举集。
 *  buildFields() 出来的行**没有 flags**（选项已经被展开成 options 数组），所以两条路都要认：
 *  先看原始 flags 里的 `O:名字`，再拿 options 数组反查 OPTION_SETS —— 反查用整串相等，
 *  不做包含：'男' 是 '男性' 的前缀，靠包含定枚举集会把两栏并成一栏。 */
export function optionSetOf(field) {
  const flags = String(field?.flags || '');
  const m = flags.match(/O:(\w+)/);
  if (m && OPTION_SETS[m[1]]) return m[1];
  const opts = field?.options;
  if (Array.isArray(opts) && opts.length) {
    const key = opts.map(x => String(x)).join('\u0001');
    for (const [name, list] of Object.entries(OPTION_SETS)) if (list.join('\u0001') === key) return name;
  }
  return '';
}

export function spaceForSlotField(field) {
  return spaceOfOptionSet(optionSetOf(field));
}

/** 供测试与文档用：代号空间覆盖了哪些 OPTION_SETS 键 */
export function coveredOptionSets() {
  return Object.keys(OPTION_SET_TO_SPACE).filter(k => OPTION_SETS[k] && spaceOf(OPTION_SET_TO_SPACE[k]));
}
