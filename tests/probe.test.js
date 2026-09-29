import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { probePageStructure, summarizeProbe } from '../dom/probe.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'test-forms/plain-cn.html'), 'utf8');

/** 往页面里塞入"用户已填写的隐私内容"，然后断言探针的输出里绝不出现它们 */
function domWithSecrets() {
  const dom = new JSDOM(html, { url: 'https://example.test/apply' });
  const doc = dom.window.document;
  doc.querySelector('[name="xm"]').value = 'SECRET_姓名_王小明';
  doc.querySelector('[name="sjh"]').value = 'SECRET_手机_13800001111';
  doc.querySelector('[name="sfzh"]').value = 'SECRET_身份证_320102199001019999';
  const ta = doc.querySelector('[name="selfintro"]');
  if (ta) ta.value = 'SECRET_自我评价_我的家庭情况';
  return { dom, doc, win: dom.window };
}

test('探针不读取任何已填写内容（把隐私值塞进去后断言输出里没有）', () => {
  const { doc, win } = domWithSecrets();
  const out = probePageStructure(doc, win.location.href, win);
  const json = JSON.stringify(out);
  for (const secret of ['SECRET_姓名', 'SECRET_手机', 'SECRET_身份证', 'SECRET_自我评价', '王小明', '13800001111', '320102199001019999']) {
    assert.ok(!json.includes(secret), `输出里出现了不该有的内容：${secret}`);
  }
  assert.ok(!Object.keys(out.fields[0]).includes('value'), '字段对象不应有 value 键');
  assert.ok(!json.includes('"value"'), '输出不应包含任何 value 键');
});

test('探针抓到结构：标签、必填、下拉候选项、文件上传数', () => {
  const { doc, win } = domWithSecrets();
  const out = probePageStructure(doc, win.location.href, win);
  assert.ok(out.totals.controls > 30, `控件数偏少：${out.totals.controls}`);
  assert.equal(out.totals.fileInputs, 1);
  assert.equal(out.totals.selects, 5);
  const name = out.fields.find(f => f.name === 'xm');
  assert.ok(name && /贵姓|姓名/.test(name.label), '应识别出姓名字段标签');
  const edu = out.fields.find(f => f.name === 'xl');
  assert.ok(Array.isArray(edu.options) && edu.options.some(o => o.includes('本科')), '应抓到站点自带的下拉候选项文案');
  assert.ok(out.sections.some(s => /实习经历|基本信息/.test(s)), '应抓到小节标题');
});

test('summarizeProbe 只留适配器需要的信息', () => {
  const { doc, win } = domWithSecrets();
  const s = summarizeProbe(probePageStructure(doc, win.location.href, win));
  assert.deepEqual(Object.keys(s).sort(), ['fields', 'framework', 'libs', 'sections', 'site', 'topLibrary', 'totals'].sort());
  assert.ok(!JSON.stringify(s).includes('SECRET_'));
  assert.ok(s.fields.every(f => f.value === undefined));
});

test('框架与组件库判定不抛错并给出结构', () => {
  const { doc, win } = domWithSecrets();
  const out = probePageStructure(doc, win.location.href, win);
  assert.equal(typeof out.componentLibs.ant, 'number');
  assert.ok(['none/自定义组件', 'ant', 'element'].includes(out.topLibrary) || typeof out.topLibrary === 'string');
  assert.equal(typeof out.at, 'string');
});

