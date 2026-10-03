import fs from 'node:fs';
const p = 'tests/row-expand-bridge.test.js';
let c = fs.readFileSync(p, 'utf8');
const nl = c.includes('\r\n') ? '\r\n' : '\n';
const old = [
  'const PAGE = `<form><div id="intern">',
  '    <h3>实习经历</h3>',
  '    <div class="ant-form-item"><label for="c0">公司名称</label><input id="c0" name="company"></div>',
  '    <div class="ant-form-item"><label for="d0">职责描述</label><input id="d0" name="duty"></div>',
  '    <a id="add" class="ant-btn" href="javascript:void(0)">+ 添加一段实习经历</a>',
  '  </div>',
  '  <div class="ant-form-item"><label for="nm">姓名</label><input id="nm" name="name"></div>',
  '</form>`;',
].join(nl);
const neu = [
  '// 姓名排在实习块**之前**：否则扫描器会因为板块标题的走向把它也算进 internship，',
  '// 那一节的容器就退化成整个 <form>，"新行长在容器之外"这种情形根本构造不出来。',
  'const PAGE = `<form>',
  '  <div class="ant-form-item"><label for="nm">姓名</label><input id="nm" name="name"></div>',
  '  <div id="intern">',
  '    <h3>实习经历</h3>',
  '    <div class="ant-form-item"><label for="c0">公司名称</label><input id="c0" name="company"></div>',
  '    <div class="ant-form-item"><label for="d0">职责描述</label><input id="d0" name="duty"></div>',
  '    <a id="add" class="ant-btn" href="javascript:void(0)">+ 添加一段实习经历</a>',
  '  </div>',
  '</form>`;',
].join(nl);
if (!c.includes(old)) { console.error('PAGE block not found'); process.exit(1); }
c = c.replace(old, neu);
// 去掉调试行
c = c.split(nl).filter(l => !l.includes("console.log('IDS'")).join(nl);
fs.writeFileSync(p, c);
console.log('PAGE reordered');
