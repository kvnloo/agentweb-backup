#!/usr/bin/env node
// .linear-autofix/gc.mjs — remove kept worktrees whose work is finished.
// Run on a schedule (folded into run.sh). For each dir under the worktrees folder, look up
// the issue's current Linear state; remove the worktree, branches, and state entry when
//   - the issue is in a "done" state type, OR
//   - the issue's linked PR(s) have merged with none still open (ENG-1017: `Verifying`/
//     `Merged` are `started` types on the ENG board, so state alone leaks ~1.9 GB per
//     delivered issue until closure), OR
//   - the identifier doesn't resolve in Linear and the directory is older than
//     `gcUnresolvedMaxAgeDays` (scratch dirs like `tsc-heap` otherwise leak forever).

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync, renameSync, readlinkSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.mjs';
import { resolveIssue } from './linear.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..');
const statePath = path.join(__dirname, 'state.json');
const previewScript = path.join(__dirname, 'preview', 'preview.mjs');
const worktreesDir = path.resolve(agentRoot, config.worktreesDir);
const DONE_TYPES = config.gcDoneStateTypes || ['completed', 'canceled'];
const UNRESOLVED_MAX_AGE_DAYS = config.gcUnresolvedMaxAgeDays ?? 14;
const log = (...a) => console.log('[gc]', ...a);

const repoRootOf = (repo) => path.resolve(agentRoot, repo.root);
const wtPathOf = (WT, repo) => (repo.mount === '.' ? WT : path.join(WT, repo.mount));
const gitIn = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

// Pure reap decision — unit-tested in test/gc.test.mjs against the ENG-1017 contract.
// prCounts: { open, merged, closedUnmerged } aggregated across repos, or null when the
// lookup failed (gh missing / network error) — null MUST fail safe to keep, never to remove.
// lookupFailed: the Linear lookup errored for a reason other than "not found" (network,
// auth, DNS) — indistinguishable from unresolvable by absence alone, so it MUST keep.
export function decideWorktree({
  resolved,
  lookupFailed,
  issueStateType,
  issueStateName,
  prCounts,
  ageDays,
  unresolvedMaxAgeDays,
  doneTypes,
}) {
  if (lookupFailed) {
    return { action: 'keep', reason: 'Linear lookup failed (transient?) — keeping until it resolves' };
  }
  if (resolved) {
    if (doneTypes.includes(issueStateType)) {
      return { action: 'remove', reason: `issue is "${issueStateName}" (${issueStateType})` };
    }
    if (
      issueStateType === 'started' &&
      prCounts &&
      prCounts.open === 0 &&
      prCounts.merged > 0 &&
      (prCounts.closedUnmerged ?? 0) === 0
    ) {
      return {
        action: 'remove',
        reason: `linked PR merged (${prCounts.merged} merged, 0 open, 0 closed-unmerged) — issue "${issueStateName}" awaits closure only`,
      };
    }
    return { action: 'keep', reason: `issue still "${issueStateName}" (${issueStateType}), no merged-PR evidence` };
  }
  if (ageDays != null && ageDays > unresolvedMaxAgeDays) {
    return { action: 'remove', reason: `unresolvable identifier, untouched ${ageDays}d > ${unresolvedMaxAgeDays}d threshold` };
  }
  return { action: 'keep', reason: 'unresolvable identifier, under age threshold (or age unknown)' };
}

// The branch this worktree checked out, read from the root repo's mount.
function branchOf(WT) {
  const main = config.repos.find((r) => r.mount === '.');
  if (!main) return null;
  const r = gitIn(wtPathOf(WT, main), ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.status === 0 ? r.stdout.trim() : null;
}

// PR counts for a branch across all configured repos via gh. Counts closed-but-unmerged
// PRs separately: a branch with one merged and one closed-without-merge PR is NOT fully
// delivered and must be kept. Returns null on any failure so the caller keeps the
// worktree instead of guessing.
function prCountsForBranch(branch) {
  let open = 0;
  let merged = 0;
  let closedUnmerged = 0;
  for (const repo of config.repos) {
    const r = spawnSync(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'state'],
      { cwd: repoRootOf(repo), encoding: 'utf8' },
    );
    if (r.status !== 0 || r.error) return null;
    let prs;
    try { prs = JSON.parse(r.stdout); } catch { return null; }
    for (const pr of prs) {
      if (pr.state === 'OPEN') open++;
      else if (pr.state === 'MERGED') merged++;
      else closedUnmerged++;
    }
  }
  return { open, merged, closedUnmerged };
}

