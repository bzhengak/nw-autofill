// AI 辅助导入的边界测试。这里守的是四条线：
//  · 只发本地判不动的片段，不发整份简历，也不带别的槽位取值；
//  · 号码类内容一律不出门；
//  · 模型必须逐字摘抄，改写/换格式/发明内容全部丢弃；
//  · 落库只填空槽，除非用户明确要覆盖。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractFragments, buildExtractRequest, parseExtractResponse, verbatimSpan, applyExtracted } from '../core/ai-extract.js';
import { createEmptyProfile, setValueByPath, getValueByPath } from '../core/profile-schema.js';

const profileWith = o => {
  const p = createEmptyProfile();
  for (const [k, v] of Object.entries(o)) setValueByPath(p, k, v);
  return p;
};

const FRAG = [
  { i: 0, heading: '求职意向', text: '意向城市：深圳 / 广州，可两周内到岗', why: 'unrouted_heading' },
  { i: 1, heading: '其他', text: '英语六级 552 分，普通话二级甲等', why: 'unrouted_heading' },
];

test('unplaced 与联系行残留片段一起进候选，重复的不算两条', () => {
  const fs = extractFragments({
    unplaced: [
      { heading: '校园', lines: ['   优秀学生干部 ', ''] },
      { heading: '校园', lines: ['优秀学生干部'] },
    ],
    warnings: ['联系行有无法归类的片段：「江苏南京」'],
  });
  assert.deepEqual(fs.map(f => f.text), ['优秀学生干部', '江苏南京']);
  assert.deepEqual(fs.map(f => f.i), [0, 1], '编号必须连续，预览和返回靠它对得上');
});

test('号码类片段整段不发（身份证 / 护照 / 银行卡连号）', () => {
  const req = buildExtractRequest({
    fragments: [
      { i: 0, heading: '基本信息', text: '身份证号 320102199001019999', why: 'x' },
      { i: 1, heading: '基本信息', text: '护照 E12345678', why: 'x' },
      { i: 2, heading: '基本信息', text: '卡号 6222 0210 1234 5678 9012', why: 'x' },
      { i: 3, heading: '语言', text: '英语六级 552 分', why: 'x' },
    ],
    profile: profileWith({}),
  });
  assert.deepEqual(req.fragments.map(f => f.i), [3], '只有正常片段能出门');
  assert.deepEqual(req.blocked.map(b => b.reason), ['sensitive_in_fragment', 'sensitive_in_fragment', 'sensitive_in_fragment']);
  assert.ok(!req.text.includes('320102199001019999'), '被拦的号码还留在待发文本里');
});
test('请求文本只含待发片段与槽位名，别的简历取值一概不带', () => {
  const profile = profileWith({ 'contact.phone': '13800001111', 'basics.name': '王小明', 'education.0.school': '南京大学' });
  const req = buildExtractRequest({ fragments: FRAG, profile });
  assert.ok(req.text.includes('意向城市：深圳'), '该发的片段没发出去');
  for (const secret of ['13800001111', '王小明', '南京大学']) {
    assert.ok(!req.text.includes(secret), `不该出门的取值出现在请求里：${secret}`);
  }
  assert.ok(!req.text.includes('"value"'), '槽位表里不该带取值字段');
});

test('逐字判据：改标点、换日期格式、拼两段都算改写', () => {
  const text = '意向城市：深圳 / 广州，可两周内到岗';
  assert.equal(verbatimSpan(text, '深圳'), '深圳');
  assert.equal(verbatimSpan(text, '深圳 / 广州'), '深圳 / 广州');
  assert.equal(verbatimSpan(text, '深圳/广州'), '', '去掉原文空格就是改写');
  assert.equal(verbatimSpan(text, '广州、深圳'), '', '换了顺序就是改写');
  assert.equal(verbatimSpan(text, '可一个月内到岗'), '', '原文里没有的说法必须挡下');
});

test('返回校验：非逐字 / 陌生槽位 / 禁发槽位 / 重复槽位各有拒绝理由', () => {
  const profile = profileWith({});
  const raw = JSON.stringify([
    { i: 0, p: 'intent.cities', v: '深圳 / 广州' },
    { i: 0, p: 'intent.cities', v: '深圳' },
    { i: 1, p: 'languages.0.level', v: '552分（六级）' },
    { i: 1, p: 'totally.made.up', v: '英语六级' },
    { i: 9, p: 'basics.name', v: '王小明' },
    { i: 1, p: 'basics.idNumber', v: '英语六级' },
  ]);
  const { accepted, rejected } = parseExtractResponse(raw, { fragments: FRAG, profile });
  assert.deepEqual(accepted.map(a => a.path), ['intent.cities']);
  assert.deepEqual(accepted[0].value, '深圳 / 广州', '落地值必须是原文子串');
  const reasons = rejected.map(r => r.reason).sort();
  assert.deepEqual(reasons, ['duplicate_path', 'forbidden_slot', 'not_verbatim', 'unknown_fragment', 'unknown_path']);
});

