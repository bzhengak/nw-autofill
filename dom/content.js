// 内容脚本入口：在页面上下文里完成 扫描 → 匹配 → 写入 → 回读 → 三态标注。
// 用 dynamic import 加载 ESM 模块，保持"源码即扩展、无构建步骤"。

let mods = null;

async function loadModules() {
  if (mods) return mods;
  const u = p => chrome.runtime.getURL(p);
  const [scanner, filler, safety, matcher, schema, matching, probe, ai, optionMap, build, ledger, canonical, mappingTable, planCheck, rowAdder] = await Promise.all([
    import(u('dom/scanner.js')),
    import(u('dom/filler.js')),
    import(u('dom/safety.js')),
    import(u('core/matcher.js')),
    import(u('core/profile-schema.js')),
    import(u('core/matching.js')),
    import(u('dom/probe.js')),
    import(u('core/ai.js')),
    import(u('core/option-map.js')),
    import(u('core/build.js')),
    import(u('core/ledger.js')),
    import(u('core/canonical.js')),
    import(u('core/mapping-table.js')),
    import(u('core/plan-check.js')),
    import(u('dom/row-adder.js')),
  ]);
  mods = { scanner, filler, safety, matcher, schema, matching, probe, ai, optionMap, build, ledger, canonical, mappingTable, planCheck, rowAdder };
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

async function handleScan({ profile, mode = 'full', dryRun = false, adapter = null, fillSensitive = false, allowCustomSelect = false, aiCandidates = null, enMissingMode = 'strict', allowNonApplication = false, siteRules = null, temporaryFps = [], siteRulesStored = null, aiPageMapSuggestions = null,
  allowAddRows = false }) {
  const { scanner, filler, matcher, safety, schema, ledger, canonical, mappingTable, planCheck, rowAdder } = await loadModules();
  safety.armSubmitGuard(window, auditLog);
  const fields = scanner.scanForm(document);
  /**
   * 整页目的闸（独立审查 2026-10-02 的 Critical 5）：先判"这是不是一份网申表格"，
   * 再谈每一栏。单栏的闸（证据 / 形状 / 归属）都看不见整页级别的错误 ——
   * 登录页的 username + password + remember 会被逐栏当成"姓名 / 自我介绍 / 勾选项"，
   * 一次自动填写在登录页上改三个框，回读还全绿。
   * 判成非网申就一个字段都不动；用户明确"我确认这是网申表"才放行（自建门户措辞千奇百怪，
   * 误拦一整页比误填一栏更没法干活 —— 但放行必须是他按的钮）。
   */
  const purpose = canonical.classifyPagePurpose(fields, {
    hasPasswordField: Boolean(document.querySelector('input[type="password"]')),
    docTitle: String(document.title || ''),
  });
  const NON_APPLICATION = new Set(['login', 'register', 'newsletter', 'search', 'captcha']);
  if (NON_APPLICATION.has(purpose.purpose) && !allowNonApplication) {
    auditLog.push({ at: new Date().toISOString(), event: 'page_purpose_blocked', purpose: purpose.purpose, evidence: purpose.evidence });
    return {
      stats: { scanned: fields.length, planned: 0, auto: 0, review: 0, gaps: 0, profileFilled: schema.countFilled(profile || {}) },
      results: [], gaps: [], aiFields: [], auditLog,
      mapping: { rows: [], stats: { fields: fields.length, decided: 0 } },
      planCheck: { warnings: [], ok: false },
      pageOrigin: location.origin,
      pagePurpose: purpose, purposeBlocked: true,
    };
  }
  auditLog.push({ at: new Date().toISOString(), event: 'page_purpose', purpose: purpose.purpose, confidence: purpose.confidence });
  /**
   * S1：先取回"我们在这个站点写过什么"的账本，再排计划。
   * 没有它，上一轮我们写错的那一栏会被当成"已填好"永远留着
   * （用户 2026-10-02："AI 填写不能修改已填过的错误的"）。
   * 取不到账本就当值是别人填的 —— 保守方向永远是不覆盖。
   */
  let fillLedger = {};
  if (/^https?:$/.test(location.protocol)) {
    fillLedger = (await chrome.runtime.sendMessage({ type: 'nw:ledgerGet' }).catch(() => null))?.ledger || {};
  }
  const plan = matcher.planFill(fields, profile, { mode, adapter, fillSensitive, allowCustomSelect, enMissingMode, ledger: fillLedger, pageOrigin: location.origin, siteRules: siteRules || null });
  /**
   * S7 补行：段数不够时替用户点页面自己的「+ 添加一段」。三条限制一道不能少：
   *  · 只在**真的要写**的那一跳做（预演一个点击都不发）；
   *  · 要在设置里显式勾「允许补经历行」（allowAddRows）；
   *  · 每节最多 ROW_CAP 次，且每次点击都必须让这一节里扫得到的栏位变多，
   *    没变多立刻停 —— 连点一个没有反馈的按钮是在页面上制造未知状态。
   * 补完行必须重扫重排：新出现的栏位要进同一张映射表，不能拿旧计划往新行上写。
   */
  let rowExpansion = [];
  const addRowSections = rowAdder.sectionsWithAddButton(fields);
  if (allowAddRows && !dryRun && mode !== 'preview') {
    const schemaFieldsForCheck = schema.buildFields();
    const pre = planCheck.checkPlan({ fields, plan, profile, schemaFields: schemaFieldsForCheck, addRowSections });
    for (const want of rowAdder.planRowExpansion(pre.warnings)) {
      const group = fields.filter(f => (f.sectionHint || '') === want.section);
      const container = rowAdder.blockContainerFor(group.length ? group : fields);
      if (!container) { rowExpansion.push({ section: want.section, added: 0, stalled: true, why: 'no_container' }); continue; }
      const res = await rowAdder.expandRows({
        container,
        willTry: want.willTry,
        click: rowAdder.defaultClick,
        count: () => rowAdder.fieldsIn(container, scanner.scanForm(document)).length,
      });
      rowExpansion.push({ section: want.section, needed: want.need, ...res, log: undefined });
      auditLog.push({ at: new Date().toISOString(), event: 'row_expansion', section: want.section, added: res.added, stalled: res.stalled, why: res.why });
    }
    if (rowExpansion.some(r => r.added > 0)) {
      const fresh = scanner.scanForm(document);
      fields.length = 0;
      fields.push(...fresh);
      const re = matcher.planFill(fields, profile, { mode, adapter, fillSensitive, allowCustomSelect, enMissingMode, ledger: fillLedger, pageOrigin: location.origin, siteRules: siteRules || null });
      plan.assignments = re.assignments;
      plan.gaps = re.gaps;
      plan.stats = re.stats;
      auditLog.push({ at: new Date().toISOString(), event: 'rescan_after_expand', fields: fields.length });
    }
  }
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
  /**
   * 整页概念映射（S5 的回答 → S6 的表）：比缺口那条路宽，能覆盖"我们自己判得没把握"的黄字栏，
   * 但用户改判、适配器钉位、绿字一律不动（判据在 core/ai.js 里，那里离线可测）。
   * 顺序有讲究：先本地判定 → 缺口 AI → 整页映射，越靠后越接近"人来定"。
   */
  let aiPageMap = null;
  if (aiPageMapSuggestions?.length) {
    aiPageMap = mods.ai.applyPageMapSuggestions(plan, profile, aiPageMapSuggestions, { fillSensitive, fields });
    plan.assignments = aiPageMap.assignments;
    plan.gaps = aiPageMap.gaps;
    plan.stats = aiPageMap.stats;
    aiApplied = aiPageMap.applied;
    auditLog.push({ at: new Date().toISOString(), event: 'ai_page_map_applied', filledGaps: aiPageMap.filledGaps, overridden: aiPageMap.overridden, refused: aiPageMap.refused.length });
  }
  const applied = await filler.applyPlan(fields, plan.assignments, { dryRun, allowCustomSelect, adapter, pageOrigin: location.origin, ledger: fillLedger });

  /**
   * S1：写完记账。只记"哪一栏（指纹）+ 写的是哪个槽位 + 值哈希 + 构建号"，
   * 明文取值不进账本；账本也不进 settings（settings 会被导出 JSON 带走）。
   * dryRun 一律不记 —— 预演没碰页面，记了就会让下一轮误以为"这值是我们写的"。
   */
  if (!dryRun && /^https?:$/.test(location.protocol)) {
    const bld = (await loadModules()).build.BUILD;
    const written = applied.results
      .filter(r => (r.status === 'green' || r.status === 'yellow') && r.path)
      .map(r => ({
        fp: ledger.fingerprint(fields[r.index] || {}),
        path: r.path,
        valueHash: ledger.hashValue(r.actual ?? r.value ?? ''),
        build: bld,
      }));
    if (written.length) {
      const res = await chrome.runtime.sendMessage({ type: 'nw:ledgerSave', entries: written }).catch(() => null);
      if (res?.ledger) fillLedger = res.ledger;
    }
  }

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
      // 选项带"文案=码值"：这是页面自己的内容（不是用户资料），
      // 而"这一栏到底要哪个码"常常只有选项能说明白（用户 2026-10-02：栏位信息要全面）
      options: (f.options || []).map(o => {
        const t = String(o?.text ?? o ?? '').slice(0, 40);
        const v = String(o?.value ?? '').slice(0, 24);
        return v && v !== t ? t + '=' + v : t;
      }).filter(Boolean).slice(0, 24),
      desc: String(f.description || '').slice(0, 160),
      section: String(f.sectionTitle || f.sectionHint || '').slice(0, 40),
      name: String(f.name || '').slice(0, 40),
      id: String(f.id || '').slice(0, 40),
      nearby: (f.nearbyLabels || []).slice(0, 3),
      required: Boolean(f.required),
    });
  }
  // "计划填 0"有两种完全不同的原因：没资料 vs 页面确实填不了。
  // 不区分就会让人去调词典，而真正的问题是 profile 是空的（Klook 实测踩过）。
  const profileFilled = schema.countFilled(profile);
  /**
   * S6 映射表 + 计划校验：这一页每一栏「我们判给了谁、凭什么、现在是谁写的」，
   * 以及整页算下来有没有对不上的地方（段数、重复占用、必填没安排）。
   * 这两份都建立在**合并 AI 候选之后**的计划上 —— 面板看到的必须就是将要写的那一份。
   */
  const schemaFields = schema.buildFields();
  const mapping = mappingTable.buildMappingTable({
    fields, plan, results: applied.results, ledger: fillLedger,
    origin: location.origin, siteRules: siteRules || {}, temporaryFps,
    storedRules: siteRulesStored || null, schemaFields,
  });
  // 补行之后页面可能又长出新的加号：这里按**当前**这一版栏位重算一次
  const check = planCheck.checkPlan({ fields, plan, profile, schemaFields, table: mapping, addRowSections: rowAdder.sectionsWithAddButton(fields) });
  return {
    stats: { ...applied.summary, ...plan.stats, profileFilled, aiApplied },
    results: applied.results.map(r => ({ path: r.path, label: r.label, score: r.score, status: r.status, reason: r.failReason || '', note: r.note || '', actual: r.actual, sensitive: r.sensitive, aiChosen: r.aiChosen, evidence: r.evidence || [], weakEvidence: Boolean(r.weakEvidence), notOurs: r.notOurs || '', overwrites: r.overwrites || '' })),
    gaps: plan.gaps.map(g => ({ index: g.index, label: g.label, reason: g.reason, kind: g.kind, note: g.note || '' })),
    mapping, planCheck: check,
    // 这一轮我们替用户点了几次加号、补出几行、卡在哪一节（空数组=没动过）
    rowExpansion,
    // 整页概念映射落地后的账：填了几个缺口、覆盖几个黄字、拒了几条（界面逐条念，不静默）
    aiMap: aiPageMap ? { filledGaps: aiPageMap.filledGaps, overridden: aiPageMap.overridden, refused: aiPageMap.refused } : null,
    // 面板拿它当"这张表是在哪家站点上算出来的"凭证：改判落盘时必须带上，
    // 后台用它和标签页**当前** origin 对一遍（独立审查 C1：切了页仍把上一页的改判存进新站点的桶）
    pageOrigin: location.origin,
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
          allowAddRows: settings ? settings.allowAddRows === true : false,
          aiCandidates: msg.aiCandidates || null,
          // 缺英文值时的处理口径来自设置，不在这里改写：面板勾选与真实填写必须是同一个值
          enMissingMode: settings ? settings.enMissingMode : 'strict',
          allowNonApplication: msg.allowNonApplication === true,
          // 改判规则由后台按 tabId 反查 origin 后合流下发（自报的一律不用）
          siteRules: msg.siteRules || null,
          temporaryFps: Array.isArray(msg.temporaryFps) ? msg.temporaryFps : [],
          siteRulesStored: msg.siteRulesStored || null,
          // 整页概念映射的回答（面板问过 nw:aiMapPage 之后带回来）：只在预演里落进计划，
          // 真正写页面仍然要用户点「按此映射填写」
          aiPageMapSuggestions: Array.isArray(msg.aiPageMapSuggestions) ? msg.aiPageMapSuggestions : null,
        }) });
      } else if (msg?.type === 'nw:undo') {
        const last = window.__nwLast;
        const r = await last?.applied?.undo?.();
        /**
         * 撤销成功就要把账本里对应那几笔擦掉 —— 否则页面已经恢复原状，
         * 台账还说着"这值是我们写的"，下一轮会拿它去覆盖用户自己填的东西。
         * 代价要写明白（独立审查 Minor 9）：撤销会把**上一轮那个错值**放回页面，
         * 从此它在归属上算 other，自动通路不再碰它 —— 方向是对的（你撤销就是不认可这次改动），
         * 但"撤销后又想让插件填对"得先经映射表改判（M4），不是再点一次扫描。
         */
        if (r?.ok && last?.fields && /^https?:$/.test(location.protocol)) {
          const { ledger } = await loadModules();
          const fps = (last.applied.results || [])
            .filter(x => (x.status === 'green' || x.status === 'yellow') && x.path)
            .map(x => ledger.fingerprint(last.fields[x.index] || {}));
          await chrome.runtime.sendMessage({ type: 'nw:ledgerForget', fps }).catch(() => {});
        }
        clearMarks();
        sendResponse({ ok: Boolean(r?.ok), restored: r?.restored ?? 0 });
      } else if (msg?.type === 'nw:probe') {
        const { probe } = await loadModules();
        sendResponse({ ok: true, data: probe.probePageStructure(document, location.href, window) });
      } else if (msg?.type === 'nw:unfilledMap') {
        // 「导出没填的字段与选项」：优先复用上一次扫描的现场（window.__nwLast），
        // 没有就先干跑一次（dryRun：只算不写，一个字节都不改页面），
        // 因为用户常常是"看这一页没填上"就直接点导出，此时还没扫过。
        const { scanner, filler, matcher, schema, optionMap, build, ledger } = await loadModules();
        // 导出与面板必须看同一份账本，否则会出现"面板说这栏是我们写的、导出说不是"
        const ledgerNow = (await chrome.runtime.sendMessage({ type: 'nw:ledgerGet' }).catch(() => null))?.ledger || {};
        let last = window.__nwLast;
        if (!last) {
          const { profile, settings } = await chrome.storage.local.get(['profile', 'settings']);
          const fields = scanner.scanForm(document);
          const plan = matcher.planFill(fields, profile || {}, {
            mode: 'full',
            // 后台按 URL 选好的适配器要一起用：不带它，导出会显示成「词典没有这个词」，
            // 而面板上同一栏明明已经命中 —— 两份结果对不上就等于没有诊断价值。
            adapter: msg.adapter || null,
            fillSensitive: Boolean(settings?.fillSensitive),
            allowCustomSelect: Boolean(settings?.allowCustomSelect),
            enMissingMode: settings?.enMissingMode || 'strict',
            ledger: ledgerNow,
            pageOrigin: location.origin,
            // 导出与面板必须看同一份改判：不带规则就会出现"面板上这栏写着『按你的改判』、
            // 导出里却说词典没这个词"（独立审查 Minor）。
            siteRules: msg.siteRules || null,
          });
          const applied = await filler.applyPlan(fields, plan.assignments, { dryRun: true, pageOrigin: location.origin, ledger: ledgerNow });
          last = window.__nwLast = { fields, plan, applied, auditLog };
        }
        sendResponse({
          ok: true,
          data: optionMap.buildUnfilledMap({
            fields: last.fields,
            gaps: last.plan?.gaps || [],
            results: last.applied?.results || [],
            url: location.href,
            build: build.BUILD,
            ledger: ledgerNow,
            profileFilled: schema.countFilled((await chrome.storage.local.get(['profile'])).profile || {}),
          }, { includeFilled: msg.includeFilled === true }),
        });
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
