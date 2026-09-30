// AI 出网的唯一一段代码：构造 URL、发一次（或顺延一次）、把上游响应收成统一形状。
//
// 从 background/service-worker.js 挪到这里来，只有一个原因：**这段逻辑必须能离线测**。
// 2026-09-30 用户实测报 "http_404 Not Found"，硬拼 `base + '/chat/completions'` 在
// "粘了完整端点"和"只粘了主机名"两种写法下都会 404，而这类形状错错得极安静 ——
// 留在 service worker 里就只能靠人在浏览器里试，挪到这里就能用假 fetch 钉住。
//
// 安全边界（与 core/ai-security.js 里的规则配合，本文件不放宽任何一条）：
// - 候选端点全部同源（chatEndpointCandidates 内已断言），Key 不会跟着跳到别的域；
// - 只有 404/405 才顺延下一个候选，401/403/429/5xx/超时一律只发一次；
// - redirect:'error' 保留：被 302 到别的域时直接失败，不让 fetch 带着 Authorization 跟走；
// - 上游错误体先过 redact 再返回，回显里不可能带出 Key。

import { chatEndpointCandidates, redact, shouldRetryNextEndpoint, AI_MAX_TOKENS_DEFAULT } from './ai-security.js';
import { interpretAiReply } from './ai.js';

const MAX_BYTES_BODY = 200_000;   // 上游回的东西不该很大；只是防御性上限，不参与业务判断
const MAX_CHARS_STREAM = 200_000; // 流式累计正文的硬上限：超了说明上游在刷屏或我们把它接错了

/**
 * 读第一个字节就撤。返回毫秒（相对**请求发出那一刻**，不是相对响应头 —— 相对响应头会算出
 * "0ms 就收到第一个字节"这种听起来很厉害其实什么都没说的话）。读不到返回 null。
 * 只看不留：内容不回传、不解析，所以自检的流式探测连"模型说了什么"都不知道。
 */
async function peekFirstChunk(res, ctrl, startedAt) {
  let reader = null;
  try {
    reader = res.body?.getReader?.() || null;
    if (!reader) return null;
    const first = await Promise.race([
      reader.read(),
      new Promise(resolve => setTimeout(() => resolve(null), Math.max(200, timingRemaining(ctrl) || 200))),
    ]);
    return first ? Math.round(nowMs() - startedAt) : null;
  } catch {
    return null;
  } finally {
    try { await reader?.cancel?.(); } catch { /* 已经关掉了 */ }
    try { ctrl.abort(); } catch { /* 同上 */ }
  }
}

/**
 * 收 SSE：把 `data: {...}` 里的 delta 拼成一份完整正文，再交给和平时同一个 interpretAiReply 判定。
 *
 * 为什么要能收流：**非流式响应在整段答案生成完成之前一个字节都不发**。
 * 于是"对端在慢慢想"和"路径根本不通"在界面上长得一模一样 —— 2026-09-30 实测就是
 * 非流式 15 秒零字节、改流式立刻开始回话。流式还顺带给了两个以前没有的事实：
 * 第一个字节的耗时，以及中途被中止时"已经收到多少字"。
 *
 * 只认 OpenAI 兼容的形状（choices[0].delta.content / reasoning_content + [DONE]）；
 * 半行留在 buffer 里等下一块，解析不动的行直接跳过 —— 上游加字段不该让填写失败。
 */
