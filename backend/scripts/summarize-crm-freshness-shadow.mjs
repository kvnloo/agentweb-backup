#!/usr/bin/env node
// ENG-2263 / ENG-2382: summarise `[crm-freshness-shadow] {json}` (flagged replies) and `[crm-freshness-checked] {json}` (every CRM-relevant
// reply, the denominator) log lines.
//   node backend/scripts/summarize-crm-freshness-shadow.mjs web.stdout.log [more.log ...]
//   cat web.stdout.log | node backend/scripts/summarize-crm-freshness-shadow.mjs
// Pull BOTH markers: aws logs filter-log-events --log-group-name <web.stdout.log group> --start-time <ms> --filter-pattern '"crm-freshness"'
// (a filter of just crm-freshness-shadow leaves out the checked lines and so the flag rate). Flagged counts are LOG LINES, not rates; a
// rate needs the checked lines, and a pull window that straddles the deploy can hold flagged lines with no matching checked lines.
import { readFileSync } from 'node:fs';

const MARK = '[crm-freshness-shadow]';
const CHECKED_MARK = '[crm-freshness-checked]';

export function parseLines(text) {
  const records = [];
  let skipped = 0;
  for (const line of String(text).split('\n')) {
    const at = line.indexOf(MARK);
    if (at === -1) continue;
    const brace = line.indexOf('{', at);
    if (brace === -1) { skipped++; continue; }
    try { records.push(JSON.parse(line.slice(brace))); } catch { skipped++; }
  }
  return { records, skipped };
}

// ENG-2382: one line per CRM-relevant reply, flagged or not: the denominator the flagged lines never had.
export function parseCheckedLines(text) {
  const records = [];
  let skipped = 0;
  for (const line of String(text).split('\n')) {
    const at = line.indexOf(CHECKED_MARK);
    if (at === -1) continue;
    const brace = line.indexOf('{', at);
    if (brace === -1) { skipped++; continue; }
    try { records.push(JSON.parse(line.slice(brace))); } catch { skipped++; }
  }
  return { records, skipped };
}

export function summarizeChecked(records) {
  const byModel = {};
  for (const r of records) {
    const m = (byModel[r.model || 'unknown'] ||= { checked: 0, flagged: 0, abstained: 0, byDensity: { sparse: { checked: 0, flagged: 0 }, mid: { checked: 0, flagged: 0 }, crowded: { checked: 0, flagged: 0 } } });
    m.checked++;
    if (r.flagged) m.flagged++;
    if (r.totalsAbstained) m.abstained++;
    if (typeof r.sessionDensity20 === 'number') {
      const b = m.byDensity[r.sessionDensity20 < 0.2 ? 'sparse' : r.sessionDensity20 < 0.5 ? 'mid' : 'crowded'];
      b.checked++;
      if (r.flagged) b.flagged++;
    }
  }
  return byModel;
}

// Whole percent from 10% up, one decimal below, so a rate like 0.5% is not shown as 1% or 0%.
const pct = (r) => { const p = r * 100; return `${p >= 10 ? Math.round(p) : Math.round(p * 10) / 10}%`; };
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); const n = a.length; return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2; };

export function summarize(records) {
  const byModel = {};
  const sessions = new Set();
  for (const r of records) {
    const model = r.model || 'unknown';
    const m = (byModel[model] ||= { lines: 0, sessions: new Set(), kinds: {}, claimedNumbers: {}, citedTools: {}, drift: 0, echoes: 0, echoLines: 0, echoDensities: [] });
    m.lines++;
    if (r.sessionId) { m.sessions.add(r.sessionId); sessions.add(r.sessionId); }
    for (const k of r.kinds || []) m.kinds[k] = (m.kinds[k] || 0) + 1;
    for (const n of r.claimed || []) m.claimedNumbers[n] = (m.claimedNumbers[n] || 0) + 1;
    for (const t of r.cited || []) m.citedTools[t] = (m.citedTools[t] || 0) + 1;
    m.drift += Number(r.drift) || 0;
    if (Number(r.echoesEarlier) > 0) {
      m.echoes += Number(r.echoesEarlier); m.echoLines++;
      if (typeof r.sessionDensity20 === 'number') m.echoDensities.push(r.sessionDensity20);
    }
  }
  return { totalLines: records.length, distinctSessions: sessions.size, byModel };
}

export function format(summary, skipped = 0, checked = {}) {
  const out = [`flagged replies (log lines): ${summary.totalLines}   distinct sessions: ${summary.distinctSessions}   unparseable marker lines: ${skipped}`];
  // A model with checked replies but no flagged ones (the best behaved) must still show its denominator.
  const EMPTY = () => ({ lines: 0, sessions: new Set(), kinds: {}, claimedNumbers: {}, citedTools: {}, drift: 0, echoes: 0, echoLines: 0, echoDensities: [] });
  const byModel = { ...summary.byModel };
  for (const name of Object.keys(checked)) byModel[name] ||= EMPTY();
  const models = Object.entries(byModel).sort((a, b) => b[1].lines - a[1].lines);
  for (const [model, m] of models) {
    out.push(`\n${model}: ${m.lines} line(s), ${m.sessions.size} session(s)`);
    if (m.lines > 0) out.push(`  kinds: ${JSON.stringify(m.kinds)}`);
    const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} x${v}`).join(', ');
    if (m.lines > 0 && Object.keys(m.claimedNumbers).length) out.push(`  most-claimed unbacked numbers: ${top(m.claimedNumbers)}`);
    if (m.drift) out.push(`  arithmetic drift (claim within 0.5% of a number the tool really returned): ${m.drift}`);
    if (m.echoLines) out.push(`  restated a number an EARLIER turn of the session returned (stale-looking): ${m.echoLines} of ${m.lines} line(s); the rest are unbacked but match no earlier value (or the session predates persisted evidence)`);
    if (m.echoDensities.length) {
      const d = m.echoDensities;
      out.push(`  session number set on those lines: density of 0..20 median ${median(d)} (range ${Math.min(...d)}-${Math.max(...d)}); a crowded set means a match is expected by chance, a sparse one makes a match meaningful`);
    }
    if (Object.keys(m.citedTools).length) out.push(`  tools cited by unbacked tags: ${top(m.citedTools)}`);
    const c = checked[model];
    if (c) {
      out.push(`  CRM replies checked: ${c.checked}, flagged: ${c.flagged} (${pct(c.flagged / c.checked)})${c.abstained ? `, total check abstained on ${c.abstained}` : ''}`);
      const d = c.byDensity;
      if (d.sparse.checked + d.mid.checked + d.crowded.checked > 0) {
        const cell = (label, b) => `${label} ${b.flagged}/${b.checked}${b.checked ? ` (${pct(b.flagged / b.checked)})` : ''}`;
        out.push(`  flag rate by session number-set density: ${cell('sparse (<0.2)', d.sparse)}, ${cell('mid (0.2-0.5)', d.mid)}, ${cell('crowded (>=0.5)', d.crowded)}`);
      }
    }
  }
  if (models.length === 0) out.push('(no [crm-freshness-shadow] lines found)');
  else if (summary.totalLines > 0 && Object.keys(checked).length === 0) {
    out.push(`\n(no [crm-freshness-checked] lines: the flag rate cannot be computed. Pull with --filter-pattern '"crm-freshness"' to include them; lines only exist from the deploy that added them.)`);
  }
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  const text = files.length ? files.map((f) => readFileSync(f, 'utf8')).join('\n') : readFileSync(0, 'utf8');
  const { records, skipped } = parseLines(text);
  console.log(format(summarize(records), skipped, summarizeChecked(parseCheckedLines(text).records)));
}
