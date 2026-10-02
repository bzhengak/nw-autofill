// Key 与端点的安全规则回归。这里钉的是"Key 会不会被发到不该去的地方"，
// 全部是纯函数断言，CI 里没有 chrome、也没有网络。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBaseUrl, sanitizeSettings, sanityCheckKey, maySendKey, redact, SETTING_KEYS, SECRETS_BUCKET, findLeaksInExport, consentAfterSettingsPatch, siteConsentCheck, withSiteConsent, siteConsentAfterEndpoint, SITE_CONSENT_BUCKET, clampTimeoutSec, effectiveTimeoutSec, AI_TIMEOUT_DEFAULT_SEC, clampMaxTokens, effectiveMaxTokens, AI_MAX_TOKENS_DEFAULT, effectiveStream } from '../core/ai-security.js';

test('持久化 Key 只能进独立桶：SECRETS_BUCKET 不在 settings 白名单里', () => {
  assert.equal(SECRETS_BUCKET, 'aiSecrets');
  assert.ok(!SETTING_KEYS.includes(SECRETS_BUCKET), 'settings 会被导出 JSON 带走，Key 不能住在里面');
  assert.ok(!SETTING_KEYS.includes('aiKey'));
  // 就算有人把 Key 塞进 settings 补丁，也照样被拒
  const { clean } = sanitizeSettings({ aiKey: 'sk-abcdefghijklmnop', aiModel: 'x' });
  assert.deepEqual(Object.keys(clean), ['aiModel']);
});

test('导出守卫：内容里带 Key（或带 Key 形状的东西）就拒绝导出', () => {
  const secret = 'sk-abcdefghijklmnop1234567890';
  const probe = JSON.stringify({ url: 'https://x.test', fields: [{ label: '姓名', kind: 'text' }] });
  assert.deepEqual(findLeaksInExport(probe, {}), [], '干净的结构导出不该被误拦');
  assert.ok(findLeaksInExport({ a: 1, b: secret }, {}).length >= 1, '形状匹配没抓到');
  assert.ok(findLeaksInExport({ note: '看这个 ' + secret }, { aiKey: secret }).some(l => l.key === 'aiKey'));
  // 泄漏清单本身只带前缀，不能把整串 Key 再抄一遍到错误信息里
  const report = JSON.stringify(findLeaksInExport({ b: secret }, { aiKey: secret }));
  assert.ok(!report.includes(secret), '错误信息里不该出现完整 Key');
});

test('Base URL 只收 https；本机例外；userinfo / query / 怪协议一律拒', () => {
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1').ok, true);
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1/').url, 'https://api.openai.com/v1', '尾斜杠要归一，否则会拼出 //chat/completions');
  assert.equal(normalizeBaseUrl('http://api.example.com/v1').error, 'insecure', '明文 http 会把 Key 摆在链路上');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:11434/v1').ok, true, '本机跑 Ollama/LM Studio 是常见用法');
  assert.equal(normalizeBaseUrl('http://localhost:1234/v1').ok, true);
  assert.equal(normalizeBaseUrl('https://evil.test@safe.test/v1').error, 'userinfo', '看起来是 safe.test 其实是 evil.test');
  assert.equal(normalizeBaseUrl('https://api.x.test/v1?key=abc').error, 'has_query', '多半是把带 token 的整条链接粘进来了');
  assert.equal(normalizeBaseUrl('javascript:alert(1)').error, 'not_http');
  assert.equal(normalizeBaseUrl('不是网址').error, 'malformed');
  assert.equal(normalizeBaseUrl('').error, 'empty');
});

test('Key 只做形状校验，任何返回值里都不含 Key 字符', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const r = sanityCheckKey(secret);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r).sort(), ['length', 'ok'], '回给 UI 的只能有长度，不能把 Key 带回去');
  assert.equal(sanityCheckKey('short').error, 'too_short');
  assert.equal(sanityCheckKey('a'.repeat(500)).error, 'too_long');
  assert.equal(sanityCheckKey('sk-has space-here').error, 'has_space');
});

