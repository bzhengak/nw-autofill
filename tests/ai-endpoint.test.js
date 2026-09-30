// AI 出网那一段的回归：端点形状、重试边界、脱敏。
// 这段代码从 background/service-worker.js 挪进 core/ai-endpoint.js 就是为了能在这里跑 ——
// 2026-09-30 用户实测 "http_404 Not Found"，硬拼 base+'/chat/completions' 在两种粘贴写法下都会 404，
// 而在 service worker 里这种错只能靠人在浏览器里试。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callChatEndpoint } from '../core/ai-endpoint.js';
import { chatEndpointCandidates, shouldRetryNextEndpoint } from '../core/ai-security.js';

const KEY = 'sk-ABCDEFGHIJ0123456789';

/** 假上游：按顺序回这些结果，并记下每次请求的 URL / header / body */
function fakeFetch(...replies) {
  const calls = [];
  const impl = async (url, init) => {
    const i = calls.length;
    calls.push({ url, headers: init?.headers, body: init?.body, redirect: init?.redirect, signal: init?.signal });
    const r = replies[i] ?? replies.at(-1);
    if (typeof r === 'function') return r(url, init);
    if (r instanceof Error) throw r;
    return r;
  };
  impl.calls = calls;
  return impl;
}

const ok = content => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
  text: async () => '',
});
const http = (status, body = '') => ({
  ok: false, status,
  text: async () => body,
  json: async () => { throw new Error('not json'); },
});

test('粘的就是完整端点：原样 POST，绝不再拼一段 /chat/completions（这就是那次 404）', () => {
  const c = chatEndpointCandidates('https://api.x.test/v1/chat/completions');
  assert.deepEqual(c.candidates, ['https://api.x.test/v1/chat/completions']);
  assert.ok(!/chat\/completions\/chat\/completions/.test(c.endpoint), '出现了重复拼接');
});

test('各种粘贴写法都能收敛到候选，且候选永远同域', () => {
  const cases = [
    ['https://api.x.test/v1', ['https://api.x.test/v1/chat/completions']],
    ['https://api.x.test/v1/', ['https://api.x.test/v1/chat/completions']],
    ['https://api.x.test', ['https://api.x.test/v1/chat/completions', 'https://api.x.test/chat/completions']],
    ['https://api.x.test/compatible-mode', ['https://api.x.test/compatible-mode/chat/completions', 'https://api.x.test/compatible-mode/v1/chat/completions']],
    ['https://api.x.test/v1/responses', ['https://api.x.test/v1/responses', 'https://api.x.test/v1/chat/completions']],
    ['http://localhost:11434/v1', ['http://localhost:11434/v1/chat/completions']],
    ['https://api.x.test:8443/v1beta', ['https://api.x.test:8443/v1beta/chat/completions']],
  ];
  for (const [input, want] of cases) {
    const got = chatEndpointCandidates(input);
    assert.deepEqual(got.candidates, want, input);
    for (const u of got.candidates) assert.equal(new URL(u).origin, new URL(input).origin, `${input} 的候选跳域了`);
  }
  for (const bad of ['', 'not a url', 'ftp://x.test/v1', 'https://u:p@x.test/v1', 'https://x.test/v1?k=1']) {
    assert.equal(chatEndpointCandidates(bad).ok, false, `非法 Base URL 该被拒：${bad}`);
  }
});

test('只 404/405 才值得再发一次：401/429/5xx 一律不重发', () => {
  assert.equal(shouldRetryNextEndpoint(404), true);
  assert.equal(shouldRetryNextEndpoint(405), true);
  for (const s of [400, 401, 403, 429, 500, 503]) assert.equal(shouldRetryNextEndpoint(s), false, `${s} 不该重发`);
});

// 收件人必须是同一个域：Key 与 origin 绑定这条规则的前提就是"我们不会自己把请求搬到别的域"。
// 这些输入里塞着看起来像别的主机名的东西，它们只能是路径。
test('Base URL 里塞进任何主机名样子的东西，候选仍全部同域', () => {
  for (const input of [
    'https://api.x.test//evil.test/v1',
    'https://api.x.test/@evil.test',
    'https://api.x.test/https:/evil.test',
    'https://api.x.test:8443/../evil.test',
  ]) {
    const c = chatEndpointCandidates(input);
    assert.equal(c.ok, true, input);
    assert.ok(c.candidates.length >= 1, input);
    for (const u of c.candidates) {
      assert.equal(new URL(u).origin, new URL(input).origin, `${input} → ${u} 跳域了`);
    }
  }
});

