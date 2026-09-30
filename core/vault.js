// 加密备份（"保险箱文件"）：把整份 profile 用口令加密成一个 JSON 文件，让你能把它放到
// 自己选的位置 —— 而不是只躺在浏览器 profile 的明文 LevelDB 里。
//
// 为什么是"加密"而不是"换个目录"：两者都在同一个 Windows 账户下，能读你磁盘的东西也能读它，
// 换路径本身不提供任何机密性；而 Documents/Desktop 往往还是 OneDrive 同步范围，
// 明文放过去反而更容易外流。真正加一道墙只有加密这一条路。
//
// 边界（与整个项目一致）：只用浏览器自带的 WebCrypto，不装本地程序、不接 native host，
// 因此**拿不到系统钥匙串**：口令只能每次由你输入，绝不写进 storage、绝不写进文件。
//
// 老实说清防得住什么、防不住什么：
//  · 防得住：文件被别人拷走（网盘、U 盘、微信传错人）、电脑丢了之后硬盘被读。
//  · 防不住：你正开着侧边栏填表时，资料在内存里就是明文（键盘记录、截屏、恶意进程都看得到）；
//    浏览器 profile 里那份**工作副本仍是明文**（这是"能自动填表"的代价，否则每次扫描都要你输口令）。
//  · 没有后门：口令忘了 = 文件解不开。这个模块里不存在任何找回路径，也别指望我以后加。

import { getValueByPath } from './profile-schema.js';

const VAULT_FORMAT = 'nw-vault-v1';
const PBKDF2_ITERATIONS = 600_000;      // OWASP 对 PBKDF2-SHA256 的建议量级；一次派生约几百毫秒，只在存/取时做一次
const MIN_PASSPHRASE = 8;

const b64 = buf => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = str => Uint8Array.from(atob(String(str || '')), c => c.charCodeAt(0));
const subtle = () => {
  const c = globalThis.crypto?.subtle;
  if (!c) throw new Error('no_webcrypto');
  return c;
};

/** 口令强度只判形状，绝不保存、绝不回显口令本身 */
export function checkPassphrase(passphrase) {
  const p = String(passphrase || '');
  // 先判"空"再判长度：'   ' 这种是"你没输"，不是"你输短了"，两句提示不能混
  if (!p.trim()) return { ok: false, error: 'empty' };
  if (p.length < MIN_PASSPHRASE) return { ok: false, error: 'too_short', min: MIN_PASSPHRASE };
  return { ok: true, length: p.length };
}

export function looksLikeVault(obj) {
  return !!obj && typeof obj === 'object' && obj.v === VAULT_FORMAT
    && typeof obj.ct === 'string' && typeof obj.salt === 'string' && typeof obj.iv === 'string';
}

async function deriveAesKey(passphrase, salt, iterations) {
  const base = await subtle().importKey('raw', new TextEncoder().encode(String(passphrase)), 'PBKDF2', false, ['deriveKey']);
  const algorithm = { name: 'PBKDF2', salt, iterations: Number(iterations) || PBKDF2_ITERATIONS, hash: 'SHA-256' };
  const derived = { name: 'AES-GCM', length: 256 };
  // 参数个数在两处不一致：浏览器按 WebIDL 只要 3 个（Node 20 的 webcrypto 要 5 个）。
  // 与其猜运行环境，两种都试一次 —— 猜错的代价是"这个功能在你的 Edge 里报一句
  // 'Failed to execute deriveKey'"，而它看起来像代码坏了。
  try {
    return await subtle().deriveKey(algorithm, base, derived);
  } catch (err) {
    if (!/arguments required/i.test(String(err?.message || ''))) throw err;
    return subtle().deriveKey(algorithm, base, derived, false, ['encrypt', 'decrypt']);
  }
}

/**
 * @returns 一个可以直接 JSON.stringify 落盘的对象。字段里除了密文没有任何内容信息 ——
 *          连槽位数量、分组名都不写（那些足以让"这是个简历文件"变成可推断的事实）。
 */
export async function encryptVault({ profile, passphrase, build = '' }) {
  const strength = checkPassphrase(passphrase);
  if (!strength.ok) return { ok: false, error: 'passphrase_' + strength.error };
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plain = new TextEncoder().encode(JSON.stringify(profile ?? {}));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plain);
  return {
    ok: true,
    vault: {
      v: VAULT_FORMAT, kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS,
      cipher: 'AES-256-GCM', salt: b64(salt), iv: b64(iv), ct: b64(ct),
      // 只记"哪一版插件写的、什么时候写的"：排查"旧文件配新代码"时有用，不含内容
      builtAt: new Date().toISOString(), build: String(build || ''),
    },
  };
}

/**
 * 解不开的情况要分得开：口令错、文件不是保险箱、文件被改过 —— 三句修法完全不同。
 * AES-GCM 是带认证的：任何一位被篡改都会解密失败，所以"被改过"和"口令错"都落在这里，
 * 只能靠"是不是标准保险箱格式"先分流，剩下统一报 wrong_passphrase（不假装能区分）。
 */
export async function decryptVault({ text, passphrase }) {
  let obj = null;
  if (typeof text === 'string') {
    try { obj = JSON.parse(text); } catch { return { ok: false, error: 'not_json' }; }
  } else obj = text;
  if (!looksLikeVault(obj)) {
    return { ok: false, error: 'not_vault', hint: '这个文件是明文的 profile JSON，不是加密保险箱：直接走「导入 JSON」就行' };
  }
  const strength = checkPassphrase(passphrase);
  if (!strength.ok) return { ok: false, error: 'passphrase_' + strength.error };
  if (!globalThis.crypto?.subtle) return { ok: false, error: 'no_webcrypto' };   // 别说成"口令错"
  try {
    const key = await deriveAesKey(passphrase, unb64(obj.salt), obj.iterations);
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(obj.iv) }, key, unb64(obj.ct));
    const profile = JSON.parse(new TextDecoder().decode(plain));
    if (!profile || typeof profile !== 'object') return { ok: false, error: 'bad_payload' };
    return { ok: true, profile, meta: { builtAt: obj.builtAt || '', build: obj.build || '' } };
  } catch {
    return { ok: false, error: 'wrong_passphrase_or_tampered' };
  }
}

/**
 * 载入前的差异：把"会被覆盖掉什么"摆在确认框之前。
 * 只数数量、不列取值 —— 差异说明是要显示在界面上的，不该把证件号又印一遍。
 *
 * @param {object} current 浏览器里现在这份
 * @param {object} incoming 保险箱里那份
 * @param {Array<{path:string}>} fields 槽位表（buildFields()）
 */
export function profileDelta(current = {}, incoming = {}, fields = []) {
  const read = (obj, path) => String(getValueByPath(obj, path) ?? '').trim();
  const out = { added: 0, changed: 0, removed: 0, same: 0, willLose: [] };
  for (const f of fields || []) {
    const a = read(current, f.path);
    const b = read(incoming, f.path);
    if (!a && !b) continue;
    if (!a && b) out.added++;
    else if (a && !b) { out.removed++; if (out.willLose.length < 12) out.willLose.push(f.zh || f.path); }
    else if (a !== b) out.changed++;
    else out.same++;
  }
  return out;
}

export function describeDelta(d) {
  const parts = [];
  if (d.added) parts.push(`补上 ${d.added} 栏`);
  if (d.changed) parts.push(`改掉 ${d.changed} 栏`);
  if (d.removed) parts.push(`清空 ${d.removed} 栏`);
  if (!parts.length) parts.push('与现在这份完全一致');
  return parts.join('、');
}

export { VAULT_FORMAT, PBKDF2_ITERATIONS };
