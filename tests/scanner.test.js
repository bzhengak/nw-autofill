// 标签解析回归：这一组锁住的是"中文标签被当成噪声洗掉"和"卡片标题冒充字段标签"两类事故。
// 两者都真实发生过（label 打分改造后 plain-cn 命中率 39→10、moka 13→9），必须有测试兜住。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { scanForm } from '../dom/scanner.js';
import { isNoiseLabel, scoreLabelCandidate, pickLabelCandidate } from '../core/matching.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function scan(html, url = 'https://example.test/apply') {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url });
  return scanForm(dom.window.document);
}
const byKey = (fields, key) => fields.find(f => (f.el.getAttribute('data-nw-test') || f.el.id || f.el.name) === key);

test('中文标签不因 \\W 被判成噪声（纯中文标点才算噪声）', () => {
  assert.equal(isNoiseLabel('出生日期'), false);
  assert.equal(isNoiseLabel('最高学历（含在读）'), false);
  assert.equal(isNoiseLabel('·—–…'), true);
  assert.equal(isNoiseLabel('Created with Sketch.'), true);
  const [f] = scan('<div><div class="item-label">出生日期</div><input data-nw-test="csrq"></div>');
  assert.equal(f.label, '出生日期');
});

test('卡片/区块标题不能冒充字段标签（Moka 的 Experience 卡片）', () => {
  const html = `
    <div class="mk-card"><div class="mk-card-title">Experience</div>
      <div class="mk-form-item"><div class="mk-label">Company</div><div><input data-nw-test="company"></div></div>
      <div class="mk-form-item"><div class="mk-label">Job title</div><div><input data-nw-test="job_title"></div></div>
      <div class="mk-form-item"><div class="mk-label">Responsibilities</div><div><textarea data-nw-test="resp"></textarea></div></div>
    </div>`;
  const fields = scan(html);
  assert.equal(byKey(fields, 'company').label, 'company');
  assert.equal(byKey(fields, 'job_title').label, 'job title');
  assert.equal(byKey(fields, 'resp').label, 'responsibilities');
  for (const f of fields) assert.ok(!/experience/.test(f.label), `卡片标题漏成了标签：${f.label}`);
});

test('作者显式声明的 <label for> 胜过邻近的 fieldset legend', () => {
  const html = `
    <fieldset><legend>Education</legend>
      <p><label for="highest_edu">Highest Qualification</label>
        <select id="highest_edu"><option value="">Please Select</option><option>Master</option></select></p>
      <p><label for="institution">Institution</label><input type="text" id="institution"></p>
    </fieldset>`;
  const fields = scan(html);
  assert.equal(byKey(fields, 'highest_edu').label, 'highest qualification');
  assert.equal(byKey(fields, 'institution').label, 'institution');
});

test('placeholder 是最后一名，且 generic placeholder 不会伪装成标签', () => {
  const fields = scan(`
    <div><span class="label">开始时间</span><input data-nw-test="start" placeholder="yyyy-MM-dd"></div>
    <div><input data-nw-test="orphan" placeholder="请选择时间"></div>`);
  const start = byKey(fields, 'start');
  assert.equal(start.label, '开始时间');
  assert.equal(start.labelSource, 'prev-sibling');
  const orphan = byKey(fields, 'orphan');
  assert.equal(orphan.label, '');
  assert.equal(orphan.placeholder, '请选择时间');
  assert.equal(orphan.labelRaw, '');
});

test('真实仿真表单：三张表的标签解析全部命中预期字段名', () => {
  for (const [file, key, want] of [
    ['test-forms/plain-cn.html', 'sfzh', '身份证号'],
    ['test-forms/plain-cn.html', 'selfintro', '自我评价'],
    ['test-forms/moka-kpmg-en.html', 'listening', 'listening and speaking'],
    ['test-forms/moka-kpmg-en.html', 'project_role', 'organizational role'],
    ['test-forms/sf-plain-en.html', 'highest_edu', 'highest qualification'],
  ]) {
    const dom = new JSDOM(fs.readFileSync(path.join(root, file), 'utf8'), { url: 'https://example.test/apply' });
    const f = byKey(scanForm(dom.window.document), key);
    assert.ok(f, `${file} 里找不到 ${key}`);
    assert.equal(f.label, want, `${file}#${key} 标签解析成了「${f.label}」`);
  }
});

