// node --test backend/scripts/prepush/logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZERO,
  parsePushLine,
  isBackendPath,
  resolveBaseSha,
  classifyChangedFiles,
  selectJestSuites,
  evaluateListTestsResult,
  parseDiffRaw,
  mergeStatusByPathAcrossRefs,
} from './logic.mjs';

test('parsePushLine: normal branch push', () => {
  const line = 'refs/heads/swarm/eng-1 abc123 refs/heads/swarm/eng-1 def456';
  assert.deepEqual(parsePushLine(line), {
    localRef: 'refs/heads/swarm/eng-1',
    localSha: 'abc123',
    remoteRef: 'refs/heads/swarm/eng-1',
    remoteSha: 'def456',
  });
});

test('parsePushLine: delete (localSha is all zeros) is skipped', () => {
  const line = `refs/heads/old-branch ${ZERO} refs/heads/old-branch abc123`;
  assert.equal(parsePushLine(line), null);
});

test('parsePushLine: non-branch ref (tag) is skipped', () => {
  const line = 'refs/tags/v1.0.0 abc123 refs/tags/v1.0.0 000000';
  assert.equal(parsePushLine(line), null);
});

test('parsePushLine: blank/malformed line is skipped', () => {
  assert.equal(parsePushLine(''), null);
  assert.equal(parsePushLine('   '), null);
  assert.equal(parsePushLine('refs/heads/x abc123'), null); // only 2 fields
});

test('parsePushLine: new branch on remote (remoteSha is zero) still parses', () => {
  const line = `refs/heads/new-branch abc123 refs/heads/new-branch ${ZERO}`;
  const parsed = parsePushLine(line);
  assert.equal(parsed.remoteSha, ZERO);
  assert.equal(parsed.localSha, 'abc123');
});

test('isBackendPath: matches backend/, tests.yml, eb-deploy.sh', () => {
  assert.equal(isBackendPath('backend/src/foo.ts'), true);
  assert.equal(isBackendPath('.github/workflows/tests.yml'), true);
  assert.equal(isBackendPath('.github/scripts/eb-deploy.sh'), true);
});

test('isBackendPath: does not match portal/landing/unrelated files', () => {
  assert.equal(isBackendPath('agentweb-customer-portal/src/App.tsx'), false);
  assert.equal(isBackendPath('README.md'), false);
  assert.equal(isBackendPath('.github/workflows/deploy.yml'), false); // only tests.yml is named
});

test('resolveBaseSha: known remote SHA diffs from itself', () => {
  const base = resolveBaseSha(
    { remoteSha: 'known123', localSha: 'local456' },
    { commitExists: (sha) => sha === 'known123', mergeBase: () => { throw new Error('should not be called'); }, parentOf: () => { throw new Error('should not be called'); } }
  );
  assert.equal(base, 'known123');
});

test('resolveBaseSha: new branch (ZERO remote) falls back to merge-base with origin/main', () => {
  const base = resolveBaseSha(
    { remoteSha: ZERO, localSha: 'local456' },
    { commitExists: () => { throw new Error('should not be called on ZERO'); }, mergeBase: (a, b) => (a === 'origin/main' && b === 'local456' ? 'mb789' : null), parentOf: () => { throw new Error('should not be called'); } }
  );
  assert.equal(base, 'mb789');
});

test('resolveBaseSha: unknown/unreachable remote SHA falls back to merge-base', () => {
  const base = resolveBaseSha(
    { remoteSha: 'stale-force-pushed-away', localSha: 'local456' },
    { commitExists: () => false, mergeBase: () => 'mb789', parentOf: () => { throw new Error('should not be called'); } }
  );
  assert.equal(base, 'mb789');
});

test('resolveBaseSha: no shared history falls back to parent of local SHA', () => {
  const base = resolveBaseSha(
    { remoteSha: ZERO, localSha: 'local456' },
    { commitExists: () => false, mergeBase: () => null, parentOf: (sha) => `${sha}~1` }
  );
  assert.equal(base, 'local456~1');
});

