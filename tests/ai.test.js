// 混合 AI 兜底的安全边界回归。这里钉的不是"AI 准不准"，而是三条不可谈判的边界：
// 取值不许离开本机、AI 只能选路径不能造值、AI 的结果永远是黄字。
// 全程不联网：请求构造与响应解析都是纯函数，网络只在 service worker 里发生。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAiRequest, assertNoProfileValues, parseAiResponse, applyAiCandidates, aiSlotCatalog, aiEligibleGaps, interpretAiReply, compactSlotCatalog, AI_MAX_BYTES } from '../core/ai.js';
import { createEmptyProfile, setValueByPath, buildFields, getValueByPath } from '../core/profile-schema.js';
import { sampleProfile } from './fixtures/sample-profile.js';
import { planFill } from '../core/matcher.js';
import { scanForm } from '../dom/scanner.js';
import { JSDOM } from 'jsdom';

function richProfile() {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', '欧阳中华');
  setValueByPath(p, 'contact.email', 'ouyang@example.test');
  setValueByPath(p, 'contact.phone', '13900002222');
  setValueByPath(p, 'work.0.company', '寰宇智能装备集团');
  setValueByPath(p, 'work.0.title', '嵌入式固件负责人');
  setValueByPath(p, 'work.0.summary', '主导电机控制板固件重构，量产十二万片');
  setValueByPath(p, 'basics.idNumber', '330105199912034567');
  setValueByPath(p, 'education.0.school', '华南理工大学');
  setValueByPath(p, 'basics.lastName', '欧阳');
  setValueByPath(p, 'intent.cities', '上海、杭州、深圳');
  return p;
}

const PLAN = { gaps: [{ index: 3, label: '中文姓', reason: 'no_candidate', kind: 'text' }] };
const PAGEFIELDS = [null, null, null, { kind: 'text', label: '中文姓', labelRaw: '中文姓', options: [], nearbyLabels: [] }];

test('请求文本里不许出现任何已填写的取值：植入了就拒绝发送', () => {
  const p = richProfile();
  const req = buildAiRequest({ plan: PLAN, profile: p, pageFields: PAGEFIELDS });
  const scan = () => assertNoProfileValues(req.text, p, { exempt: [req.slotSection] });
  assert.deepEqual(scan(), [], `这些取值漏进了请求体：${JSON.stringify(scan())}`);
  // 反向证明这条检查真的会响：把取值写进待发文本，必须被抓出来
  const planted = req.text + '\n补充说明：' + getValueByPath(p, 'work.0.summary');
  const leaks = assertNoProfileValues(planted, p, { exempt: [req.slotSection] });
  assert.ok(leaks.length >= 1, '取值泄漏没被自检抓到，等于边界是假的');
  assert.match(leaks[0].path, /summary/, `泄漏定位要指到具体槽位，实得 ${leaks[0].path}`);
});

test('证件号/签证/薪酬/声明类路径根本不进白名单，AI 连提名机会都没有', () => {
  const paths = aiSlotCatalog(richProfile()).map(s => s.path);
  for (const bad of ['basics.idNumber', 'basics.passportNumber', 'hkGlobal.visaType', 'work.0.salary', 'intent.salary', 'records.noCriminal']) {
    assert.ok(!paths.includes(bad), `${bad} 不该出现在可提名槽位里`);
  }
  assert.ok(paths.includes('basics.lastName'), '白名单不能一路收紧到什么都不剩');
  assert.ok(paths.length > 100, `白名单只剩 ${paths.length} 个槽位，AI 基本无从下手`);
  // 白名单里只有路径与中文名，没有取值、没有 profile 结构
  const catalogText = JSON.stringify(aiSlotCatalog(richProfile()));
  assert.ok(!catalogText.includes('寰宇'), '槽位目录里混进了取值');
});

