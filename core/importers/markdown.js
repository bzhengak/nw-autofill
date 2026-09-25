// 简历 Markdown → profile 导入器（纯函数，无 DOM、无网络）。
// 设计约束：
//  1. 按"标题文本"路由，不按 # 层级——实测两份简历一份用 #、另一份用 ##。
//  2. 只填空着的槽位，绝不覆盖你手工补过的字段（opts.overwrite 才覆盖）。
//  3. 每个写入都记进 report.mapped，导入后必须能看见"哪句话进了哪个字段"。
//  4. 认不出的标题进 report.unmappedHeadings，不要静默丢弃内容。

import { createEmptyProfile, getValueByPath, setValueByPath } from '../profile-schema.js';

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const BULLET_RE = /^\s*([*+-])\s+(.*)$/;

const SECTION_KEYWORDS = [
  { key: 'others.selfIntro', re: /(个人简介|自我评价|自我介绍|_summary|professional summary|^summary$|profile|关于我|求职优势)/i },
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
  { key: 'languages', re: /(语言|language)/i },
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
  const report = { mapped: [], unmappedHeadings: [], warnings: [], skippedExisting: [], stats: { entries: 0, bullets: 0 } };

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
        if (/(软件|mlops|编程|程序|开发语言|software|platform|engineering|infrastructure)/.test(label)) target = 'skills.programming';
        else if (/(工具|tool|办公|office|ide)/.test(label)) target = 'skills.tools';
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
      const all = body.map(l => l.replace(BULLET_RE.source, '$2')).join(' ');
      for (const lang of parseLanguages(all)) put(`languages.${nextSlot('languages')}.language`, lang.language, '语言条目'), put(`languages.${listCursor.languages}.level`, lang.level, '语言条目');
      continue;
    }

    if (route === 'intent' || route === 'contact' || route === 'basics') {
      for (const item of bulletsOf(body)) {
        const t = stripInline(item.text);
        const kv = t.match(/^(语言|languages)[:：]\s*(.+)$/i);
        if (kv && /语言|language/i.test(kv[1])) {
          for (const lang of parseLanguages(kv[2])) {
            const i = nextSlot('languages');
            put(`languages.${i}.language`, lang.language, '其他信息·语言');
            put(`languages.${i}.level`, lang.level, '其他信息·语言');
          }
          continue;
        }
        const label = (t.match(/^(.{2,12}?)[:：]\s*(.+)$/) || []);
        if (label[1] && label[2]) {
          if (/兴趣|爱好|hobb|interest/i.test(label[1])) put('others.hobbies', label[2], `条目「${label[1]}」`);
          else if (/作品集|主页|portfolio|site/i.test(label[1])) put('others.portfolio', label[2], `条目「${label[1]}」`);
          else if (/ github/i.test(label[1])) put('others.github', label[2], `条目「${label[1]}」`);
          else if (/linkedin/i.test(label[1])) put('others.linkedin', label[2], `条目「${label[1]}」`);
          else if (/期望|意向|城市|到岗|salary/i.test(label[1])) put('intent.willingnessNote', `${label[1]}：${label[2]}`, `条目「${label[1]}」`);
          else put('others.otherInfo', `${label[1]}：${label[2]}`, `条目「${label[1]}」`);
        } else if (t) {
          put('others.otherInfo', t, `标题「${headingText}」`);
        }
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
      if (intro) put('others.otherInfo', `「${headingText}」段首未归类文字：${intro}`, `标题「${headingText}」`);
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
