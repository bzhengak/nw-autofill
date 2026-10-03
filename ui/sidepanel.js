import { createEmptyProfile, SECTIONS, buildFields, setValueByPath, getValueByPath, countFilled, writeLang, ensureEnSkeleton, englishCoverage, isLangNeutral } from '../core/profile-schema.js';
import { importMarkdown } from '../core/importers/markdown.js';
import { auditProfile, editorModel, advice } from '../core/coverage.js';
import { gapReasonLabel } from '../core/matcher.js';
// 端点/Key 的判定规则与 service worker 用同一份代码：这里只用于即时反馈，
// 真正的把关在 background（哪怕这个文件被改成永远不校验，请求也发不出去）。
import { applyExtracted } from '../core/ai-extract.js';
import { normalizeBaseUrl, sanityCheckKey, findLeaksInExport, clampTimeoutSec, effectiveTimeoutSec, AI_TIMEOUT_DEFAULT_SEC, clampMaxTokens, effectiveMaxTokens, AI_MAX_TOKENS_DEFAULT, effectiveStream } from '../core/ai-security.js';
import { BUILD } from '../core/build.js';
import { encryptVault, decryptVault, profileDelta, describeDelta } from '../core/vault.js';
import { describeUnfilledMap } from '../core/option-map.js';
import { describeMappingTable, plainMappingTable, slotZhFor, findValueLeaks } from '../core/mapping-table.js';
import { describePlanCheck } from '../core/plan-check.js';
import { slotChoices } from '../core/site-rules.js';

const $ = id => document.getElementById(id);
let tabId = null;
// 整页目的闸的"仅本次放行"：判成登录/搜索/订阅页时后台一个字段都不写，
// 用户点了「我确认这是网申表」才重试。刻意不写进设置 —— 换页就该重新问。
let allowNonApplicationOnce = false;
let lastState = null;
// 表单编辑区当前看的是哪一份取值（zh / en）。只影响编辑区，不影响填写与体检的读法：
// 填写时用哪一份由页面语言决定，不取决于这个开关 —— 否则切个标签就把中文写进英文表单。
let editorLang = 'zh';
let HIGH = null;
let aiKeyPresent = false;      // 只记"有没有"，不记内容
let aiKeyBoundOrigin = '';     // Key 录入时绑定的 origin；Base URL 换了就得重录
// 真正被后台接受的确认（origin 字符串）。勾只是意图，这个才是事实：
// 之前 ready 判定看勾选状态，后台看存储，两者会分叉（先勾确认再保存 URL 时确认被擦掉，
// 界面上勾还在，点「问 AI」只得到一句 needs_consent —— 用户没做错任何事）。
let aiConsentStored = '';

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

/**
 * 顶栏那行版本号不是装饰：MV3 重载扩展后，旧的 service worker 不一定立刻退场
 * （还挂着连接时它照样回消息），表现就是"我明明重载了，怎么还是老 behaviour"。
 * 界面与后台各处报一个号，不一致就直接讲人话，别再靠对话去猜。
 */
function stampVersions(state) {
  const sw = state?.build || '';
  const el = $('buildStamp');
  if (!el) return;
  const stale = sw !== BUILD;
  // 修法直接写在文字里，不藏进 title：侧边栏那么窄，悬停提示等于没有
  el.textContent = stale
    ? `界面 ${BUILD} · 后台 ${sw || '没有版本自述（更旧的版本）'} — 后台没跟上：去 chrome://extensions 把本扩展关掉再打开，然后重开侧边栏`
    : `构建 ${BUILD}`;
  el.className = stale ? 'banner' : 'note';
  el.title = stale
    ? '侧边栏是新的、后台 service worker 还是旧的：去 chrome://extensions 把本扩展的开关关掉再打开（或点「Service Worker」→ 停止），然后关掉侧边栏重开。'
    : '界面与后台是同一份构建';
}

async function refresh() {
  const tab = await activeTab();
  tabId = tab?.id ?? null;
  const state = await chrome.runtime.sendMessage({ type: 'nw:getState', tabId });
  lastState = state;
  const profile = state?.profile;
  // 面板里这份副本先补齐英文骨架：存储中可能是老结构（en 只有几栏），
  // 不补的话「编辑 / 导入 JSON」框里看不见英文该写在哪，导出文件也一样是空的。
  if (profile) ensureEnSkeleton(profile);
  stampVersions(state);
  $('fillSensitive').checked = Boolean(state?.settings?.fillSensitive);
  $('allowCustomSelect').checked = Boolean(state?.settings?.allowCustomSelect);
  $('allowAddRows').checked = Boolean(state?.settings?.allowAddRows);
  $('enZhFallback').checked = state?.settings?.enMissingMode === 'zh_yellow';
  // 映射表先行是默认态：设置里没这个键（老配置）也算开
  $('mappingFirst').checked = state?.settings?.mappingFirst !== false;
  // 按钮文字跟着开关走：开着时点它**不会写页面**，名字就不能还叫"扫描并填写"
  $('btnScan').textContent = $('mappingFirst').checked ? '扫描并出映射表' : '扫描并填写';
  // 编辑区语言跟着设置走（刷新面板不该跳回中文，用户正在补英文补到一半）
  editorLang = state?.settings?.editorLang === 'en' ? 'en' : 'zh';
  $('langZh').classList.toggle('on', editorLang === 'zh');
  $('langEn').classList.toggle('on', editorLang === 'en');
  // Key 不回显（也不该回显）：只告诉用户本次会话里有没有、绑在哪个 origin
  if (state?.settings?.aiBaseUrl) $('aiBaseUrl').value = state.settings.aiBaseUrl;
  if (state?.settings?.aiModel) $('aiModel').value = state.settings.aiModel;
  $('aiTimeoutSec').value = state?.settings?.aiTimeoutSec || '';
  $('aiTimeoutState').textContent = `当前生效：${effectiveTimeoutSec(state?.settings || {})} 秒`;
  $('aiMaxTokens').value = state?.settings?.aiMaxOutput || '';
  $('aiMaxTokensState').textContent = `当前生效：${effectiveMaxTokens(state?.settings || {})} token`;
  $('aiStream').checked = effectiveStream(state?.settings || {});
  aiKeyPresent = Boolean(state?.hasAiKey);
  aiKeyBoundOrigin = state?.aiKeyOrigin || '';
  $('aiPersist').checked = Boolean(state?.aiKeyPersisted);
  if (aiKeyPresent) {
    $('aiKeyState').textContent = `已有 Key（长度 ${state.aiKeyLength} · 绑定 ${state.aiKeyOrigin}）`
      + (state.aiKeyPersisted ? ' · 记住在本机（明文落在浏览器 profile 里，点「清除」删除）' : ' · 只存本次会话，重启即失效');
    // 只有当前 origin 与绑定 origin 一致、且用户之前确认过，才算已授权
    aiConsentStored = String(state.settings?.aiConsentOrigin || '');
    $('aiConsent').checked = Boolean(aiConsentStored) && aiConsentStored === state.aiKeyOrigin;
  } else {
    $('aiKeyState').textContent = '当前没有 Key。';
    $('aiConsent').checked = false;
  }
  $('btnClearKey').disabled = !aiKeyPresent;
  $('aiKey').placeholder = aiKeyPresent ? '重新输入会覆盖本次会话的 Key' : 'API Key（只存本次会话，重启即失效）';
  aiUiSync();
  const cov = profile ? englishCoverage(profile) : null;
  $('profileMeta').textContent = profile
    ? `已载入：${countFilled(profile)} 个字段有值 / 共 ${buildFields().length} 个可填项`
      + (cov && cov.need ? `　·　英文写法：${cov.done}/${cov.need} 栏已补（英文值写在 JSON 的 "en" 子树里）` : '')
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
  const lang = editorLang;
  const en = lang === 'en';
  $('langHint').hidden = !en;
  const model = editorModel(profile, { onlyEmpty: $('onlyEmpty').checked, lang });
  let inputs = 0;
  let needsEn = 0;
  for (const sec of model) {
    const h = document.createElement('h3');
    // 用 textContent + 子节点，不要把 <span> 当字符串塞进 textContent（那会原样显示标签）
    const main = document.createElement('span');
    main.textContent = (en ? (sec.en || sec.zh) : sec.zh) + ' ';
    h.appendChild(main);
    const other = document.createElement('span');
    other.className = 'note';
    other.textContent = en ? (sec.zh || '') : (sec.en || '');
    h.appendChild(other);
    h.style.cssText = 'font-size:12px;margin:12px 0 4px;color:var(--muted)';
    body.appendChild(h);
    for (const row of sec.rows) {
      const wrap = document.createElement('label');
      wrap.className = 'frow' + (row.needsEnglish ? ' needsEn' : '');
      const name = document.createElement('span');
      name.textContent = row.label + (row.sensitive ? (en ? ' (sensitive)' : '（敏感）') : '')
        + (row.needsEnglish ? (en ? ' *' : '（缺英文）') : '');
      name.title = row.labelZh + (row.needsEnglish ? `　|　中文值：${row.altValue}` : '');
      let ctrl;
      if (row.type === 'textarea') ctrl = document.createElement('textarea');
      else if (row.type === 'enum' && row.options.length) {
        ctrl = document.createElement('select');
        // 用 createElement 而不是 new Option()：后者依赖全局构造函数，在测试环境里不可用
        const blank = document.createElement('option');
        blank.value = ''; blank.textContent = '';
        ctrl.appendChild(blank);
        row.options.forEach((shown, i) => {
          const opt = document.createElement('option');
          // 显示英文，存的是规范值（见 core/coverage.js 的 optionValues 注释）
          opt.value = row.optionValues?.[i] ?? shown;
          opt.textContent = shown;
          ctrl.appendChild(opt);
        });
        if (row.value && !row.options.includes(row.value) && !(row.optionValues || []).includes(row.value)) {
          const opt = document.createElement('option');
          opt.value = row.value; opt.textContent = row.value + (en ? ' (current)' : '（现值不在候选）');
          ctrl.appendChild(opt);
        }
      } else ctrl = document.createElement('input');
      if (ctrl.tagName === 'INPUT') ctrl.type = row.type === 'date' ? 'date' : 'text';
      ctrl.value = row.value;
      ctrl.dataset.path = row.path;
      ctrl.dataset.lang = lang;
      // 灰提示 = 这一栏的中文值：EN 模式下照着它写英文，不用来回切语言
      if (en && !row.neutral && !row.value && row.altValue) ctrl.placeholder = `中文：${String(row.altValue).slice(0, 40)}`;
      wrap.appendChild(name);
      wrap.appendChild(ctrl);
      body.appendChild(wrap);
      inputs++;
      if (row.needsEnglish) needsEn++;
    }
  }
  $('formMeta').textContent = `${inputs} 个字段（列表分组只展开在用的段落 + 一个空段）`;
  $('langMeta').textContent = en
    ? (needsEn ? `${needsEn} 栏只有中文值，补完才会在英文表单上写入` : '该补的英文写法都齐了')
    : '中文取值（日期/邮箱/选项等两种语言同一个值）';
}

function setEditorLang(lang) {
  editorLang = lang === 'en' ? 'en' : 'zh';
  $('langZh').classList.toggle('on', editorLang === 'zh');
  $('langEn').classList.toggle('on', editorLang === 'en');
  chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { editorLang } });
  renderForm(lastState?.profile || createEmptyProfile());
}
$('langZh').onclick = () => setEditorLang('zh');
$('langEn').onclick = () => setEditorLang('en');

