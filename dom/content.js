// 内容脚本入口：在页面上下文里完成 扫描 → 匹配 → 写入 → 回读 → 三态标注。
// 用 dynamic import 加载 ESM 模块，保持"源码即扩展、无构建步骤"。

let mods = null;

async function loadModules() {
  if (mods) return mods;
  const u = p => chrome.runtime.getURL(p);
  const [scanner, filler, safety, matcher, schema, matching, probe, ai] = await Promise.all([
    import(u('dom/scanner.js')),
    import(u('dom/filler.js')),
    import(u('dom/safety.js')),
    import(u('core/matcher.js')),
    import(u('core/profile-schema.js')),
    import(u('core/matching.js')),
    import(u('dom/probe.js')),
    import(u('core/ai.js')),
  ]);
  mods = { scanner, filler, safety, matcher, schema, matching, probe, ai };
  return mods;
}

const auditLog = [];
const activeMarks = [];
const markNotes = new Map();

function mark(el, status, note = '') {
  const color = status === 'green' ? '#22a06b' : status === 'yellow' ? '#e8a33d' : status === 'red' ? '#d64545' : '#8a8f98';
  const target = el.closest?.('[class*="form-item"],[class*="field"],[class*="row"],[class*="item"],p,li,td,div') || el;
  target.style.outline = `2px solid ${color}`;
  target.style.outlineOffset = '1px';
  target.dataset.nwStatus = status;
  // 说明文字只留在扩展侧内存里（侧边栏会列出来）。写进 title/自定义属性等于
  // 把"哪些字段被自动填了、为什么"交给页面脚本读，还能被预置成 green 骗用户。
  if (note) markNotes.set(target, note);
  activeMarks.push(target);
}

function clearMarks() {
  for (const el of activeMarks.splice(0)) {
    el.style.outline = '';
    delete el.dataset.nwStatus;
    markNotes.delete(el);
  }
}

/** 主世界闸门拦下的一次程序化提交都要留痕：用户点"扫描并填写"后如果页面试图自己提交，
 *  侧边栏要能看到"拦了几次"，否则"永不代提交"这句承诺又变成无人核对的口号。 */
if (!window.__nwSubmitListener) {
  window.__nwSubmitListener = true;
  const read = () => Number(document.documentElement?.dataset?.nwBlockedSubmits || 0);
  window.addEventListener('nw:submit-blocked', () => {
    auditLog.push({ at: new Date().toISOString(), event: 'submit_blocked', count: read() });
  });
}

async function handleScan({ profile, mode = 'full', dryRun = false, adapter = null, fillSensitive = false, allowCustomSelect = false, aiCandidates = null, enMissingMode = 'strict' }) {
  const { scanner, filler, matcher, safety, schema } = await loadModules();
  safety.armSubmitGuard(window, auditLog);
  const fields = scanner.scanForm(document);
  const plan = matcher.planFill(fields, profile, { mode, adapter, fillSensitive, allowCustomSelect, enMissingMode });
  // AI 候选在这里落地：路径白名单与"空槽/敏感槽"的判断都交给 core/ai.js，
  // 内容脚本只负责把结果并进 plan，再走同一条 applyPlan（写入与回读口径不另开一套）。
  let aiApplied = 0;
  if (aiCandidates?.length) {
    const merged = mods.ai.applyAiCandidates(plan, profile, aiCandidates, { fillSensitive });
    plan.assignments = merged.assignments;
    plan.gaps = merged.gaps;
    plan.stats = merged.stats;
    aiApplied = merged.applied;
  }
  const applied = await filler.applyPlan(fields, plan.assignments, { dryRun, allowCustomSelect });

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
  // AI 兜底要问的那几个缺口，字段描述在这里现取：
  // 只给页面自己的文字（标签/类型/选项文本/邻近标签），**刻意不给 currentValue** ——
  // 站点预填的内容里可能就有用户姓名手机，那才是真正会漏出去的东西。
  const aiFields = [];
  const eligible = new Set(mods.ai.aiEligibleGaps(plan.gaps).map(g => g.index));
  for (const g of plan.gaps) {
    if (!eligible.has(g.index)) continue;
    const f = fields[g.index] || {};
    aiFields.push({
      index: g.index,
      label: String(f.labelRaw || f.label || g.label || '').slice(0, 160),
      kind: f.kind || g.kind || 'text',
      options: (f.options || []).map(o => String(o.text ?? o).slice(0, 40)).filter(Boolean).slice(0, 24),
      nearby: (f.nearbyLabels || []).slice(0, 3),
      required: Boolean(f.required),
    });
  }
  // "计划填 0"有两种完全不同的原因：没资料 vs 页面确实填不了。
  // 不区分就会让人去调词典，而真正的问题是 profile 是空的（Klook 实测踩过）。
  const profileFilled = schema.countFilled(profile);
  return {
    stats: { ...applied.summary, ...plan.stats, profileFilled, aiApplied },
    results: applied.results.map(r => ({ path: r.path, label: r.label, score: r.score, status: r.status, reason: r.failReason || '', note: r.note || '', actual: r.actual, sensitive: r.sensitive, aiChosen: r.aiChosen })),
    gaps: plan.gaps.map(g => ({ index: g.index, label: g.label, reason: g.reason, kind: g.kind, note: g.note || '' })),
    aiFields,
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
          allowCustomSelect: settings ? settings.allowCustomSelect === true : false,
          aiCandidates: msg.aiCandidates || null,
          // 缺英文值时的处理口径来自设置，不在这里改写：面板勾选与真实填写必须是同一个值
          enMissingMode: settings ? settings.enMissingMode : 'strict',
        }) });
      } else if (msg?.type === 'nw:undo') {
        const r = await window.__nwLast?.applied?.undo?.();
        clearMarks();
        sendResponse({ ok: Boolean(r?.ok), restored: r?.restored ?? 0 });
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
