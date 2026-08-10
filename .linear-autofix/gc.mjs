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
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
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
// prCounts: { open, merged } aggregated across repos, or null when the lookup failed
// (gh missing / network error) — null MUST fail safe to keep, never to remove.
export function decideWorktree({
  resolved,
  issueStateType,
  issueStateName,
  prCounts,
  ageDays,
  unresolvedMaxAgeDays,
  doneTypes,
}) {
  if (resolved) {
    if (doneTypes.includes(issueStateType)) {
      return { action: 'remove', reason: `issue is "${issueStateName}" (${issueStateType})` };
    }
    if (issueStateType === 'started' && prCounts && prCounts.open === 0 && prCounts.merged > 0) {
      return {
        action: 'remove',
        reason: `linked PR merged (${prCounts.merged} merged, 0 open) — issue "${issueStateName}" awaits closure only`,
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

// PR counts for a branch across all configured repos via gh. Returns null on any
// failure so the caller keeps the worktree instead of guessing.
function prCountsForBranch(branch) {
  let open = 0;
  let merged = 0;
  for (const repo of config.repos) {
    for (const [state, bump] of [['open', () => open++], ['merged', () => merged++]]) {
      const r = spawnSync(
        'gh',
        ['pr', 'list', '--head', branch, '--state', state, '--json', 'number'],
        { cwd: repoRootOf(repo), encoding: 'utf8' },
      );
      if (r.status !== 0 || r.error) return null;
      let prs;
      try { prs = JSON.parse(r.stdout); } catch { return null; }
      for (let i = 0; i < prs.length; i++) bump();
    }
  }
  return { open, merged };
}

function ageDaysOf(WT) {
  try { return Math.floor((Date.now() - statSync(WT).mtimeMs) / 86400000); }
  catch { return null; }
}

function removeWorktree(id) {
  const WT = path.join(worktreesDir, id);
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

    const decision = decideWorktree({
      resolved: !!issue,
      issueStateType: issue?.state?.type,
      issueStateName: issue?.state?.name,
      prCounts,
      ageDays: issue ? null : ageDaysOf(WT),
      unresolvedMaxAgeDays: UNRESOLVED_MAX_AGE_DAYS,
      doneTypes: DONE_TYPES,
    });

    if (decision.action === 'remove') {
      log(`${id}: ${decision.reason} → removing worktree`);
      removeWorktree(id);
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
