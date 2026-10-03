import fs from 'node:fs';
const p = 'dom/row-adder.js';
const raw = fs.readFileSync(p, 'utf8');
const nl = raw.includes('\r\n') ? '\r\n' : '\n';
const L = raw.split(/\r?\n/);
const iNot = L.findIndex(l => l.startsWith('export const NOT_ADD_ROW_RE'));
const iAdd = L.findIndex(l => l.startsWith('export const ADD_ROW_RE'));
if (iNot < 0 || iAdd < 0) { console.error('anchors missing'); process.exit(1); }
L[iNot] = "export const NOT_ADD_ROW_RE = /(附件|文件|简历|推荐人|内推|投递|应聘|下载|删除|去掉|移除|清空|重置|提交|保存|发送|上传|下一步|上一页|下一页|退出|登录|验证|attachment|\bfile\b|resume|referr|applic|delete|remove|clear|reset|submit|save|upload|download|next|prev|logout|sign\s?in|captcha)/i;";
L.splice(iAdd, 1,
  '// 「段/条/行/记录/经历」这类量词是这一类按钮的身份证：只写「添加」两字的那枚，',
  '// 在真站点上更多是「添加附件」「添加推荐人」，不是「再加一段经历」。',
  'export const ADD_ROW_RE = /((添加|新增|再加|增加|补充)[^。]{0,6}(一段|一条|一行|一项|更多|其他|另一|一段记录|经历|经验)|再?加?[^。]{0,3}(一段|一条|一行|一条记录)|(add|new)\s+(another|more|row|record|entry|experience|section)|\+\s*(添加|一段|一条|经验|经历|row|more))/i;',
  '/** 文字里明确点出"这是一段/一条记录"，优先级高于只写「添加」的那一枚 */',
  'export const ROWISH_RE = /(一段|一条|一行|一项|一条记录|经历|经验|记录|条目|another|row|record|entry|experience|section)/i;',
);
const iSort = L.findIndex(l => l.includes('cands.sort((a, b) => String(a.textContent'));
if (iSort < 0) { console.error('sort line missing'); process.exit(1); }
L.splice(iSort, 1,
  '  // 排序判据：① 文字里点明"一段/一条/记录"的先（这一档要能压过「添加附件」那种只写「添加」的）；',
  '  // ② 同档再按文字短的优先（短的多半就是那枚加号本体）。',
  '  const rank = el => (ROWISH_RE.test(String(el.textContent || \'\')) ? 0 : 1);',
  '  cands.sort((a, b) => rank(a) - rank(b) || String(a.textContent || \'\').length - String(b.textContent || \'\').length);',
);
const iDoc = L.findIndex(l => l.includes('/** 在一节范围内找那枚加号'));
if (iDoc >= 0) L[iDoc] = '/** 在一节范围内找那枚加号：容器内（含容器自身）所有能确认的元素，先"像加一段"的、再文字短的 */';
fs.writeFileSync(p, L.join(nl));
console.log('regexes + ranking patched');
