import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importMarkdown, parseDateRange, parseLanguages, normalizePhone, stripInline } from '../core/importers/markdown.js';
import { getValueByPath, createEmptyProfile, countFilled } from '../core/profile-schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fs = fsp;

const MD = `# 测试用户

test@example.com | +86 13800138000 | +852 63074165 | Personal Page

## 个人简介

这是一段自我评价，讲清楚我做什么。

## 教育背景

**某大学 -- 计算机科学与技术硕士** 2024.09 – 至今（预计 2027.06 毕业）

* 主修课程：机器学习、分布式系统

**另一学院 -- 软件工程学士** 2020.09 – 2024.06

## 实习经历

**某某公司 | 后端实习生** 2025.06 – 2025.09

* **负责订单服务**：接口开发与联调
* 参与搜索链路性能优化

## 专业技能

* **软件与 MLOps：** Go、Kubernetes、gRPC
* **数据与分析：** pandas、SQL

## 其他信息

* **语言：** 普通话（母语）、英语（流利）

## 奇怪的段落

这段内容不该被静默丢掉。
`;

const { profile, report } = importMarkdown(MD);
const g = p => getValueByPath(profile, p);

test('头部：姓名 / 邮箱 / 内地号进 phone，境外号进 altPhone', () => {
  assert.equal(g('basics.name'), '测试用户');
  assert.equal(g('contact.email'), 'test@example.com');
  assert.equal(g('contact.phone'), '13800138000');
  assert.equal(g('contact.altPhone'), '+852 63074165');
  assert.ok(report.warnings.some(w => w.includes('Personal Page')), '无 URL 的链接文字应给出提示');
});

test('自我评价按标题路由', () => {
  assert.match(g('others.selfIntro'), /自我评价/);
});

test('教育：校名 / 学位推断 / 专业去学位词 / 至今+预计毕业', () => {
  assert.equal(g('education.0.school'), '某大学');
  assert.equal(g('education.0.degree'), '硕士');
  assert.equal(g('education.0.major'), '计算机科学与技术');
  assert.equal(g('education.0.enrollDate'), '2024-09');
  assert.equal(g('education.0.gradDate'), '2027-06');
  assert.equal(g('education.1.school'), '另一学院');
  assert.equal(g('education.1.degree'), '本科');
  assert.equal(g('education.1.gradDate'), '2024-06');
  assert.match(g('education.0.transcript'), /机器学习/);
});

test('实习：公司 | 职位拆分与正文聚合', () => {
  assert.equal(g('internship.0.company'), '某某公司');
  assert.equal(g('internship.0.title'), '后端实习生');
  assert.equal(g('internship.0.startDate'), '2025-06');
  assert.equal(g('internship.0.endDate'), '2025-09');
  assert.match(g('internship.0.summary'), /负责订单服务/);
  assert.match(g('internship.0.summary'), /性能优化/);
});

test('技能分类标签超过 14 字也能切开', () => {
  assert.match(g('skills.programming'), /Go/);
  assert.match(g('skills.domain'), /pandas/);
});

test('其他信息里的语言行拆成多条 language/level', () => {
  assert.equal(g('languages.0.language'), '普通话');
  assert.equal(g('languages.0.level'), '母语');
  assert.equal(g('languages.1.language'), '英语');
});

test('未识别标题进入 report，而不是静默丢弃', () => {
  assert.deepEqual(report.unmappedHeadings, ['奇怪的段落']);
});

test('一致性推导：毕业年份 → 应届身份与到岗时间', () => {
  assert.equal(g('intent.gradStatus'), '应届毕业生');
  assert.equal(g('intent.availableDate'), '2027-07-01');
  assert.ok((report.derived || []).length >= 2);
});

test('默认不覆盖已有值（保护手工补充的条目）', () => {
  const again = importMarkdown(MD, { base: profile });
  assert.ok(again.report.skippedExisting.length > 10);
  assert.equal(getValueByPath(again.profile, 'basics.name'), '测试用户');
  const forced = importMarkdown(MD.replace('测试用户', '改名后'), { base: profile, overwrite: true });
  assert.equal(getValueByPath(forced.profile, 'basics.name'), '改名后');
});

test('英文简历：expected 10/2026、MSc in X 剥学位词', () => {
  assert.equal(parseDateRange('09/2025 – Present (expected 10/2026)').expected, '2026-10');
  assert.equal(parseDateRange('2025.09 – 至今（预计 2026.10 毕业）').expected, '2026-10');
  assert.equal(parseDateRange('2024.09 – 2027.06').start, '2024-09');
  assert.equal(parseDateRange('2024.09 – 2027.06').end, '2027-06');
  assert.equal(parseDateRange('Ongoing').current, true);
  const en = importMarkdown(`# Jane Doe

jane@example.com | +852 63074165

# Education

**Some University -- MSc in Artificial Intelligence** 09/2025 – Present (expected 10/2026)
`);
  assert.equal(getValueByPath(en.profile, 'education.0.degree'), '硕士');
  assert.equal(getValueByPath(en.profile, 'education.0.major'), 'Artificial Intelligence');
  assert.equal(getValueByPath(en.profile, 'education.0.gradDate'), '2026-10');
  assert.equal(getValueByPath(en.profile, 'contact.phone'), '+852 63074165', '只有一个号码时兜底进 phone');
  assert.ok((en.report.derived || []).some(d => d.includes('contact.phone')));
});

