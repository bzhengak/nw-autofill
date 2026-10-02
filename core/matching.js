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
  // 标点换成空格后，中文字之间的空格要再吃一遍：'姓 - 拼音' 与 '姓 拼音' 必须收敛成同一个主干
  s = s.replace(/([\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff])(?:\s+)(?=[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff])/g, '$1');
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
/**
 * "经历类"可重复分组：只有它们会在页面上互相抢位，章节错配时才需要重罚。
 * 银行表格里"七、档案与证明"下混放英语等级等一次性字段，若一律重罚就会被误杀成 no_candidate。
 */
export const AMBIGUOUS_SECTIONS = new Set(['education', 'work', 'internship', 'projects', 'campus', 'awards', 'competitions', 'publications', 'languages', 'certifications', 'family', 'skills']);

/**
 * 问句式标签（"Do you require sponsorship to work in Hong Kong?"）。
 * 两处要用它，理由相反相成：
 * - matcher 用它收紧闸门：问句靠词元重合能被"兴趣爱好"蹭到，只许字面/主干命中。
 * - scorePair 用它豁免中心词惩罚：英文陈述式标签是右分支结构（"Current Job Title" 问的是
 *   title），末词是中心词；但问句不是——它的末词往往是 "hong kong" 这种状语，
 *   照陈述式规则罚 0.8 会让「是否需要签证担保」这种精确别名只拿到 0.40，整栏变成"我们没有词"。
 */
const QUESTION_WORD_RE = /\b(what|which|how|why|when|who|do you|are you|tell us|interest you|consider|describe)\b/i;

export function isQuestionLabel(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const words = core(raw).split(' ').filter(Boolean);
  if (words.length < 5) return false;
  return /[?？]$/.test(raw) || QUESTION_WORD_RE.test(raw);
}

