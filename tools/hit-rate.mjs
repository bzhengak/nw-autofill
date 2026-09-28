// 命中率评测：在 jsdom 里跑真实扫描→匹配→写入→回读，按 tools/expected/*.json 判分。
// 这是 P0 验收门槛的执行工具：npm run hit

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { scanForm } from '../dom/scanner.js';
import { planFill } from '../core/matcher.js';
import { applyPlan } from '../dom/filler.js';
import { sampleProfile } from '../tests/fixtures/sample-profile.js';
import { importMarkdown } from '../core/importers/markdown.js';

/**
 * NW_RESUME_MD=path 时用真实（或脱敏）简历跑一遍。
 * 量的是"我这份资料到底能填多少"，而不是虚构样本能拿到的理想值 —— 两者差距很大，
 * 而且只有前者会决定你敢不敢在真实网申上用它。
 */
function profileForJudging() {
  const file = process.env.NW_RESUME_MD;
  if (!file) return sampleProfile();
  return importMarkdown(fs.readFileSync(file, 'utf8')).profile;
}
import { getValueByPath, equivalentsOf } from '../core/profile-schema.js';
import { normalize, core, boolLike, AMBIGUOUS_SECTIONS } from '../core/matching.js';
import { matchAdapter } from '../core/adapters.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadAdapters() {
  const regPath = path.join(root, 'adapters', 'registry.json');
  if (!fs.existsSync(regPath)) return [];
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  return (reg.files || []).map(f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')));
}
const ADAPTERS = loadAdapters();

function valueEquivalent(a, b) {
  const x = normalize(a), y = normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const eqs = equivalentsOf(b).map(t => normalize(t)).filter(Boolean);
  if (eqs.includes(x) || eqs.includes(core(x)) || core(x) === core(y)) return true;
  // 日期只比数字集合：2001-03-15 与 03/15/2001 是同一个值
  const ga = x.match(/\d+/g), gb = y.match(/\d+/g);
  if (ga && gb && ga.slice().sort().join('') === gb.slice().sort().join('')) return true;
  // 站点只要年月时，'06/2026' 对上 '2026-06-30' 属于正确的精度降级，不算填错
  const ymd = s => { const m = String(s).match(/(20\d{2})\D*(\d{1,2})?(?:\D*(\d{1,2}))?/); return m ? { y: m[1], mo: m[2] ? m[2].padStart(2, '0') : '', d: m[3] ? m[3].padStart(2, '0') : '' } : null; };
  const ya = ymd(x), yb = ymd(y);
  if (ya && yb && ya.y === yb.y && (!ya.mo || !yb.mo || ya.mo === yb.mo) && (!ya.d || !yb.d || ya.d === yb.d)) return true;
  const da = x.replace(/[^\d]/g, ''), db = y.replace(/[^\d]/g, '');
  if (da && db && /^\d+$/.test(da) && /^\d+$/.test(db) && (da.startsWith(db) || db.startsWith(da))) return true;
  return eqs.some(e => e.length > 2 && (x.includes(e) || e.includes(x)));
}

const forms = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(path.join(root, 'test-forms')).filter(f => f.endsWith('.html'));

let grandCorrect = 0, grandTotal = 0, grandViolations = 0;