test('AI 只能从白名单里挑：陌生 path、越界 index、看不懂的回答，全部丢弃并说明原因', () => {
  const allowed = new Set(['basics.lastName', 'basics.firstName']);
  const asked = new Set([3]);
  const r = parseAiResponse('{"matches":['
    + '{"index":3,"path":"basics.lastName","reason":"中文姓=姓"},'
    + '{"index":3,"path":"secret.salary","reason":"越界"},'
    + '{"index":99,"path":"basics.firstName","reason":"没问过这栏"},'
    + '{"index":7,"path":"basics.firstName"}]}', { allowedPaths: allowed, askedIndexes: asked });
  assert.deepEqual(r.candidates, [{ index: 3, path: 'basics.lastName', reason: '中文姓=姓' }]);
  const reasons = r.dropped.map(d => d.reason).sort();
  assert.deepEqual(reasons, ['unknown_index', 'unknown_index', 'unknown_path'],
    `越界 index 有两个（99 与 7）、陌生 path 一个，都要各自丢弃：${JSON.stringify(r.dropped)}`);
  const junk = parseAiResponse('抱歉，我觉得这栏应该填姓名', { allowedPaths: allowed, askedIndexes: asked });
  assert.equal(junk.candidates.length, 0);
  assert.equal(junk.dropped[0].reason, 'unparsable');
});

test('AI 的建议一律黄字，且值永远由本地从 profile 取（AI 造不出值）', () => {
  const p = richProfile();
  const dom = new JSDOM('<input name="xq">');
  const fields = scanForm(dom.window.document);
  const plan = planFill(fields, p, { mode: 'full' });
  plan.gaps = [{ index: 0, label: '期望服务地区', reason: 'no_candidate', kind: 'text' }];
  plan.assignments = [];
  const merged = applyAiCandidates(plan, p, [{ index: 0, path: 'intent.cities', reason: '服务地区≈意向城市' }]);
  assert.equal(merged.assignments.length, 1);
  const a = merged.assignments[0];
  assert.equal(a.tier, 'review', 'AI 选的路径永远不许绿字');
  assert.equal(a.aiChosen, true);
  assert.equal(a.value, getValueByPath(p, 'intent.cities'), '写入值必须是资料里原有的值，不是 AI 生成的');
  // 资料里那栏空着 → 不许写，变成一条能看懂的缺口
  const empty = createEmptyProfile();
  const merged2 = applyAiCandidates({ gaps: plan.gaps, assignments: [], stats: plan.stats }, empty, [{ index: 0, path: 'intent.cities' }]);
  assert.equal(merged2.assignments.length, 0);
  assert.equal(merged2.gaps[0].reason, 'ai_empty_slot');
  assert.match(merged2.gaps[0].note, /你资料里那栏是空的/);
});

test('AI 选中的敏感槽位仍要走「允许填写敏感字段」那道闸：不能因为换了个来源就绕过', () => {
  const p = richProfile();
  const plan = { gaps: [{ index: 0, label: '中文名', reason: 'no_candidate', kind: 'text' }], assignments: [], stats: { review: 0 } };
  const off = applyAiCandidates(plan, p, [{ index: 0, path: 'basics.lastName' }], { fillSensitive: false });
  assert.equal(off.assignments.length, 0, '没勾就不许写，AI 提名也不例外');
  assert.equal(off.gaps[0].reason, 'sensitive_withheld');
  const on = applyAiCandidates(plan, p, [{ index: 0, path: 'basics.lastName' }], { fillSensitive: true });
  assert.equal(on.assignments.length, 1);
  assert.equal(on.assignments[0].tier, 'review', '即便勾了敏感字段，AI 选的仍然只能是黄字');
});

test('只有本地词典答不上来的缺口才配问 AI；验证码/附件/声明类绝不外送', () => {
  const gaps = [
    { index: 1, reason: 'no_candidate' },
    { index: 2, reason: 'required_no_candidate' },
    { index: 3, reason: 'conflict_unresolved' },
    { index: 4, reason: 'captcha' },
    { index: 5, reason: 'file' },
    { index: 6, reason: 'consent_declaration' },
    { index: 7, reason: 'subjective' },
    { index: 8, reason: 'sensitive_withheld' },
  ];
  assert.deepEqual(aiEligibleGaps(gaps).map(g => g.index), [1, 2, 3]);
});

