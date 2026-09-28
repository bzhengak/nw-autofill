import { createEmptyProfile, SECTIONS, buildFields, setValueByPath, countFilled } from '../core/profile-schema.js';
import { importMarkdown } from '../core/importers/markdown.js';
import { auditProfile, editorModel, advice } from '../core/coverage.js';
// 端点/Key 的判定规则与 service worker 用同一份代码：这里只用于即时反馈，
// 真正的把关在 background（哪怕这个文件被改成永远不校验，请求也发不出去）。
import { normalizeBaseUrl, sanityCheckKey, findLeaksInExport } from '../core/ai-security.js';

const $ = id => document.getElementById(id);
let tabId = null;
let lastState = null;
let HIGH = null;
let aiKeyPresent = false;      // 只记"有没有"，不记内容
let aiKeyBoundOrigin = '';     // Key 录入时绑定的 origin；Base URL 换了就得重录

async function highFreq() {
  if (HIGH) return HIGH;
  try {
    HIGH = await (await fetch(chrome.runtime.getURL('core/high-frequency.json'))).json();
  } catch { HIGH = { paths: {}, forms: [] }; }
  return HIGH;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  const tab = await activeTab();
  tabId = tab?.id ?? null;
  const state = await chrome.runtime.sendMessage({ type: 'nw:getState', tabId });
  lastState = state;
  const profile = state?.profile;
  $('fillSensitive').checked = Boolean(state?.settings?.fillSensitive);
  // Key 不回显（也不该回显）：只告诉用户本次会话里有没有、绑在哪个 origin
  if (state?.settings?.aiBaseUrl) $('aiBaseUrl').value = state.settings.aiBaseUrl;
  if (state?.settings?.aiModel) $('aiModel').value = state.settings.aiModel;
  aiKeyPresent = Boolean(state?.hasAiKey);
  aiKeyBoundOrigin = state?.aiKeyOrigin || '';
  $('aiPersist').checked = Boolean(state?.aiKeyPersisted);
  if (aiKeyPresent) {
    $('aiKeyState').textContent = `已有 Key（长度 ${state.aiKeyLength} · 绑定 ${state.aiKeyOrigin}）`
      + (state.aiKeyPersisted ? ' · 记住在本机（明文落在浏览器 profile 里，点「清除」删除）' : ' · 只存本次会话，重启即失效');
    // 只有当前 origin 与绑定 origin 一致、且用户之前确认过，才算已授权
    $('aiConsent').checked = Boolean(state.settings?.aiConsentOrigin) && state.settings.aiConsentOrigin === state.aiKeyOrigin;
  } else {
    $('aiKeyState').textContent = '当前没有 Key。';
    $('aiConsent').checked = false;
  }
  $('btnClearKey').disabled = !aiKeyPresent;
  $('aiKey').placeholder = aiKeyPresent ? '重新输入会覆盖本次会话的 Key' : 'API Key（只存本次会话，重启即失效）';
  aiUiSync();
  $('profileMeta').textContent = profile
    ? `已载入：${countFilled(profile)} 个字段有值 / 共 ${buildFields().length} 个可填项`
    : '还没有简历数据，先点「下载空白模板」或「编辑 / 导入 JSON」';
  if (profile) $('profileText').value = JSON.stringify(profile, null, 2);
  else $('profileText').value = JSON.stringify(createEmptyProfile(), null, 2);
  await renderAudit(profile || createEmptyProfile());
  if ($('formEditor').style.display !== 'none') renderForm(profile || createEmptyProfile());
}

