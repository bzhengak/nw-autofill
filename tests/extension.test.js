// 扩展装配层的回归：这一层的问题只有"真在浏览器里点一次"才会暴露，
// 所以把它们拉到 node 里检查（Klook 实测就撞过 schema is not defined 与 classic SW 不支持 import()）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 收集从入口出发、沿静态 import 能走到的全部模块（相对仓库根的路径） */
function moduleGraph(entries) {
  const seen = new Set();
  const resolve = (fromFile, spec) => {
    if (!spec.startsWith('.')) return null;                       // 扩展 API 之外的东西不管
    const abs = new URL(spec, new URL(`../${fromFile}`, import.meta.url));
    if (abs.protocol !== 'file:') return null;
    return path.relative(repoRoot, fileURLToPath(abs)).split(path.sep).join('/');
  };
  const stack = [...entries];
  while (stack.length) {
    const f = stack.shift();
    if (seen.has(f) || !fs.existsSync(root(`../${f}`))) continue;
    seen.add(f);
    const src = fs.readFileSync(root(`../${f}`), 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]{0,200}?from\s+['"](\.[^'"]+)['"]/g)) {
      const next = resolve(f, m[1]);
      if (next) stack.push(next);
    }
    // 两类写法都要认：普通 `import('./x.js')`，和 content.js 的 `import(u('dom/scanner.js'))`
    // —— u() 给的是"相对扩展根"的路径，不认这一类就等于图只有一层，测试形同虚设。
    for (const m of src.matchAll(/import\(\s*u\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g)) stack.push(m[1]);
    for (const m of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const next = resolve(f, m[1]);
      if (next) stack.push(next);
    }
  }
  return [...seen];
}

test('内容脚本能触达的每个模块都必须在 web_accessible_resources 里（走完整 import 图）', () => {
  // 曾经只检查 content.js 里字面写了的那几个路径：给 dom/filler.js 加一句
  // import './select-opener.js' 就静默漏掉，真实浏览器里整个扫描直接挂。
  const graph = moduleGraph(['dom/content.js']);
  assert.ok(graph.length >= 8, `import 图只抓到 ${graph.length} 个文件，多半是解析写错了`);
  const war = (manifest.web_accessible_resources || []).flatMap(e => e.resources || []);
  for (const p of graph) {
    if (p === 'dom/content.js') continue;                          // 入口本身由 content_scripts 注入
    assert.ok(fs.existsSync(root(`../${p}`)), `${p} 被引用但不存在`);
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

/**
 * 设置项穿线：面板有勾、matcher 会读，中间的 content.js 忘了传就是"界面上骗人"。
 * 这类断链在 jsdom 里测不到（内容脚本要真浏览器），所以在源码层面钉死：
 * handleScan 的每个入参都必须 ① 自己用掉 ② 由 nw:scan 监听传进来。
 */
test('handleScan 的每个入参都要真的被用掉，也要真的由 nw:scan 传进来', () => {
  const src = read('../dom/content.js');
  const sig = src.match(/async function handleScan\(\{([^}]*)\}\)/);
  assert.ok(sig, '没抓到 handleScan 的解构签名');
  const params = sig[1].split(',').map(s => s.trim().split(/[\s:=]/)[0]).filter(Boolean);
  assert.ok(params.length >= 6, `只抓到 ${params.length} 个入参，正则八成没匹配上`);
  const body = src.slice((sig.index || 0) + sig[0].length).split('chrome.runtime.onMessage')[0];
  assert.ok(body.includes('matcher.planFill'), '函数体没截到 planFill 调用');
  for (const p of params) {
    assert.ok(new RegExp(`\\b${p}\\b`).test(body), `${p} 传进 handleScan 却没人读它：这个设置等于没生效`);
  }
  const listener = src.split("msg?.type === 'nw:scan'")[1]?.split("'} else if")[0]
    || src.split("msg?.type === 'nw:scan'")[1]?.split('else if')[0];
  assert.ok(listener, "没抓到 nw:scan 监听体");
  for (const p of params) {
    assert.ok(new RegExp(`\\b${p}\\s*:`).test(listener), `${p} 从没被 nw:scan 传过：handleScan 永远只能拿到默认值`);
  }
});

/**
 * 模型原文（call.content）只能喂给解析函数或用于计数，绝不能进给侧边栏的回包 ——
 * 界面看到的是解析结果与脱敏后的 snippet。这条是给"顺手把 content 也回给前端"准备的。
 */
test('service worker 里的模型原文只用于本机解析，不进任何回包', () => {
  const sw = read('../background/service-worker.js');
  const uses = [...sw.matchAll(/call\.content/g)];
  assert.ok(uses.length >= 4, `只抓到 ${uses.length} 处 call.content 引用，正则没生效`);
  for (const u of uses) {
    const from = sw.lastIndexOf('\n', u.index) + 1;
    const to = sw.indexOf('\n', u.index + u[0].length);
    const line = sw.slice(from, to < 0 ? undefined : to);
    assert.ok(
      /parseAiResponse\(call\.content|parseExtractResponse\(call\.content|String\(call\.content \|\| ''\)\.length/.test(line),
      `原文被用在了"解析 / 计数"之外：${line.trim()}`,
    );
  }
  assert.ok(!/content:\s*call\.content/.test(sw), '回包字段里出现了模型原文');
});

/**
 * 出网代码必须只有一处实现。重构后 fetch 在 core/ai-endpoint.js 里，
 * service worker 再出现裸 fetch(chat) 就意味着两条链路各写一套端点/脱敏规则（会漂移）。
 */
test('AI 出网只有 core/ai-endpoint.js 一处：service worker 里不许再手写 chat/completions', () => {
  const sw = read('../background/service-worker.js');
  assert.ok(!/chat\/completions/.test(sw), 'service worker 里又出现了端点拼接：请改 core/ai-endpoint.js');
  assert.match(sw, /callChatEndpoint/, '没走统一的出网函数');
  const ep = read('../core/ai-endpoint.js');
  assert.match(ep, /redirect:\s*'error'/, '禁跟跳转是 Key 不外泄的一条实闸');
  assert.match(ep, /authorization: 'Bearer '/, '请求头形状变了');
});

/**
 * 版本号只能有一处定义。以前探针自己写一个日期、页面另写一个，
 * 用户报"我重载了"时我们无从判断他跑的到底是哪一份 —— 现在两侧对撞同一个常量。
 */
test('构建号只在 core/build.js 里定义，其他层一律 import 它', () => {
  const src = read('../core/build.js');
  assert.match(src, /export const BUILD = '\d{4}-\d{2}-\d{2}-\d+';/, 'BUILD 的形状是 日期-序号');
  for (const f of ['dom/probe.js', 'background/service-worker.js', 'ui/sidepanel.js']) {
    const s = read(`../${f}`);
    assert.match(s, /from '[^']*core\/build\.js'/, `${f} 没有 import 构建号`);
    assert.ok(!/=\s*['\"]20\d\d-\d\d-\d\d(-\d+)?['\"]/.test(s), `${f} 里又写了一个自己的日期版本号`);
  }
  // 后台要把版本号带回界面，界面才可能发现"重载没生效"
  const sw = read('../background/service-worker.js');
  assert.match(sw, /build: BUILD/, 'getState/unknown_message 的回包没带构建号');
});
