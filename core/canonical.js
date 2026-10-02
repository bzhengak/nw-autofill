// 概念层：页面栏位 →（封闭概念集）→ 本地槽位。
//
// 为什么要这一层（用户 2026-10-02："name 能填成 last name，phone number 能填成 id number…
// 应该审视你的匹配方法"；见 docs/MATCHING-REDESIGN.md 第五、六节）：
// 以前识别是一步"页面栏位 → 519 个槽位路径里挑一个"，靠一个混合了标签/占位符/
// 控件属性/邻近文字的**标量分数**决定，既解释不了也压不住"中心词蹭上位"（School Name 里的 name）。
// 浏览器自动填充实现不这么做：它们先把字段归进一张**封闭的类型枚举**
// （WHATWG/MDN 的 autofill 令牌表：name / given-name / family-name / tel-national /
// address-level2 / postal-code / organization …），再由这张表去对存好的数据。
// 本文件把同一套做法搬过来，并补上简历特有的概念。
//
// 三条规矩：
//  1. 概念 id 尽量直接沿用标准令牌名（不是自造词），这样站点写了 autocomplete 我们就白拿确定性；
//  2. 每个概念带**两份名单**（学 Bitwarden）：keywords 拿去扫 name/id/label/placeholder 这类属性文本，
//     values 只与 autocomplete 的属性值比对；再加一条属性扫描优先级；
//  3. 说不清就弃权：≥2 个概念同等命中、或只有含糊词命中，一律返回 null，交回原有打分/映射表，
//     绝不"挑一个最像的"。概念层负责的是"少猜"，不是"多填"。

import { normalize, core, AMBIGUOUS_WORDS } from './matching.js';