test('classifyChangedFiles: splits test files from non-test source files', () => {
  const { srcChanged, testChanged, nonTestChanged } = classifyChangedFiles([
    'backend/src/services/fooService.ts',
    'backend/src/services/__tests__/fooService.test.ts',
    'backend/src/__tests__/e2e/skip.test.ts', // still matches the __tests__ regex — counted as a test file
    'backend/package.json', // not under src/ — excluded from srcChanged entirely
  ]);
  assert.deepEqual(testChanged.sort(), [
    'backend/src/__tests__/e2e/skip.test.ts',
    'backend/src/services/__tests__/fooService.test.ts',
  ]);
  assert.ok(nonTestChanged.includes('backend/src/services/fooService.ts'));
  assert.ok(!nonTestChanged.includes('backend/src/services/__tests__/fooService.test.ts'));
  assert.ok(!srcChanged.includes('backend/package.json'));
});

test('classifyChangedFiles: a .d.ts declaration file counts as non-test source (endsWith(".ts") matches it)', () => {
  const { nonTestChanged } = classifyChangedFiles(['backend/src/types.d.ts']);
  assert.deepEqual(nonTestChanged, ['backend/src/types.d.ts']);
});

test('selectJestSuites: no non-test source changes -> only directly changed test files run', () => {
  const { suites, capped } = selectJestSuites({
    testChanged: ['backend/src/a.test.ts'],
    relatedSuites: null,
    nonTestChanged: [],
    cap: 150,
  });
  assert.deepEqual(suites, ['backend/src/a.test.ts']);
  assert.equal(capped, false);
});

test('selectJestSuites: related set under cap is fully included', () => {
  const { suites, capped } = selectJestSuites({
    testChanged: [],
    relatedSuites: ['backend/src/services/__tests__/fooService.test.ts', 'backend/src/services/__tests__/barService.test.ts'],
    nonTestChanged: ['backend/src/services/fooService.ts'],
    cap: 150,
  });
  assert.equal(suites.length, 2);
  assert.equal(capped, false);
});

test('selectJestSuites: related set OVER cap (hub file) falls back to name-matched suites only', () => {
  const related = Array.from({ length: 200 }, (_, i) => `backend/src/services/__tests__/other${i}.test.ts`);
  related.push('backend/src/services/__tests__/agentModeService.test.ts');
  related.push('backend/src/services/__tests__/agentModeService-extra.test.ts');
  const { suites, capped, namedMatched } = selectJestSuites({
    testChanged: [],
    relatedSuites: related,
    nonTestChanged: ['backend/src/services/agentModeService.ts'],
    cap: 150,
  });
  assert.equal(capped, true);
  assert.equal(namedMatched.length, 2);
  assert.deepEqual(suites.sort(), [
    'backend/src/services/__tests__/agentModeService-extra.test.ts',
    'backend/src/services/__tests__/agentModeService.test.ts',
  ]);
  assert.equal(suites.length, 200 - 198); // none of the 200 unrelated "other*" suites survive the cap
});

test('selectJestSuites: directly-changed test files always survive the cap, even for a hub file', () => {
  const related = Array.from({ length: 200 }, (_, i) => `backend/src/services/__tests__/other${i}.test.ts`);
  const { suites } = selectJestSuites({
    testChanged: ['backend/src/services/__tests__/agentModeService.test.ts'],
    relatedSuites: related,
    nonTestChanged: ['backend/src/services/agentModeService.ts'],
    cap: 150,
  });
  assert.ok(suites.includes('backend/src/services/__tests__/agentModeService.test.ts'));
});

// ENG-1277 / Greptile finding: a failed or timed-out `jest --listTests --findRelatedTests`
// must fail loud, never be read as "zero related tests" (which would let an unverified
// push through as if it were safely covered).

