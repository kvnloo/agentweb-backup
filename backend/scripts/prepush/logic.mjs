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

function basenameOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}
function basenameNoExt(p) {
  const b = basenameOf(p);
  return b.endsWith('.ts') ? b.slice(0, -3) : b;
}