$('btnForm').onclick = () => {  const open = $('formEditor').style.display !== 'none';
  $('formEditor').style.display = open ? 'none' : 'block';
  if (!open) renderForm(lastState?.profile || createEmptyProfile());
};
$('btnFormCancel').onclick = () => { $('formEditor').style.display = 'none'; };
$('onlyEmpty').onchange = () => renderForm(lastState?.profile || createEmptyProfile());
$('btnFormSave').onclick = async () => {
  const next = JSON.parse(JSON.stringify(lastState?.profile || createEmptyProfile()));
  // 每个输入框带着自己是中文还是英文（data-lang）：EN 模式的值写进 profile.en.<路径>，
  // 中文模式的写进原路径。混成一处写就会把英文校名覆盖掉中文校名 —— 那是数据丢失，不是显示问题。
  for (const el of $('formBody').querySelectorAll('[data-path]')) {
    writeLang(next, el.dataset.path, el.dataset.lang || 'zh', el.value);
  }
  await chrome.runtime.sendMessage({ type: 'nw:saveProfile', profile: next });
  $('formMeta').textContent = '已保存。';
  await refresh();
};

// 「允许填写敏感字段」这个勾必须真的落到 settings 里，否则 matcher 读不到，等于界面上骗人
$('fillSensitive').onchange = async e => {
  await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { fillSensitive: e.target.checked } });
  lastState = { ...(lastState || {}), settings: { ...(lastState?.settings || {}), fillSensitive: e.target.checked } };
};
// 点开自定义下拉 = 扩展会真的点击页面上的控件，这是一次独立授权，默认关，
// 与「允许填写敏感字段」分开勾：两者风险性质不同（改内容 vs 动页面）。
$('allowAddRows').onchange = async e => {
  await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { allowAddRows: e.target.checked } });
  lastState = { ...(lastState || {}), settings: { ...(lastState?.settings || {}), allowAddRows: e.target.checked } };
  panelNotice = e.target.checked ? '已允许补行：下一次「按此映射填写」时，段数不够的那一节我们会试着点「+ 添加一段」。' : '已关闭补行：段数不够时那一节的后面几行会一直留着不写。';
  refreshMapSummary();
};
$('allowCustomSelect').onchange = async e => {
  await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { allowCustomSelect: e.target.checked } });
  lastState = { ...(lastState || {}), settings: { ...(lastState?.settings || {}), allowCustomSelect: e.target.checked } };
  $('stats').innerHTML = `<div class="banner">${e.target.checked
    ? '已授权点开自定义下拉：这类栏位会被真实点击并选中，结果一律标黄由你核对。提交仍然不会代做。'
    : '已收回授权：自定义下拉恢复为「交给你手动点」，不再被点击。'}</div>` + ($('stats').innerHTML || '');
};
// 英文表单缺英文值时怎么办：默认**不写**（列进"需要你处理"），勾选后才允许写中文并标黄。
// 这个勾必须真的落到 settings.enMissingMode，否则 matcher 读不到 = 界面上骗人。
$('enZhFallback').onchange = async e => {
  const mode = e.target.checked ? 'zh_yellow' : 'strict';
  await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { enMissingMode: mode } });
  lastState = { ...(lastState || {}), settings: { ...(lastState?.settings || {}), enMissingMode: mode } };
};

function render(data, meta = {}) {
  const s = data?.stats || {};
  const withheld = (data?.gaps || []).filter(g => g.reason === 'sensitive_withheld');
  const noEn = (data?.gaps || []).filter(g => g.reason === 'missing_english_value');
  const banners = [];
  if (s.profileFilled === 0) {
    banners.push('<div class="banner">简历资料是空的（0 项有值）：所以现在一个字段都填不了。先去「导入简历 Markdown」或「分类编辑」把资料灌进来，再来扫描。</div>');
  } else if (withheld.length) {
    banners.push(`<div class="banner">${withheld.length} 个敏感字段（证件号/手机号等）按你的设置没有写入。要自动填，就在上方「填写授权」里勾上「允许填写证件号等敏感字段」。</div>`);
  }
  // 英文页面上"中文有值、英文没值"的槽位：我们宁可留空也不把中文写进英文名栏，
  // 所以必须说清是哪几栏、以及两条出路（补英文值 / 开那个降级开关）。
  if (noEn.length) {
    banners.push(`<div class="banner">这一页是英文表单，${noEn.length} 个槽位只有中文写法，已故意留空（把「南京大学」写进 English name 就是这种事故）。`
      + '去「分类编辑」切到 English 表单补齐；赶时间可勾「缺英文时写中文并标黄」。</div>');
  }
  /**
   * 整页目的闸拦下来的时候必须说人话：这一页被判定成什么、凭什么、以及"我确认是网申表"的出口。
   * 误拦一整页比误填一栏更让人没法干活，所以放行按钮给的是**当次**放行（不写进设置）。
   */
  if (data?.purposeBlocked) {
    const pp = data.pagePurpose || {};
    const WHY = { login: '登录页', register: '注册页', newsletter: '订阅页', search: '搜索页', captcha: '只要验证码' };
    banners.push(`<div class="banner">这一页看起来不是网申表格（判定：<b>${WHY[pp.purpose] || escapeHtml(pp.purpose || '未知')}</b>`
      + (pp.evidence?.length ? `，依据：${escapeHtml(pp.evidence.join('；'))}` : '')
      + '）。已经整页停止填写 —— 一个字段都没写、也没改。'
      + '<br>确实要在这一页填：<button id="btnAllowPage" class="linkbtn">我确认这是网申表，照常填写（仅本次）</button></div>');
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
    // "我们没动的栏"要单独看得见：它不是失败，是按覆盖口径保住了站点预填与你手填的值
    ['没动的栏', (data?.results || []).filter(r => r.notOurs).length || 0],
    ['资料已填', s.profileFilled != null ? s.profileFilled : '-'],
    // AI 指认的栏位：非敏感按正常档位，但角标要看得见"这一栏的依据不是本地词典"
    ['AI 补栏', s.aiApplied || 0],
  ].map(([k, v]) => `<span><b>${k}</b> ${v}</span>`).join('') + adapterLine + banners.join('');
  $('stats').querySelector('#btnAllowPage')?.addEventListener('click', async () => {
    allowNonApplicationOnce = true;
    await run('full');
  });

  // 'skipped' 一般是噪音（已经填过、预演条目），但 **"我们不动这一栏"必须看得见** ——
  // 不然用户只会觉得"这一栏怎么没反应"，而真相是站点预填的值被我们的覆盖口径保住了。
  $('results').innerHTML = (data?.results || [])
    .filter(r => !['skipped'].includes(r.status) || r.notOurs || r.status === 'planned')
    .map(r => `<tr><td><span class="dot ${r.status === 'manual' ? 'orange' : r.status}"></span></td>
      <td>${escapeHtml(r.label || '(无标签)')}${r.aiChosen ? ' <span class="note">〔AI 选路〕</span>' : ''}</td>
      <td class="note">${escapeHtml(r.path || '')}<br>${r.score != null ? '置信 ' + r.score : ''} ${r.note ? '· ' + escapeHtml(r.note) : ''} ${r.failReason ? '· ' + escapeHtml(r.failReason) : ''}</td>
      <td>${escapeHtml(String(r.actual ?? '')).slice(0, 40)}</td></tr>`).join('');

  $('gaps').innerHTML = (data?.gaps || []).map(g =>
    `<tr><td><span class="dot orange"></span></td><td>${escapeHtml(g.label)}</td>`
    // 表格里给中文说明，原始 token 留在 title：用户看得懂下一步，报障时我们也对得上号
    + `<td class="note" title="${escapeHtml(g.reason || '')}">${escapeHtml(gapReasonLabel(g.reason))}${g.note ? '　·　' + escapeHtml(g.note) : ''}</td></tr>`).join('')
    || '<tr><td class="note">无</td></tr>';
  renderMapping(data);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let lastScan = null;   // 最近一次扫描的 {gaps, aiFields}：AI 兜底要问的就是这批缺口

async function run(mode, extra = {}) {
  const { mappingGate, ...rest } = extra || {};
  // 「映射表先行」把「扫描并填写」变成「扫描并出表」：这句话必须在表顶上说明白，
  // 否则用户看到的仍是"点了填写却没动静"。
  // 这里**不能无条件清空 panelNotice**：「按此映射填写」先落盘再调本函数，
  // 上一句"已记住 N 条 / 被拒 N 条"正是那一跳的结论，被这一渲染抹掉就等于没说。
  if (mappingGate) panelNotice = '映射表先行：这一轮只出了这张表，页面一个字节都没改。要落笔点「按此映射填写」。';
  const tab = await activeTab();
  tabId = tab?.id;
  const res = await chrome.runtime.sendMessage({
    type: 'nw:scan', tabId, mode, dryRun: mode === 'preview',
    allowNonApplication: allowNonApplicationOnce,
    // 带着"这张表是在哪一页算的"：后台据此判断本轮改判是否还对应这一页（切了页就拒，见 SW 注释）
    expectOrigin: scanOrigin,
    ...rest,
  });
  if (!res?.ok) {
    $('stats').innerHTML = `<span class="banner">页面未响应：${escapeHtml(res?.error || '未知错误')}。若是刚装扩展，请刷新目标页面后重试。</span>`;
    return;
  }
  lastScan = res.data;
  scanOrigin = res.data?.pageOrigin || '';
  if (res.confirmationRejected?.length) {
    panelNotice = `有 ${res.confirmationRejected.length} 条改判被拒（${res.confirmationRejected.map(x => x.why).slice(0, 2).join('；')}），这一轮没生效。`
      + (panelNotice ? `　${panelNotice}` : '');
  }
  render(res.data, { adapterId: res.adapterId, adapterInfo: res.adapterInfo });
}

// 用户主动发起的一次扫描该把上一轮的结论清掉（"已记住/被拒"是上一次动作的话）。
// AI 那批候选也一起作废：它们是**上一次扫描的那些缺口**的答案，重新扫过之后 index 可能对不上，
// 留着比丢掉危险。
$('btnScan').onclick = () => { panelNotice = ''; pendingWritten = false; lastAiCandidates = null; forgetAiMap(); run(mappingFirstOn() ? 'preview' : 'full', mappingFirstOn() ? { mappingGate: true } : {}); };
$('btnPreview').onclick = () => { panelNotice = ''; pendingWritten = false; lastAiCandidates = null; forgetAiMap(); run('preview'); };

// ── S6 映射表：一栏一行，确认后才写 ──────────────────────────────────
// 用户 2026-10-02 定的口径："一律先出映射表再写"。所以这张表不是"更多信息"，
// 而是写入的**唯一入口**：点「扫描并填写」在开关开着时只出表，一个字节都不写。
// 三条实现取向：
//  ① 行内只用 textContent / createElement —— 页面标签是不可信输入（tests/xss.test.js 钉过）；
//  ② 改判只决定"这一格是什么"，取值仍来自资料（这一栏里永远不出现取值）；
//  ③ 勾了「记住到本站」才落盘，且落盘前后台会再校验一次槽位是否真实存在。
const MAP_SCHEMA = buildFields();
const MAP_SKIP = '__skip__';
let pendingRules = new Map();      // 指纹 → { path, skip, note }（本轮改判，还没确认）
let pendingWritten = false;        // 这批改判是否已经按下去写过一次（措辞要跟着变）
let lastAiCandidates = null;       // 「问 AI」给出的那批候选：写入那一跳必须带上，不然 AI 的栏位在表里"存在过又消失"
// 这张表是在哪家站点上算出来的（扫描回包里的 pageOrigin）。改判落盘时带回去当凭据：
// 侧边栏不监听标签页切换，tabId 可能是旧的，用户却已经把那一页翻到别家招聘站了。
let scanOrigin = '';
let lastMapping = null;            // 最近一次扫描的映射表（导出与"已记住几条"都读它）
let panelNotice = '';          // 「映射表先行」把填写钮变成出表时的那句话
let mapJson = '';

function mappingFirstOn() {
  const el = $('mappingFirst');
  return el ? el.checked !== false : true;
}

/** 资料里的叶子取值摊平成 {路径: 值}：导出前用它核对"表里没夹带取值" */
function flattenValues(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flattenValues(v, p, out);
    else if (typeof v === 'string' && v.trim()) out[p] = v.trim();
  }
  return out;
}

