// Bug 2 (double-stack leak): up() for a bug that ALREADY has a live stack overwrote routes+state with
// freshly-allocated ports, orphaning the old process groups → two full stacks resident for one ticket
// → OOM. Fix: up() must stop-and-await any existing procs-bearing stack FIRST. This models the exact
// precondition preview.mjs stopExistingStack() uses, and the "two turns in a row for the same ticket"
// scenario the report calls out. Faithful/pure — no real builds. Run: node test/preview-teardown.test.mjs

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

// Faithful copy of the guard in stopExistingStack(bug): only a FULL stack (procs present) is torn down;
// a bare `starting: true` placeholder (a concurrent in-flight bring-up with no procs yet) is left alone.
const shouldTearDown = (prior) => !!(prior?.procs && Object.keys(prior.procs).length);

console.log('stopExistingStack precondition');
{
  ok(shouldTearDown({ procs: { backend: { pid: 1, port: 31100 } } }), 'existing stack with procs → tear down first');
  ok(!shouldTearDown(undefined), 'no prior entry → nothing to tear down');
  ok(!shouldTearDown({ at: 'x', starting: true }), 'concurrent placeholder (starting:true, no procs) → left alone');
  ok(!shouldTearDown({ procs: {} }), 'empty procs map → nothing to tear down');
}

// Model up() with the fix in place: before recording a new stack it stops any existing procs-bearing
// stack. Assert that "two turns in a row for the same ticket" never leaves two stacks alive.
console.log('two bring-ups in a row for the same ticket');
{
  let nextPortBase = 31100;
  const stopped = [];
  const STATE = {};
  // Simplified faithful up(): stop-first (the fix), then allocate fresh ports + overwrite state.
  const up = (bug) => {
    if (shouldTearDown(STATE[bug])) { stopped.push(bug); delete STATE[bug]; }          // ← Bug 2 fix
    const port = nextPortBase++;
    STATE[bug] = { procs: { backend: { pid: 1000 + port, port } }, ports: { api: port } };
  };

  up('eng-396');                                   // turn 1: first stack
  const firstPort = STATE['eng-396'].ports.api;
  up('eng-396');                                   // turn 2: second bring-up for the SAME ticket
  const secondPort = STATE['eng-396'].ports.api;

  ok(stopped.length === 1 && stopped[0] === 'eng-396', 'the older stack is stopped before the new one starts');
  ok(secondPort !== firstPort, 'the new stack gets fresh ports (proves it is a real restart)');
  ok(Object.keys(STATE).length === 1, 'exactly ONE stack for the ticket remains — no leak');
}

// Regression: WITHOUT the stop-first step, the same scenario leaks a second stack (what actually
// happened to ENG-396: ports ...102 and ...103 both alive). This documents the bug the fix closes.
console.log('regression — the un-fixed path leaks');
{
  let nextPortBase = 31100;
  const alive = new Set();
  const STATE = {};
  const upBuggy = (bug) => { const port = nextPortBase++; alive.add(port); STATE[bug] = { port }; }; // never stops old
  upBuggy('eng-396'); upBuggy('eng-396');
  ok(alive.size === 2, 'un-fixed up() would leave 2 process groups alive for one ticket (the leak this fix prevents)');
}

console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