test('导出物自带探针版本与子框地图（SF/汇丰 靠它定位表单藏在哪个框）', () => {
  const dom = new JSDOM('<!doctype html><html><body><iframe name="app" src="about:blank"></iframe>'
    + '<iframe src="https://match.adsrvr.org/track/cei"></iframe></body></html>', { url: 'https://career10.successfactors.com/portalcareer' });
  const { doc, win } = { doc: dom.window.document, win: dom.window };
  // 同源框里塞几个控件，验证"能量到的就报控件数，能量不到的只报 src"
  const inner = doc.querySelector('iframe[name="app"]').contentDocument;
  inner.body.innerHTML = '<input name="a"><input name="b"><select name="c"></select>';
  const out = probePageStructure(doc, win.location.href, win);
  assert.equal(typeof out.probeBuild, 'string', '探针必须自带版本号');
  assert.equal(out.isTopFrame, true);
  assert.equal(out.iframeMap.length, 2);
  const first = out.iframeMap.find(x => x.frameName === 'app');
  assert.equal(first.sameOrigin, true);
  assert.equal(first.controls, 3);
  const ad = out.iframeMap.find(x => /adsrvr/.test(x.src));
  assert.equal(ad.sameOrigin, false, '跨源框不得伪报控件数');
  assert.equal(ad.controls, null);
  assert.ok(!JSON.stringify(out).includes('value'), '子框地图同样不得带出任何填写值');
});

