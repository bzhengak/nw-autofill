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

test('itemIndex 按"同一章节内第几块"编号，不被其他 fieldset 顶偏', () => {
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
  for (const f of edu) assert.equal(f.itemIndex, 0, `教育经历被编成第 ${f.itemIndex} 块，会把硕士槽漂到本科槽`);
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