test('evaluateListTestsResult: exit 0 with real output -> ok, parsed suites', () => {
  const result = evaluateListTestsResult({
    error: null,
    status: 0,
    stdout: '/repo/backend/src/__tests__/fooService.test.ts\n/repo/backend/src/__tests__/barService.test.ts\n',
  });
  assert.deepEqual(result, {
    ok: true,
    suites: [
      '/repo/backend/src/__tests__/fooService.test.ts',
      '/repo/backend/src/__tests__/barService.test.ts',
    ],
  });
});

test('evaluateListTestsResult: exit 0 with EMPTY output -> ok, zero suites (a genuine "nothing related", not a failure)', () => {
  const result = evaluateListTestsResult({ error: null, status: 0, stdout: '' });
  assert.deepEqual(result, { ok: true, suites: [] });
});

test('evaluateListTestsResult: non-zero exit -> NOT ok, even if stdout happens to be empty', () => {
  const result = evaluateListTestsResult({ error: null, status: 1, stdout: '' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'nonzero-exit');
  assert.equal(result.status, 1);
});

test('evaluateListTestsResult: ETIMEDOUT -> NOT ok, regardless of status/stdout', () => {
  const result = evaluateListTestsResult({
    error: { code: 'ETIMEDOUT' },
    status: null,
    stdout: '',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
});

test('evaluateListTestsResult: a spurious non-.test.ts line in stdout is filtered out, not treated as a suite', () => {
  const result = evaluateListTestsResult({
    error: null,
    status: 0,
    stdout: '/repo/backend/src/__tests__/fooService.test.ts\nsome warning line\n',
  });
  assert.deepEqual(result.suites, ['/repo/backend/src/__tests__/fooService.test.ts']);
});

// ENG-1277 / Greptile P1 #3, #5: classification must come from git (this parser),
// never from the filesystem — an uncommitted file sitting at a git-deleted path
// must not be able to make that path look "still there" — and must carry the
// blob hash, not just a status letter, so two refs that both show `M` on a path
// but leave different content there can still be told apart.

test('parseDiffRaw: parses Added/Modified/Deleted raw lines with blob hashes', () => {
  const out = [
    ':000000 100644 0000000000000000000000000000000000000000 aaa1111 A\tbackend/src/newFile.ts',
    ':100644 100644 bbb2222 bbb3333 M\tbackend/src/changed.ts',
    ':100644 000000 ccc4444 0000000000000000000000000000000000000000 D\tbackend/src/removed.ts',
    '',
  ].join('\n');
  assert.deepEqual(parseDiffRaw(out), {
    'backend/src/newFile.ts': { status: 'A', blob: 'aaa1111' },
    'backend/src/changed.ts': { status: 'M', blob: 'bbb3333' },
    'backend/src/removed.ts': { status: 'D', blob: '0000000000000000000000000000000000000000' },
  });
});

test('parseDiffRaw: empty output -> empty map', () => {
  assert.deepEqual(parseDiffRaw(''), {});
  assert.deepEqual(parseDiffRaw(null), {});
});

test('parseDiffRaw: non-raw lines (blank, or anything not starting with ":") are skipped', () => {
  const out = ':000000 100644 0000000000000000000000000000000000000000 aaa1111 A\tbackend/src/a.ts\n\nsome unrelated line\n';
  assert.deepEqual(parseDiffRaw(out), { 'backend/src/a.ts': { status: 'A', blob: 'aaa1111' } });
});

test('parseDiffRaw: a path containing a tab character is preserved after the first tab', () => {
  // Pathological but shouldn't corrupt parsing: only the FIRST tab separates the meta columns from the path.
  const out = ':100644 100644 bbb2222 bbb3333 M\tbackend/src/weird\tname.ts';
  assert.deepEqual(parseDiffRaw(out), { 'backend/src/weird\tname.ts': { status: 'M', blob: 'bbb3333' } });
});

// ENG-1277 / Greptile P1 #4, #5: a single `git push` can push multiple refs at
// once; their per-ref {status, blob} maps must never be merged via silent
// last-write-wins, and matching STATUS letters alone must not be read as
// agreement — the blob hash is the real proof two refs produce the same content.

test('mergeStatusByPathAcrossRefs: single ref, no conflicts possible -> ok', () => {
  const result = mergeStatusByPathAcrossRefs([
    { 'backend/src/a.ts': { status: 'M', blob: 'aaa' }, 'backend/src/b.ts': { status: 'D', blob: ZERO } },
  ]);
  assert.deepEqual(result, { ok: true, statusByPath: { 'backend/src/a.ts': 'M', 'backend/src/b.ts': 'D' } });
});

test('mergeStatusByPathAcrossRefs: two refs touching disjoint paths -> ok, union', () => {
  const result = mergeStatusByPathAcrossRefs([
    { 'backend/src/a.ts': { status: 'M', blob: 'aaa' } },
    { 'backend/src/b.ts': { status: 'D', blob: ZERO } },
  ]);
  assert.deepEqual(result, { ok: true, statusByPath: { 'backend/src/a.ts': 'M', 'backend/src/b.ts': 'D' } });
});

test('mergeStatusByPathAcrossRefs: two refs agreeing on the same path/status/blob -> ok, not a conflict', () => {
  const result = mergeStatusByPathAcrossRefs([
    { 'backend/src/a.ts': { status: 'M', blob: 'aaa' } },
    { 'backend/src/a.ts': { status: 'M', blob: 'aaa' } },
  ]);
  assert.deepEqual(result, { ok: true, statusByPath: { 'backend/src/a.ts': 'M' } });
});

test('mergeStatusByPathAcrossRefs: two refs assigning DIFFERENT statuses to the same path -> refused, not silently merged', () => {
  const result = mergeStatusByPathAcrossRefs([
    { 'backend/src/a.ts': { status: 'M', blob: 'aaa' }, 'backend/src/shared.ts': { status: 'D', blob: ZERO } },
    { 'backend/src/shared.ts': { status: 'M', blob: 'ddd' }, 'backend/src/c.ts': { status: 'A', blob: 'ccc' } },
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflictingPaths, ['backend/src/shared.ts']);
});

test('mergeStatusByPathAcrossRefs: SAME status but DIFFERENT blob on the same path -> refused (Greptile P1 #5 — this is the case a status-only compare would miss)', () => {
  const result = mergeStatusByPathAcrossRefs([
    { 'backend/src/shared.ts': { status: 'M', blob: 'version-one' } },
    { 'backend/src/shared.ts': { status: 'M', blob: 'version-two' } },
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflictingPaths, ['backend/src/shared.ts']);
});

test('mergeStatusByPathAcrossRefs: two refs that both DELETE the same path trivially agree (both blobs are the zero hash)', () => {
  const result = mergeStatusByPathAcrossRefs([
    { 'backend/src/gone.ts': { status: 'D', blob: ZERO } },
    { 'backend/src/gone.ts': { status: 'D', blob: ZERO } },
  ]);
  assert.deepEqual(result, { ok: true, statusByPath: { 'backend/src/gone.ts': 'D' } });
});

test('mergeStatusByPathAcrossRefs: three refs, only one conflicting path is reported, not the whole set', () => {
  const result = mergeStatusByPathAcrossRefs([
    { 'backend/src/a.ts': { status: 'M', blob: 'a1' }, 'backend/src/x.ts': { status: 'D', blob: ZERO } },
    { 'backend/src/b.ts': { status: 'A', blob: 'b1' }, 'backend/src/x.ts': { status: 'D', blob: ZERO } },
    { 'backend/src/c.ts': { status: 'M', blob: 'c1' }, 'backend/src/x.ts': { status: 'M', blob: 'x1' } },
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflictingPaths, ['backend/src/x.ts']);
});

test('mergeStatusByPathAcrossRefs: no refs -> ok, empty map', () => {
  assert.deepEqual(mergeStatusByPathAcrossRefs([]), { ok: true, statusByPath: {} });
});