test('0 控件时探针自己说清"下一步做什么"（分步向导要先点填写）', () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <h2>我的简历</h2>
    <button>开始填写</button><a href="/x">继续完善</a><button>下一步</button>
    <my-widget></my-widget><my-widget></my-widget>
  </body></html>`, { url: 'https://zhaopin.test/resume2' });
  const out = probePageStructure(dom.window.document, 'https://zhaopin.test/resume2', dom.window);
  assert.equal(out.totals.controls, 0);
  assert.ok(out.emptyHints.gateButtons.includes('开始填写'), JSON.stringify(out.emptyHints));
  assert.ok(out.emptyHints.gateButtons.includes('继续完善'));
  assert.equal(out.emptyHints.customElementHosts, 2, 'closed shadow 的自定义元素要报出来：探针读不到内部不是 bug，是要让人知道');
  assert.equal(out.emptyHints.loginWall, false);
  assert.ok(!JSON.stringify(out).includes('13800'), '诊断信息里不许出现填写值');
});

test('登录墙文案要标出来，别让人以为是扩展坏了', () => {
  const dom = new JSDOM(`<!doctype html><html><body><p>请先登录后再查看职位并填写简历</p></body></html>`, { url: 'https://x.test/' });
  const out = probePageStructure(dom.window.document, 'https://x.test/', dom.window);
  assert.equal(out.emptyHints.loginWall, true);
});

test('有控件时不产生误导性的空态诊断', () => {
  const dom = new JSDOM(`<!doctype html><html><body><input name="nm"><button>提交</button></body></html>`, { url: 'https://x.test/' });
  const out = probePageStructure(dom.window.document, 'https://x.test/', dom.window);
  assert.ok(out.totals.controls >= 1);
  assert.deepEqual(out.emptyHints.gateButtons, [], '提交按钮不该被当成"先点这里出现表单"的提示');
});

// 探针是"给适配器看的眼睛"。它报"这个字段没标签"却说不清标签在 DOM 哪儿，
// 每修一次就要用户重导一次真实站点 —— tupu 那 25 栏就是这么卡住的。
const GRID_HTML = `<!doctype html><html><body><form class="ant-form">
  <div class="ant-row ant-form-item">
    <div class="ant-col ant-col-16"><div class="ant-form-item-control-wrapper"><div class="ant-form-item-control">
      <span class="ant-form-item-children"><span class="ant-calendar-picker">
        <input readonly name="grad" value="SECRET_日期_2026年6月">
      </span></span>
    </div></div></div>
    <div class="ant-col ant-col-8"><div class="ant-form-item-label"><label>毕业时间</label></div></div>
  </div>
</form></body></html>`;

const probeOf = (html, url = 'https://careersite.tupu360.test/cummins/resume/applicationView') => {
  const dom = new JSDOM(html, { url });
  return probePageStructure(dom.window.document, url, dom.window);
};

test('无标签字段要带结构素描：标签那一支的类名看得见，控件本体压成标记', () => {
  const out = probeOf(GRID_HTML);
  const f = out.fields.find(x => x.name === 'grad');
  assert.ok(f, '探针没扫到这个字段');
  assert.ok(f.sketch, '没标签又没有素描，等于让我继续猜');
  assert.match(f.sketch, /ant-form-item-label/);
  assert.match(f.sketch, /毕业时间/);
  assert.match(f.sketch, /data-nw-here/);
});

test('素描不带用户填进去的任何值（value 属性、已选文本都算）', () => {
  const out = probeOf(GRID_HTML);
  const json = JSON.stringify(out);
  for (const secret of ['SECRET_日期', '2026年6月']) {
    assert.ok(!json.includes(secret), `导出里出现了用户内容：${secret}`);
  }
});

test('素描只给缺标签的字段，且一页最多 10 条（导出不能变成几十 KB）', () => {
  const rows = Array.from({ length: 14 }, (_, i) => `
    <div class="ant-row ant-form-item"><span class="ant-form-item-children">
      <input name="x${i}">
    </span></div>`).join('');
  const out = probeOf(`<!doctype html><html><body><form>${rows}
    <div class="ant-row ant-form-item"><div class="ant-form-item-label"><label>姓名</label></div>
      <span class="ant-form-item-children"><input name="named"></span></div>
  </form></body></html>`);
  const sketched = out.fields.filter(f => f.sketch);
  assert.ok(sketched.length <= 10, `素描 ${sketched.length} 条，超预算`);
  assert.equal(out.fields.find(f => f.name === 'named')?.sketch, undefined, '有标签的字段不该带素描');
});

test('探针要同时报"填充路径看到的标签"，不然分不清是页面问题还是探针抄漏规则', () => {
  const out = probeOf(GRID_HTML);
  const f = out.fields.find(x => x.name === 'grad');
  // 探针自己的简化实现走不到（标签在控件之后），scanner 的倒找规则走到了
  assert.ok(!f.label, '这条测试的前提是探针自己拿不到标签');
  assert.equal(f.scanLabel, '毕业时间');
  assert.equal(f.scanVia, 'item-label');
});

test('只读日历控件即使有标签也带素描（下一步要不要替用户点面板，得先看面板长什么样）', () => {
  const html = `<!doctype html><html><body><form>
    <div class="ant-form-item">
      <div class="ant-col ant-form-item-label"><label>开始时间</label></div>
      <div class="ant-col ant-form-item-control">
        <span class="ant-picker ant-picker-outlined">
          <input readonly placeholder="请选择开始时间" id="start_date" data-nw-test="d">
          <span class="ant-picker-suffix"><span class="anticon anticon-calendar"></span></span>
        </span>
      </div>
    </div>
    <div class="ant-form-item">
      <div class="ant-col ant-form-item-label"><label>备注</label></div>
      <div class="ant-col ant-form-item-control"><input type="text" id="note_field" data-nw-test="n"></div>
    </div>
  </form></body></html>`;
  const dom = new JSDOM(html, { url: 'https://c.iguopin.test/apply' });
  const out = probePageStructure(dom.window.document, 'https://c.iguopin.test/apply', dom.window);
  const d = out.fields.find(f => f.id === 'start_date');
  const n = out.fields.find(f => f.id === 'note_field');
  assert.ok(d.label, '这条测试的前提是它自己就有标签');
  assert.ok(d.sketch, '只读日历控件没带素描，下一轮还是只能猜');
  assert.match(d.sketch, /ant-picker/);
  assert.equal(n.sketch, undefined, '普通有标签字段不该带素描');
});

test('自定义控件计数要认出挂在 <input> 上的 role=combobox（AntD v5 / 国聘形态）', () => {
  const html = `<!doctype html><html><body><form>
    <input type="search" role="combobox" aria-haspopup="listbox" id="a">
    <input type="text" role="combobox" id="b">
    <div role="combobox" id="c"></div>
    <input type="text" id="d" placeholder="普通框">
    <select id="e"><option>1</option></select>
  </form></body></html>`;
  const dom = new JSDOM(html, { url: 'https://x.test/' });
  const out = probePageStructure(dom.window.document, 'https://x.test/', dom.window);
  assert.equal(out.totals.customWidgets, 3, `数到 ${out.totals.customWidgets} 个，用户会以为这页没有需要点开的控件`);
  assert.equal(out.totals.selects, 1);
});