test('端到端（不联网）：一次真实的"卡住 → 建议 → 落地"只能产出黄字', async () => {
  const { applyPlan } = await import('../dom/filler.js');
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', '赵东');
  setValueByPath(p, 'family.0.name', '赵大山');
  // 页面上是一栏本地词典确实没有的说法（葡语：你的联系人是谁？）
  const dom = new JSDOM('<form><label>Quem é a sua pessoa de contacto?</label><input name="pwr"></form>', { url: 'https://x.test/' });
  const fields = scanForm(dom.window.document);
  const plan = planFill(fields, p, { mode: 'full' });
  assert.equal(plan.assignments.length, 0, '前提：本地词典确实答不上这栏');
  assert.equal(plan.gaps[0].reason, 'no_candidate');

  const req = buildAiRequest({ plan, profile: p, pageFields: fields });
  assert.deepEqual(assertNoProfileValues(req.text, p, { exempt: [req.slotSection] }), []);
  assert.match(req.text, /Quem é a sua pessoa de contacto/, '页面字段名必须发出去，否则 AI 无从判断');
  assert.ok(!req.text.includes('赵大山'), '取值出现在请求体里');

  // 模拟一次模型应答（不联网）
  const parsed = parseAiResponse('{"matches":[{"index":0,"path":"family.0.name","reason":"联系人=家庭成员栏"}]}', {
    allowedPaths: new Set(req.slots.map(s => s.path)),
    askedIndexes: new Set(req.gaps.map(g => g.index)),
  });
  assert.equal(parsed.candidates.length, 1);

  // family.0.name 在 schema 里是 sensitive：没勾「允许填写敏感字段」时 AI 也越不过这道闸
  const gated = applyAiCandidates(plan, p, parsed.candidates, { fillSensitive: false });
  assert.equal(gated.assignments.length, 0, 'AI 提名不能绕过敏感字段闸门');
  assert.equal(gated.gaps[0].reason, 'sensitive_withheld');

  const merged = applyAiCandidates(plan, p, parsed.candidates, { fillSensitive: true });
  assert.equal(merged.assignments.length, 1);
  assert.equal(merged.assignments[0].tier, 'review');
  assert.equal(merged.assignments[0].value, '赵大山');

  const { results } = await applyPlan(fields, merged.assignments, {});
  assert.equal(results[0].status, 'yellow', 'AI 选的路径写下去也只能是黄字');
  assert.equal(fields[0].el.value, '赵大山');

  // 下标漂了（页面在两次扫描之间多了一个控件）→ 必须整条丢弃，而不是把答案写进别的栏
  const shifted = applyAiCandidates(plan, p, [{ index: 0, path: 'family.0.name', label: '完全不同的标签' }], {});
  assert.equal(shifted.assignments.length, 0, '索引复核失守就会把 A 栏的答案写进 B 栏');
  assert.equal(shifted.stale.length, 1);
});

test('真实样例资料同样不许泄漏：整份 plan 走一遍自检', () => {
  const p = sampleProfile();
  const dom = new JSDOM('<form><input name="foo"><label>紧急联系人称呼</label><input name="rel"></form>');
  const fields = scanForm(dom.window.document);
  const plan = planFill(fields, p, { mode: 'full' });
  const req = buildAiRequest({ plan, profile: p, pageFields: fields });
  assert.deepEqual(assertNoProfileValues(req.text, p, { exempt: [req.slotSection] }), [], '样例资料的取值出现在了请求体里');
});

// ── "AI 点了没反应"这一类：必须先能自证是哪一种没反应 ─────────────────────
const WL = new Set(['basics.name', 'education.0.school']);
const IX = new Set([3, 7]);

test('响应信封容错：裸数组 / result 键 / i-p 简写都收，但白名单一条不放松', () => {
  const shapes = [
    '{"matches":[{"index":3,"path":"basics.name"}]}',
    '[{"index":3,"path":"basics.name"}]',
    '{"result":[{"index":3,"path":"basics.name"}]}',
    '{"data":{"matches":[{"index":3,"path":"basics.name"}]}}',
    '[{"i":3,"p":"basics.name","why":"页面上写姓名"}]',
    '{"index":3,"path":"basics.name"}',
    '好的：\n```json\n[{"index":3,"path":"basics.name"}]\n```\n希望有帮助',
  ];
  for (const raw of shapes) {
    const r = parseAiResponse(raw, { allowedPaths: WL, askedIndexes: IX });
    assert.equal(r.candidates.length, 1, `这种形状没解析出来：${raw}`);
    assert.equal(r.candidates[0].path, 'basics.name');
  }
  // 形状认了，路径不认：越界的照样丢
  const bad = parseAiResponse('[{"index":3,"path":"basics.idNumber"},{"i":99,"p":"basics.name"}]', { allowedPaths: WL, askedIndexes: IX });
  assert.equal(bad.candidates.length, 0);
  assert.deepEqual(bad.dropped.map(d => d.reason), ['unknown_path', 'unknown_index']);
});