test('路径没对上：顺延到下一个候选，成功那次才是界面上显示的地址', async () => {
  const f = fakeFetch(http(404, 'Not Found'), ok('[{"i":0,"p":"basics.name"}]'));
  const res = await callChatEndpoint({
    baseUrl: 'https://api.x.test/gateway', model: 'm', key: KEY, text: 'q', timeoutSec: 30, fetchImpl: f,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(f.calls.map(c => c.url), [
    'https://api.x.test/gateway/chat/completions',
    'https://api.x.test/gateway/v1/chat/completions',
  ], '第一次 404 后没有顺延，或顺序不对');
  assert.equal(res.endpoint, 'https://api.x.test/gateway/v1/chat/completions');
  assert.equal(res.attempted.length, 2);
  assert.equal(res.attempted[0].status, 404);
});

test('401 只发一次：不能因为"再试一个路径"就多敲一遍错误状态下的 Key', async () => {
  const f = fakeFetch(http(401, 'invalid api key'));
  const res = await callChatEndpoint({ baseUrl: 'https://api.x.test/gateway', model: 'm', key: KEY, text: 'q', timeoutSec: 30, fetchImpl: f });
  assert.equal(f.calls.length, 1, '非 404 也重发了');
  assert.equal(res.error, 'http_401');
  assert.match(res.detail, /invalid api key/);
});

test('两个候选都 404：错误里要带着试过的每一个地址，否则用户无从对照 Base URL', async () => {
  const f = fakeFetch(http(404, 'Not Found'), http(404, 'Not Found'));
  const res = await callChatEndpoint({ baseUrl: 'https://api.x.test/gateway', model: 'm', key: KEY, text: 'q', timeoutSec: 30, fetchImpl: f });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'http_404');
  assert.deepEqual(res.attempted.map(a => a.url), [
    'https://api.x.test/gateway/chat/completions',
    'https://api.x.test/gateway/v1/chat/completions',
  ]);
  assert.match(res.detail, /Not Found/);
});

test('请求形状没被重构弄丢：Bearer Key、禁跟跳转、temperature 0、messages 结构', async () => {
  const f = fakeFetch(ok('[]'));
  await callChatEndpoint({ baseUrl: 'https://api.x.test/v1', model: 'glm-4', key: KEY, text: 'PROMPT', timeoutSec: 30, fetchImpl: f });
  const call = f.calls[0];
  assert.equal(call.headers.authorization, 'Bearer ' + KEY);
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.redirect, 'error', '关掉 redirect 就是把 Key 交给一次 302');
  const body = JSON.parse(call.body);
  assert.equal(body.model, 'glm-4');
  assert.equal(body.temperature, 0);
  assert.equal(body.messages[0].content, 'PROMPT');
  assert.ok(body.max_tokens >= 1000, 'max_tokens 又回落到 800 会把答案截断成"空输出"');
});

test('超时不重发，并把等了多久带回去', async () => {
  const abort = new Error('The operation was aborted.');
  abort.name = 'AbortError';
  const f = fakeFetch(abort, ok('[]'));
  const res = await callChatEndpoint({ baseUrl: 'https://api.x.test/gateway', model: 'm', key: KEY, text: 'q', timeoutSec: 1, fetchImpl: f });
  assert.equal(res.error, 'timeout');
  assert.equal(f.calls.length, 1, '超时又发一次 = 等待时间翻倍');
  assert.ok(res.waitedSec >= 1);
});

test('假上游把 Key 印进正文/错误体里：会进界面的那几个字段必须干净', async () => {
  const leaky = fakeFetch(http(404, `Not Found (key ${KEY} not allowed)`), ok(`echo ${KEY}`));
  const res = await callChatEndpoint({ baseUrl: 'https://api.x.test/gateway', model: 'm', key: KEY, text: 'q', timeoutSec: 30, fetchImpl: leaky });
  assert.equal(res.ok, true);
  // content 只在 service worker 里被解析成路径候选，永不进回包（另一条静态断言守着）；
  // 其余字段都会显示在界面上，必须逐个查。
  const uiFacing = { snippet: res.snippet, detail: res.detail, error: res.error, endpoint: res.endpoint, attempted: res.attempted };
  assert.ok(!JSON.stringify(uiFacing).includes(KEY), `界面字段里漏出了 Key：${JSON.stringify(uiFacing).slice(0, 200)}`);
  assert.match(res.snippet, /REDACTED/, '正文里的 Key 应该被脱敏而不是原样带回');

  const both = fakeFetch(http(404, `bad ${KEY}`), http(404, `bad ${KEY}`));
  const fail = await callChatEndpoint({ baseUrl: 'https://api.x.test/gateway', model: 'm', key: KEY, text: 'q', timeoutSec: 30, fetchImpl: both });
  const failUi = { error: fail.error, detail: fail.detail, endpoint: fail.endpoint, attempted: fail.attempted };
  assert.ok(!JSON.stringify(failUi).includes(KEY), '失败路径把 Key 带进了界面');
});

test('Base URL 不合法时一个字节都不发', async () => {
  const f = fakeFetch(ok('[]'));
  const res = await callChatEndpoint({ baseUrl: 'https://x.test/v1?token=1', model: 'm', key: KEY, text: 'q', fetchImpl: f });
  assert.equal(res.ok, false);
  assert.match(res.error, /^endpoint_/);
  assert.equal(f.calls.length, 0);
});
