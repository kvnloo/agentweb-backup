#!/usr/bin/env node
// Runs from backend/package.json "prepare" (npm ci / npm install run it automatically).
// Points the repository at the committed .githooks/ directory. Idempotent; a no-op in CI, in a
// non-git checkout (docker build context, EB bundle), or when explicitly disabled. core.hooksPath
// is stored in the shared .git/config, so every worktree of the checkout (swarm worktrees
// included) inherits it; relative paths resolve against each worktree. See ENG-1277.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// CI checkouts must never get a local hook wired in mid-run — every hosted-runner job sets CI=true,
// and `npm ci` is the first thing tests.yml does. AGENTWEB_NO_GIT_HOOKS is the explicit human/agent
// opt-out for environments that aren't CI but still shouldn't get the hook (e.g. a throwaway
// scratch checkout).
if (process.env.CI || process.env.AGENTWEB_NO_GIT_HOOKS) process.exit(0);

const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (top.status !== 0) process.exit(0); // not a git checkout (e.g. an extracted tarball/EB bundle)
const root = top.stdout.trim();
if (!existsSync(path.join(root, '.githooks', 'pre-push'))) process.exit(0); // checkout predates the hook

const cur = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).stdout.trim();
if (cur === '.githooks') process.exit(0); // already installed

const set = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
if (set.status !== 0) { console.error('install-git-hooks: could not set core.hooksPath'); process.exit(0); }
console.log('install-git-hooks: core.hooksPath -> .githooks (pre-push verification enabled; bypass with git push --no-verify or AGENTWEB_SKIP_PREPUSH=1)');