for (const file of forms) {
  const html = fs.readFileSync(path.join(root, 'test-forms', file), 'utf8');
  const expectedPath = path.join(root, 'tools', 'expected', file.replace(/\.html$/, '.json'));
  if (!fs.existsSync(expectedPath)) { console.log(`跳过 ${file}（无判分标准）`); continue; }
  const { expect, mustNotTouch = [], pageUrl = '' } = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const adapter = pageUrl ? matchAdapter(pageUrl, ADAPTERS) : null;

  const dom = new JSDOM(html, { url: 'https://example.test/apply', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;

  const fields = scanForm(doc);
  const profile = profileForJudging();
  const plan = planFill(fields, profile, { mode: 'full', adapter, fillSensitive: true });
  const { results } = await applyPlan(fields, plan.assignments, {});

  const byName = new Map();
  results.forEach((r) => {
    const f = fields[r.index];
    const key = f?.el?.getAttribute?.('data-nw-test') || f?.el?.getAttribute?.('name') || f?.el?.getAttribute?.('id');
    if (key) byName.set(key, { ...r, kind: f.kind });
  });

  const rows = [];
  let correct = 0;
  for (const [name, wantPath] of Object.entries(expect)) {
    const got = byName.get(name);
    // 期望值可以是数组：页面没有小节标题时，"工作经历/实习经历"的 Responsibilities 无法区分，
    // 只要落到任一合理路径且被标为待复核就算对（不许假装我们能分辨）
    const wantPaths = Array.isArray(wantPath) ? wantPath : [wantPath];
    const truthPath = got && wantPaths.includes(got.path) ? got.path : wantPaths[0];
    const truth = String(getValueByPath(profile, truthPath) || '');
    const el = doc.querySelector(`[data-nw-test="${name}"],[name="${name}"]`);
    const shownForSelect = got?.kind === 'select'
      ? (got.shown || Array.from(el?.selectedOptions || []).map(o => o.textContent).join(''))
      : '';
    const actualText = got?.kind === 'radio' || got?.kind === 'checkbox'
      ? Array.from(doc.querySelectorAll(`[name="${name}"]`)).filter(x => x.checked).map(x => x.value).join('|')
      : (shownForSelect || String(got?.actual ?? (el?.value ?? '')));
    const rightPath = !!got && wantPaths.includes(got.path);
    let rightValue;
    if (got?.kind === 'radio' || got?.kind === 'checkbox') {
      // 判分要看用户看得见的选项文本，不是 value 属性（M/1/0 之类）
      const texts = Array.from(doc.querySelectorAll(`[name="${name}"]`)).filter(x => x.checked)
        .map(x => normalize(x.parentElement?.textContent || x.nextElementSibling?.textContent || x.value));
      const wantBool = boolLike(truth);
      rightValue = texts.some(t => valueEquivalent(t, truth) || (wantBool !== null && boolLike(t) === wantBool));
    } else {
      rightValue = valueEquivalent(actualText, truth);
    }
    // 判分标准写成数组且数组里全是「可重复经历槽位」= 承认"我们分辨不出这是哪一段"。
    // 那这一栏就必须是黄字；若匹配器哪天敢把它当绿字直填，这里不能跟着一起骗自己。
    // 而 ["others.personalSite","others.portfolio"] 这类"两个一次性字段填哪个都算对"不算歧义。
    const slotAmbiguous = wantPaths.length > 1 && wantPaths.every(p => AMBIGUOUS_SECTIONS.has(String(p).split('.')[0]));
    const falseGreen = slotAmbiguous && got && got.tier === 'auto';
    const ok = rightPath && rightValue && !falseGreen;
    if (ok) correct++;
    else rows.push({ name, wantPath, gotPath: got?.path || '(未分配)', gotValue: String(actualText || '').slice(0, 28), want: truth.slice(0, 28), status: (got?.status || 'missing') + (falseGreen ? '/假绿' : '') });
  }

  const violations = [];
  for (const name of mustNotTouch) {
    const el = doc.querySelector(`[data-nw-test="${name}"],[name="${name}"]`);
    if (!el) continue;
    // 判"有没有被写过"必须按控件类型分开看：checkbox 的 el.value 天生就是 "on"，
    // 拿它当"被写入"会把所有 cookie 开关误判成越界（假警报会让整套门槛失去意义）。
    const t = String(el.type || '').toLowerCase();
    let touched = false;
    if (el.tagName === 'FIELDSET' && el.checked === undefined) touched = false;
    else if (el.checked !== undefined && (t === 'checkbox' || t === 'radio')) touched = el.checked === true;
    else if (el.tagName === 'SELECT') touched = el.value !== '' && el.selectedIndex >= 0;
    else if (t === 'button' || t === 'submit' || t === 'image') touched = false;
    else if (t === 'password') touched = String(el.value || '') !== '';
    // 只有真正"可编辑"的元素才用 textContent 判写入：静态 <span> 的占位文案（"Select"）
    // 本来就带文字，按 textContent 判会让每个自定义下拉都变成假越界
    else touched = String(el.value ?? '').trim() !== ''
      || ((el.isContentEditable || el.getAttribute('contenteditable') === 'true')
        && String(el.textContent || '').trim() !== '');
    if (touched) violations.push(`${name} 被写入（应当留给你手动处理）`);
  }
  const submitBlocked = true; // applyPlan 不派发任何 submit/click 到提交按钮，P2 会加断言

  grandCorrect += correct; grandTotal += Object.keys(expect).length; grandViolations += violations.length;
  const pct = (correct / Object.keys(expect).length * 100).toFixed(1);
  console.log(`\n=== ${file} ===`);
  console.log(`扫描 ${plan.stats.scanned} 个控件 · 计划 ${plan.stats.planned} · 绿 ${plan.stats.auto ?? results.filter(r => r.status === 'green').length} · 黄 ${plan.stats.review ?? 0} · 红 ${results.filter(r => r.status === 'red').length} · 缺口 ${plan.stats.gaps}`);
  console.log(`命中率 ${correct}/${Object.keys(expect).length} = ${pct}%`);
  if (Object.keys(plan.stats.gapReasons || {}).length) console.log('缺口归因：', JSON.stringify(plan.stats.gapReasons));
  if (violations.length) console.log('⚠ 越界：', violations.join('; '));
  if (rows.length) {
    console.log('未命中明细：');
    for (const r of rows) console.log(`  - ${String(r.name).padEnd(12)} 期望 ${String(r.wantPath).padEnd(26)} 实得 ${String(r.gotPath || '-').padEnd(26)} [${r.status}] 值 "${String(r.gotValue).slice(0,22)}" vs "${String(r.want).slice(0,22)}"`);
  }
}

console.log(`\n总计 ${grandCorrect}/${grandTotal} = ${(grandCorrect / grandTotal * 100).toFixed(1)}%，越界 ${grandViolations} 处`);
process.exit(grandCorrect / grandTotal >= 0.85 && grandViolations === 0 ? 0 : 1);
