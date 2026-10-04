/**
 * 测试入口：把要跑的文件一条条列清楚，再交给 node --test。
 *
 * 为什么不直接写 `node --test tests/`（这条踩过两次坑）：
 * ① 2026-10-05 首跑 GitHub Actions 就红在这里 —— 同一个参数在 Windows + Node 20 下
 *    是"扫这个目录"，到 Linux 的 runner 上却变成"把 tests 当成一个测试文件跑"，
 *    报 Cannot find module '/home/runner/.../tests'。
 * ② 反过来什么参数都不给（`node --test`）也不行：它会从仓库根往下找，
 *    把 .reference/ 里 fork 来的上游测试也一起跑了（本地 632 条 vs 真身 562 条），
 *    而那批文件是 gitignore 的，CI 上根本不存在 —— 数量对不上，判分也就不可信。
 *
 * 明确列出 tests/ 下的 *.test.js，跨平台、跨 Node 版本跑的都是同一批。
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const testDir = path.join(root, 'tests');

const files = readdirSync(testDir)
  .filter((f) => /\.test\.(js|mjs|cjs)$/.test(f))
  .sort()
  .map((f) => path.join('tests', f));

if (files.length === 0) {
  console.error(`tests/ 里一个 .test.js 都没找到（${testDir}）：这不是"全过"，这是没跑。`);
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
if (res.error) {
  console.error('node --test 没起来：', res.error.message);
  process.exit(1);
}
process.exit(res.status === null ? 1 : res.status);