test('interpretAiReply：正文 / 只有思考 / 被截断 / 上游报错 / 不是 JSON，五种空各报各的', () => {
  const ok = interpretAiReply({ choices: [{ message: { content: '[{"index":3,"path":"basics.name"}]' }, finish_reason: 'stop' }] });
  assert.equal(ok.ok, true);
  assert.match(ok.snippet, /basics\.name/);

  const reasoning = interpretAiReply({ choices: [{ message: { content: '', reasoning_content: '让我先想想这个字段应该……' }, finish_reason: 'stop' }] });
  assert.equal(reasoning.error, 'reasoning_only');
  assert.ok(reasoning.reasoningChars > 0);

  const truncated = interpretAiReply({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
  assert.equal(truncated.error, 'truncated');

  const empty = interpretAiReply({ choices: [{ message: { content: '   ' }, finish_reason: '' }] });
  assert.equal(empty.error, 'empty_content');

  const upstream = interpretAiReply({ error: { code: 'model_not_found', message: '未找到该模型' } });
  assert.equal(upstream.error, 'upstream_model_not_found');
  assert.match(upstream.detail, /未找到该模型/);

  assert.equal(interpretAiReply(null).error, 'not_json');
  // Responses API 的 output_text 也要能取到
  const responses = interpretAiReply({ output_text: '[{"index":3,"path":"basics.name"}]' });
  assert.equal(responses.ok, true);
});

test('答案被长度砍断时不能当成"模型没建议"：unparsable 与 truncated 是两回事', () => {
  // 完全截断：一个都解析不出来，报 unparsable，但界面上必须说是"被截断"
  const cut = interpretAiReply({ choices: [{ message: { content: '[{"index":3,"path":"' }, finish_reason: 'length' }] });
  assert.equal(cut.ok, true);
  assert.equal(cut.finishReason, 'length', '界面靠 finish_reason 才能说"是长度截断，少问几栏"');
  const parsed = parseAiResponse(cut.content, { allowedPaths: WL, askedIndexes: IX });
  assert.equal(parsed.candidates.length, 0);
  assert.equal(parsed.dropped[0].reason, 'unparsable');

  // 部分截断：前半段仍然可用 —— 不能因为尾部残缺就把能用的建议丢掉
  const half = interpretAiReply({ choices: [{ message: { content: '[{"index":3,"path":"basics.name"},{"index":7,"path":"' }, finish_reason: 'length' }] });
  const parsedHalf = parseAiResponse(half.content, { allowedPaths: WL, askedIndexes: IX });
  assert.equal(parsedHalf.candidates.length, 1, '截断尾巴把已经答对的那条也拖没了');
  assert.equal(parsedHalf.candidates[0].path, 'basics.name');
});

// ── 请求体体积：填写侧那条链路曾经整条是死的 ─────────────────────────────
// 上限本来写在 service worker 里（12000），而未压缩的槽位目录本身就有 36KB：
// 于是每次「问 AI」都在本机被判 payload_too_large，一个字节都没发出去过。
// 单元测只看函数、界面测只看文案，两边都照不出来 —— 修好之后把体积本身钉住。

test('槽位目录归并后仍覆盖每一条白名单路径，且请求体装得下上限', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.lastName', '欧阳');
  const slots = aiSlotCatalog(p);
  const compact = compactSlotCatalog(slots);
  assert.ok(compact.length < slots.length, '同构重复没归并，体积还是 36KB 那个量级');
  // 归并不能丢槽位：每一条具体路径都要能从某一条目录项还原出来
  const allowed = new Set(slots.map(s => s.path));
  for (const s of slots) {
    const m = /^([a-z]+)\.(\d+)\.(.+)$/i.exec(s.path);
    const generic = m ? `${m[1]}.N.${m[3]}` : s.path;
    assert.ok(compact.some(c => c.p === generic), `${s.path} 在目录里没有对应条目（字面或 N 形式）`);
    assert.ok(allowed.has(s.path));
  }
  const req = buildAiRequest({ plan: PLAN, profile: p, pageFields: PAGEFIELDS, limit: 30 });
  const bytes = new TextEncoder().encode(req.text).length;
  assert.ok(bytes <= AI_MAX_BYTES, `请求体 ${bytes} 字节 > 上限 ${AI_MAX_BYTES}：填写侧又会一发出不了`);
});

test('最坏情况（30 个长标签缺口 + 满选项）也不许越过上限', () => {
  const p = createEmptyProfile();
  const gaps = Array.from({ length: 40 }, (_, i) => ({ index: i, label: 'X'.repeat(160), reason: 'no_candidate' }));
  const fields = Array.from({ length: 40 }, (_, i) => ({
    index: i, kind: 'select', labelRaw: 'Y'.repeat(160),
    options: Array.from({ length: 24 }, (_, j) => ({ text: 'Z'.repeat(40) + j })),
    nearbyLabels: ['附近标签'.repeat(20)], required: true,
  }));
  const req = buildAiRequest({ plan: { gaps }, profile: p, pageFields: fields, limit: 30 });
  const bytes = new TextEncoder().encode(req.text).length;
  assert.ok(bytes <= AI_MAX_BYTES, `最坏情况 ${bytes} 字节 > 上限 ${AI_MAX_BYTES}`);
  // 装得下不是白装的：削了什么必须报出来，否则用户会以为"模型没建议"是自己的问题
  assert.ok(req.trim.level > 0, '超预算却没报告削了哪一层辅助信号');
  assert.match(req.trim.why, /选项|标签|体积/);
  assert.deepEqual(JSON.parse(req.payload.user).fields.length, req.gaps.length, 'payload.user 与真正发出去的那段文本不是同一份');
});

test('模型交回带 N 的归并路径：本地补成第一条并说明是我们补的；陌生路径照样丢', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'work.0.company', '寰宇智能');
  const allowed = new Set(aiSlotCatalog(p).map(s => s.path));
  const got = parseAiResponse('[{"index":3,"path":"work.N.company","reason":"经历单位"}]', { allowedPaths: allowed, askedIndexes: new Set([3]) });
  assert.equal(got.candidates.length, 1, JSON.stringify(got.dropped));
  assert.equal(got.candidates[0].path, 'work.0.company');
  assert.equal(got.candidates[0].nExpanded, true, '没记下"序号是我们补的"');
  assert.ok(got.dropped.every(d => d.reason !== 'unknown_path'), '带 N 的路径被当成非法路径丢了');

  const bad = parseAiResponse('[{"index":3,"path":"records.0.x"}]', { allowedPaths: allowed, askedIndexes: new Set([3]) });
  assert.equal(bad.candidates.length, 0);
  assert.equal(bad.dropped[0].reason, 'unknown_path', '白名单被放宽了');
});

