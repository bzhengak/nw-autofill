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

test('栅格条目：标签那一支排在控件之后也要认（AntD ant-col 形状）', () => {
  const fields = scan(`
    <div class="ant-row ant-form-item">
      <div class="ant-col ant-col-16"><div class="ant-form-item-control-wrapper"><div class="ant-form-item-control">
        <span class="ant-form-item-children"><span class="ant-calendar-picker"><input readonly data-nw-test="d1"></span></span>
      </div></div></div>
      <div class="ant-col ant-col-8"><div class="ant-form-item-label"><label>毕业时间</label></div></div>
    </div>`);
  const f = byKey(fields, 'd1');
  assert.equal(f.label, '毕业时间');
  assert.equal(f.labelSource, 'item-label');
});

test('倒找的标签只认"这一条目里不含控件的 label 支"：校验文案与隔壁条目都不算', () => {
  const fields = scan(`
    <form>
      <div class="ant-row ant-form-item">
        <div class="ant-col ant-col-16"><span class="ant-form-item-children"><input name="nm" data-nw-test="nm"></span></div>
        <div class="ant-col ant-col-8"><div class="ant-form-explain">SECRET_这里是不该当标签的校验提示</div></div>
      </div>
      <div class="ant-row ant-form-item">
        <div class="ant-col ant-col-16"><span class="ant-form-item-children"><input name="xx" data-nw-test="xx"></span></div>
      </div>
      <div class="other-block"><div class="label">邻区块文字</div></div>
    </form>`);
  // .ant-form-explain 不带 label/title 类名，也没有 <label>，所以不会被倒找规则捞走
  assert.ok(!/SECRET_/.test(byKey(fields, 'nm').label || ''), '校验文案被当成标签了');
  assert.ok(!/邻区块/.test(byKey(fields, 'xx').label || ''), '隔壁区块的文字被当成标签了');
});

test('HTML 注释不是标签（真实页面会留模板注释和构建水印）', () => {
  // ① 页面上没有别的候选时，注释正文绝不能顶上来当标签
  const alone = scan(`
    <div class="ant-row ant-form-item">
      <div class="ant-form-item-control-wrapper"><span class="ant-form-item-children">
        <!-- 这里是一段模板注释，不是字段名 -->
        <input name="solo" data-nw-test="solo">
      </span></div>
    </div>`);
  assert.equal(byKey(alone, 'solo').label, '', '注释正文被当成了字段标签');

  // ② 有真标签时也不许把注释混进原始文本里
  const withLabel = scan(`
    <div class="ant-row ant-form-item">
      <div class="ant-form-item-label"><label>期望行业</label></div>
      <div class="ant-form-item-control-wrapper"><span class="ant-form-item-children">
        <!-- 搜索型下拉壳子里有内层 input 这是边界情况 -->
        <div role="combobox" aria-haspopup="listbox" data-nw-test="ind"></div>
      </span></div>
    </div>`);
  const f = byKey(withLabel, 'ind');
  assert.equal(f.label, '期望行业');
  assert.ok(!/边界情况/.test(f.labelRaw || ''), '注释正文被当成了标签或原始标签');
});

test('条目套条目（国聘 iguopin 真实形状）：标签隔了 9~13 层也要够到，且不许捞隔壁条目的', () => {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'test-forms/iguopin-nested-cn.html'), 'utf8'), { url: 'https://c.iguopin.test/apply' });
  const fields = scanForm(dom.window.document);
  const by = k => byKey(fields, k);
  assert.equal(by('school')?.label, '学校名称', '嵌套条目里的下拉取不到标签 = 整片字段白屏');
  assert.equal(by('school_hidden_a')?.label, '学校名称');
  assert.equal(by('major')?.label, '专业名称');
  assert.equal(by('name')?.label, '姓名', '隔壁条目的标签串过来了');
  // 标签文字里那段"（最多 20 字，超出部分不显示）"不能进匹配用名
  assert.ok(!/超出部分/.test(by('school').label), '提示文字混进了标签');
});

/**
 * 途普 tupu360 真实导出（careersite.tupu360.com/accentureats，2026-10-01）里 41 个控件有 26 个拿不到标签：
 * 同一行里的 <input> 靠 prev 兄弟拿到了 '*Name'，而 <div role="combobox"> 的 chain 顶到
 * span.field-value 就断了 —— 它的标签不在这个 AntD 条目里，而是在**包着这个条目的小 <form> 外面**。
 * 2026-09-29 那版复刻没复现，原因就写在文件头：当时探针不导出兄弟分支，class 名之外的信息一片空白。
 */