test('工具函数：转义清理、号码归一、语言行解析', () => {
  assert.equal(stripInline('Data \\& Analytics'), 'Data & Analytics');
  assert.equal(stripInline('**粗体**和`代码`'), '粗体和代码');
  assert.equal(normalizePhone('+86 13912345678'), '13912345678');
  assert.equal(normalizePhone('+852 63074165'), '+852 63074165');
  assert.deepEqual(parseLanguages('普通话（母语）、英语（流利）'), [
    { language: '普通话', level: '母语' },
    { language: '英语', level: '流利' },
  ]);
});

test('导入产物能直接喂给匹配层（profile 形状一致）', () => {
  const blank = createEmptyProfile();
  assert.deepEqual(Object.keys(profile).sort(), Object.keys(blank).sort());
  assert.ok(Array.isArray(profile.education) && profile.education.length === blank.education.length);
});

// ―― 虚构简历（tests/fixtures/dev-resume.md）：开发期所有链路的统一取值表 ――
// 这份文件刻意写成"真实中文校招生会写的样子"：基本信息一行塞多个「标签：值」、
// 「语言与证书」合并标题、家庭情况按称谓摊平。它红了就说明导入器跟不上真实格式。
const DEV_MD = fs.readFileSync(path.join(root, 'tests/fixtures/dev-resume.md'), 'utf8');

test('虚构简历：一行多个「标签：值」全部落位，单位被剥掉', () => {
  const { profile, report } = importMarkdown(DEV_MD);
  const g = p => String(getValueByPath(profile, p) ?? '');
  assert.equal(report.unmappedHeadings.length, 0, `有标题没认出来：${report.unmappedHeadings}`);
  assert.equal(g('basics.gender'), '女');
  assert.equal(g('basics.birthDate'), '2001-07-12');
  assert.equal(g('basics.politicalStatus'), '中共党员');
  assert.equal(g('basics.maritalStatus'), '未婚');
  assert.equal(g('basics.ethnicity'), '汉族');
  assert.equal(g('basics.heightCm'), '164', 'cm 单位要剥掉，否则站点数字校验直接红');
  assert.equal(g('basics.weightKg'), '50');
  assert.equal(g('basics.hometown'), '浙江宁波');
  assert.equal(g('contact.phone'), '13800001111');
  assert.equal(g('contact.email'), 'lws.dev@example.com');
  assert.equal(g('intent.salary'), '25000');
  assert.equal(g('intent.availableDate'), '2027-07-01');
  assert.equal(g('records.dossierLocation'), '上海市学生事务中心');
  assert.equal(g('others.personalSite'), 'https://lws.example.com');
  assert.ok(countFilled(profile) >= 70, `导入后只填了 ${countFilled(profile)} 项`);
});

test('虚构简历：基本信息段里的教育问法落到第一条教育经历', () => {
  const g = p => String(getValueByPath(importMarkdown(DEV_MD).profile, p) ?? '');
  assert.equal(g('education.0.degree'), '硕士');
  assert.equal(g('education.0.school'), '复旦大学');
  assert.equal(g('education.0.major'), '数据科学');
});

test('虚构简历：家庭情况按称谓摊平，工作单位跟着对应的人', () => {
  const g = p => String(getValueByPath(importMarkdown(DEV_MD).profile, p) ?? '');
  assert.deepEqual([g('family.0.relation'), g('family.0.name'), g('family.0.employer'), g('family.0.position')],
    ['父亲', '李国栋', '宁波供电局', '工程师']);
  assert.equal(g('family.0.phone'), '13900002222');
  assert.deepEqual([g('family.1.relation'), g('family.1.name'), g('family.1.employer')],
    ['母亲', '王慧敏', '宁波市第七中学']);
});

test('虚构简历：「语言与证书」合并标题两类信息都不丢', () => {
  const g = p => String(getValueByPath(importMarkdown(DEV_MD).profile, p) ?? '');
  assert.deepEqual([g('languages.0.language'), g('languages.0.level')], ['普通话', '母语'], '语言标签本身不该混进语种名');
  assert.equal(g('languages.1.language'), '英语');
  assert.ok(g('certifications.0.name').includes('软件专业技术资格'), '证书行被语言段吞掉就是丢数据');
  assert.equal(g('certifications.1.name'), 'CET-6');
});