async function readSse(res, ctrl, { startedAt, key }) {
  const out = { ok: false, content: '', reasoning: '', finishReason: null, firstChunkMs: null, charsAtAbort: 0 };
  let reader = null;
  try {
    reader = res.body?.getReader?.() || null;
    if (!reader) { out.error = 'no_stream_body'; return out; }
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (out.firstChunkMs == null) out.firstChunkMs = Math.round(nowMs() - startedAt);
      buf += dec.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let j = null;
        try { j = JSON.parse(payload); } catch { continue; }        // 半行或上游自己的注释
        if (j?.error) {
          out.error = 'upstream_' + String(j.error.code || j.error.type || 'error');
          out.detail = redact(String(j.error.message || '').slice(0, 300), key);
          return out;
        }
        const delta = j?.choices?.[0]?.delta || j?.choices?.[0]?.message || {};
        if (delta.content) out.content += String(delta.content);
        if (delta.reasoning_content) out.reasoning += String(delta.reasoning_content);
        if (j?.choices?.[0]?.finish_reason) out.finishReason = j.choices[0].finish_reason;
        if (out.content.length + out.reasoning.length > MAX_CHARS_STREAM) {
          out.error = 'stream_too_large';
          return out;
        }
      }
    }
    out.ok = true;
    return out;
  } catch (err) {
    // 中途被时限/用户中止：把"已经收到多少字"带回去，这比"超时了"有用得多
    out.charsAtAbort = out.content.length + out.reasoning.length;
    out.error = String(err?.name || '') === 'AbortError' ? 'aborted_mid_stream' : 'stream_read_failed';
    return out;
  } finally {
    try { await reader?.cancel?.(); } catch { /* 已结束 */ }
  }
}

/** 探测用的剩余预算：AbortController 没有公开"还剩多久"，这里由调用方挂在对象上 */
function timingRemaining(ctrl) {
  return ctrl?.__nwDeadline ? Math.max(200, ctrl.__nwDeadline - nowMs()) : 3000;
}

/** 自检请求的固定正文：写死在这里，不拼任何页面文字或资料 —— 它能漏出去的东西只有"ping"这个词。 */
export const PING_TEXT = 'ping';

/** 一次请求的时间线：用来把"连不上"和"连上了但模型没答完"分开 —— 这两件事的修法完全不同。 */
function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

/**
 * fetch 被拒绝时的分类。浏览器在这里非常含糊（一律 TypeError: Failed to fetch），
 * 所以判定要靠"同一时间做一次不带凭据的 GET"来对照，见 pingAiEndpoint。
 */
export function classifyFetchError(err) {
  const name = String(err?.name || '');
  const msg = String(err?.message || '');
  if (name === 'AbortError') return { error: 'timeout', errName: name };
  if (/redirect/i.test(msg) || name === 'ResponseRedirectedError') return { error: 'redirect_blocked', errName: name };
  return { error: 'fetch_failed', errName: name || 'Error' };
}

/**
 * 流式那一发失败后，哪些情况值得**退回普通收法**再试一次。
 * 只列"这条响应方式本身不被接受"的形状：400/422（很多兼容层对 stream 的处理不一样）、
 * 拿不到 body 流、SSE 读不动、200 但正文不是响应。
 * 401/403/404/429/5xx 与超时都不在列 —— 那些换成非流式一样会失败，多打一发只是浪费额度。
 */
export function shouldRetryWithoutStream(res) {
  if (!res || res.ok) return false;
  const code = Number(res.status);
  if (code === 400 || code === 422) return true;
  // empty_content 也在列：有些兼容层收了 stream 参数却仍按普通 JSON 回，
  // 这时 SSE 解析一行都认不出来，看起来就是"200 但正文为空"
  return ['no_stream_body', 'stream_read_failed', 'bad_body', 'not_json', 'empty_content'].includes(res.error);
}

/**
 * @param {object} p
 * @param {(url: string, init: object) => Promise<any>} [p.fetchImpl] 注入点是给测试用的；运行时用全局 fetch
 * @returns {Promise<object>} 成功 { ok:true, content, finishReason, rawChars, snippet, endpoint, attempted }
 *                            失败 { ok:false, error, detail?, status?, endpoint, attempted }
 */
