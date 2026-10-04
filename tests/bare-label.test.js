// 裸词标签的归属（2026-10-04 用户第四次报同一件事）。
//
// 他的原话从 2026-10-02 起就没变过："name 就是 name"、"我需要的是这个 name 在哪个板块的"。
// 这次他发来的真实导出（nw-diag-2026-10-04.json，途普/埃森哲那页）里第 0 栏写着：
//   label="name" → basics.lastNameZh（中文姓）evidence=broader score=0.68
// 也就是说：英文页面上一个裸词 name，被"别名里**含有** name 这串字母"的槽位抢走了 ——
// 'surname in chinese' 里的 sur**name** 根本不是 name 这个词。这不是打分调参能治的，
// 证据判定本身缺了三刀：
//   ① 拉丁串要整词命中（'nickname' 里那串 -name 也不算）；
//   ② 裸词标签不许凭"某个更长的别名包含它"胜出；
//   ③ 裸词在词典里有多个主人时（title 25 个、level 13 个、date 12 个）交人工点名，
//      而不是按打分挑第一个 —— 那正是"按资料顺序轮值猜"的老病。
// 另外钉住同一次导出里现形的两条：note 里不许有资料取值（它让映射表整段被导出自检拒收）、
// 也不许出现内部结构名（真实导出里出现过「第 2 段『languages』」）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { labelEvidence } from '../core/matching.js';
import { planFill, detectPageLanguage, maskValues } from '../core/matcher.js';
import { matchAdapter } from '../core/adapters.js';
import { buildFields, createEmptyProfile, setValueByPath, writeLang, userSafeText } from '../core/profile-schema.js';
import { buildMappingTable, plainMappingTable, findValueLeaks } from '../core/mapping-table.js';
import { sampleProfile } from './fixtures/sample-profile.js';

const root = p => fileURLToPath(new URL(p, import.meta.url));
const TUPU = JSON.parse(fs.readFileSync(root('../adapters/tupu-antd.json'), 'utf8'));
const by = new Map(buildFields().map(f => [f.path, f]));
const pf = (label, extra = {}) => ({
  kind: 'text', label, labelRaw: label, name: '', id: '', placeholder: '', currentValue: '',
  options: [], required: false, nearbyLabels: [], description: '', sectionHint: '', sectionTitle: '',
  itemIndex: null, autocomplete: '', type: 'text', ...extra,
});

test('第一刀：拉丁别名要整词命中，sur-name 里那串字母不算 "name"', () => {
  assert.equal(labelEvidence(pf('name'), by.get('basics.lastNameZh')).kinds.size, 0,
    `裸词 name 蹭上了「中文姓」的别名：${[...labelEvidence(pf('name'), by.get('basics.lastNameZh')).kinds]}`);
  // 但"名字里真有这个词"的仍然要认得（否则把有用的判据一起杀了）
  assert.ok([...labelEvidence(pf('full name'), by.get('basics.name')).kinds].includes('exact'), '「full name」该整词命中姓名的别名');
  assert.ok(labelEvidence(pf('姓名'), by.get('basics.lastName')).kinds.size > 0, '中文标签的包含关系判据不能整条废掉');
  assert.ok(![...labelEvidence(pf('nickname'), by.get('basics.name')).kinds].some(k => k === 'full-cover' || k === 'qualifier'),
    '常用名不许靠 "nickname" 里的 -name 抢走姓名');
});

