// 表单编辑区的中/英切换：这是用户填英文网申时对着看的界面，
// 切错、写错桶（把英文覆盖到中文值上）都是数据丢失级的问题，单独钉一组。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = p => fileURLToPath(new URL(p, import.meta.url));
const html = fs.readFileSync(root('../ui/sidepanel.html'), 'utf8');
const high = JSON.parse(fs.readFileSync(root('../core/high-frequency.json'), 'utf8'));

function boot(profile, settings = {}, scan = null) {
  const dom = new JSDOM(html, { url: 'chrome-extension://nwtest/ui/sidepanel.html', pretendToBeVisual: true });
  dom.window.CSS = dom.window.CSS || {};
  if (!dom.window.CSS.escape) dom.window.CSS.escape = s => String(s).replace(/([^\w-])/g, '\\$1');
  const sent = [];
  dom.window.chrome = {
    runtime: {
      getURL: p => 'chrome-extension://nwtest/' + p,
      sendMessage: async msg => {
        sent.push(msg);
        if (msg.type === 'nw:scan' && scan) return scan;
        return {
          ok: true, profile, settings: { ...settings, ...(msg.type === 'nw:saveSettings' ? msg.settings : {}) },
          tabId: 1, hasAiKey: false, aiKeyOrigin: '', aiKeyPersisted: false, aiKeyLength: 0,
        };
      },
      onMessage: { addListener() {} },
    },
    tabs: { query: async () => [{ id: 1 }] },
    storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } },
  };
  dom.window.fetch = async () => ({ json: async () => high });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.CSS = dom.window.CSS;
  globalThis.fetch = dom.window.fetch;
  globalThis.chrome = dom.window.chrome;
  return { dom, doc: dom.window.document, sent };
}

async function load() {
  await import('../ui/sidepanel.js?lang=' + Math.random().toString(36).slice(2));
  await new Promise(r => setTimeout(r, 40));
}

const PROFILE = {
  basics: { name: '张伟', lastName: 'Zhang', firstName: 'Wei', gender: '男' },
  contact: {}, education: [{ school: '南京大学', major: '计算机科学与技术', degree: '本科', enrollDate: '2021-09', gradDate: '2025-06' }],
  work: [], internship: [], projects: [], campus: [], awards: [], competitions: [],
  publications: [], skills: {}, languages: [], certifications: [], intent: {}, others: {},
  records: {}, family: {}, hkGlobal: {}, declaration: {}, en: {},
};

const rowOf = (doc, path) => doc.querySelector(`#formBody [data-path="${path}"]`);

test('切到 English 表单：标签变英文、中文值不丢，缺英文的那栏标出来', async () => {
  const { doc } = boot(JSON.parse(JSON.stringify(PROFILE)));
  await load();
  doc.getElementById('btnForm').click();
  await new Promise(r => setTimeout(r, 40));
  const zhLabel = rowOf(doc, 'education.0.school').closest('label');
  assert.match(zhLabel.querySelector('span').textContent, /学校/, '中文模式下标签该是中文');

  doc.getElementById('langEn').click();
  await new Promise(r => setTimeout(r, 60));
  const enRow = rowOf(doc, 'education.0.school').closest('label');
  assert.match(enRow.querySelector('span').textContent, /School/, '切英文后标签没换成英文');
  assert.ok(!/[\u3400-\u9fff]/.test(enRow.querySelector('span').textContent), '英文标签里还留着中文');
  assert.equal(rowOf(doc, 'education.0.school').value, '', '没英文值却显示中文值，会让人以为已经填好了');
  assert.match(rowOf(doc, 'education.0.school').placeholder, /南京大学/, '灰色提示该给出中文值当参照');
  assert.ok(enRow.className.includes('needsEn'), '缺英文的栏位没有可见标记');
  assert.match(doc.getElementById('langMeta').textContent, /只有中文值/, '顶部没数出还缺几栏');

  // 拼音姓名 / 日期两种语言同一个值，不该被催着补第二遍
  assert.equal(rowOf(doc, 'basics.lastName').value, 'Zhang');
  assert.equal(rowOf(doc, 'education.0.enrollDate').value, '2021-09');
  assert.ok(!rowOf(doc, 'education.0.enrollDate').closest('label').className.includes('needsEn'));
});

test('保存只写当前语言的桶：英文值不会覆盖中文，中文值也不会被英文清空', async () => {
  const { doc, sent } = boot(JSON.parse(JSON.stringify(PROFILE)));
  await load();
  doc.getElementById('btnForm').click();
  doc.getElementById('langEn').click();
  await new Promise(r => setTimeout(r, 60));
  rowOf(doc, 'education.0.school').value = 'Nanjing University';
  doc.getElementById('btnFormSave').click();
  await new Promise(r => setTimeout(r, 60));
  const saved = sent.filter(m => m.type === 'nw:saveProfile').pop();
  assert.equal(saved.profile.en.education[0].school, 'Nanjing University', '英文值没写进 en 桶');
  assert.equal(saved.profile.education[0].school, '南京大学', '中文值被动了 —— 那是数据丢失');
});

