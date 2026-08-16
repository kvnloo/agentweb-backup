// Pure decision logic for the pre-push hook (see ../ci-prepush.mjs, ENG-1277).
// No process I/O here — this module exists so the branching that decides what runs
// pre-push can be unit-tested without spawning git/tsc/jest. logic.test.mjs covers it.

export const ZERO = '0000000000000000000000000000000000000000';
export const BACKEND_PREFIXES = ['backend/', '.github/workflows/tests.yml', '.github/scripts/eb-deploy.sh'];

/**
 * Parse one line of the "<local-ref> <local-sha> <remote-ref> <remote-sha>" stdin
 * git feeds a pre-push hook. Returns null for a delete (localSha === ZERO), a
 * non-branch ref (tags etc.), or a malformed/blank line.
 */
export function parsePushLine(line) {
  const parts = (line || '').trim().split(/\s+/);
  if (parts.length !== 4) return null;
  const [localRef, localSha, remoteRef, remoteSha] = parts;
  if (!localRef || !localSha || localSha === ZERO) return null;
  if (!localRef.startsWith('refs/heads/')) return null;
  return { localRef, localSha, remoteRef, remoteSha };
}

/** Does a repo-root-relative path count as a "backend changed" file for this hook? */
export function isBackendPath(filePath, prefixes = BACKEND_PREFIXES) {
  return prefixes.some((p) => filePath.startsWith(p));
}

/**
 * Parse `git diff --no-renames --raw --diff-filter=AMD <a>..<b>` output — lines of
 * the form `:<old-mode> <new-mode> <old-blob> <new-blob> <status><TAB>path` — into
 * a {path: {status, blob}} map. `blob` is the NEW blob's SHA (all-zeros for a
 * deletion, matching git's own convention — two refs that both delete the same
 * path trivially produce the same all-zero blob, so they correctly never conflict
 * without any special-casing). This is the single source of truth for "is this
 * path part of the push, as what kind of change, and resulting in what content"
 * (Greptile P1 #3 and #5, ENG-1277 pre-push hook):
 *   - #3: the caller previously asked the FILESYSTEM (`existsSync`) whether a path
 *     was deleted, which answers a different question than whether the pushed
 *     COMMIT deletes it — an uncommitted file sitting at the same path made
 *     `existsSync` say "still exists" for a path git says is gone.
 *   - #5: a plain status letter (`M`) is not enough to tell whether two refs that
 *     both "modify" the same path actually agree — they could produce entirely
 *     different content while both showing `M`. The blob hash is git's own
 *     content-addressed proof of exactly what a ref leaves at that path; two refs
 *     agree on a path if and only if they produce the same blob there.
 * `--no-renames` guarantees every line is a plain single-path record (a rename
 * becomes an independent D + A rather than one R entry spanning two paths), so
 * parsing never special-cases a two-path line — treating a rename's old path as
 * deleted and its new path as added is exactly the semantics this hook wants.
 */
export function parseDiffRaw(output) {
  const result = {};
  for (const line of (output || '').split('\n')) {
    if (!line || line[0] !== ':') continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const meta = line.slice(1, tab).trim().split(/\s+/);
    if (meta.length < 5) continue;
    const [, , , newBlob, status] = meta;
    result[line.slice(tab + 1)] = { status: status[0], blob: newBlob };
  }
  return result;
}

/**
 * Merge the per-ref {path: {status, blob}} maps from `changedFilesForRefs` (one
 * map per pushed ref — a single `git push` can push several refs at once) into a
 * single {path: status} map, detecting when the SAME path resolves to a DIFFERENT
 * status OR a DIFFERENT resulting blob across different refs (Greptile P1 #4 and
 * #5, ENG-1277 pre-push hook). This hook verifies against ONE shared working
 * tree — it cannot check two different versions of the same path at once — so a
 * plain last-write-wins merge (the original `Object.assign`) would silently apply
 * whichever ref happened to be processed last to BOTH refs' verification: failing
 * a valid push because a path one ref modified looks deleted per the other ref,
 * discovering related tests from stale content instead of the actually-changed
 * content, or — the narrower #5 case — accepting two refs that both show `M` on a
 * path while actually producing different content, since a status-only compare
 * can't tell those apart. Comparing the blob hash closes that gap: two refs that
 * genuinely agree on a path always produce the identical blob for it. Returns
 * `{ok:false, conflictingPaths}` rather than guessing, so the caller can fail loud
 * instead of silently picking a version.
 */