test('第二刀：裸词标签只许命中把该词当自己名字的那一栏', () => {
  for (const [label, path] of [
    ['name', 'basics.nameEn'],       // 别名 'name in english' 里 name 是整词，但标签是裸词
    ['name', 'basics.firstNameZh'],  // 'given name in chinese'
    ['name', 'basics.lastNameZh'],   // 'surname in chinese'
    ['number', 'contact.phone'],     // 'contact number' / 'mobile number'
  ]) {
    const kinds = [...labelEvidence(pf(label), by.get(path)).kinds];
    assert.equal(kinds.length, 0, `裸词「${label}」在 ${path} 上留下了证据：${kinds}`);
  }
  assert.ok([...labelEvidence(pf('name'), by.get('basics.name')).kinds].includes('exact'), '裸词 name 该归姓名（它是 name 的唯一主人）');
  // 带定语的标签照旧正常 —— 这才是"这个 name 在哪个板块的"该有的判法
  assert.ok(labelEvidence(pf('school name'), by.get('education.0.school')).kinds.size > 0);
  assert.ok(labelEvidence(pf('last name'), by.get('basics.lastName')).kinds.size > 0);
  assert.ok(labelEvidence(pf('job title'), by.get('work.0.title')).kinds.size > 0);
  assert.ok(labelEvidence(pf('职位名称'), by.get('work.0.title')).kinds.size > 0);
});

test('第三刀：裸词在词典里有多个主人时交人工点名，不按打分挑第一个', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'work.0.company', '某科技');
  setValueByPath(p, 'work.0.title', '数据分析实习生');
  writeLang(p, 'work.0.title', 'en', 'Data Analyst Intern');
  setValueByPath(p, 'projects.0.name', '风控建模项目');
  writeLang(p, 'projects.0.name', 'en', 'Risk Modelling Project');
  setValueByPath(p, 'awards.0.title', '数学建模一等奖');
  writeLang(p, 'awards.0.title', 'en', 'Mathematical Modelling First Prize');
  setValueByPath(p, 'awards.0.level', '国家级');
  writeLang(p, 'awards.0.level', 'en', 'National');
  setValueByPath(p, 'basics.name', '欧阳某某');
  writeLang(p, 'basics.name', 'en', 'OUYANG Moumou');
  const fields = [pf('title'), pf('job title'), pf('name'), pf('awards level')];
  const plan = planFill(fields, p, { mode: 'full', fillSensitive: true });
  const gap0 = plan.gaps.find(g => g.index === 0);
  assert.ok(!plan.assignments.some(a => a.index === 0),
    `裸词 title 被按打分写进了某一格：${JSON.stringify(plan.assignments.find(a => a.index === 0))}`);
  assert.equal(gap0?.reason, 'block_ambiguous', `裸词 title 该说"好几个板块都有同名位"：${JSON.stringify(gap0)}`);
  assert.ok(/板块/.test(gap0?.note || ''), `缺口说明要念出候选板块：${gap0?.note}`);
  // 念的必须是中文板块名：内部键名（work / awards）念给用户等于没念，而且会随导出离机
  assert.ok(!/\bwork\b|\bawards\b|\bprojects\b/.test(gap0?.note || ''),
    `缺口说明里在念内部键名：${gap0?.note}`);
  assert.ok(/工作经历|奖项荣誉|项目经历/.test(gap0?.note || ''), `候选板块要用中文名念出来：${gap0?.note}`);
  // 反面对照：这一刀不许波及"带定语的标签"和"有唯一主人的裸词"
  assert.equal(plan.assignments.find(a => a.index === 1)?.path, 'work.0.title', '带定语的 job title 被误伤');
  assert.equal(plan.assignments.find(a => a.index === 2)?.path, 'basics.name', '裸词 name 有唯一主人，该照常归姓名');
  assert.equal(plan.assignments.find(a => a.index === 3)?.path, 'awards.0.level', '带定语的 awards level 被误伤');
});