/**
 * 补行的账必须上屏（审查 I1）：我们真的点了页面上的控件，
 * 却只在数据里留一个 rowExpansion 数组，等于动了手不报告。
 */
function renderRowExpansion(list) {
  if (!list?.length) return;
  const box = $('mapWarn');
  box.hidden = false;
  const head = document.createElement('div');
  head.className = 'witem';
  const t = document.createElement('b');
  const okAdds = list.filter(x => x.added > 0);
  t.textContent = okAdds.length
    ? `补行：我们点了「+ 添加一段」，补出 ${okAdds.reduce((a, x) => a + x.added, 0)} 行（${okAdds.map(x => `${SECTION_ZH_NAME(x.section) || x.section} ${x.added} 行`).join('、')}）`
    : `补行：试过了，一行都没补出来（${list.map(x => `${SECTION_ZH_NAME(x.section) || x.section}：${ROW_WHY_ZH[x.why] || x.why}`).join('；')}）`;
  head.appendChild(t);
  const act = document.createElement('span');
  act.className = 'wact';
  act.textContent = '下一步：每一轮最多补 3 行；不想让我们点加号，就去「填写授权」取消「允许补经历行」。';
  head.appendChild(act);
  box.appendChild(head);
}

const SECTION_ZH_NAME = s => ({ education: '教育经历', work: '工作经历', internship: '实习经历', projects: '项目经历', competitions: '竞赛', publications: '论文/专利', campus: '校园活动', awards: '获奖', certifications: '证书', languages: '语言', family: '家庭成员' }[s] || '');
const ROW_WHY_ZH = {
  no_section: '认不出这一节在页面上的范围，没敢点',
  no_container: '找不到这一节的容器，没敢点',
  no_add_button: '这一节里没找到能确认的「+ 添加一段」',
  stalled: '点了之后没长出新行，立刻停了',
  click_threw: '点击被页面拒绝，立刻停了',
};

function renderPlanWarnings(check) {
  const box = $('mapWarn');
  if (!box) return;
  const list = check?.warnings || [];
  box.textContent = '';
  box.hidden = !list.length;
  if (!list.length) return;
  const head = document.createElement('div');
  head.textContent = describePlanCheck(check);
  box.appendChild(head);
  for (const w of list) {
    const item = document.createElement('div');
    item.className = 'witem';
    const t = document.createElement('b');
    t.textContent = w.zh || w.kind;
    const act = document.createElement('span');
    act.className = 'wact';
    act.textContent = `下一步：${w.action || ''}`;
    item.append(t, act);
    box.appendChild(item);
  }
}

/** 一行里的标签块：kind / 必填 / 板块 / 第几组 / 选项数 / 自定义下拉 */
function pageTags(page) {
  const tags = [page.kind, page.labelSource && `来源:${page.labelSource}`, page.required ? '必填' : '',
    page.section && `板块:${page.section}`, page.itemIndex != null ? `第 ${page.itemIndex + 1} 组` : '',
    page.options?.length ? `${page.options.length} 个选项` : '', page.customSelect ? '自定义下拉' : ''];
  return tags.filter(Boolean);
}

/**
 * 表顶那行话的组装：面板上"刚刚发生了什么"的那句必须每次一起重排，
 * 否则改一个下拉就会把「映射表先行：一个字节都没写」这句盖掉 ——
 * 而那句话正是用户决定要不要再点一个钮的依据。
 */
function mapSummaryText(table) {
  if (!table?.rows?.length) return panelNotice || '映射表：暂无栏位。';
  const changed = pendingRules.size
    ? (pendingWritten
      ? `本轮你改了 ${pendingRules.size} 栏，这张表已经按它写过一次（再点会继续生效）。`
      : `本轮你改了 ${pendingRules.size} 栏，还没落笔 —— 点「按此映射填写」才会写。`)
    : '';
  return [panelNotice, describeMappingTable(table), changed].filter(Boolean).join('　');
}
function refreshMapSummary() { $('mapSummary').textContent = mapSummaryText(lastMapping); }

function renderMapping(data) {
  const host = $('mapTable');
  const summary = $('mapSummary');
  const table = data?.mapping || null;
  lastMapping = table;
  renderPlanWarnings(data?.planCheck);
  renderRowExpansion(data?.rowExpansion);   // 清了警告框之后才算：补行的账不能被校验提示覆盖掉
  if (!host) return;
  if (!table?.rows?.length) {
    host.textContent = data?.purposeBlocked
      ? '整页目的闸拦下了这一页，没有映射可出。确认是网申表请按上面的「我确认这是网申表」。'
      : '这一页没扫到栏位（或整页被拦下），所以映射表是空的。';
    summary.textContent = mapSummaryText(table);
    $('btnMapFill').disabled = true;
    return;
  }
  summary.textContent = mapSummaryText(table);
  host.textContent = '';
  const head = document.createElement('div');
  head.className = 'mrow mhead';
  for (const t of ['页面这一栏', '我们的判定', '凭什么', '现在是谁写的', '改判（只改这一栏）']) {
    const c = document.createElement('span');
    c.textContent = t;
    head.appendChild(c);
  }
  host.appendChild(head);
  const choices = slotChoices(MAP_SCHEMA, String($('mapSearch')?.value || '').trim(), 40);
  for (const r of table.rows) host.appendChild(mappingRow(r, choices));
  $('btnMapFill').disabled = false;
}

function mappingRow(r, choices) {
  const row = document.createElement('div');
  row.className = 'mrow';
  row.dataset.fp = r.fp;

  // ① 页面这一栏：只放页面自己的文字
  const c1 = document.createElement('span');
  const label = document.createElement('b');
  label.textContent = r.page.label || '(没读到标签)';
  c1.appendChild(label);
  const tagline = document.createElement('span');
  tagline.className = 'note';
  tagline.textContent = '　' + pageTags(r.page).join(' · ');
  c1.appendChild(tagline);
  if (r.page.options?.length) {
    const opts = document.createElement('span');
    opts.className = 'mwhy';
    opts.textContent = `　选项：${r.page.options.slice(0, 8).join(' / ')}${r.page.options.length > 8 ? ' …' : ''}`;
    c1.appendChild(opts);
  }
  if (r.page.description) {
    const d = document.createElement('span');
    d.className = 'mwhy';
    d.textContent = `　说明：${r.page.description}`;
    c1.appendChild(d);
  }
  if (r.collision > 1) {
    const col = document.createElement('span');
    col.className = 'banner';
    col.textContent = `　这一页有 ${r.collision} 栏自述完全相同：改判与「记住到本站」会对它们一起生效`;
    c1.appendChild(col);
  }

  // ② 我们的判定（槽位中文名 + 路径；没判定就给缺口说明）
  const c2 = document.createElement('span');
  const dot = document.createElement('span');
  const tier = r.decision.tier;
  dot.className = `dot ${tier === 'auto' ? 'green' : tier === 'review' ? 'yellow' : 'orange'}`;
  c2.appendChild(dot);
  const dec = document.createElement('span');
  dec.textContent = r.decision.skipKind === 'yours' || r.decision.gap === 'user_excluded'
    ? '不自动填（你的决定）'
    : r.decision.skip
      // "已有值所以不动"是我们的覆盖口径，不是他勾的：说成他的决定，他就会去找自己按过哪儿（I5）
      ? `这一栏${r.current === 'us' ? '是我们上一轮写的、值没变' : '已经有值'}，按口径不动`
      : r.decision.path ? `${r.decision.zh || r.decision.path}` : (r.decision.gapZh || '没定下来');
  c2.appendChild(dec);
  if (r.decision.path) {
    const p = document.createElement('span');
    p.className = 'mwhy';
    p.textContent = `　${r.decision.path}`;
    c2.appendChild(p);
  } else if (r.decision.slotGuess) {
    const g = document.createElement('span');
    g.className = 'mwhy';
    g.textContent = `　我们判它是「${r.decision.slotGuessZh}」，只是那份资料是空的`;
    c2.appendChild(g);
  }
  if (r.decision.actual) {
    const a = document.createElement('span');
    a.className = 'mwhy';
    a.textContent = `　写进去的是：${r.decision.actual}`;
    c2.appendChild(a);
  }

  // ③ 凭什么：来历 + 证据 + 说明
  const c3 = document.createElement('span');
  const by = document.createElement('span');
  by.className = 'mtag';
  by.textContent = r.decision.byZh || r.decision.by;
  c3.appendChild(by);
  const why = document.createElement('span');
  why.className = 'mwhy';
  why.textContent = [r.decision.evidence?.length ? `依据：${r.decision.evidence.join('/')}` : '',
    r.decision.score != null ? `置信 ${r.decision.score}` : ''].filter(Boolean).join('　');
  c3.appendChild(why);
  if (r.decision.note) {
    const n = document.createElement('span');
    n.className = 'mwhy';
    n.textContent = `　${r.decision.note}`;
    c3.appendChild(n);
  }

  // ④ 现状：这一格现在是谁写的（台账）+ 已有规则
  const c4 = document.createElement('span');
  const cur = document.createElement('span');
  cur.textContent = r.currentZh || r.current;
  c4.appendChild(cur);
  if (r.rule) {
    const rl = document.createElement('span');
    rl.className = 'mtag';
    rl.textContent = r.rule.skip ? '本站规则：不填' : `本站规则：${r.rule.path}`;
    rl.title = r.rule.temporary ? '本轮确认，没勾记住 —— 关页就没了' : '已记住到本站';
    c4.appendChild(rl);
    // 本轮确认压在已记住那条上面时，必须说"关页之后旧规则会回来"，
    // 否则他以为勾掉记住就恢复原状（独立审查 Minor）
    if (r.rule.alsoStored) {
      const back = document.createElement('span');
      back.className = 'mtag';
      back.textContent = `关页后回到：${r.rule.alsoStored.skip ? '不填' : r.rule.alsoStored.path}`;
      c4.appendChild(back);
    }
  }

  // ⑤ 改判：下拉（只在这一个站点、只改这一栏）+ 理由
  const c5 = document.createElement('span');
  const sel = document.createElement('select');
  const mk = (value, text) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    return o;
  };
  const pending = pendingRules.get(r.fp);
  // 已改判的那一栏必须先在渲染时就带上 pending 标记：以前只在 onchange 里加，
  // 于是"改判 → 换搜索词重画 → 看不出来改过，但写入照带"（独立审查 I4：隐蔽的 armed 状态）
  if (pending) row.classList.add('pending');
  sel.appendChild(mk('', `不改判（沿用「${r.decision.path ? r.decision.zh || r.decision.path : '没定下来'}」）`));
  sel.appendChild(mk(MAP_SKIP, '这一栏不自动填'));
  const listed = new Set();
  const push = (path, zh) => {
    if (!path || listed.has(path)) return;
    listed.add(path);
    sel.appendChild(mk(path, `${zh}　${path}`));
  };
  // 这一栏现在的判定永远排在最前：搜别的词时也不能把"它自己"从选项里挤掉
  if (r.decision.path) push(r.decision.path, `${r.decision.zh}（当前）`);
  // 本轮已改判但被搜索结果筛掉了 —— 也必须列出来，否则下拉显示"不改判"而写入仍带它
  if (pending?.path) push(pending.path, `${slotZhFor(MAP_SCHEMA, pending.path)}（你本轮改的）`);
  for (const c of choices) push(c.path, c.zh);
  sel.value = pending ? (pending.skip ? MAP_SKIP : pending.path) : '';
  if (!sel.value && pending) sel.value = '';
  const noteBox = document.createElement('input');
  noteBox.type = 'text';
  noteBox.placeholder = '为什么这么判（可空，会写进本站规则）';
  noteBox.value = pending?.note || '';
  sel.onchange = () => {
    if (sel.value === '') pendingRules.delete(r.fp);
    else pendingRules.set(r.fp, { path: sel.value === MAP_SKIP ? '' : sel.value, skip: sel.value === MAP_SKIP, note: String(noteBox.value || '').slice(0, 120) });
    row.classList.toggle('pending', pendingRules.has(r.fp));
    $('btnMapFill').textContent = pendingRules.size ? `按此映射填写（含 ${pendingRules.size} 栏改判）` : '按此映射填写';
    pendingWritten = false;   // 又改了一栏 → "已经按这张表写过"这句不再成立
    refreshMapSummary();
  };
  noteBox.oninput = () => {
    const p = pendingRules.get(r.fp);
    if (p) { p.note = String(noteBox.value || '').slice(0, 120); pendingRules.set(r.fp, p); }
  };
  c5.appendChild(sel);
  c5.appendChild(noteBox);

  row.append(c1, c2, c3, c4, c5);
  return row;
}

