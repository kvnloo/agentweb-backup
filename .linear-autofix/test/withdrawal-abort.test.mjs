// Tests the in-flight abort ORCHESTRATION (gc.mjs abortWithdrawnInFlight) for ENG-654 — the layer that
// turns an admissionWithdrawal decision into: comment + kill/teardown + drop the state entry. All external
// effects (Linear resolve/comment, lock probe, kill, teardown) are injected, and it reads/writes a TEMP
// state file, so nothing real is touched. Run: node test/withdrawal-abort.test.mjs
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { abortWithdrawnInFlight } from '../gc.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const dir = mkdtempSync(path.join(tmpdir(), 'wabort-'));
const statePath = path.join(dir, 'state.json');
const admit = { forceLabel: true, assignee: { name: 'Manan', email: 'm@x.com' }, stateType: 'started', at: 't0' };
const withdrawn = { id: 'U1', identifier: 'ENG-654', state: { name: 'Done', type: 'completed' }, assignee: { email: 'm@x.com' }, labels: { nodes: [{ name: 'autofix' }] } };
const stillAdmitted = { id: 'U1', identifier: 'ENG-654', state: { name: 'In Progress', type: 'started' }, assignee: { email: 'm@x.com' }, labels: { nodes: [{ name: 'autofix' }] } };
const seed = (entry) => writeFileSync(statePath, JSON.stringify({ U1: entry }, null, 2));
const loadEntry = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')).U1; } catch { return undefined; } };
const base = (over) => ({ statePathOverride: statePath, log: () => {}, ...over });

console.log('orphaned run (no live lock) → teardown + drop');
{
  seed({ identifier: 'ENG-654', outcome: 'started', admit });
  const calls = { comment: 0, kill: 0, teardown: [] };
  const aborted = await abortWithdrawnInFlight(base({
    resolveIssue: async () => withdrawn,
    lockActive: () => false,
    comment: async () => { calls.comment++; },
    kill: () => { calls.kill++; },
    teardown: (id) => { calls.teardown.push(id); },
  }));
  ok(aborted.join() === 'ENG-654', 'aborted list contains ENG-654');
  ok(calls.teardown.join() === 'ENG-654' && calls.kill === 0, 'tore the worktree down (no kill — nothing alive)');
  ok(calls.comment === 1, 'posted the "admission withdrawn — aborted" comment');
  ok(loadEntry() === undefined, 'state entry dropped');
}

console.log('live pipeline holder → SIGTERM the pid (handler tears down), drop');
{
  seed({ identifier: 'ENG-654', outcome: 'started', admit });
  const calls = { kill: [], teardown: 0 };
  await abortWithdrawnInFlight(base({
    resolveIssue: async () => withdrawn,
    lockActive: () => true,
    pipelinePid: () => 4242,
    comment: async () => {},
    kill: (pid) => { calls.kill.push(pid); },
    teardown: () => { calls.teardown++; },
  }));
  ok(calls.kill.join() === '4242', 'SIGTERM sent to the pipeline pid');
  ok(calls.teardown === 0, 'gc does NOT teardown a live pipeline run (its own handler does)');
  ok(loadEntry() === undefined, 'state entry dropped');
}

console.log('non-pipeline holder (chat turn) → DEFER: no kill, no teardown, keep entry');
{
  seed({ identifier: 'ENG-654', outcome: 'started', admit });
  const calls = { kill: 0, teardown: 0 };
  const aborted = await abortWithdrawnInFlight(base({
    resolveIssue: async () => withdrawn,
    lockActive: () => true,
    pipelinePid: () => null, // e.g. the chat server holds the lock — must never be signalled
    comment: async () => {},
    kill: () => { calls.kill++; },
    teardown: () => { calls.teardown++; },
  }));
  ok(aborted.length === 0 && calls.kill === 0 && calls.teardown === 0, 'deferred — never kills the server or yanks its worktree');
  ok(loadEntry() !== undefined, 'state entry kept for the run/chat to self-abort');
}

console.log('label removed mid-run → aborts');
{
  seed({ identifier: 'ENG-654', outcome: 'started', admit });
  const aborted = await abortWithdrawnInFlight(base({
    resolveIssue: async () => ({ ...stillAdmitted, labels: { nodes: [{ name: 'Bug' }] } }), // force label gone
    lockActive: () => false, comment: async () => {}, teardown: () => {},
  }));
  ok(aborted.join() === 'ENG-654', 'label-removal is a withdrawal → aborted');
}

console.log('still admitted → nothing aborted');
{
  seed({ identifier: 'ENG-654', outcome: 'started', admit });
  const aborted = await abortWithdrawnInFlight(base({ resolveIssue: async () => stillAdmitted, lockActive: () => false, teardown: () => {} }));
  ok(aborted.length === 0 && loadEntry() !== undefined, 'healthy admitted run is left alone');
}

console.log('legacy entry without admit → skipped');
{
  seed({ identifier: 'ENG-654', outcome: 'started' }); // no admit
  let resolved = false;
  const aborted = await abortWithdrawnInFlight(base({ resolveIssue: async () => { resolved = true; return withdrawn; }, lockActive: () => false, teardown: () => {} }));
  ok(aborted.length === 0 && resolved === false, 'non-admitted (legacy) run is never touched');
}

console.log('terminal entry (already fixed) → not treated as in-flight');
{
  seed({ identifier: 'ENG-654', outcome: 'fixed', admit });
  const aborted = await abortWithdrawnInFlight(base({ resolveIssue: async () => withdrawn, lockActive: () => false, teardown: () => {} }));
  ok(aborted.length === 0, 'a terminal outcome is left for the normal reap, not aborted');
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n❌ ${fail} failed, ${pass} passed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