export function mergeStatusByPathAcrossRefs(perRefMaps) {
  const seenByPath = {};
  for (const map of perRefMaps) {
    for (const [p, entry] of Object.entries(map)) {
      (seenByPath[p] ??= new Map()).set(`${entry.status}:${entry.blob}`, entry.status);
    }
  }
  const conflictingPaths = Object.keys(seenByPath).filter((p) => seenByPath[p].size > 1);
  if (conflictingPaths.length) return { ok: false, conflictingPaths };
  const statusByPath = {};
  for (const p of Object.keys(seenByPath)) statusByPath[p] = [...seenByPath[p].values()][0];
  return { ok: true, statusByPath };
}

/**
 * For each path some ref reports Deleted, record ONLY the base(s) of the
 * ref(s) that actually reported that deletion (Greptile P1, ENG-1277 pre-push
 * hook: "wrong base restores deleted source"). `materializeDeletedForDiscovery`
 * previously tried every base from the WHOLE push (a flat Set, one entry per
 * pushed ref) for every deleted path, in Set-iteration order, and took the
 * first `git show <base>:<path>` that succeeded. In a multi-ref push where a
 * ref unrelated to a given deletion (e.g. a docs-only ref) happens to have
 * its OWN base resolve to a totally different commit that coincidentally also
 * has a file at that same path, that unrelated base could be tried first and
 * "win" — recovering the wrong historical content and making
 * `--findRelatedTests` resolve the wrong import graph, potentially missing
 * suites that actually cover the real deletion. Scoping candidate bases to
 * only the refs that actually deleted a given path closes that gap.
 */
export function basesForDeletedPaths(refBases, perRefMaps) {
  const result = {};
  perRefMaps.forEach((map, i) => {
    for (const [p, entry] of Object.entries(map)) {
      if (entry.status === 'D') {
        (result[p] ??= []).push(refBases[i]);
      }
    }
  });
  for (const p of Object.keys(result)) result[p] = [...new Set(result[p])];
  return result;
}

/**
 * Identify pushed refs that are NOT the currently checked-out HEAD but still
 * touch a backend path (Greptile finding, ENG-1277 pre-push hook, round 5b,
 * ci-prepush.mjs:88-90). tsc/jest in this hook always run against the CURRENT
 * WORKING TREE on disk, which reflects only whatever branch is actually
 * checked out — `git diff` can compute a ref's changes without checking it
 * out, but tsc/jest cannot verify content they never see. A single
 * `git push origin branch-B` while sitting on a different branch is enough to
 * hit this (no second ref needed): branch-B's diff is computed correctly, but
 * whatever tsc/jest actually read at each of branch-B's changed paths is
 * whatever the CHECKED-OUT branch has there instead — a different version of
 * the same path, or nothing at all if the path doesn't exist on the checked-
 * out branch. The hook cannot safely verify a ref it cannot check out, so it
 * refuses rather than silently passing on the wrong tree.
 */
export function findForeignBackendRefs(refs, perRefMaps, currentHeadSha, prefixes = BACKEND_PREFIXES) {
  return refs
    .filter((r, i) => r.localSha !== currentHeadSha && Object.keys(perRefMaps[i] || {}).some((p) => isBackendPath(p, prefixes)))
    .map((r) => r.localRef);
}