export async function callChatEndpoint(opts) {
  const run = stream => callChatOnce({ ...opts, stream });
  const first = await run(opts.stream);
  if (opts.stream === true && !first.ok && shouldRetryWithoutStream(first)) {
    const again = await run(false);
    // 退回成功了也要留痕：界面得说清"这次是换了收法才通的"，不然下次还以为流式没事
    if (again.ok) return { ...again, streamFallback: true, firstTry: { error: first.error, status: first.status ?? null } };
    return { ...again, streamFallback: true };
  }
  return first;
}

async function callChatOnce({ baseUrl, model, key, text, timeoutSec = 180, maxTokens, stream = false, fetchImpl, signal }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const cand = chatEndpointCandidates(baseUrl);
  if (!cand.ok || !cand.candidates.length) {
    return { ok: false, error: 'endpoint_' + (cand.error || 'empty'), endpoint: '', attempted: [] };
  }
  const limitMs = Math.max(1000, (Number(timeoutSec) > 0 ? Number(timeoutSec) : 180) * 1000);
  const deadline = Date.now() + limitMs;            // 总预算，不是一试 180 秒再试又一次
  const attempted = [];
  let last = null;

  for (const url of cand.candidates) {
    const left = deadline - Date.now();
    if (last && left < 1000) {                      // 预算见底：把上一次的失败原样交回去，不再发
      return { ...last, endpoint: attempted.at(-1)?.url || '', attempted };
    }
    if (signal?.aborted) {                          // 用户点了「取消等待」：不再发下一个候选
      return { ok: false, error: 'cancelled', endpoint: url, attempted, detail: '已取消，没有再发下一个地址' };
    }
    const res = await oneCall({ doFetch, url, model, key, text, timeoutMs: left, outerSignal: signal, maxTokens, stream });
    attempted.push({ url, status: res.status ?? null, error: res.error || '' });
    if (res.ok) return { ...res, endpoint: url, attempted };
    if (res.error === 'cancelled') return { ...res, endpoint: url, attempted };
    if (!shouldRetryNextEndpoint(res.status)) return { ...res, endpoint: url, attempted };
    last = res;
  }
  return { ...(last || { ok: false, error: 'network_error' }), endpoint: attempted.at(-1)?.url || '', attempted };
}

