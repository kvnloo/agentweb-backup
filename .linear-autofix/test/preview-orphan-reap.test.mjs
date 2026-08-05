// Tests for the orphan-preview-process reaper (orphanPreviewProcs).
//
// The reconciler clears stale preview STATE; this reaps the processes that state forgot. A preview can
// be restarted (or half-restarted) leaving an earlier generation running: still holding its RAM, still
// bound to ports, but recorded nowhere, so nothing will ever stop it. Measured live on 2026-08-05 —
// ENG-845 had TEN such processes 3.9 hours old holding 2498MB, including a 1.7GB worker, serving
// 31100/52100/51100 while state.json recorded 31102/52102/51101 and routes.json had dropped the bug
// entirely. That is dead weight on a box whose whole failure mode is running out of memory.
//
// This is a destructive sweep, so nearly all of these tests are about what it must NOT kill. The live
// near-miss that shaped it: ENG-845 was LOCKED with two active claude turns, and one of those turns had
// its own `ts-node --transpile-only -O {...}` running, 76 seconds old. Matching on worktree path alone
// would have killed an agent's in-flight build. Shape + age is what makes it safe.
// Run: node test/preview-orphan-reap.test.mjs
import { orphanPreviewProcs, reapOrphanPreviewProcs } from '../preview/policy.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const ROOT = '/home/ec2-user/autofix-worktrees';
const WT = (bug) => `${ROOT}/${bug.toUpperCase()}`;
// Real command lines, copied from the live box.
const BACKEND = (bug) => `node ${WT(bug)}/backend/node_modules/.bin/ts-node --transpile-only src/server.ts`;
const VITE = (port) => `npm exec vite preview --port ${port} --strictPort`;
const VITE_NODE = (bug, port) => `node ${WT(bug)}/customer-portal/node_modules/.bin/vite preview --port ${port} --strictPort`;

const P = (pid, args, { age = 9999, cwd = WT('ENG-845') } = {}) => ({ pid, args, ageSec: age, cwd });
const run = (procs, opts = {}) => orphanPreviewProcs({ procs, state: {}, root: ROOT, minAgeSec: 900, ...opts }).map((p) => p.pid);

console.log('orphanPreviewProcs — reaps what state forgot');
{
  ok(run([P(1, BACKEND('ENG-845'))]).join() === '1', 'old unrecorded preview backend → reaped');
  ok(run([P(2, VITE_NODE('ENG-845', 52100))]).join() === '2', 'old unrecorded vite preview → reaped');
  // the npm exec wrapper carries no worktree path in argv — it can only be attributed by cwd
  ok(run([P(3, VITE(52100), { cwd: `${WT('ENG-845')}/customer-portal` })]).join() === '3', 'npm exec wrapper attributed by cwd → reaped');

  const state = { 'eng-845': { procs: { backend: { pid: 10 } } } };
  ok(run([P(10, BACKEND('ENG-845')), P(11, BACKEND('ENG-845'))], { state }).join() === '11',
    'the RECORDED generation is spared; only the forgotten one is reaped');
}

console.log('orphanPreviewProcs — what it must never kill');
{
  // The live near-miss: an agent's own ts-node, same worktree, different shape and 76s old.
  const agentTsNode = `node ${WT('ENG-845')}/backend/node_modules/.bin/ts-node --transpile-only -O {"module":"commonjs"} scripts/x.ts`;
  ok(run([P(20, agentTsNode, { age: 76 })]).length === 0, "an agent's ts-node (different shape, young) → never reaped");
  ok(run([P(21, agentTsNode)]).length === 0, 'and not even when it is old — the SHAPE is wrong, it is not a preview server');

  // Other things that live in a worktree and would be catastrophic to kill mid-flight.
  ok(run([P(22, `node ${WT('ENG-845')}/node_modules/typescript/bin/tsc --noEmit`)]).length === 0, 'a type-check → never reaped');
  ok(run([P(23, `node ${WT('ENG-845')}/node_modules/.bin/jest src/__tests__/x.test.ts`)]).length === 0, 'a jest run → never reaped');
  ok(run([P(24, `node ${WT('ENG-845')}/customer-portal/node_modules/.bin/vite build`)]).length === 0, 'a vite BUILD (not `preview`) → never reaped');
  ok(run([P(25, 'claude -p --output-format stream-json --resume abc')]).length === 0, 'a claude turn → never reaped');

  // Age is the guard against catching a bring-up whose processes are not recorded yet. Bring-ups were
  // observed taking 15+ minutes on this box.
  ok(run([P(26, BACKEND('ENG-845'), { age: 60 })]).length === 0, 'preview-shaped but young → spared (a bring-up may not have recorded it yet)');
  ok(run([P(27, BACKEND('ENG-845'), { age: 899 })]).length === 0, 'just under the age threshold → spared');
  ok(run([P(28, BACKEND('ENG-845'), { age: 901 })]).join() === '28', 'just over it → reaped');

  // A `starting` entry is a bring-up in flight: its processes exist but are not recorded yet, so age
  // alone could betray it on a slow build. Belt and braces.
  ok(run([P(29, BACKEND('ENG-803'), { cwd: WT('ENG-803') })], { state: { 'eng-803': { starting: true } } }).length === 0,
    'bug is mid-bring-up (starting) → its unrecorded processes are spared regardless of age');

  // Never reach outside the worktree root — the shared main checkout must be untouchable.
  ok(run([P(30, 'node /home/ec2-user/agentweb/backend/node_modules/.bin/ts-node --transpile-only src/server.ts', { cwd: '/home/ec2-user/agentweb/backend' })]).length === 0,
    'a preview-shaped process in the MAIN checkout → never reaped (outside the worktree root)');
  ok(run([P(31, BACKEND('ENG-845'), { cwd: '/tmp' })]).length === 0, 'cwd outside the worktree root → never reaped');
}