/** 概念 → 定义。values 是标准 autocomplete 明细令牌；keywords 是站点自己写的措辞。 */
export const CONCEPTS = {
  // —— 身份与姓名（标准令牌那一族）——
  'name.person': { values: ['name', 'full-name', 'your-name'], keywords: ['姓名', '全称', '中文姓名', '真实姓名', 'candidate name', 'full name', 'your name'] },
  'name.given': { values: ['given-name', 'first-name'], keywords: ['名', 'given name', 'first name', 'firstname'] },
  'name.family': { values: ['family-name', 'last-name', 'surname'], keywords: ['姓', 'family name', 'last name', 'surname'] },
  'nickname': { values: ['nickname'], keywords: ['昵称', 'preferred name', 'nickname'] },
  'sex': { values: ['sex', 'gender'], keywords: ['性别', 'gender'] },
  'nationality': { values: [], keywords: ['国籍', 'nationality', 'nationality of passport', 'citizenship'] },
  'birth-date': { values: ['bday'], keywords: ['出生日期', '出生年月', 'birthday', 'birth date', 'date of birth'] },
  'marital-status': { values: [], keywords: ['婚姻状况', 'marital status', 'marriage'] },
  'political-status': { values: [], keywords: ['政治面貌', 'political status'] },
  'id-number': { values: [], keywords: ['证件号', '身份证号', '身份证号码', 'id number', 'id no', 'identity card number', 'nric', 'passport number'] },
  'photo': { values: ['photo'], keywords: ['照片', '头像', 'photo'] },

  // —— 联系方式 ——
  'email': { values: ['email'], keywords: ['邮箱', '电子邮件', 'e-mail address', 'email address', 'email'] },
  'phone': { values: ['tel', 'tel-national'], keywords: ['手机', '手机号', '电话', '联系电话', '主要手机号', 'cell number', 'mobile', 'phone', 'telephone', 'contact number'] },
  'phone-alt': { values: [], keywords: ['备用电话', '其他电话', 'secondary cell number', 'alternate phone', 'backup phone'] },
  'phone-dial-code': { values: ['tel-country-code'], keywords: ['国际区号', '国家或地区电话区号', 'dial code', 'country calling code', 'country code'] },
  'phone-extension': { values: ['tel-extension'], keywords: ['分机', '分机号', 'extension'] },
  'address': { values: ['street-address'], keywords: ['地址', '现居住地址', '通讯地址', '街道', 'street address'] },
  'address-line': { values: ['address-line1', 'address-line2'], keywords: ['地址行', 'address line'] },
  'city': { values: ['address-level2', 'address-level3'], keywords: ['城市', '现居城市', '意向城市', '工作城市', 'city', 'town', 'current location'] },
  'province': { values: ['address-level1'], keywords: ['省份', '省', '州', 'state', 'province', 'region'] },
  'postal-code': { values: ['postal-code', 'zip-code'], keywords: ['邮编', '邮政编码', 'postal', 'zip'] },
  'country': { values: ['country-name', 'country'], keywords: ['国家', '所在地区', 'country', 'nation'] },
  'homepage': { values: ['url'], keywords: ['个人主页', '主页', '网站', 'homepage', 'website', 'url', 'linkedin'] },

  // —— 教育与工作 ——
  'school': { values: ['organization'], keywords: ['学校', '院校', '大学', '毕业学校', '就读学校', 'school', 'university', 'college', 'institution'] },
  'degree': { values: [], keywords: ['学历', '学位', '最高学历', '在读学历', 'degree', 'qualification', 'education level'] },
  'major': { values: ['organization-title'], keywords: ['专业', '主修专业', '研究方向', 'major', 'field of study', 'subject'] },
  'gpa': { values: [], keywords: ['绩点', 'gpa', '加权平均', '平均分', '成绩排名'] },
  'graduation-date': { values: [], keywords: ['毕业时间', '毕业日期', '预计毕业', 'graduation date', 'graduation year', 'expected graduation'] },
  'company': { values: ['organization'], keywords: ['公司', '单位', '雇主', '组织', '企业名称', 'company', 'organization', 'employer', 'organisation'] },
  'job-title': { values: ['organization-title'], keywords: ['职位', '职务', '岗位', '职位名称', 'job title', 'position title', 'role'] },
  'work-start-date': { values: [], keywords: ['入职时间', '开始时间', '起始时间', 'start date', 'from'] },
  'work-end-date': { values: [], keywords: ['离职时间', '结束时间', '截止时间', 'end date', 'to', 'until'] },
  'work-summary': { values: [], keywords: ['工作内容', '职责', '描述', '工作职责', 'responsibilities', 'description', 'summary', 'job description'] },
  'start-date-available': { values: [], keywords: ['到岗时间', '最早到岗', '可到岗日期', 'available date', 'earliest start date'] },

  // —— 语言与证书 ——
  'language-name': { values: ['language'], keywords: ['语种', '语言类别', '第一外语', '语言', 'language'] },
  'language-score': { values: [], keywords: ['分数', '成绩', '等级', 'score', 'band', 'proficiency'] },
  'cert-name': { values: [], keywords: ['证书名称', '资格证书', '持证名称', '证书', 'certificate', 'certification', 'license', 'qualification name'] },
  'cert-date': { values: [], keywords: ['获得时间', '取证时间', '发证日期', 'issue date', 'award date'] },
  'award-title': { values: [], keywords: ['获奖名称', '奖项', '荣誉', '奖学金', 'award', 'honour', 'honor', 'scholarship'] },

  // —— 合规声明（只允许"存在这个概念"，取值一律要用户点头）——
  'work-permit': { values: [], keywords: ['工作许可', '合法工作身份', 'work permit', 'working permit', 'right to work', 'work authorization'] },
  'sponsorship-need': { values: [], keywords: ['签证担保', '需要担保', 'sponsorship', 'visa sponsorship'] },
  'referrer-name': { values: [], keywords: ['内推人', '推荐人姓名', 'referrer', 'referee', 'referred by', 'referrer name'] },
  'relative-in-company': { values: [], keywords: ['亲属', '亲友', '是否有亲戚在公司', 'relative', 'family member employed'] },
  'willing-relocation': { values: [], keywords: ['异地工作', '调剂', 'relocation', ' willing to relocate'] },
  'expected-salary': { values: [], keywords: ['期望薪酬', '期望薪资', '薪酬要求', 'expected salary', 'desired package', 'ctc'] },

  // —— 其它 ——
  'skills': { values: [], keywords: ['技能', '技能专长', '特长', 'skills', 'competencies'] },
  'self-intro': { values: [], keywords: ['自我介绍', '自我评价', '自荐理由', '个人简介', 'self introduction', 'about me'] },
  'emergency-contact-name': { values: [], keywords: ['紧急联系人姓名', '紧急联系人', 'emergency contact name', 'contact person'] },
  'emergency-contact-phone': { values: [], keywords: ['紧急联系电话', '紧急联系人电话', 'emergency contact number'] },
  'notes': { values: [], keywords: ['备注', '其他说明', 'additional information', 'remarks'] },
};

