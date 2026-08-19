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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parsePushLine, isBackendPath, resolveBaseSha, classifyChangedFiles, selectJestSuites, evaluateListTestsResult, parseDiffRaw, mergeStatusByPathAcrossRefs, findForeignBackendRefs, basesForDeletedPaths, distinctBasesForDeletedPaths, pathsForBase } from './prepush/logic.mjs';

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
  const refBases = [];
  for (const r of refs) {
    const base = resolveBaseSha(r, {
      commitExists: (sha) => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root }).status === 0,
      mergeBase: (a, b) => {
        const mb = spawnSync('git', ['merge-base', a, b], { cwd: root, encoding: 'utf8' });
        return mb.status === 0 ? mb.stdout.trim() : null;
      },
      parentOf: (sha) => `${sha}~1`,
    });
    refBases.push(base);
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
  // ENG-1277 / Greptile P1: "wrong base restores deleted source" — scope each
  // deleted path's candidate bases to only the refs that actually reported it
  // deleted, not every base from the whole push. See basesForDeletedPaths's
  // doc comment for why an unrelated ref's base can otherwise win.
  const basesForPath = basesForDeletedPaths(refBases, perRefMaps);
  return { statusByPath: merged.statusByPath, basesForPath };
}

// ENG-1277 / Greptile: rounds 5, 7c (x2), and 8 each found a real way for
// deleted-file materialization to escape or race the developer's REAL
// working tree — a symlink follow (twice, once via an ancestor directory and
// once via the deleted path's own final component), a stale base's content
// winning over the correct one, an unconditional revert destroying a
// genuinely concurrent edit, and directory creation happening before the
// containment check that was meant to prevent it. Patching each new shape of
// "something touched the real tree" individually was chasing symptoms of one
// root cause: discovery was writing into a place other things can see and
// touch. Materializing into an ISOLATED, ephemeral `git worktree` instead of
// `backend/` removes the root cause rather than the next symptom — nothing
// else on the machine knows this worktree exists, so there is no concurrent
// process to race and nothing of the developer's to preserve. It is torn
// down unconditionally when the process exits (success, a `fail()`-triggered
// exit, or an uncaught throw), via the `process.on('exit', ...)` handler
// registered below — Node guarantees that fires synchronously for every exit
// path, so no manual try/finally bookkeeping is needed at each call site.
// Tests themselves still run against the REAL, post-deletion `backend/` tree
// afterward, entirely unaffected by any of this — only *discovery* is isolated.
function createIsolatedWorktreeForDiscovery() {
  const rawTmpDir = mkdtempSync(path.join(os.tmpdir(), 'agentweb-prepush-'));
  // Resolve BEFORE removing (while it still exists to resolve): macOS
  // symlinks /tmp -> /private/tmp and /var -> /private/var, so
  // os.tmpdir()'s string form and what a spawned child process reports as
  // its own cwd (which the OS resolves) can differ for the SAME real
  // location. Comparing or `path.relative()`-ing between the two silently
  // produces garbage (a long `../../..` climb back out instead of the
  // short, correct relative path) rather than an error — caught live via a
  // stubbed jest reporting its real `process.cwd()`. Resolve once, use the
  // resolved form everywhere downstream, so every later string comparison
  // and relative-path computation stays valid.
  const tmpDir = realpathSync(rawTmpDir);
  rmdirSync(tmpDir); // `git worktree add` creates its own target directory; it must not already exist.
  const r = spawnSync('git', ['worktree', 'add', '--detach', '--quiet', tmpDir, 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`could not create an isolated worktree for safe test discovery: ${r.stderr}`);
  }
  const cleanup = () => {
    spawnSync('git', ['worktree', 'remove', '--force', tmpDir], { cwd: root });
    spawnSync('git', ['worktree', 'prune'], { cwd: root });
  };
  process.on('exit', cleanup);
  const tmpBackend = path.join(tmpDir, 'backend');
  const realNodeModules = path.join(backend, 'node_modules');
  const tmpNodeModules = path.join(tmpBackend, 'node_modules');
  // node_modules is gitignored in this repo, so a fresh worktree checkout
  // normally never has it — but don't assume that; if the checkout somehow
  // already produced something at that path (an unusual repo state), leave
  // it alone rather than let symlinkSync throw EEXIST.
  if (existsSync(realNodeModules) && !existsSync(tmpNodeModules)) {
    // Symlink the real one in (read-only reuse, no reinstall) so jest can
    // actually run there. This is the ONE symlink the isolated worktree ever
    // has, and it's ours, expected, and points at a known-safe location.
    symlinkSync(realNodeModules, tmpNodeModules, 'dir');
  }
  return { tmpBackend, cleanup };
}

