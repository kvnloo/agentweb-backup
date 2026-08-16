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