export function scorePair(pageField, profileField) {
  const labelSigs = signals(pageField.label || '');
  const aliasSigs = signals(profileField.zh + ' ' + profileField.labels.join(' '));
  const labelIsQuestion = isQuestionLabel(pageField.labelRaw || pageField.label);
  let best = 0;

  const normLabel = normalize(pageField.label);
  let exactHit = false;
  for (const alias of profileField.labels) {
    const a = normalize(alias);
    if (!a) continue;
    // 精确命中也要继续走后面的章节/类型调制，
    // 否则"单位名称"这类在 work 与 internship 里都出现的别名会变成平局随机漂移。
    if (normLabel === a) { best = 1; exactHit = true; continue; }
    const ac = core(a);
    if (ac && normLabel && core(normLabel) === ac) best = Math.max(best, 0.95);
    if (ac && ac.length >= 2) {
      const labelCore = core(normLabel);
      if (labelCore.includes(ac)) {
        // 按"别名覆盖了标签多少内容"给分：'last name' 命中 'Last Name / Surname' 要比 'name' 更可信
        const cover = Math.min(1, ac.length / Math.max(labelCore.length, 1));
        // 覆盖率不到一半的包含关系是弱信号：'id number' ⊂ 'other contact number'（0.47）
        // 一度让证件号字段以 0.599 赢过真正的备用电话，属于"短别名蹭长标签"。
        // 例外：别名正好落在标签结尾（'job title' ⊂ 'current most recent job title'）是中心词命中，不弱化。
        if (cover >= 0.5 || labelCore.endsWith(ac)) {
          let s = 0.55 + 0.4 * cover;
          // 英文是右分支结构："Current Job Title" 问的是 title，'current job' 只是修饰。
          // 不带中心词（label 末词）的别名要让位，否则"是否在职"会赢过"职位名称"。
          const lw = labelCore.split(' ').filter(Boolean);
          const aw = ac.split(' ').filter(Boolean);
          const head = lw.length > 1 ? lw[lw.length - 1] : '';
          const tail = aw.length ? aw[aw.length - 1] : '';
          const pureLatin = /^[a-z0-9. ]+$/.test(labelCore) && /^[a-z0-9. ]+$/.test(ac);
          const headHit = !head || !tail || head === tail || head.startsWith(tail) || tail.startsWith(head);
          if (pureLatin && lw.length > 1 && !headHit && !labelIsQuestion) s *= 0.8;
          best = Math.max(best, s);
        }
      } else if (ac.includes(labelCore) && labelCore.length >= 2) {
        best = Math.max(best, 0.68);
      } else if (/^[a-z ]+$/.test(ac) && ac.length >= 8) {
        // 英文词形变化只认"长公共前缀 ≥8"：institute/institution 可通，
        // 而 currently → current（前缀仅 7）不通，避免把"是否在职"填进 Job Title
        const labelWords = labelCore.split(' ').filter(Boolean);
        const hit = labelWords.some(w => {
          if (w.length < 8) return false;
          let k = 0;
          while (k < Math.min(w.length, ac.length) && w[k] === ac[k]) k++;
          return k >= 8;
        });
        if (hit) best = Math.max(best, 0.6);
      }
    }
  }

  // 词元重合：CJK 二元组照用；拉丁词要求 ≥6 字符，否则 'check' 会把
  // "是否接受背景调查(background check)" 误配到 "Security Check" 这类框上
  const usable = new Set([...labelSigs.tokens].filter(t => !/^[a-z0-9 .]+$/.test(t) || t.length >= 6));
  const overlap = [...usable].filter(t => aliasSigs.tokens.has(t));
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

  // 标签证据封顶 0.95，把最后的 0.05 留给"章节/槽位对得上"这种修正量。
  // 不封顶的话结尾那个 Math.min(1, best) 会把奖惩一起抹平：别名精确命中的第 0 条与第 1 条经历
  // 都是 1×0.9×1.12 与 1×1.12 → 双双夹到 1.0 → 打平，匈牙利只能按列顺序随便挑，
  // 于是 legacy 表单的「最高学历」能拿到 education.1.degree（本科）而期待是 education.0（硕士）。
  best = Math.min(0.95, best);

  const compat = typeCompatible(pageField.type, profileField, String(pageField.currentValue ?? ''));
  if (compat === 0) return 0;
  best *= compat >= 1 ? 1 : 0.72 + compat * 0.28;

  // 枚举字段：页面的 option 文本与资料里的候选值有交集则加权，完全对不上则罚——
  // 这是"页面下拉只有 男/女，而资料写 Male"这类无声失败的唯一提前信号。
  // 以前这里拿 normalize(o) 比较，o 是 {text,value} 对象，永远得到 "[object object]"，
  // 于是所有带选项的枚举字段都被判成"对不上"而吃 ×0.8：SF 的 Current Work Authorization
  // 因此输给"工作城市"这种垃圾候选（0.529 vs 0.554），整栏红字。
  if (pageField.options?.length && profileField.options?.length) {
    const terms = profileField.options.map(v => normalize(v)).filter(t => t.length >= 1);
    const hit = pageField.options.filter(o => {
      const t = normalize(o?.text ?? o?.label ?? o?.value);
      return t && terms.some(x => t === x || (x.length >= 3 && (t.includes(x) || (t.length >= 3 && x.includes(t)))));
    }).length;
    if (hit) best = Math.min(0.95, best + 0.08);
    else best *= 0.8;
  }

  // 重复区块对齐：页面第 i 段经历优先映射到 profile 第 i 段
  // 重复区块对齐：页面第 i 段经历优先映射到 profile 第 i 段。
  // 但页面没识别出重复区块时（英文表单大多是单块布局），映射到第 0 槽是正常情况，不该罚。
  if (pageField.itemIndex != null && profileField.itemIndex != null) {
    best *= pageField.itemIndex === profileField.itemIndex ? 1.08 : 0.82;
  } else if (pageField.itemIndex == null && profileField.itemIndex != null) {
    best *= profileField.itemIndex === 0 ? 1 : 0.9;
  } else if (pageField.itemIndex != null && profileField.itemIndex == null) {
    best *= 0.8;
  }
  // 章节归属惩罚只用于"经历类"可重复分组（work / internship / education / projects…），
  // 因为只有它们会在页面上互相抢位。银行表格里"七、档案与证明"下混放英语等级等
  // 一次性字段，若一律重罚就会把它们误杀成 no_candidate。
  if (pageField.sectionHint && profileField.section
    && AMBIGUOUS_SECTIONS.has(pageField.sectionHint) && AMBIGUOUS_SECTIONS.has(profileField.section)) {
    best *= pageField.sectionHint === profileField.section ? 1.12 : 0.55;
  } else if (pageField.sectionHint && profileField.section && pageField.sectionHint === profileField.section) {
    best *= 1.06;
  } else if (pageField.sectionHint && profileField.section && pageField.sectionHint !== profileField.section) {
    // 页面明确说了这块是"基本信息"，那"家庭成员"的同名字段就不该赢；
    // 两侧都封顶到 1.0 时会打平，所以这里必须用乘法惩罚而不是靠排序。
    // 精确别名命中可以扛住一次*启发式章节判定*（SF 把 Expected Salary 摆在 Employment 小节里，
    // 章节线索是错的而 'expected salary' 是字面命中）；但目标若是 work/family/education 这类
    // 可重复列表槽位，就不给这个面子——"政治面貌"曾被 0.9 的宽松系数推进 family.0.political。
    best *= (exactHit && !AMBIGUOUS_SECTIONS.has(profileField.section)) ? 0.9 : 0.75;
  } else if (!pageField.sectionHint && profileField.itemIndex != null) {
    // 页面没有区块证据时，列表槽位（家庭成员、多段经历）让位于一次性字段：
    // 否则"政治面貌"会被家庭成员的 political 抢走，而页面上并没有任何"家庭成员"标题
    best *= 0.9;
  }

  return Math.min(1, best);
}