test('AI 落地时的黄字说明要写出"第几条经历是我们补的"', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'work.0.company', '寰宇智能装备');
  const plan = {
    gaps: [{ index: 3, label: 'Company', reason: 'no_candidate', kind: 'text' }],
    assignments: [], stats: { planned: 0, review: 0, gaps: 1 },
  };
  const merged = applyAiCandidates(plan, p, [
    { index: 3, path: 'work.0.company', nExpanded: true, reason: '经历单位' },
  ]);
  assert.equal(merged.assignments.length, 1);
  assert.equal(merged.assignments[0].tier, 'review', 'AI 的结果永远黄字');
  assert.match(merged.assignments[0].note, /第几条经历是我们补的/);
});

test('归并后自检仍然拦得住取值：目录豁免只盖住目录那一串字', () => {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', '欧阳中华绝密');
  const req = buildAiRequest({ plan: PLAN, profile: p, pageFields: PAGEFIELDS, limit: 30 });
  const tampered = { ...req, text: req.text + ' 欧阳中华绝密' };
  const leaks = assertNoProfileValues(tampered.text, p, { exempt: [tampered.slotSection] });
  assert.ok(leaks.length, '取值混进目录以外的地方却没被自检拦下');
  const clean = assertNoProfileValues(req.text, p, { exempt: [req.slotSection] });
  assert.equal(clean.length, 0, '正常请求被自己的豁免规则误拦（归并改动过目录形状）');
});