test('AntD 下拉：role=combobox 外壳与内层匿名 input 只算一个控件', () => {
  const antd = scan(`
    <div class="ant-form-item"><label class="ant-form-item-label">毕业学院</label>
      <div class="ant-select"><div class="ant-select-selector">
        <input class="ant-select-selection-search-input" role="combobox" id="college" placeholder="请选择">
      </div></div></div>`);
  assert.equal(antd.length, 1);
  assert.equal(antd[0].el.getAttribute('role'), 'combobox');
  assert.equal(antd[0].label, '毕业学院');

  const wrapped = scan(`
    <div class="form-item"><label>所属部门</label>
      <div role="combobox" id="dept" class="el-select__input"><input class="search-inner"></div></div>`);
  assert.equal(wrapped.length, 1, 'combobox 外壳内的匿名 input 不能再单独成字段');
  assert.equal(wrapped[0].el.tagName.toLowerCase(), 'div');
});

test('不同章节的三个 fieldset 不是"重复记录"，不该被编号顶偏', () => {
  const html = `
    <form>
      <fieldset><legend>Personal</legend>
        <p><label>姓名</label><input name="a"></p><p><label>手机号码</label><input name="b"></p></fieldset>
      <fieldset><legend>Education</legend>
        <p><label>学校</label><input name="c"></p><p><label>专业</label><input name="d"></p></fieldset>
      <fieldset><legend>Work Experience</legend>
        <p><label>公司</label><input name="e"></p><p><label>职位</label><input name="f"></p></fieldset>
    </form>`;
  const fields = scan(html);
  const edu = fields.filter(f => f.sectionHint === 'education');
  assert.ok(edu.length >= 2, '教育章节没被识别出来');
  // 三个 fieldset 字段名互不相同（姓名/学校/公司），是三个章节而不是三段同类记录：
  // 编成"第 1 块"就会把硕士槽漂到本科槽，所以这里必须干脆不编号
  for (const f of edu) assert.equal(f.itemIndex, null, `教育经历被当成重复区块第 ${f.itemIndex} 块`);
});

test('真重复记录（字段名逐段重复）才编号：Sea 自研页两段教育经历实测形态', () => {
  const block = (n) => `
    <div class="se-group">
      <input placeholder="Course Start Month" data-nw-test="s${n}"><input placeholder="Course End Month" data-nw-test="e${n}">
      <input placeholder="CGPA" data-nw-test="g${n}">
    </div>`;
  const fields = scan(`<form>${block(1)}${block(2)}</form>`);
  const idx = new Map(fields.map(f => [f.el.getAttribute('data-nw-test'), f.itemIndex]));
  assert.equal(idx.get('s1'), 0, '第一段教育经历必须是槽位 0');
  assert.equal(idx.get('e1'), 0);
  assert.equal(idx.get('s2'), 1, '第二段必须是槽位 1');
  assert.equal(idx.get('g2'), 1);
});

test('SF 的 <input role=combobox> 判成自定义控件，不当成可以打字的文本框', () => {
  const fields = scan(`
    <div><label for="title">* Title</label>
      <input id="title" type="text" role="combobox" placeholder="No Selection" data-nw-test="title"></div>
    <div><a id="lang" role="combobox" aria-label="Language">English</a></div>`);
  assert.equal(fields[0].kind, 'combobox', 'role 必须优先于标签名');
  assert.equal(fields[0].label, 'title');
  assert.equal(fields[1].kind, 'combobox');
  assert.equal(fields[1].label, 'language');
});

