#!/usr/bin/env node
// .linear-autofix/poll.mjs — one poll cycle:
//   1. force-fix any issue tagged `forceLabel` ("autofix") right away (bypasses the cap), then pick
//      new bugs one-by-one up to the `maxOpenBugs` WIP cap (urgent first)
//   2. recover issues stranded In Progress by a crashed run (one retry, then flag for a human)
//   3. apply any pending human "revise: ..." comments to already-fixed bugs

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.mjs';
import { listNewBugs, listForcedBugs, listStaleInProgress, resolveIssue, addComment, findStateId, moveIssue } from './linear.mjs';
import { assigneeRefreshPatch } from './git-identity.mjs';

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

// Linear priority: 1=urgent .. 4=low, 0=none — urgent first, unprioritized last.
const byPriority = (a, b) => { const rank = (p) => (p > 0 ? p : 9); return rank(a.priority) - rank(b.priority); };

// Run a set of bugs through autofix.mjs, up to `width` concurrently (default: config.maxConcurrent).
async function runBugs(queue, width = Math.max(1, config.maxConcurrent || 1)) {
  const lanes = Math.max(1, Math.min(width, queue.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (queue.length) {
      const b = queue.shift();
      log(`-> ${b.identifier}: ${b.title}`);
      const code = await runNode(path.join(__dirname, 'autofix.mjs'), [b.identifier]);
      if (code !== 0) console.error(`[poll] ${b.identifier} exited with ${code}`);
    }
  }));
}

