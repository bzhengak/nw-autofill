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

import { chatEndpointCandidates, redact, shouldRetryNextEndpoint } from './ai-security.js';
import { interpretAiReply } from './ai.js';

const MAX_BYTES_BODY = 200_000;   // 上游回的东西不该很大；只是防御性上限，不参与业务判断

/**
 * @param {object} p
 * @param {(url: string, init: object) => Promise<any>} [p.fetchImpl] 注入点是给测试用的；运行时用全局 fetch
 * @returns {Promise<object>} 成功 { ok:true, content, finishReason, rawChars, snippet, endpoint, attempted }
 *                            失败 { ok:false, error, detail?, status?, endpoint, attempted }
 */
export async function callChatEndpoint({ baseUrl, model, key, text, timeoutSec = 180, fetchImpl }) {
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
    const res = await oneCall({ doFetch, url, model, key, text, timeoutMs: left });
    attempted.push({ url, status: res.status ?? null, error: res.error || '' });
    if (res.ok) return { ...res, endpoint: url, attempted };
    if (!shouldRetryNextEndpoint(res.status)) return { ...res, endpoint: url, attempted };
    last = res;
  }
  return { ...(last || { ok: false, error: 'network_error' }), endpoint: attempted.at(-1)?.url || '', attempted };
}

async function oneCall({ doFetch, url, model, key, text, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await doFetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        // 几十个缺口的 JSON 答案很容易超过 800 token：截断后解析不出来，
        // 用户看到的就成了"AI 没给建议"，其实是回答被砍断了。
        max_tokens: 2000,
        messages: [{ role: 'user', content: text }],
      }),
    });
    if (!res.ok) {
      const bodyText = String(await res.text().catch(() => '')).slice(0, MAX_BYTES_BODY);
      // 上游错误体常带模型名/额度信息，对用户有用；也可能回显请求内容，一律先过 redact
      return { ok: false, status: res.status, error: `http_${res.status}`, detail: redact(bodyText.slice(0, 300), key) };
    }
    const json = await res.json().catch(() => null);
    if (json?.error) {
      return {
        ok: false, status: res.status,
        error: 'upstream_' + String(json.error.code || json.error.type || 'error'),
        detail: redact(String(json.error.message || '').slice(0, 300), key),
      };
    }
    // 正文/思考/截断的判定全在 core/ai.js 的纯函数里（那才是"空输出"最容易出事的环节）
    const got = interpretAiReply(json);
    if (!got.ok) {
      return {
        ok: false, status: res.status, error: got.error,
        detail: redact(got.detail || '', key), finishReason: got.finishReason, reasoningChars: got.reasoningChars,
      };
    }
    return {
      ok: true, status: res.status,
      content: got.content,
      finishReason: got.finishReason,
      rawChars: got.rawChars,
      // 回显兜底：上游要是把 Key 印进正文里（见过这种代理），也不能带进界面
      snippet: redact(got.snippet, key),
    };
  } catch (err) {
    const name = String(err?.name || '');
    if (name === 'AbortError') {
      return { ok: false, error: 'timeout', detail: `等待 ${Math.round(timeoutMs / 1000)} 秒后中止`, waitedSec: Math.round(timeoutMs / 1000) };
    }
    // 错误文本可能带上请求 URL 甚至 Header，一律脱敏后再返回
    return { ok: false, error: redact(String(err?.message || 'network_error'), key) };
  } finally { clearTimeout(timer); }
}
