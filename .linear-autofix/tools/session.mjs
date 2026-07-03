#!/usr/bin/env node
// .linear-autofix/tools/session.mjs
// READ-ONLY helper: pull a production chat session (or any AW-* item) and print a curated summary
// so the fixer can confirm a bug's root cause against real data instead of guessing.
// Access comes from the EC2 instance role (agentweb-test-env-ec2-role) — read-only on prod AW-*.
//
// Usage:
//   node session.mjs <sessionId>                 # curated summary of AW-ChatSessions
//   node session.mjs <sessionId> --raw           # full unmarshalled JSON
//   node session.mjs <id> --table AW-TaskExecutions --key executionId   # any AW-* table
//
// NEVER paste raw output (customer PII) into commits, the PR, tests, or Linear comments.

import { spawnSync } from 'node:child_process';

// DynamoDB attribute-value -> plain JS.
function un(v) {
  if (v == null) return v;
  if (v.S !== undefined) return v.S;
  if (v.N !== undefined) return Number(v.N);
  if (v.BOOL !== undefined) return v.BOOL;
  if (v.NULL !== undefined) return null;
  if (v.L !== undefined) return v.L.map(un);
  if (v.M !== undefined) { const o = {}; for (const k in v.M) o[k] = un(v.M[k]); return o; }
  if (v.SS !== undefined) return v.SS;
  if (v.NS !== undefined) return v.NS.map(Number);
  return v;
}

export function fetchItem(id, { table = 'AW-ChatSessions', keyName = 'sessionId' } = {}) {
  const key = JSON.stringify({ [keyName]: { S: id } });
  const r = spawnSync('aws', ['dynamodb', 'get-item', '--table-name', table, '--key', key, '--output', 'json'], { encoding: 'utf8' });
  if (r.status !== 0) return { error: (r.stderr || 'aws get-item failed').trim() };
  let parsed;
  try { parsed = JSON.parse(r.stdout || '{}'); } catch { return { error: 'unparseable aws output' }; }
  if (!parsed.Item) return { error: `no item for ${keyName}=${id} in ${table}` };
  const out = {};
  for (const k in parsed.Item) out[k] = un(parsed.Item[k]);
  return { item: out };
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + ` …[+${s.length - n} chars]` : s || '');

// Compact, PII-light summary of a chat session focused on what a bug investigation needs.
export function summarizeSession(item) {
  if (!item) return '(no session)';
  const L = [];
  L.push(`sessionType=${item.sessionType || '?'} portalType=${item.portalType || '?'} llmModel=${item.llmModel || '?'} messageCount=${item.messageCount ?? '?'}`);
  if (item.createdAt || item.updatedAt) L.push(`created=${item.createdAt || '?'} updated=${item.updatedAt || '?'}`);
  if (item.title) L.push(`title: ${clip(String(item.title), 120)}`);
  if (item.failedFunctions && Object.keys(item.failedFunctions).length) L.push(`failedFunctions: ${JSON.stringify(item.failedFunctions)}`);
  if (item.calledFunctions && Object.keys(item.calledFunctions).length) L.push(`calledFunctions: ${JSON.stringify(item.calledFunctions)}`);
  const msgs = item.messages;
  L.push(Array.isArray(msgs) && msgs.length
    ? `messages: ${msgs.length} present`
    : 'messages: OFFLOADED/empty in DynamoDB (raw tool-call args not retained here)');
  // workPlan step notes often carry the agent's own diagnosis of what failed.
  const steps = item.workPlan && Array.isArray(item.workPlan.steps) ? item.workPlan.steps : [];
  if (steps.length) {
    L.push(`workPlan: ${steps.length} steps; notes:`);
    steps.forEach((s, i) => { if (s && s.notes) L.push(`  [${i}] ${clip(String(s.notes), 300)}`); });
  }
  if (item.sessionSummary) {
    const ss = typeof item.sessionSummary === 'string' ? item.sessionSummary : JSON.stringify(item.sessionSummary);
    L.push(`sessionSummary: ${clip(ss, 400)}`);
  }
  return L.join('\n');
}

// Extract the first session-id-like UUID that follows a "session" mention in free text.
export function findSessionId(text) {
  if (!text) return null;
  const m = /session[^\n]{0,30}?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(text);
  return m ? m[1] : null;
}

function main() {
  const args = process.argv.slice(2);
  const id = args.find((a) => !a.startsWith('--'));
  const raw = args.includes('--raw');
  const table = (args[args.indexOf('--table') + 1] && args.includes('--table')) ? args[args.indexOf('--table') + 1] : 'AW-ChatSessions';
  const keyName = (args.includes('--key')) ? args[args.indexOf('--key') + 1] : 'sessionId';
  if (!id) { console.error('Usage: node session.mjs <id> [--raw] [--table AW-*] [--key <attr>]'); process.exit(2); }
  const { item, error } = fetchItem(id, { table, keyName });
  if (error) { console.error(error); process.exit(1); }
  console.log(raw ? JSON.stringify(item, null, 2) : summarizeSession(item));
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