test('settings 白名单：Key 类键名根本进不了持久化设置，且丢弃要说明原因', () => {
  const { clean, dropped } = sanitizeSettings({
    mode: 'full', fillSensitive: true, aiKey: 'sk-leakme', apiKey: 'x', token: 'y',
    evil: 'z', aiBaseUrl: 'https://api.x.test/v1',
  });
  assert.deepEqual(Object.keys(clean).sort(), ['aiBaseUrl', 'fillSensitive', 'mode']);
  assert.ok(!('aiKey' in clean), 'aiKey 进了 settings 就等于跟着"导出 JSON"离开本机');
  assert.deepEqual(dropped.map(d => d.k).sort(), ['aiKey', 'apiKey', 'evil', 'token']);
  const secretish = dropped.filter(d => d.k !== 'evil').map(d => d.why);
  assert.ok(secretish.every(w => /Key\/Token/.test(w)), 'Key 类键名要说清是被"秘密"规则拒的，不是拼错字段名');
  assert.ok(dropped.find(d => d.k === 'evil')?.why.includes('未知'));
  assert.ok(!SETTING_KEYS.some(k => /(key|token|secret)/i.test(k)), '白名单里不能有秘密类键名');
});

test('Origin 绑定：换地址就停发，没勾选确认也停发', () => {
  const K = 'https://api.openai.com';
  assert.deepEqual(maySendKey({ keyOrigin: K, targetOrigin: K, consentOrigin: K }), { ok: true });
  assert.equal(maySendKey({ keyOrigin: '', targetOrigin: K, consentOrigin: K }).error, 'no_key');
  assert.equal(maySendKey({ keyOrigin: K, targetOrigin: '', consentOrigin: K }).error, 'no_endpoint');
  assert.equal(maySendKey({ keyOrigin: K, targetOrigin: K, consentOrigin: '' }).error, 'needs_consent',
    '没确认过收件人就发 Key，等于替用户做了决定');
  assert.equal(maySendKey({ keyOrigin: K, targetOrigin: K, consentOrigin: 'https://other.test' }).error, 'origin_changed');
  assert.equal(maySendKey({ keyOrigin: K, targetOrigin: 'https://evil.test', consentOrigin: 'https://evil.test' }).error, 'origin_mismatch',
    '在 A 域录的 Key 绝不跟着发到 B 域，哪怕用户"确认"过 B 域');
});

test('错误文本脱敏：Key 出现在任何要写出去的字符串里都得替换', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const noisy = `fetch failed: POST https://api.x.test/v1/chat/completions Authorization: Bearer ${secret}`;
  const out = redact(noisy, secret);
  assert.ok(!out.includes(secret), '错误信息把 Key 带出去了');
  assert.match(out, /\[REDACTED\]/);
  assert.equal(redact('plain', ''), 'plain');
});

// needs_consent 那次事故：勾了确认、点了「问 AI」，后台却说没确认。
// 根因在"存设置时怎么处置旧确认"这条规则上，所以规则挪进纯函数并逐条钉住。
test('先勾确认、再保存同一个 Base URL：确认必须留着（旧写法会把它擦掉 → needs_consent）', () => {
  const prev = { aiBaseUrl: '', aiConsentOrigin: '' };
  const afterConsent = consentAfterSettingsPatch({ prev, patch: { aiConsentOrigin: 'https://api.a.test' } });
  assert.equal(afterConsent, 'https://api.a.test');
  // 用户接着补保存 URL（origin 相同）——这一步在旧逻辑里把上面的确认清了
  const afterUrl = consentAfterSettingsPatch({
    prev: { aiConsentOrigin: afterConsent },
    patch: { aiBaseUrl: 'https://api.a.test/v1' },
  });
  assert.equal(afterUrl, 'https://api.a.test', '同一端点不该作废确认');
  assert.equal(maySendKey({ keyOrigin: 'https://api.a.test', targetOrigin: 'https://api.a.test', consentOrigin: afterUrl }).ok, true);
});

test('换端点就真的作废：确认指向 A、Base URL 改成 B → 必须重勾', () => {
  const got = consentAfterSettingsPatch({
    prev: { aiBaseUrl: 'https://api.a.test/v1', aiConsentOrigin: 'https://api.a.test' },
    patch: { aiBaseUrl: 'https://api.b.test/v1' },
  });
  assert.equal(got, '');
  assert.equal(maySendKey({ keyOrigin: 'https://api.a.test', targetOrigin: 'https://api.b.test', consentOrigin: got }).error, 'needs_consent');
});

test('同端点只改路径（/v1 → /v1beta）不算换地址，确认继续有效', () => {
  const got = consentAfterSettingsPatch({
    prev: { aiBaseUrl: 'https://api.a.test/v1', aiConsentOrigin: 'https://api.a.test' },
    patch: { aiBaseUrl: 'https://api.a.test/v1beta' },
  });
  assert.equal(got, 'https://api.a.test');
});

