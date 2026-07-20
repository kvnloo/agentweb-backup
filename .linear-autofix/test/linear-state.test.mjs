// Tests for linearStatePatch — mirrors the issue's CURRENT Linear workflow state (Backlog / Todo /
// In Progress / In Review / Done / Canceled) into the state entry so the chat sidebar shows a live
// status chip. Auto-refreshed by the poller each cycle (same mechanism as the assignee sync).
// Run: node test/linear-state.test.mjs
import { linearStatePatch } from '../linear.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const inProgress = { id: 's1', name: 'In Progress', type: 'started' };
const done = { id: 's2', name: 'Done', type: 'completed' };

console.log('linearStatePatch');
{
  // First capture: entry has no stored state → patch fills in name + type.
  const p = linearStatePatch({ identifier: 'ENG-368' }, inProgress);
  ok(p && p.linearState === 'In Progress' && p.linearStateType === 'started', 'no stored state → patch fills name + type');

  // Transition: stored "In Progress" but Linear now "Done" → patch updates both.
  const p2 = linearStatePatch({ identifier: 'ENG-368', linearState: 'In Progress', linearStateType: 'started' }, done);
  ok(p2 && p2.linearState === 'Done' && p2.linearStateType === 'completed', 'state changed → patch updates to the new state');

  // Unchanged → no write (avoids churning state.json every cycle).
  ok(linearStatePatch({ identifier: 'ENG-368', linearState: 'In Progress', linearStateType: 'started' }, inProgress) === null,
    'unchanged state → null (no needless write)');
  // Same name but type drifted (rare Linear reconfig) → still refresh so the chip color stays right.
  ok(linearStatePatch({ identifier: 'ENG-368', linearState: 'In Progress', linearStateType: 'unstarted' }, inProgress)?.linearStateType === 'started',
    'type drift (same name) → patch updates the type');

  // Missing/absent live state → keep whatever we have (never blank the chip on a transient read).
  ok(linearStatePatch({ identifier: 'ENG-368', linearState: 'Done', linearStateType: 'completed' }, null) === null,
    'no live state → null (keeps last known)');
  ok(linearStatePatch({ identifier: 'ENG-368', linearState: 'Done', linearStateType: 'completed' }, { name: '', type: 'started' }) === null,
    'live state with empty name → null (keeps last known)');

  // Standalone chats aren't Linear issues → never given a status chip.
  ok(linearStatePatch({ identifier: 'CHAT-3', standalone: true }, inProgress) === null, 'standalone chat → null');
  ok(linearStatePatch(null, inProgress) === null, 'null entry → null');

  // Name is trimmed; a missing type is stored as null (not undefined) so equality checks are stable.
  const p3 = linearStatePatch({ identifier: 'ENG-9' }, { name: '  Backlog  ' });
  ok(p3 && p3.linearState === 'Backlog' && p3.linearStateType === null, 'name trimmed; absent type → null');
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
