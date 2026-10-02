// Key 与端点的安全规则，全部写成纯函数：
// service worker 里那些 chrome.* / fetch 的部分没法在 CI 跑，
// 所以"什么算合法端点、Key 能不能发出去、settings 里能不能存 Key"必须能离线断言，
// 而不是等有人在浏览器里试。

/** 可以持久化的设置白名单。Key 不在里面 —— 它只配活在 chrome.storage.session。 */
export const SETTING_KEYS = ['mode', 'fillSensitive', 'autoSubmitNever', 'allowCustomSelect', 'aiEnabled',
  'aiBaseUrl', 'aiModel', 'aiMaxGaps', 'aiConsentOrigin', 'aiTimeoutSec', 'aiMaxOutput', 'aiStream', 'editorLang', 'enMissingMode'];

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

/**
 * Base URL → 真正要 POST 的端点候选（有序，最多两个，全部同源）。
 *
 * 为什么要候选而不是硬拼：大家粘的"Base URL"形状根本不统一 ——
 * `https://api.x.test/v1`、`https://api.x.test/v1/`、`https://api.x.test`、
 * 甚至有人直接粘了完整端点 `https://api.x.test/v1/chat/completions`。
 * 老写法一律 `base + '/chat/completions'`，后两种就会 404，
 * 而上游回的 404 正文往往只是 "Not Found" —— 用户看到的就是"调用失败：http_404"，
 * 完全猜不到是自己粘的地址差一段。（2026-09-30 实测就是这个形状。）
 *
 * 候选只在同一个 origin 的 pathname 上做文章：**永不换域**。
 * Key 与 origin 绑定那条规则（maySendKey）因此不会被这里绕过。
 */
export function chatEndpointCandidates(input) {
  const base = normalizeBaseUrl(input);
  if (!base.ok) return { ok: false, error: base.error, candidates: [] };
  const u = new URL(base.url);
  const path = u.pathname.replace(/\/+$/, '');
  const at = p => `${base.origin}${p}/chat/completions`;
  const list = [];
  const push = url => {
    if (!url || list.includes(url)) return;
    // 同源兜底：候选全部由 `${origin}${pathname}` 拼出来，今天这条路改不动域；
    // 留着这行是**后盾**——将来谁把候选改成直接吃用户原文，这一行会把它挡住，
    // 而界面层的断言（tests/ai-endpoint.test.js）会同时变红。
    if (new URL(url).origin !== base.origin) return;
    list.push(url);
  };
  if (/\/chat\/completions$/i.test(path)) {
    push(`${base.origin}${path}`);                     // 粘的就是完整端点，原样用
  } else if (/\/(completions|responses|messages)$/i.test(path)) {
    push(`${base.origin}${path}`);                     // 其它 API 动词：别再加一段，先按它试
    push(at(path.replace(/\/[^/]*$/i, '')));           // 再退回同前缀的 chat/completions
  } else if (path === '') {
    push(at('/v1'));                                   // 只给了主机名：OpenAI 兼容层的规范形状
    push(at(''));
  } else if (/\/v\d+([a-z0-9]*)$/i.test(path)) {
    push(at(path));                                    // /v1、/v1beta、/v3：直接接上
  } else {
    push(at(path));                                    // 自定义前缀（/api/gateway…）
    push(at(`${path}/v1`));                             // 同一前缀下带版本号的另一种常见摆法
  }
  return { ok: true, origin: base.origin, candidates: list, endpoint: list[0] || '' };
}

/**
 * 只有"路径没对上"才值得顺延下一个候选。
 * 401/403/429/5xx 与超时都不是路径问题：重一次就是多发一次真实请求，
 * 既烧额度也可能把同一个 Key 在错误状态下敲第二遍。
 */
export function shouldRetryNextEndpoint(status) {
  return status === 404 || status === 405;
}

/** Key 的最小校验：只做形状检查，绝不回显内容 */export function sanityCheckKey(key) {
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
/**
 * AI 请求的等待上限（秒）。
 * 默认 180 秒：reasoning 模型 + 几十个缺口的 JSON 回答，20 秒这个旧默认值几乎必然超时，
 * 而且超时是最难归因的失败（用户看到的是"没反应"，其实是还没答完）。
 * 上限给到 900 秒，但界面与后台都会在此期间持续告诉用户"已等待多少秒"，
 * 不是在黑箱里干等。
 */
export const AI_TIMEOUT_DEFAULT_SEC = 180;
export const AI_TIMEOUT_MIN_SEC = 15;
export const AI_TIMEOUT_MAX_SEC = 900;

export function clampTimeoutSec(v) {
  const raw = String(v ?? '').trim();
  // 空值当"没填"处理（invalid），不当成 0：调用方据此退回默认，
  // 而 Number('') === 0 会被下面判成"太小"，语义上把"留空"和"填了个 0"混为一谈。
  if (!raw) return { ok: false, error: 'timeout_invalid', seconds: AI_TIMEOUT_DEFAULT_SEC };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: 'timeout_invalid', seconds: AI_TIMEOUT_DEFAULT_SEC };
  const s = Math.round(n);
  if (s < AI_TIMEOUT_MIN_SEC) return { ok: false, error: 'timeout_too_small', seconds: AI_TIMEOUT_MIN_SEC };
  if (s > AI_TIMEOUT_MAX_SEC) return { ok: false, error: 'timeout_too_large', seconds: AI_TIMEOUT_MAX_SEC };
  return { ok: true, seconds: s };
}