// 语言开关与"缺英文写中文"都走同一条 nw:saveSettings。如果作废规则看的是"设置变没变"
// 而不是"端点变没变"，用户切一下语言就又要重勾确认 —— 那就是 needs_consent 复发。
test('切编辑语言 / 改缺英文策略：与端点无关，确认不能被擦掉，且这两个键要能存住', () => {
  const prev = { aiBaseUrl: 'https://api.a.test/v1', aiConsentOrigin: 'https://api.a.test' };
  for (const patch of [{ editorLang: 'en' }, { editorLang: 'zh' }, { enMissingMode: 'zh_yellow' }, { enMissingMode: 'strict' }]) {
    assert.equal(consentAfterSettingsPatch({ prev, patch }), 'https://api.a.test', `${JSON.stringify(patch)} 擦掉了确认`);
  }
  const { clean, dropped } = sanitizeSettings({ editorLang: 'en', enMissingMode: 'zh_yellow', evil: 'x' });
  assert.equal(clean.editorLang, 'en', 'editorLang 不在白名单里 → 存了就丢，切换记不住');
  assert.equal(clean.enMissingMode, 'zh_yellow', 'enMissingMode 不在白名单里 → 那个勾等于没生效');
  assert.deepEqual(dropped.map(d => d.k), ['evil'], '未知设置项要报出来，不能静默吞掉');
});

test('取消确认就立刻清空；还没填端点时确认留着（另有 no_endpoint 闸拦发送）', () => {
  assert.equal(consentAfterSettingsPatch({ prev: { aiConsentOrigin: 'https://api.a.test' }, patch: { aiConsentOrigin: '' } }), '');
  assert.equal(consentAfterSettingsPatch({ prev: {}, patch: { aiConsentOrigin: 'https://api.a.test' } }), 'https://api.a.test',
    '先勾确认再填 URL 是合法顺序，这里清了就是 needs_consent 的成因');
  // 不合法的 Base URL 由 nw:saveSettings 直接拒收，所以这里不该把它当成"端点变了"
  assert.equal(consentAfterSettingsPatch({ prev: {}, patch: { aiConsentOrigin: 'https://api.a.test', aiBaseUrl: 'not a url' } }), 'https://api.a.test');
  assert.equal(maySendKey({ keyOrigin: '', targetOrigin: 'https://api.a.test', consentOrigin: 'https://api.a.test' }).error, 'no_key',
    '确认留着也不构成放行：没 Key 照样发不出去');
});

// 用户实测：模型答得慢，20 秒的旧默认值必然超时，而超时看起来就是"插件没反应"。
test('等待上限：默认 180 秒，可配 15–900，非法值退回默认而不是设成 0', () => {
  assert.equal(AI_TIMEOUT_DEFAULT_SEC, 180, '默认值不能再回到 20 秒这种"模型还没答完就掐"的量级');
  assert.equal(clampTimeoutSec('300').seconds, 300);
  assert.equal(clampTimeoutSec('').error, 'timeout_invalid');       // 清空 = 回默认，由调用方处理
  assert.equal(clampTimeoutSec('abc').error, 'timeout_invalid');
  assert.equal(clampTimeoutSec('5').error, 'timeout_too_small');
  assert.equal(clampTimeoutSec('9999').error, 'timeout_too_large');
  assert.equal(effectiveTimeoutSec({ aiTimeoutSec: 600 }), 600);
  assert.equal(effectiveTimeoutSec({ aiTimeoutSec: '乱填' }), AI_TIMEOUT_DEFAULT_SEC, '手滑填错不该把请求锁死');
  assert.equal(effectiveTimeoutSec(undefined), AI_TIMEOUT_DEFAULT_SEC);
  assert.ok(SETTING_KEYS.includes('aiTimeoutSec'), '不在白名单里就存不进 settings，改了等于没改');
});