/**
 * Decide the base SHA to diff a ref against.
 *   - A known remote SHA (already on the remote, commitExists(remoteSha) true) diffs from itself.
 *   - A new branch (remoteSha === ZERO) or an unknown/unreachable remote SHA (force-pushed history,
 *     a shallow clone that never fetched it) falls back to the merge-base with origin/main.
 *   - If even that fails (e.g. no shared history — degenerate/test repo), diffs against the parent
 *     of the local SHA so the hook still runs on *something* rather than throwing.
 * `commitExists` / `mergeBase` / `parentOf` are injected so this is testable without real git.
 */
export function resolveBaseSha({ remoteSha, localSha }, { commitExists, mergeBase, parentOf }) {
  if (remoteSha && remoteSha !== ZERO && commitExists(remoteSha)) return remoteSha;
  const mb = mergeBase('origin/main', localSha);
  if (mb) return mb;
  return parentOf(localSha);
}

/**
 * Split changed backend files into: test files (already .test.ts under __tests__) and
 * non-test source files (candidates for --findRelatedTests).
 */
export function classifyChangedFiles(backendFiles) {
  const srcChanged = backendFiles.filter((f) => f.startsWith('backend/src/') && f.endsWith('.ts'));
  const testChanged = srcChanged.filter((f) => /__tests__\/.*\.test\.ts$/.test(f));
  const nonTestChanged = srcChanged.filter((f) => !/__tests__\//.test(f));
  return { srcChanged, testChanged, nonTestChanged };
}

/**
 * Pick the jest suites to run pre-push: directly changed .test.ts files, plus
 * findRelatedTests(changed src) UNLESS the related set exceeds `cap` (a hub file like
 * agentModeService.ts relates roughly half the suite — see ENG-129, the autofix runner hit the
 * same wall and dropped findRelatedTests for the same reason). Above the cap, fall back to
 * suites whose basename matches one of the changed files' stems (services/fooService.ts names
 * fooService.test.ts), which is where a broken change shows up first, and report the cap hit so
 * the caller can log it — CI still runs the full suite on the ready-flip regardless.
 */
export function selectJestSuites({ testChanged, relatedSuites, nonTestChanged, cap }) {
  const suites = new Set(testChanged);
  if (!nonTestChanged.length || !relatedSuites) return { suites: [...suites], capped: false, namedMatched: [] };
  if (relatedSuites.length <= cap) {
    relatedSuites.forEach((s) => suites.add(s));
    return { suites: [...suites], capped: false, namedMatched: [] };
  }
  const stems = nonTestChanged.map((f) => basenameNoExt(f).toLowerCase());
  const namedMatched = relatedSuites.filter((s) => {
    const b = basenameOf(s).toLowerCase();
    return stems.some((st) => b.startsWith(`${st}.`) || b.startsWith(`${st}-`) || b === `${st}.test.ts`);
  });
  namedMatched.forEach((s) => suites.add(s));
  return { suites: [...suites], capped: true, namedMatched };
}

/**
 * Classify the result of `jest --listTests --findRelatedTests <files>` (a spawnSync
 * result shape: {error, status, stdout}). Distinguishes "genuinely nothing related"
 * (exit 0, possibly empty stdout — verified live: jest exits 0 even for a file with
 * zero related tests) from "jest could not answer" (non-zero exit, or a timeout
 * surfaced as `error.code === 'ETIMEDOUT'`), which must fail loud rather than be
 * silently read as an empty — and therefore trivially safe — related set (Greptile
 * review on ENG-1277's pre-push hook PR: a failed/timed-out discovery previously fell
 * through to "empty successful output", one of two reported verification bypasses).
 */
export function evaluateListTestsResult({ error, status, stdout }) {
  if (error && error.code === 'ETIMEDOUT') {
    return { ok: false, reason: 'timeout' };
  }
  if (status !== 0) {
    return { ok: false, reason: 'nonzero-exit', status };
  }
  const suites = (stdout || '').split('\n').filter((l) => l.endsWith('.test.ts'));
  return { ok: true, suites };
}

function basenameOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}
function basenameNoExt(p) {
  const b = basenameOf(p);
  return b.endsWith('.ts') ? b.slice(0, -3) : b;
}
