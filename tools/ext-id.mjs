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
  const clean = path.normalize(String(absolutePath || '')).replace(/[\\/]+$/, '');
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
