// 保险箱文件：口令错、文件被改、把明文当成加密包 —— 这几种必须给出不同且正确的答复，
// 而最重要的一条是"密文里不能有任何明文"（否则这个功能就是自欺欺人）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encryptVault, decryptVault, checkPassphrase, looksLikeVault, VAULT_FORMAT, PBKDF2_ITERATIONS } from '../core/vault.js';
import { createEmptyProfile, setValueByPath, countFilled } from '../core/profile-schema.js';

function profileWithSecrets() {
  const p = createEmptyProfile();
  setValueByPath(p, 'basics.name', '欧阳中华');
  setValueByPath(p, 'basics.idNumber', '330105199912034567');
  setValueByPath(p, 'contact.phone', '13900002222');
  setValueByPath(p, 'contact.email', 'ouyang@example.test');
  setValueByPath(p, 'education.0.school', '华南理工大学');
  setValueByPath(p, 'en.education.0.school', 'South China University of Technology');
  setValueByPath(p, 'intent.position', '商业分析师');
  return p;
}
const PASS = '一个只有我记得的长短语-2026';

test('存进去和取出来必须一模一样（含英文子树与敏感字段）', async () => {
  const p = profileWithSecrets();
  const { ok, vault } = await encryptVault({ profile: p, passphrase: PASS, build: 'test-build' });
  assert.ok(ok && looksLikeVault(vault), '没产出一个合法的保险箱对象');
  const got = await decryptVault({ text: JSON.stringify(vault), passphrase: PASS });
  assert.equal(got.ok, true, got.error);
  assert.deepEqual(got.profile, JSON.parse(JSON.stringify(p)), '解出来不是原来那份');
  assert.equal(countFilled(got.profile), countFilled(p));
  assert.equal(got.meta.build, 'test-build');
});

test('密文里不能出现任何明文：取值、槽位路径、分组名都不行', async () => {
  const { vault } = await encryptVault({ profile: profileWithSecrets(), passphrase: PASS });
  const text = JSON.stringify(vault);
  for (const leak of ['欧阳中华', '330105199912034567', '13900002222', '华南理工', 'South China', '商业分析师',
    'basics', 'education', 'hkGlobal', 'intent', 'idNumber']) {
    assert.ok(!text.includes(leak), `保险箱文件里出现了明文：${leak}`);
  }
  assert.ok(!text.includes(PASS), '口令被写进了文件');
  // 唯一允许的非密文字段：格式、算法参数与时间戳
  assert.deepEqual(Object.keys(vault).sort(),
    ['build', 'builtAt', 'cipher', 'ct', 'iv', 'iterations', 'kdf', 'salt', 'v'].sort(), '多了会泄露信息的字段');
});

test('口令错与文件被改都解不开，且不会吐出半截内容', async () => {
  const { vault } = await encryptVault({ profile: profileWithSecrets(), passphrase: PASS });
  const wrong = await decryptVault({ text: JSON.stringify(vault), passphrase: '另外一个口令-99999' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, 'wrong_passphrase_or_tampered');
  assert.ok(!('profile' in wrong), '失败还带着 profile 字段');

  const tampered = JSON.parse(JSON.stringify(vault));
  const bytes = Uint8Array.from(atob(tampered.ct), c => c.charCodeAt(0));
  bytes[40] ^= 0x01;                                    // 只动一位：认证加密必须发现
  tampered.ct = btoa(String.fromCharCode(...bytes));
  const after = await decryptVault({ text: JSON.stringify(tampered), passphrase: PASS });
  assert.equal(after.ok, false, '改了一个字节还能解开，说明没在做认证解密');
  assert.equal(after.error, 'wrong_passphrase_or_tampered');
});

test('把明文 profile JSON 当保险箱导入：要说"这不是保险箱"，而不是报口令错', async () => {
  const plain = JSON.stringify(profileWithSecrets());
  const got = await decryptVault({ text: plain, passphrase: PASS });
  assert.equal(got.ok, false);
  assert.equal(got.error, 'not_vault');
  assert.match(got.hint, /导入 JSON/, '没给出正确的下一步（它是明文备份，走另一条路）');

  const junk = await decryptVault({ text: '不是 JSON', passphrase: PASS });
  assert.equal(junk.error, 'not_json');
});

test('弱口令直接拒，且不做任何派生（省时间也省误用）', async () => {
  assert.equal(checkPassphrase('').error, 'empty');
  assert.equal(checkPassphrase('abc').error, 'too_short');
  assert.equal(checkPassphrase('  ').error, 'empty');
  assert.equal(checkPassphrase(PASS).ok, true);
  const got = await encryptVault({ profile: createEmptyProfile(), passphrase: 'abc' });
  assert.equal(got.ok, false);
  assert.equal(got.error, 'passphrase_too_short');
});

test('派生参数写进文件本身：以后调默认强度也不会让老文件解不开', async () => {
  const { vault } = await encryptVault({ profile: profileWithSecrets(), passphrase: PASS });
  assert.equal(vault.v, VAULT_FORMAT);
  assert.equal(vault.iterations, PBKDF2_ITERATIONS);
  const cheap = JSON.parse(JSON.stringify(vault));
  cheap.iterations = 1000;                              // 文件里写着 60 万，我们按 1000 派生
  const got = await decryptVault({ text: JSON.stringify(cheap), passphrase: PASS });
  assert.equal(got.ok, false, '解密没用文件里记的 iterations，而是用了代码里的常量');
});

test('载入前的差异：只报数量与栏名，不重复印取值', async () => {
  const { profileDelta, describeDelta } = await import('../core/vault.js');
  const { buildFields } = await import('../core/profile-schema.js');
  const cur = createEmptyProfile();
  setValueByPath(cur, 'basics.name', '欧阳中华');
  setValueByPath(cur, 'contact.phone', '13900002222');
  const inc = createEmptyProfile();
  setValueByPath(inc, 'basics.name', '欧阳中华');       // 相同
  setValueByPath(inc, 'education.0.school', '华南理工大学'); // 新增
  const d = profileDelta(cur, inc, buildFields());
  assert.equal(d.added, 1);
  assert.equal(d.changed, 0);
  assert.equal(d.removed, 1, '现有一项在文件里没有 → 会被清空');
  assert.deepEqual(d.willLose, ['手机号'], `该列出栏名而不是取值：${JSON.stringify(d.willLose)}`);
  assert.equal(describeDelta(d), '补上 1 栏、清空 1 栏');
  assert.equal(describeDelta(profileDelta(cur, cur, buildFields())), '与现在这份完全一致');
  const text = JSON.stringify(d);
  assert.ok(!text.includes('13900002222') && !text.includes('欧阳中华'), '差异结果里带了明文取值');
});
