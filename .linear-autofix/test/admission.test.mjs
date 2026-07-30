// Tests the pure admission-gating + merge-safety helpers (admission.mjs) for ENG-654. All decisions are
// dependency-free, so we import and exercise them directly. Covers: snapshot recorded; withdrawal fires on
// label-removal, Done-mid-run, and reassignment; merge blocked on red CI / no-Greptile / withdrawn
// admission / no-instruction (and nlMergeTrigger honored); test-deletion-only diffs rejected. A separate
// grep asserts no `gh pr merge --admin` / branch-protection bypass anywhere in the pipeline.
// Run: node test/admission.test.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  admitSnapshot, admissionWithdrawal, admissionValid, mergeGateDecision,
  signalSuppressionVerdict, classifyNetDiff, hasForceLabel,
} from '../admission.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const CFG = { forceLabel: 'autofix', fixabilityGate: { blockedLabel: 'autofix:blocked' } };
const issue = (over = {}) => ({
  id: 'uuid-1', identifier: 'ENG-654',
  state: { name: 'In Progress', type: 'started' },
  assignee: { name: 'Manan', email: 'mvarma@x.com' },
  labels: { nodes: [{ name: 'Bug' }, { name: 'autofix' }] },
  ...over,
});

console.log('1. ADMISSION SNAPSHOT');
{
  const snap = admitSnapshot(issue(), '2026-07-30T12:00:00.000Z');
  ok(snap.forceLabel === true, 'forceLabel: true recorded');
  ok(snap.assignee.email === 'mvarma@x.com' && snap.assignee.name === 'Manan', 'assignee captured');
  ok(snap.stateType === 'started', 'stateType captured');
  ok(snap.at === '2026-07-30T12:00:00.000Z', 'at stamped');
  const un = admitSnapshot(issue({ assignee: null }), 't');
  ok(un.assignee === null, 'unassigned pickup → assignee null (no false reassignment later)');
}

console.log('2. WITHDRAWAL ABORT');
{
  const admit = admitSnapshot(issue(), 't0');
  ok(admissionWithdrawal(admit, issue(), CFG).withdrawn === false, 'unchanged issue → not withdrawn');
  ok(admissionValid(admit, issue(), CFG) === true, 'admissionValid true when unchanged');

  // label removed
  const noLabel = issue({ labels: { nodes: [{ name: 'Bug' }] } });
  const w1 = admissionWithdrawal(admit, noLabel, CFG);
  ok(w1.withdrawn && /label/.test(w1.reason), 'force label removed → withdrawn');

  // moved to Done / Canceled / Blocked
  ok(admissionWithdrawal(admit, issue({ state: { name: 'Done', type: 'completed' } }), CFG).withdrawn, 'moved to Done → withdrawn');
  ok(admissionWithdrawal(admit, issue({ state: { name: 'Canceled', type: 'canceled' } }), CFG).withdrawn, 'moved to Canceled → withdrawn');
  ok(admissionWithdrawal(admit, issue({ state: { name: 'Blocked', type: 'started' } }), CFG).withdrawn, 'state NAMED Blocked → withdrawn');
  ok(admissionWithdrawal(admit, issue({ labels: { nodes: [{ name: 'autofix' }, { name: 'autofix:blocked' }] } }), CFG).withdrawn, 'blocked label added → withdrawn');

  // reassigned away
  const reassigned = issue({ assignee: { name: 'Anurag', email: 'aseth@x.com' } });
  ok(admissionWithdrawal(admit, reassigned, CFG).withdrawn, 'reassigned to a different person → withdrawn');
  ok(admissionWithdrawal(admit, issue({ assignee: { email: 'MVARMA@X.com' } }), CFG).withdrawn === false, 'same assignee, different case → NOT withdrawn');

  // fail-safe
  ok(admissionWithdrawal(admit, null, CFG).withdrawn === false, 'absent live issue (transient read) → not withdrawn');
  ok(admissionWithdrawal(null, issue(), CFG).withdrawn === false, 'no admit (legacy/non-forced run) → not withdrawn');
  ok(hasForceLabel(issue(), 'AutoFix') === true, 'hasForceLabel is case-insensitive');
}