// Newest mtime anywhere under WT, not just the top-level dir — a write to a nested file
// does not bump the parent directory's mtime, so top-level mtime alone can misread an
// active scratch dir as idle. Caps the walk; hitting the cap returns null (age unknown →
// caller keeps) so a huge tree can never be aged out on partial evidence.
const AGE_SCAN_MAX_ENTRIES = 20000;
export function scanNewestMtime(WT) {
  try {
    let newest = statSync(WT).mtimeMs;
    let visited = 0;
    const stack = [WT];
    while (stack.length) {
      const dir = stack.pop();
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (++visited > AGE_SCAN_MAX_ENTRIES) return null;
        const p = path.join(dir, ent.name);
        try {
          const st = statSync(p);
          if (st.mtimeMs > newest) newest = st.mtimeMs;
          if (ent.isDirectory() && !ent.isSymbolicLink()) stack.push(p);
        } catch {
          // A raced stat means something is mutating the tree right now —
          // that IS activity. Age unknown → caller keeps.
          return null;
        }
      }
    }
    return newest;
  } catch { return null; }
}
// The scan races with live writers: a write landing in an already-visited path is
// invisible to a single pass. Two passes bound that window — a write during pass 1
// is visible to pass 2 (which starts after it), so age only counts when both
// passes agree the tree is old. Any unknown → keep.
export function newestStableMtime(WT) {
  const first = scanNewestMtime(WT);
  if (first === null) return null;
  const second = scanNewestMtime(WT);
  if (second === null) return null;
  return Math.max(first, second);
}
export function ageDaysOf(WT) {
  const newest = newestStableMtime(WT);
  if (newest === null) return null;
  // An mtime can land marginally ahead of Date.now() (filesystem timestamp
  // rounding) — a negative age is just "fresh", never propagate it below 0.
  return Math.max(0, Math.floor((Date.now() - newest) / 86400000));
}

// The age scan and the removal are not atomic: a write landing after the last scan pass
// but before rmSync would be silently destroyed. renameSync is the atomic barrier — once
// the dir is quarantined, a writer using the original path fails loudly with ENOENT
// instead of writing into a tree mid-deletion. Re-checking age on the quarantined tree
// closes the scan→rename window: any write in that window bumps an mtime, the re-check
// sees it, and the dir is restored untouched. Returns the quarantine path to delete, or
// null to keep (tree restored, or rename itself raced → nothing to do).
// A rename does not invalidate already-open file descriptors (or a process cwd), so a
// holder inside the quarantined tree could keep writing right up to rmSync — and those
// writes would be silently destroyed. /proc is the ground truth for that on the Linux
// runner: scan every process's fd table and cwd for paths inside the quarantined dir.
// Any holder, or a missing/unreadable proc table → treat as live. Uninspectable
// individual pids (foreign-uid / non-dumpable) are skipped but logged. Exported with an
// injectable proc root so tests can build a fake /proc tree.
export function openHandleHolders(dir, procRoot = '/proc') {
  let real;
  try { real = realpathSync(dir); } catch { return null; } // dir vanished mid-check → can't prove
  const prefix = real + path.sep;
  const inside = (p) => p === real || p.startsWith(prefix);
  let pids;
  try { pids = readdirSync(procRoot).filter((n) => /^\d+$/.test(n)); } catch { return null; }
  const holders = [];
  const unprovable = [];
  let lastSkipCode = null;
  for (const pid of pids) {
    const base = path.join(procRoot, pid);
    // A pid that vanished mid-scan (ENOENT/ESRCH) provably holds nothing. Any other
    // failure (EACCES/EPERM) means the pid is live but uninspectable — a foreign-uid
    // process, or an own-uid non-dumpable one (sshd/sd-pam post-setuid daemons are
    // EACCES even to their owner on every Linux host). Failing the whole check closed
    // on those would make GC permanently unable to reap anywhere; every process the
    // runner itself spawns is same-uid and dumpable, hence readable. So: skip the pid,
    // but LOG it — an uninspectable holder is never silently equated with "no holder".
    const goneMidScan = (e) => e && (e.code === 'ENOENT' || e.code === 'ESRCH');
    const skipUnprovable = (e) => {
      if (unprovable[unprovable.length - 1] !== pid) unprovable.push(pid);
      lastSkipCode = e.code;
    };
    try {
      if (inside(readlinkSync(path.join(base, 'cwd')))) { holders.push(pid); continue; }
    } catch (e) {
      if (!goneMidScan(e)) { skipUnprovable(e); continue; }
    }
    let fds = [];
    try {
      fds = readdirSync(path.join(base, 'fd'));
    } catch (e) {
      if (!goneMidScan(e)) skipUnprovable(e);
      continue;
    }
    for (const fd of fds) {
      try {
        if (inside(readlinkSync(path.join(base, 'fd', fd)))) { holders.push(pid); break; }
      } catch (e) {
        if (!goneMidScan(e)) skipUnprovable(e);
      }
    }
  }
  if (unprovable.length > 0) {
    log(`open-handle scan: skipped ${unprovable.length} uninspectable pid(s) (${lastSkipCode}): ${unprovable.join(', ')} — foreign-uid/non-dumpable; runner-spawned processes are always inspectable`);
  }
  return holders;
}

