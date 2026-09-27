// 生成 core/high-frequency.json：哪些 profile 槽位是"站点真的会问"的。
// 依据不是我的猜测，而是 tools/expected/*.json —— 那七份判分标准逐条复刻自 13 份真实站点导出。
// 用法：node tools/gen-high-frequency.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'tools', 'expected');

const count = new Map();
const forms = [];
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const want = j.expect || {};
  forms.push(file.replace(/\.json$/, ''));
  for (const v of Object.values(want)) {
    for (const p of Array.isArray(v) ? v : [v]) count.set(p, (count.get(p) || 0) + 1);
  }
}

const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: 'tools/expected/*.json 的期望路径（复刻自真实站点导出结构）',
  forms,
  note: '被越多张表单问到的槽位越"高频"：这些空着，网申时就会大面积标橙交人工。生成命令：node tools/gen-high-frequency.mjs',
  paths: Object.fromEntries([...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
};

fs.writeFileSync(path.join(root, 'core', 'high-frequency.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`写入 core/high-frequency.json：${count.size} 个槽位，来自 ${forms.length} 份判分标准`);
console.log('最高频前 12：', [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([p, n]) => `${p}×${n}`).join(' '));