async function processNewBugs() {
  const known = new Set(Object.values(loadState()).filter((e) => e && e.identifier).map((e) => e.identifier));

  // 0) Forced pickups. A human tagged these with `forceLabel` ("autofix") to demand an immediate fix —
  //    run them right away, bypassing the WIP cap AND the one-per-cycle pacing. Skip any that already
  //    have a state.json record: accidentally re-labelling an already-handled bug must NOT re-trigger it.
  let forcedIds = new Set();
  try {
    const forced = (await listForcedBugs()).filter((b) => !known.has(b.identifier));
    forcedIds = new Set(forced.map((b) => b.identifier));
    if (forced.length) {
      forced.sort(byPriority);
      // Urgent → no concurrency cap: run ALL forced bugs at once (or `maxForcedConcurrent` if set > 0).
      const fw = config.maxForcedConcurrent > 0 ? config.maxForcedConcurrent : forced.length;
      log(`${new Date().toISOString()} — ${forced.length} forced bug(s) [label "${config.forceLabel}"] — fixing now (${fw} at a time), bypassing the cap`);
      await runBugs([...forced], fw);
    }
  } catch (e) { console.error('[poll] forced pickup failed:', e.message); }

  // 1) Normal capped picking, one-by-one under `maxOpenBugs`. EVERY state.json entry counts (the same
  //    list the chat UI shows); a slot frees only when a human marks the issue Done/Canceled and gc.mjs
  //    deletes its entry. Re-read state so the forced picks just made count against the cap.
  const cap = Math.max(0, config.maxOpenBugs ?? 15);
  const perCycle = Math.max(1, config.maxPicksPerCycle || 1);
  const open = Object.values(loadState()).filter((e) => e && e.identifier).length;
  const slots = Math.max(0, cap - open);
  if (slots === 0) {
    log(`${new Date().toISOString()} — ${open}/${cap} bug(s) already in the list; picking no new (unforced) bugs this cycle`);
    return;
  }

  const bugs = (await listNewBugs()).filter((b) => !forcedIds.has(b.identifier)); // don't double-pick a forced one
  bugs.sort(byPriority);
  const take = Math.min(slots, perCycle, bugs.length);
  log(`${new Date().toISOString()} — ${bugs.length} new bug(s); ${open}/${cap} in the list, ${slots} slot(s) free → picking ${take} this cycle`);
  if (!take) return;

  await runBugs(bugs.slice(0, take)); // highest-priority first; the rest wait for a future cycle
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
  const changed = {}; // only the entries we actually touch, so we can re-apply against a FRESH read
  for (const issue of stale) {
    const entry = state[issue.id];
    if (!entry || entry.outcome !== 'started') continue; // human-owned issue or a finished run
    try {
      if ((entry.recoveries || 0) === 0) {
        log(`${issue.identifier}: autofix started this run but never finished — resetting for one retry`);
        const sid = (await findStateId(issue.team.id, 'Backlog', 'backlog')) || (await findStateId(issue.team.id, 'Todo', 'unstarted'));
        if (sid) await moveIssue(issue.id, sid);
        await addComment(issue.id, '⚠️ **Auto-fix run appears to have crashed** (the issue sat In Progress with no result). Resetting it so the poller retries once.');
        changed[issue.id] = { ...entry, outcome: 'recovered', recoveries: 1, at: new Date().toISOString() };
      } else {
        log(`${issue.identifier} crashed again after a recovery — flagging for a human`);
        await addComment(issue.id, '🔴 **Auto-fix crashed twice on this issue — needs a human.** It will not be retried automatically.');
        changed[issue.id] = { ...entry, outcome: 'recovery_failed', at: new Date().toISOString() };
      }
    } catch (e) { console.error(`[poll] recovery of ${issue.identifier} failed:`, e.message); }
  }
  // Re-read FRESH and apply only our changes, so the await-heavy loop above can't clobber entries the
  // chat server added meanwhile (e.g. new standalone chats).
  if (Object.keys(changed).length) { const fresh = loadState(); Object.assign(fresh, changed); saveState(fresh); }
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

// Keep each issue's stored assignee in sync with its CURRENT Linear assignee, so the chat sidebar shows
// the real owner. A card is often assigned to a person only AFTER the bot fixes it, so the pickup-time
// snapshot (usually unassigned) would otherwise show no owner forever. READS use the default key (the
// poller sees every assignee's issues). RMW against a fresh read + apply only the patch fields, so this
// can't clobber entries the chat server touches concurrently (new standalone chats, PR links, watches).
async function refreshAssignees() {
  const patches = {}; // uuid -> { assignee, assigneeEmail }
  for (const [uuid, entry] of Object.entries(loadState())) {
    if (!entry.identifier || entry.standalone) continue;
    let issue;
    try { issue = await resolveIssue(entry.identifier); } catch { continue; }
    const patch = assigneeRefreshPatch(entry, issue.assignee);
    if (patch) patches[uuid] = patch;
  }
  const ids = Object.keys(patches);
  if (!ids.length) return;
  const fresh = loadState();
  for (const [uuid, patch] of Object.entries(patches)) if (fresh[uuid]) Object.assign(fresh[uuid], patch);
  saveState(fresh);
  log(`refreshed assignee on ${ids.length} issue(s) to match Linear`);
}

async function main() {
  if (!process.env.LINEAR_API_KEY) { console.error('[poll] LINEAR_API_KEY not set'); process.exit(2); }
  // One-off backfill: pull every issue's current Linear assignee into state.json and exit. Safe to run
  // any time (independent of AUTOFIX_RUN_ENABLED — it only reads Linear and writes assignee fields).
  if (process.argv.includes('--refresh-assignees')) { await refreshAssignees(); return; }
  // The poller runs ONLY on the designated runner (the EC2 box sets this in its .env).
  if (process.env.AUTOFIX_RUN_ENABLED !== '1') {
    console.error('[poll] refusing to run: AUTOFIX_RUN_ENABLED != 1 (fixes are EC2-only; set it in .linear-autofix/.env on the designated runner)');
    process.exit(2);
  }
  await processNewBugs();
  await recoverStale();
  await scanRevisions();
  await refreshAssignees();
}

main().catch((e) => { console.error('[poll] fatal:', e); process.exit(1); });
