// AI 辅助导入的界面闭环测试：预览 → 每次确认 → 勾选 → 写入。
// 这里守的是"没说出口就不能发"：没预览不给发、confirm 取消就不发、发一次就要重新预览。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = p => fileURLToPath(new URL(p, import.meta.url));
const html = fs.readFileSync(root('../ui/sidepanel.html'), 'utf8');
const high = JSON.parse(fs.readFileSync(root('../core/high-frequency.json'), 'utf8'));

// 一段"本地解析判不动"的简历：标题「 Miscellaneous 」认不出来，正文只能整段留下
const MD = '# 基本信息\n\n张三\n\n# Miscellaneous\n\n校学生会宣传部 副部长 2022.09-2023.06\n';

function bootExtract(handler) {
  const dom = new JSDOM(html, { url: 'chrome-extension://nwtest/ui/sidepanel.html', pretendToBeVisual: true });
  dom.window.CSS = dom.window.CSS || {};
  if (!dom.window.CSS.escape) dom.window.CSS.escape = s => String(s).replace(/([^\w-])/g, '\\$1');
  const sent = [];
  dom.window.chrome = {
    runtime: {
      getURL: p => 'chrome-extension://nwtest/' + p,
      sendMessage: async msg => { sent.push(msg); return handler(msg, sent) || { ok: true, profile: {}, settings: {}, tabId: 1 }; },
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
  await import('../ui/sidepanel.js?run=' + Math.random().toString(36).slice(2));
  await new Promise(r => setTimeout(r, 40));
}

const click = async (doc, id) => { doc.getElementById(id).click(); await new Promise(r => setTimeout(r, 40)); };

const PREVIEW_RES = {
  ok: true,
  text: '槽位表…\n待归位片段：[{"i":0,"where":"Miscellaneous","text":"校学生会宣传部 副部长 2022.09-2023.06"}]',
  bytes: 1234, fragments: 1, blocked: [], endpoint: 'https://api.example.test/v1',
};
const RUN_RES = {
  ok: true,
  accepted: [{ i: 0, path: 'campus.0.org', value: '校学生会宣传部', from: 'Miscellaneous', sourceText: '校学生会宣传部 副部长 2022.09-2023.06' }],
  rejected: [],
};

test('没预览就不给发送；预览之后按钮才亮', async () => {
  const { doc, sent } = bootExtract(() => ({ ...PREVIEW_RES }));
  await load();
  doc.getElementById('mdText').value = MD;
  await click(doc, 'btnImportMd');
  const importDone = sent.some(m => m.type === 'nw:saveProfile');
  assert.ok(importDone, '导入没落到 storage，AI 辅助也就没有报告可用');

  assert.equal(doc.getElementById('btnExtractRun').disabled, true, '未预览就能点发送');
  await click(doc, 'btnExtractRun');
  assert.ok(!sent.some(m => m.type === 'nw:extractRun'), '未预览却发出了请求');

  await click(doc, 'btnExtractPreview');
  assert.equal(doc.getElementById('btnExtractRun').disabled, false, '预览成功后仍不能发送');
  assert.match(doc.getElementById('extractPreviewText').textContent, /将发往：https:\/\/api\.example\.test\/v1/, '预览没显示收件人');
});

test('确认框取消时一个字节都不发；确认后才发，并且发完必须重新预览', async () => {
  let confirmAnswer = false;
  const { doc, sent } = bootExtract(m => (m.type === 'nw:extractRun' ? RUN_RES : { ...PREVIEW_RES }));
  doc.defaultView.confirm = () => confirmAnswer;
  await load();
  doc.getElementById('mdText').value = MD;
  await click(doc, 'btnImportMd');
  await click(doc, 'btnExtractPreview');

  await click(doc, 'btnExtractRun');
  assert.ok(!sent.some(m => m.type === 'nw:extractRun'), '用户点了取消却还是发了');
  assert.match(doc.getElementById('extractStatus').textContent, /已取消/);

  confirmAnswer = true;
  await click(doc, 'btnExtractRun');
  const run = sent.find(m => m.type === 'nw:extractRun');
  assert.ok(run, '确认后没发出请求');
  assert.equal(run.confirm, true, '请求里要带着这次的确认标记，后台只认这个');
  assert.equal(doc.getElementById('btnExtractRun').disabled, true, '发过一次就该重新预览');
});

test('结果默认全勾、点「写入勾选项」才落库，取消勾选的那条不写', async () => {
  const { doc, sent } = bootExtract(m => (m.type === 'nw:extractRun' ? RUN_RES : { ...PREVIEW_RES }));
  doc.defaultView.confirm = () => true;
  await load();
  doc.getElementById('mdText').value = MD;
  await click(doc, 'btnImportMd');
  await click(doc, 'btnExtractPreview');
  await click(doc, 'btnExtractRun');

  const rows = [...doc.getElementById('extractResults').querySelectorAll('input[type=checkbox]')];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset.path, 'campus.0.org');
  assert.equal(rows[0].dataset.value, '校学生会宣传部', '写入值必须是原文逐字段落');
  rows[0].checked = false;
  const applyBtn = doc.getElementById('extractResults').querySelector('button');
  assert.ok(applyBtn, '结果区没有「写入勾选项」按钮');
  applyBtn.click();
  await new Promise(r => setTimeout(r, 40));
  assert.ok(!sent.some(m => m.type === 'nw:saveProfile' && JSON.stringify(m.profile || '').includes('校学生会宣传部')),
    '一条都没勾，不该写库');

  // 重新走一遍并勾选，确认这次真的写进去了
  rows[0].checked = true;
  await click(doc, 'btnExtractPreview');
  await click(doc, 'btnExtractRun');
  doc.getElementById('extractResults').querySelector('button').click();
  await new Promise(r => setTimeout(r, 40));
  const saved = sent.filter(m => m.type === 'nw:saveProfile').pop();
  assert.ok(JSON.stringify(saved?.profile || '').includes('校学生会宣传部'), '勾了却没写入');
});

test('后台拒绝（未配 Key / 没有可发片段 / 只输出思考）时界面说清原因而不是转圈', async () => {
  const cases = [
    ['ai_not_configured', /还没配好/],
    ['no_fragments', /本地解析没有剩余片段/],
    ['reasoning_only', /思考过程/],
    ['not_json', /不是 JSON/],
  ];
  for (const [err, expect] of cases) {
    const { doc } = bootExtract(m => (m.type === 'nw:extractRun' ? { ok: false, error: err } : { ...PREVIEW_RES }));
    doc.defaultView.confirm = () => true;
    await load();
    doc.getElementById('mdText').value = MD;
    await click(doc, 'btnImportMd');
    await click(doc, 'btnExtractPreview');
    await click(doc, 'btnExtractRun');
    const status = doc.getElementById('extractStatus').textContent;
    assert.match(status, expect, `${err} 的提示不像人话：${status}`);
    assert.ok(!/正在请求/.test(status), `${err} 之后还停在"正在请求"`);
    assert.equal(doc.getElementById('extractResults').querySelectorAll('input').length, 0, '失败了却渲染了可写入的清单');
  }
});

test('AI 回了但一条都没逐字命中时，把原始回显摊出来（否则"空输出"永远查不下去）', async () => {
  const { doc } = bootExtract(m => (m.type === 'nw:extractRun'
    ? { ok: true, accepted: [], rejected: [{ i: 0, p: 'work.0.company', v: '字节', reason: 'not_verbatim' }], rawChars: 88, snippet: '[{"i":0,"p":"work.0.company","v":"字节跳动科技有限公司"}]', finishReason: 'stop' }
    : { ...PREVIEW_RES }));
  doc.defaultView.confirm = () => true;
  await load();
  doc.getElementById('mdText').value = MD;
  await click(doc, 'btnImportMd');
  await click(doc, 'btnExtractPreview');
  await click(doc, 'btnExtractRun');
  const box = doc.getElementById('extractPreviewText').textContent;
  assert.match(box, /一条都没通过逐字/);
  assert.match(box, /字节跳动科技有限公司/, '原始回显没摊出来');
  assert.match(box, /not_verbatim/);
});

// 侧边栏的按钮状态只是"好不好用"，真正拦住了的是后台那道闸。
// 这里用源码断言钉住它：以后谁把 confirm 判定删了，测试就红，而不是等到简历出门。
test('后台的按次确认闸是真的：没有 confirm 一律不发，也不用填写侧的自检误拦导入', () => {
  const sw = fs.readFileSync(root('../background/service-worker.js'), 'utf8');
  assert.match(sw, /msg\.type === 'nw:extractPreview' \|\| msg\.type === 'nw:extractRun'/);
  assert.match(sw, /msg\.confirm !== true/, '没带 confirm 也照发，等于"按次确认"是假的');
  assert.match(sw, /not_confirmed/);
  assert.ok(!/assertNoProfileValues\(built\.text/.test(sw), '导入侧本来就允许发简历原文，套用填写侧的取值自检会永远拦死');
  assert.match(sw, /EXTRACT_MAX_BYTES/, '片段总量还得有一道字节上限兜底');
});

test('闸门错误在两条 AI 链路里说同一句话（needs_consent 不能一边说人话一边说 token）', async () => {
  for (const err of ['needs_consent', 'origin_changed', 'origin_mismatch', 'no_endpoint', 'no_key']) {
    const { doc } = bootExtract(m => (m.type === 'nw:extractRun' ? { ok: false, error: err } : { ...PREVIEW_RES }));
    doc.defaultView.confirm = () => true;
    await load();
    doc.getElementById('mdText').value = MD;
    await click(doc, 'btnImportMd');
    await click(doc, 'btnExtractPreview');
    await click(doc, 'btnExtractRun');
    const status = doc.getElementById('extractStatus').textContent;
    assert.ok(!/^调用失败：(needs_consent|origin_changed|origin_mismatch|no_endpoint|no_key)$/.test(status), `${err} 还在直接印 token：${status}`);
    assert.match(status, /勾|重录|Base URL|没保存/, `${err} 的提示没给出下一步：${status}`);
  }
});

// 模型答得慢不是错误：等待期间要看得见"已经等了多久 / 上限多少"，
// 超时的提示必须说清"是多等一会儿还是少问几栏"，而不是"请求超时（20s）"这种没下文的句子。
test('等待中有计时与上限；超时提示给出下一步；「等待上限」输入框能存进设置', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { doc, sent } = bootExtract(async m => {
    if (m.type === 'nw:extractRun') { await gate; return { ok: false, error: 'timeout', waitedSec: 300, detail: '等待 300 秒后中止' }; }
    if (m.type === 'nw:extractPreview') return { ...PREVIEW_RES };
    return { ok: true, profile: {}, settings: { aiTimeoutSec: 300 }, tabId: 1, hasAiKey: true, aiKeyOrigin: 'https://api.example.test', aiKeyLength: 24, aiKeyPersisted: false };
  });
  doc.defaultView.confirm = () => true;
  await load();
  doc.getElementById('mdText').value = MD;
  await click(doc, 'btnImportMd');
  await click(doc, 'btnExtractPreview');
  // gate 必须在 finally 里放行：断言一失败就把后台回包挂着，整轮 node --test 会卡死而不是报错
  try {
    doc.getElementById('btnExtractRun').click();
    await new Promise(r => setTimeout(r, 1200));            // 让它至少跳一次秒
    const during = doc.getElementById('extractStatus').textContent;
    assert.match(during, /已等待 \d+ 秒/, '等待中没有任何进度，用户只能猜是卡住了还是在算');
    assert.match(during, /上限 300 秒/, '没把当前上限说出来');
    assert.ok(sent.some(m => m.type === 'nw:keepAlive'), '没发心跳：MV3 的 worker 会被回收，回包永远不来');
  } finally {
    release();
  }
  await new Promise(r => setTimeout(r, 200));
  const after = doc.getElementById('extractStatus').textContent;
  assert.match(after, /等了 300 秒模型还没答完/, `超时提示没讲清：${after}`);
  assert.match(after, /等待上限/, '没告诉用户下一步是改上限');
  assert.ok(!/已等待/.test(after), '请求已经结束，计时还在跑');

  // 上限输入框：改动要落到设置，非法值要保住原状并说明
  const t = doc.getElementById('aiTimeoutSec');
  t.value = '600';
  t.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  const saved = sent.filter(m => m.type === 'nw:saveSettings').pop();
  assert.equal(saved?.settings?.aiTimeoutSec, 600);
  t.value = '5';
  t.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  assert.match(doc.getElementById('aiTimeoutState').textContent, /最少 15 秒/);
});

// 用户实测报的是"调用失败：http_404 / Not Found"——这种错误光说状态码没用，
// 唯一能让他自己修好的信息就是"我到底把请求发去了哪个地址"。
test('上游回 404：界面必须列出真正请求过的每一个地址，并说清是路径没对上', async () => {
  const FAIL = {
    ok: false, error: 'http_404', detail: 'Not Found',
    // 故意不给 endpoint：只显示"成功那次"的地址不够，404 恰恰没有成功那次
    endpoint: '',
    attempted: [
      { url: 'https://api.example.test/v1/chat/completions/chat/completions', status: 404 },
      { url: 'https://api.example.test/v1/chat/completions', status: 404 },
    ],
  };
  const { doc } = bootExtract(m => (m.type === 'nw:extractRun' ? FAIL : { ...PREVIEW_RES }));
  doc.defaultView.confirm = () => true;
  await load();
  doc.getElementById('mdText').value = MD;
  await click(doc, 'btnImportMd');
  await click(doc, 'btnExtractPreview');
  await click(doc, 'btnExtractRun');
  await new Promise(r => setTimeout(r, 120));
  const status = doc.getElementById('extractStatus').textContent;
  assert.match(status, /404/, `没报出状态码：${status}`);
  assert.match(status, /路径|端点/, '只说了失败，没说这是 Base URL 最后一段路径的问题');
  assert.match(status, /chat\/completions\/chat\/completions/, '没把第一个试过的地址念出来');
  assert.match(status, /https:\/\/api\.example\.test\/v1\/chat\/completions\n/, '没把第二个试过的地址念出来');
  // 详情区同样带上，方便截图报障
  assert.match(doc.getElementById('extractPreviewText').textContent, /实际请求的地址/, '详情区没有地址线索');
  // 上游原文不能重复贴两遍
  const dup = (doc.getElementById('extractPreviewText').textContent.match(/Not Found/g) || []).length;
  assert.equal(dup, 1, `上游原文被念了 ${dup} 遍`);
});

// 填写侧（「问 AI」）与导入侧是同一条错误文本函数，但渲染点有两个：
// 以前只补了一边的"detail 不再拼两遍"，另一边会重复显示 —— 两条链路都要钉。
test('填写侧「问 AI」遇到 404：同一句话、同样带地址、同样不把上游原文念两遍', async () => {
  const BASE = 'https://api.example.test/v1';
  const FAIL = {
    ok: false, error: 'http_404', detail: 'Not Found', endpoint: '',
    attempted: [{ url: BASE + '/chat/completions/chat/completions', status: 404 }],
  };
  const { doc } = bootExtract(msg => {
    if (msg.type === 'nw:scan') {
      return {
        ok: true, adapterId: '', adapterInfo: null,
        data: {
          stats: { scanned: 1, planned: 0, green: 0, review: 0, red: 0, gaps: 1 },
          results: [],
          gaps: [{ index: 0, label: 'Full Name', reason: 'no_candidate', kind: 'text' }],
          aiFields: [{ index: 0, label: 'Full Name' }],
        },
      };
    }
    if (msg.type === 'nw:aiAsk') return FAIL;
    return {
      ok: true, tabId: 1, profile: { basics: {}, education: [], work: [] },
      settings: { aiBaseUrl: BASE, aiModel: 'm', aiConsentOrigin: 'https://api.example.test' },
      hasAiKey: true, aiKeyOrigin: 'https://api.example.test', aiKeyPersisted: false, aiKeyLength: 24,
    };
  });
  await load();
  await click(doc, 'btnPreview');
  assert.equal(doc.getElementById('btnAiAsk').disabled, false, '这条测试的前提是 AI 按钮已解锁');
  await click(doc, 'btnAiAsk');
  await new Promise(r => setTimeout(r, 120));
  const status = doc.getElementById('aiStatus').textContent;
  assert.match(status, /404/);
  assert.match(status, /api\.example\.test\/v1\/chat\/completions\/chat\/completions/, '填写侧没念出请求过的地址');
  const box = doc.getElementById('aiPreviewText').textContent;
  assert.equal((box.match(/Not Found/g) || []).length, 1, '填写侧把上游原文念了两遍');
});

test('上游回 401/429：要分清是 Key 的问题还是额度的问题，别让人去改 Base URL', async () => {
  for (const [code, want] of [['http_401', /Key/], ['http_429', /限流|额度/], ['http_503', /503/]]) {
    const { doc } = bootExtract(m => (m.type === 'nw:extractRun' ? { ok: false, error: code, detail: 'upstream says no' } : { ...PREVIEW_RES }));
    doc.defaultView.confirm = () => true;
    await load();
    doc.getElementById('mdText').value = MD;
    await click(doc, 'btnImportMd');
    await click(doc, 'btnExtractPreview');
    await click(doc, 'btnExtractRun');
    await new Promise(r => setTimeout(r, 120));
    assert.match(doc.getElementById('extractStatus').textContent, want, `${code} 的提示不对味`);
  }
});

// 第二个候选才通 = 用户粘的 Base URL 形状不对。这次填上了，下次还会绕一遍，
// 所以"该怎么写"要顺着成功的那句一起说出来，而不是只在失败时才提。
test('换到第二个候选才成功：界面提示 Base URL 该怎么写', async () => {
  const RES = {
    ...RUN_RES,
    endpoint: 'https://api.example.test/chat/completions',
    attempted: [
      { url: 'https://api.example.test/v1/chat/completions', status: 404 },
      { url: 'https://api.example.test/chat/completions', status: 200 },
    ],
  };
  const { doc } = bootExtract(m => (m.type === 'nw:extractRun' ? RES : { ...PREVIEW_RES }));
  doc.defaultView.confirm = () => true;
  await load();
  doc.getElementById('mdText').value = MD;
  await click(doc, 'btnImportMd');
  await click(doc, 'btnExtractPreview');
  await click(doc, 'btnExtractRun');
  await new Promise(r => setTimeout(r, 140));
  const txt = doc.getElementById('extractResults').textContent;
  assert.match(txt, /第一个地址回了 404/, `成功就没下文了：${txt}`);
  assert.match(txt, /把 Base URL 直接写成 https:\/\/api\.example\.test/, '没告诉用户地址该怎么写');
});

// ── 「测一下连接」与「取消等待」：长时间干等时必须有人话结论和中途出口 ──────
const AI_READY = {
  ok: true, tabId: 1, profile: { basics: {}, education: [], work: [] },
  settings: { aiBaseUrl: 'https://api.example.test/v1', aiModel: 'm', aiConsentOrigin: 'https://api.example.test' },
  hasAiKey: true, aiKeyOrigin: 'https://api.example.test', aiKeyPersisted: false, aiKeyLength: 24,
};

test('自检按钮与「问 AI」同一道闸：没勾确认就不给点（它也要带 Key 出门）', async () => {
  const { doc } = bootExtract(() => ({ ok: true, profile: {}, settings: {}, tabId: 1, hasAiKey: false, aiKeyOrigin: '', aiKeyPersisted: false, aiKeyLength: 0 }));
  await load();
  assert.equal(doc.getElementById('btnAiPing').disabled, true, '未配置/未确认时自检竟然可点');
  const ready = bootExtract(() => AI_READY);
  await load();
  assert.equal(ready.doc.getElementById('btnAiPing').disabled, false, '配置齐全时自检按钮还锁着');
});

test('自检结论要说清下一步：连不上 ≠ Key 错 ≠ 模型慢', async () => {
  const CASES = [
    ['unreachable', /连不上|代理|DNS/, '域名都到不了，还谈什么 Key'],
    ['post_blocked', /POST 被拒|被拦/, '域名通、POST 不通，得说清是后者'],
    ['no_first_byte', /响应字节|没开始回话/, '连上了但对方不回话'],
    ['key_rejected', /Key/, 'Key 被拒要说 Key'],
    ['path_not_found', /端点|路径/, '路径没对上要说路径'],
    ['ok', /通了/, '成功也要说一句'],
  ];
  for (const [verdict, want, why] of CASES) {
    const { doc } = bootExtract(m => (m.type === 'nw:aiPing'
      ? { ok: verdict === 'ok', verdict, endpoint: 'https://api.example.test/v1/chat/completions', origin: 'https://api.example.test', status: verdict === 'key_rejected' ? 401 : verdict === 'path_not_found' ? 404 : null, timing: { upBytes: 90, headersMs: 12, bodyMs: 30, limitMs: 15000 }, originReachable: true, originMs: 8 }
      : AI_READY));
    await load();
    await click(doc, 'btnAiPing');
    await new Promise(r => setTimeout(r, 60));
    const txt = doc.getElementById('aiPingState').textContent;
    assert.match(txt, want, `${verdict} 的结论不合格（${why}）：${txt}`);
    assert.match(txt, /api\.example\.test|连不上|域名/, `${verdict} 没给出地址或域名线索`);
  }
});

test('长时间等待期间「取消等待」是亮的，一结束就灰掉', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { doc } = bootExtract(async m => {
    if (m.type === 'nw:extractRun') { await gate; return { ok: false, error: 'cancelled', detail: '已取消' }; }
    if (m.type === 'nw:extractPreview') return { ...PREVIEW_RES };
    return AI_READY;
  });
  doc.defaultView.confirm = () => true;
  await load();
  doc.getElementById('mdText').value = MD;
  await click(doc, 'btnImportMd');
  await click(doc, 'btnExtractPreview');
  assert.equal(doc.getElementById('btnAiAbort').disabled, true, '没在飞请求时「取消等待」却是亮的');
  doc.getElementById('btnExtractRun').click();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(doc.getElementById('btnAiAbort').disabled, false, '干等的时候没有出口');
  release();
  await new Promise(r => setTimeout(r, 150));
  assert.equal(doc.getElementById('btnAiAbort').disabled, true, '请求结束了按钮还开着');
});
