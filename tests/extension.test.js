// 扩展装配层的回归：这一层的问题只有"真在浏览器里点一次"才会暴露，
// 所以把它们拉到 node 里检查（Klook 实测就撞过 schema is not defined 与 classic SW 不支持 import()）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = f => fileURLToPath(new URL(f, import.meta.url));
const read = f => fs.readFileSync(root(f), 'utf8');
const manifest = JSON.parse(read('../manifest.json'));

const MODULE_IDS = ['scanner', 'filler', 'matcher', 'safety', 'schema', 'matching', 'probe'];

test('content.js 里用到的每个模块都在该函数的解构里', () => {
  const src = read('../dom/content.js');
  // 按函数体切分（本仓库的函数都以顶格 } 结束），逐函数检查而不是全局检查：
  // "schema is not defined" 正是别的函数解构了、这个函数没解构
  const bodies = [...src.matchAll(/(?:async )?function (\w+)\([^)]*\) \{([\s\S]*?)\n\}/g)];
  assert.ok(bodies.length >= 3, `没抓到函数体（${bodies.length}）`);
  for (const [, name, body] of bodies) {
    if (name === 'loadModules') continue; // 它就是提供这些标识符的地方
    for (const id of MODULE_IDS) {
      const used = new RegExp(`\\b${id}\\.[A-Za-z_$]`).test(body);
      if (!used) continue;
      const destructured = new RegExp(`const \\{[^}]*\\b${id}\\b[^}]*\\} = await loadModules\\(\\)`).test(body);
      assert.ok(destructured, `${name}() 用了 ${id}.* 但没在函数内解构它`);
    }
  }
});

/** manifest 的 WAR 用 * 匹配单段路径（core/*.js 覆盖 core/matcher.js，但不跨斜杠） */
function coveredBy(pat, p) {
  const re = new RegExp('^' + pat.split('*').map(x => x.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
  return re.test(p);
}

test('content.js 动态 import 的模块都存在，且在 web_accessible_resources 里', () => {
  const src = read('../dom/content.js');
  const paths = [...src.matchAll(/import\(u\('([^']+)'\)\)/g)].map(m => m[1]);
  assert.ok(paths.length >= 5, `没抓到动态 import（${paths.length}）`);
  const war = (manifest.web_accessible_resources || []).flatMap(e => e.resources || []);
  for (const p of paths) {
    assert.ok(fs.existsSync(root(`../${p}`)), `${p} 不存在`);
    assert.ok(war.some(pat => coveredBy(pat, p)), `${p} 未列入 web_accessible_resources，运行时 import 会被拒`);
  }
});

test('service worker 必须是 module：classic SW 里 import() 不可用，适配器会静默加载失败', () => {
  assert.equal(manifest.background.type, 'module', 'background.type 必须是 "module"');
  const sw = read('../background/service-worker.js');
  assert.match(sw, /^import \{ compileAdapters \} from/m, '适配器应静态 import，而不是运行时 import()');
  assert.ok(!/await import\(/.test(sw), 'classic/普通 SW 里动态 import 会抛，别再写回来');
});

test('主世界提交闸门作为 MAIN-world content script 注册', () => {
  const entry = (manifest.content_scripts || []).find(e => (e.js || []).includes('dom/submit-guard.js'));
  assert.ok(entry, 'submit-guard.js 未注册进 content_scripts');
  assert.equal(entry.world, 'MAIN', '必须在主世界才拦得到页面的 form.submit()');
  assert.equal(entry.run_at, 'document_start', '晚于 document_start 就来不及包住原生 submit');
  assert.ok(fs.existsSync(root('../dom/submit-guard.js')));
});