async function oneCall({ doFetch, url, model, key, text, timeoutMs, outerSignal, maxTokens, stream }) {
  const ctrl = new AbortController();
  const t0 = nowMs();
  // 外部信号 = 用户点「取消等待」。与内部超时分开：一个是"我不等了"，一个是"它没答完"，
  // 混成一条的话界面会把取消说成超时。
  let byUser = false;
  const onOuterAbort = () => { byUser = true; ctrl.abort(); };
  if (outerSignal) {
    if (outerSignal.aborted) onOuterAbort();
    else outerSignal.addEventListener?.('abort', onOuterAbort, { once: true });
  }
  const watch = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  ctrl.__nwDeadline = t0 + Math.max(1000, timeoutMs);   // peekFirstChunk 用它算剩余预算
  // 时间线是给"用量为 0 却一直在等"这种问题准备的：没有它，用户只能猜请求出没出去
  const timing = { upBytes: 0, headersMs: null, bodyMs: null, aborted: false, cancelled: false, limitMs: Math.max(1000, timeoutMs) };
  try {
    const bodyJson = JSON.stringify({
      model,
      temperature: 0,
      // 长度上限由设置决定（默认 4000）：reasoning 模型把思考链也算进 max_tokens，
      // 老实现写死 2000，几十个缺口的 JSON 回答几乎必然被砍断 → 表现成"AI 没建议"。
      max_tokens: Number(maxTokens) > 0 ? Number(maxTokens) : AI_MAX_TOKENS_DEFAULT,
      // stream：false=普通收法；true=边收边拼（真请求可开）；'peek'=只摸第一个字节就撤（自检用）
      ...(stream ? { stream: true } : {}),
      messages: [{ role: 'user', content: text }],
    });
    timing.upBytes = new TextEncoder().encode(bodyJson).length;
    const res = await doFetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      signal: ctrl.signal,
      body: bodyJson,
    });
    timing.headersMs = Math.round(nowMs() - t0);
    // 先判状态码：开了流式之后，上游拒绝（400/401/404…）仍是一个普通 JSON 响应，
    // 不能因为"开了流式"就去摸字节 —— 摸到的会是那段错误正文。
    if (!res.ok) {
      const bodyText = String(await res.text().catch(() => '')).slice(0, MAX_BYTES_BODY);
      timing.bodyMs = Math.round(nowMs() - t0);
      // 上游错误体常带模型名/额度信息，对用户有用；也可能回显请求内容，一律先过 redact
      return { ok: false, status: res.status, error: `http_${res.status}`, detail: redact(bodyText.slice(0, 300), key), timing };
    }
    if (stream === 'peek') {
      // 自检只看"第一个字节什么时候到"，看到就撤：不等它写完，也不把内容带回来
      const chunkMs = await peekFirstChunk(res, ctrl, t0);
      timing.firstChunkMs = chunkMs;
      return {
        ok: chunkMs != null, status: res.status,
        error: chunkMs == null ? 'no_first_byte' : 'stream_ok', timing, streamPeek: true,
      };
    }
    if (stream === true) {
      const s = await readSse(res, ctrl, { startedAt: t0, key });
      timing.firstChunkMs = s.firstChunkMs;
      timing.bodyMs = Math.round(nowMs() - t0);
      if (!s.ok) {
        return {
          ok: false, status: res.status,
          error: s.error === 'aborted_mid_stream' ? (byUser ? 'cancelled' : 'timeout') : (s.error || 'stream_read_failed'),
          detail: s.error === 'aborted_mid_stream'
            ? `流式已经开始回话（第一个字节 ${s.firstChunkMs}ms），但没写完就被中止：那时已收到 ${s.charsAtAbort} 字`
            : redact(String(s.detail || s.error || ''), key),
          firstChunkMs: s.firstChunkMs, timing,
        };
      }
      // 拼好的正文交给与非流式**同一个**判定函数：空正文/只有思考/截断这些结论不能因为换了收法就分叉
      const json = { choices: [{ message: { content: s.content, reasoning_content: s.reasoning }, finish_reason: s.finishReason }] };
      const got = interpretAiReply(json);
      if (!got.ok) {
        return {
          ok: false, status: res.status, error: got.error,
          detail: redact(got.detail || '', key), finishReason: got.finishReason,
          reasoningChars: got.reasoningChars, firstChunkMs: s.firstChunkMs, timing,
        };
      }
      return {
        ok: true, status: res.status,
        content: got.content,
        finishReason: got.finishReason,
        rawChars: got.rawChars,
        snippet: redact(got.snippet, key),
        firstChunkMs: s.firstChunkMs,
        timing,
      };
    }
    const json = await res.json().catch(() => null);
    timing.bodyMs = Math.round(nowMs() - t0);
    if (json?.error) {
      return {
        ok: false, status: res.status,
        error: 'upstream_' + String(json.error.code || json.error.type || 'error'),
        detail: redact(String(json.error.message || '').slice(0, 300), key), timing,
      };
    }
    // 正文/思考/截断的判定全在 core/ai.js 的纯函数里（那才是"空输出"最容易出事的环节）
    const got = interpretAiReply(json);
    if (!got.ok) {
      return {
        ok: false, status: res.status, error: got.error,
        detail: redact(got.detail || '', key), finishReason: got.finishReason, reasoningChars: got.reasoningChars, timing,
      };
    }
    return {
      ok: true, status: res.status,
      content: got.content,
      finishReason: got.finishReason,
      rawChars: got.rawChars,
      // 回显兜底：上游要是把 Key 印进正文里（见过这种代理），也不能带进界面
      snippet: redact(got.snippet, key),
      timing,
    };
  } catch (err) {
    timing.aborted = String(err?.name || '') === 'AbortError';
    // 「取消」不能报成「超时」：前者是你不干了，后者是服务端没答完，两句结论完全不同
    if (byUser) {
      timing.cancelled = true;
      return { ok: false, error: 'cancelled', timing, detail: '你点了「取消等待」，请求已中止（没再发下一个地址）' };
    }
    const kind = classifyFetchError(err);
    if (kind.error === 'timeout') {
      const sec = Math.round(timing.limitMs / 1000);
      // 关键区分：等了这么久，**收到响应头没有**？没收到 = 服务端连开始回包都没有
      return { ok: false, error: 'timeout', waitedSec: sec, timing, detail: timing.headersMs == null
        ? `等了 ${sec} 秒，连响应头都没回来。注意：非流式响应要等整段答案生成完才开始发字节，`
          + 'reasoning 模型的思考链也算在答案里，所以这一段可能只是"它在想"'
        : `等了 ${sec} 秒，响应头 ${timing.headersMs}ms 就到了，但正文一直没写完` };
    }
    // 错误文本可能带上请求 URL 甚至 Header，一律脱敏后再返回
    return { ok: false, error: kind.error, errName: kind.errName, timing,
      detail: redact(String(err?.message || 'network_error'), key) };
  } finally { clearTimeout(watch); }
}

