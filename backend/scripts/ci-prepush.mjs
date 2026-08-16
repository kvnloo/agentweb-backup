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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  const bases = new Set();
  for (const r of refs) {
    const base = resolveBaseSha(r, {
      commitExists: (sha) => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root }).status === 0,
      mergeBase: (a, b) => {
        const mb = spawnSync('git', ['merge-base', a, b], { cwd: root, encoding: 'utf8' });
        return mb.status === 0 ? mb.stdout.trim() : null;
      },
      parentOf: (sha) => `${sha}~1`,
    });
    bases.add(base);
    // ENG-1277 / Greptile P1: ACMRD, not ACMR — a deletion-only push (e.g. removing a
    // source file something else still imports) must still be classified as a
    // backend change, or the hook's own "no backend changes — skipping" short
    // circuit below silently skips tsc/jest for exactly the push most likely to
    // break the build.
    for (const f of git(['diff', '--name-only', '--diff-filter=ACMRD', `${base}..${r.localSha}`], { cwd: root }).split('\n')) {
      if (f) files.add(f);
    }
  }
  return { files: [...files], bases: [...bases] };
}

// ENG-1277 / Greptile P1 #2: a deleted source file is dropped from `nonTestChanged`
// (it fails `existsSync`) before `--findRelatedTests` runs, so tests that depended on
// its behavior — and would catch a regression TypeScript can't see (e.g. a
// side-effect-only `import './handler'` that registers something at runtime) — never
// get discovered or run. jest's `--findRelatedTests` needs the file to exist on disk
// to resolve who imports it, so this materializes the file's PRE-deletion content
// (via `git show <base>:<path>`) back at its real path just long enough for jest to
// compute relatedness, then removes it again before any test actually executes —
// tests still run against the true, post-deletion tree, only *discovery* sees the
// old file. Returns the temp-restored paths so the caller can clean them up even if
// something downstream throws.
function materializeDeletedForDiscovery(deletedRelPaths, bases) {
  const restored = [];
  try {
    for (const relPath of deletedRelPaths) {
      const absPath = path.join(backend, relPath);
      let content = null;
      for (const base of bases) {
        const r = spawnSync('git', ['show', `${base}:${path.posix.join('backend', relPath)}`], { cwd: root, encoding: 'utf8' });
        if (r.status === 0) { content = r.stdout; break; }
      }
      if (content === null) {
        // Could not recover pre-deletion content from any resolved base. Throw
        // (not `fail()`, which exits immediately) so the catch below can clean up
        // any files THIS loop already restored before this one failed — leaving a
        // half-restored temp file behind on a failed push would pollute the
        // developer's working tree with an untracked file they never created.
        throw new Error(`could not recover the pre-deletion content of ${relPath} from any base commit (tried: ${bases.join(', ')}) — cannot check for tests that depended on it.`);
      }
      mkdirSync(path.dirname(absPath), { recursive: true });
      writeFileSync(absPath, content);
      restored.push(absPath);
    }
  } catch (e) {
    for (const p of restored) rmSync(p, { force: true });
    fail(e.message);
  }
  return restored;
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

const { files, bases } = changedFilesForRefs(refs);
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
const nonTestChangedAll = nonTestChangedAbs.map(rel);
const nonTestChanged = nonTestChangedAll.filter((f) => existsSync(path.join(backend, f)));
// ENG-1277 / Greptile P1 #2: files classified as backend/non-test but absent on disk
// were DELETED by this push (not renamed — renames are their own diff entries and
// still exist post-rename). See materializeDeletedForDiscovery above.
const deletedNonTest = nonTestChangedAll.filter((f) => !existsSync(path.join(backend, f)));

let relatedSuites = null;
if (nonTestChanged.length || deletedNonTest.length) {
  const restoredPaths = materializeDeletedForDiscovery(deletedNonTest, bases);
  let list;
  try {
    list = spawnSync(process.execPath, ['--max-old-space-size=4096', bin('jest'), '--listTests', '--findRelatedTests', ...nonTestChanged, ...deletedNonTest],
      { cwd: backend, encoding: 'utf8', timeout: 60_000 });
  } finally {
    // Discovery is the only step allowed to see the pre-deletion content — the tests
    // themselves must run against the real, post-deletion tree. Clean up even if the
    // spawnSync above threw.
    for (const p of restoredPaths) rmSync(p, { force: true });
  }
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

const { suites, capped, namedMatched } = selectJestSuites({ testChanged, relatedSuites, nonTestChanged: [...nonTestChanged, ...deletedNonTest], cap: RELATED_CAP });
if (capped) {
  log(`related set is ${relatedSuites.length} suites (> cap ${RELATED_CAP}) — a hub file changed; running ${testChanged.length} directly changed + ${namedMatched.length} name-matched suite(s). CI runs the full suite on ready-flip.`);
}
if (!suites.length) { log('no runnable test files selected; type-check was the gate.'); process.exit(0); }
run(`jest on ${suites.length} suite(s) --bail`, process.execPath,
  ['--max-old-space-size=4096', bin('jest'), ...suites, '--bail', '--silent', '--forceExit', '--maxWorkers=50%'],
  { cwd: backend, budgetMs: JEST_BUDGET_MS });
log('green — pushing.');
