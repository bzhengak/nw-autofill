// 简历 Markdown → profile 导入器（纯函数，无 DOM、无网络）。
// 设计约束：
//  1. 按"标题文本"路由，不按 # 层级——实测两份简历一份用 #、另一份用 ##。
//  2. 只填空着的槽位，绝不覆盖你手工补过的字段（opts.overwrite 才覆盖）。
//  3. 每个写入都记进 report.mapped，导入后必须能看见"哪句话进了哪个字段"。
//  4. 认不出的标题进 report.unmappedHeadings，不要静默丢弃内容。

import { createEmptyProfile, getValueByPath, setValueByPath, buildFields } from '../profile-schema.js';
import { normalize, scorePair } from '../matching.js';

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const BULLET_RE = /^\s*([*+-])\s+(.*)$/;

const SECTION_KEYWORDS = [
  { key: 'others.selfIntro', re: /(个人简介|自我评价|自我介绍|_summary|professional summary|^summary$|profile|关于我|求职优势)/i },
  { key: 'family', re: /(家庭|成员|父母|家属|family|guardian|紧急联系)/i },
  // languages 必须在 certifications 之前：中文简历常写「语言与证书」，先命中"证书"会把语言整行塞进证书名
  { key: 'languages', re: /(语言|language)/i },
  { key: 'skills', re: /(专业技能|技能|skills|technical skills|技术栈|能力)/i },
  { key: 'education', re: /(教育|学历|education|academic)/i },
  { key: 'internship', re: /(实习|internship|intern)/i },
  { key: 'work', re: /(工作经历|工作经验|职业经历|work experience|employment|experience)/i },
  { key: 'projects', re: /(项目|project|research|研究)/i },
  { key: 'campus', re: /(校园|社团|学生活动|campus|leadership|activities|extracurricular)/i },
  { key: 'awards', re: /(奖项|荣誉|获奖|scholarship|award|honor|achievement)/i },
  { key: 'competitions', re: /(竞赛|比赛|competition|contest|hackathon)/i },
  { key: 'publications', re: /(论文|发表|出版|专利|publication|paper|patent)/i },
  { key: 'certifications', re: /(证书|资格|certificat|license|qualification)/i },
  { key: 'intent', re: /(求职意向|意向|expected|objective|job preference|其他信息|additional|补充|interests)/i },
  { key: 'contact', re: /(联系方式|联系|contact)/i },
  { key: 'basics', re: /(基本信息|基本资料|personal information|个人信息)/i },
];

const LIST_SECTIONS = new Set(['education', 'internship', 'work', 'projects', 'campus', 'awards', 'competitions', 'publications', 'certifications', 'languages']);
const LIST_LIMIT = { education: 4, internship: 4, work: 4, projects: 5, campus: 3, awards: 6, competitions: 3, publications: 3, certifications: 5, languages: 4 };

/** Markdown 富文本 → 纯文本（长文本字段里不要带 ** 和反引号） */
export function stripInline(value) {
  return String(value || '')
    .replace(/\\([^\s])/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s>])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）')
    .replace(/[ \t  ]+/g, ' ')
    .trim();
}

const MONTH_FIX = m => String(m).padStart(2, '0');

/**
 * 一行里可能有多个「标签：值」（中文简历常写成 性别：男　出生日期：2001-03-15　籍贯：江苏南京）。
 * 先按"标签:"出现的位置切段，值就是到下一个标签之前的内容。
 */