const tupuRow = (label, cls = 'field-label') => `
  <div class="field-group">
    <span class="field-value field-editor">
      <form class="ant-form ant-form-horizontal specialSelect">
        <div class="ant-row ant-form-item"><div class="ant-form-item-control-wrapper">
          <div class="ant-form-item-control has-success"><span class="ant-form-item-children">
            <div><div class="searchStyle ant-select ant-select-enabled">
              <div role="combobox" aria-haspopup="listbox" data-nw-test="edu"></div>
            </div></div>
          </span></div>
        </div></div>
      </form>
      <${'span'} class="${cls}">${label}</${'span'}>
    </span>
  </div>`;

test('标签在字段自带的 <form> 外面（途普真实形状）：combobox 也该拿到它', () => {
  const f = byKey(scan(tupuRow('最后毕业学校')), 'edu');
  assert.equal(f.label, '最后毕业学校', `form 外层的标签没够到，实得「${f.label}」`);
  // 隔壁字段不许串进来：另一行也有标签时，各拿各的
  const two = `<div class="field-wrap">${tupuRow('最后毕业学校')}
    <div class="field-group"><span class="field-value field-editor"><form class="ant-form">
      <div role="combobox" aria-haspopup="listbox" data-nw-test="other"></div></form>
      <span class="field-label">期望工作城市</span></span></div></div>`;
  const fs2 = scan(two);
  const mine = fs2.filter(x => x.el.getAttribute('data-nw-test') === 'other');
  assert.equal(mine[0]?.label, '期望工作城市', '隔壁条目的标签串过来了，或者第二个字段仍拿不到标签');
});

test('两列条目里标签分支自己不套 <label>（field-label 裸文本）也算标签', () => {
  const [f] = scan(`<div class="ant-row ant-form-item">
    <span class="field-label">是否有亲属在本系统</span>
    <div class="ant-form-item-control-wrapper"><div class="ant-form-item-control">
      <span class="ant-form-item-children"><input data-nw-test="rel"></span>
    </div></div>
  </div>`);
  assert.equal(f.label, '是否有亲属在本系统');
});

/**
 * AntD / Element 的 radio、checkbox 真身是 opacity:0 的 input，看得见的是一层皮肤 span。
 * 用户 2026-10-01 在途普那张页面遇到的就是这种：探针数出 28 个 checkbox + 5 个 radio，
 * 可扫描结果里一个都没有 —— 于是"这一页完全填不上"，而我们只看到"控件数为 0 的字段类型"。
 */
const SKIN_HTML = `<form><fieldset>
  <legend>是否有亲属在本系统</legend>
  <label class="ant-radio-wrapper"><span class="ant-radio">
      <span class="ant-radio-inner"></span><input type="radio" class="ant-radio-input" name="relative" value="Y" style="opacity: 0">
    </span><span>是</span></label>
  <label class="ant-radio-wrapper"><span class="ant-radio">
      <span class="ant-radio-inner"></span><input type="radio" class="ant-radio-input" name="relative" value="N" style="opacity: 0">
    </span><span>否</span></label>
</fieldset>
<fieldset>
  <legend>技能掌握</legend>
  <label class="ant-checkbox-wrapper"><span class="ant-checkbox">
      <input type="checkbox" class="ant-checkbox-input" name="skill" value="PY" style="opacity: 0">
    </span><span>Python</span></label>
  <label class="ant-checkbox-wrapper"><span class="ant-checkbox">
      <input type="checkbox" class="ant-checkbox-input" name="skill" value="SQL" style="opacity: 0">
    </span><span>SQL</span></label>
</fieldset></form>`;

test('皮肤化的 radio/checkbox（input 被 opacity:0 藏起来）也要被扫到，且选项文案取得到', () => {
  const fields = scan(SKIN_HTML);
  const radios = fields.filter(f => f.kind === 'radio');
  const boxes = fields.filter(f => f.kind === 'checkbox');
  assert.equal(radios.length, 1, `皮肤 radio 组没被扫到（拿到 ${radios.length} 条）`);
  assert.equal(boxes.length, 1, '皮肤 checkbox 组没被扫到');
  assert.deepEqual(radios[0].options.map(o => o.text), ['是', '否'], `选项文案是空的：${JSON.stringify(radios[0].options)}`);
  assert.deepEqual(radios[0].options.map(o => o.value), ['Y', 'N'], '选项码值没带出来');
  // 选项文案走的是和老写法同一个清洗（core() 会转小写），这里钉的是"取得到字"，不是大小写
  assert.deepEqual(boxes[0].options.map(o => o.text), ['python', 'sql']);
  assert.equal(radios[0].skinned, true, '要标注这是"靠皮肤可见"的控件，导出与判分都靠它分辨');
  assert.match(radios[0].label, /亲属/, '组标签没拿到，字段名会是一串空白');
});