test('打分函数：显式来源加分、标题减分、噪声直接淘汰', () => {
  assert.ok(scoreLabelCandidate('Highest Qualification', 0, false, 'label-for')
    > scoreLabelCandidate('Education', 1, true, 'prev-sibling'));
  assert.equal(pickLabelCandidate([]).text, '');
  assert.equal(pickLabelCandidate([{ text: '！！', source: 'container-text', depth: 0 }]).text, '');
  assert.equal(pickLabelCandidate([
    { text: '请选择', source: 'placeholder', depth: 9 },
    { text: '手机号码', source: 'prev-sibling', depth: 1 },
  ]).text, '手机号码');
});

test('年月成对：一行四个框是起止两段，不是四条记录；纯日期行不得被当成重复经历编号', () => {
  const dom = new JSDOM(`<div class="mk-form"><div class="mk-item"><div class="mk-label">起止时间</div>
    <div class="mk-control"><input class="mk-input" placeholder="年" data-nw-test="y1"><span>-</span><input class="mk-input" placeholder="月" data-nw-test="m1">
    <input class="mk-input" placeholder="年" data-nw-test="y2"><span>-</span><input class="mk-input" placeholder="月" data-nw-test="m2"></div></div></div>`, { url: 'https://x.test/' });
  const fields = scanForm(dom.window.document);
  const byName = Object.fromEntries(fields.map(f => [f.el.getAttribute('data-nw-test'), f]));
  assert.equal(byName.y1.datePair.id, byName.m1.datePair.id, '年框和紧跟的月框必须是同一个逻辑日期');
  assert.notEqual(byName.y1.datePair.id, byName.y2.datePair.id, '一行两组 = 开始与结束两个日期，不能全并成一组');
  assert.equal(byName.y1.datePair.role, 'start');
  assert.equal(byName.y2.datePair.role, 'end');
  assert.equal(byName.y2.datePair.roleSource, 'order', '标签只说「起止时间」时角色是按顺序推的，必须让上层降级');
  // 编号（第几段经历）只能来自真正的经历卡片；只由年/月框组成的行如果被编号，
  // 「自」会变成第 0 段、「至」变成第 1 段，一个时间段就被拆到两段经历上。
  for (const k of ['y1', 'm1', 'y2', 'm2']) assert.equal(byName[k].itemIndex, null, `${k} 不该拿到重复区块序号`);

  const range = new JSDOM(`<div class="wd-form"><div class="wd-field"><span class="wd-lab">自:</span>
    <div class="wd-control"><input placeholder="Year" data-nw-test="from_y"><input placeholder="Month" data-nw-test="from_m"></div></div>
    <div class="wd-field"><span class="wd-lab">至:</span>
    <div class="wd-control"><input placeholder="Year" data-nw-test="to_y"><input placeholder="Month" data-nw-test="to_m"></div></div></div>`, { url: 'https://x.test/' });
  const rf = Object.fromEntries(scanForm(range.window.document).map(f => [f.el.getAttribute('data-nw-test'), f]));
  assert.equal(rf.from_y.datePair.role, 'start', '「自」是标签直接说的，不是顺序猜的');
  assert.equal(rf.from_y.datePair.roleSource, 'label');
  assert.equal(rf.to_m.datePair.role, 'end');
  for (const k of ['from_y', 'from_m', 'to_y', 'to_m']) assert.equal(rf[k].itemIndex, null, `纯日期行 ${k} 被当成重复经历编号了`);
});