// Writes every deletedNonTest path's content AS OF ONE SPECIFIC BASE into
// the isolated worktree's copy of backend/ (never the real one), so a
// single discoverRelatedSuites pass sees one coherent historical snapshot.
// Keeps the same symlink/containment guards from rounds 5 and 8 as
// defense-in-depth — a fresh checkout would faithfully reproduce a
// git-TRACKED symlink if this repo ever commits one under backend/src (it
// does not today; grep `git ls-files -s backend/src | awk '$1==120000'`) —
// scoped to the isolated worktree's own boundary instead of the real one.
//
// Greptile, ENG-1277, "extra version pass mixes bases across paths": the
// earlier shape materialized each path's OWN recoverable versions
// independently and cycled through them one path at a time, so a
// multi-base push could leave path A on base 2's content while path B sat
// on base 1's — a combination that existed in no real commit, since every
// deleted path shares the SAME local commit across refs (the only real
// divergence is which base recovers it). `pathsForBase` (logic.mjs) makes
// that decision per path for THIS base; a path it puts in `absent` is
// explicitly unlinked here so a PRIOR base's pass never leaks stale content
// into this one, matching the real history at this base — the path
// genuinely predates its addition there, or is otherwise irrelevant.
function materializeDeletedAsOfBase(base, deletedRelPaths, basesForPath, tmpBackend) {
  const { recoverable, absent } = pathsForBase(base, deletedRelPaths, basesForPath);
  for (const relPath of absent) {
    try {
      unlinkSync(path.join(tmpBackend, relPath));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  for (const relPath of recoverable) {
    const absPath = path.join(tmpBackend, relPath);
    let existingEntry = null;
    try {
      existingEntry = lstatSync(absPath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e; // anything other than "nothing there" is a real stat failure, not the expected case.
    }
    if (existingEntry && existingEntry.isSymbolicLink()) {
      throw new Error(`refusing to materialize ${relPath} for test discovery — a symlink already sits at that exact path in the isolated worktree (${absPath}). A fresh checkout should never produce one unless it's git-tracked; investigate before pushing.`);
    }
    const fullPath = path.posix.join('backend', relPath);
    const r = spawnSync('git', ['show', `${base}:${fullPath}`], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) {
      // pathsForBase said this base's ref reported this exact path deleted,
      // so recovering it here should never fail — a real inconsistency, not
      // the expected "predates addition" case (that's already in `absent`).
      throw new Error(`could not recover the pre-deletion content of ${relPath} from base ${base} (recorded as a deleting base for this path) — cannot check for tests that depended on it.`);
    }
    // Check containment BEFORE creating any directories, not after — see the
    // ENG-1277 round-8 "containment check runs too late" fix this preserves.
    const dir = path.dirname(absPath);
    let nearestExisting = dir;
    while (!existsSync(nearestExisting)) {
      const parent = path.dirname(nearestExisting);
      if (parent === nearestExisting) break; // filesystem root — should be unreachable under the worktree's backend/, but never loop forever.
      nearestExisting = parent;
    }
    const realNearestExisting = realpathSync(nearestExisting);
    const realTmpBackend = realpathSync(tmpBackend);
    if (realNearestExisting !== realTmpBackend && !realNearestExisting.startsWith(realTmpBackend + path.sep)) {
      throw new Error(`refusing to materialize ${relPath} for test discovery — its nearest existing ancestor directory (${nearestExisting}) resolves to ${realNearestExisting}, outside the isolated worktree's backend/ (${realTmpBackend}), likely via a git-tracked symlink. Creating directories there would escape it.`);
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(absPath, r.stdout);
    // No revert/restore logic needed: the whole worktree is disposable and
    // exclusively ours, torn down unconditionally by the caller. There is
    // nothing of the developer's to preserve here.
  }
}

// Runs `jest --listTests --findRelatedTests <targets>` and returns suite
// paths relative to `cwd` — fails loud rather than treating a real failure
// as "nothing related" (see evaluateListTestsResult's doc comment).
function discoverRelatedSuites(jestBin, cwd, targets) {
  const list = spawnSync(process.execPath, ['--max-old-space-size=4096', jestBin, '--listTests', '--findRelatedTests', ...targets],
    { cwd, encoding: 'utf8', timeout: 60_000 });
  const evaluated = evaluateListTestsResult(list);
  if (!evaluated.ok && evaluated.reason === 'timeout') {
    fail('jest --listTests --findRelatedTests exceeded its 60s budget — cannot determine which suites this change touches.');
  }
  if (!evaluated.ok && evaluated.reason === 'nonzero-exit') {
    fail(`jest --listTests --findRelatedTests failed (exit ${evaluated.status}) — cannot determine which suites this change touches.\n${(list.stderr || '').slice(-2000)}`);
  }
  return evaluated.suites.map((a) => path.relative(cwd, a));
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

const { statusByPath, basesForPath } = changedFilesForRefs(refs);
const files = Object.keys(statusByPath);
const backendFiles = files.filter((f) => isBackendPath(f));
if (!backendFiles.length) { log(`no backend changes in ${files.length} pushed file(s) — skipping.`); process.exit(0); }

// ENG-1277 / Greptile P1: "dirty tree masks pushed failures" — tsc below (and
// the real suite run) always read the CURRENT WORKING TREE, which this hook
// has always implicitly assumed matches exactly the commit being pushed
// (HEAD) — that assumption was never actually checked. Uncommitted staged or
// unstaged changes under backend/ mean tsc/jest test something OTHER than
// the committed code about to be pushed: an uncommitted local fix can make a
// broken pushed commit pass locally, and unrelated uncommitted breakage can
// wrongly block a valid pushed commit. Refuse rather than verify a tree that
// doesn't match what's actually being pushed.
const dirtyBackend = git(['status', '--porcelain', '--', 'backend'], { cwd: root }).trim();
if (dirtyBackend) {
  fail(`backend/ has uncommitted changes — this hook verifies the CURRENT WORKING TREE, which must exactly match the commit being pushed (HEAD) for that verification to mean anything:\n${dirtyBackend}\nCommit or stash these changes first, then push again, or bypass with --no-verify (CI still checks the actual pushed commit for real).`);
}

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
// never from `existsSync` (filesystem truth) — see parseDiffRaw's doc comment
// for why the filesystem can lie.
const isDeleted = (f) => statusByPath[f] === 'D';
const testChanged = testChangedAbs.filter((f) => !isDeleted(f)).map(rel);
const nonTestChanged = nonTestChangedAbs.filter((f) => !isDeleted(f)).map(rel);
const deletedNonTest = nonTestChangedAbs.filter(isDeleted).map(rel);

let relatedSuites = null;
if (nonTestChanged.length || deletedNonTest.length) {
  // Only deletions need isolation — if nothing is deleted, the real backend/
  // tree is already exactly correct for discovery and nothing is written to
  // it, so there's no reason to pay for a worktree. See
  // createIsolatedWorktreeForDiscovery's doc comment for why deletions do.
  let discoveryCwd = backend;
  let jestBin = bin('jest');
  let wt = null;
  if (deletedNonTest.length) {
    try {
      wt = createIsolatedWorktreeForDiscovery();
    } catch (e) {
      // wt's cleanup (if it was created) runs automatically via its
      // registered `process.on('exit', ...)` handler when fail() exits below.
      fail(e.message);
    }
    discoveryCwd = wt.tmpBackend;
    jestBin = path.join(wt.tmpBackend, 'node_modules', '.bin', 'jest');
  }
  const relatedSet = new Set();
  if (deletedNonTest.length) {
    // ENG-1277 / Greptile: "extra version pass mixes bases across paths" — a
    // multi-ref push (`git push origin HEAD:a HEAD:b`) can resolve `a` and
    // `b` to different bases; every deleted path shares the SAME local
    // commit across refs, so the only real per-ref divergence is which base
    // recovers a given path's pre-deletion content. A coherent historical
    // snapshot is "every deleted path as of the SAME base" — never path A
    // from base 1 mixed with path B from base 2, a combination that existed
    // in no real commit. One discovery pass per distinct base
    // (distinctBasesForDeletedPaths, logic.mjs), each materializing every
    // deletedNonTest path from that single base (materializeDeletedAsOfBase
    // leaves a path absent for a base that never reported it deleted,
    // matching real history), unioning the related suites found. Collapses
    // to exactly one pass for the overwhelming common case — a single-ref
    // push, one base.
    const distinctBases = distinctBasesForDeletedPaths(deletedNonTest, basesForPath);
    if (!distinctBases.length) {
      fail(`could not recover the pre-deletion content of ${deletedNonTest.join(', ')} — no base reports any of them deleted; cannot check for tests that depended on them.`);
    }
    for (const base of distinctBases) {
      try {
        materializeDeletedAsOfBase(base, deletedNonTest, basesForPath, wt.tmpBackend);
      } catch (e) {
        fail(e.message);
      }
      for (const s of discoverRelatedSuites(jestBin, discoveryCwd, [...nonTestChanged, ...deletedNonTest])) relatedSet.add(s);
    }
  } else {
    for (const s of discoverRelatedSuites(jestBin, discoveryCwd, nonTestChanged)) relatedSet.add(s);
  }
  relatedSuites = [...relatedSet];
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