/**
 * 途普 Declaration 那一块的真实形状（用户 2026-10-01 补充）：
 * **整页没有 <label> 元素**，题目写在字段壳子的另一支上，而且还在那个"每字段一个小 form"的外面。
 * 组标签机制（减掉选项文本看剩什么）在这里什么都不剩 —— 控件扫到了、选项也取得到，
 * 唯独字段名是空的，等于"能填但不知填哪一栏"。所以组标签要退回单控件标签规则。
 */
test('没有 <label> 元素的声明区：题目在 form 外时，radio 组也要有字段名', () => {
  const html = `<div class="field-group">
    <span class="field-label">是否有犯罪记录</span>
    <span class="field-value field-editor">
      <form class="ant-form ant-form-horizontal specialSelect"><div class="ant-row ant-form-item">
        <span class="ant-form-item-children">
          <input type="radio" name="criminal" value="1" style="opacity: 0"><span>是</span>
          <input type="radio" name="criminal" value="0" style="opacity: 0"><span>否</span>
        </span></div></form>
    </span>
  </div>`;
  const radios = scan(html).filter(f => f.kind === 'radio');
  assert.equal(radios.length, 1, '同名 radio 该并成一个组');
  assert.match(radios[0].label, /犯罪记录/, `组标签取不到题目，实得「${radios[0].label}」`);
  assert.deepEqual(radios[0].options.map(o => o.text), ['是', '否'], '选项文字取不到');
  assert.deepEqual(radios[0].options.map(o => o.value), ['1', '0'], '码值取不到');
});

/**
 * 「Name 这一栏在哪个板块」——途普那张页面没有任何 h1-h4/legend，sections 导出是空的，
 * 而页面上有 5 个都叫 Name 的框（项目、实习、组织、证书、推荐人）。
 * 板块标题在 DOM 里确实存在，只是它既不是标题标签也不在字段那一层：
 * 它是"一个容器里排着好几栏"的第一支不含控件的文本。以前没人看这一层。
 */
const BLOCKS_HTML = `<div class="page">
  <div class="section-box">
    <div class="sec-title">教育经历</div>
    <div class="field-group"><span class="field-label">学校名称</span><span class="field-value"><input data-nw-test="e1"></span></div>
    <div class="field-group"><span class="field-label">专业</span><span class="field-value"><input data-nw-test="e2"></span></div>
  </div>
  <div class="section-box">
    <div class="sec-title">资格证书</div>
    <div class="field-group"><span class="field-label">Name</span><span class="field-value"><input data-nw-test="c1"></span></div>
    <div class="field-group"><span class="field-label">获得时间</span><span class="field-value"><input data-nw-test="c2"></span></div>
  </div>
</div>`;

test('板块标题能当章节证据：证书区块里的 Name 归到 certifications 而不是基本信息', () => {
  const fields = scan(BLOCKS_HTML);
  const by = k => fields.find(f => f.el.getAttribute('data-nw-test') === k);
  assert.equal(by('c1').sectionHint, 'certifications', `板块标题没被当证据，实得 hint=${by('c1').sectionHint}`);
  assert.equal(by('c1').sectionTitle, '资格证书');
  assert.equal(by('e1').sectionHint, 'education');
  // 字段自己的标签仍然优先：hint 只用来在多个同名词之间做归属判断
  assert.equal(by('e1').label, '学校名称');
});

test('区块容器里找不到标题时不许改口：宁可没证据，也不拿页面大标题当板块', () => {
  const html = `<h1>候选人简历</h1><div class="wrap">
    <div class="field-group"><span class="field-label">Name</span><span class="field-value"><input data-nw-test="n1"></span></div>
    <div class="field-group"><span class="field-label">Name</span><span class="field-value"><input data-nw-test="n2"></span></div>
  </div>`;
  const fields = scan(html);
  for (const k of ['n1', 'n2']) {
    const f = fields.find(x => x.el.getAttribute('data-nw-test') === k);
    assert.ok(!f.sectionHint, `没有板块标题却给出了章节归属：${f.sectionHint}（会把手名都归到同一块）`);
  }
});
