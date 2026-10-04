// 算出"解压加载"的扩展 ID：Edge/Chrome 用的是**文件夹路径的 UTF-16LE 字节**做 SHA-256，
// 取前 32 个 16 进制位，每位映射到 a-p（0→a、1→b、…、f→p）。
//
// 为什么要这么一个脚本：storage.local 落在
//   %LOCALAPPDATA%\<浏览器>\User Data\<配置文件>\Local Extension Settings\<扩展ID>\
// 用户想知道"我的资料到底是哪个文件"时，需要的就是这个 ID；而 ID 又**只由加载路径决定** ——
// 把仓库换个目录，ID 就变了，旧数据不会跟过去（"我资料怎么没了"的常见真因）。
//
// 用法：node tools/ext-id.mjs "C:\path\to\nw-autofill"
import { createHash } from 'node:crypto';
import path from 'node:path';

export function extensionIdFor(absolutePath) {
  const raw = String(absolutePath ?? '').trim();
  // 输入得不像个绝对路径就别算了：空串、'relative/path' 这种照样能哈希出一个 32 位、
  // 看着完全像真的 ID —— 用户拿它去翻 Local Extension Settings 就是白跑一趟（宁可当场说清楚）。
  if (!/^[a-zA-Z]:[\\/]/.test(raw) && !/^[\\/]/.test(raw)) {
    throw new Error(`这不是绝对路径，算扩展 ID 没有意义：${JSON.stringify(absolutePath)}`);
  }
  // 分隔符先统一成 \，再走 win32 的 normalize：
  // ① 这个 ID 本来就是给 Windows 上的 Edge/Chrome 用的（见文件头），路径语义要固定；
  //    用平台相关的 path.normalize，同一串路径在 Linux 的 CI 上会算出另一个 ID
  //    （2026-10-05 首跑 CI 红的第一条就是它 —— posix 根本不把 \ 当分隔符）。
  // ② 对真正的 Windows 路径没有任何改变：原来 win32 的 normalize 结果一致。
  // UNC / 设备前缀开头的那两个反斜杠要保住（\\server\share 压成 \server\share 就成另一个 ID 了）。
  const unc = /^\\\\/.test(raw) ? '\\\\' : '';
  const unified = (unc ? raw.slice(2) : raw).replace(/[\\/]+/g, '\\');
  const clean = (unc + path.win32.normalize(unified)).replace(/\\+$/, '');
  if (!clean) {
    throw new Error(`路径里没有任何目录成分，算不出扩展 ID：${JSON.stringify(absolutePath)}`);
  }
  const hex = createHash('sha256').update(clean, 'utf16le').digest('hex');
  return hex.slice(0, 32).split('').map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

if (process.argv[1] && process.argv[1].endsWith('ext-id.mjs')) {
  const target = process.argv[2] || process.cwd();
  const abs = path.resolve(target);
  console.log(`路径：${abs}`);
  console.log(`扩展 ID：${extensionIdFor(abs)}`);
  console.log('数据目录（Windows）：%LOCALAPPDATA%\\<Google\\Chrome | Microsoft\\Edge>\\User Data\\<配置文件>\\Local Extension Settings\\' + extensionIdFor(abs));
}