// REGRESSION, caught in production on the first live sweep (2026-08-05 13:40): the reaper killed the
// backend of an eng-803 bring-up that was 24 minutes into its run. The `starting` guard did not save it
// because `starting` only exists when a state ENTRY exists — and `preview.mjs up` does teardown-before-
// start, which REMOVES the entry. In that window there is no entry at all: no flag to read, no recorded
// pids, age past the threshold, so a perfectly live bring-up looked exactly like an orphan.
//
// Absence of state is not evidence of orphanhood. While a bring-up is running, the process table is the
// authoritative signal, so an in-flight `preview.mjs up <bug>` now vetoes reaping anything for that bug.
console.log('orphanPreviewProcs — an in-flight bring-up vetoes reaping (regression)');
{
  const victim = P(40, BACKEND('ENG-803'), { age: 24 * 60, cwd: WT('ENG-803') });
  const bringUp = (bug) => P(41, `node /home/ec2-user/agentweb/.linear-autofix/preview/preview.mjs up ${bug} ${WT(bug)}`, { age: 800, cwd: '/home/ec2-user/agentweb/.linear-autofix' });

  ok(run([victim]).join() === '40', 'no bring-up running → the forgotten backend is reaped (unchanged)');
  ok(run([victim, bringUp('ENG-803')]).length === 0, 'a `preview.mjs up` for THIS bug → spared, even with no state entry at all');
  ok(run([victim, bringUp('eng-803')]).length === 0, 'bug id matching is case-insensitive (state keys lowercase, argv often UPPER)');
  ok(run([victim, bringUp('ENG-999')]).join() === '40', "a bring-up for a DIFFERENT bug does not protect this one");
  // and the veto must never protect the bring-up runner itself from being counted as a candidate
  ok(run([bringUp('ENG-803')]).length === 0, 'the bring-up process itself is not preview-server-shaped → never a candidate');
}

console.log('orphanPreviewProcs — the live ENG-845 shape');
{
  const procs = [
    P(177871, BACKEND('ENG-845'), { age: 14214 }),
    P(178195, VITE_NODE('ENG-845', 52100), { age: 14168 }),
    P(178873, VITE_NODE('ENG-845', 51100), { age: 14082 }),
    P(326663, `node ${WT('ENG-845')}/backend/node_modules/.bin/ts-node --transpile-only -O {"module":"commonjs"} x.ts`, { age: 89 }),
  ];
  const got = run(procs, { state: { 'eng-845': { ports: { api: 31102 }, procs: { backend: { pid: 999 } } } } });
  ok(got.length === 3 && got.includes(177871) && got.includes(178195) && got.includes(178873), 'reaps the three forgotten servers');
  ok(!got.includes(326663), "and leaves the agent's live ts-node alone — the exact near-miss from the incident");
}

// dryRun is the default posture at the call site: this sweep kills processes and has already been wrong
// once in production, and bring-ups here have been seen dying BEFORE recording state — leaving a stack
// that is genuinely serving yet indistinguishable from an abandoned one. Observe first, arm later.
console.log('reapOrphanPreviewProcs — dry-run posture');
{
  const orphan = [P(50, BACKEND('ENG-845'), { age: 9999 })];
  const common = { procs: orphan, state: {}, root: ROOT, minAgeSec: 900 };
  const killed = []; const lines = [];
  const n = reapOrphanPreviewProcs((m) => lines.push(m), { ...common, dryRun: true, kill: (pid) => killed.push(pid) });
  ok(killed.length === 0, 'dryRun → nothing is signalled');
  ok(n.length === 0, 'dryRun → reports nothing reaped');
  ok(lines.some((l) => l.includes('[dry-run] WOULD stop') && l.includes('50')), 'dryRun → still logs the candidate, so the evidence accumulates');

  const killed2 = []; const lines2 = [];
  const n2 = reapOrphanPreviewProcs((m) => lines2.push(m), { ...common, dryRun: false, kill: (pid) => killed2.push(pid) });
  ok(killed2.join() === '50' && n2.join() === '50', 'armed → signals the orphan and reports it');
  ok(lines2.some((l) => l.startsWith('stopping ')), 'armed → logs it as an action, not a hypothetical');
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