/** 属性扫描优先级（学 Bitwarden：先最确定的，最后才是猜出来的） */
export const ATTRIBUTE_PRIORITY = ['autocomplete', 'name', 'id', 'testId', 'label', 'placeholder', 'nearby'];

/** autocomplete 明细令牌 → 概念（标准名对得上就直接定案，不必再猜） */
const TOKEN_TO_CONCEPT = (() => {
  const map = new Map();
  for (const [concept, def] of Object.entries(CONCEPTS)) {
    for (const v of def.values || []) map.set(v, concept);
  }
  // 标准里 'name' 是"本人全名"；'organization'/'organization-title' 在简历语境里
  // 分别指公司名与职位，比"学校"更常见 —— 学校那条靠 keywords 认。
  map.set('given-name', 'name.given');
  map.set('additional-name', 'nickname');
  map.set('honorific-prefix', 'name.person');
  return map;
})();

/** 站点写了 autocomplete 就白拿的确定性命中；去掉 home/work/mobile 这类修饰词 */
export function conceptFromAutocomplete(pageField) {
  const raw = String(pageField?.autocomplete || '').toLowerCase().trim();
  if (!raw) return '';
  const tokens = raw.split(/\s+/).filter(t => t && !['home', 'work', 'mobile', 'fax', 'pager', 'shipping', 'billing'].includes(t) && !t.startsWith('section-'));
  const last = tokens[tokens.length - 1] || '';
  return TOKEN_TO_CONCEPT.get(last) || '';
}

/** 概念 × 控件相容：判"这个概念能不能长在这种控件上"（Bitwarden 的 ExcludedAutofillTypes 思路） */
export const CONCEPT_KINDS = {
  'phone': ['text', 'tel', 'select', 'combobox', 'contenteditable'],
  'phone-alt': ['text', 'tel', 'select', 'combobox', 'contenteditable'],
  'email': ['text', 'email', 'select', 'combobox', 'contenteditable'],
  'id-number': ['text', 'select', 'combobox', 'contenteditable'],
  'sex': ['radio', 'select', 'combobox', 'text'],
  'marital-status': ['radio', 'select', 'combobox', 'text'],
  'political-status': ['select', 'combobox', 'radio', 'text'],
  'nationality': ['select', 'combobox', 'text'],
  'country': ['select', 'combobox', 'text'],
  'province': ['select', 'combobox', 'text'],
  'city': ['select', 'combobox', 'text'],
  'degree': ['select', 'combobox', 'radio', 'text'],
  'phone-dial-code': ['select', 'combobox', 'text'],
  'work-permit': ['radio', 'checkbox', 'select', 'combobox'],
  'sponsorship-need': ['radio', 'checkbox', 'select', 'combobox'],
  'relative-in-company': ['radio', 'checkbox', 'select', 'combobox'],
  'willing-relocation': ['radio', 'checkbox', 'select', 'combobox'],
  'self-intro': ['textarea', 'text'],
};

/**
 * 页面栏位 → 概念。返回 { concept, source, ambiguous } 或 null（说不清就弃权）。
 * 只在**唯一**概念命中时才给结论；两个概念并列命中就返回 ambiguous，让上层继续走
 * 打分/映射表/人工 —— 概念层的职责是少猜，不是多填。
 */
export function classifyConcept(pageField) {
  const ac = conceptFromAutocomplete(pageField);
  if (ac) return { concept: ac, source: 'autocomplete' };
  const hay = [
    ['name', core(normalize(pageField?.name || ''))],
    ['id', core(normalize(pageField?.id || ''))],
    ['label', core(normalize(pageField?.labelRaw || pageField?.label || ''))],
    ['placeholder', core(normalize(pageField?.placeholder || ''))],
    ['nearby', (pageField?.nearbyLabels || []).map(l => core(normalize(l))).join('#')],
  ];
  const hits = new Map();   // concept → { source, len }（先到先得，顺序即优先级；长度算具体度）
  for (const [source, text] of hay) {
    if (!text) continue;
    for (const [concept, def] of Object.entries(CONCEPTS)) {
      for (const kw of def.keywords || []) {
        const k = core(normalize(kw));
        if (!k || k.length < 2) continue;
        if (!text.includes(k)) continue;
        if (AMBIGUOUS_WORDS.has(k)) continue;                 // 含糊词单独命中不算数
        const cur = hits.get(concept);
        if (!cur || k.length > cur.len) hits.set(concept, { source, len: k.length });
      }
    }
  }
  /**
   * 谁都不许被"并列歧义"判死：英文/中文里长标签常常同时含多个概念的词
   * （「紧急联系人电话」里既有"紧急联系人"又有"电话"）。
   * 通行做法是按**具体度**取胜（Bitwarden 的名单也总是把长词条排在短词条前用），
   * 所以这里比的是命中词条的长度；只有长度一模一样才承认是真歧义。
   * 判据收紧的另一半在下面：概念层只"抬举"命中的槽位，不降级别人 ——
   * 不认识的东西不等于不存在，贸然扣分就是把对的栏位做没（判分当场掉过 5 条）。
   */
  const ranked = [...hits.entries()].sort((a, b) => b[1].len - a[1].len);
  if (ranked.length === 1) return { concept: ranked[0][0], source: ranked[0][1].source };
  if (ranked.length > 1 && ranked[0][1].len > ranked[1][1].len) {
    return { concept: ranked[0][0], source: ranked[0][1].source };
  }
  if (ranked.length > 1) return { concept: '', ambiguous: true, candidates: ranked.map(r => r[0]) };
  return null;
}

