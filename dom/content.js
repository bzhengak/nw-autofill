// 内容脚本入口：在页面上下文里完成 扫描 → 匹配 → 写入 → 回读 → 三态标注。
// 用 dynamic import 加载 ESM 模块，保持"源码即扩展、无构建步骤"。

let mods = null;

async function loadModules() {
  if (mods) return mods;
  const u = p => chrome.runtime.getURL(p);
  const [scanner, filler, safety, matcher, schema, matching, probe] = await Promise.all([
    import(u('dom/scanner.js')),
    import(u('dom/filler.js')),
    import(u('dom/safety.js')),
    import(u('core/matcher.js')),
    import(u('core/profile-schema.js')),
    import(u('core/matching.js')),
    import(u('dom/probe.js')),
  ]);
  mods = { scanner, filler, safety, matcher, schema, matching, probe };
  return mods;
}

const auditLog = [];
const activeMarks = [];

function mark(el, status, note = '') {
  const color = status === 'green' ? '#22a06b' : status === 'yellow' ? '#e8a33d' : status === 'red' ? '#d64545' : '#8a8f98';
  const target = el.closest?.('[class*="form-item"],[class*="field"],[class*="row"],[class*="item"],p,li,td,div') || el;
  target.style.outline = `2px solid ${color}`;
  target.style.outlineOffset = '1px';
  target.dataset.nwStatus = status;
  if (note) target.dataset.nwNote = note;
  activeMarks.push(target);
}

function clearMarks() {
  for (const el of activeMarks.splice(0)) {
    el.style.outline = '';
    delete el.dataset.nwStatus;
    delete el.dataset.nwNote;
  }
}

async function handleScan({ profile, mode = 'full', dryRun = false, adapter = null, fillSensitive = false }) {
  const { scanner, filler, matcher, safety } = await loadModules();
  safety.armSubmitGuard(window, auditLog);
  const fields = scanner.scanForm(document);
  const plan = matcher.planFill(fields, profile, { mode, adapter, fillSensitive });
  const applied = await filler.applyPlan(fields, plan.assignments, { dryRun });

  clearMarks();
  for (const r of applied.results) {
    const field = fields[r.index];
    if (!field?.el) continue;
    if (r.status === 'green' || r.status === 'yellow' || r.status === 'red' || r.status === 'manual') {
      mark(field.el, r.status === 'manual' ? 'orange' : r.status, r.note || r.failReason || '');
    }
  }
  for (const g of plan.gaps) {
    const field = fields[g.index];
    if (field?.el) mark(field.el, 'orange', g.reason);
  }

  window.__nwLast = { fields, plan, applied, auditLog };
  return {
    stats: { ...applied.summary, ...plan.stats },
    results: applied.results.map(r => ({ path: r.path, label: r.label, score: r.score, status: r.status, reason: r.failReason || '', note: r.note || '', actual: r.actual, sensitive: r.sensitive })),
    gaps: plan.gaps.map(g => ({ label: g.label, reason: g.reason, kind: g.kind })),
    auditLog,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'nw:scan') {
        const { profile, settings } = await chrome.storage.local.get(['profile', 'settings']);
        sendResponse({ ok: true, data: await handleScan({
          profile: profile || {}, mode: msg.mode, dryRun: msg.dryRun,
          adapter: msg.adapter || null, fillSensitive: settings ? settings.fillSensitive === true : false,
        }) });
      } else if (msg?.type === 'nw:undo') {
        const r = window.__nwLast?.applied?.undo?.();
        clearMarks();
        sendResponse({ ok: Boolean(r) });
      } else if (msg?.type === 'nw:probe') {
        const { probe } = await loadModules();
        sendResponse({ ok: true, data: probe.probePageStructure(document, location.href, window) });
      } else if (msg?.type === 'nw:ping') {
        await loadModules();
        sendResponse({ ok: true, armed: Boolean(window.__nwSubmitGuardArmed) });
      } else if (msg?.type === 'nw:clearMarks') {
        clearMarks();
        sendResponse({ ok: true });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true; // 异步 sendResponse
});
