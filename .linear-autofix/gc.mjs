#!/usr/bin/env node
// .linear-autofix/gc.mjs — remove kept worktrees whose Linear issue is Done/Canceled.
// Run on a schedule (folded into run.sh). For each dir under the worktrees folder, look up
// the issue's current Linear state; if it's a "done" type, stop any preview + remove the
// worktree, branches, and state entry.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
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
const log = (...a) => console.log('[gc]', ...a);

const repoRootOf = (repo) => path.resolve(agentRoot, repo.root);
const wtPathOf = (WT, repo) => (repo.mount === '.' ? WT : path.join(WT, repo.mount));
const gitIn = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

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

async function main() {
  if (!process.env.LINEAR_API_KEY) { console.error('[gc] LINEAR_API_KEY not set'); process.exit(2); }
  if (!existsSync(worktreesDir)) { log('no worktrees dir; nothing to do'); return; }
  const dirs = readdirSync(worktreesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  if (!dirs.length) { log('no worktrees'); return; }

  let state = {}; try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* none */ }
  let removed = 0;
  for (const id of dirs) {
    let issue;
    try { issue = await resolveIssue(id); }
    catch (e) { log(`skip ${id} (could not resolve: ${e.message})`); continue; }
    const type = issue.state?.type;
    if (DONE_TYPES.includes(type)) {
      log(`${id} is "${issue.state.name}" (${type}) → removing worktree`);
      removeWorktree(id);
      for (const k of Object.keys(state)) if (state[k].identifier === id) delete state[k];
      removed++;
    } else {
      log(`${id} still "${issue.state?.name}" (${type}) → keep`);
    }
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  log(`done — removed ${removed} worktree(s)`);
}

main().catch((e) => { console.error('[gc] fatal:', e); process.exit(1); });
