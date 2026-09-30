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

// ── 连接自检：把"没出门 / 出门被打回 / 出门了在慢慢答"分开 ─────────────────
import { pingAiEndpoint, classifyPing, PING_TEXT, classifyFetchError } from '../core/ai-endpoint.js';

test('自检的正文是写死的 "ping"：不含槽位表、不含页面标签，也就无处带取值', async () => {
  const f = fakeFetch(ok('Pong'));
  const res = await pingAiEndpoint({ baseUrl: 'https://api.x.test/v1', model: 'm', key: KEY, fetchImpl: f });
  assert.equal(res.verdict, 'ok');
  const body = JSON.parse(f.calls[0].body);
  assert.equal(body.messages[0].content, PING_TEXT);
  assert.equal(PING_TEXT, 'ping');
  assert.ok(f.calls[0].body.length < 200, `自检正文 ${f.calls[0].body.length} 字节，不像只发了一个词`);
  assert.match(f.calls[0].url, /^https:\/\/api\.x\.test\/v1\/chat\/completions$/);
});

test('自检带时间线：上行字节数与"多久收到响应头"都要有，没收到时要能看出来', async () => {
  const f = fakeFetch(ok('Pong'));
  const res = await pingAiEndpoint({ baseUrl: 'https://api.x.test/v1', model: 'm', key: KEY, fetchImpl: f });
  assert.ok(res.timing.upBytes > 20, '上行字节数没记');
  assert.equal(typeof res.timing.headersMs, 'number', '收到响应头了却没记耗时');
  const f2 = fakeFetch(http(401, 'invalid api key'));
  const r2 = await pingAiEndpoint({ baseUrl: 'https://api.x.test/v1', model: 'm', key: KEY, fetchImpl: f2 });
  assert.equal(r2.verdict, 'key_rejected');
  assert.match(JSON.stringify(r2.attempted), /401/);
});

test('POST 被网络层拒了但域名连得上 → 判成"POST 被拦"，对照探测不带任何凭据', async () => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (init?.method === 'POST') { const e = new TypeError('Failed to fetch'); throw e; }
    return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
  };
  const res = await pingAiEndpoint({ baseUrl: 'https://api.x.test/v1', model: 'm', key: KEY, fetchImpl: impl });
  assert.equal(res.verdict, 'post_blocked');
  assert.equal(res.originReachable, true);
  assert.equal(calls.length, 2, '该做两次探测（POST + 对照 GET）');
  const get = calls[1];
  assert.equal(get.init.method, 'GET');
  assert.ok(!get.init.headers, '对照探测居然带了头部 —— Key 绝不能跟着自检走到别处');
  assert.equal(new URL(get.url).origin, 'https://api.x.test');
});

test('连 GET 都不通 → 判成"这台机器连不上这个域"，这才是用量为 0 的那种', async () => {
  const impl = async () => { throw new TypeError('Failed to fetch'); };
  const res = await pingAiEndpoint({ baseUrl: 'https://api.x.test/v1', model: 'm', key: KEY, fetchImpl: impl });
  assert.equal(res.verdict, 'unreachable');
  assert.equal(res.originReachable, false);
});

// 判定表是这段代码的全部价值，直接当纯函数测：不靠计时器，也就不会慢、不会飘。
test('自检判定表：同一句"一直在等"要拆得开 —— 连不上 / 没首字节 / 流挂住 / 正文不对 / 被取消', () => {
  const V = classifyPing;
  assert.equal(V({ status: 200 }), 'bad_body');                                 // 200 但正文不可用
  assert.equal(V({ status: 200, error: 'timeout' }), 'streaming_stalled');      // 头到了、正文没写完
  assert.equal(V({ status: 401 }), 'key_rejected');
  assert.equal(V({ status: 403 }), 'key_rejected');
  assert.equal(V({ status: 404 }), 'path_not_found');
  assert.equal(V({ status: 429 }), 'rate_limited');
  assert.equal(V({ status: 503 }), 'upstream_error');
  assert.equal(V({ status: 418 }), 'http_error');
  assert.equal(V({ error: 'timeout', headersMs: null, originReachable: true }), 'no_first_byte');
  assert.equal(V({ error: 'timeout', headersMs: 12, originReachable: true }), 'streaming_stalled');
  assert.equal(V({ error: 'timeout', headersMs: null, originReachable: false }), 'unreachable');
  assert.equal(V({ error: 'fetch_failed', originReachable: true }), 'post_blocked');
  assert.equal(V({ error: 'fetch_failed', originReachable: false }), 'unreachable');
  assert.equal(V({ error: 'redirect_blocked' }), 'redirect_blocked');
  assert.equal(V({ error: 'cancelled' }), 'cancelled');
  assert.equal(V({ error: 'upstream_model_not_found' }), 'upstream_error');
});

