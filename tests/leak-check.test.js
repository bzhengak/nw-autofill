/**
 * leak-check 自己的回归。这条测试的意义是"别让那把尺子坏掉"：
 * 2026-10-05 那次清扫，靠形状规则（手机号/证件号正则）连查两轮都漏了真号与中文校名，
 * 最后是靠"拿真实资料逐值比对"才查出来。工具一旦静默失效，下一次推送又会只剩形状规则可用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tool = 'tools/leak-check.mjs';

function runTool(profile) {
  const f = path.join(os.tmpdir(), `nw-leak-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(profile));
  try {
    const out = execFileSync(process.execPath, [tool, f], { encoding: 'utf8', maxBuffer: 1 << 26 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  } finally {
    rmSync(f, { force: true });
  }
}

test('真值在仓库里时必须报出来，并点名文件（这条就是"尺子没坏"）', () => {
  // 用一个确实登记在仓库里、且长度过工具门槛（≥5 字）的值
  const { code, out } = runTool({ education: [{ school: 'Fudan University' }] });
  assert.equal(code, 1, `本该判泄露却过了，输出：${out}`);
  assert.match(out, /【泄露】/, `没按"泄露"这一档报：${out}`);
  assert.match(out, /education\.0\.school/, '没说是哪个字段');
  assert.match(out, /tests\/mapping-plan\.test\.js|tests\\mapping-plan\.test\.js/, '没点名出现的文件');
});

test('资料里的值不在仓库里时判干净（不许反过来一律报泄露）', () => {
  const { code, out } = runTool({ contact: { email: 'zz-不存在-9f8e7d@example.invalid' } });
  assert.equal(code, 0, `不该有泄露却报了：${out}`);
  assert.match(out, /没有真实取值出现在仓库里/);
});

test('输出里不许出现取值明文（这个脚本自己不能变成新的泄露面）', () => {
  const secret = 'Fudan University';   // 仓库里确实有，一定会命中
  const { out } = runTool({ education: [{ school: secret }] });
  assert.ok(!out.includes(secret), '输出里带着明文，打码失效');
  assert.match(out, /Fud\*+sity|【泄露】education/, `没看到打码样式：${out}`);
});

test('产品用词（出现在一大堆文件里的值）不算泄露，否则工具会被噪音废掉', () => {
  // '应届毕业生' 既是资料里的 intent.gradStatus，又是 schema/适配器/README 里的用词（13 个文件）
  const { code, out } = runTool({ intent: { gradStatus: '应届毕业生' } });
  assert.equal(code, 0, `产品用词被当成泄露了：${out}`);
  assert.match(out, /多半是产品用词/, `没归到词表那一档：${out}`);
});

test('用法错误要退 2，不能"没给资料"就当干净', () => {
  let code = 0;
  try { execFileSync(process.execPath, [tool], { encoding: 'utf8' }); }
  catch (e) { code = e.status; }
  assert.equal(code, 2, '不带参数时应该报用法错误');
});