test('落库只填空槽；勾了覆盖才动已有值，且每一步都带原文出处', () => {
  const profile = profileWith({ 'intent.cities': '上海' });
  const { accepted } = parseExtractResponse(
    JSON.stringify([{ i: 0, p: 'intent.cities', v: '深圳 / 广州' }, { i: 1, p: 'languages.0.cert', v: '英语六级' }]),
    { fragments: FRAG, profile },
  );
  const got = applyExtracted(profile, accepted, {
    setValue: (p, path, v) => setValueByPath(p, path, v),
    getValue: (p, path) => getValueByPath(p, path),
  });
  assert.equal(got.written.length, 1);
  assert.equal(got.skipped[0].reason, 'occupied');
  assert.equal(getValueByPath(profile, 'intent.cities'), '上海', '没勾覆盖就不许动');
  assert.equal(getValueByPath(profile, 'languages.0.cert'), '英语六级');
  assert.equal(got.written[0].from, '其他', '写入项要能回指它是从哪一段来的');

  const again = applyExtracted(profile, accepted, {
    overwrite: true,
    setValue: (p, path, v) => setValueByPath(p, path, v),
    getValue: (p, path) => getValueByPath(p, path),
  });
  assert.equal(again.written.find(w => w.path === 'intent.cities').replaced, true);
  assert.equal(getValueByPath(profile, 'intent.cities'), '深圳 / 广州');
});

test('片段总量有上限，超了就标 budget 而不是把整份简历发出去', () => {
  const big = Array.from({ length: 60 }, (_, k) => ({ i: k, heading: 'h' + k, text: `第${k}段内容，足够长一些以便把预算用完：` + '字'.repeat(120), why: 'x' }));
  const req = buildExtractRequest({ fragments: big, profile: profileWith({}) });
  assert.ok(req.fragments.length < big.length, '一条都没拦');
  assert.ok(req.blocked.some(b => b.reason === 'budget'));
  const sentChars = req.fragments.reduce((a, f) => a + f.text.length, 0);
  assert.ok(sentChars <= 6000, `片段合计 ${sentChars} 字，超出预算`);
});

test('模型输出外面套了 ``` 或多余解释也还能解析（但只取数组内的项）', () => {
  const { accepted, rejected } = parseExtractResponse(
    '```json\n[{"i":1,"p":"languages.0.cert","v":"英语六级"}]\n```\n希望对你有帮助',
    { fragments: FRAG, profile: profileWith({}) },
  );
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 0);
});

test('解析不出来时整批拒绝，不猜', () => {
  const { accepted, rejected } = parseExtractResponse('我觉得这一段应该放进意向城市', { fragments: FRAG, profile: profileWith({}) });
  assert.equal(accepted.length, 0);
  assert.deepEqual(rejected, [{ reason: 'unparsable' }]);
});

test('槽位表归并后请求体明显变小，但校验仍按完整白名单走', () => {
  const req = buildExtractRequest({ fragments: FRAG, profile: profileWith({}) });
  const bytes = new TextEncoder().encode(req.text).length;
  assert.ok(bytes < 20000, `请求体 ${bytes} 字节，槽位表没压下去`);
  assert.ok(req.text.includes('work.N.company'), '列表型槽位应压成 N 形式');
  assert.ok(/"r":"0-\d+"/.test(req.text), '要带上可取的序号范围');
  // 压缩只影响"怎么说"：具体路径照样收
  const { accepted } = parseExtractResponse(JSON.stringify([{ i: 0, p: 'intent.cities', v: '深圳' }]), { fragments: FRAG, profile: profileWith({}) });
  assert.equal(accepted.length, 1);
});

test('模型把模板路径原样交回来时，由本地补一个"当前为空"的序号并标明', () => {
  const profile = profileWith({ 'campus.0.org': '已有的第一个社团' });
  const { accepted } = parseExtractResponse(
    JSON.stringify([{ i: 1, p: 'campus.N.org', v: '英语六级' }]),
    { fragments: [{ i: 1, heading: '校园', text: '英语六级 志愿队队长', why: 'x' }], profile },
  );
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].path, 'campus.1.org', '第 0 条已被占，应补到第 1 条空位');
  assert.equal(accepted[0].indexFilled, true, '序号是本地补的，界面必须标出来');
});

test('模板路径没有对应槽位时照样 unknown_path，不做"大概放进哪一段"的猜测', () => {
  const { accepted, rejected } = parseExtractResponse(
    JSON.stringify([{ i: 0, p: 'nosuch.N.field', v: '深圳 / 广州' }]),
    { fragments: FRAG, profile: profileWith({}) },
  );
  assert.equal(accepted.length, 0);
  assert.equal(rejected[0].reason, 'unknown_path');
});

test('号码识别不能把正常简历内容一起拦掉（列年份、日期区间、GPA、手机号都该放过）', async () => {
  const { looksLikeNumberSecret } = await import('../core/ai-extract.js');
  const block = [
    '身份证号 320102199001019999',
    '护照号 E12345678',
    '卡号 6222 0210 1234 5678 9012',
    '202209301234567',            // 连续 15 位
  ];
  const allow = [
    '2021 2022 2023 2024 连续四年拿奖学金',   // 分组全是年份：不是卡号
    '2022.09-2023.06 任副部长',
    'GPA 3.8/4.0，排名 5/120',
    '电话 13800001111',
    '英语六级 552 分',
  ];
  for (const t of block) assert.equal(looksLikeNumberSecret(t), true, `该拦的没拦：${t}`);
  for (const t of allow) assert.equal(looksLikeNumberSecret(t), false, `误拦正常内容：${t}`);
});

test('被拦下的片段要把原文开头交出去，不能静默少发一段', () => {
  const req = buildExtractRequest({
    fragments: [
      { i: 0, heading: '基本信息', text: '身份证号 320102199001019999', why: 'x' },
      { i: 1, heading: '获奖', text: '2021 2022 连续四年奖学金', why: 'x' },
    ],
    profile: profileWith({}),
  });
  assert.equal(req.fragments.length, 1);
  assert.match(req.blocked[0].head, /^身份证号/, '预览里要能看出是哪一段被拦了');
  assert.ok(req.blocked[0].head.length <= 24, '只给开头，别把整段号码搬到界面上');
  assert.ok(!req.text.includes('320102199001019999'));
});
