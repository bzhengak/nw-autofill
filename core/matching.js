// 纯匹配原语：文本归一化、类型嗅探、打分、全局最优分配、日期格式策略。
// 无 DOM、无 chrome API，全部可被 node --test 覆盖。
//
// 归一化与候选标签打分的思路参考上游项目 shared/field-text.js，
// 但这里是独立实现（简繁/全半角归一、括号降级、CJK 二元组、缩写扩展）。
// 见 NOTICE.md。

const T2S = {
  // 港企 / 繁体表单里高频出现的求职词汇
  個: '个', 們: '们', 稱: '称', 號: '号', 電: '电', 話: '话', 郵: '邮', 貳: '贰',
  歷: '历', 學: '学', 國: '国', 際: '际', 應: '应', 屆: '届', 業: '业', 崗: '岗',
  種: '种', 類: '类', 証: '证', 證: '证', 檔: '档', 紀: '纪', 緯: '纬', 選: '选',
  擇: '择', 願: '愿', 歡: '欢', 時: '时', 間: '间', 開: '开', 開: '开', 開始: '开始',
  結: '结', 束: '束', 住: '住', 蹟: '迹', 联: '联', 係: '系', 關: '关', 聯: '联',
  通: '通', 訊: '讯', 訊: '讯', 僱: '雇', 傭: '佣', 資: '资', 薪: '薪', 訖: '讫',
  欄: '栏', 項: '项', 頁: '页', 編: '编', 碼: '码', 備: '备', 註: '注', 籤: '签',
  於: '于', 至: '至', 或: '或', 並: '并', 與: '与', 從: '从', 會: '会', 員: '员',
  務: '务', 優: '优', 勢: '势', 缺: '缺', 點: '点', 歡: '欢', 樂: '乐', 趣: '趣',
  經: '经', 驗: '验', 簡: '简', 歷: '历', 願: '愿', 意: '意', 向: '向', 望: '望',
};

const HALF = { '，': ',', '：': ':', '；': ';', '（': '(', '）': ')', '【': '[', '】': ']', '、': ',', '／': '/', '－': '-', '　': ' ' };

const ABBR = {
  tel: 'telephone phone', ph: 'phone', mob: 'mobile', mail: 'email', eml: 'email', e: 'email',
  dob: 'date of birth birthday', nat: 'nationality', natl: 'national', ltr: 'letter',
  yrs: 'years', yr: 'year', mo: 'month', dt: 'date', add: 'address', addr: 'address',
  pos: 'position', post: 'position', qty: 'quantity', exp: 'experience expected',
  qual: 'qualification', cert: 'certificate', pers: 'personal', info: 'information',
  city: 'city location', loc: 'location', pref: 'preference preferred', cur: 'current currency',
  avail: 'available availability', spons: 'sponsorship', auth: 'authorization',
  fam: 'family', rel: 'relation relationship', emp: 'employer employment', com: 'company',
  univ: 'university', grad: 'graduation graduate', maj: 'major', deg: 'degree',
  手: '手机 电话', 电: '电话 邮箱', 联: '联系', 住: '地址', 毕: '毕业', 在: '在读',
};

export function toHalfWidth(s) {
  return String(s).replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\u3000]/g, ' ');
}

export function simplify(s) {
  return String(s).replace(/[一-龥]/g, ch => T2S[ch] || ch);
}

