import { createEmptyProfile, SECTIONS, buildFields, setValueByPath } from '../core/profile-schema.js';
import { importMarkdown } from '../core/importers/markdown.js';
import { auditProfile, editorModel, advice } from '../core/coverage.js';

const $ = id => document.getElementById(id);
let tabId = null;
let lastState = null;
let HIGH = null;

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
    h.textContent = `${sec.zh}　<span class="note">${sec.en || ''}</span>`;
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

$('btnForm').onclick = () => {
  const open = $('formEditor').style.display !== 'none';
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

function countFilled(profile) {
  let n = 0;
  for (const f of buildFields()) {
    let cur = profile;
    for (const seg of f.path.split('.')) { cur = cur?.[seg]; if (cur == null) break; }
    if (typeof cur === 'string' && cur.trim()) n++;
  }
  return n;
}

function render(data) {
  const s = data?.stats || {};
  $('stats').innerHTML = [
    ['扫描到', s.scanned || 0], ['计划填', s.planned || 0], ['绿·自动', s.green || s.auto || 0],
    ['黄·待复核', s.yellow || s.review || 0], ['红·失败', s.red || 0], ['待你处理', s.gaps || 0],
  ].map(([k, v]) => `<span><b>${k}</b> ${v}</span>`).join('');

  $('results').innerHTML = (data?.results || [])
    .filter(r => !['skipped', 'planned'].includes(r.status) || r.status === 'planned')
    .map(r => `<tr><td><span class="dot ${r.status === 'manual' ? 'orange' : r.status}"></span></td>
      <td>${escapeHtml(r.label || '(无标签)')}</td>
      <td class="note">${escapeHtml(r.path || '')}<br>${r.score != null ? '置信 ' + r.score : ''} ${r.note ? '· ' + escapeHtml(r.note) : ''} ${r.failReason ? '· ' + escapeHtml(r.failReason) : ''}</td>
      <td>${escapeHtml(String(r.actual ?? '')).slice(0, 40)}</td></tr>`).join('');

  $('gaps').innerHTML = (data?.gaps || []).map(g =>
    `<tr><td><span class="dot orange"></span></td><td>${escapeHtml(g.label)}</td><td class="note">${escapeHtml(g.reason)}</td></tr>`).join('')
    || '<tr><td class="note">无</td></tr>';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function run(mode) {
  const tab = await activeTab();
  tabId = tab?.id;
  const res = await chrome.runtime.sendMessage({ type: 'nw:scan', tabId, mode, dryRun: mode === 'preview' });
  if (!res?.ok) {
    $('stats').innerHTML = `<span class="banner">页面未响应：${escapeHtml(res?.error || '未知错误')}。若是刚装扩展，请刷新目标页面后重试。</span>`;
    return;
  }
  render(res.data);
}

$('btnScan').onclick = () => run('full');
$('btnPreview').onclick = () => run('preview');
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

$('btnImportMd').onclick = () => {
  const md = $('mdText').value;
  if (!md.trim()) { $('mdReport').textContent = '先粘贴简历 Markdown 全文'; return; }
  let base;
  try { base = JSON.parse($('profileText').value); } catch { base = createEmptyProfile(); }
  const { profile, report } = importMarkdown(md, { base, overwrite: $('mdOverwrite').checked });
  $('profileText').value = JSON.stringify(profile, null, 2);
  $('editor').classList.add('on');
  $('mdReport').innerHTML = '<b>写入 ' + report.mapped.length + ' 项</b> · 跳过已有 '
    + report.skippedExisting.length + ' 项 · 未识别标题 ' + report.unmappedHeadings.length + ' 个';
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
    at: d.at, url: d.url, title: d.title, framework: d.framework,
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
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([probeJson], { type: 'application/json' }));
  a.download = 'page-structure-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
};