export function quarantineIfStillAged(WT, minAgeDays, procRoot = '/proc') {
  const q = `${WT}.gc-quarantine`;
  try { renameSync(WT, q); } catch { return null; }
  const restore = () => {
    try { renameSync(q, WT); } catch (e) { console.error('[gc] restore from quarantine failed:', q, e.message); }
  };
  const age = ageDaysOf(q);
  if (age === null || age <= minAgeDays) { restore(); return null; }
  // Age re-check only proves no *completed* write; a process holding an open fd (or its
  // cwd) inside the tree can still write after it. No holders — proven via /proc — is
  // the condition for deletion; holders present or unprovable → restore and keep.
  const holders = openHandleHolders(q, procRoot);
  if (holders === null || holders.length > 0) {
    log(`quarantine ${q}: ${holders === null ? 'open-handle check unavailable' : `open handles held by pid(s) ${holders.join(', ')}`} → keep`);
    restore();
    return null;
  }
  return q;
}

function removeWorktree(id, WT = path.join(worktreesDir, id)) {
  // Stop any running preview for this bug first (services hold files open).
  spawnSync('node', [previewScript, 'down', id], { stdio: 'ignore' });
  // Find the branch (from the root worktree) so we can delete it from each repo.
  const branch = branchOf(WT);
  for (const repo of [...config.repos].reverse()) {
    spawnSync('git', ['-C', repoRootOf(repo), 'worktree', 'remove', '--force', wtPathOf(WT, repo)]);
    spawnSync('git', ['-C', repoRootOf(repo), 'worktree', 'prune']);
    if (branch) spawnSync('git', ['-C', repoRootOf(repo), 'branch', '-D', branch]);
  }
  rmSync(WT, { recursive: true, force: true });
}

async function main() {
  if (!process.env.LINEAR_API_KEY) { console.error('[gc] LINEAR_API_KEY not set'); process.exit(2); }
  if (!existsSync(worktreesDir)) { log('no worktrees dir; nothing to do'); return; }
  const dirs = readdirSync(worktreesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  if (!dirs.length) { log('no worktrees'); return; }

  let state = {}; try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* none */ }
  let removed = 0;
  for (const id of dirs) {
    const WT = path.join(worktreesDir, id);
    let issue = null;
    let resolveError = null;
    try { issue = await resolveIssue(id); }
    catch (e) { resolveError = e; }

    let prCounts = null;
    if (issue && !DONE_TYPES.includes(issue.state?.type) && issue.state?.type === 'started') {
      const branch = branchOf(WT);
      prCounts = branch ? prCountsForBranch(branch) : null;
    }

    // resolveIssue throws "Issue X not found" for a definitive miss and other messages
    // for transient failures (network/auth/DNS). Only the definitive miss may age out.
    const lookupFailed = !!resolveError && !/not found/i.test(resolveError.message);

    // For an age-based reap, remember the mtime the age was computed FROM so the
    // final pre-removal check below can prove nothing wrote to the tree since.
    const ageBased = !issue && !lookupFailed;
    const baselineMtime = ageBased ? newestStableMtime(WT) : null;

    const decision = decideWorktree({
      resolved: !!issue,
      lookupFailed,
      issueStateType: issue?.state?.type,
      issueStateName: issue?.state?.name,
      prCounts,
      ageDays:
        baselineMtime === null ? null : Math.floor((Date.now() - baselineMtime) / 86400000),
      unresolvedMaxAgeDays: UNRESOLVED_MAX_AGE_DAYS,
      doneTypes: DONE_TYPES,
    });

    if (decision.action === 'remove') {
      let target = WT;
      if (ageBased) {
        // A re-scan alone still leaves a scan→rm window. Quarantine-rename is the
        // atomic barrier: post-rename writers fail loudly with ENOENT, and the age
        // re-check on the quarantined tree catches any write that landed before it.
        const q = quarantineIfStillAged(WT, UNRESOLVED_MAX_AGE_DAYS);
        if (!q) {
          log(`${id}: activity detected at removal time (quarantine re-check) → keep`);
          continue;
        }
        target = q;
      }
      log(`${id}: ${decision.reason} → removing worktree`);
      removeWorktree(id, target);
      for (const k of Object.keys(state)) if (state[k].identifier === id) delete state[k];
      removed++;
    } else {
      const detail = resolveError ? `${decision.reason}: ${resolveError.message}` : decision.reason;
      log(`${id}: ${detail} → keep`);
    }
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  log(`done — removed ${removed} worktree(s)`);
}

// Only run when executed directly, so tests can import decideWorktree without side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('[gc] fatal:', e); process.exit(1); });
}