/** 从 settings 里取实际生效的超时（非法值一律退回默认，不让一次手滑把请求锁死） */
export function effectiveTimeoutSec(settings) {
  const got = clampTimeoutSec(settings?.aiTimeoutSec);
  return got.ok ? got.seconds : AI_TIMEOUT_DEFAULT_SEC;
}

/**
 * 回答长度上限（请求体里的 max_tokens）。
 *
 * 为什么这也要能配：reasoning 模型（DeepSeek-R1 / QwQ / Qwen3 思考模式）把
 * **思考过程一起算进 max_tokens**。上限给小了会出现两种表现：正文是空的（`reasoning_only`），
 * 或 JSON 被砍半（`truncated`）—— 都不是"模型没建议"，而是我们没留够写字的地方。
 * 老实现写死 2000，对几十个缺口的 JSON 回答 + 思考链本来就不够。
 *
 * 设置键名故意叫 `aiMaxOutput` 而不是 `aiMaxTokens`：持久化设置有一条按**键名**拦秘密的闸
 * （名字里带 token/key/secret 的一律拒收，因为 settings 会被导出 JSON 带走），
 * 叫 aiMaxTokens 会被那道闸当成可疑键名丢掉 —— 那道闸不能为了一个数字键开口子。
 */
export const AI_MAX_TOKENS_DEFAULT = 4000;
export const AI_MAX_TOKENS_MIN = 500;
export const AI_MAX_TOKENS_MAX = 16000;

export function clampMaxTokens(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return { ok: false, error: 'output_invalid', tokens: AI_MAX_TOKENS_DEFAULT };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: 'output_invalid', tokens: AI_MAX_TOKENS_DEFAULT };
  const t = Math.round(n);
  if (t < AI_MAX_TOKENS_MIN) return { ok: false, error: 'output_too_small', tokens: AI_MAX_TOKENS_MIN };
  if (t > AI_MAX_TOKENS_MAX) return { ok: false, error: 'output_too_large', tokens: AI_MAX_TOKENS_MAX };
  return { ok: true, tokens: t };
}

export function effectiveMaxTokens(settings) {
  const got = clampMaxTokens(settings?.aiMaxOutput);
  return got.ok ? got.tokens : AI_MAX_TOKENS_DEFAULT;
}

/**
 * 要不要用流式收答案。**默认开**。
 * 理由不是"流式更高级"，而是非流式有一个物理事实：整段答案生成完成之前，服务端一个字节都不发。
 * 于是"对端在慢慢想"和"路径根本不通"在界面上完全同形 —— 2026-09-30 用户实测就是
 * 非流式 15 秒零字节、流式立刻开始回话。开了流式还能顺手得到"第一个字节几毫秒"和
 * "中止时已经收到多少字"这两个以前看不见的事实。
 * 服务商不认 `stream:true` 时，core/ai-endpoint.js 会自动退回普通收法再试一次（见 shouldRetryWithoutStream），
 * 所以这个默认值是安全的。
 */
export function effectiveStream(settings) {
  return settings?.aiStream !== false;        // 没配过 = 开；只有显式关掉才不走流式
}

export function maySendKey({ keyOrigin, targetOrigin, consentOrigin }) {
  if (!targetOrigin) return { ok: false, error: 'no_endpoint' };
  if (!keyOrigin) return { ok: false, error: 'no_key' };
  if (!consentOrigin) return { ok: false, error: 'needs_consent' };
  if (consentOrigin !== targetOrigin) return { ok: false, error: 'origin_changed' };
  if (keyOrigin !== targetOrigin) return { ok: false, error: 'origin_mismatch' };
  return { ok: true };
}

/**
 * 「每换一个站点问一次」的那本账。
 *
 * 为什么 aiConsentOrigin 不够用：它记的是"我确认把 Key 与字段名发往这个 AI 端点"，
 * 一次勾完，之后在哪个招聘站点都放行。但真正在变的另一半是**发出去的是什么页面**：
 * 途普那一页的栏位名、选项文案、板块标题都会离开本机。用户 2026-10-02 要的粒度是
 * "每换站点问一次"，所以要按页面 origin 单独记一条。
 *
 * 记的是 `页面 origin → 当时确认过的 AI 端点 origin`：
 *  · 端点换了（改 Base URL）→ 老记录一律不算数（site_consent_stale），重新问；
 *  · 认不出页面 origin（没有标签页 URL）→ 直接拒，不"当作已确认"。
 * 这本账不进 settings —— settings 会被「导出 JSON」带走，而它记的是"你在哪些站点投过简历"。
 */
export const SITE_CONSENT_BUCKET = 'aiSiteConsent';
export const SITE_CONSENT_LIMIT = 50;

