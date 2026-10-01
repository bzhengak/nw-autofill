// 「导出没填的字段与选项」的纯函数层。
// 这份导出存在的意义：用户实测里最贵的一轮往返是"这页 28 个 checkbox 一个都没勾上"，
// 而决定能不能填上的是**选项可见文案 ↔ 提交码值**这张对照表。所以它必须
// ① 只带没填上的（否则文件被已成功的噪音淹没）；② 一定带 options 的 text+value；
// ③ 绝不带简历里的取值（导出物是要粘贴给别人看的）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildUnfilledMap, describeUnfilledMap, plainField } from '../core/option-map.js';

const F = (over = {}) => ({
  kind: 'text', label: '', labelRaw: '', name: '', id: '', placeholder: '',
  required: false, multi: false, nearbyLabels: [], options: [], currentValue: '',
  className: '', el: { nodeType: 1 }, ...over,
});

const fields = [
  F({ kind: 'radio', label: '是否有亲属在本系统', name: 'relative',
    options: [{ text: '是', value: 'Y' }, { text: '否', value: 'N' }] }),
  F({ kind: 'checkbox', label: '技能', name: 'skill', multi: true,
    options: [{ text: 'python', value: 'PY' }, { text: 'sql', value: 'SQL' }] }),
  F({ kind: 'text', label: '期望工作城市', name: 'city' }),
  F({ kind: 'combobox', label: '户口所在地', options: [{ text: '南京市', value: '320100' }] }),
  F({ kind: 'text', label: '已填好的栏', name: 'done' }),
];
const gaps = [
  { index: 0, label: '是否有亲属在本系统', reason: 'no_candidate', kind: 'radio' },
  { index: 1, label: '技能', reason: 'custom_control', kind: 'checkbox', note: '多选组要你确认' },
  { index: 2, label: '期望工作城市', reason: 'required_no_candidate', kind: 'text' },
  { index: 3, label: '户口所在地', reason: 'option_missing', kind: 'combobox' },
];
const results = [{ index: 4, path: 'basics.name', label: '已填好的栏', status: 'green', actual: '已填好的栏' }];

test('导出只带没填上的，并把"选项文案 ↔ 码值"完整带出来', () => {
  const m = buildUnfilledMap({ fields, gaps, results, url: 'https://careersite.tupu360.test/a', build: 'x-1', profileFilled: 37 });
  assert.deepEqual(m.rows.map(r => r.index), [0, 1, 2, 3], '已写成功的该被跳过，没填上的一个都不能少');
  assert.equal(m.totals.filledSkipped, 1);
  assert.equal(m.totals.withOptions, 3, '带选项的控件数');
  assert.equal(m.totals.optionCount, 5, '选项总数 = 对照表行数（2+2+1）');
  const radio = m.rows.find(r => r.index === 0);
  assert.deepEqual(radio.options, [{ text: '是', value: 'Y' }, { text: '否', value: 'N' }], '对照表就是这个文件的价值');
  assert.equal(radio.reason, 'no_candidate');
  assert.equal(m.byReason.no_candidate, 1);
  assert.equal(m.build, 'x-1', '导出要能对上构建号，否则修完规则分不清跑的哪一份');
  assert.ok(m.legend.some(l => l.includes('码值')), '文件里要自带读法说明，用户不用回来问');
});

test('勾上「把已填的也带上」时才带成功项，并写明它填成了什么', () => {
  const m = buildUnfilledMap({ fields, gaps, results }, { includeFilled: true });
  const done = m.rows.find(r => r.index === 4);
  assert.ok(done, 'includeFilled 时该把已写入的也带上');
  assert.equal(done.status, 'green');
  assert.equal(done.reason, 'filled');
  assert.equal(done.writtenBack, '已填好的栏');
});

test('导出里不出现资料取值：plain 化只取页面属性，DOM 节点必须被剥掉', () => {
  const p = plainField(fields[0]);
  assert.ok(p && !('el' in p), 'DOM 节点混进导出（会带出整棵子树）');
  const json = JSON.stringify(buildUnfilledMap({ fields, gaps, results }));
  // profileFilled 是"资料里有几栏填了"这个计数，允许出现；带数据的 "profile": 键绝不允许
  for (const banned of ['"el"', 'nodeType', '"profile":', 'ownerText', '__nwGroup']) {
    assert.ok(!json.includes(banned), `导出里出现了 ${banned}`);
  }
  // 页面自己显示的选中项要保留（那是站点的状态，用户核对时正需要它），但不来自资料
  const withCurrent = JSON.stringify(buildUnfilledMap({
    fields: [F({ kind: 'select', label: '学历', options: [{ text: '本科', value: 'B' }], currentValue: '本科' })],
    gaps: [{ index: 0, reason: 'no_candidate' }], results: [],
  }));
  assert.ok(withCurrent.includes('本科'), 'currentValue 丢了就看不出站点已经选了什么');
});

test('摘要一句话讲清"导了多少、其中几个带选项"，别让人去数 JSON', () => {
  const line = describeUnfilledMap(buildUnfilledMap({ fields, gaps, results }));
  assert.match(line, /导出 4 个控件/);
  assert.match(line, /3 个带选项/);
  assert.match(line, /码值/);
});