/**
 * 自检结论的判定表。单独抽成纯函数，是因为"该判成哪一种"就是这段代码的全部价值，
 * 而它不该只能靠造计时器、造 abort 才测得到（那类测试慢、脆，而且一红分不清判定错还是计时错）。
 *
 * @param {object} x
 * @param {number|string|null} x.status         非流式那一发拿到的 HTTP 状态（没有就是 null）
 * @param {string} x.error                      错误码（timeout / fetch_failed / cancelled / upstream_xxx）
 * @param {number|null} x.headersMs             响应头耗时
 * @param {boolean} [x.originReachable]         对照 GET 通不通（没探测时 undefined）
 * @param {number|null|undefined} x.firstChunkMs 流式探测第一个字节的耗时；undefined = 没做过这次探测
 */
export function classifyPing({ status, error, headersMs, originReachable, firstChunkMs }) {
  const code = Number(status);
  if (Number.isFinite(code)) {
    if (code === 401 || code === 403) return 'key_rejected';
    if (code === 404 || code === 405) return 'path_not_found';
    if (code === 429) return 'rate_limited';
    if (code >= 500) return 'upstream_error';
    // 200 却没拿到能用的正文：既不是"连不上"也不是"被打回"，别混进 POST 被拦那一类
    if (code === 200 || code === 201) return error === 'timeout' ? 'streaming_stalled' : 'bad_body';
    return 'http_error';
  }
  if (/^upstream_/.test(String(error || ''))) return 'upstream_error';
  if (error === 'redirect_blocked') return 'redirect_blocked';
  if (error === 'cancelled') return 'cancelled';
  if (originReachable === false) return 'unreachable';          // GET 都不通：这台机器到不了那个域
  if (error === 'timeout') {
    // 只有"沉默到超时"才值得分辨慢/不通；直接被拒（fetch_failed）走下面的 POST 被拦
    if (firstChunkMs != null) return 'holding_response';        // 流式摸到了字节：路通，非流式要等整段生成
    if (firstChunkMs === null) return 'no_first_byte';          // 流式也摸不到：对端确实没回话
    return headersMs == null ? 'no_first_byte' : 'streaming_stalled';
  }
  return 'post_blocked';                                        // 域名通、POST 被拒：代理/防火墙/CORS 预检
}