console.log('3. MERGE GATE');
{
  const green = { standingMergeInstruction: true, source: 'button', ciGreen: true, greptilePass: true, admissionValid: true };
  ok(mergeGateDecision(green, CFG).allow === true, 'all four gates satisfied → allow');
  ok(mergeGateDecision({ ...green, ciGreen: false }, CFG).allow === false, 'red CI → blocked');
  ok(/CI/.test(mergeGateDecision({ ...green, ciGreen: false }, CFG).blockedReasons.join()), 'red CI reason surfaced');
  ok(mergeGateDecision({ ...green, greptilePass: false }, CFG).allow === false, 'no Greptile pass → blocked');
  ok(mergeGateDecision({ ...green, admissionValid: false }, CFG).allow === false, 'withdrawn admission → blocked');
  ok(mergeGateDecision({ ...green, standingMergeInstruction: false }, CFG).allow === false, 'no standing merge instruction → blocked');

  // nlMergeTrigger honored
  const nl = { ...green, source: 'nl' };
  ok(mergeGateDecision(nl, { ...CFG, chat: { nlMergeTrigger: true } }).allow === true, 'NL instruction allowed when nlMergeTrigger on');
  const off = mergeGateDecision(nl, { ...CFG, chat: { nlMergeTrigger: false } });
  ok(off.allow === false && /nlMergeTrigger/.test(off.blockedReasons.join()), 'NL instruction blocked when nlMergeTrigger off (button-only)');
  ok(mergeGateDecision({ ...green, source: 'button' }, { ...CFG, chat: { nlMergeTrigger: false } }).allow === true, 'button still merges when NL trigger is off');
}

console.log('4. SIGNAL-SUPPRESSION REJECTION');
{
  // test-deletion-only → rejected
  const delOnly = signalSuppressionVerdict([{ path: 'backend/src/__tests__/foo.test.ts', added: 0, removed: 22 }]);
  ok(delOnly.suppressed === true, 'test-deletion-only diff → suppressed (rejected)');
  // skip/only markers added, no product code → rejected
  ok(signalSuppressionVerdict([{ path: 'a.test.ts', added: 1, removed: 0 }], { skipsAdded: 1 }).suppressed, 'added it.skip with no product code → suppressed');
  // silences a reliability signal, no product fix → rejected
  ok(signalSuppressionVerdict([{ path: 'src/monitor.ts', added: 0, removed: 4 }], { reliabilitySignalSilenced: true }).suppressed, 'silenced reliability signal, no fix → suppressed');
  // a REAL fix that also removes an obsolete test → allowed
  ok(signalSuppressionVerdict([{ path: 'src/foo.ts', added: 12, removed: 3 }, { path: 'foo.test.ts', added: 0, removed: 5 }]).suppressed === false, 'real product fix + obsolete-test removal → NOT suppressed');
  // strengthening tests (adds more than it removes) → allowed
  ok(signalSuppressionVerdict([{ path: 'foo.test.ts', added: 20, removed: 4 }]).suppressed === false, 'net-positive test change (strengthening) → NOT suppressed');
  // pure product fix + new tests → allowed
  ok(signalSuppressionVerdict([{ path: 'src/foo.ts', added: 8, removed: 1 }, { path: 'foo.test.ts', added: 15, removed: 0 }]).suppressed === false, 'product fix with new tests → NOT suppressed');
  // classifier splits test vs product correctly
  const c = classifyNetDiff([{ path: 'src/a.ts', added: 3, removed: 1 }, { path: 'a.spec.ts', added: 0, removed: 9 }]);
  ok(c.prodAdded === 3 && c.testRemoved === 9 && c.touchedProd && c.touchedTest, 'classifyNetDiff separates product/test line counts');
}

console.log('5. NO --admin / branch-protection bypass anywhere (criterion 7)');
{
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'test' || e.name.startsWith('tmp-') || e.name === 'logs') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.mjs$/.test(e.name)) files.push(p);
    }
  };
  walk(root);
  // A real merge-bypass would be `gh pr merge ... --admin`. Flag any occurrence that is NOT inside a
  // string that explicitly FORBIDS it (the mergeMsg prompt says "NEVER --admin").
  const offenders = [];
  for (const f of files) {
    for (const [i, line] of readFileSync(f, 'utf8').split('\n').entries()) {
      if (/--admin\b/.test(line) && !/NEVER|never|forbid|do not|don't|no\s+bypass/i.test(line)) {
        offenders.push(`${path.basename(f)}:${i + 1}: ${line.trim().slice(0, 80)}`);
      }
    }
  }
  ok(offenders.length === 0, offenders.length ? `found --admin bypass: ${offenders.join(' | ')}` : 'no `gh pr merge --admin` / bypass in any pipeline .mjs');
}

console.log(fail ? `\n❌ ${fail} failed, ${pass} passed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
