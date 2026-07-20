// Tests for linearPriorityPatch — mirrors the issue's CURRENT Linear priority (0 none / 1 urgent /
// 2 high / 3 medium / 4 low) into the state entry so the sidebar can show a priority chip. Refreshed
// by the poller each cycle, same as the state/assignee sync. Run: node test/linear-priority.test.mjs
import { linearPriorityPatch } from '../linear.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

console.log('linearPriorityPatch');
{
  // First capture: no stored priority → patch fills it in.
  ok(linearPriorityPatch({ identifier: 'ENG-1' }, 1)?.priority === 1, 'no stored priority → patch fills it in');

  // Change: stored High(2) but Linear now Medium(3) → patch updates.
  ok(linearPriorityPatch({ identifier: 'ENG-1', priority: 2 }, 3)?.priority === 3, 'priority changed → patch updates');

  // Unchanged → no write.
  ok(linearPriorityPatch({ identifier: 'ENG-1', priority: 2 }, 2) === null, 'unchanged → null (no needless write)');

  // Priority 0 ("No priority") is a REAL value, not "unknown": clearing a priority must be reflected.
  ok(linearPriorityPatch({ identifier: 'ENG-1', priority: 2 }, 0)?.priority === 0, 'cleared to 0 → patch updates to 0');
  ok(linearPriorityPatch({ identifier: 'ENG-1', priority: 0 }, 0) === null, 'already 0 → null');
  ok(linearPriorityPatch({ identifier: 'ENG-1' }, 0)?.priority === 0, 'no stored + live 0 → patch stores 0');

  // Missing/non-numeric live priority → keep whatever we have (never blank it on a bad read).
  ok(linearPriorityPatch({ identifier: 'ENG-1', priority: 2 }, undefined) === null, 'undefined live priority → null (keep)');
  ok(linearPriorityPatch({ identifier: 'ENG-1', priority: 2 }, null) === null, 'null live priority → null (keep)');

  // Standalone chats aren't Linear issues → never given a priority.
  ok(linearPriorityPatch({ identifier: 'CHAT-3', standalone: true }, 1) === null, 'standalone chat → null');
  ok(linearPriorityPatch(null, 1) === null, 'null entry → null');
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