// 回答长度上限（请求里的 max_tokens）：reasoning 模型把思考链也算进这里，
// 上限写死 2000 时的表现是"AI 没建议"，其实是没留够写字的地方。
test('回答长度上限：边界、非法退回默认，并且键名不能被"秘密键名闸"吞掉', () => {
  assert.equal(clampMaxTokens('6000').tokens, 6000);
  assert.equal(clampMaxTokens('6000').ok, true);
  assert.equal(clampMaxTokens('100').error, 'output_too_small');      // 太小：一条完整建议都装不下
  assert.equal(clampMaxTokens('999999').error, 'output_too_large');   // 太大：交给服务商那边确认
  assert.equal(clampMaxTokens('').error, 'output_invalid');            // 留空=没填，不当成 0
  assert.equal(clampMaxTokens('abc').error, 'output_invalid');
  assert.equal(effectiveMaxTokens({}), AI_MAX_TOKENS_DEFAULT, '没配就该退回默认');
  assert.equal(effectiveMaxTokens({ aiMaxOutput: 8000 }), 8000);
  assert.equal(effectiveMaxTokens({ aiMaxOutput: 'x' }), AI_MAX_TOKENS_DEFAULT, '脏值不能把请求锁死');
  // 键名带 token 会被 sanitizeSettings 的秘密键名闸拒收（那是设计），所以设置键叫 aiMaxOutput；
  // 这条断言防的是"以后有人改回 aiMaxTokens，于是这个设置永远存不下去"
  assert.ok(SETTING_KEYS.includes('aiMaxOutput'), 'aiMaxOutput 不在白名单里 → 存了就丢');
  const { clean, dropped } = sanitizeSettings({ aiMaxOutput: 6000 });
  assert.equal(clean.aiMaxOutput, 6000, JSON.stringify(dropped));
  assert.equal(dropped.length, 0, '被秘密键名闸误杀了');
  // 与端点无关的设置不得擦掉 AI 确认（needs_consent 的老形状）
  const prev = { aiBaseUrl: 'https://api.a.test/v1', aiConsentOrigin: 'https://api.a.test' };
  assert.equal(consentAfterSettingsPatch({ prev, patch: { aiMaxOutput: 6000 } }), 'https://api.a.test');
});

test('流式开关：默认开、能存住、名字不会被秘密键名闸误杀，也不擦确认', () => {
  assert.equal(effectiveStream({}), true, '没配过就该是开：非流式分不清"慢"和"不通"');
  assert.equal(effectiveStream({ aiStream: false }), false);
  assert.equal(effectiveStream({ aiStream: true }), true);
  const { clean, dropped } = sanitizeSettings({ aiStream: false });
  assert.equal(clean.aiStream, false, JSON.stringify(dropped));
  const prev = { aiBaseUrl: 'https://api.a.test/v1', aiConsentOrigin: 'https://api.a.test' };
  assert.equal(consentAfterSettingsPatch({ prev, patch: { aiStream: false } }), 'https://api.a.test');
});

/** 站点级确认的三件套：判放、记账、端点变了以后清账 */
test('siteConsentCheck：只认"这一站对这一地址"确认过', () => {
  const K = 'https://api.example.test';
  const S = 'https://tupu360.example.test';
  assert.deepEqual(siteConsentCheck({ consents: { [S]: K }, pageOrigin: S, targetOrigin: K }), { ok: true });
  assert.equal(siteConsentCheck({ consents: {}, pageOrigin: S, targetOrigin: K }).error, 'needs_site_consent');
  assert.equal(siteConsentCheck({ consents: { [S]: K }, pageOrigin: S, targetOrigin: 'https://evil.test' }).error, 'site_consent_stale',
    '换端点后旧确认不能继续放行');
  assert.equal(siteConsentCheck({ consents: { [S]: K }, pageOrigin: '', targetOrigin: K }).error, 'no_page_origin',
    '认不出页面是哪一站就不许发（不能"当作已确认"）');
  assert.equal(siteConsentCheck({ consents: { [S]: K }, pageOrigin: S, targetOrigin: '' }).error, 'no_endpoint');
});

test('withSiteConsent：只收形状正确的 origin，账本有上限', () => {
  const K = 'https://api.example.test';
  const got = withSiteConsent({}, { pageOrigin: 'https://a.test', targetOrigin: K });
  assert.deepEqual(got, { 'https://a.test': K });
  assert.deepEqual(withSiteConsent({}, { pageOrigin: 'javascript:alert(1)', targetOrigin: K }), {}, '非法 origin 不进账本');
  assert.deepEqual(withSiteConsent({}, { pageOrigin: 'https://a.test', targetOrigin: 'not a url' }), {});
  let map = {};
  for (let i = 0; i < 80; i++) map = withSiteConsent(map, { pageOrigin: `https://s${i}.test`, targetOrigin: K, limit: 50 });
  assert.equal(Object.keys(map).length, 50, '投过的站点会无限涨：必须有上限');
  assert.equal(map['https://s79.test'], K, '留最晚的那 50 条');
  assert.equal(map['https://s0.test'], undefined);
});

test('端点变了：不再指向新端点的站点记录一起清掉', () => {
  const consents = { 'https://a.test': 'https://old.test', 'https://b.test': 'https://new.test' };
  assert.deepEqual(siteConsentAfterEndpoint({ consents, endpointOrigin: 'https://new.test' }), { 'https://b.test': 'https://new.test' });
  assert.deepEqual(siteConsentAfterEndpoint({ consents, endpointOrigin: '' }), consents, '拿不到端点时不动账本（发送另有闸兜着）');
});