test('真实形状复现：姓名缺英文写法时，裸词 name 留成缺口，不抓有拼音写法的中文姓顶替', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', '欧阳某某');            // 只有中文写法
  setValueByPath(p, 'basics.lastName', '欧阳');
  writeLang(p, 'basics.lastName', 'en', 'OUYANG');
  setValueByPath(p, 'basics.firstName', '某');
  writeLang(p, 'basics.firstName', 'en', 'MOU');
  setValueByPath(p, 'basics.lastNameZh', '欧阳');
  writeLang(p, 'basics.lastNameZh', 'en', 'OUYANG');       // 拼音也填在「中文姓」那一行上了
  setValueByPath(p, 'basics.firstNameZh', '某');
  writeLang(p, 'basics.firstNameZh', 'en', 'MOU');
  const fields = [pf('name'), pf('first name'), pf('last name')];
  assert.equal(detectPageLanguage(fields), 'en');
  const plan = planFill(fields, p, { mode: 'full', enMissingMode: 'strict', fillSensitive: true });
  const assigned = plan.assignments.find(a => a.index === 0);
  assert.ok(!assigned || assigned.path === 'basics.name',
    `裸词 name 又被判给了 ${assigned?.path}（证据 ${(assigned?.evidence || []).map(e => e.kind || e).join('+')}、分数 ${assigned?.score}）`);
  assert.ok(plan.gaps.some(g => g.index === 0 && g.reason === 'missing_english_value'),
    `第 0 栏要留成"缺英文写法"的缺口才看得见：${JSON.stringify(plan.gaps.filter(g => g.index === 0))}`);
  assert.equal(plan.assignments.find(a => a.index === 1)?.path, 'basics.firstName');
  assert.equal(plan.assignments.find(a => a.index === 2)?.path, 'basics.lastName');
});

test('来历说明与缺口说明不许带资料取值；内部键名在措辞层面治（不靠抹句子）', () => {
  const masked = maskValues('按「粤语」与「IELTS」定位槽位，值为 欧阳某某', ['粤语', 'IELTS', '欧阳某某']);
  assert.ok(!masked.includes('粤语') && !masked.includes('IELTS') && !masked.includes('欧阳某某'), `掩码没生效：${masked}`);
  assert.ok(masked.length > 0, '整句被抹空了：说明还得读得通');
  // 句子本身不许被"内部名"判据抹掉：那是用户唯一看得懂的线索（上一版一次抹掉四条，判分集红）
  assert.equal(userSafeText('槽位 basics.name 空着', []), '槽位 basics.name 空着');
  assert.equal(userSafeText('这一栏要的是「现居城市」', ['某科技']), '这一栏要的是「现居城市」');
  assert.equal(userSafeText('这一栏要的是「某科技」', ['某科技']), false, '取值混进说明必须被拒');
  assert.equal(userSafeText('', ['x']), '');
});

test('真实链路：语言段规则给的 note 进映射表后仍能被导出（不含取值）', () => {
  const adapter = matchAdapter('https://careersite.tupu360.com/accentureats/resume/applicationView', [TUPU]);
  assert.ok(adapter && (adapter.languageSlotPins || []).length, '这个适配器该带语言槽位规则');
  const p = createEmptyProfile();
  setValueByPath(p, 'languages.1.language', '英语');
  writeLang(p, 'languages.1.language', 'en', 'IELTS');
  setValueByPath(p, 'languages.1.cert', 'IELTS');
  setValueByPath(p, 'languages.1.score', '7.0');
  const fields = [pf('ielts score'), pf('ielts type', { kind: 'select', options: [{ text: 'IELTS', value: '1' }] })];
  const plan = planFill(fields, p, { mode: 'full', adapter });
  const assigned = plan.assignments.filter(a => String(a.path || '').startsWith('languages.1'));
  // 先确认这条规则真的跑到了，否则下面那条 note 断言是空的（本仓库为这种假绿摔过五次）
  assert.ok(assigned.length, `语言槽位规则没生效，note 断言会空对空：${JSON.stringify(plan.gaps)}`);
  /**
   * 收口处那道掩码才是这条链的真判据：note 里引了页面那句 "IELTS …"，
   * 而 'IELTS' 同时是我们资料里的值 → 必须被掩成点，否则导出自检会拒收整段映射表
   * （用户这次遇到的正是这个）。摘掉掩码 → 这一条会红。
   */
  const allNotes = [...assigned, ...plan.gaps].map(x => x.note || '').join('\n');
  for (const v of ['IELTS', '英语', '7.0']) {
    assert.ok(!allNotes.includes(v), `说明里还带着资料取值「${v}」：${allNotes.slice(0, 160)}`);
  }
  assert.ok(/第\s*\d+\s*段/.test(allNotes), `note 说不出"凭哪一行"：${allNotes}`);
  const table = buildMappingTable({ fields, plan, results: [], schemaFields: buildFields(), origin: 'https://careersite.tupu360.com' });
  assert.deepEqual(findValueLeaks(plainMappingTable(table), ['IELTS', '英语', '7.0']), [],
    '说明文字里带着资料取值（导出会被自己拒绝）');
});

