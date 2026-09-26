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
