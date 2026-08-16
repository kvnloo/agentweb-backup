#!/usr/bin/env node
// agentweb pre-push verification (see ../../.githooks/pre-push).
//
// Contract
//   1. Only the refs actually being pushed are inspected (stdin from git). Deletes and tags skip.
//   2. If none of the pushed commits touch backend/ (or the CI path files that count as backend
//      per .github/workflows/tests.yml `backend` filter), exit 0 in < 1s.
//   3. Otherwise run, sequentially (never concurrently — both are memory-heavy):
//        a. tsc --noEmit over backend/tsconfig.json     (budget TSC_BUDGET_MS)
//        b. jest on: changed/added *.test.ts files  union  findRelatedTests(changed src files),
//           capped at RELATED_CAP suites; above the cap only the directly changed test files run
//           plus name-matched suites (hub files such as agentModeService.ts relate roughly half
//           the suite; the autofix runner dropped findRelatedTests for the same reason, ENG-129).
//           --bail so the first failure ends the run.               (budget JEST_BUDGET_MS)
//   4. Fail loud: a failure, a missing node_modules, or an exceeded budget blocks the push and
//      says exactly what to run. Never a silent pass. Bypass is explicit: --no-verify or
//      AGENTWEB_SKIP_PREPUSH=1 (checked by the bash shim before this file ever runs).
//
// Why here and not CI: CI proves the head; this hook stops the push that would have bought a
// ~31-runner-minute pair (ENG-1277) to learn what tsc says in well under a minute locally.
//
// The branching logic (ref parsing, base-SHA resolution, suite selection) lives in
// ./prepush/logic.mjs and is unit-tested there (`node --test backend/scripts/prepush/logic.test.mjs`).
// This file is intentionally thin: it wires that logic to real git/tsc/jest processes.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parsePushLine, isBackendPath, resolveBaseSha, classifyChangedFiles, selectJestSuites, evaluateListTestsResult } from './prepush/logic.mjs';

const TSC_BUDGET_MS = Number(process.env.AGENTWEB_PREPUSH_TSC_BUDGET_MS || 4 * 60 * 1000);
const JEST_BUDGET_MS = Number(process.env.AGENTWEB_PREPUSH_JEST_BUDGET_MS || 6 * 60 * 1000);
const RELATED_CAP = Number(process.env.AGENTWEB_PREPUSH_RELATED_CAP || 150);

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
const root = git(['rev-parse', '--show-toplevel']).trim();
const backend = path.join(root, 'backend');
function log(msg) { process.stderr.write(`pre-push: ${msg}\n`); }
function fail(msg) { log(msg); log('bypass (CI is the backstop): git push --no-verify'); process.exit(1); }

async function readPushedRefs() {
  const rl = readline.createInterface({ input: process.stdin });
  const refs = [];
  for await (const line of rl) {
    const parsed = parsePushLine(line);
    if (parsed) refs.push(parsed);
  }
  return refs;
}

function changedFilesForRefs(refs) {
  const files = new Set();
  for (const r of refs) {
    const base = resolveBaseSha(r, {
      commitExists: (sha) => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root }).status === 0,
      mergeBase: (a, b) => {
        const mb = spawnSync('git', ['merge-base', a, b], { cwd: root, encoding: 'utf8' });
        return mb.status === 0 ? mb.stdout.trim() : null;
      },
      parentOf: (sha) => `${sha}~1`,
    });
    // ENG-1277 / Greptile: ACMRD, not ACMR — a deletion-only push (e.g. removing a
    // source file something else still imports) must still be classified as a
    // backend change, or the hook's own "no backend changes — skipping" short
    // circuit below silently skips tsc/jest for exactly the push most likely to
    // break the build. `existsSync` filtering further down already drops deleted
    // paths before they're handed to tsc/jest as real files — this only affects
    // whether the change is COUNTED, not what gets passed to a tool that needs it
    // to exist.
    for (const f of git(['diff', '--name-only', '--diff-filter=ACMRD', `${base}..${r.localSha}`], { cwd: root }).split('\n')) {
      if (f) files.add(f);
    }
  }
  return [...files];
}