test('枚举在英文模式下显示 Male，存的仍是规范值 男（写英文会把选项匹配搞坏）', async () => {
  const { doc } = boot(JSON.parse(JSON.stringify(PROFILE)));
  await load();
  doc.getElementById('btnForm').click();
  await new Promise(r => setTimeout(r, 40));
  const zhSel = rowOf(doc, 'basics.gender');
  assert.equal(zhSel.value, '男');
  doc.getElementById('langEn').click();
  await new Promise(r => setTimeout(r, 60));
  const sel = rowOf(doc, 'basics.gender');
  const texts = [...sel.options].map(o => o.textContent);
  assert.ok(texts.includes('Male'), `EN 模式下选项没翻成英文：${texts.join('/')}`);
  assert.equal(sel.value, '男', '存进 profile 的必须是规范值，不是英文显示文字');
  const male = [...sel.options].find(o => o.textContent === 'Male');
  assert.equal(male.value, '男', 'option.value 被英文覆盖了 —— 那会把选项匹配与回读一起搞坏');
});

test('切换会记住：刷新面板后仍在英文模式，不会把用户补到一半弹回中文', async () => {
  const { doc, sent } = boot(JSON.parse(JSON.stringify(PROFILE)), { editorLang: 'en' });
  await load();
  doc.getElementById('btnForm').click();
  await new Promise(r => setTimeout(r, 60));
  assert.ok(doc.getElementById('langEn').classList.contains('on'), '设置里是 en，界面却回到中文');
  assert.match(rowOf(doc, 'education.0.school').closest('label').querySelector('span').textContent, /School/);
  doc.getElementById('langZh').click();
  await new Promise(r => setTimeout(r, 60));
  assert.equal(sent.filter(m => m.type === 'nw:saveSettings').pop()?.settings?.editorLang, 'zh', '切换没落到设置');
});

// 面板上那个"缺英文时写中文并标黄"的勾，如果没真的落到 settings.enMissingMode，
// matcher 就读不到 —— 和当年 fillSensitive 一样是"界面承诺了、代码没做"。
test('缺英文兜底开关：勾一下就要写进设置，刷新时跟着存储走而不是跟着鼠标', async () => {
  const { doc, sent } = boot(JSON.parse(JSON.stringify(PROFILE)));
  await load();
  const box = doc.getElementById('enZhFallback');
  assert.equal(box.checked, false, '默认必须是"不写中文"：降级兜底要用户主动开');
  box.checked = true;
  box.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 40));
  assert.equal(
    sent.filter(m => m.type === 'nw:saveSettings').pop()?.settings?.enMissingMode, 'zh_yellow',
    '勾选没落到 settings.enMissingMode');

  // 反向：存储里已经是 zh_yellow，重新打开面板时勾必须亮着
  const again = boot(JSON.parse(JSON.stringify(PROFILE)), { enMissingMode: 'zh_yellow' });
  await load();
  assert.equal(again.doc.getElementById('enZhFallback').checked, true, '存储里开着，界面却显示关着');
});

test('英文表单上有槽位因缺英文值被跳过：面板要说是哪几栏、故意留空、以及两条出路', async () => {
  const scan = {
    ok: true, adapterId: '', adapterInfo: null,
    data: {
      stats: { scanned: 3, planned: 1, green: 1, review: 0, red: 0, gaps: 2, profileFilled: 12 },
      results: [{ status: 'green', label: 'Last Name', path: 'basics.lastName', actual: 'Zhang' }],
      gaps: [
        { index: 1, label: 'School Name', reason: 'missing_english_value', kind: 'text' },
        { index: 2, label: 'Major', reason: 'missing_english_value', kind: 'text' },
      ],
    },
  };
  const { doc } = boot(JSON.parse(JSON.stringify(PROFILE)), {}, scan);
  await load();
  doc.getElementById('btnPreview').click();
  await new Promise(r => setTimeout(r, 60));
  const stats = doc.getElementById('stats').textContent;
  assert.match(stats, /英文表单/, `没交代这一页是英文表单：${stats}`);
  assert.match(stats, /2/, '没说清有几栏被跳过');
  assert.match(stats, /留空|不写入/, '没说清这些栏位是被故意跳过的，用户会以为漏扫了');
  assert.match(stats, /分类编辑/, '没给出补英文值的去处');
  // 缺口表里也要能看懂：中文说明，而不是裸 token
  assert.match(doc.getElementById('gaps').textContent, /英文/, '缺口行只显示了 reason token');
});