/**
 * 连接自检：用固定正文、不含任何用户数据的请求，回答"到底有没有出这台机器"。
 *
 * 存在的理由：用户报"等了 300 秒、后台用量是 0"时，这一句至少对应五种病（没出门 / 出门被拦 /
 * Key 被拒 / 路径不对 / 对方在慢慢生成），而"用量为 0"区分不了它们 —— 被拒的调用多数服务商压根不记。
 * 所以这里做的是把它们拆开，不是再把超时拉长。
 *
 * 三发，按需才发：
 *  1. 与真请求同一条 callChatEndpoint（同样候选、同样头部、同样确认闸），正文写死 `PING_TEXT`，
 *     **长度上限给 1 token**：一个词的请求没有"模型还在想"的借口，还不回状态就是路径/网络的问题。
 *     （第一版沿用了真请求的 2000 token，reasoning 模型光思考就超过 15 秒，
 *      自检把"它在想"误报成了"对端没回话" —— 2026-09-30 用户实测就是这个形状。）
 *  2. 只在"一个 HTTP 状态都没拿到"时，做一次不带任何头部与凭据的 GET（同一 origin 根路径），
 *     把"域名连不上"和"能连上但 POST 被拦"分开。
 *  3. 域名通、而第 1 发仍没状态时，再用 `stream:true` + 1 token 摸一次第一个字节：
 *     非流式响应要等整段答案生成完才发第一个字节，光凭第 1 发分不清"慢"和"不通"。
 */
export async function pingAiEndpoint({ baseUrl, model, key, fetchImpl, timeoutSec = 15, signal }) {
  const cand = chatEndpointCandidates(baseUrl);
  if (!cand.ok || !cand.candidates.length) {
    return { ok: false, verdict: 'bad_endpoint', detail: 'endpoint_' + (cand.error || 'empty'), endpoint: '' };
  }
  const sec = Math.min(30, Math.max(1, Number(timeoutSec) > 0 ? Number(timeoutSec) : 15));
  const doFetch = fetchImpl || globalThis.fetch;
  const post = await callChatEndpoint({
    baseUrl, model, key, text: PING_TEXT, timeoutSec: sec, maxTokens: 1, fetchImpl: doFetch, signal,
  });
  const base = {
    ok: post.ok, verdict: post.ok ? 'ok' : '', endpoint: post.endpoint, attempted: post.attempted,
    status: post.status ?? null, timing: post.timing, origin: cand.origin,
    detail: post.detail || '', error: post.error || '', finishReason: post.finishReason ?? null,
  };
  if (post.ok) return base;

  if (!Number.isFinite(Number(post.status))) {          // 没拿到状态才需要对照探测，别多打一次网络
    const probe = await probeOrigin(doFetch, cand.origin, sec * 1000);
    base.originReachable = probe.reachable;
    base.originStatus = probe.status;
    base.originMs = probe.ms;
    if (probe.reachable && post.error === 'timeout' && !signal?.aborted) {
      // 第 3 发只对"沉默到超时"做：被直接拒掉（fetch_failed）不需要再问一次
      const peek = await callChatEndpoint({
        baseUrl, model, key, text: PING_TEXT, timeoutSec: sec, maxTokens: 1, stream: 'peek', fetchImpl: doFetch, signal,
      });
      base.firstChunkMs = peek.timing?.firstChunkMs ?? null;
      base.streamStatus = peek.status ?? null;
    }
  }
  return { ...base, verdict: classifyPing({
    status: post.status, error: post.error,
    headersMs: post.timing?.headersMs, originReachable: base.originReachable,
    firstChunkMs: base.firstChunkMs,
  }) };
}

/** 不带任何头部与凭据的 HEAD/GET：只回答"这个 origin 连不连得上" */
async function probeOrigin(doFetch, origin, timeoutMs) {
  const ctrl = new AbortController();
  const watch = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  const t0 = nowMs();
  try {
    const res = await doFetch(origin + '/', { method: 'GET', redirect: 'error', signal: ctrl.signal });
    return { reachable: true, status: res.status, ms: Math.round(nowMs() - t0) };
  } catch {
    return { reachable: false, status: null, ms: Math.round(nowMs() - t0) };
  } finally { clearTimeout(watch); }
}
