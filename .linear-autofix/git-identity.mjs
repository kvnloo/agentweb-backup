// .linear-autofix/git-identity.mjs — attribute the automated fix's commits to the Linear
// issue's ASSIGNEE, so git history and the GitHub contribution graph credit the person the
// bug was assigned to instead of the runner box's identity.
//
// We set GIT_AUTHOR_* / GIT_COMMITTER_* in the environment rather than running `git config`:
// the worktrees hang off the developer's REAL local repos (a `git config user.email` would
// write to the shared repo config and silently change their own identity). Env vars affect
// only the commits made by processes we spawn, and touch no config file.
import { config } from './config.mjs';
import { spawnSync } from 'child_process';
import path from 'path';

// Resolve a Linear assignee to the git { name, email } their commits should carry:
//   1. an explicit per-person override in config.assigneeGitIdentity (keyed by Linear email), else
//   2. the assignee's own Linear name + email.
// Returns null when attribution is disabled, there is no assignee, or we have no usable email —
// callers then leave the box's default git identity in place.
export function resolveAssigneeIdentity(assignee) {
  if (config.commitAsAssignee === false) return null;
  if (!assignee) return null;
  const linearEmail = (assignee.email || '').trim();
  const map = config.assigneeGitIdentity || {};
  const override = linearEmail ? map[linearEmail] || map[linearEmail.toLowerCase()] : null;
  const name = (override?.name || assignee.name || assignee.displayName || '').trim();
  const email = (override?.email || linearEmail).trim();
  if (!name || !email) return null;
  return { name, email };
}

// The GIT_AUTHOR_* / GIT_COMMITTER_* env pairs for an identity — author AND committer both,
// so the commit is fully attributed to the assignee (not just the "authored by" line).
export function gitIdentityEnv(identity) {
  if (!identity) return {};
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

// Convenience for the assignee case: env pairs (or {}) straight from a Linear assignee.
export function assigneeGitEnv(assignee) {
  return gitIdentityEnv(resolveAssigneeIdentity(assignee));
}

// Resolve the GitHub token the draft PR should be OPENED with, so the PR itself (not just its
// commits) is authored by the assignee. Unlike commit identity — which is just git metadata —
// GitHub ties PR authorship to the API token, so this needs a real per-person token. Tokens live
// in .linear-autofix/.env (gitignored); config.assigneeGhTokenEnv maps a Linear email to the
// ENV-VAR NAME holding that person's token (never the literal token — config.mjs is committed).
// Returns the token string, or null when PR-as-assignee is disabled, there is no assignee, no
// mapping exists, or the referenced env var is empty — callers then fall back to the box's `gh`.
export function resolveAssigneeGhToken(assignee) {
  if (config.prAsAssignee === false) return null;
  if (!assignee) return null;
  const email = (assignee.email || '').trim();
  if (!email) return null;
  const map = config.assigneeGhTokenEnv || {};
  const envName = map[email] || map[email.toLowerCase()];
  if (!envName) return null;
  const token = (process.env[envName] || '').trim();
  return token || null;
}

// Persist an identity as the LOCAL git config of ONE linked worktree, so every commit made in it —
// our spawned agent AND a human who SSHes in to commit by hand — is authored by the assignee even
// without the GIT_* env, and so re-applying with a new identity is how a reassignment changes who
// future commits go by. We MUST use per-worktree config, not plain `git config --local`: the autofix
// worktrees are LINKED worktrees of the developer's real repos, which share one $GIT_DIR/config — a
// `--local` set there would rewrite the developer's own identity and let concurrent worktrees (one
// per assignee) clobber each other. `extensions.worktreeConfig` + `--worktree` writes to that
// worktree's private config.worktree instead, fully isolated (verified: the main checkout stays
// untouched). Idempotent — safe to call every turn. Returns true on success.
export function setWorktreeIdentity(wt, identity, log = () => {}) {
  if (!identity?.name || !identity?.email) return false;
  const cfg = (...args) => spawnSync('git', ['-C', wt, 'config', ...args], { encoding: 'utf8' });
  const en = cfg('extensions.worktreeConfig', 'true'); // enable per-worktree config (idempotent)
  if (en.status !== 0) { log(`worktree identity: could not enable worktreeConfig in ${wt}: ${(en.stderr || '').trim()}`); return false; }
  const n = cfg('--worktree', 'user.name', identity.name);
  const e = cfg('--worktree', 'user.email', identity.email);
  if (n.status !== 0 || e.status !== 0) { log(`worktree identity: could not set user.* in ${wt}: ${((n.stderr || '') + (e.stderr || '')).trim()}`); return false; }
  return true;
}

// Apply the identity to EVERY repo of an assembled workspace (main + each nested repo), mirroring
// how config.repos are mounted under the workspace root WT. No-op when there's no usable identity
// (unassigned issue) — those keep git's default so nothing is falsely attributed.
export function applyWorktreeIdentity(WT, identity, log = () => {}) {
  if (!identity?.name || !identity?.email) return;
  for (const repo of config.repos) {
    const wt = repo.mount === '.' ? WT : path.join(WT, repo.mount);
    if (setWorktreeIdentity(wt, identity, log)) log(`Commit identity for ${repo.key} worktree set to ${identity.name} <${identity.email}>.`);
  }
}

// For the per-issue processes (autofix.mjs, revise.mjs): set the assignee's identity on
// process.env so EVERY commit-making stage they spawn inherits it. Returns the resolved
// identity (or null) so the caller can log who commits will be attributed to.
export function applyAssigneeIdentity(issue, log = () => {}) {
  const identity = resolveAssigneeIdentity(issue?.assignee);
  if (!identity) {
    if (issue?.assignee) log(`Commit attribution: could not resolve a git identity for assignee ${issue.assignee.name || issue.assignee.email || '(unknown)'} — using the box default.`);
    else log('Commit attribution: issue has no assignee — using the box default git identity.');
    return null;
  }
  Object.assign(process.env, gitIdentityEnv(identity));
  log(`Commit attribution: commits will be authored as ${identity.name} <${identity.email}> (issue assignee).`);
  return identity;
}
