#!/usr/bin/env node
// .linear-autofix/gc.mjs — remove kept worktrees whose Linear issue is Done/Canceled.
// Run on a schedule (folded into run.sh). For each dir under the worktrees folder, look up
// the issue's current Linear state; if it's a "done" type, stop any preview + remove the
// worktree, branches, and state entry.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { config } from './config.mjs';
import { resolveIssue } from './linear.mjs';
import { lockActive } from './lock.mjs';
import { evictIdlePreviews, evictUnderMemoryPressure, stalePreviews } from './preview/policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..');
const statePath = path.join(__dirname, 'state.json');
const chatStatePath = path.join(__dirname, 'chat', 'chat-state.json');
const previewScript = path.join(__dirname, 'preview', 'preview.mjs');
const worktreesDir = path.resolve(agentRoot, config.worktreesDir);
const logsDir = path.join(__dirname, 'logs');
const DONE_TYPES = config.gcDoneStateTypes || ['completed', 'canceled'];
const log = (...a) => console.log('[gc]', ...a);

const repoRootOf = (repo) => path.resolve(agentRoot, repo.root);
const wtPathOf = (WT, repo) => (repo.mount === '.' ? WT : path.join(WT, repo.mount));
const gitIn = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

// Delete the chat session-transcript forks minted for this issue (from message edits). Forks live
// at ~/.claude/projects/<escaped-cwd>/<sid>.jsonl; only ids we created (cs.forks) are touched —
// never the pipeline or original chat session. This is READ-ONLY on chat-state.json: the chat
// server is its sole writer, so there is no cross-process lost-update race. The leftover chat-state
// entry (a few KB, and invisible in the UI since the sidebar is driven by state.json) is harmless.
function cleanChatForks(id) {
  let cs; try { cs = JSON.parse(readFileSync(chatStatePath, 'utf8')); } catch { return; }
  const entry = cs[id];
  if (!entry?.cwd) return;
  const projDir = path.join(process.env.HOME || '', '.claude', 'projects', entry.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  for (const sid of entry.forks || []) rmSync(path.join(projDir, `${sid}.jsonl`), { force: true });
}

function removeWorktree(id) {
  const WT = path.join(worktreesDir, id);
  // Stop any running preview for this bug first (services hold files open).
  spawnSync('node', [previewScript, 'down', id], { stdio: 'ignore' });
  // Find the branch (from the root worktree) so we can delete it from each repo.
  let branch = null;
  const main = config.repos.find((r) => r.mount === '.');
  if (main) { const r = gitIn(wtPathOf(WT, main), ['rev-parse', '--abbrev-ref', 'HEAD']); if (r.status === 0) branch = r.stdout.trim(); }
  for (const repo of [...config.repos].reverse()) {
    spawnSync('git', ['-C', repoRootOf(repo), 'worktree', 'remove', '--force', wtPathOf(WT, repo)]);
    spawnSync('git', ['-C', repoRootOf(repo), 'worktree', 'prune']);
    if (branch) spawnSync('git', ['-C', repoRootOf(repo), 'branch', '-D', branch]);
  }
  rmSync(WT, { recursive: true, force: true });
}

// Given the current state.json entries and the set of ids that DO have a worktree, return the ids of
// worktree-less entries whose Linear issue is Done/Canceled and are therefore safe to reap. Standalone
// CHAT-* entries (not Linear issues), still-open issues, locked/in-flight issues, and issues that no
// longer resolve are all left alone. The Linear/lock probes are injectable so this is unit-testable.
export async function reapableWorktreelessIds(entries, worktreeIds, {
  doneTypes = DONE_TYPES,
  resolveIssue: resolveFn = resolveIssue,
  lockActive: lockFn = lockActive,
  log: logFn = () => {},
} = {}) {
  const wt = new Set([...worktreeIds].map((s) => String(s).toUpperCase()));
  const out = [];
  for (const e of entries || []) {
    const id = e?.identifier;
    if (!id || e.standalone) continue;         // standalone CHAT-* isn't a Linear issue
    if (wt.has(id.toUpperCase())) continue;    // already handled by the worktree scan
    if (out.includes(id)) continue;            // guard against duplicate identifiers in state
    if (lockFn(id)) { logFn(`skip ${id} (an operation is active)`); continue; }
    let issue;
    try { issue = await resolveFn(id); }
    catch (ex) { logFn(`skip ${id} (could not resolve: ${ex.message})`); continue; } // deleted/renamed issue — leave it
    const type = issue.state?.type;
    if (doneTypes.includes(type)) { logFn(`${id} is "${issue.state.name}" (${type}), no worktree → reap`); out.push(id); }
    else logFn(`${id} still "${issue.state?.name}" (${type}), no worktree → keep`);
  }
  return out;
}

async function main() {
  if (!process.env.LINEAR_API_KEY) { console.error('[gc] LINEAR_API_KEY not set'); process.exit(2); }

  // Reap previews untouched for previewIdleHours (default 24h), independent of worktree state — a
  // long-abandoned preview holds ~0.8GB even while its issue is still open. Uses the same last-hit
  // signal as the cap eviction, so an actively-used preview is never stopped. Local JSON only.
  const idleHours = config.previewIdleHours ?? 0;
  if (idleHours > 0) {
    try { evictIdlePreviews(idleHours * 3600 * 1000, log); }
    catch (e) { log(`idle-preview reap failed: ${e.message}`); }
  }

  // OOM backstop: the idle reaper above only fires at 24h, but a handful of live stacks can exhaust
  // RAM long before that (tickets sit in Verifying for hours, each holding a full backend+2×vite copy).
  // When MemAvailable drops below the floor, stop the longest-idle stacks NOW — regardless of Linear
  // status or the 24h age — while protecting any preview touched in the last few minutes. This is the
  // status-independent eviction the worktree GC alone can't provide. Disabled when floor is 0/unset.
  const memFloorMB = config.previewMemFloorMB ?? 0;
  if (memFloorMB > 0) {
    try {
      evictUnderMemoryPressure(memFloorMB, {
        keep: config.previewMemKeep ?? 1,
        minIdleMs: (config.previewMemMinIdleMinutes ?? 10) * 60 * 1000,
      }, log);
    } catch (e) { log(`memory-pressure preview reap failed: ${e.message}`); }
  }

  // Keep each live preview matching its branch HEAD. A preview is a bring-up-time SNAPSHOT — the backend
  // runs ts-node from the worktree source, the portals are built once — so commits landing on the branch
  // AFTER bring-up leave it serving STALE code until it's restarted (this is what made ENG-384 look stale:
  // the backend predated the fix commit). Detect the drift here and refresh: cheap ts-node restart for a
  // backend-only change, full rebuild only if a portal changed. Skip a locked worktree (a run/turn/rebuild
  // is mid-flight — refreshing under it would corrupt it). Disable via config.previewAutoRefreshOnHeadChange.
  if (config.previewAutoRefreshOnHeadChange !== false) {
    try {
      for (const { b, from, to } of stalePreviews()) {
        if (lockActive(b)) { log(`${b} stale (${from.slice(0, 9)} → ${to.slice(0, 9)}) but an operation is active — deferring refresh`); continue; }
        log(`${b} preview is stale (${from.slice(0, 9)} → branch head ${to.slice(0, 9)}) → refreshing`);
        spawnSync('node', [previewScript, 'refresh', b], { stdio: 'inherit' });
      }
    } catch (e) { log(`preview auto-refresh failed: ${e.message}`); }
  }

  // Worktree dirs (may be empty). Even with none, we still reconcile worktree-less state entries below,
  // so this no longer early-returns.
  const dirs = existsSync(worktreesDir)
    ? readdirSync(worktreesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];

  const removedIds = [];
  for (const id of dirs) {
    let issue;
    try { issue = await resolveIssue(id); }
    catch (e) { log(`skip ${id} (could not resolve: ${e.message})`); continue; } // e.g. a standalone CHAT-* worktree — not a Linear issue, never reaped here
    const type = issue.state?.type;
    // Something may be mid-flight in this worktree — a chat turn (full OR read-only), a poller
    // fix/revision, or a background preview rebuild all hold a self-healing lock for their duration.
    // Removing the worktree under any of them corrupts it. lockActive() ignores a dead holder's stale
    // lock (so a crashed run can't wedge gc forever) and also covers the `<id>.preview.lock`.
    if (lockActive(id)) {
      log(`skip ${id} (an operation is active in this worktree)`);
      continue;
    }
    if (DONE_TYPES.includes(type)) {
      log(`${id} is "${issue.state.name}" (${type}) → removing worktree`);
      removeWorktree(id);
      cleanChatForks(id);
      rmSync(path.join(logsDir, id), { recursive: true, force: true }); // stage/chat tee logs for this issue
      removedIds.push(id);
    } else {
      log(`${id} still "${issue.state?.name}" (${type}) → keep`);
    }
  }

  // Also reconcile state entries that never produced a worktree — issues that ended terminal-but-early
  // (blocked / cannot_fix / setup_failed / no_change, before any branch was cut) leave no dir for the
  // scan above, so without this they linger in the sidebar forever even after a human marks them
  // Done/Canceled. Resolve each against Linear and drop the completed/canceled ones, mirroring the
  // worktree path (chat-fork + log cleanup; the deletion itself is applied in the fresh-state write below).
  const worktreeIds = new Set(dirs.map((d) => d.toUpperCase()));
  let stateForScan = {}; try { stateForScan = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* none */ }
  const reapIds = await reapableWorktreelessIds(Object.values(stateForScan), worktreeIds, { log });
  for (const id of reapIds) {
    if (removedIds.includes(id)) continue;
    cleanChatForks(id);
    rmSync(path.join(logsDir, id), { recursive: true, force: true }); // stage/chat tee logs for this issue
    removedIds.push(id);
  }

  // Re-read state FRESH before writing so this run's slow async loop can't clobber entries the chat
  // server added meanwhile (notably new standalone chats). Apply ONLY the deletions we actually made.
  let state = {}; try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* none */ }
  for (const k of Object.keys(state)) if (removedIds.includes(state[k].identifier)) delete state[k];
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  const removed = removedIds.length;
  log(`done — removed ${removed} worktree(s)`);
}

// Auto-run only when invoked directly (not when imported by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[gc] fatal:', e); process.exit(1); });
}