/**
 * 「凭什么认定这一栏是这个槽位」——打分给的是一个数，数不可解释，错了也看不出来。
 * 用户 2026-10-02 的口径是"审视你的匹配方法"，第一步就是让每次自动写入都能列出证据，
 * 并且**只有中心词证据**（`School Name` 里的 `name`）时不许自动写：
 * 网申栏位的身份由定语与板块决定，中心词只说"这是个名字/号码/日期"，不说"是谁的"。
 *
 * 注意这份证据是**独立分类**，不复制 scorePair 的算法：它回答"存在哪几种命中"，
 * scorePair 回答"这一对值多少分"。两者若哪天分歧，用例会把分歧照出来（tests/evidence.test.js）。
 */
export const GENERIC_HEAD_WORDS = new Set([
  'name', 'number', 'num', 'score', 'date', 'time', 'type', 'level', 'status', 'title', 'address', 'value',
]);

export function labelEvidence(pageField, profileField) {
  const kinds = new Set();
  const normLabel = normalize(pageField.label || '');
  const labelCore = core(normLabel);
  const lw = labelCore.split(' ').filter(Boolean);
  const head = lw.length > 1 ? lw[lw.length - 1] : '';
  const heads = new Set(lw.slice(-2));                      // 末词/末两词都算中心词位置
  for (const alias of profileField.labels || []) {
    const a = normalize(alias);
    if (!a) continue;
    const ac = core(a);
    if (!ac) continue;
    if (normLabel === a) { kinds.add('exact'); continue; }
    if (labelCore && labelCore === ac) { kinds.add('exact'); continue; }
    if (labelCore.includes(ac)) {
      const cover = Math.min(1, ac.length / Math.max(labelCore.length, 1));
      const aw = ac.split(' ').filter(Boolean);
      const isHead = aw.length === 1 ? (heads.has(aw[0]) || head === aw[0]) : labelCore.endsWith(ac);
      if (cover >= 0.5) kinds.add('full-cover');
      else if (isHead && GENERIC_HEAD_WORDS.has(aw[aw.length - 1])) kinds.add('head-only');
      else if (isHead) kinds.add('head-noun');
      else kinds.add('qualifier');
    } else if (ac.includes(labelCore) && labelCore.length >= 2) {
      kinds.add('broader');                                  // 别名比标签还宽："是否在职" ⊃ "在职"
    }
  }
  if (pageField.autocomplete) kinds.add('struct-autocomplete');
  const structText = [pageField.name, pageField.id, pageField.testId].filter(Boolean).join(' ').toLowerCase();
  if (structText) {
    const st = signals(structText.replace(/[._-]+/g, ' '));
    const aliasTokens = signals([profileField.zh, ...(profileField.labels || [])].join(' ')).tokens;
    if ([...st.tokens].some(t => t.length >= 4 && aliasTokens.has(t))) kinds.add('struct-attr');
  }
  if (pageField.options?.length && profileField.options?.length) {
    const terms = profileField.options.map(v => normalize(v)).filter(t => t.length >= 1);
    if (pageField.options.some(o => {
      const t = normalize(o?.text ?? o?.label ?? o?.value);
      return t && terms.some(x => t === x || (x.length >= 3 && (t.includes(x) || (t.length >= 3 && x.includes(t)))));
    })) kinds.add('options-hit');
  }
  if (pageField.sectionHint && profileField.section === pageField.sectionHint) kinds.add('section-agree');
  if (pageField.itemIndex != null && profileField.itemIndex != null && pageField.itemIndex === profileField.itemIndex) kinds.add('item-agree');

  const strong = ['exact', 'full-cover', 'qualifier', 'options-hit', 'struct-autocomplete', 'section-agree'];
  return {
    kinds,
    strong: [...kinds].some(k => strong.includes(k)),
    /** 只有中心词/结构属性这类"说不上是谁的"证据 */
    weakOnly: kinds.size > 0 && ![...kinds].some(k => strong.includes(k))
      && [...kinds].every(k => k === 'head-only' || k === 'head-noun' || k === 'struct-attr' || k === 'broader'),
  };
}