/** 体检：填写率 + 高频缺口（缺口行点一下就能跳到对应输入框） */
async function renderAudit(profile) {
  const audit = auditProfile(profile, await highFreq());
  $('auditStats').innerHTML = [
    ['已填', `${audit.filled}/${audit.total}`],
    ['填写率', `${Math.round(audit.rate * 100)}%`],
    ['高频缺口', audit.missingHigh.length],
  ].map(([k, v]) => `<span><b>${k}</b> ${v}</span>`).join('');
  $('auditAdvice').textContent = advice(audit);

  const rows = audit.missingHigh.slice(0, 40);
  $('auditMissing').innerHTML = rows.length
    ? rows.map(m => `<tr><td><span class="dot ${m.askedBy >= 4 ? 'red' : 'yellow'}"></span></td>
        <td>${escapeHtml(m.sectionZh)} · ${escapeHtml(m.label)}${m.sensitive ? ' <span class="note">（敏感：默认不自动写）</span>' : ''}</td>
        <td class="note">被 ${m.askedBy} 份真实站点结构问到</td></tr>`).join('')
    : '<tr><td class="note">高频槽位都已填写。</td></tr>';
  $('auditMissing').querySelectorAll('tr').forEach((tr, i) => {
    tr.style.cursor = 'pointer';
    tr.title = '点击跳到该字段';
    tr.onclick = () => focusSlot(rows[i]?.path);
  });
}

function focusSlot(path) {
  if (!path) return;
  if (! $('onlyEmpty').checked) $('onlyEmpty').checked = false;
  renderForm(lastState?.profile || createEmptyProfile());
  $('formEditor').style.display = 'block';
  const el = $('formBody').querySelector(`[data-path="${CSS.escape(path)}"]`);
  if (el) { el.scrollIntoView?.({ block: 'center' }); el.focus(); }
  else $('formMeta').textContent = `该字段在折叠的列表分组里，取消「只看没填的」或展开表单后再试：${path}`;
}

function renderForm(profile) {
  const body = $('formBody');
  body.textContent = '';
  const model = editorModel(profile, { onlyEmpty: $('onlyEmpty').checked });
  let inputs = 0;
  for (const sec of model) {
    const h = document.createElement('h3');
    // 用 textContent + 子节点，不要把 <span> 当字符串塞进 textContent（那会原样显示标签）
    h.append(sec.zh + ' ');
    const en = document.createElement('span');
    en.className = 'note';
    en.textContent = sec.en || '';
    h.appendChild(en);
    h.style.cssText = 'font-size:12px;margin:12px 0 4px;color:var(--muted)';
    body.appendChild(h);
    for (const row of sec.rows) {
      const wrap = document.createElement('label');
      wrap.className = 'frow';
      const name = document.createElement('span');
      name.textContent = row.label + (row.sensitive ? '（敏感）' : '');
      let ctrl;
      if (row.type === 'textarea') ctrl = document.createElement('textarea');
      else if (row.type === 'enum' && row.options.length) {
        ctrl = document.createElement('select');
        // 用 createElement 而不是 new Option()：后者依赖全局构造函数，在测试环境里不可用
        const blank = document.createElement('option');
        blank.value = ''; blank.textContent = '';
        ctrl.appendChild(blank);
        for (const o of row.options) {
          const opt = document.createElement('option');
          opt.value = o; opt.textContent = o;
          ctrl.appendChild(opt);
        }
        if (row.value && !row.options.includes(row.value)) {
          const opt = document.createElement('option');
          opt.value = row.value; opt.textContent = row.value + '（现值不在候选）';
          ctrl.appendChild(opt);
        }
      } else ctrl = document.createElement('input');
      if (ctrl.tagName === 'INPUT') ctrl.type = row.type === 'date' ? 'date' : 'text';
      ctrl.value = row.value;
      ctrl.dataset.path = row.path;
      wrap.appendChild(name);
      wrap.appendChild(ctrl);
      body.appendChild(wrap);
      inputs++;
    }
  }
  $('formMeta').textContent = `${inputs} 个字段（列表分组只展开在用的段落 + 一个空段）`;
}

$('btnForm').onclick = () => {  const open = $('formEditor').style.display !== 'none';
  $('formEditor').style.display = open ? 'none' : 'block';
  if (!open) renderForm(lastState?.profile || createEmptyProfile());
};
$('btnFormCancel').onclick = () => { $('formEditor').style.display = 'none'; };
$('onlyEmpty').onchange = () => renderForm(lastState?.profile || createEmptyProfile());
$('btnFormSave').onclick = async () => {
  const next = JSON.parse(JSON.stringify(lastState?.profile || createEmptyProfile()));
  for (const el of $('formBody').querySelectorAll('[data-path]')) setValueByPath(next, el.dataset.path, el.value);
  await chrome.runtime.sendMessage({ type: 'nw:saveProfile', profile: next });
  $('formMeta').textContent = '已保存。';
  await refresh();
};

