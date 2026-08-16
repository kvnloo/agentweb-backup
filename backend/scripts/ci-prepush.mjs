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
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parsePushLine, isBackendPath, resolveBaseSha, classifyChangedFiles, selectJestSuites, evaluateListTestsResult, parseDiffRaw, mergeStatusByPathAcrossRefs, findForeignBackendRefs } from './prepush/logic.mjs';

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
  const perRefMaps = [];
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
    // ENG-1277 / Greptile P1 #1, #3, #5: `--raw`, not `--name-only`, and
    // `--diff-filter=AMD` (Added/Modified/Deleted — C requires an explicit
    // --find-copies flag we don't pass, so it can never appear; R is excluded by
    // --no-renames below). `--raw` carries the blob hash alongside the status
    // letter — see parseDiffRaw's doc comment for why both matter: the status
    // letter makes classification git-truth-based instead of filesystem-truth-
    // based (a deletion-only push must still be classified as a backend change,
    // or the hook's own "no backend changes — skipping" short circuit silently
    // skips tsc/jest for exactly the push most likely to break the build), and the
    // blob hash is what lets a multi-ref push detect two refs that both show `M`
    // on a path while actually leaving different content there.
    const out = git(['diff', '--no-renames', '--raw', '--diff-filter=AMD', `${base}..${r.localSha}`], { cwd: root });
    perRefMaps.push(parseDiffRaw(out));
  }
  // ENG-1277 / Greptile round 5b: tsc/jest below only ever read the CURRENT
  // checked-out working tree — a ref that isn't HEAD can be diffed (git diff
  // needs no checkout) but can never actually be verified by them. Refuse
  // before running anything, rather than silently checking the checked-out
  // ref's content in place of the foreign ref's real, pushed content. See
  // findForeignBackendRefs's doc comment for why one non-checked-out ref is
  // already enough to trigger this — no second ref required.
  const currentHeadSha = git(['rev-parse', 'HEAD'], { cwd: root }).trim();
  const foreignRefs = findForeignBackendRefs(refs, perRefMaps, currentHeadSha);
  if (foreignRefs.length) {
    fail(`pushing ${foreignRefs.join(', ')} — not the currently checked-out ref — is not supported by this hook when it touches backend/: tsc and jest below only ever read the checked-out working tree, so a non-checked-out ref's actual content is never what gets verified. Checkout and push that ref on its own (\`git checkout <ref> && git push origin <ref>\`), or bypass with --no-verify (CI still checks it for real on its own head).`);
  }
  // ENG-1277 / Greptile P1 #4: merge per-ref maps through a conflict-detecting
  // merge, not `Object.assign` — a single `git push` can push multiple refs, and
  // if two of them assign different statuses to the same path, last-write-wins
  // would silently verify the wrong ref's version of that path (or none of them).
  // See mergeStatusByPathAcrossRefs's doc comment for the full reasoning.
  const merged = mergeStatusByPathAcrossRefs(perRefMaps);
  if (!merged.ok) {
    fail(`pushing multiple refs in one \`git push\` with different changes to the same path is not supported by this hook — it verifies against a single shared working tree and cannot check two different versions of the same path at once: ${merged.conflictingPaths.join(', ')}. Push these refs separately (one \`git push origin <ref>\` at a time), or bypass with --no-verify (CI still checks each ref for real on its own head).`);
  }
  return { statusByPath: merged.statusByPath, bases: [...bases] };
}