/**
 * 控件形状：只看站点自己声明的硬线索（input type / autocomplete / maxlength），
 * 不看 placeholder 猜 —— "请输入手机号"这类提示也可能写错，而把它当判据会把正常的栏位拦死。
 */
export function shapeOfControl(pageField) {
  const t = String(pageField.inputType || pageField.type || '').toLowerCase();
  const ac = String(pageField.autocomplete || '').toLowerCase();
  const max = Number(pageField.maxLength || pageField.maxlength || 0);
  if (t === 'email' || ac === 'email') return 'email';
  if (t === 'tel' || /^tel/.test(ac)) return 'tel';
  if (t === 'number' || t === 'range') return 'num';
  if (t === 'date' || t === 'month' || t === 'datetime-local') return 'date';
  if ((t === 'text' || !t) && max >= 7 && max <= 15 && /phone|mobile|tel|手机|电话/i.test(
    [pageField.name, pageField.id, pageField.label].filter(Boolean).join(' '))) return 'tel';
  return '';
}

/** 取值形状（宽松版：只用来判"明显不相容"，不做完整校验） */
export function valueShape(value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  const digits = v.replace(/[\s()+\-.]/g, '');
  if (/^[0-9]{7,15}$/.test(digits) && digits === v.replace(/[^0-9]/g, '')) return 'tel';
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v)) return 'email';
  if (/^[0-9]{15,18}([0-9Xx])?$/.test(v)) return 'idcard';
  if (/^\d{4}([-/年.])\d{1,2}([-/月.])?$/.test(v)) return 'date';
  if (/^-?\d+(\.\d+)?$/.test(v)) return 'num';
  return 'text';
}

/** 明显配错栏的唯一提前信号：控件形状与取值形状不相容。返回 '' 表示放行 */
export function shapeMismatch(pageField, value) {
  const want = shapeOfControl(pageField);
  if (!want) return '';
  const got = valueShape(value);
  if (!got || got === want) return '';
  if (want === 'tel' && (got === 'idcard' || got === 'email' || got === 'text')) return want;
  if (want === 'email' && got !== 'email') return want;
  if (want === 'num' && got !== 'num' && got !== 'date') return want;
  if (want === 'date' && got !== 'date' && got !== 'num') return want;
  return '';
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
  // 年/月两个框拆开的实现（Moka、Workday）：月份框只吃两位月份
  { id: 'MM', re: /^\d{2}$/, out: d => `${d.m}` },
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

/**
 * 纯数字样例（"05/06/2024"）在英文站点上两种顺序都可能：05-06 是 5 月 6 日（MM/DD，美式），
 * 也可能是 6 月 5 日（DD/MM，港英/欧陆）。猜错的后果是把生日、毕业月写反，
 * 而且回读还是"绿"的。所以：两段都 ≤12 时判为不可知，返回 ''（由上层降级成待人工确认）。
 * 只要文本里有字面 d/m/y（占位符 "DD/MM/YYYY"）或首段 >12，就仍然可以确定。
 */
function numericDateOrder(text) {
  const s = normalize(text);
  const m = s.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/);
  if (!m) return 'unknown';
  const a = Number(m[1]), b = Number(m[3]);
  if (a > 12) return 'dd/MM/yyyy';
  if (b > 12) return 'MM/dd/yyyy';
  return 'ambiguous';
}

