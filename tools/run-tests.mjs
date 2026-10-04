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
 * 递归扫 tests/（不是一层）：将来谁把测试放进子目录、或者写成 *.spec.js，
 * 只扫一层会"少跑一批还全绿"，这正是本项目被咬过的那类问题（装配层是死的）。
 * 一个都没找到时报错退出，绝不静默变成"全过"。
 * 额外支持透传参数：`npm test -- --test-name-pattern 裸词` 只会跑匹配的那几条。
 */
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const testDir = path.join(root, 'tests');
// 与 tests/extension.test.js 里那条"扫测试文件"的守卫保持同一套后缀，别一边宽一边窄
const TEST_FILE = /\.(test|spec)\.(js|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.output', '.reference']);

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      out.push(...walk(path.join(dir, ent.name)));
    } else if (TEST_FILE.test(ent.name)) {
      out.push(path.relative(root, path.join(dir, ent.name)));
    }
  }
  return out;
}

if (!existsSync(testDir)) {
  console.error(`tests/ 目录不存在（${testDir}）：这不是"全过"，这是没地方跑。`);
  process.exit(1);
}

const files = walk(testDir).sort();
if (files.length === 0) {
  console.error(`tests/ 下一个测试文件都没找到（后缀要匹配 ${TEST_FILE}）：这不是"全过"，这是没跑。`);
  process.exit(1);
}

// 让 CI 能拿这个数与 `git ls-files` 对账：少跑一批文件时，对账那条会红，而不是静默全绿
console.log(`[run-tests] 扫到 ${files.length} 个测试文件`);

const extra = process.argv.slice(2);
const res = spawnSync(process.execPath, ['--test', ...extra, ...files], { cwd: root, stdio: 'inherit' });
if (res.error) {
  console.error('node --test 没起来：', res.error.message);
  process.exit(1);
}
process.exit(res.status === null ? 1 : res.status);