// ENG-1277 / Greptile P1 #2 and #3: a deleted source file must still have its
// dependent tests discovered — jest's `--findRelatedTests` needs the file to exist
// on disk to resolve who imports it, so this materializes the file's PRE-deletion
// content (via `git show <base>:<path>`) back at its real path just long enough for
// jest to compute relatedness, then reverts the path to its exact pre-call state —
// removed if nothing was there, restored byte-for-byte if something was — before
// any test actually executes. Reverting rather than unconditionally deleting matters
// because the path being git-truth-"deleted" does not mean the path is empty on
// disk: an uncommitted file having nothing to do with this push could legitimately
// sit there (leftover scratch work, a stale build artifact, anything), and this must
// never destroy it — only borrow the path for the duration of discovery. Tests
// themselves still run against the true, post-deletion tree; only *discovery* sees
// the old file. Returns revert callbacks so the caller can restore correctly even if
// something downstream throws.
function materializeDeletedForDiscovery(deletedRelPaths, bases) {
  const revert = [];
  const revertAll = () => { while (revert.length) revert.pop()(); };
  try {
    for (const relPath of deletedRelPaths) {
      const absPath = path.join(backend, relPath);
      // ENG-1277 / Greptile: the directory-containment check below only covers
      // path.dirname(absPath) — an ancestor. It says nothing about absPath's
      // OWN final path component. If a symlink sits at the exact deleted path
      // (not one of its ancestors), the directory check passes cleanly (the
      // directory itself is real and contained) while writeFileSync still
      // follows that final symlink and writes through it — to an existing
      // external file (silently overwriting it, "restored" on revert by
      // writing the external file's own prior content back, which is still a
      // real write to something outside the repo in between), or, worse, to a
      // DANGLING symlink's target: writeFileSync's open() follows the link and
      // creates a brand-new file at the external, nonexistent target, but the
      // revert path only knows to `rmSync` the symlink itself (POSIX unlink
      // never follows a symlink to remove its target) — leaving that newly
      // created external file permanently orphaned once the symlink pointing
      // to it is gone. `lstatSync` (unlike `existsSync`/`statSync`) does not
      // follow the final symlink, so it sees the symlink itself regardless of
      // whether its target exists — refuse outright rather than write through
      // it: a legitimately git-deleted path should have nothing sitting there
      // at all, so anything already there (let alone a symlink) is foreign.
      let existingEntry = null;
      try {
        existingEntry = lstatSync(absPath);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e; // anything other than "nothing there" is a real stat failure, not the expected case.
      }
      if (existingEntry && existingEntry.isSymbolicLink()) {
        throw new Error(`refusing to materialize ${relPath} for test discovery — a symlink already sits at that exact path (${absPath}). Writing through it could overwrite or create content outside the repository, and cleanup cannot safely undo that for a dangling symlink. Remove the stray symlink before pushing, or bypass with --no-verify.`);
      }
      const hadLocalContent = existsSync(absPath);
      const localContent = hadLocalContent ? readFileSync(absPath) : null;
      let content = null;
      for (const base of bases) {
        const r = spawnSync('git', ['show', `${base}:${path.posix.join('backend', relPath)}`], { cwd: root, encoding: 'utf8' });
        if (r.status === 0) { content = r.stdout; break; }
      }
      if (content === null) {
        // Could not recover pre-deletion content from any resolved base. Throw
        // (not `fail()`, which exits immediately) so the catch below can revert
        // any paths THIS loop already touched before this one failed — leaving a
        // half-materialized path behind on a failed push would either pollute the
        // developer's working tree with an untracked file they never created, or
        // worse, leave their own pre-existing file overwritten.
        throw new Error(`could not recover the pre-deletion content of ${relPath} from any base commit (tried: ${bases.join(', ')}) — cannot check for tests that depended on it.`);
      }
      mkdirSync(path.dirname(absPath), { recursive: true });
      // ENG-1277 / Greptile P1 #5: refuse to write outside the repo. If the
      // deleted path's directory (or an ancestor of it) is a symlink pointing
      // outside `backend/` — a real pattern in THIS repo's own worktree setup,
      // where `backend/node_modules` is routinely symlinked into a different
      // worktree entirely (ENG-731) — `writeFileSync` would silently follow it
      // and overwrite a file outside the repository, and the later revert could
      // then rewrite or delete that external file too. `mkdirSync` above already
      // ran, so the directory chain exists; verify its REAL path resolves inside
      // `backend/`'s real path before writing anything into it.
      const dir = path.dirname(absPath);
      const realDir = realpathSync(dir);
      const realBackend = realpathSync(backend);
      if (realDir !== realBackend && !realDir.startsWith(realBackend + path.sep)) {
        throw new Error(`refusing to materialize ${relPath} for test discovery — its directory resolves to ${realDir}, outside backend/ (${realBackend}), likely via a symlink in its ancestry. Writing there would escape the repository.`);
      }
      writeFileSync(absPath, content);
      revert.push(hadLocalContent
        ? () => writeFileSync(absPath, localContent)
        : () => rmSync(absPath, { force: true }));
    }
  } catch (e) {
    revertAll();
    fail(e.message);
  }
  return revertAll;
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

const { statusByPath, bases } = changedFilesForRefs(refs);
const files = Object.keys(statusByPath);
const backendFiles = files.filter((f) => isBackendPath(f));
if (!backendFiles.length) { log(`no backend changes in ${files.length} pushed file(s) — skipping.`); process.exit(0); }

// ENG-1277 / Greptile P1 #3: a path git says is Added/Modified (not Deleted) but is
// missing from the working tree means the tree does not match what's about to be
// pushed — fail loud rather than let tsc/jest silently verify a smaller set than
// what's actually being pushed. This is the mirror image of the deletion fix: that
// one stops the filesystem from hiding a real deletion; this one stops the
// filesystem from hiding a real addition/modification.
const missingButNotDeleted = backendFiles.filter((f) => statusByPath[f] !== 'D' && !existsSync(path.join(root, f)));
if (missingButNotDeleted.length) {
  fail(`these paths are Added/Modified per the pushed commit(s) but missing from the working tree — cannot verify against a tree that doesn't match what you're about to push: ${missingButNotDeleted.join(', ')}`);
}

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
// ENG-1277 / Greptile P1 #3: deleted-ness comes from `statusByPath` (git truth),
// never from `existsSync` (filesystem truth) — see parseDiffNameStatus and
// materializeDeletedForDiscovery's doc comments for why the filesystem can lie.
const isDeleted = (f) => statusByPath[f] === 'D';
const testChanged = testChangedAbs.filter((f) => !isDeleted(f)).map(rel);
const nonTestChanged = nonTestChangedAbs.filter((f) => !isDeleted(f)).map(rel);
const deletedNonTest = nonTestChangedAbs.filter(isDeleted).map(rel);

let relatedSuites = null;
if (nonTestChanged.length || deletedNonTest.length) {
  const revertMaterialized = materializeDeletedForDiscovery(deletedNonTest, bases);
  let list;
  try {
    list = spawnSync(process.execPath, ['--max-old-space-size=4096', bin('jest'), '--listTests', '--findRelatedTests', ...nonTestChanged, ...deletedNonTest],
      { cwd: backend, encoding: 'utf8', timeout: 60_000 });
  } finally {
    // Discovery is the only step allowed to see the pre-deletion content — the tests
    // themselves must run against the real, post-deletion tree. Revert even if the
    // spawnSync above threw.
    revertMaterialized();
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