// 「允许填写敏感字段」这个勾必须真的落到 settings 里，否则 matcher 读不到，等于界面上骗人
$('fillSensitive').onchange = async e => {
  await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { fillSensitive: e.target.checked } });
  lastState = { ...(lastState || {}), settings: { ...(lastState?.settings || {}), fillSensitive: e.target.checked } };
};

function render(data, meta = {}) {
  const s = data?.stats || {};
  const withheld = (data?.gaps || []).filter(g => g.reason === 'sensitive_withheld');
  const banners = [];
  if (s.profileFilled === 0) {
    banners.push('<div class="banner">简历资料是空的（0 项有值）：所以现在一个字段都填不了。先去「导入简历 Markdown」或「分类编辑」把资料灌进来，再来扫描。</div>');
  } else if (withheld.length) {
    banners.push(`<div class="banner">${withheld.length} 个敏感字段（证件号/手机号等）按你的设置没有写入。要自动填就在下方勾选「允许填写敏感字段」。</div>`);
  }
  const ai = meta.adapterInfo;
  if (!meta.adapterId && ai && !ai.loaded) {
    banners.push(`<div class="banner">适配器没加载成功：${escapeHtml(ai.error || '未知原因')}。这一页只能按通用规则匹配，钉位与槽位规则都不会生效。</div>`);
  }
  const adapterLine = `<div class="note">本页适配器：${escapeHtml(meta.adapterId || '无（按通用规则匹配）')}`
    + (ai && ai.loaded ? `　已加载 ${ai.count} 份` + (ai.rejected.length ? `，被拒绝 ${ai.rejected.length} 份` : '') : '') + '</div>';
  $('stats').innerHTML = [
    ['扫描到', s.scanned || 0], ['计划填', s.planned || 0], ['绿·自动', s.green || s.auto || 0],
    ['黄·待复核', s.yellow || s.review || 0], ['红·失败', s.red || 0], ['待你处理', s.gaps || 0],
    ['资料已填', s.profileFilled != null ? s.profileFilled : '-'],
    // AI 补了几栏要单独看得见：这些行永远黄字，用户需要知道"这一栏的依据不是本地词典"
    ['AI 补栏', s.aiApplied || 0],
  ].map(([k, v]) => `<span><b>${k}</b> ${v}</span>`).join('') + adapterLine + banners.join('');

  $('results').innerHTML = (data?.results || [])
    .filter(r => !['skipped', 'planned'].includes(r.status) || r.status === 'planned')
    .map(r => `<tr><td><span class="dot ${r.status === 'manual' ? 'orange' : r.status}"></span></td>
      <td>${escapeHtml(r.label || '(无标签)')}${r.aiChosen ? ' <span class="note">〔AI 选路〕</span>' : ''}</td>
      <td class="note">${escapeHtml(r.path || '')}<br>${r.score != null ? '置信 ' + r.score : ''} ${r.note ? '· ' + escapeHtml(r.note) : ''} ${r.failReason ? '· ' + escapeHtml(r.failReason) : ''}</td>
      <td>${escapeHtml(String(r.actual ?? '')).slice(0, 40)}</td></tr>`).join('');

  $('gaps').innerHTML = (data?.gaps || []).map(g =>
    `<tr><td><span class="dot orange"></span></td><td>${escapeHtml(g.label)}</td><td class="note">${escapeHtml(g.reason)}</td></tr>`).join('')
    || '<tr><td class="note">无</td></tr>';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let lastScan = null;   // 最近一次扫描的 {gaps, aiFields}：AI 兜底要问的就是这批缺口

async function run(mode, extra = {}) {
  const tab = await activeTab();
  tabId = tab?.id;
  const res = await chrome.runtime.sendMessage({ type: 'nw:scan', tabId, mode, dryRun: mode === 'preview', ...extra });
  if (!res?.ok) {
    $('stats').innerHTML = `<span class="banner">页面未响应：${escapeHtml(res?.error || '未知错误')}。若是刚装扩展，请刷新目标页面后重试。</span>`;
    return;
  }
  lastScan = res.data;
  render(res.data, { adapterId: res.adapterId, adapterInfo: res.adapterInfo });
}

$('btnScan').onclick = () => run('full');
$('btnPreview').onclick = () => run('preview');

// ―― AI 兜底 ――
// 面板只负责"取最近一次扫描的缺口 → 交给 background → 拿回候选 → 重新扫描并落地"。
// 判定规则的实体在 core/ai-security.js（离线可测），这里只是把同一套规则用在输入框上，
// 让错误在点按钮之前就看得见，而不是等请求被拒再猜原因。
const ENDPOINT_ERROR_ZH = {
  empty: 'Base URL 是空的', malformed: 'Base URL 不是合法网址', not_http: '只支持 http(s) 地址',
  insecure: '必须是 https（本机 127.0.0.1 / localhost 例外）',
  userinfo: '地址里不能带 user@ 这种账号信息', has_query: '地址不能带 ?query 或 #（可能粘错了整条链接）',
};
const KEY_ERROR_ZH = {
  empty: 'Key 是空的', too_short: 'Key 太短（少于 12 字符）', too_long: 'Key 过长（超过 400 字符）',
  has_space: 'Key 里有空格，检查是否误粘了前后内容',
};

function aiUiSync() {
  const base = normalizeBaseUrl($('aiBaseUrl').value);
  $('aiConsentTarget').textContent = base.ok ? base.origin : (ENDPOINT_ERROR_ZH[base.error] || '先填 Base URL');
  // Base URL 与录入 Key 时不是同一个 origin → 确认必须作废、Key 也要重录
  if (base.ok && aiKeyBoundOrigin && aiKeyBoundOrigin !== base.origin) {
    $('aiConsent').checked = false;
    $('aiKeyState').textContent = `Base URL 变了：之前录的 Key 绑在 ${aiKeyBoundOrigin}，不会跟着发到新地址。请重新保存 Key。`;
  }
  const ready = base.ok && $('aiConsent').checked && aiKeyPresent && aiKeyBoundOrigin === base.origin && $('aiModel').value.trim();
  $('btnAiAsk').disabled = !ready;
  $('btnAiAsk').title = ready ? '' : '需要：合法 https Base URL + 已保存的 Key + 模型名 + 勾选确认发往该地址';
}
$('aiBaseUrl').oninput = () => { aiUiSync(); };
$('aiBaseUrl').onchange = async e => {
  const base = normalizeBaseUrl(e.target.value);
  if (!base.ok) {
    // 不合法也要把原因显示在"确认发往"那一行：只报状态栏会让人以为勾了就能发
    $('aiStatus').textContent = ENDPOINT_ERROR_ZH[base.error] || 'Base URL 不合法，未保存';
    aiUiSync();
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { aiBaseUrl: base.url } });
  $('aiStatus').textContent = res?.ok ? `Base URL 已保存：${base.url}` : '保存失败：' + (res?.error || '');
  $('aiConsent').checked = false;
  aiUiSync();
};
$('aiModel').onchange = async e => {
  await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { aiModel: e.target.value.trim() } });
  aiUiSync();
};
$('aiConsent').onchange = async e => {
  const base = normalizeBaseUrl($('aiBaseUrl').value);
  if (!e.target.checked) { await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { aiConsentOrigin: '' } }); aiUiSync(); return; }
  if (!base.ok) { $('aiStatus').textContent = ENDPOINT_ERROR_ZH[base.error] || 'Base URL 不合法，无法确认'; $('aiConsent').checked = false; aiUiSync(); return; }
  await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { aiConsentOrigin: base.origin } });
  aiUiSync();
};
async function aiNeedsScan() {
  if (!lastScan?.aiFields?.length) { $('aiStatus').textContent = '先「只预演不写入」扫一次本页'; return false; }
  return true;
}
$('btnSaveKey').onclick = async () => {
  const key = $('aiKey').value.trim();
  $('aiKey').value = '';                       // 无论成败都先擦掉输入框，不留残余
  if (!key) { $('aiStatus').textContent = 'Key 输入框是空的，没有保存'; return; }
  const shape = sanityCheckKey(key);
  if (!shape.ok) { $('aiStatus').textContent = KEY_ERROR_ZH[shape.error] || 'Key 形状不对，没有保存'; return; }
  const persist = $('aiPersist').checked;
  const res = await chrome.runtime.sendMessage({ type: 'nw:saveAiKey', key, baseUrl: $('aiBaseUrl').value, persist });
  if (!res?.ok) {
    const why = res?.error?.startsWith('endpoint_') ? ENDPOINT_ERROR_ZH[res.error.slice(9)] || 'Base URL 不合法，Key 无处可去' : '保存失败';
    $('aiStatus').textContent = why;
    return;
  }
  aiKeyPresent = true;
  aiKeyBoundOrigin = res.boundOrigin;
  // 只报长度与 origin：任何 Key 字符都不回到 DOM
  $('aiKeyState').textContent = `Key 已保存（长度 ${res.length}）· 绑定 ${res.boundOrigin}`
    + (persist ? ' · 明文存在浏览器 profile，重启后仍在' : ' · 只存本次会话，重启即失效')
    + (res.secure ? '' : ' · 注意：目标是本机 http 地址，Key 走明文链路');
  $('aiStatus').textContent = persist ? 'Key 已记住（本机明文，不进导出文件）' : 'Key 已存入本次会话';
  aiUiSync();
};
$('btnClearKey').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'nw:saveAiKey', key: '' });
  aiKeyPresent = false; aiKeyBoundOrigin = '';
  $('aiKeyState').textContent = '当前没有 Key（会话与本机两个位置都已清除）。';
  $('aiConsent').checked = false;
  $('aiStatus').textContent = 'Key 已清除';
  aiUiSync();
};
$('btnAiPreview').onclick = async () => {
  if (!await aiNeedsScan()) return;
  const profile = JSON.parse($('profileText').value || '{}');
  const res = await chrome.runtime.sendMessage({ type: 'nw:aiPreview', profile, gaps: lastScan.gaps, fields: lastScan.aiFields });
  const box = $('aiPreviewText');
  if (!res?.ok) {
    box.hidden = false;
    box.textContent = res?.error === 'value_leak'
      ? `自检拦下了这次请求：下面这些槽位的取值出现在了待发文本里，已拒绝发送。\n`
        + (res.leaks || []).map(l => `  · ${l.path}（开头「${l.sample}」）`).join('\n')
      : '预览失败：' + (res?.error || '未知错误');
    $('aiStatus').textContent = res?.error === 'value_leak' ? '已拒绝发送（取值泄漏）' : '预览失败';
    return;
  }
  box.hidden = false;
  // 预览必须把收件人一起显示：只核对内容不看地址，等于让用户以为"发给我核对过的地址"
  box.textContent = `（将发往：${res.endpoint || '未配置地址'}）\n` + res.text;
  $('aiStatus').textContent = `将发送 ${res.asks} 个缺口 · ${res.bytes} 字节 · 目标 ${res.endpoint || '未配置'} · 以上文本就是实际请求体全文`;
};
$('btnAiAsk').onclick = async () => {
  if (!await aiNeedsScan()) return;
  $('aiStatus').textContent = '正在请求…（只发字段名）';
  const profile = JSON.parse($('profileText').value || '{}');
  const res = await chrome.runtime.sendMessage({ type: 'nw:aiAsk', profile, gaps: lastScan.gaps, fields: lastScan.aiFields });
  if (!res?.ok) {
    const why = {
      ai_not_configured: '还没配好 Base URL / 模型 / Key（Key 只存本次会话）',
      value_leak: '自检拦下了这次请求，已拒绝发送',
      timeout: '请求超时（20s）',
      network_error: '网络错误：检查 Base URL 与站点可达性',
      payload_too_large: '请求体超限，缺口太多，先分批处理',
    }[res?.error] || ('调用失败：' + (res?.error || '未知错误'));
    $('aiStatus').textContent = why;
    return;
  }
  if (!res.candidates.length) { $('aiStatus').textContent = `AI 没有给出可用建议（丢弃 ${res.dropped.length} 条）`; return; }
  await run('preview', { aiCandidates: res.candidates });
  $('aiStatus').textContent = `AI 补齐 ${res.candidates.length} 栏（全部黄字待你核对）；已用「只预演」应用，确认后点「扫描并填写」写入`;
};
$('btnUndo').onclick = async () => { await chrome.runtime.sendMessage({ type: 'nw:undo', tabId }); render({ stats: {}, results: [], gaps: [] }); };
$('btnClear').onclick = () => chrome.runtime.sendMessage({ type: 'nw:clearMarks', tabId });
$('btnEdit').onclick = () => $('editor').classList.toggle('on');
$('btnCancel').onclick = () => { $('editor').classList.remove('on'); refresh(); };
$('btnSave').onclick = async () => {
  let parsed;
  try { parsed = JSON.parse($('profileText').value); }
  catch (e) { alert('JSON 格式错误：' + e.message); return; }
  await chrome.runtime.sendMessage({ type: 'nw:saveProfile', profile: parsed });
  $('editor').classList.remove('on');
  refresh();
};
$('btnTemplate').onclick = () => {  const blank = createEmptyProfile();
  const blob = new Blob([JSON.stringify(blank, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'nw-autofill-profile-template.json';
  a.click();
  alert(`空白模板含 ${SECTIONS.length} 个分组、${buildFields().length} 个可填项。\n\n用文本编辑器打开这个 JSON，把你简历里没有但网申会问的条目（家庭成员、档案所在地、港企签证合规等）手动补上，再回到这里「编辑 / 导入 JSON」粘贴保存即可。`);
};

refresh();

$('btnImportMd').onclick = async () => {
  const md = $('mdText').value;
  if (!md.trim()) { $('mdReport').textContent = '先粘贴简历 Markdown 全文'; return; }
  let base;
  try { base = JSON.parse($('profileText').value); } catch { base = createEmptyProfile(); }
  const { profile, report } = importMarkdown(md, { base, overwrite: $('mdOverwrite').checked });
  $('profileText').value = JSON.stringify(profile, null, 2);
  $('editor').classList.add('on');
  // 以前这里只填文本框、不保存：点完「解析并填入」再扫描，读到的是 storage 里的旧资料，
  // 表现就是"简历导入识别不到字段"。导入即保存，并回报保存后的真实条数。
  await chrome.runtime.sendMessage({ type: 'nw:saveProfile', profile });
  lastState = { ...(lastState || {}), profile };
  $('mdReport').innerHTML = '<b>写入并保存 ' + countFilled(profile) + ' 项</b> · 本次新填 '
    + report.mapped.length + ' 项 · 跳过已有 ' + report.skippedExisting.length + ' 项 · 未识别标题 '
    + report.unmappedHeadings.length + ' 个';
  const detail = [];
  if (report.unmappedHeadings.length) detail.push('⚠ 这些标题没被识别，内容可能丢失，请手动补：\n  ' + report.unmappedHeadings.join('\n  '));
  if (report.warnings.length) detail.push('提示：\n  ' + report.warnings.join('\n  '));
  if (report.derived && report.derived.length) detail.push('自动推导（请核对）：\n  ' + report.derived.join('\n  '));
  detail.push('写入明细：\n  ' + report.mapped.map(m => m.path + ' ← ' + m.source).join('\n  '));
  $('mdDetail').textContent = detail.join('\n\n');
};

let probeJson = '';
$('btnProbe').onclick = async () => {
  const tab = await activeTab();
  tabId = tab?.id;
  $('probeMeta').textContent = '正在只读扫描页面结构…';
  const res = await chrome.runtime.sendMessage({ type: 'nw:probe', tabId });
  if (!res?.ok) { $('probeMeta').textContent = '本页无响应：' + (res?.error || '未知错误') + '（刚装扩展请刷新目标页面）'; return; }
  const d = res.data;
  const fr = res.frameReport || null;
  probeJson = JSON.stringify({
    at: d.at, url: d.url, titleChars: d.titleChars, framework: d.framework,
    componentLibs: d.componentLibs, topLibrary: d.topLibrary, totals: d.totals,
    sections: d.sections, fields: d.fields,
    probeBuild: d.probeBuild, isTopFrame: d.isTopFrame, iframeMap: d.iframeMap,
    frames: fr?.tried || undefined,
    note: d.note,
  }, null, 1);
  $('probeOut').value = probeJson;
  $('btnProbeCopy').disabled = false;
  $('btnProbeSave').disabled = false;
  $('probeMeta').innerHTML = '探针 ' + escapeHtml(d.probeBuild || '(旧版)') + (d.isTopFrame === false ? ' · 非顶层框' : ' · 顶层框')
    + ' · 控件 <b>' + d.totals.controls + '</b> · 可见 <b>' + d.totals.visible + '</b> · 下拉 ' + d.totals.selects
    + ' · 单选 ' + d.totals.radios + ' · 文件 ' + d.totals.fileInputs + ' · iframe ' + d.totals.iframes
    + ' · Shadow ' + d.totals.shadowHosts + ' · 组件库判定: <b>' + d.topLibrary + '</b>'
    + (fr ? ' · 取自 frame#' + fr.chosen + '（共遍历 ' + fr.tried.length + ' 个框）' : '');
  // 空结果必须自己说清"取的是哪个框"，否则用户只知道失败、维护者只能靠猜
  if (!d.totals.controls) {
    const picked = fr?.tried?.find(x => x.frameId === fr.chosen);
    const framesTxt = fr?.tried?.length
      ? '各框控件数：' + fr.tried.map(x => '#' + x.frameId + ' ' + x.controls).join('，')
      : (d.probeBuild
        ? '（框清单缺失：探针是新版但枚举 frame 失败，多为扩展需要重新授权，请在 edge://extensions 重新加载一次）'
        : '（探针是旧版：请在 edge://extensions 点「重新加载」，关掉侧边栏再重开，然后刷新目标页面）');
    const sub = (d.iframeMap || []).filter(x => x.sameOrigin && x.controls > 0)
      .map(x => '同源 iframe 有 ' + x.controls + ' 个控件（name=' + (x.frameName || '无名') + '）');
    $('probeMeta').innerHTML += '<br><span style="color:var(--warn-fg);background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:4px;padding:2px 6px;display:inline-block">'
      + '这个框里没有表单控件（URL: ' + escapeHtml(picked?.url || d.url || '未知') + '）。'
      + escapeHtml(framesTxt)
      + (sub.length ? '。' + escapeHtml(sub.join('；')) + ' → 表单可能在首方 iframe 里' : '')
      + '。把这一段一起发我。</span>';
  }
};
$('btnProbeCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(probeJson); $('probeMeta').textContent = '已复制，直接粘贴给维护者即可。'; }
  catch { $('probeOut').select(); document.execCommand('copy'); $('probeMeta').textContent = '已选中并尝试复制。'; }
};
$('btnProbeSave').onclick = () => {
  // 导出守卫：这份文件是要粘贴给别人看的。今天它只含结构，但"只含结构"必须是被检查的事实，
  // 而不是"我记得没写进去"。命中任何像 Key 的东西就拒绝导出。
  const leaks = findLeaksInExport(probeJson, {});
  if (leaks.length) {
    $('probeMeta').textContent = '已拒绝导出：内容里出现像 API Key 的字符串（' + leaks.map(l => l.key).join(', ') + '）';
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([probeJson], { type: 'application/json' }));
  a.download = 'page-structure-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
};