function run(label, cmd, args, { cwd, budgetMs }) {
  const t0 = Date.now();
  log(`${label} …`);
  const r = spawnSync(cmd, args, {
    cwd, stdio: ['ignore', 'inherit', 'inherit'], timeout: budgetMs, killSignal: 'SIGKILL',
    env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (r.error && r.error.code === 'ETIMEDOUT') fail(`${label} exceeded its ${budgetMs / 1000}s budget (this is a slow-machine signal, not a green).`);
  if (r.status !== 0) fail(`${label} FAILED after ${secs}s — fix before pushing.`);
  log(`${label} ok (${secs}s)`);
}

const refs = await readPushedRefs();
if (!refs.length) process.exit(0);

const files = changedFilesForRefs(refs);
const backendFiles = files.filter((f) => isBackendPath(f));
if (!backendFiles.length) { log(`no backend changes in ${files.length} pushed file(s) — skipping.`); process.exit(0); }

const bin = (name) => path.join(backend, 'node_modules', '.bin', name);
if (!existsSync(bin('tsc')) || !existsSync(bin('jest'))) {
  fail(`backend/node_modules is missing or incomplete (${bin('tsc')}). Run \`npm ci\` in backend/ first — this worktree cannot verify what it is about to push.`);
}

// (a) type-check — the ONLY thing that type-checks __tests__ (ts-jest here is isolatedModules)
run('tsc --noEmit (backend)', process.execPath,
  ['--max-old-space-size=6144', path.join(backend, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', path.join(backend, 'tsconfig.json')],
  { cwd: backend, budgetMs: TSC_BUDGET_MS });

// (b) targeted jest
const rel = (f) => path.relative(backend, path.join(root, f));
const { testChanged: testChangedAbs, nonTestChanged: nonTestChangedAbs } = classifyChangedFiles(backendFiles);
const testChanged = testChangedAbs.map(rel).filter((f) => existsSync(path.join(backend, f)));
const nonTestChanged = nonTestChangedAbs.map(rel).filter((f) => existsSync(path.join(backend, f)));

let relatedSuites = null;
if (nonTestChanged.length) {
  const list = spawnSync(process.execPath, ['--max-old-space-size=4096', bin('jest'), '--listTests', '--findRelatedTests', ...nonTestChanged],
    { cwd: backend, encoding: 'utf8', timeout: 60_000 });
  // ENG-1277 / Greptile: fail loud, not silently empty — see evaluateListTestsResult.
  const evaluated = evaluateListTestsResult(list);
  if (!evaluated.ok && evaluated.reason === 'timeout') {
    fail('jest --listTests --findRelatedTests exceeded its 60s budget — cannot determine which suites this change touches.');
  }
  if (!evaluated.ok && evaluated.reason === 'nonzero-exit') {
    fail(`jest --listTests --findRelatedTests failed (exit ${evaluated.status}) — cannot determine which suites this change touches.\n${(list.stderr || '').slice(-2000)}`);
  }
  relatedSuites = evaluated.suites.map((a) => path.relative(backend, a));
}

const { suites, capped, namedMatched } = selectJestSuites({ testChanged, relatedSuites, nonTestChanged, cap: RELATED_CAP });
if (capped) {
  log(`related set is ${relatedSuites.length} suites (> cap ${RELATED_CAP}) — a hub file changed; running ${testChanged.length} directly changed + ${namedMatched.length} name-matched suite(s). CI runs the full suite on ready-flip.`);
}
if (!suites.length) { log('no runnable test files selected; type-check was the gate.'); process.exit(0); }
run(`jest on ${suites.length} suite(s) --bail`, process.execPath,
  ['--max-old-space-size=4096', bin('jest'), ...suites, '--bail', '--silent', '--forceExit', '--maxWorkers=50%'],
  { cwd: backend, budgetMs: JEST_BUDGET_MS });
log('green — pushing.');