$('mappingFirst').onchange = async () => {
  const on = $('mappingFirst').checked;
  $('btnScan').textContent = on ? '扫描并出映射表' : '扫描并填写';
  await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { mappingFirst: on } });
  lastState = { ...(lastState || {}), settings: { ...(lastState?.settings || {}), mappingFirst: on } };
  panelNotice = on
    ? '开关已改：现在点「扫描并填写」也只出映射表，落笔要按「按此映射填写」。'
    : '开关已关：点「扫描并填写」会直接写页面（映射表仍然出，但不再拦着写入）。';
  refreshMapSummary();
};
$('mapSearch').oninput = () => { if (lastMapping) renderMapping({ mapping: lastMapping, planCheck: lastScan?.planCheck }); };

const RULES_ERROR_ZH = {
  no_origin: '当前页面不是 http(s) 站点，改判没地方存',
  origin_changed: '这个标签页已经翻到别的站点，而这张表是在旧站点上算的 —— 先重新扫描这一页再改判',
};
const rulesZh = err => RULES_ERROR_ZH[err] || err || '未知原因';

/** 规则类消息的 tabId 必须现取：面板没有标签页监听，旧 tabId 会让规则存到别处 */
async function currentTabId() {
  const tab = await activeTab();
  if (tab?.id != null) tabId = tab.id;
  return tabId;
}

$('btnMapFill').onclick = async () => {
  await currentTabId();
  const confirmed = [...pendingRules.entries()].map(([fp, r]) => ({ fp, path: r.path, skip: r.skip, note: r.note }));
  panelNotice = '';
  pendingWritten = true;
  const extra = {};
  // 「问 AI」补的那几栏必须一起带上：写入那一跳不带 aiCandidates，它们在表里就"存在过又消失"，
  // 用户看到的是"我确认过的表，写出来少了 AI 补的那几栏"（独立审查 Important 2）。
  if (lastAiCandidates?.length) extra.aiCandidates = lastAiCandidates;
  // 整页概念映射的回答同理：表上看得见 〔AI 概念映射〕 的那几栏，写入时必须还在
  if (lastAiMapSuggestions?.length) extra.aiPageMapSuggestions = lastAiMapSuggestions;
  let persisted = false;
  if (confirmed.length && $('mapRemember').checked) {
    const put = await chrome.runtime.sendMessage({ type: 'nw:siteRulesPut', tabId, expectOrigin: scanOrigin, entries: confirmed });
    persisted = Boolean(put?.ok);
    if (!persisted) {
      panelNotice = `改判没能记住（${rulesZh(put?.error)}）—— 这一轮仍按这些改判填写，但下一页/下一次重载就没了。`;
    } else {
      const rejected = put.rejected || [];
      panelNotice = `已记住 ${put.accepted} 条到本站`
        + (rejected.length ? `；被拒 ${rejected.length} 条：${rejected.map(x => x.why).slice(0, 3).join('；')}` : '')
        + '　正在按这张表写入…';
    }
  }
  // 没进存储的改判（没勾记住，或落盘失败）必须随这一次扫描带下去 ——
  // 以前落盘失败那一支只说了"仍按这些改判填写"，发出去的却不带 confirmed（Important 3）。
  if (confirmed.length && !persisted) extra.confirmed = confirmed;
  await run('full', extra);
};

$('btnMapRules').onclick = async () => {
  await currentTabId();
  const res = await chrome.runtime.sendMessage({ type: 'nw:siteRulesGet', tabId, expectOrigin: scanOrigin });
  const box = $('mapWarn');
  const rules = res?.rules || {};
  const fps = Object.keys(rules);
  box.hidden = false;
  box.textContent = '';
  const head = document.createElement('div');
  head.textContent = res?.ok
    ? `本站已记住 ${fps.length} 条改判（桶：${res.origin}）。这一页命中 ${lastMapping?.rows?.filter(r => rules[r.fp]).length || 0} 条。`
    : `读不到本站改判：${rulesZh(res?.error)}`;
  box.appendChild(head);
  for (const r of (lastMapping?.rows || []).filter(x => rules[x.fp])) {
    const item = document.createElement('div');
    item.className = 'witem';
    const t = document.createElement('b');
    t.textContent = `「${r.page.label || '(没读到标签)'}」→ ${rules[r.fp].skip ? '不自动填' : rules[r.fp].path}`;
    item.appendChild(t);
    if (rules[r.fp].note) {
      const n = document.createElement('span');
      n.className = 'wact';
      n.textContent = `当时的理由：${rules[r.fp].note}`;
      item.appendChild(n);
    }
    box.appendChild(item);
  }
};

$('btnMapForget').onclick = async () => {
  await currentTabId();
  const res = await chrome.runtime.sendMessage({ type: 'nw:siteRulesForgetSite', tabId, expectOrigin: scanOrigin });
  pendingRules = new Map();
  $('btnMapFill').textContent = '按此映射填写';
  panelNotice = res?.ok
    ? `本站的改判已忘记（剩 ${res.count ?? 0} 条）。正在按无改判重扫一遍…`
    : `忘记失败：${rulesZh(res?.error)}`;
  refreshMapSummary();
  await run('preview');
};

// ── 整页概念映射（S5 的回答进 S6 的表）──
// 与「问 AI 补缺口」的三条不同：范围是全页、选择集是约 60 个概念、结果一律先进这张表。
// 每次问都要先预览一次（预览把按钮解锁）—— 与缺口那条路同一套"按次确认"的规矩。
let lastAiMapPreview = null;
let lastAiMapSuggestions = null;

function aiMapPayloadFromTable() {
  const rows = lastMapping?.rows || [];
  const stateZh = { us: 'ours', edited: 'user', other: 'site', empty: 'empty' };
  const valueStates = {};
  const fields = rows.map(r => {
    valueStates[r.index] = stateZh[r.current] || 'empty';
    return {
      labelRaw: r.page.label, label: r.page.label, kind: r.page.kind, required: r.page.required,
      description: r.page.description, sectionTitle: r.page.section,
      options: r.page.options, nearbyLabels: r.page.nearby,
    };
  });
  return { fields, valueStates };
}

function forgetAiMap() {
  lastAiMapSuggestions = null;
  lastAiMapPreview = null;
  const btn = $('btnMapAi');
  if (btn) btn.disabled = true;
}

function aiMapReady() {
  const st = lastState?.settings || {};
  const target = normalizeBaseUrl(st.aiBaseUrl);
  return { ok: target.ok && Boolean(st.aiModel) && aiKeyPresent && aiConsentStored === (lastState?.aiKeyOrigin || ''), error: !target.ok ? (rulesZh(target.error) || '端点没填对') : (!st.aiModel ? '模型名没填' : (!aiKeyPresent ? '本次会话没有 Key' : '还没确认收件人')) };
}

$('btnMapAiPreview').onclick = async () => {
  await currentTabId();
  const status = $('mapAiStatus');
  if (!lastMapping?.rows?.length) { status.textContent = '还没扫这一页：先「扫描并出映射表」，才有栏位档案可发。'; return; }
  const gate = aiMapReady();
  if (!gate.ok) { status.textContent = `AI 还没配好（${gate.error}）—— 去下面「AI 兜底」那一段填端点、模型与 Key。`; return; }
  const { fields, valueStates } = aiMapPayloadFromTable();
  const res = await chrome.runtime.sendMessage({ type: 'nw:aiMapPage', tabId, fields, valueStates, preview: true });
  if (!res?.ok) { status.textContent = `预览失败：${res?.error || '未知原因'}`; lastAiMapPreview = null; $('btnMapAi').disabled = true; return; }
  lastAiMapPreview = { bytes: res.bytes, count: res.count, at: Date.now() };
  $('btnMapAi').disabled = false;
  status.textContent = `要发 ${res.count} 栏的档案，共 ${res.bytes} 字节（${res.trim?.why || '完整档案'}）`
    + '　里面只有页面文字与"这一栏空/已填"这类状态词，没有任何取值。确认无误再点「问一次整页」。';
};

$('btnMapAi').onclick = async () => {
  const status = $('mapAiStatus');
  if (!lastAiMapPreview) { status.textContent = '要先预览一次（每次问都重新预览、重新确认）。'; return; }
  await currentTabId();
  const { fields, valueStates } = aiMapPayloadFromTable();
  status.textContent = '正在问这一整页（推理模型可能要几十秒）…';
  const res = await chrome.runtime.sendMessage({ type: 'nw:aiMapPage', tabId, fields, valueStates });
  lastAiMapPreview = null;
  $('btnMapAi').disabled = true;
  if (!res?.ok) { status.textContent = `问失败了：${res?.error || '未知原因'}${res?.detail ? `（${String(res.detail).slice(0, 120)}）` : ''}`; return; }
  const rowAt = i => (lastMapping?.rows || []).find(r => r.index === i) || {};
  // 带上栏位指纹：页面在两跳之间自己增删过控件时，后台按指纹重新对号，而不是拿旧下标往别的栏位上写
  const suggestions = (res.mapping || []).filter(m => m.path).map(m => ({ index: m.index, fp: rowAt(m.index).fp || '', path: m.path, concept: m.concept, reason: m.reason, label: m.label }));
  const unclear = (res.mapping || []).filter(m => !m.path);
  lastAiMapSuggestions = suggestions.length ? suggestions : null;
  await run('preview', lastAiMapSuggestions ? { aiPageMapSuggestions: lastAiMapSuggestions } : {});
  // 落地结果不在 AI 回包里，而在紧随其后的那次"预演扫描"的回答里（缺口补了几个、黄字覆盖几个）
  const mapResult = lastScan?.aiMap || null;
  const refused = mapResult?.refused || [];
  status.textContent = `AI 答了 ${res.mapping?.length || 0} 栏：落到具体槽位 ${suggestions.length} 栏、说清"这栏是什么"但没法定位到唯一槽位 ${unclear.length} 栏；`
    + `它说认不出 ${(res.declined || []).length} 栏、被本地丢弃 ${res.dropped?.length || 0} 条。`
    + (mapResult ? `已按语义补进表里：补缺口 ${mapResult.filledGaps} 栏、覆盖没把握的黄字 ${mapResult.overridden} 栏` : '')
    + (refused.length ? `；没动的 ${refused.length} 栏都写了原因（例如"你在映射表里改过判，AI 不覆盖"）` : '')
    + `　${formatTiming(res.timing) || ''}`;
  if ((res.declined || []).length) {
    const first = res.declined.slice(0, 3).map(d => `「${d.label || `第 ${(Number(d.index) || 0) + 1} 栏`}」${d.reason || '没给理由'}`).join('；');
    status.textContent += `　它原话举例：${first}`;
  }
};