test('取消不是超时：外部信号一中止就报 cancelled，并且不再发下一个候选', async () => {
  const ctrl = new AbortController();
  const calls = [];
  const impl = (url, init) => {
    calls.push(url);
    return new Promise((_resolve, reject) => {
      const sig = init?.signal;
      sig?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
  };
  const p = callChatEndpoint({ baseUrl: 'https://api.x.test/gateway', model: 'm', key: KEY, text: 'q', timeoutSec: 60, fetchImpl: impl, signal: ctrl.signal });
  await new Promise(r => setTimeout(r, 10));
  ctrl.abort();
  const res = await p;
  assert.equal(res.error, 'cancelled');
  assert.equal(res.timing.cancelled, true);
  assert.equal(calls.length, 1, '取消后又去发第二个候选了');

  // 一开始就已经取消：一个字节都不发
  const dead = new AbortController(); dead.abort();
  const r2 = await callChatEndpoint({ baseUrl: 'https://api.x.test/gateway', model: 'm', key: KEY, text: 'q', fetchImpl: impl, signal: dead.signal });
  assert.equal(r2.error, 'cancelled');
});

test('网络层错误的分类：redirect 单独一类（它意味着 Key 会跟到别的域）', () => {
  assert.equal(classifyFetchError(new TypeError('Failed to fetch')).error, 'fetch_failed');
  assert.equal(classifyFetchError(Object.assign(new Error('manual redirect'), { name: 'ResponseError' })).error, 'redirect_blocked');
  const e = new Error('x'); e.name = 'AbortError';
  assert.equal(classifyFetchError(e).error, 'timeout');
});

// ── 自检的 max_tokens：这条是 2026-09-30 那次误判的回归 ──────────────────────
// 第一版自检沿用了真请求的 max_tokens=2000，reasoning 模型光思考就超过 15 秒，
// 于是"对端在慢慢想"被自检误报成"没回话"。自检要的是"通不通"，不是"想多久"。

test('自检那一发带的是 max_tokens:1；真请求带的是设置里的上限', async () => {
  const f = fakeFetch(ok('Pong'));
  await pingAiEndpoint({ baseUrl: 'https://api.x.test/v1', model: 'm', key: KEY, fetchImpl: f });
  assert.equal(JSON.parse(f.calls[0].body).max_tokens, 1, '自检不该给模型留思考的余地');
  assert.ok(!('stream' in JSON.parse(f.calls[0].body)), '第一发不该开流式：那会改变响应形状');

  const g = fakeFetch(ok('[]'));
  await callChatEndpoint({ baseUrl: 'https://api.x.test/v1', model: 'm', key: KEY, text: 'q', maxTokens: 6000, fetchImpl: g });
  assert.equal(JSON.parse(g.calls[0].body).max_tokens, 6000, '真请求没按设置给长度上限');
});

test('域名通、非流式沉默时：再用流式摸一次第一个字节，据此分开"慢"和"不通"', async () => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body || '{}') });
    if (init?.method !== 'POST') return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    if (init.body.includes('"stream":true')) {
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array([1]) }), cancel: async () => {} }) } };
    }
    // 非流式那一发：一直沉默
    return new Promise((_r, reject) => init.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    }));
  };
  const res = await pingAiEndpoint({ baseUrl: 'https://api.x.test/v1', model: 'm', key: KEY, fetchImpl: impl, timeoutSec: 2 });
  assert.equal(res.verdict, 'holding_response', JSON.stringify(res));
  assert.ok(res.firstChunkMs != null, '流式那一发没记第一个字节的耗时');
  const posts = calls.filter(c => c.init?.method === 'POST');
  assert.equal(posts.length, 2, '该先非流式、再流式各一发');
  assert.equal(posts[1].body.stream, true, '第二发没开流式');
  assert.equal(posts[1].body.max_tokens, 1);
});

test('流式也摸不到字节 → 判 no_first_byte（这才轮到"对端没回话"）', async () => {
  const impl = async (url, init) => {
    if (init?.method !== 'POST') return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    return new Promise((_r, reject) => init.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    }));
  };
  const res = await pingAiEndpoint({ baseUrl: 'https://api.x.test/v1', model: 'm', key: KEY, fetchImpl: impl, timeoutSec: 2 });
  assert.equal(res.verdict, 'no_first_byte', JSON.stringify(res));
  assert.equal(res.firstChunkMs, null);
});

test('被直接拒掉的 POST（fetch_failed）不再做流式二次探测：那不是"慢"', async () => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(init?.method);
    if (init?.method === 'POST') throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
  };
  const res = await pingAiEndpoint({ baseUrl: 'https://api.x.test/v1', model: 'm', key: KEY, fetchImpl: impl, timeoutSec: 2 });
  assert.equal(res.verdict, 'post_blocked');
  assert.deepEqual(calls, ['POST', 'GET'], '被拒的情况不该再补一发流式');
});