function templateOf(text) {
  const s = normalize(text);
  if (!s) return '';
  if (/[dmy]/i.test(s) && !/^\d/.test(s)) {
    // 占位符形态（dd/mm/yyyy）：按字母顺序判定
    for (const t of DATE_TEMPLATES) if (t.re.test(s)) return t.id(s);
    return '';
  }
  const order = numericDateOrder(s);
  if (order === 'ambiguous') return '';
  if (order !== 'unknown') return order;
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
const MONTH_LEVEL = new Set(['yyyy-MM', 'yyyy/MM', 'yyyyMM', 'yyyy年MM月', 'MMM yyyy', 'MM/yyyy', 'yyyy', 'MM']);

/**
 * 把一个日期值拆成年/月/日三段（供"年框 + 月框"这种拆分实现使用）。
 * 缺的段返回空串而不是补 01：拆分填写时，缺月份就必须让月框留空并说明原因，
 * 借 formatDate 的降级逻辑会把年份写进月框里。
 */
export function dateParts(raw) {
  const m = String(raw || '').trim().match(/(\d{4})(?:\D{0,3}(\d{1,2}))?(?:\D{0,3}(\d{1,2}))?/);
  if (!m) return { year: '', month: '', day: '' };
  return {
    year: m[1] || '',
    month: m[2] ? String(m[2]).padStart(2, '0') : '',
    day: m[3] ? String(m[3]).padStart(2, '0') : '',
  };
}

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

/**
 * 否定词护栏：'全日制' 不得命中 '非全日制'，'婚' 不得命中 '未婚'。
 * 来自 TshyGO 的 ai-helpers 与 ailock 的社区经验——枚举字段一旦选反，
 * 站点不会报错，会安静地把错误答案交上去，是最糟的失败模式。
 */
export function negationMismatch(optionText, target) {
  const ot = normalize(optionText), t = normalize(target);
  if (!ot || !t || ot === t) return false;
  const occurrences = [];
  for (let i = ot.indexOf(t); i >= 0; i = ot.indexOf(t, i + 1)) occurrences.push(i);
  if (!occurrences.length) return false;
  const negatedAt = idx => {
    const before = ot.slice(0, idx);
    return /[非不无未]$/.test(before) || /(?:^|[^a-z])(?:non|un|dis|ex|anti|without|no)[-_ ]?$/.test(before);
  };
  // 只有当目标词每一次出现都被否定词修饰时才算"选反"，否则仍可用
  return occurrences.every(negatedAt);
}

/**
 * 标签质量评估（招行真实结构教出来的：一整排日期字段的"标签"都是 placeholder「请选择时间」，
 * 直接用会把开始时间/结束时间/获奖时间糊成同一题）。借鉴同类项目 shared/field-text.js 的打分思路，独立实现。
 */
const GENERIC_LABEL_RE = /^(请选择.*|请输入.*|请填写.*|请填入.*|请选取.*|please\s*(select|enter|input|choose).*|select.*|enter.*|choose.*|items selected|搜索|search|type to add.*|键入以.*)$/i;
const NOISE_LABEL_RE = /^(created with sketch|image|icon|logo|svg|picture|photo icon|[\s\W]*)$/i;
const LABEL_KEYWORD_RE = /(姓名|曾用名|手机|电话|邮箱|邮件|证件|身份|学历|学位|学校|院校|学院|班级|导师|实验室|职位|职务|岗位|公司|单位|企业|部门|城市|地区|籍贯|户口|生源|出生|日期|时间|开始|结束|毕业|入学|成绩|排名|绩点|gpa|外语|英语|等级|证书|奖项|获奖|奖学金|技能|婚姻|政治|面貌|民族|身高|体重|健康|宗教|爱好|特长|期望|意向|到岗|薪资|薪酬|推荐|渠道|理由|评价|描述|职责|内容|关系|联系人|备注|编号|类型|方式|地点|状态|经历|项目|研究|方向|志愿|调剂|微信|邮箱|键入|添加|qualification|nationality|marital|surname|given name|postcode|postal|hometown|guardian|referee|emergency|mobile|telephone|passport|student id|notice period|salary)/i;

/** 作者显式声明的标签来源，优先级高于一切推断文本（SF 的 `<label for>` 旁边就站着 `<legend>Education</legend>`） */
const EXPLICIT_LABEL_SOURCES = new Set(['label-for', 'aria-labelledby', 'aria-label', 'wrapped-label']);

export function isGenericLabel(text) {
  const t = core(text);
  return !t || GENERIC_LABEL_RE.test(String(text || '').trim()) || GENERIC_LABEL_RE.test(t);
}

export function isNoiseLabel(text) {
  const raw = String(text || '').trim().replace(/[.!。！？?、,，;；:：]+$/, '');
  // JS 的 \W 不认中日韩字符，直接套用会把整段中文标签判成噪声（回归时中文表单命中率从 100% 掉到 26%）。
  if (/[㐀-䶿一-鿿぀-ヿ]/.test(raw)) return false;
  return NOISE_LABEL_RE.test(raw);
}

/** @param {boolean} [isHeading] 候选来自小节/卡片标题时降权：它是"这一块的题目"，不是这个字段的标签 */
export function scoreLabelCandidate(text, depth = 0, isHeading = false, source = '') {
  const raw = String(text || '').trim();
  if (!raw || isNoiseLabel(raw)) return Number.NEGATIVE_INFINITY;
  const t = core(raw);
  // 长度上限只对"推断出来的邻近文本"生效：<label for> 这种作者显式声明的标签即使很长也是正解
  // （SF 的「If other University/College, please specify」42 字符，旧上限把它直接丢掉，
  // 结果让上一节的 h3「Personal Information」冒充标签）
  if (!t || t.length > (EXPLICIT_LABEL_SOURCES.has(source) ? 90 : 40)) return Number.NEGATIVE_INFINITY;
  let s = 0;
  s += isGenericLabel(raw) ? -7 : 7;
  if (LABEL_KEYWORD_RE.test(t)) s += 8;
  if (t.length >= 2 && t.length <= 14) s += 4; else if (t.length <= 22) s += 1; else s -= 3;
  if (!/[，,。;；]/.test(raw)) s += 2;
  if (/[*＊?？]/.test(raw)) s += 1;               // 带必填/说明星号的通常就是字段名
  if (/^\d+$/.test(raw)) s -= 10;
  if (/\d{4}[-/.年]\d{1,2}/.test(raw)) s -= 6;   // 像示例值而不是标签
  if (isHeading) s -= 9;
  if (EXPLICIT_LABEL_SOURCES.has(source)) s += 8;
  s -= depth * 1.5;
  return s;
}

/** @param {Array<{text:string, raw?:string, source:string, depth?:number, heading?:boolean}>} cands */
export function pickLabelCandidate(cands) {
  let best = null, bestScore = Number.NEGATIVE_INFINITY;
  for (const c of Array.isArray(cands) ? cands : []) {
    const s = scoreLabelCandidate(c.text, c.depth || 0, !!c.heading, c.source);
    if (s > bestScore) { bestScore = s; best = { ...c, score: s }; }
  }
  // 全部候选都不合格时宁可返回空：labelRaw 一旦被"落选候选"污染，下游会以为这就是页面标签去猜
  if (!best || !Number.isFinite(bestScore) || bestScore < -5) return { text: '', raw: '', source: '' };
  return { text: best.text, raw: best.raw || best.text, source: best.source };
}

export function boolLike(value) {
  const s = normalize(value);
  if (['是', 'y', 'yes', 'true', '1', '有', '同意', '接受', '需要', 'male'].includes(s)) return true;
  if (['否', 'n', 'no', 'false', '0', '无', '不同意', '不接受', '不需要', 'female'].includes(s)) return false;
  return null;
}
