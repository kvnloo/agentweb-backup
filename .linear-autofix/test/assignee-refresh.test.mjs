// Tests for assigneeRefreshPatch — keeps a stored state entry's assignee in sync with the issue's
// CURRENT Linear assignee, so the chat sidebar shows the real owner. Cards are frequently assigned to
// a person only AFTER the bot fixes them (pickup-time snapshot = unassigned), so without this refresh
// the sidebar shows no owner forever. Run: node test/assignee-refresh.test.mjs
import { assigneeRefreshPatch } from '../git-identity.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const manan = { id: 'u1', name: 'Manan Varma', email: 'mvarma@argusoft.com' };
const anurag = { id: 'u2', name: 'Anurag Seth', email: 'aseth@argusoft.com' };

console.log('assigneeRefreshPatch');
{
  // The real-world case that started this: fixed while unassigned → stored null; a human assigns it
  // afterward → the patch fills in the current owner so the sidebar chip finally renders.
  const p = assigneeRefreshPatch({ identifier: 'ENG-368', assignee: null, assigneeEmail: null }, manan);
  ok(p && p.assigneeEmail === 'mvarma@argusoft.com' && p.assignee.name === 'Manan Varma',
    'null → assigned: patch fills in the live assignee');

  // Reassignment: stored owner differs from the live one → adopt the new person everywhere.
  const p2 = assigneeRefreshPatch({ identifier: 'ENG-370', assignee: { name: 'Manan Varma', email: 'mvarma@argusoft.com' }, assigneeEmail: 'mvarma@argusoft.com' }, anurag);
  ok(p2 && p2.assigneeEmail === 'aseth@argusoft.com' && p2.assignee.name === 'Anurag Seth',
    'reassigned: patch switches to the new assignee');

  // Already current → no write (avoids churning state.json every poll cycle).
  ok(assigneeRefreshPatch({ identifier: 'ENG-351', assignee: { name: 'Manan Varma', email: 'mvarma@argusoft.com' }, assigneeEmail: 'mvarma@argusoft.com' }, manan) === null,
    'unchanged assignee → null (no needless write)');
  // Email match is case-insensitive (Linear/stored casing can differ) → still no write.
  ok(assigneeRefreshPatch({ identifier: 'ENG-351', assignee: { name: 'Manan Varma', email: 'mvarma@argusoft.com' }, assigneeEmail: 'MVARMA@argusoft.com' }, manan) === null,
    'email match is case-insensitive → null');

  // Never downgrade a known owner to null on a transient/absent Linear assignee.
  ok(assigneeRefreshPatch({ identifier: 'ENG-351', assignee: { name: 'Manan Varma', email: 'mvarma@argusoft.com' }, assigneeEmail: 'mvarma@argusoft.com' }, null) === null,
    'live unassigned → null (keeps last known owner)');
  ok(assigneeRefreshPatch({ identifier: 'ENG-351', assignee: { name: 'Manan Varma', email: 'mvarma@argusoft.com' }, assigneeEmail: 'mvarma@argusoft.com' }, { name: 'Ghost', email: '' }) === null,
    'live assignee with no email → null (keeps last known owner)');

  // Standalone chats are owner-driven (not Linear-assigned) — never touched.
  ok(assigneeRefreshPatch({ identifier: 'CHAT-3', standalone: true, assignee: null, assigneeEmail: null }, manan) === null,
    'standalone chat → null (owner-driven, not Linear)');

  // Defensive: no entry at all.
  ok(assigneeRefreshPatch(null, manan) === null, 'null entry → null');

  // Name-only change (same email) still refreshes so the displayed name tracks Linear.
  const p3 = assigneeRefreshPatch({ identifier: 'ENG-9', assignee: { name: 'M. Varma', email: 'mvarma@argusoft.com' }, assigneeEmail: 'mvarma@argusoft.com' }, manan);
  ok(p3 && p3.assignee.name === 'Manan Varma', 'name-only drift (same email) → patch updates the name');
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
