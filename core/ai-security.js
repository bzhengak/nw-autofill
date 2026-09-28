// Key 与端点的安全规则，全部写成纯函数：
// service worker 里那些 chrome.* / fetch 的部分没法在 CI 跑，
// 所以"什么算合法端点、Key 能不能发出去、settings 里能不能存 Key"必须能离线断言，
// 而不是等有人在浏览器里试。

/** 可以持久化的设置白名单。Key 不在里面 —— 它只配活在 chrome.storage.session。 */
export const SETTING_KEYS = ['mode', 'fillSensitive', 'autoSubmitNever', 'aiEnabled', 'aiBaseUrl', 'aiModel', 'aiMaxGaps', 'aiConsentOrigin'];

const SECRETISH = /(key|token|secret|password|credential|auth)/i;

/**
 * 过滤设置补丁：未知键丢弃，名字像秘密的键丢弃（哪怕值还没写）。
 * 返回 { clean, dropped } —— 侧边栏要把 dropped 念出来，不能静默吃掉，
 * 否则"我的 Key 怎么没保存"会变成用户自己猜。
 */
export function sanitizeSettings(patch = {}) {
  const clean = {};
  const dropped = [];
  for (const [k, v] of Object.entries(patch || {})) {
    // 先按"名字像不像秘密"判：这类键如果被归进"未知设置项"，用户看到的提示是错的，
    // 会以为自己拼错了字段名，而不是"你试图把 Key 写进会被导出的地方"。
    if (SECRETISH.test(k)) { dropped.push({ k, why: 'Key/Token 类内容不允许写进持久化设置' }); continue; }
    if (!SETTING_KEYS.includes(k)) { dropped.push({ k, why: '未知设置项' }); continue; }
    clean[k] = v;
  }
  return { clean, dropped };
}

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

/**
 * 校验并规范化 Base URL。返回 { ok, url, origin, error }。
 *
 * 为什么要拒这些：
 * - 非 https：Key 走明文链路，等于把 Key 发给路径上任何一台路由器。
 *   本机（localhost/127.0.0.1）例外并写明 —— 很多人本地跑 Ollama/LM Studio。
 * - 带 userinfo（https://user@host/）：这是经典的"看起来是 A 域其实是 B 域"写法。
 * - 带 query/hash：Base URL 不该有查询串，有就说明粘贴错了东西（常见于粘了整个带 token 的链接）。
 * - 非 http(s) 协议（javascript:/data:）：不解释。
 */
export function normalizeBaseUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'empty' };
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: 'malformed' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'not_http' };
  if (u.protocol === 'http:' && !LOOPBACK.test(raw)) return { ok: false, error: 'insecure' };
  if (u.username || u.password) return { ok: false, error: 'userinfo' };
  if (u.search || u.hash) return { ok: false, error: 'has_query' };
  const url = raw.replace(/\/+$/, '');
  return { ok: true, url, origin: u.origin, secure: u.protocol === 'https:' };
}

/** Key 的最小校验：只做形状检查，绝不回显内容 */
export function sanityCheckKey(key) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, error: 'empty' };
  if (k.length < 12) return { ok: false, error: 'too_short' };
  if (k.length > 400) return { ok: false, error: 'too_long' };
  if (/\s/.test(k)) return { ok: false, error: 'has_space' };
  return { ok: true, length: k.length };
}

/**
 * Key 能不能发出去：三重门，缺一不可。
 *  - needs_consent：用户没有明确勾过"我确认发往这个地址"。Base URL 一改，
 *    侧边栏必须把这个勾清掉（存的是 consentOrigin，与当前 origin 不等就失效），
 *    否则"改了地址继续用老 Key"会静默发生。
 *  - origin_changed：勾过但地址已经不是当初那个 origin。
 *  - origin_mismatch：Key 是在 A 域录的，现在要发去 B 域 —— 老 Key 绝不跟着走。
 */
export function maySendKey({ keyOrigin, targetOrigin, consentOrigin }) {
  if (!targetOrigin) return { ok: false, error: 'no_endpoint' };
  if (!keyOrigin) return { ok: false, error: 'no_key' };
  if (!consentOrigin) return { ok: false, error: 'needs_consent' };
  if (consentOrigin !== targetOrigin) return { ok: false, error: 'origin_changed' };
  if (keyOrigin !== targetOrigin) return { ok: false, error: 'origin_mismatch' };
  return { ok: true };
}

/** 日志与错误信息里一律不许出现 Key：任何要写出去的东西先过这道 */
export function redact(text, secret) {
  const s = String(secret || '');
  if (!s) return String(text ?? '');
  return String(text ?? '').split(s).join('[REDACTED]');
}