export function normalize(text) {
  let s = toHalfWidth(text);
  s = simplify(s);
  s = s.toLowerCase();
  for (const [k, v] of Object.entries(HALF)) s = s.split(k).join(v);
  s = s.replace(/[＊*\s]+/g, ' ');
  // 中文标签里的空格是排版噪音（"姓 名"），必须吃掉，否则别名永远对不上
  s = s.replace(/([\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff])(?:\s+)(?=[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff])/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** 去掉括号补充说明与标点，得到"主干语义"。最高学历（含在读）→ 最高学历 */
export function core(text) {
  let s = normalize(text);
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/[?？!！:;,.\-_/\\|]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

const CJK = /[㐀-䶿一-鿿぀-ヿ]/;

/** 中文按二元组、英文按词，统一成可比较的信号集合 */
export function signals(text) {
  const s = new Set();
  const c = core(text);
  const n = normalize(text);
  if (!c) return { tokens: s, full: n };
  s.add(c);
  const latin = c.match(/[a-z0-9.]+/g) || [];
  for (const w of latin) {
    s.add(w);
    if (ABBR[w]) for (const alt of ABBR[w].split(' ')) s.add(alt);
  }
  const cjkRuns = c.match(/[㐀-鿿぀-ヿ]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length <= 2) { s.add(run); continue; }
    for (let i = 0; i + 2 <= run.length; i++) s.add(run.slice(i, i + 2));
  }
  return { tokens: s, full: n };
}

const PATTERNS = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  tel: /^(\+?\d[\d\s\-().]{5,})$/,
  url: /^(https?:\/\/|www\.)\S+$/,
  date: /^\d{4}([-/.年]\d{1,2})([-/.月]\d{1,2}日?)?$/,
};

export function sniffType(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (PATTERNS.email.test(s)) return 'email';
  if (PATTERNS.url.test(s)) return 'url';
  if (PATTERNS.date.test(s)) return 'date';
  if (PATTERNS.tel.test(s) && !/[a-z]/i.test(s)) return 'tel';
  return 'text';
}

/** 类型兼容性：返回 1（兼容）/ 0.6（不冲突但弱）/ 0（明显不该填这个字段） */
export function typeCompatible(fieldType, profileField, value) {
  const sniffed = sniffType(value);
  const ft = fieldType || 'text';
  const pt = profileField.type;
  // 页面字段声明的类型与 profile 字段类型是否可能同类（空值时只能靠这个）
  const DECLARED_OK = {
    email: ['email'], tel: ['tel', 'text', 'num'], url: ['url', 'text'],
    date: ['date', 'month', 'year', 'text'], month: ['date', 'month', 'year', 'text'],
    year: ['date', 'month', 'year', 'text'], number: ['num', 'text', 'year'],
  };
  const declared = DECLARED_OK[ft] ? (DECLARED_OK[ft].includes(pt) ? 1 : 0.08) : 1;
  if (!value) return declared;
  if (ft === 'email' || pt === 'email') return sniffed === 'email' && (ft === 'email' || pt === 'email') ? 1 : (ft === 'email' || pt === 'email' ? 0 : 0.6);
  if (ft === 'tel' || pt === 'tel') return sniffed === 'tel' ? 1 : (/[a-z\u4e00-\u9fff]/i.test(value) ? 0 : 0.9);
  if (ft === 'date' || ft === 'month' || ft === 'year' || pt === 'date' || pt === 'month' || pt === 'year') {
    return sniffed === 'date' || /^\d{4}$/.test(value) ? 1 : 0.15;
  }
  if (ft === 'bool') return 0.5;
  if (ft === 'num') return /^[\d.,\-–%~ ]+$/.test(value) ? 1 : 0.2;
  if (sniffed === 'email' && pt !== 'email') return 0.1;
  if ((ft === 'url' || pt === 'url') && sniffed !== 'url') return 0.4;
  return 1;
}

/**
 * 单个"页面字段 × profile 字段"打分，0..1。
 * 信号来源：标签别名精确命中 > 主干包含 > 词元重合 > id/name 属性语义 > placeholder。
 */
export function scorePair(pageField, profileField) {
  const labelSigs = signals(pageField.label || '');
  const aliasSigs = signals(profileField.zh + ' ' + profileField.labels.join(' '));
  let best = 0;

  const normLabel = normalize(pageField.label);
  for (const alias of profileField.labels) {
    const a = normalize(alias);
    if (!a) continue;
    // 精确命中也要继续走后面的章节/类型调制，
    // 否则"单位名称"这类在 work 与 internship 里都出现的别名会变成平局随机漂移。
    if (normLabel === a) { best = 1; continue; }
    const ac = core(a);
    if (ac && normLabel && core(normLabel) === ac) best = Math.max(best, 0.95);
    if (ac && ac.length >= 2) {
      if (normLabel.includes(ac)) best = Math.max(best, 0.86 + Math.min(0.06, ac.length / 60));
      else if (ac.includes(normLabel) && normLabel.length >= 2) best = Math.max(best, 0.7);
    }
  }

  // 词元重合
  const overlap = [...labelSigs.tokens].filter(t => aliasSigs.tokens.has(t));
  if (overlap.length) {
    const w = overlap.reduce((m, t) => Math.max(m, t.length), 0);
    const jaccard = overlap.length / Math.max(2, Math.min(labelSigs.tokens.size, aliasSigs.tokens.size));
    best = Math.max(best, Math.min(0.8, 0.32 + jaccard * 0.5 + (w >= 3 ? 0.12 : 0)));
  }

  // 结构信号：name / id / 自动化测试属性里往往是英文语义
  const structText = [pageField.name, pageField.id, pageField.testId, pageField.autocomplete].filter(Boolean).join(' ');
  if (structText) {
    const ss = signals(structText.replace(/[._-]+/g, ' '));
    const so = [...ss.tokens].filter(t => aliasSigs.tokens.has(t));
    if (so.length) best = Math.max(best, Math.min(0.85, 0.45 + so.length * 0.12));
    if (pageField.autocomplete) {
      const acMap = {
        'given-name': ['firstname', 'preferredname'], 'family-name': ['lastname'], 'name': ['name'],
        'email': ['email'], 'tel': ['phone'], 'street-address': ['address'], 'postal-code': ['postalcode'],
        'organization': ['company'], 'organization-title': ['title'], 'bday': ['birthdate'],
      };
      if ((acMap[pageField.autocomplete] || []).some(k => profileField.path.includes(k))) best = Math.max(best, 0.9);
    }
  }

  // 上下文与邻近标签：弱信号，避免把整段经历的第一行误分配给不相干字段
  const ctx = [pageField.placeholder, ...(pageField.nearbyLabels || [])].filter(Boolean).join(' ');
  if (ctx) {
    const cs = signals(ctx);
    const co = [...cs.tokens].filter(t => aliasSigs.tokens.has(t) && t.length >= 2);
    if (co.length) best = Math.max(best, Math.min(0.62, 0.34 + co.length * 0.09));
  }

  if (best === 0) return 0;

  const compat = typeCompatible(pageField.type, profileField, String(pageField.currentValue ?? ''));
  if (compat === 0) return 0;
  best *= compat >= 1 ? 1 : 0.72 + compat * 0.28;

  // 枚举字段：页面 option 文本与 profile 候选值有交集则加权
  if (pageField.options?.length && profileField.options?.length) {
    const hit = pageField.options.filter(o => profileField.options.some(p => normalize(o) === normalize(p))).length;
    if (hit) best = Math.min(1, best + 0.08);
    else best *= 0.8;
  }

  // 重复区块对齐：页面第 i 段经历优先映射到 profile 第 i 段
  if (pageField.itemIndex != null && profileField.itemIndex != null) {
    best *= pageField.itemIndex === profileField.itemIndex ? 1.08 : 0.82;
  } else if ((pageField.itemIndex == null) !== (profileField.itemIndex == null)) {
    best *= 0.8;
  }
  // 章节归属惩罚只用于"经历类"可重复分组（work / internship / education / projects…），
  // 因为只有它们会在页面上互相抢位。银行表格里"七、档案与证明"下混放英语等级等
  // 一次性字段，若一律重罚就会把它们误杀成 no_candidate。
  const AMBIGUOUS_SECTIONS = new Set(['education', 'work', 'internship', 'projects', 'campus', 'awards', 'competitions', 'publications', 'languages', 'certifications', 'family', 'skills']);
  if (pageField.sectionHint && profileField.section
    && AMBIGUOUS_SECTIONS.has(pageField.sectionHint) && AMBIGUOUS_SECTIONS.has(profileField.section)) {
    best *= pageField.sectionHint === profileField.section ? 1.12 : 0.55;
  } else if (pageField.sectionHint && profileField.section && pageField.sectionHint === profileField.section) {
    best *= 1.06;
  }

  return Math.min(1, best);
}

/**
 * 稀疏二分图最大权匹配（Kuhn-Munkres / 增广路 + 势函数）。
 * 目的：避免"贪心分配"造成整页字段串行错位——例如两段实习的 company 互相抢位。
 * cost = 上限 - score，配合每行独占的 dummy 列（score 0）实现"允许不分配"。
 */
export function assignMaxWeight(scoreMatrix, nCols) {
  const nRows = scoreMatrix.length;
  if (!nRows) return [];
  const m = Math.max(nCols, 0);
  const C = 1.000001;
  // cols: 0..m-1 为真实 profile 字段；m..m+nRows-1 为每行的 dummy（不分配）
  const totalCols = m + nRows;
  const u = new Array(nRows + 1).fill(0);
  const v = new Array(totalCols + 1).fill(0);
  const p = new Array(totalCols + 1).fill(0);
  const way = new Array(totalCols + 1).fill(0);

  const cost = (i, j) => {
    if (j < m) {
      const s = scoreMatrix[i][j];
      return s > 0 ? C - s : C * 2; // 负分/零分：极高代价，等价于禁止
    }
    return j - m === i ? C : C * 3; // 本行 dummy = "得分 0"的退路；其它行的 dummy 禁止
  };

  for (let i = 1; i <= nRows; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(totalCols + 1).fill(Infinity);
    const used = new Array(totalCols + 1).fill(false);
    do {
      used[j0] = true;
      let i0 = p[j0], delta = Infinity, j1 = -1;
      for (let j = 1; j <= totalCols; j++) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= totalCols; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const out = [];
  for (let j = 1; j <= totalCols; j++) {
    if (p[j] && j <= m) out.push({ row: p[j] - 1, col: j - 1, score: scoreMatrix[p[j] - 1][j - 1] });
  }
  return out;
}

// ---- 日期格式策略 -------------------------------------------------------

const DATE_PATTERNS = [
  { id: 'yyyy-MM-dd', re: /^\d{4}-\d{2}-\d{2}$/, out: d => `${d.y}-${d.m}-${d.dd}` },
  { id: 'yyyy/MM/dd', re: /^\d{4}[/.]\d{1,2}[/.]\d{1,2}$/, out: d => `${d.y}/${d.m}/${d.dd}` },
  { id: 'yyyyMMdd', re: /^\d{8}$/, out: d => `${d.y}${d.m}${d.dd}` },
  { id: 'yyyy年MM月dd日', re: /^\d{4}年\d{1,2}月\d{1,2}日$/, out: d => `${d.y}年${d.m}月${d.dd}日` },
  { id: 'yyyy年MM月', re: /^\d{4}年\d{1,2}月$/, out: d => `${d.y}年${d.m}月` },
  { id: 'yyyy-MM', re: /^\d{4}-\d{2}$/, out: d => `${d.y}-${d.m}` },
  { id: 'yyyyMM', re: /^\d{6}$/, out: d => `${d.y}${d.m}` },
  { id: 'MM/yyyy', re: /^\d{1,2}\/\d{4}$/, out: d => `${d.m}/${d.y}` },
  { id: 'yyyy/MM', re: /^\d{4}[/.]\d{1,2}$/, out: d => `${d.y}/${d.m}` },
  { id: 'MM/dd/yyyy', re: /^\d{1,2}[/.]\d{1,2}[/.]\d{4}$/, out: d => `${d.m}/${d.dd}/${d.y}`, usFirst: true },
  { id: 'dd/MM/yyyy', re: /^\d{1,2}[/.]\d{1,2}[/.]\d{4}$/, out: d => `${d.dd}/${d.m}/${d.y}`, usFirst: false },
  { id: 'MMM yyyy', re: /^[a-z]{3,9}\s+\d{4}$/i, out: d => `${MONTH_NAMES[d.m - 1]} ${d.y}` },
  { id: 'yyyy-MM-ddTHH:mm', re: /^\d{4}-\d{2}-\d{2}t/, out: d => `${d.y}-${d.m}-${d.dd}t00:00` },
  { id: 'yyyy', re: /^\d{4}$/, out: d => `${d.y}` },
];

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * 占位符/提示语里的"格式模板"（yyyy-MM-dd、DD/MM/YYYY、YYYY年MM月）要先于实际值判断。
 * 否则 'yyyy/mm/dd' 会因为含有子串 'mm/dd' 被误判成美式格式。
 */
const DATE_TEMPLATES = [
  { re: /^y{4}\s*[-/.]\s*m{1,2}\s*[-/.]\s*d{1,2}$/, id: d => (d.includes('.') || d.includes('/')) ? 'yyyy/MM/dd' : 'yyyy-MM-dd' },
  { re: /^d{1,2}\s*[-/.]\s*m{1,2}\s*[-/.]\s*y{4}$/, id: () => 'dd/MM/yyyy' },
  { re: /^m{1,2}\s*[-/.]\s*d{1,2}\s*[-/.]\s*y{4}$/, id: () => 'MM/dd/yyyy' },
  { re: /^y{4}\s*[年]\s*m{1,2}\s*月\s*d{1,2}\s*日?$/, id: () => 'yyyy年MM月dd日' },
  { re: /^y{4}\s*[年]\s*m{1,2}\s*月$/, id: () => 'yyyy年MM月' },
  { re: /^y{4}\s*[-/.]\s*m{1,2}$/, id: d => (d.includes('.') || d.includes('/')) ? 'yyyy/MM' : 'yyyy-MM' },
  { re: /^m{1,2}\s*[-/.]\s*y{4}$/, id: () => 'MM/yyyy' },
  { re: /^y{4}\s*m{1,2}\s*d{1,2}$/, id: () => 'yyyyMMdd' },
  { re: /^y{4}\s*m{1,2}$/, id: () => 'yyyyMM' },
  { re: /^mmm?\.?\s*y{4}$/, id: () => 'MMM yyyy' },
  { re: /^y{4}$/, id: () => 'yyyy' },
];

function templateOf(text) {
  const s = normalize(text);
  if (!s) return '';
  for (const t of DATE_TEMPLATES) {
    if (t.re.test(s)) return t.id(s);
  }
  return '';
}

/** 从页面线索（占位符模板 → 已有样例值 → 标签关键词）推断日期格式 */
export function inferDateFormat({ label = '', placeholder = '', sample = '', inputType = '' } = {}) {
  if (inputType === 'month') return 'yyyy-MM';
  if (inputType === 'date') return 'yyyy-MM-dd';

  for (const src of [placeholder, label]) {
    const t = templateOf(src);
    if (t) return t;
  }
  for (const src of [sample]) {
    const s = String(src || '').trim().toLowerCase();
    if (!s) continue;
    for (const pat of DATE_PATTERNS) if (pat.re.test(s)) return pat.id;
  }
  const t = normalize(label + ' ' + placeholder);
  if (/(年月|month.*year|毕业|入学|入职|起始|截止)/.test(t) && !/(日|day|\bdd\b)/.test(t)) return 'yyyy-MM';
  if (/(dd\/mm|日\/月|港|hk|英国|uk|新加坡|sg)/.test(t)) return 'dd/MM/yyyy';
  if (/(mm\/dd|美|us|usa)/.test(t)) return 'MM/dd/yyyy';
  return 'yyyy-MM-dd';
}

/** 把 profile 里的日期（支持 2026-06 / 2026-06-30 / 2026年6月）格式化到目标 pattern */
const DAY_LEVEL = {
  'yyyy-MM-dd': 'yyyy-MM',
  'yyyy/MM/dd': 'yyyy/MM',
  'yyyyMMdd': 'yyyyMM',
  'yyyy年MM月dd日': 'yyyy年MM月',
  'MM/dd/yyyy': 'MM/yyyy',
  'dd/MM/yyyy': 'MM/yyyy',
};
const MONTH_LEVEL = new Set(['yyyy-MM', 'yyyy/MM', 'yyyyMM', 'yyyy年MM月', 'MMM yyyy', 'MM/yyyy', 'yyyy']);

export function formatDate(raw, patternId) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/(\d{4})\D{0,3}(\d{1,2})?(?:\D{0,3}(\d{1,2}))?/);
  if (!m) return s;
  const hasMonth = Boolean(m[2]);
  const hasDay = Boolean(m[3]);
  let pat = DATE_PATTERNS.find(p => p.id === patternId) || DATE_PATTERNS[0];
  // 资料里只有年月，而页面要完整日期 → 降级到该格式的年月版本，绝不臆造日期
  if (!hasDay && DAY_LEVEL[pat.id]) pat = DATE_PATTERNS.find(p => p.id === DAY_LEVEL[pat.id]) || pat;
  if (!hasMonth && pat.id !== 'yyyy') pat = DATE_PATTERNS.find(p => p.id === 'yyyy') || pat;
  if ((hasDay || hasMonth) && MONTH_LEVEL.has(pat.id) && !hasMonth) return m[1];
  return pat.out({
    y: m[1],
    m: (m[2] || '01').padStart(2, '0'),
    dd: (m[3] || '01').padStart(2, '0'),
  });
}

export function boolLike(value) {
  const s = normalize(value);
  if (['是', 'y', 'yes', 'true', '1', '有', '同意', '接受', '需要', 'male'].includes(s)) return true;
  if (['否', 'n', 'no', 'false', '0', '无', '不同意', '不接受', '不需要', 'female'].includes(s)) return false;
  return null;
}