$('btnMapExport').onclick = () => {
  if (!lastMapping?.rows?.length) { panelNotice = '还没有映射表可导出（先扫一次这一页）。'; $('mapOut').value = ''; refreshMapSummary(); return; }
  mapJson = JSON.stringify(plainMappingTable(lastMapping), null, 1);
  const values = Object.values(flattenValues(lastState?.profile || {}));
  // 两道检查一起过：Key 形状（findLeaksInExport）+ 取值本身（长度分档，说明文字里更严）
  const leaks = [...findLeaksInExport(mapJson, {}).map(l => `${l.key}…（像 Key）`), ...findValueLeaks(JSON.parse(mapJson), values)];
  if (leaks.length) {
    panelNotice = `已拒绝导出：表里出现了资料取值（${leaks.slice(0, 4).join('、')}）。请把这一句连同构建号发回来。`;
    $('mapOut').value = '';
    refreshMapSummary();
    return;
  }
  $('mapOut').value = mapJson;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([mapJson], { type: 'application/json' }));
  a.download = `mapping-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  panelNotice = `已导出 ${lastMapping.rows.length} 行映射表：里面只有页面文字、槽位名与依据，没有你的任何取值。`;
  refreshMapSummary();
};


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

/**
 * AI 两条链路（填写兜底 / 辅助导入）共用的失败文案。
 * 之前两处各写一份 map，同一种错误一边说"调用失败：xxx"、另一边说人话 ——
 * 漂移的方向永远是"少写一条"，所以合并成一份并让两边都查它。
 */
const AI_ERROR_ZH = {
  ai_not_configured: '还没配好 Base URL / 模型 / Key（Key 只存本次会话）',
  value_leak: '自检拦下了这次请求，已拒绝发送',
  timeout: '请求超时：模型太慢或网络不通，先少问几栏再试（等待上限在「AI 兜底」里可改）',
  network_error: '网络错误：检查 Base URL 与站点可达性',
  payload_too_large: '请求体超限，一次问太多了，先分批',
  no_fragments: '本地解析没有剩余片段，不需要 AI 辅助',
  not_confirmed: '这次没点确认，没有发送任何内容',
  // 闸门拦下的几种（不是 API 出错）：措辞要说清按哪一步重来
  needs_consent: '没勾「我确认把 Key 与字段名发往 …」那一格 —— 勾上才允许发',
  // 站点级确认（每换一个招聘站点问一次）：这一栏的字段名与选项文案要离开本机
  needs_site_consent: '这一站还没确认过：勾上下面那行「以后在本页都允许…」，再点一次问 AI',
  site_consent_stale: 'AI 地址变了，之前在本页的确认已作废：重新勾一次那行站点确认',
  no_page_origin: '认不出当前标签页是哪个站点（不是 http/https 页面），因此不发任何字段名',
  origin_changed: 'Base URL 换过了，之前对旧地址的确认已作废：重新勾一次确认',
  origin_mismatch: 'Key 是在别的地址下录的，不会跟着发到这里：在当前 Base URL 下重新保存 Key',
  no_endpoint: '还没填 Base URL（应形如 https://…/v1）',
  no_key: '还没保存 Key（会话 Key 重启浏览器就失效，需要重录）',
  // 网络层：这三种都不是"模型慢"，等多久都不会变好，所以说清下一步查哪儿
  fetch_failed: '请求没出这台机器，或被网络层拒了（DNS / 代理 / 防火墙 / CORS 预检都会这样）。点「测一下连接」区分是域名连不上还是 POST 被拦',
  redirect_blocked: '这个地址把请求重定向到别处了 —— 禁跟跳转是故意的（不然 Key 会跟着跳到别的域）。请把 Base URL 填成最终地址本身',
  cancelled: '已取消等待，请求中止了',
  // 侧边栏认识这条消息、后台说不认识 = 后台还是旧构建（重载没生效）
  unknown_message: '后台不认这条消息：侧边栏是新版本、service worker 还是旧版本。'
    + '去 chrome://extensions 把本扩展开关关掉再打开（或点「Service Worker」→ 停止），然后关掉侧边栏重开',
  // 上游回得"没内容"的几种，各自成因不同、修法也不同
  reasoning_only: '模型只输出了"思考过程"，正文是空的 —— 换个非 reasoning 模型（或把它关掉）再来',
  truncated: '答案被长度上限砍断，JSON 不完整 —— 先少问几栏',
  empty_content: '上游回了 200 但正文是空的（多半是模型名或兼容层不对）',
  not_json: '上游回的不是 JSON：Base URL 可能指到了网页而不是 API 根路径（应形如 https://…/v1）',
  http_404: '这个地址上没有聊天端点（HTTP 404）—— 九成是 Base URL 最后一段路径没对上，试过的地址在下面',
  http_401: 'Key 不对或已失效（HTTP 401）：重新录一次 Key',
  http_403: '这个 Key 没有调用权限（HTTP 403）',
  http_429: '被限流或额度用完（HTTP 429）：等一会儿再试，或换个模型',
};

/**
 * 把后台/AI 的错误码翻成"下一步该做什么"。
 * HTTP 那几条必须把**真正请求过的 URL** 念出来：404 唯一的线索就是最后那段路径长什么样
 * （粘了完整端点 → 出现 /chat/completions/chat/completions；只粘主机名 → 少一段 /v1）。
 */
/**
 * 换了第二个候选才通 = 用户粘的 Base URL 形状不对。
 * 这次能填上不代表下次还顺：直接把该写成的地址说出来，比"成功"更值钱。
 */
function endpointNote(res) {
  const a = res?.attempted || [];
  if (a.length < 2) return '';
  const suggest = String(res.endpoint || '').replace(/\/chat\/completions\/?$/, '');
  return `　·　注意：第一个地址回了 ${a[0].status}，换到第二个才通 —— 把 Base URL 直接写成 ${suggest} 就不用绕这一趟`;
}

function aiErrorText(res) {
  const code = String(res?.error || '');
  // 超时最容易被误读成"插件坏了"：把实际等了多久和怎么调都说出来
  if (code === 'timeout') {
    const sec = res.waitedSec || aiTimeoutSecNow();
    return `等了 ${sec} 秒模型还没答完（不是出错了）。想多等就在「等待上限」里改大（当前 ${sec} 秒，最多 900），或者少问几栏`;
  }
  const known = AI_ERROR_ZH[code];
  const base = known
    || (/^http_/.test(code)
      ? `上游回了 HTTP ${code.slice(5)}${res?.detail ? '：' + res.detail : ''}`
      : '调用失败：' + (code || '未知错误'));
  const tried = (res?.attempted || []).map(a => a.url).filter(Boolean);
  const lines = tried.length ? tried : (res?.endpoint ? [String(res.endpoint)] : []);
  // 已经知道是 HTTP 类错误时 detail 已经并进 base 了，别再念一遍
  const tail = !known && /^http_/.test(code) ? '' : (res?.detail ? `\n${res.detail}` : '');
  // 时间线（上行字节 / 多久收到响应头）是判"出没出去"的直接证据，失败时一并念出来
  const when = formatTiming(res?.timing) ? `\n本次时间线：${formatTiming(res.timing)}` : '';
  return base + (lines.length ? `\n实际请求的地址：\n${lines.join('\n')}` : '') + tail + when;
}

/** 设置里生效的等待上限（秒）。与后台用同一个 clamp 规则，避免两边算出两个数。 */
function aiTimeoutSecNow() {
  const got = clampTimeoutSec($('aiTimeoutSec').value);
  return got.ok ? got.seconds : AI_TIMEOUT_DEFAULT_SEC;
}

/**
 * 请求在飞的时候：状态栏每秒报已等待时长，并定期给后台发心跳。
 * 心跳不是装饰 —— MV3 的 service worker 空闲约 30 秒会被回收，
 * 它一被回收，那个还在等的 fetch 的 sendResponse 就永远不会回来，
 * 用户看到的正好是"点了没反应"。
 */
function startAiWait(statusEl, label) {
  const limit = aiTimeoutSecNow();
  const t0 = Date.now();
  const paint = () => {
    const sec = Math.round((Date.now() - t0) / 1000);
    statusEl.textContent = `${label}（已等待 ${sec} 秒 / 上限 ${limit} 秒）`;
  };
  paint();
  const tick = setInterval(paint, 1000);
  // 长等待必须能中途停下：300 秒的计时器没有出口，等于把人锁在界面上
  const abortBtn = $('btnAiAbort');
  if (abortBtn) abortBtn.disabled = false;
  const beat = () => {
    // 心跳本身失败不该打扰用户：最坏情况就是回到"没心跳"的老行为
    Promise.resolve(chrome.runtime.sendMessage({ type: 'nw:keepAlive' })).catch(() => {});
  };
  // 第一次立刻发：worker 是在"没事干 30 秒"后被回收的，
  // 等 15 秒才拍第一下手，正好可能落在它已经被杀了之后
  beat();
  const timer2 = setInterval(beat, 15000);
  return () => {
    clearInterval(tick); clearInterval(timer2);
    if (abortBtn) abortBtn.disabled = true;   // 计时一停，「取消等待」就该灰掉
  };
}

/**
 * 站点级确认那一行：只在后台说"这一站还没确认过 / 确认已过期"时出现。
 * 页面地址由后台按 tabId 查回来，界面只负责把它念给用户看（textContent，永不进 HTML）。
 */
const SITE_GATE_ERRORS = new Set(['needs_site_consent', 'site_consent_stale', 'no_page_origin']);
function showSiteConsentRow(error, pageOrigin) {
  const row = $('aiSiteRow');
  if (!row) return;
  if (!SITE_GATE_ERRORS.has(String(error || ''))) { row.hidden = true; $('aiSiteConsent').checked = false; return; }
  $('aiSiteTarget').textContent = pageOrigin || '（认不出这一页是哪个站点）';
  $('aiSiteConsent').checked = false;
  row.hidden = false;
}
$('aiSiteConsent')?.addEventListener('change', async e => {
  if (!e.target.checked) {
    // 反勾 = 撤回本站确认（后台那条记录删掉），不然界面和账本会分叉
    await chrome.runtime.sendMessage({ type: 'nw:aiConsentSite', tabId, revoke: true });
    $('aiStatus').textContent = '已撤回本页的站点确认，下次问 AI 会重新问。';
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'nw:aiConsentSite', tabId });
  if (!res?.ok) {
    e.target.checked = false;
    $('aiStatus').textContent = `记下本站确认失败：${ENDPOINT_ERROR_ZH[String(res?.error || '').replace('endpoint_', '')] || res?.error || '未知错误'}`;
    return;
  }
  $('aiStatus').textContent = `已记下：${res.pageOrigin} 的字段名可以发往 ${res.targetOrigin}（换了 AI 地址会重新问）。再点一次「问 AI 补全缺口」。`;
});

function aiUiSync() {
  const base = normalizeBaseUrl($('aiBaseUrl').value);
  $('aiConsentTarget').textContent = base.ok ? base.origin : (ENDPOINT_ERROR_ZH[base.error] || '先填 Base URL');
  // 勾是"意图"，aiConsentStored 才是后台认的事实。让界面显示等于事实：
  // 之前两者会分叉（确认被后台作废了、勾还留着），点「问 AI」只得到一句 needs_consent。
  $('aiConsent').checked = Boolean(aiConsentStored) && base.ok && aiConsentStored === base.origin;
  // Base URL 与录入 Key 时不是同一个 origin → 确认必须作废、Key 也要重录
  if (base.ok && aiKeyBoundOrigin && aiKeyBoundOrigin !== base.origin) {
    $('aiKeyState').textContent = `Base URL 变了：之前录的 Key 绑在 ${aiKeyBoundOrigin}，不会跟着发到新地址。请重新保存 Key。`;
  }
  const ready = base.ok && aiConsentStored === base.origin && aiKeyPresent && aiKeyBoundOrigin === base.origin && Boolean($('aiModel').value.trim());
  $('btnAiAsk').disabled = !ready;
  // 自检也带 Key 出门，闸门与「问 AI」一模一样：不能让「只是测一下」绕过确认
  $('btnAiPing').disabled = !ready;
  $('btnAiPing').title = ready ? '' : '同样需要：合法 https Base URL + Key + 模型名 + 勾上「确认发往该地址」（自检会把 Key 发出去）';
  $('btnAiAsk').title = ready ? '' : '需要：合法 https Base URL + 已保存的 Key + 模型名 + 勾上「确认发往该地址」';
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
  aiConsentStored = String(res?.consentOrigin || '');
  $('aiStatus').textContent = res?.ok
    ? `Base URL 已保存：${base.url}` + (aiConsentStored === base.origin ? '' : ' · 端点变了，之前的确认已作废，需要重新勾')
    : '保存失败：' + (res?.error || '');
  aiUiSync();
};
$('aiModel').onchange = async e => {
  await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { aiModel: e.target.value.trim() } });
  aiUiSync();
};
$('aiTimeoutSec').onchange = async e => {
  const raw = e.target.value.trim();
  if (!raw) {   // 清空 = 回到默认，而不是把超时设成 0
    await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { aiTimeoutSec: '' } });
    $('aiTimeoutState').textContent = `当前生效：${AI_TIMEOUT_DEFAULT_SEC} 秒（默认）`;
    return;
  }
  const got = clampTimeoutSec(raw);
  if (!got.ok) {
    const why = {
      timeout_invalid: '等待上限要填数字（秒）',
      timeout_too_small: `最少 15 秒；太小的话模型还没来得及答就被掐了`,
      timeout_too_large: '最多 900 秒（15 分钟）；真要这么久，不如把缺口分批问',
    }[got.error];
    $('aiTimeoutState').textContent = `${why}（保持 ${effectiveTimeoutSec({ aiTimeoutSec: '' })} 秒不变）`;
    e.target.value = '';
    return;
  }
  await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { aiTimeoutSec: got.seconds } });
  e.target.value = String(got.seconds);
  $('aiTimeoutState').textContent = `当前生效：${got.seconds} 秒`;
};

// 回答长度上限（max_tokens）：reasoning 模型把思考链也算进这里，给小了就表现为"AI 没建议"
$('aiMaxTokens').onchange = async e => {
  const raw = e.target.value.trim();
  if (!raw) {
    await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { aiMaxOutput: '' } });
    $('aiMaxTokensState').textContent = `当前生效：${AI_MAX_TOKENS_DEFAULT} token（默认）`;
    return;
  }
  const got = clampMaxTokens(raw);
  if (!got.ok) {
    const why = {
      output_invalid: '回答长度要填数字（token）',
      output_too_small: '最少 500：再小就连一条完整建议都装不下了',
      output_too_large: '最多 16000：更大的窗口该由服务商那边确认',
    }[got.error];
    $('aiMaxTokensState').textContent = `${why}（保持 ${AI_MAX_TOKENS_DEFAULT} 不变）`;
    e.target.value = '';
    return;
  }
  await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { aiMaxOutput: got.tokens } });
  e.target.value = String(got.tokens);
  $('aiMaxTokensState').textContent = `当前生效：${got.tokens} token`;
};
// 流式接收：默认开。关掉只是回到"等整段生成完再一次性收"，不影响发送内容与闸门。
$('aiStream').onchange = async e => {
  await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { aiStream: e.target.checked } });
  lastState = { ...(lastState || {}), settings: { ...(lastState?.settings || {}), aiStream: e.target.checked } };
  $('aiStatus').textContent = e.target.checked
    ? '已开流式：答案边生成边收，能看到第一个字节的耗时。'
    : '已关流式：会等整段生成完一次性收 —— 那时"慢"和"不通"在界面上分不开，超时也更常见。';
};
$('aiConsent').onchange = async e => {
  const base = normalizeBaseUrl($('aiBaseUrl').value);
  if (!e.target.checked) {
    const off = await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { aiConsentOrigin: '' } });
    aiConsentStored = String(off?.consentOrigin || '');
    $('aiStatus').textContent = '已收回确认：现在一个字节都不会发出去';
    aiUiSync();
    return;
  }
  if (!base.ok) { $('aiStatus').textContent = ENDPOINT_ERROR_ZH[base.error] || 'Base URL 不合法，无法确认'; aiUiSync(); return; }
  const on = await chrome.runtime.sendMessage({ type: 'nw:saveSettings', settings: { aiConsentOrigin: base.origin } });
  aiConsentStored = String(on?.consentOrigin || '');
  // 后台没记下就必须如实说，不能让那个勾留在界面上骗人
  $('aiStatus').textContent = aiConsentStored === base.origin
    ? `已确认：Key 与字段名只发往 ${base.origin}`
    : '确认没有被记下（端点与确认对不上），请重新填 Base URL 后再勾一次';
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
  // 清除 Key 时把端点确认一起收掉：留着"已确认发往 https://…"但没 Key 的空壳状态，
  // 下次重录 Key 就会带着一个用户已经不记得给过的授权直接发出去
  aiConsentStored = '';
  $('aiKeyState').textContent = '当前没有 Key（会话与本机两个位置都已清除，端点确认同时作废）。';
  $('aiStatus').textContent = 'Key 与确认都已清除';
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
  $('aiStatus').textContent = `将发送 ${res.asks} 个缺口 · ${res.bytes} 字节 · 目标 ${res.endpoint || '未配置'} · 以上文本就是实际请求体全文`
    + (res.trim?.level ? `　·　为控制体积：${res.trim.why}` + (res.trim.droppedQuestions ? `，并少问 ${res.trim.droppedQuestions} 栏` : '') : '');
};
$('btnAiAsk').onclick = async () => {
  if (!await aiNeedsScan()) return;
  const stopWait = startAiWait($('aiStatus'), '正在请求（只发字段名，等模型答完）');
  try {
    const profile = JSON.parse($('profileText').value || '{}');
    const res = await chrome.runtime.sendMessage({ type: 'nw:aiAsk', profile, gaps: lastScan.gaps, fields: lastScan.aiFields, tabId });
    if (!res?.ok) {
      const why = aiErrorText(res);
      $('aiStatus').textContent = why;
      // 被站点级确认拦下：把那一站的名字摊出来，勾一次记一站
      showSiteConsentRow(res?.error, res?.pageOrigin);
      const box = $('aiPreviewText');
      box.hidden = false;
      // why 里已经带上游原文（res.detail）与试过的地址了，这里不能再拼一遍
      box.textContent = [why, res.finishReason ? `finish_reason=${res.finishReason}` : '', res.reasoningChars ? `思考过程 ${res.reasoningChars} 字` : '']
        .filter(Boolean).join('\n');
      return;
    }
    if (!res.candidates.length) {
      const box = $('aiPreviewText');
      box.hidden = false;
      const declined = res.declined || [];
      // "回了 N 字、丢弃 0 条"是最难看懂的一句：模型其实答了，答的是"这一栏我认不出"。
      // 把是哪一栏、它自己给的理由念出来，用户才知道下一步该补标签还是补资料，而不是再点一次。
      const declinedText = declined.length
        ? `AI 明确说认不出 ${declined.length} 栏：` + declined.map(d => `「${d.label || '(页面上没标签)'}」${d.reason ? `（${d.reason}）` : ''}`).join('、')
          + '\n这些栏我们什么都没收，也不会乱填 —— 如果它标签是空的，那是我们没抓到标签，导出「页面结构探针」我就能定位。'
        : `AI 回了 ${res.rawChars} 字，但没有一条能落进白名单（丢弃 ${res.dropped.length} 条：`
          + [...new Set(res.dropped.map(d => d.reason))].join('、') + '）';
      box.textContent = declinedText
        + (res.finishReason ? `\nfinish_reason=${res.finishReason}` : '')
        + `\n它原样回的前 200 字：\n${res.snippet || '（空）'}`;
      $('aiStatus').textContent = declined.length
        ? `AI 认不出 ${declined.length} 栏（都留着没填）—— 下面有它的原话`
        : `AI 没有给出可用建议（丢弃 ${res.dropped.length} 条）—— 下面有原始回显`;
      return;
    }
    lastAiCandidates = res.candidates;
    await run('preview', { aiCandidates: res.candidates });
    showSiteConsentRow('', '');   // 问通了说明两道闸都过了，那一行不该继续挂着
    $('aiStatus').textContent = `AI 补齐 ${res.candidates.length} 栏（敏感字段黄字待你核对，其余按正常档位；来源标了〔AI 选路〕）；${formatTiming(res.timing) ? formatTiming(res.timing) + '；' : ''}`
      // 「扫描并填写」在映射表先行开着时只出表，所以这句指路不能写死按钮名（Important 2）
      + `已在映射表里预演出来，核对后点「按此映射填写」才会写页面`
      + (res.finishReason === 'length' ? ' —— 注意：这次回答被长度上限截断了，可能还有缺口没给出，再点一次问剩下的' : '')
      + endpointNote(res) + streamNote(res);
  } finally { stopWait(); }   // 任何一条出口都得停掉计时与心跳，不能让它在后台一直跳
};
/** 一次请求的时间线，念成人话：上行多少字节、多久收到响应头、多久收到正文。 */
function formatTiming(t) {
  if (!t) return '';
  const parts = [`上行 ${t.upBytes || 0} 字节`];
  if (t.headersMs != null) parts.push(`响应头 ${t.headersMs}ms`);
  else parts.push('没收到响应头');
  if (t.firstChunkMs != null) parts.push(`第一个字节 ${t.firstChunkMs}ms`);
  if (t.bodyMs != null) parts.push(`正文 ${t.bodyMs}ms`);
  return parts.join(' · ');
}

/** 流式这一发到底是怎么通的：自动退回过要讲，正常流式也值得报第一个字节。 */
function streamNote(res) {
  if (res?.streamFallback) return '　·　这次服务商没接受流式，已自动退回普通收法才拿到答案（可以把「流式接收」关掉省一发）';
  if (res?.firstChunkMs != null) return `　·　流式：第一个字节 ${res.firstChunkMs}ms 就到了`;
  return '';
}

/**
 * 「测一下连接」的结论。每种判定都给"下一步查哪儿"，
 * 因为用户看到的都是同一句"在等"，而三种成因的修法互不相干。
 */
function pingVerdictText(res) {
  const where = `地址 ${res?.endpoint || res?.origin || '（未配置）'}`;
  const timing = formatTiming(res?.timing) ? `（${formatTiming(res.timing)}）` : '';
  // 后台答不上这句 = 它压根没有自检这个功能 = 浏览器里跑的还是旧 worker
  if (res?.error === 'unknown_message' || res?.verdict === 'unknown_message') return AI_ERROR_ZH.unknown_message;
  const V = {
    ok: `通了：${timing}。那"问 AI"卡住就不是连接问题，而是模型生成得慢 —— 少问几栏、把上限调大，或换非 reasoning 模型。`,
    key_rejected: `连上了，但 Key 被拒（HTTP ${res?.status}）${timing}。被拒的请求一般不进用量记录，所以"用量为 0"与此一致 —— 重新录 Key。`,
    path_not_found: `连上了，但这个地址上没有聊天端点（HTTP ${res?.status}）：${where}。看下面是试过的地址，Base URL 通常应填到 /v1 为止。`,
    rate_limited: `连上了，但被限流（429）${timing}：等一会儿再试，或换模型/额度。`,
    upstream_error: `连上了，但对端自己报错（HTTP ${res?.status || res?.error}）${timing}：这不是插件的问题，看服务商状态页或稍后再试。`,
    unreachable: `这台电脑连不上 ${res?.origin || ''} —— 连不带凭据的 GET 都没回来。所以用量必然是 0：请求根本没出门。查代理 / VPN / DNS / 防火墙（公司网络常拦境外 API 域）。`,
    post_blocked: `${res?.origin || ''} 连得上（GET ${res?.originMs}ms，HTTP ${res?.originStatus}），但 POST 被拒 —— 多半是代理/防火墙只放行简单请求，或 CORS 预检没过去。把这条结果发我。`,
    no_first_byte: `域名连得上，但连"只回一个词"的请求都摸不到第一个字节（GET ${res?.originMs}ms 就通）—— 对端确实没回话。`
      + '这通常不是模型慢：查服务商状态页、账号是否被限，或中间是否有网关把 POST 挂住了。',
    holding_response: `路是通的：非流式那一发在 ${res?.timing?.limitMs ? Math.round(res.timing.limitMs / 1000) : 15} 秒内没吐字节，`
      + `但改成流式后，从请求发出算 ${res?.firstChunkMs ?? '?'}ms 就收到了第一个字节。说明对端要等整段生成完才发（reasoning 模型尤其明显）—— `
      + '这是"慢"不是"不通"：把「回答长度上限」调大、一次少问几栏，或换非 reasoning 模型。',
    streaming_stalled: `响应头 ${res?.timing?.headersMs}ms 就到了，但正文一直没写完 —— 生成中途挂住，通常是模型侧或中间代理缓冲。`,
    redirect_blocked: `这个地址会把请求重定向到别处（我们禁止跟跳转，否则 Key 会跟着跑到别的域）。请把 Base URL 填成最终地址本身。`,
    bad_body: `对方回了 HTTP 200，但正文不是一份能用的 JSON 响应${timing} —— 通常是中间有个"网页版"网关或 Base URL 指错了服务，不是连不上的问题。`,
    http_error: `对方回了没见过的状态码 HTTP ${res?.status}${timing}：按服务商的报错页处理。`,
    bad_endpoint: `Base URL 不合法：${res?.detail || ''}。应形如 https://…/v1，不要带 ?query。`,
    not_configured: `还没配好模型名或 Key，自检也没法发。`,
    gate_needs_consent: `没勾「我确认把 Key 与字段名发往 …」：自检也要带 Key，所以同样要勾。`,
    gate_origin_changed: `Base URL 改过了，之前对旧地址的确认已作废：重新勾一次。`,
    gate_origin_mismatch: `Key 是在别的地址下录的，不会跟着发到这里：在当前 Base URL 下重新保存 Key。`,
  };
  const v = V[res?.verdict];
  const tried = (res?.attempted || []).map(a => a.url).filter(u => u && u !== res?.endpoint);
  // 结论后面永远附上打的是哪个地址：截图报障时这一行就是全部上下文
  const addr = `\n请求地址：${res?.endpoint || res?.origin || '（未配置）'}`
    + (tried.length ? `\n还试过：\n${tried.join('\n')}` : '');
  return (v || `自检回了个没见过的结果：${JSON.stringify({ verdict: res?.verdict, error: res?.error, status: res?.status })}`) + addr;
}