test('导出前的取值自查：页面自己写过的词不算泄漏，塞进说明里才算', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'languages.1.language', 'English');
  // 真实形状：页面标签原文就写着 "English Name"（≥6 个字符），资料里 languages.1.language 也是 'English'。
  // 用户那次导出里 `Eng…（出现在表格正文）` 就是这么来的 —— 页面写的词不因为我们导出而离开机器。
  const fields = [pf('english name', { labelRaw: 'English Name' }), pf('please state your english proficiency')];
  const plan = planFill(fields, p, { mode: 'full' });
  const table = plainMappingTable(buildMappingTable({
    fields, plan, results: [], schemaFields: buildFields(), origin: 'https://x.test',
  }));
  assert.ok(JSON.stringify(table).includes('English'), '用例前提不成立：表里没有页面原文 English 了');
  assert.deepEqual(findValueLeaks(table, ['English']), [], '页面自己写的 English 被当成我们的取值泄漏');
  table.rows[0].note = '按资料里的 English 那一行定位';
  assert.ok(findValueLeaks(table, ['English']).length, 'note 里的取值没被抓出来');
});

test('整条链的不变量：所有说明文字都不许带资料取值（新加说明时也适用）', () => {
  // 用户那次导出里红掉的是 `按「粤语」定位槽位` —— 说明引用了资料值，整段映射表被自检拒收。
  // 这条用例盯的是同一个承诺：任何一条 note 里都不许出现任何一条取值。
  const p = sampleProfile();
  const values = [];
  const walk = n => {
    if (typeof n === 'string') { if (n.trim().length >= 2) values.push(n.trim()); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n && typeof n === 'object') Object.values(n).forEach(walk);
  };
  walk(p);
  const fields = [
    pf('name'), pf('first name'), pf('last name'), pf('gender'), pf('highest education'),
    pf('school name'), pf('major'), pf('company name'), pf('job title'), pf('work location'),
    pf('ielts score'), pf('expected salary'), pf('phone number'), pf('email'), pf('current visa type'),
  ];
  const plan = planFill(fields, p, { mode: 'full', fillSensitive: true });
  const notes = [...plan.assignments, ...plan.gaps].map(x => x.note || '');
  const offenders = [];
  for (const n of notes) for (const v of values) if (n.includes(v) && v.length >= 2) offenders.push(`${n.slice(0, 40)} ← ${v}`);
  assert.deepEqual(offenders, [], `说明文字里出现了资料取值：${offenders.slice(0, 4).join('；')}`);
});

test('多主人裸词 + 只填了中文值：先说"分不清是哪个板块"，不说"它对应到职位"', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'work.0.title', '数据分析实习生');          // 只有中文写法
  setValueByPath(p, 'projects.0.name', '风控建模项目');
  setValueByPath(p, 'awards.0.title', '数学建模一等奖');
  // 页面要有两句以上拉丁标签才判得出"这是英文表单"，否则走不到缺英文那条分支
  const fields = [pf('title'), pf('awards level'), pf('company name')];
  const plan = planFill(fields, p, { mode: 'full', fillSensitive: true });
  assert.equal(detectPageLanguage(fields), 'en', '用例前提不成立：这一页没被判成英文表单');
  const g = plan.gaps.find(x => x.index === 0);
  assert.equal(g?.reason, 'block_ambiguous',
    `缺英文之前先要说清板块分不清：${JSON.stringify(g)} / 写进了 ${JSON.stringify(plan.assignments.find(a => a.index === 0))}`);
  assert.ok(/板块/.test(g?.note || '') && !/对应到「/.test(g?.note || ''),
    `说明不许替用户猜某个板块（那等于把"它一定是职位"写进缺口理由）：${g?.note}`);
});
