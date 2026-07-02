#!/usr/bin/env node
// .linear-autofix/poll.mjs — one poll cycle:
//   1. find new bugs and fix up to `config.maxConcurrent` of them in parallel (urgent first)
//   2. recover issues stranded In Progress by a crashed run (one retry, then flag for a human)
//   3. apply any pending human "revise: ..." comments to already-fixed bugs

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.mjs';
import { listNewBugs, listStaleInProgress, resolveIssue, addComment, findStateId, moveIssue } from './linear.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const statePath = path.join(__dirname, 'state.json');
const loadState = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } };
const saveState = (s) => writeFileSync(statePath, JSON.stringify(s, null, 2));
const log = (...a) => console.log('[poll]', ...a);

function runNode(script, args) {
  return new Promise((resolve) => {
    const c = spawn('node', [script, ...args], { stdio: 'inherit', env: process.env });
    c.on('close', resolve);
  });
}

async function processNewBugs() {
  const bugs = await listNewBugs();
  // Linear priority: 1=urgent .. 4=low, 0=none — urgent first, unprioritized last.
  const rank = (p) => (p > 0 ? p : 9);
  bugs.sort((a, b) => rank(a.priority) - rank(b.priority));
  log(`${new Date().toISOString()} — ${bugs.length} new bug(s)`);
  const queue = [...bugs];
  const width = Math.max(1, config.maxConcurrent || 1);
  await Promise.all(Array.from({ length: Math.min(width, queue.length) }, async () => {
    while (queue.length) {
      const b = queue.shift();
      log(`-> ${b.identifier}: ${b.title}`);
      const code = await runNode(path.join(__dirname, 'autofix.mjs'), [b.identifier]);
      if (code !== 0) console.error(`[poll] ${b.identifier} exited with ${code}`);
    }
  }));
}

// A crashed autofix run leaves its issue In Progress with a 'started' record and no final
// outcome — it would sit there forever (the pickup query only sees backlog/unstarted). Reset it
// ONCE for a retry; if it crashes again, flag it for a human and stop touching it.
// IMPORTANT: issues with NO state.json record were moved to In Progress by a HUMAN — autofix
// never touched them and the sweep must leave them alone.
async function recoverStale() {
  const hours = config.staleInProgressHours;
  if (!hours) return;
  let stale = [];
  try { stale = await listStaleInProgress(hours); }
  catch (e) { console.error('[poll] stale sweep failed:', e.message); return; }
  if (!stale.length) return;
  const state = loadState();
  for (const issue of stale) {
    const entry = state[issue.id];
    if (!entry || entry.outcome !== 'started') continue; // human-owned issue or a finished run
    try {
      if ((entry.recoveries || 0) === 0) {
        log(`${issue.identifier}: autofix started this run but never finished — resetting for one retry`);
        const sid = (await findStateId(issue.team.id, 'Backlog', 'backlog')) || (await findStateId(issue.team.id, 'Todo', 'unstarted'));
        if (sid) await moveIssue(issue.id, sid);
        await addComment(issue.id, '⚠️ **Auto-fix run appears to have crashed** (the issue sat In Progress with no result). Resetting it so the poller retries once.');
        state[issue.id] = { ...entry, outcome: 'recovered', recoveries: 1, at: new Date().toISOString() };
      } else {
        log(`${issue.identifier} crashed again after a recovery — flagging for a human`);
        await addComment(issue.id, '🔴 **Auto-fix crashed twice on this issue — needs a human.** It will not be retried automatically.');
        state[issue.id] = { ...entry, outcome: 'recovery_failed', at: new Date().toISOString() };
      }
    } catch (e) { console.error(`[poll] recovery of ${issue.identifier} failed:`, e.message); }
  }
  saveState(state);
}

// Human feedback loop: a Linear comment starting with the trigger (default "revise:") on a
// fixed bug asks the automation to apply that feedback to the existing branch/PR.
async function scanRevisions() {
  if (config.revise?.enabled === false) return;
  const trigger = (config.revise?.trigger || 'revise:').toLowerCase();
  const state = loadState();
  for (const entry of Object.values(state)) {
    if (!entry.identifier || !String(entry.outcome || '').startsWith('fixed')) continue;
    let issue;
    try { issue = await resolveIssue(entry.identifier); } catch { continue; }
    const done = new Set(entry.revisedComments || []);
    const pending = (issue.comments?.nodes || [])
      .filter((c) => c.id && !done.has(c.id) && (c.body || '').trim().toLowerCase().startsWith(trigger));
    if (!pending.length) continue;
    log(`${entry.identifier}: ${pending.length} revision request(s) — running revise pass`);
    const code = await runNode(path.join(__dirname, 'revise.mjs'), [entry.identifier]);
    if (code !== 0) console.error(`[poll] revise ${entry.identifier} exited with ${code}`);
  }
}

async function main() {
  if (!process.env.LINEAR_API_KEY) { console.error('[poll] LINEAR_API_KEY not set'); process.exit(2); }
  // The poller runs ONLY on the designated runner (the EC2 box sets this in its .env).
  if (process.env.AUTOFIX_RUN_ENABLED !== '1') {
    console.error('[poll] refusing to run: AUTOFIX_RUN_ENABLED != 1 (fixes are EC2-only; set it in .linear-autofix/.env on the designated runner)');
    process.exit(2);
  }
  await processNewBugs();
  await recoverStale();
  await scanRevisions();
}

main().catch((e) => { console.error('[poll] fatal:', e); process.exit(1); });