$('btnAiPing').onclick = async () => {
  const el = $('aiPingState');
  el.textContent = '正在自检（15 秒内）…';
  $('btnAiPing').disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'nw:aiPing', timeoutSec: 15 });
    el.textContent = pingVerdictText(res);
  } finally {
    $('btnAiPing').disabled = false;
  }
};

$('btnAiAbort').onclick = async () => {
  $('btnAiAbort').disabled = true;
  await chrome.runtime.sendMessage({ type: 'nw:aiAbort' }).catch(() => {});
  $('aiStatus').textContent = '已请求取消：等这一条回包中止（不会真的把答案应用上）';
};

$('btnUndo').onclick = async () => {
  await currentTabId();
  await chrome.runtime.sendMessage({ type: 'nw:undo', tabId });
  // 撤销之后不能把映射表抹成"没扫到栏位"（审查 Minor：那会让导出和改判都在下一跳前失效）。
  // 重新只读扫一遍：账本已擦掉、页面已复原，表里看到的就是真实现状。
  panelNotice = '已回滚这一轮的写入，并重新只读扫了一遍这一页。注意：撤销会把上一轮那个值放回页面，'
    + '那一格从此算"别人写的" —— 要再写它请先在映射表里改判。';
  pendingWritten = false;
  lastAiCandidates = null;
  await run('preview');
};
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
$('btnTemplate').onclick = () => {
  const blank = createEmptyProfile();
  const blob = new Blob([JSON.stringify(blank, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'nw-autofill-profile-template.json';
  a.click();
  const enTotal = buildFields().filter(f => !isLangNeutral(f)).length;
  alert(`空白模板含 ${SECTIONS.length} 个分组、${buildFields().length} 个可填项；`
    + `文件末尾的 "en" 子树已经摆好 ${enTotal} 个需要英文写法的栏位（日期/数字/邮箱/选项这些不重复要英文）。\n\n`
    + '用文本编辑器打开这个 JSON：中文值写在原路径，英文值写在 en 下的同一路径（education → 第 1 条 → school，对应 en → education → 第 1 条 → school），'
    + '再回到这里「编辑 / 导入 JSON」粘贴保存即可。');
};

/**
 * 导出**当前资料**（不是空模板）。存在的意义只有一个：换机或清库之前你能把它带走。
 * 只导出 profile —— settings 里有端点与授权痕迹、aiSecrets 里有 Key，
 * 那两个不该被顺手写进一个"备份文件"里（导出物常被人丢进网盘或微信）。
 */
$('btnExportProfile').onclick = async () => {
  const state = await chrome.runtime.sendMessage({ type: 'nw:getState', tabId });
  const profile = state?.profile;
  if (!profile) { $('exportNote').textContent = '还没有资料可导出：先导入 Markdown 或展开表单编辑填一份。'; return; }
  const filled = countFilled(profile);
  ensureEnSkeleton(profile);   // 导出文件里要看得见英文的落点，不能只有几栏旧键
  if (!window.confirm(`将下载一份包含你全部简历资料的 JSON（${filled} 项有值，含证件号/手机号等敏感字段）。\n\n这个文件是明文：下载后请自己保管，别丢进网盘共享目录或聊天窗口。确认下载？`)) {
    $('exportNote').textContent = '已取消，没有写出任何文件。';
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' }));
  a.download = `nw-autofill-profile-${day}.json`;
  a.click();
  $('exportNote').textContent = `已导出 ${filled} 项有值的资料（文件名 nw-autofill-profile-${day}.json）。它不含端点、不含 Key —— 那两样本来就不该跟着备份文件跑。`;
};

// ── 保险箱：把资料加密成你自选位置的本地文件（浏览器里那份仍是明文工作副本，这点不含糊）──
const VAULT_ERR_ZH = {
  passphrase_empty: '先输口令（至少 8 位）。口令不会被保存，也不会写进文件 —— 忘了就解不开。',
  passphrase_too_short: '口令太短（至少 8 位）：这么短的口令挡不住拿到文件的人。',
  not_json: '这个文件不是 JSON，读不动。',
  not_vault: '这个文件不是保险箱（看起来是明文 profile 备份）：那种走上面的「编辑 / 导入 JSON」。',
  wrong_passphrase_or_tampered: '解不开：口令不对，或文件被改过（AES-GCM 带完整性校验，改一个字节都会失败）。浏览器里那份资料没有被改动。',
  no_webcrypto: '这个浏览器不给你 WebCrypto，加密功能用不了。',
};

function downloadJson(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
}

/** 写文件：优先浏览器的文件选择器（能挑出网盘同步范围），没有就退回下载目录 */
async function writeVaultFile(name, text) {
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'nw-autofill 保险箱', accept: { 'application/json': ['.json'] } }],
      });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      return { ok: true, where: handle?.name || name, picked: true };
    } catch (err) {
      if (String(err?.name || '') === 'AbortError') return { ok: false, cancelled: true };
      return { ok: false, error: String(err?.message || err) };
    }
  }
  downloadJson(name, text);
  return { ok: true, where: '浏览器下载目录/' + name, picked: false };
}

