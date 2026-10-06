// Tests for the env_down recovery path (ENG-1324).
// A failed per-bug preview must not silently downgrade a fix to "needs manual test" with
// no way back to automated verification: every env_down report names the exact
// --verify-only command that re-runs the deterministic gates on the fixed branch.
// Run: node --test .linear-autofix/test/env-down-recovery.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { envDownRecovery, verifyGateLine } from '../autofix.mjs';

test('env_down recovery names the --verify-only rerun for the exact issue', () => {
  const r = envDownRecovery('ENG-1188');
  assert.match(r, /node \.linear-autofix\/autofix\.mjs ENG-1188 --verify-only/);
  assert.match(r, /eng-1188-\*\.log/);
});

test('PR gate line for env_down includes the recovery command', () => {
  const line = verifyGateLine({ verdict: 'env_down' }, 'ENG-1188');
  assert.match(line, /environment down \(not verified\)/);
  assert.match(line, /ENG-1188 --verify-only/);
});

test('PR gate line for other verdicts is unchanged and carries no recovery hint', () => {
  assert.equal(verifyGateLine({ verdict: 'verified' }, 'ENG-1'), 'Browser verify: ✅ verified');
  assert.equal(verifyGateLine({ verdict: 'not_fixed' }, 'ENG-1'), 'Browser verify: ❌ not fixed');
  assert.equal(verifyGateLine({ verdict: 'inconclusive' }, 'ENG-1'), 'Browser verify: ❓ inconclusive');
  assert.equal(verifyGateLine(null, 'ENG-1'), null);
});