test('摊平表单：同名标签第二次出现 = 第二条记录，但只当"第几条"的证据、不当"哪段经历"的证据', () => {
  const dom = new JSDOM(`<div class="mk-form">
      <div class="mk-item"><div class="mk-label">公司名称</div><input placeholder="公司名称" data-nw-test="c1"></div>
      <div class="mk-item"><div class="mk-label">职位名称</div><input placeholder="职位名称" data-nw-test="t1"></div>
      <div class="mk-item"><div class="mk-label">学校名称</div><input placeholder="学校名称" data-nw-test="s1"></div>
      <div class="mk-item"><div class="mk-label">公司名称</div><input placeholder="公司名称" data-nw-test="c2"></div>
      <div class="mk-item"><div class="mk-label">职位名称</div><input placeholder="职位名称" data-nw-test="t2"></div>
    </div>`, { url: 'https://x.test/' });
  const by = Object.fromEntries(scanForm(dom.window.document).map(f => [f.el.getAttribute('data-nw-test'), f]));
  assert.equal(by.c1.itemIndex, 0);
  assert.equal(by.c2.itemIndex, 1, '同名标签第二次出现必须拿到"第 2 条"，否则两条经历的字段会互相抢位');
  assert.equal(by.t2.itemIndex, 1);
  assert.equal(by.c1.itemIndexSource, 'occurrence', '这个序号是推断出来的，匹配器要靠它拒绝绿字');
  assert.equal(by.s1.itemIndex, null, '只出现一次的标签没有"第几条"可言，不许编号');
});

test('一个标签同时挂着自定义下拉与真空输入框时，输入框是第 1 次出现（Sea 实测形态）', () => {
  const dom = new JSDOM(`<div class="se-field"><span class="se-label" id="l-cn">Contact Number *</span>
      <span class="se-select" id="l-cn-code" role="combobox" aria-haspopup="true" data-nw-test="code_combo">Select</span>
      <input class="se-input" type="text" aria-labelledby="l-cn" data-nw-test="phone"></div>
    <div class="se-field"><span class="se-label" id="l-cn2">Contact Number</span>
      <input class="se-input" type="text" aria-labelledby="l-cn2" data-nw-test="phone2"></div>`, { url: 'https://x.test/' });
  const by = Object.fromEntries(scanForm(dom.window.document).map(f => [f.el.getAttribute('data-nw-test'), f]));
  assert.equal(by.phone.itemIndex, 0, 'role=combobox 那个壳子永远填不了，不能占掉一次出现');
  assert.equal(by.phone2.itemIndex, 1);
});

test('「Work Authorization」是合规块，不是工作经历块；「Work Experience」仍然要认', () => {
  const dom = new JSDOM(`<fieldset><legend>Work Authorization</legend>
      <p><label for="wa">Current Work Authorization</label><select id="wa"><option>Hong Kong Permanent Resident</option></select></p>
      <p><label for="sp">Do you require sponsorship?</label><input id="sp" type="text"></p></fieldset>
    <fieldset><legend>Work Experience</legend>
      <p><label for="co">Company</label><input id="co" type="text"></p></fieldset>`, { url: 'https://x.test/' });
  const fields = scanForm(dom.window.document);
  const wa = fields.find(f => f.el.id === 'wa');
  assert.notEqual(wa.sectionHint, 'work',
    '裸 "work" 命中章节词会把合规块当成工作经历块：「是否需要签证担保」被章节惩罚 ×0.75 后掉到候选线以下，整栏变成"我们没有这个词"');
  assert.equal(fields.find(f => f.el.id === 'co').sectionHint, 'work', '真正的 Work Experience 还得认出来，不能一刀切');
});

test('区号下拉的显示文本不能被当成手机号标签（zhiye 实测形态）', () => {
  const dom = new JSDOM(`<form>
    <div class="row"><span class="cc-select ant-select"><span class="ant-select-selection-item">中国大陆 +86</span></span>
      <input data-nw-test="phone" placeholder="请输入11位手机号"></div>
    <div class="row"><div class="label">家庭住址</div><input data-nw-test="addr" placeholder="请输入"></div>
  </form>`, { url: 'https://x.test/' });
  const f = Object.fromEntries(scanForm(dom.window.document).map(x => [x.el.getAttribute('data-nw-test'), x]));
  assert.notEqual(f.phone.label, '中国大陆 +86', '自定义下拉的显示区不是标签，抓到它等于给手机号安了个别名');
  assert.equal(f.addr.label, '家庭住址', '真标签还得照常拿得到');
});