$('btnVaultSave').onclick = async () => {
  const note = $('vaultNote');
  const btn = $('btnVaultSave');
  const state = await chrome.runtime.sendMessage({ type: 'nw:getState', tabId });
  const profile = state?.profile;
  if (!profile || !countFilled(profile)) { note.textContent = '资料还是空的，没什么可加密的。'; return; }
  ensureEnSkeleton(profile);   // 保险箱里也要带着英文落点：从加密文件恢复的人同样要能手写英文
  const passphrase = $('vaultPass').value;
  btn.disabled = true;
  note.textContent = '正在加密（口令派生约 1 秒，别关面板）…';
  try {
    const enc = await encryptVault({ profile, passphrase, build: BUILD });
    if (!enc.ok) { note.textContent = VAULT_ERR_ZH[enc.error] || ('没能加密：' + enc.error); return; }
    const name = `nw-autofill-vault-${new Date().toISOString().slice(0, 10)}.json`;
    const wrote = await writeVaultFile(name, JSON.stringify(enc.vault, null, 2));
    if (wrote.cancelled) { note.textContent = '已取消，没有写出任何文件。'; return; }
    if (!wrote.ok) { note.textContent = '写入失败：' + wrote.error; return; }
    $('vaultPass').value = '';
    note.textContent = `已写成密文文件：${wrote.where}（${countFilled(profile)} 项有值，文件里不含任何明文）`
      + (wrote.picked ? '' : '　·　这个浏览器没提供文件选择器，只能落到下载目录 —— 记得自己挪出网盘同步范围')
      + '　·　口令只用过一次，但 JS 无法真正把内存清零：公共电脑上别做这件事。';
  } catch (err) {
    note.textContent = '加密失败：' + String(err?.message || err);
  } finally { btn.disabled = false; }
};

$('btnVaultOpen').onclick = () => { $('vaultFile').value = ''; $('vaultFile').click(); };

$('vaultFile').onchange = async e => {
  const note = $('vaultNote');
  const file = e.target?.files?.[0];
  if (!file) return;
  let text = '';
  try { text = await file.text(); } catch { note.textContent = '文件读不出来。'; return; }
  // 口令只在这一刻用一下：不写 storage、不进日志、不进任何回包
  const got = await decryptVault({ text, passphrase: $('vaultPass').value });
  if (!got.ok) { note.textContent = VAULT_ERR_ZH[got.error] || ('打不开：' + got.error); return; }
  const state = await chrome.runtime.sendMessage({ type: 'nw:getState', tabId });
  // 比对要把英文值一起算：只看中文路径会把"保险箱里英文写法多一半/少一半"报成"完全一致"，
  // 而那正是用户载入前最想知道的事。
  const enFields = buildFields().filter(f => !isLangNeutral(f))
    .map(f => ({ ...f, path: `en.${f.path}`, zh: `英文·${f.zh || f.path}` }));
  const delta = profileDelta(state?.profile || {}, got.profile, buildFields().concat(enFields));
  const lost = delta.willLose.length
    ? `\n会被清空的栏（前 ${delta.willLose.length} 个）：${delta.willLose.join('、')}${delta.removed > delta.willLose.length ? ' …' : ''}` : '';
  if (!window.confirm(`载入这份保险箱会覆盖浏览器里现在的工作副本：\n${describeDelta(delta)}${lost}\n\n确认载入？`)) {
    note.textContent = '已取消，浏览器里的资料没动。';
    return;
  }
  await chrome.runtime.sendMessage({ type: 'nw:saveProfile', profile: got.profile });
  $('vaultPass').value = '';
  note.textContent = `已载入并保存：${describeDelta(delta)}${got.meta?.builtAt ? `（文件写于 ${String(got.meta.builtAt).slice(0, 10)}）` : ''}`;
  await refresh();
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
  lastImportReport = report;
  extractReset(report.unplaced && report.unplaced.length ? `本地判不动 ${report.unplaced.length} 段，可用下面「AI 辅助导入」逐字归位` : "本地解析没有剩余片段，不需要 AI 辅助");
};

