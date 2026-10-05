/**
 * 泄露自检：拿一份真实资料，逐值比对仓库里所有被 git 登记的文本文件，报"哪个字段的值出现在哪个文件"。
 *
 * 为什么要有这个：2026-10-05 推上 GitHub 前做身份清扫，靠"形状像不像手机号/证件号"猜了两轮都没猜全 ——
 * 真号 139…6253 就躺在 tests/importer.test.js 的一条断言里，形状和那些编的 13900002222 一模一样，
 * 而"复旦大学"这种中文校名根本不匹配任何 ASCII 规则。**唯一可靠的办法是拿真资料逐值比对。**
 * 真实资料本身是 gitignore 的（.output/、private-profile.*.json），所以这条检查只能在本地跑。
 *
 * 用法：node tools/leak-check.mjs <资料.json> [更多.json...]
 * 退出码：0 = 干净；1 = 有真实取值出现在仓库里；2 = 用法/读取错误。
 * 输出里取值一律打码 —— 这个脚本自己不该变成新的泄露面（日志、终端回滚缓冲都会留底）。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('用法：node tools/leak-check.mjs <真实资料.json> [更多.json...]');
  process.exit(2);
}

const mask = (s) => (s.length <= 10
  ? s[0] + '*'.repeat(Math.max(1, s.length - 2)) + s.slice(-1)
  : `${s.slice(0, 3)}${'*'.repeat(6)}${s.slice(-4)}`);

// 日期/年份/纯数字这种"人人都会有"的值单独一档：它们命中多半是巧合，不该淹没真信号
const LIKELY_COINCIDENCE = /^(19|20)\d{2}([-/.]\d{1,2}){0,2}$|^\d+$/;

const entries = [];
const walk = (node, path) => {
  if (typeof node === 'string') { const s = node.trim(); if (s.length >= 5) entries.push([path, s]); return; }
  if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}.${i}`)); return; }
  if (node && typeof node === 'object') { for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k); }
};
for (const f of args) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(f, 'utf8')); }
  catch (e) { console.error(`读不了 ${f}：${e.message}`); process.exit(2); }
  walk(parsed, f.replace(/^.*[\\/]/, '').replace(/\.json$/, ''));
}

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  .filter((f) => /\.(js|mjs|cjs|json|md|html|css|yml|yaml|txt)$/.test(f));
const bodies = tracked.map((f) => {
  try { return [f, readFileSync(f, 'utf8')]; } catch { return [f, '']; }
});

const seen = new Set();
const hard = [];
const soft = [];
const vocab = [];
for (const [path, val] of entries) {
  const key = `${path}=${val}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const where = bodies.filter(([, b]) => b.includes(val)).map(([f]) => f);
  if (!where.length) continue;
  const row = { path, shown: mask(val), where };
  // 出现在一大堆文件里的值，几乎一定是产品自己的用词（枚举、选项、示例），不是你的隐私；
  // 不这么分的话每次跑都被"应届生"这类噪音占满，工具就废了。阈值取 8：真号 1 个、校名 4 个都远低于它。
  if (where.length >= 8) { vocab.push(row); continue; }
  (LIKELY_COINCIDENCE.test(val) ? soft : hard).push(row);
}

console.log(`比对：真实取值 ${seen.size} 个 × 仓库登记文本文件 ${bodies.length} 个`);
for (const r of hard) console.log(`  【泄露】${r.path} = ${r.shown}  →  ${r.where.join(', ')}`);
for (const r of soft) console.log(`  （日期/数字型，多半巧合，自己看一眼）${r.path} = ${r.shown} → ${r.where.slice(0, 3).join(', ')}`);
for (const r of vocab) console.log(`  （出现在 ${r.where.length} 个文件里，多半是产品用词而非隐私）${r.path} = ${r.shown}`);
if (!hard.length) { console.log('结论：没有真实取值出现在仓库里。'); process.exit(0); }
console.log(`结论：${hard.length} 个真实取值出现在仓库里，推之前先换成假数据。`);
process.exit(1);