/**
 * 槽位 → 概念。用 section+key 查表（比给 519 条各写一遍短得多，也更不容易漂移）。
 * 表里没有的槽位返回 ''：概念层不认识它，识别照旧走打分。
 */
const SLOT_CONCEPT = {
  'basics.name': 'name.person',
  'basics.nameEn': 'name.person',
  'basics.preferredName': 'nickname',
  'basics.firstName': 'name.given',
  'basics.lastName': 'name.family',
  'basics.gender': 'sex',
  'basics.birthday': 'birth-date',
  'basics.nation': 'nationality',
  'basics.political': 'political-status',
  'basics.marital': 'marital-status',
  'basics.idType': 'id-number',
  'basics.photo': 'photo',
  'contact.email': 'email',
  'contact.phone': 'phone',
  'contact.dialCode': 'phone-dial-code',
  'contact.altPhone': 'phone-alt',
  'contact.city': 'city',
  'contact.province': 'province',
  'contact.address': 'address',
  'contact.postcode': 'postal-code',
  'contact.country': 'country',
  'contact.website': 'homepage',
  'contact.emergencyName': 'emergency-contact-name',
  'contact.emergencyPhone': 'emergency-contact-phone',
  'education.*.school': 'school',
  'education.*.degree': 'degree',
  'education.*.major': 'major',
  'education.*.gpa': 'gpa',
  'education.*.endDate': 'graduation-date',
  'education.*.startDate': 'work-start-date',
  'work.*.company': 'company',
  'work.*.title': 'job-title',
  'work.*.startDate': 'work-start-date',
  'work.*.endDate': 'work-end-date',
  'work.*.summary': 'work-summary',
  'internship.*.company': 'company',
  'internship.*.title': 'job-title',
  'internship.*.startDate': 'work-start-date',
  'internship.*.endDate': 'work-end-date',
  'internship.*.summary': 'work-summary',
  'languages.*.language': 'language-name',
  'languages.*.cert': 'cert-name',
  'certifications.*.name': 'cert-name',
  'awards.*.title': 'award-title',
  'intent.position': 'job-title',
  'intent.availableDate': 'start-date-available',
  'intent.acceptRelocation': 'willing-relocation',
  'intent.referralName': 'referrer-name',
  'intent.hasRelative': 'relative-in-company',
  'intent.expectedSalary': 'expected-salary',
  'hkGlobal.workAuth': 'work-permit',
  'hkGlobal.needSponsorship': 'sponsorship-need',
  'others.selfIntro': 'self-intro',
  'skills.domain': 'skills',
};

/** 记录型槽位（education.* / work.*）按 段+字段 匹配，所以先把具体下标折成 * */
function slotKey(path) {
  return String(path || '').replace(/\.\d+\./g, '.*.');
}

export function slotConcept(profileField) {
  if (!profileField) return '';
  const path = String(profileField.path || '');
  return SLOT_CONCEPT[path] || SLOT_CONCEPT[slotKey(path)] || '';
}

/** 这个概念有没有被本层认识（映射表与 AI 都要能说出"这个概念我不认识"） */
export function isKnownConcept(concept) {
  return Object.prototype.hasOwnProperty.call(CONCEPTS, String(concept || ''));
}

/** 概念 × 控件相容（不认识的概念一律放行；表里没有就不拦） */
export function conceptFitsControl(concept, kind) {
  const allow = CONCEPT_KINDS[concept];
  if (!allow || !kind) return true;
  return allow.includes(kind);
}