// ── AI 辅助导入 ────────────────────────────────────────────────────────
// 与填写侧的 AI 兜底是两条不同的边界：这里发出去的是"本地解析判不动的简历片段"，
// 所以护栏是"预览 + 每次点发送都重新确认 + 逐字校验"，缺一条都不许静默发出去。
let lastImportReport = null;      // 上一次「解析并填入」留下的报告
let extractReady = null;          // 预览过的片段：没预览过就不给发

function extractReset(msg) {
  $('extractStatus').textContent = msg || '';
  $('extractResults').replaceChildren();
  $('extractPreviewText').hidden = true;
  extractReady = null;
  $('btnExtractRun').disabled = true;
}

$('btnExtractPreview').onclick = async () => {
  if (!lastImportReport) { extractReset('先在上面「解析并填入」一次，才知道哪些片段本地判不动'); return; }
  const profile = JSON.parse($('profileText').value || '{}');
  const res = await chrome.runtime.sendMessage({ type: 'nw:extractPreview', profile, report: lastImportReport });
  const box = $('extractPreviewText');
  if (!res?.ok || typeof res.text !== 'string') {
    box.hidden = false;
    box.textContent = '预览失败：' + (res?.error || '后台没有返回可预览的文本');
    extractReset('预览失败，未发送任何内容');
    return;
  }
  box.hidden = false;
  // 被拦下的片段不进请求，但必须在这里列出来：正则会把"2021 2022 2023 2024"这类
  // 正常内容也判成号码，静默少发一段比误拦更难发现。
  const blockedList = (res.blocked || []).length
    ? `\n\n（以下 ${res.blocked.length} 段没有发出，理由见括号，请自己手动补进资料）\n`
      + res.blocked.map(b => `  · ${b.head || ''}… （${b.reason === 'budget' ? '超出本次片段预算' : '含号码样式内容，安全规则拦下'}）`).join('\n')
    : '';
  box.textContent = `（将发往：${res.endpoint || '未配置地址'}，共 ${res.fragments} 段 / ${res.bytes} 字节，下面就是实际请求体全文）\n\n${res.text}${blockedList}`;
  extractReady = { fragments: res.fragments, bytes: res.bytes, endpoint: res.endpoint || '未配置地址' };
  const blocked = (res.blocked || []).length ? `，另拦下 ${res.blocked.length} 段（理由 ${res.blocked[0].reason}）` : '';
  $('extractStatus').textContent = `待发 ${res.fragments} 段${blocked} · 目标 ${extractReady.endpoint} · 点右边按钮会再问你一次`;
  $('btnExtractRun').disabled = false;
};

$('btnExtractRun').onclick = async () => {
  if (!extractReady) { extractReset('请先点「预览将发送的片段」'); return; }
  // 按次确认：每一次发送都要用户在这个框里再点一次，不记住上次的同意
  const ready = extractReady;
  const ok = window.confirm(
    `这次将把 ${ready.fragments} 段简历原文（约 ${ready.bytes} 字节）发给：\n${ready.endpoint}\n\n`
    + '模型只能逐字摘录这些片段里的原文；返回结果会先列出来给你勾选，勾了才写入资料。\n现在发送吗？');
  if (!ok) {
    $('extractStatus').textContent = '已取消，什么都没发出去';
    return;                                     // 保留 ready：预览过的事实不该被一次取消冲掉
  }
  extractReset();                               // 发一次就清空，再发要重新预览
  const stopWait = startAiWait($('extractStatus'), '正在请求（只发本地判不动的片段，等模型答完）');
  try {
    const profile = JSON.parse($('profileText').value || '{}');
    const res = await chrome.runtime.sendMessage({ type: 'nw:extractRun', profile, report: lastImportReport, confirm: true });
    if (!res?.ok) {
      const why = aiErrorText(res);
      $('extractStatus').textContent = why;
      const box = $('extractPreviewText');
      box.hidden = false;
      box.textContent = [why, res.finishReason ? `finish_reason=${res.finishReason}` : ''].filter(Boolean).join('\n');
      return;
    }
    if (!res.accepted?.length) {
      const why = [...new Set((res.rejected || []).map(r => r.reason))].join('、');
      const box = $('extractPreviewText');
      box.hidden = false;
      box.textContent = `AI 回了 ${res.rawChars || 0} 字，但一条都没通过逐字/白名单校验（丢弃 ${(res.rejected || []).length} 条${why ? `：${why}` : ''}）`
        + (res.finishReason ? `\nfinish_reason=${res.finishReason}` : '')
        + `\n它原样回的前 200 字：\n${res.snippet || '（空）'}`;
      $('extractStatus').textContent = '没有逐字命中的结果 —— 下面有原始回显';
      return;
    }
    renderExtractResults(res);
  } finally { stopWait(); }
};

function renderExtractResults(res) {
  const host = $('extractResults');
  host.replaceChildren();
  const intro = document.createElement('p');
  intro.className = 'hint';
  intro.textContent = `AI 给出 ${res.accepted.length} 条逐字摘录${res.rejected?.length ? `，另有 ${res.rejected.length} 条被规则丢弃` : ''}。只有勾选的会写入。`
    + endpointNote(res) + streamNote(res);
  host.appendChild(intro);
  const table = document.createElement('table');
  for (const a of res.accepted) {
    const tr = document.createElement('tr');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = true; cb.dataset.path = a.path; cb.dataset.value = a.value;
    const td1 = document.createElement('td'); td1.appendChild(cb);
    const td2 = document.createElement('td');
    td2.textContent = `${a.path} ← 「${a.value}」`;
    td2.title = `摘自「${a.from || ''}」：${a.sourceText || ''}`;
    const td3 = document.createElement('td');
    td3.className = 'hint';
    // 模型只给了 campus.N.org 这种模板路径时，"第几条"是我们按空槽补的 —— 必须显式说出来
    td3.textContent = (a.indexFilled ? '（条目序号由本地补为空槽，请核对）' : '') + `原文：${String(a.sourceText || '').slice(0, 60)}`;
    tr.append(td1, td2, td3);
    table.appendChild(tr);
  }
  host.appendChild(table);
  const btn = document.createElement('button');
  btn.textContent = '写入勾选项';
  btn.className = 'primary';
  btn.onclick = async () => {
    const picked = [...host.querySelectorAll('input[type=checkbox]:checked')].map(x => ({ path: x.dataset.path, value: x.dataset.value }));
    if (!picked.length) { $('extractStatus').textContent = '没勾任何一条，资料没动'; return; }
    const base = JSON.parse($('profileText').value || '{}');
    const { written, skipped } = applyExtracted(base, picked, {
      overwrite: $('extractOverwrite').checked,
      setValue: (o, path, v) => setValueByPath(o, path, v),
      getValue: (o, path) => getValueByPath(o, path),
    });
    $('profileText').value = JSON.stringify(base, null, 2);
    await chrome.runtime.sendMessage({ type: 'nw:saveProfile', profile: base });
    lastState = { ...(lastState || {}), profile: base };
    host.replaceChildren();
    $('extractStatus').textContent = `写入 ${written.length} 项${skipped.length ? `，跳过 ${skipped.length} 项（已有值、未勾覆盖）` : ''}`;
    await refresh();     // 资料变了，体检区和高频缺口要按新值重算
  };
  host.appendChild(btn);
  $('extractStatus').textContent = '下面是逐字摘录的结果，勾完点「写入勾选项」才会进资料';
}

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
    emptyHints: d.totals?.controls ? undefined : d.emptyHints,
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
    + (fr ? ` · 取自 frame#${fr.chosen}${fr.merged > 1 ? ' 并合并 ' + fr.merged + ' 个框' : ''}（共遍历 ${fr.tried.length} 个框）` : '');
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
    // 分步向导（智联校园等）要先点『填写/继续填写』才渲染表单：直接把页面上的按钮文案念出来，
    // 而不是让人对着"0 个控件"猜扩展坏没坏。
    const gates = (d.emptyHints?.gateButtons || []).filter(Boolean);
    $('probeMeta').innerHTML += '<br><span style="color:var(--warn-fg);background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:4px;padding:2px 6px;display:inline-block">'
      + '这个框里没有表单控件（URL: ' + escapeHtml(picked?.url || d.url || '未知') + '）。'
      + escapeHtml(framesTxt)
      + (sub.length ? '。' + escapeHtml(sub.join('；')) + ' → 表单可能在首方 iframe 里' : '')
      + (gates.length ? '。页面上有像入口的按钮：「' + escapeHtml(gates.slice(0, 5).join('」「')) + '」→ 先点它出现表单，再点一次导出' : '')
      + (d.emptyHints?.loginWall ? '。页面文案疑似登录墙，先确认已登录' : '')
      + (d.emptyHints?.customElementHosts ? `。另有 ${d.emptyHints.customElementHosts} 个自定义元素拿不到 shadow（可能是 closed shadow，探针读不到内部）` : '')
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

// ── 没填上的字段与「选项文案 ↔ 码值」对照表 ──
// 用户实测里最费话的一轮就是"这页 28 个 checkbox 一个都没勾上"：面板只报字段名，
// 而决定能不能填上的是页面上每个选项的可见文字和它自己的提交码。这一份把两者一起摊开。
let unfilledJson = '';
$('btnUnfilled').onclick = async () => {
  const tab = await activeTab();
  tabId = tab?.id;
  $('unfilledMeta').textContent = '正在核对这一页哪些没填上（没扫过会先只读地算一遍，不写任何东西）…';
  const res = await chrome.runtime.sendMessage({ type: 'nw:unfilledMap', tabId, includeFilled: $('unfilledAll').checked });
  if (!res?.ok || !res.data) {
    $('unfilledMeta').textContent = '本页没回应：' + (res?.error || '未知错误') + '（刚重载过扩展请刷新目标页面，再打开侧边栏）';
    return;
  }
  unfilledJson = JSON.stringify(res.data, null, 1);
  $('unfilledOut').value = unfilledJson;
  $('btnUnfilledCopy').disabled = false;
  $('btnUnfilledSave').disabled = false;
  $('unfilledMeta').innerHTML = escapeHtml(describeUnfilledMap(res.data))
    + (res.data.profileFilled === 0 ? '<br><b>资料是空的（0 项有值）</b>：这种情况"没填上"多半与站点无关，先去「分类编辑」把简历灌进来。' : '');
};
$('btnUnfilledCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(unfilledJson); $('unfilledMeta').textContent += ' 已复制。'; }
  catch { $('unfilledOut').select(); document.execCommand('copy'); $('unfilledMeta').textContent += ' 已选中并尝试复制。'; }
};
$('btnUnfilledSave').onclick = () => {
  const leaks = findLeaksInExport(unfilledJson, {});
  if (leaks.length) {
    $('unfilledMeta').textContent = '已拒绝导出：内容里出现像 API Key 的字符串（' + leaks.map(l => l.key).join(', ') + '）';
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([unfilledJson], { type: 'application/json' }));
  a.download = 'unfilled-options-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  $('unfilledMeta').textContent = `已下载 unfilled-options-${new Date().toISOString().slice(0, 10)}.json。`
    + '提醒一句：里面的 currentValue 是页面上已经显示的选中项（可能是你自己点的），要发给别人前自己过一眼。';
};
