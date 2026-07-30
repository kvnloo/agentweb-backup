// Tests the "make editable" promotion: a blocked / branch-less issue chat is read-only (capabilityOf
// grants full access only where a fix branch or worktree exists). "Make editable" provisions a fresh
// assignee-prefixed branch + worktree on demand so the chat becomes editable. These cover the pure
// decision (when it's allowed) and the branch-name assembly. Run: node test/make-editable.test.mjs
import { makeEditableDecision, buildEditableBranch, promotedOutcome } from '../chat/editable.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const blocked = { identifier: 'ENG-48', outcome: 'blocked', assignee: { name: 'Manan Varma' } };
const on = { fixEnabled: true, worktreeExists: false };

console.log('makeEditableDecision — the gate');
{
  ok(makeEditableDecision(blocked, on).ok === true, 'blocked + no branch + no worktree + fix enabled → allowed');

  ok(makeEditableDecision(blocked, { ...on, fixEnabled: false }).ok === false, 'refused when the box cannot push fixes');
  ok(makeEditableDecision(null, on).ok === false, 'refused when there is no autofix record');
  ok(makeEditableDecision({ ...blocked, standalone: true }, on).ok === false, 'refused for standalone chats (already editable)');
  ok(makeEditableDecision({ ...blocked, outcome: 'started' }, on).ok === false, 'refused while the pipeline is started');
  ok(makeEditableDecision({ ...blocked, outcome: 'recovered' }, on).ok === false, 'refused while the pipeline is recovered');
  ok(makeEditableDecision({ ...blocked, branch: 'manan/eng-48-x' }, on).ok === false, 'refused when a branch already exists (idempotent)');
  ok(makeEditableDecision(blocked, { ...on, worktreeExists: true }).ok === false, 'refused when a worktree already exists (idempotent)');

  // Refusals carry a human reason for the UI to show.
  ok(typeof makeEditableDecision(blocked, { ...on, fixEnabled: false }).reason === 'string', 'a refusal includes a reason string');
}

console.log('\nbuildEditableBranch — matches the pipeline shape');
{
  ok(buildEditableBranch('ENG-48', 'manan/', 'fix-the-thing') === 'manan/eng-48-fix-the-thing', 'prefix + lowercased id + title slug');
  ok(buildEditableBranch('ENG-48', 'autofix/', '') === 'autofix/eng-48', 'no title slug → no trailing dash');
  ok(buildEditableBranch('ENG-48', 'autofix/', '   ') === 'autofix/eng-48', 'whitespace-only slug is treated as empty');
  ok(buildEditableBranch('eng-48', 'manan/', 'x') === 'manan/eng-48-x', 'already-lowercase id is stable');
}

console.log('\npromotedOutcome — clears "blocked" on takeover, leaves others alone');
{
  ok(promotedOutcome('blocked') === 'editing', 'blocked → editing');
  ok(promotedOutcome('fixed') === 'fixed', 'fixed is untouched');
  ok(promotedOutcome('cannot_fix') === 'cannot_fix', 'cannot_fix is untouched');
  ok(promotedOutcome(undefined) === undefined, 'undefined is untouched');
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
