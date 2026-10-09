#!/usr/bin/env node
// ENG-2263: summarise `[crm-freshness-shadow] {json}` log lines.
//   node backend/scripts/summarize-crm-freshness-shadow.mjs web.stdout.log [more.log ...]
//   cat web.stdout.log | node backend/scripts/summarize-crm-freshness-shadow.mjs
// Counts are LOG LINES (one per flagged reply), not rates: the denominator (replies per model) comes from request logs.
import { readFileSync } from 'node:fs';

const MARK = '[crm-freshness-shadow]';

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

export function summarize(records) {
  const byModel = {};
  const sessions = new Set();
  for (const r of records) {
    const model = r.model || 'unknown';
    const m = (byModel[model] ||= { lines: 0, sessions: new Set(), kinds: {}, claimedNumbers: {}, citedTools: {}, drift: 0, echoes: 0, echoLines: 0 });
    m.lines++;
    if (r.sessionId) { m.sessions.add(r.sessionId); sessions.add(r.sessionId); }
    for (const k of r.kinds || []) m.kinds[k] = (m.kinds[k] || 0) + 1;
    for (const n of r.claimed || []) m.claimedNumbers[n] = (m.claimedNumbers[n] || 0) + 1;
    for (const t of r.cited || []) m.citedTools[t] = (m.citedTools[t] || 0) + 1;
    m.drift += Number(r.drift) || 0;
    if (Number(r.echoesEarlier) > 0) { m.echoes += Number(r.echoesEarlier); m.echoLines++; }
  }
  return { totalLines: records.length, distinctSessions: sessions.size, byModel };
}

export function format(summary, skipped = 0) {
  const out = [`flagged replies (log lines): ${summary.totalLines}   distinct sessions: ${summary.distinctSessions}   unparseable marker lines: ${skipped}`];
  const models = Object.entries(summary.byModel).sort((a, b) => b[1].lines - a[1].lines);
  for (const [model, m] of models) {
    out.push(`\n${model}: ${m.lines} line(s), ${m.sessions.size} session(s)`);
    out.push(`  kinds: ${JSON.stringify(m.kinds)}`);
    const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} x${v}`).join(', ');
    if (Object.keys(m.claimedNumbers).length) out.push(`  most-claimed unbacked numbers: ${top(m.claimedNumbers)}`);
    if (m.drift) out.push(`  arithmetic drift (claim within 0.5% of a number the tool really returned): ${m.drift}`);
    if (m.echoLines) out.push(`  restated a number an EARLIER turn of the session returned (stale-looking): ${m.echoLines} of ${m.lines} line(s); the rest are unbacked but match no earlier value (or the session predates persisted evidence)`);
    if (Object.keys(m.citedTools).length) out.push(`  tools cited by unbacked tags: ${top(m.citedTools)}`);
  }
  if (models.length === 0) out.push('(no [crm-freshness-shadow] lines found)');
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  const text = files.length ? files.map((f) => readFileSync(f, 'utf8')).join('\n') : readFileSync(0, 'utf8');
  const { records, skipped } = parseLines(text);
  console.log(format(summarize(records), skipped));
}