export function siteConsentCheck({ consents, pageOrigin, targetOrigin }) {
  if (!pageOrigin) return { ok: false, error: 'no_page_origin' };
  if (!targetOrigin) return { ok: false, error: 'no_endpoint' };
  const granted = String((consents && consents[pageOrigin]) || '');
  if (!granted) return { ok: false, error: 'needs_site_consent', pageOrigin };
  if (granted !== targetOrigin) return { ok: false, error: 'site_consent_stale', pageOrigin };
  return { ok: true };
}

/** 记一条"这一站确认发往该端点"；只接受 https?://host 形状的 origin，超量时丢最旧插入的 */
export function withSiteConsent(consents, { pageOrigin, targetOrigin, limit = SITE_CONSENT_LIMIT }) {
  const next = { ...(consents && typeof consents === 'object' ? consents : {}) };
  const ok = s => /^https?:\/\/[a-z0-9.\-]+(:\d+)?$/i.test(String(s || ''));
  if (!ok(pageOrigin) || !ok(targetOrigin)) return next;
  next[pageOrigin] = targetOrigin;
  const keys = Object.keys(next);
  if (keys.length > limit) for (const k of keys.slice(0, keys.length - limit)) delete next[k];
  return next;
}

/** 端点变了：把不再指向新端点的记录一起清掉，避免"旧确认放行新地址"或反过来 */
export function siteConsentAfterEndpoint({ consents, endpointOrigin }) {
  const next = {};
  for (const [k, v] of Object.entries(consents && typeof consents === 'object' ? consents : {})) {
    if (!endpointOrigin || v === endpointOrigin) next[k] = v;
  }
  return next;
}

/**
 * 存设置之后，"确认发往某地址"这条记录该留什么值。
 *
 * 曾经的写法是"patch 里带了 aiBaseUrl 且它和 prev.aiBaseUrl 的 origin 不一样 → 清空确认"。
 * 这在用户先勾确认、后（或几乎同时）保存 Base URL 时会把刚记下的确认擦掉：
 * prev.aiBaseUrl 还是空串或不一致的旧值，于是 origin 判定不相等 → 确认清零，
 * 而界面上那个勾还留着 → 点「问 AI」就得到一句看不懂的 needs_consent。
 *
 * 判据应该是"这条确认对新端点还成不成立"，不是"URL 字符串变没变"：
 *  · 确认的 origin 与最终生效端点的 origin 一致 → 保留；
 *  · 不一致，或端点根本不合法 → 作废（必须重勾）。
 */
export function consentAfterSettingsPatch({ prev = {}, patch = {} } = {}) {
  const granted = patch.aiConsentOrigin !== undefined ? String(patch.aiConsentOrigin || '') : String(prev.aiConsentOrigin || '');
  if (!granted) return '';
  const url = patch.aiBaseUrl !== undefined ? patch.aiBaseUrl : prev.aiBaseUrl;
  // 没有可比端点时留着这条确认：发送时另有 no_endpoint 闸兜着，
  // 而"先勾确认、后填 URL"是合法顺序，这里清掉就正是 needs_consent 的成因。
  // 不合法的 URL 也留着：nw:saveSettings 根本不会让它存进 settings（另一条闸）。
  if (!url || !normalizeBaseUrl(String(url)).ok) return granted;
  const t = normalizeBaseUrl(String(url));
  return t.origin === granted ? granted : '';
}

/**
 * Key 若要持久化，只能进这个**独立的桶**（storage.local 的顶层键 aiSecrets），
 * 绝不进 settings —— 因为 settings/profile 是会被"导出 JSON"带走的东西，
 * 而 chrome.storage.local 是明文落盘，扩展拿不到系统钥匙串（要走 DPAPI 就得装
 * native host，那违反"纯浏览器插件"的边界）。
 * 便利与暴露面就换在这里：记住 Key = 明文留在本机浏览器 profile 里，直到你点清除。
 */
export const SECRETS_BUCKET = 'aiSecrets';

const SECRET_VALUED = /(sk-[A-Za-z0-9_\-]{12,}|AKIA[0-9A-Z]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-)/;

/**
 * 导出守卫：任何要写文件 / 复制到剪贴板的对象，先扫一遍有没有把 Key 带进去。
 * 命中就返回泄漏清单，调用方必须拒绝导出 —— 宁可让人来问"为什么导不出"，
 * 也不能让人把 Key 发到聊天窗口里。
 */
export function findLeaksInExport(payload, secrets = {}) {
  const text = JSON.stringify(payload ?? null);
  const leaks = [];
  for (const [k, v] of Object.entries(secrets || {})) {
    const s = String(v || '');
    if (s.length >= 12 && text.includes(s)) leaks.push({ key: k, sample: s.slice(0, 6) });
  }
  const m = text.match(SECRET_VALUED);
  if (m) leaks.push({ key: '(形状匹配)', sample: m[1].slice(0, 6) });
  return leaks;
}
/** 日志与错误信息里一律不许出现 Key：任何要写出去的东西先过这道 */
export function redact(text, secret) {
  const s = String(secret || '');
  if (!s) return String(text ?? '');
  return String(text ?? '').split(s).join('[REDACTED]');
}