export function splitKeyValuePairs(line) {
  const s = String(line || '').trim();
  if (!s) return [];
  const LABEL = /(?:^|[\s|｜、·])((?:[\u4e00-\u9fffA-Za-z()（）/·+.#-]{2,12}?))\s*[:：]\s*/g;
  const marks = [];
  let m;
  while ((m = LABEL.exec(s))) marks.push({ label: m[1].trim(), from: m.index + m[0].length, labelStart: m.index + (m[0].indexOf(m[1]) ) });
  if (!marks.length) return [];
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].labelStart : s.length;
    const value = s.slice(marks[i].from, end).replace(/[|｜、·\s]+$/, '').trim();
    if (marks[i].label && value) out.push({ label: marks[i].label, value });
  }
  return out;
}

/**
 * 「标签：值」里的标签，交给和填页面同一份别名词典去认（core/matching.js 的 scorePair）。
 * 词典只有一份这一条是刻意的：以前导入器自己写死几个关键词，页面匹配那边认识
 * 「政治面貌」而导入这边不认识，同一个字段两处知识、必然漂移。
 * 只认一次性字段（itemIndex == null）：kv 行是"一个事实"，不该去抢多段经历的槽位。
 */
let flatFields = null;
function fieldForLabel(label) {
  if (!flatFields) flatFields = buildFields().filter(f => f.itemIndex == null);
  const synthetic = {
    label: normalize(label), labelRaw: label, kind: 'text', type: 'text', options: [],
    sectionHint: '', itemIndex: null, nearbyLabels: [], autocomplete: '', currentValue: '', name: '', id: '', placeholder: '',
  };
  let best = null, bestScore = 0;
  for (const f of flatFields) {
    const s = scorePair(synthetic, f);
    if (s > bestScore) { bestScore = s; best = f; }
  }
  // 0.66 = "标签是某个别名的子串"（手机 ⊂ 手机号）也能落位；再低就开始把杂项标签塞进正经字段了
  return bestScore >= 0.66 ? best : null;
}

/**
 * 「标签：值」落位前的小修正：中文简历爱写 "164cm"、"50kg"，
 * 而网申该栏只要数字，带着单位会直接把站点校验弄红。
 */
function tidyValue(path, value) {
  const v = String(value || '').trim();
  if (/^(basics\.(heightCm|weightKg)|skills?\.)/.test(path)) return v.replace(/\s*(cm|kg|厘米|公斤|米)\s*$/i, '').trim();
  return v;
}

/**
 * 基本信息段里常有教育类一次性问法（最高学历/毕业院校/专业）。
 * 它们在 profile 里属于可重复列表（education.N），kv 行不该抢列表槽位，
 * 但"最高学历"这种就是第一条教育经历的事实，不接住就白丢。
 */
const EDU_KV_FALLBACK = [
  { re: /^(最高学历|现有学历|现学历|学历)$/i, path: 'education.0.degree' },
  { re: /^(最高学位|学位)$/i, path: 'education.0.degreeTitle' },
  { re: /^(毕业院校|毕业学校|学校|院校)$/i, path: 'education.0.school' },
  { re: /^(所学专业|专业|专业名称)$/i, path: 'education.0.major' },
  { re: /^(专业方向|研究方向)$/i, path: 'education.0.researchField' },
  { re: /^(绩点|gpa)$/i, path: 'education.0.gpa' },
];

/** 单个「标签：值」落位；命中词典返回 true，交给调用方走原有兜底分支 */
function putKeyValue(labelRaw, value, put, where) {
  const label = String(labelRaw || '').replace(/[（(].*?[）)]/g, '').trim();
  if (!label || !value) return false;
  const hit = fieldForLabel(label);
  if (hit) { put(hit.path, tidyValue(hit.path, value), `${where}「${label}」`); return true; }
  const edu = EDU_KV_FALLBACK.find(r => r.re.test(label));
  if (edu) { put(edu.path, tidyValue(edu.path, value), `${where}「${label}」`); return true; }
  return false;
}

const FAMILY_RELATIONS = [
  { re: /(父亲|爸爸|父)/, value: '父亲' },
  { re: /(母亲|妈妈|母)/, value: '母亲' },
  { re: /(配偶|爱人|妻子|丈夫)/, value: '配偶' },
  { re: /(哥哥|兄弟|兄)/, value: '兄弟' },
  { re: /(姐姐|姐妹|姊)/, value: '姐妹' },
];

/**
 * 家庭情况段：中文简历写成 "父亲：李国栋　工作单位：…　职务：…　联系电话：…"，
 * 一行之内称谓在最前，后面几个属性属于同一个人 —— 按称谓开新槽位，属性沿用。
 */
function parseIntoFamily(lines, put) {
  let slot = -1;
  for (const line of lines) {
    const pairs = splitKeyValuePairs(line.replace(/^[-*+]\s+/, '').trim()) || [];
    if (!pairs.length) continue;
    for (const { label, value } of pairs) {
      const rel = FAMILY_RELATIONS.find(r => r.re.test(label));
      if (rel) {
        // 「父亲：李国栋」= 称谓即标签，值就是姓名 → 新开一个人；
        // 「父亲工作单位：…」= 称谓+属性，沿用当前人（不因为标签里带"父亲"就串到下一行）
        const isBareRelation = /^[s]*(父亲|爸爸|母亲|妈妈|配偶|爱人|妻子|丈夫|哥哥|姐姐|兄|弟|姊|妹)[s]*(姓名|名字|名|称呼)?[s]*$/.test(label);
        if (isBareRelation) {
          slot = Math.min(3, slot + 1);
          put(`family.${slot}.relation`, rel.value, `家庭条目「${label}」`);
          put(`family.${slot}.name`, value, `家庭条目「${label}」`);
          continue;
        }
        if (slot < 0) slot = 0;
      }
      if (slot < 0) continue;
      if (/(工作单位|单位|职业|employer)/i.test(label)) put(`family.${slot}.employer`, value, `家庭条目「${label}」`);
      else if (/(职务|职位|position|title)/i.test(label)) put(`family.${slot}.position`, value, `家庭条目「${label}」`);
      else if (/(电话|手机|联系方式|phone)/i.test(label)) put(`family.${slot}.phone`, value, `家庭条目「${label}」`);
      else if (/(出生|生日|birth)/i.test(label)) put(`family.${slot}.birthYear`, value, `家庭条目「${label}」`);
      else if (/(政治面貌|党派|political)/i.test(label)) put(`family.${slot}.political`, value, `家庭条目「${label}」`);
    }
  }
}

/**
 * 从一行尾部文字里抽日期区间。支持：
 * 2025.09 – 至今 / 09/2025 – Present / 2024-09 ~ 2025-08 / 2025年9月（预计 2026.10 毕业）/ Ongoing / 持续进行
 */
export function parseDateRange(text) {
  const s = String(text || '');
  const out = { start: '', end: '', current: false, expected: '', raw: s.trim() };
  const ym = [];
  for (const m of s.matchAll(/(20\d{2})\s*[.\-/年]\s*(\d{1,2})\s*月?/g)) ym.push({ i: m.index, v: `${m[1]}-${MONTH_FIX(m[2])}` });
  for (const m of s.matchAll(/(\d{1,2})\s*[./\-]\s*(20\d{2})/g)) ym.push({ i: m.index, v: `${m[2]}-${MONTH_FIX(m[1])}` });
  for (const m of s.matchAll(/(20\d{2})(?![-.\d])/g)) {
    if (ym.some(x => Math.abs(x.i - m.index) < 4)) continue;
    ym.push({ i: m.index, v: m[1] });
  }
  ym.sort((a, b) => a.i - b.i);
  if (ym.length) out.start = ym[0].v;
  if (ym.length > 1) out.end = ym[ym.length - 1].v;
  if (/(至今|现在|Present|Ongoing|持续|Current|现在)/i.test(s)) { out.current = true; if (ym.length > 1) out.end = ym[1].v; }
  const exp = s.match(/预计\s*(20\d{2})\s*[.\-/年]?\s*(\d{1,2})?\s*月?\s*(毕业)?/);
  if (exp) out.expected = exp[2] ? `${exp[1]}-${MONTH_FIX(exp[2])}` : exp[1];
  if (!out.expected) {
    const enMMYYYY = s.match(/expected\s*(\d{1,2})\s*[./\-]\s*(20\d{2})/i);
    const enYYYYMM = s.match(/expected\s*(20\d{2})\s*[.\-/]\s*(\d{1,2})/i);
    if (enMMYYYY) out.expected = `${enMMYYYY[2]}-${MONTH_FIX(enMMYYYY[1])}`;
    else if (enYYYYMM) out.expected = `${enYYYYMM[1]}-${MONTH_FIX(enYYYYMM[2])}`;
    else {
      const justYear = s.match(/expected\s*(20\d{2})/i);
      if (justYear) out.expected = justYear[1];
    }
  }
  return out;
}

/** 标题里的 "A -- B" / "A | B" / "A — B" 拆分 */
function splitTitle(title) {
  const normalized = title.replace(/\\&/g, '&');
  let parts = normalized.split(/\s+(?:--|—|–)\s+|\s*\|\s*| \/ /);
  parts = parts.map(p => stripInline(p).replace(/[（(]\s*[)）]/g, '').trim()).filter(Boolean);
  return parts.length ? parts : [stripInline(title).trim()];
}

function degreeOf(text) {
  const s = String(text || '');
  if (/(博士|phd|ph\.d|doctor)/i.test(s)) return '博士';
  if (/(硕士|msc|master|mba|mpp)/i.test(s)) return '硕士';
  if (/(学士|bsc|beng|bba|b\.s|b\.a|bachelor)/i.test(s)) return '本科';
  if (/(大专|专科|associate|diploma)/i.test(s)) return '大专';
  if (/博士后|postdoc/i.test(s)) return '博士后';
  return '';
}

function emailOf(text) {
  return (String(text || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [''])[0];
}

function phonesOf(text) {
  const s = String(text || '');
  const found = [];
  for (const m of s.matchAll(/(\+?\d{2,3})[\s-]?([1]?\d{6,11})/g)) {
    const num = `${m[1]}${m[2]}`.replace(/[\s-]/g, '');
    if (num.replace(/\D/g, '').length >= 8 && !found.includes(num)) found.push(num);
  }
  for (const m of s.matchAll(/(?<!\d)(1[3-9]\d{9})(?!\d)/g)) if (!found.includes(m[1])) found.push(m[1]);
  return found;
}

/** 归一化成网申可直接填的形式：内地 11 位裸号；其他保留国际前缀 */
export function normalizePhone(raw) {
  let s = String(raw || '').replace(/[^\d+]/g, '');
  if (s.startsWith('+86')) s = s.slice(3);
  if (/^86\d{11}$/.test(s)) s = s.slice(2);
  if (/^1[3-9]\d{9}$/.test(s)) return s;
  const cc = (s.match(/^\+?(\d{2,3})(\d{6,10})$/) || []).slice(1);
  return cc.length ? `+${cc[0]} ${cc[1]}` : s.replace(/^\+/, '');
}

/** 语言行："普通话（母语）、英语（流利）、粤语（conversational）" */
export function parseLanguages(text) {
  const out = [];
  for (const seg of String(text || '').split(/[、,;；,]/)) {
    const s = seg.trim();
    if (!s) continue;
    const m = s.match(/^([^(（]+)[（(]([^)）]+)[)）]/);
    if (m) out.push({ language: stripInline(m[1]), level: stripInline(m[2]) });
    else if (/^[一-龥A-Za-z]{2,10}$/.test(s)) out.push({ language: stripInline(s), level: '' });
  }
  return out.slice(0, 6);
}

function routeHeading(heading) {
  const h = stripInline(heading).toLowerCase();
  for (const k of SECTION_KEYWORDS) if (k.re.test(h)) return k.key;
  return '';
}

function splitBlocks(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let current = { heading: '', level: 0, lines: [], preamble: true };
  for (const line of lines) {
    const h = HEADING_RE.exec(line);
    if (h) {
      if (current.lines.some(l => l.trim()) || current.heading) blocks.push(current);
      current = { heading: h[2].trim(), level: h[1].length, lines: [], preamble: false };
    } else {
      current.lines.push(line);
    }
  }
  blocks.push(current);
  return blocks;
}

function bulletsOf(lines) {
  const items = [];
  let cur = null;
  for (const line of lines) {
    const b = BULLET_RE.exec(line);
    if (b) {
      const indent = line.match(/^\s*/)[0].length;
      if (indent >= 2 && cur) { cur.sub.push(b[2].trim()); continue; }
      cur = { text: b[2].trim(), sub: [] };
      items.push(cur);
    } else if (line.trim()) {
      if (cur) cur.sub.push(line.trim());
      else items.push({ text: line.trim(), sub: [] });
    }
  }
  return items;
}

function entryLinesToText(item) {
  const main = stripInline(item.text);
  const subs = item.sub.map(s => stripInline(s)).filter(Boolean);
  return [main, ...subs].filter(Boolean).join('；').replace(/；{2,}/g, '；');
}

function splitEntryBlocks(lines) {
  const entries = [];
  let cur = null;
  let pre = [];
  for (const line of lines) {
    const boldLead = /^\s*\*\*[^*]{2,}\*\*/.test(line) && !BULLET_RE.test(line);
    if (boldLead) {
      if (cur) entries.push(cur);
      const m = /^(.+?)\s*$/.exec(line.trim());
      cur = { header: m[1], lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      pre.push(line);
    }
  }
  if (cur) entries.push(cur);
  return { entries, pre };
}

function titleAndTail(header) {
  const bold = /^\*\*([\s\S]+?)\*\*\s*(.*)$/.exec(header.trim());
  if (bold) return { title: bold[1].trim(), tail: bold[2].trim() };
  const m = /^(.*?)(\s*(?:[（(【].{0,40}[）)】])?\s*(?:\d{4}.*|0\d\/\d{4}.*|至今.*|Present.*|Ongoing.*))$/m.exec(header.trim());
  if (m) return { title: m[1].trim(), tail: m[2].trim() };
  return { title: header.trim(), tail: '' };
}

/**
 * @param {string} md 简历 Markdown 全文
 * @param {Object} opts { base: 已有 profile（默认新建空档）, overwrite: false, langs: ['zh','en'] }
 */
export function importMarkdown(md, opts = {}) {
  const profile = opts.base ? JSON.parse(JSON.stringify(opts.base)) : createEmptyProfile();
  const report = { mapped: [], unmappedHeadings: [], unplaced: [], warnings: [], skippedExisting: [], stats: { entries: 0, bullets: 0 } };

  const put = (path, value, source) => {
    const v = String(value ?? '').trim();
    if (!v) return false;
    if (!opts.overwrite && String(getValueByPath(profile, path) || '').trim()) {
      report.skippedExisting.push({ path, source });
      return false;
    }
    setValueByPath(profile, path, v);
    report.mapped.push({ path, source, preview: v.length > 60 ? v.slice(0, 60) + '…' : v });
    return true;
  };

  const absorbContact = (line, source) => {
    const raw = String(line || '');
    if (!raw.trim()) return;
    const e = emailOf(raw); if (e) put('contact.email', e, source);
    for (const pRaw of phonesOf(raw)) {
      const n = normalizePhone(pRaw);
      if (n.length === 11 && n[0] === '1' && n[1] >= '3') put('contact.phone', n, source);
      else put('contact.altPhone', n, source);
    }
    const url = String(raw).split(/[\s,，|]+/).find(x => /^https?:/i.test(x)) || '';
    if (url) put('others.personalSite', url.replace(/[|,，;；]+/g, ''), source);
    for (const token of raw.split(/[|,，]/).map(s => stripInline(s)).filter(Boolean)) {
      if (token.includes('@') || /^https?:/i.test(token) || /^[+0-9][0-9\s-]{6,}$/.test(token)) continue;
      if (/^(personal page|个人主页|portfolio|homepage|领英|linkedin)$/i.test(token)) report.warnings.push('「' + token + '」只有文字没有链接，请在 profile 里手动补 URL');
      else report.warnings.push('联系行有无法归类的片段：「' + token + '」');
    }
  };

  const blocks = splitBlocks(md);
  let seenSection = false;
  const listCursor = {};
  const nextSlot = section => {
    listCursor[section] = (listCursor[section] ?? -1) + 1;
    return Math.min(listCursor[section], (LIST_LIMIT[section] || 4) - 1);
  };

  for (const block of blocks) {
    const body = block.lines;
    const headingText = block.heading;
    if (!headingText) {
      for (const line of body) absorbContact(line, '头部联系方式行');
      continue;
    }

    const route = routeHeading(headingText);
    if (route) seenSection = true;
    if (!route) {
      // 姓名只取"第一个正式章节之前"的未路由标题。文档中途出现的杂项标题一律记为未识别，
      // 否则 overwrite 模式下末尾标题（如"奇怪的段落"）会把姓名覆盖掉。
      const isNameCandidate = !seenSection && (!getValueByPath(profile, 'basics.name') || opts.overwrite);
      if (isNameCandidate && stripInline(headingText).length <= 40 && !/[：:]$/.test(headingText)) {
        const parts = splitTitle(headingText);
        put('basics.name', parts[0], '首个标题（判为姓名）');
        for (const line of body) absorbContact(line, '姓名下方联系行');
      } else {
        report.unmappedHeadings.push(headingText);
        // 整段都没地方去：正文也留着。AI 辅助导入只发"本地判不动的这几段"，
        // 不发整份简历 —— 所以这里必须把正文留住，否则下一步就没得可发。
        report.unplaced.push({ heading: headingText, lines: body.map(l => stripInline(l)).filter(Boolean), why: 'unrouted_heading' });
      }
      continue;
    }

    if (route === 'others.selfIntro') {
      const text = body.map(l => l.trim()).filter(Boolean).map(stripInline).join(' ');
      put('others.selfIntro', text, `标题「${headingText}」`);
      continue;
    }

    if (route === 'skills') {
      for (const item of bulletsOf(body)) {
        const t = stripInline(item.text);
        const cat = (t.match(/^(.{2,32}?)[:：]\s*(.+)$/) || [, '', t]);
        const content = (cat[2] || t).trim();
        const label = (cat[1] || '').toLowerCase();
        let target = 'skills.domain';
        // 办公软件要先判：它同时含"软件"和"工具"两类关键词，晚判就被抢进编程语言
        if (/(办公|office|excel|ppt|powerpoint|word)/.test(label)) target = 'skills.office';
        else if (/(软件|mlops|编程|程序|开发语言|software|platform|engineering|infrastructure)/.test(label)) target = 'skills.programming';
        else if (/(工具|tool|ide)/.test(label)) target = 'skills.tools';
        else if (/(llm|算法|模型|ai|智能体|data|数据|分析)/.test(label)) target = 'skills.domain';
        const prev = String(getValueByPath(profile, target) || '');
        const merged = [prev, content].filter(Boolean).join('、');
        setValueByPath(profile, target, merged);
        report.mapped.push({ path: target, source: `技能分类「${label || headingText}」`, preview: content.slice(0, 60) });
        report.stats.bullets++;
      }
      continue;
    }

    if (route === 'languages') {
      // 「语言与证书」是中文简历极常见的合并标题：两类信息都在这段里，
      // 只按语言解析会把证书整行丢掉，而带 "语言：" 前缀时第一个语种会变成 "语言：普通话"
      const lines = body.map(l => stripInline(l.replace(BULLET_RE.source, '$2'))).filter(Boolean);
      const langTexts = [];
      for (const line of lines) {
        const cert = line.match(/^(?:证书|资格证书|获奖证书|certificat(?:ion|e))?[:：]\s*(.+)$/i);
        if (/证书|certificat/i.test(line.split(/[：:]/)[0]) && cert) {
          for (const c of cert[1].split(/[；;]/).map(x => x.trim()).filter(Boolean)) {
            put(`certifications.${nextSlot('certifications')}.name`, c, '语言与证书·证书');
          }
          continue;
        }
        langTexts.push(line.replace(/^(?:语言|languages)\s*[:：]\s*/i, ''));
      }
      for (const lang of parseLanguages(langTexts.join('、'))) {
        const i = nextSlot('languages');
        put(`languages.${i}.language`, lang.language, '语言条目');
        put(`languages.${listCursor.languages}.level`, lang.level, '语言条目');
      }
      continue;
    }

    if (route === 'family') {
      parseIntoFamily([...new Set(body.map(l => stripInline(l)).filter(Boolean))], put);
      continue;
    }

    if (route === 'intent' || route === 'contact' || route === 'basics') {
      // 基本信息常写成不带项目符号的一行（"性别：男　出生日期：2001-03-15"），也要吃进来
      const texts = [...new Set(body.map(l => stripInline(l)).filter(Boolean))];
      for (const raw of texts) {
        // 项目符号要先脱掉：'- 语言：普通话（母语）' 以前会绕过语言专用解析，被通用 kv 抢走
        const t = raw.replace(/^[-*+]\s+/, '').trim();
        const kv = t.match(/^(语言|languages)[:：]\s*(.+)$/i);
        if (kv && /语言|language/i.test(kv[1])) {
          for (const lang of parseLanguages(kv[2])) {
            const i = nextSlot('languages');
            put(`languages.${i}.language`, lang.language, '其他信息·语言');
            put(`languages.${i}.level`, lang.level, '其他信息·语言');
          }
          continue;
        }
        const pairs = splitKeyValuePairs(t);
        let consumed = false;
        for (const { label, value } of pairs) {
          if (putKeyValue(label, value, put, '字段')) { consumed = true; continue; }
          if (/兴趣|爱好|hobb|interest/i.test(label)) { put('others.hobbies', value, `字段「${label}」`); consumed = true; continue; }
          if (/作品集|主页|portfolio|site/i.test(label)) { put('others.portfolio', value, `字段「${label}」`); consumed = true; continue; }
          if (/github/i.test(label)) { put('others.github', value, `字段「${label}」`); consumed = true; continue; }
          if (/linkedin/i.test(label)) { put('others.linkedin', value, `字段「${label}」`); consumed = true; continue; }
          if (/期望|意向|城市|到岗|salary/i.test(label)) { put('intent.willingnessNote', `${label}：${value}`, `字段「${label}」`); consumed = true; continue; }
        }
        if (consumed) continue;
        if (pairs.length) {
          // 标签认得出但词典没把握：原样存进"其他信息"，至少不丢内容
          for (const { label, value } of pairs) { put('others.otherInfo', `${label}：${value}`, `字段「${label}」（未识别）`); if (value) report.unplaced.push({ heading: label, lines: [value], why: 'unclassified_field' }); }
          continue;
        }
        if (t) put('others.otherInfo', t, `标题「${headingText}」`);
      }
      continue;
    }

    if (route === 'awards' || route === 'certifications' || route === 'competitions' || route === 'publications' || route === 'campus') {
      const { entries, pre } = splitEntryBlocks(body);
      const list = entries.length ? entries : bulletsOf(body).map(b => ({ header: b.text, lines: b.sub }));
      for (const e of list) {
        const { title, tail } = titleAndTail(e.header || '');
        if (!title) continue;
        const FIELD = {
          awards: { name: 'title', text: 'issuer', date: 'date' },
          certifications: { name: 'name', text: 'issuer', date: 'issueDate' },
          competitions: { name: 'name', text: 'award', date: 'date' },
          publications: { name: 'title', text: 'venue', date: 'date' },
          campus: { name: 'org', text: 'summary', date: 'startDate' },
        }[route];
        const i = nextSlot(route);
        const dates = parseDateRange(tail);
        put(`${route}.${i}.${FIELD.name}`, title, `标题「${headingText}」`);
        if (dates.start) put(`${route}.${i}.${FIELD.date}`, dates.start, '条目日期');
        if (dates.end && FIELD.date !== 'date') put(`${route}.${i}.endDate`, dates.end, '条目日期');
        const rest = bulletsOf(e.lines || []).map(entryLinesToText).filter(Boolean);
        if (rest.length) put(`${route}.${i}.${FIELD.text}`, rest.join('；'), '条目正文');
        report.stats.entries++;
      }
      continue;
    }

    // 列表型主区块：education / internship / work / projects
    const { entries, pre } = splitEntryBlocks(body);
    const source = entries.length ? entries : (() => {
      const bs = bulletsOf(body);
      return bs.map(b => ({ header: b.text, lines: b.sub }));
    })();
    if (pre.some(l => l.trim())) {
      const intro = pre.map(l => l.trim()).filter(Boolean).map(stripInline).join(' ');
      if (intro) { put('others.otherInfo', `「${headingText}」段首未归类文字：${intro}`, `标题「${headingText}」`); report.unplaced.push({ heading: headingText, lines: [intro], why: 'section_preamble' }); }
    }

    for (const e of source) {
      const { title, tail } = titleAndTail(e.header || '');
      if (!title) continue;
      const i = nextSlot(route);
      const dates = parseDateRange(tail);
      const parts = splitTitle(title);
      const bullets = bulletsOf(e.lines || []);
      report.stats.entries++;

      if (route === 'education') {
        const [schoolRaw, ...rest] = parts;
        const school = stripInline(schoolRaw);
        put(`education.${i}.school`, school, `教育条目「${title}」`);
        if (!/[一-龥]/.test(school)) put(`education.${i}.schoolEn`, school, '英文校名');
        const restText = rest.join(' ').trim();
        const paren = (restText.match(/[（(]([^）)]{2,80})[）)]/) || [])[1] || '';
        const mainLine = stripInline(restText.replace(/[（(][^）)]{2,80}[）)]/g, ' ')).replace(/\s+/g, ' ').trim();
        const dg = degreeOf(mainLine || restText || title);
        if (dg) put(`education.${i}.degree`, dg, '按标题词推断');
        const major = mainLine
          .replace(/(硕士学位研究生|硕士学位|硕士|学士学位|学士|博士学位|博士|研究生)/g, ' ')
          .replace(/\b(M\.?Sc|M\.?Eng|B\.?Sc|B\.?Eng|Master|Bachelor|PhD|Doctor|Doctorate)\b/gi, ' ')
          .replace(/^\s*(in|of|en|on)\s+/i, '')
          .replace(/[\s、，,;；]+$/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        if (major) put(`education.${i}.major`, major, `教育条目「${title}」`);
        if (paren && /[A-Za-z]/.test(paren)) put(`education.${i}.majorEn`, paren, '标题括号内英文名');
        else if (major && !/[一-龥]/.test(major)) put(`education.${i}.majorEn`, major, '英文专业名');
        put(`education.${i}.enrollDate`, dates.start, '条目日期');
        if (dates.expected) put(`education.${i}.gradDate`, dates.expected, '预计毕业时间');
        else if (!dates.current) put(`education.${i}.gradDate`, dates.end, '条目日期');
        for (const b of bullets) {
          const t = stripInline(b.text);
          if (/主修课程|核心课程|courses/i.test(t)) put(`education.${i}.transcript`, t.replace(/^[^:：]*[:：]\s*/, ''), '主修课程');
          else put(`education.${i}.transcript`, t, '教育条目补充');
        }
      } else if (route === 'internship' || route === 'work') {
        const [company, ...rest] = parts;
        put(`${route}.${i}.company`, company, `${route === 'work' ? '工作' : '实习'}条目「${title}」`);
        if (rest.length) put(`${route}.${i}.title`, rest.join(' '), '条目职位');
        put(`${route}.${i}.startDate`, dates.start, '条目日期');
        put(`${route}.${i}.endDate`, dates.current ? '' : dates.end, '条目日期');
        if (dates.current) put(`${route}.${i}.current`, '是', '至今/Present');
        const city = (tail.match(/[—-]\s*([\u4e00-\u9fa5A-Za-z ]{2,20})/) || [])[1];
        if (city) put(`${route}.${i}.city`, city.trim(), '条目地点');
        const lines = [];
        for (const b of bullets) {
          const t = stripInline(b.text);
          lines.push([t, ...b.sub.map(s => stripInline(s))].filter(Boolean).join(' — '));
        }
        if (lines.length) put(`${route}.${i}.summary`, lines.join('\n'), '条目正文');
      } else if (route === 'projects') {
        const paren = title.match(/[（(]([^）)]{2,60})[）)]/);
        const name = title.replace(/[（(][^）)]{2,60}[）)]/, '').trim();
        put(`projects.${i}.name`, name || title, `项目「${name || title}」`);
        if (paren) put(`projects.${i}.org`, paren[1].trim(), '项目标题括号说明');
        put(`projects.${i}.startDate`, dates.start, '条目日期');
        put(`projects.${i}.endDate`, dates.current ? '' : dates.end, '条目日期');
        const lines = bullets.map(entryLinesToText).filter(Boolean);
        if (lines.length) put(`projects.${i}.description`, lines.join('\n'), '项目正文');
        const role = (stripInline(title).match(/^(负责|主导|参与|独立)/) || [])[1];
        if (role) put(`projects.${i}.role`, role, '标题角色前缀');
      }
    }
    if (!LIST_SECTIONS.has(route) && route !== 'skills') report.unmappedHeadings.push(headingText);
  }

  // 一致性推导：把散落在教育条目里的信息同步到高频问法
  const firstEdu = (profile.education || [])[0] || {};
  if (firstEdu.gradDate) {
    const y = String(firstEdu.gradDate).slice(0, 4);
    if (y && /^\d{4}$/.test(y)) {
      setValueByPath(profile, 'intent.gradStatus', getValueByPath(profile, 'intent.gradStatus') || '应届毕业生');
      setValueByPath(profile, 'basics.graduateYear', getValueByPath(profile, 'basics.graduateYear') || y);
      setValueByPath(profile, 'intent.availableDate', getValueByPath(profile, 'intent.availableDate') || `${y}-07-01`);
      report.derived = ['intent.gradStatus=应届毕业生', `basics.graduateYear=${y}`, `intent.availableDate=${y}-07-01`];
    }
  }

  if (!getValueByPath(profile, 'contact.phone') && getValueByPath(profile, 'contact.altPhone')) {
    setValueByPath(profile, 'contact.phone', getValueByPath(profile, 'contact.altPhone'));
    report.derived = (report.derived || []).concat('contact.phone ← 暂用唯一的境外号，如有内地号请手动替换');
  }
  report.stats.filled = report.mapped.length;
  return { profile, report };
}
