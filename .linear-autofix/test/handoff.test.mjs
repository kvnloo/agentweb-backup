// Tests for the local-Claude → autofix handoff (POST /api/handoff).
//
// The flow: you finish work in a local Claude session on your laptop, it opens a PR and writes a rich
// context document, then POSTs both here. The box creates a standalone chat whose worktree adopts the
// PR's branch, drops the document on disk, and fires ONE seeded turn = handoff framing + the existing
// merge drive. From there the [[WATCH]] loop carries Greptile → CI → merge → deploy → live verify
// without the laptop being open.
//
// These cover the pure parts: what a handoff must contain to be accepted, and what the agent is told.
// Run: node test/handoff.test.mjs
import { validateHandoff, handoffDoc, handoffPrompt, workspaceLines, MIN_CONTEXT_CHARS } from '../chat/handoff.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const MEMBERS = [
  { email: 'mvarma@argusoft.com', name: 'Manan Varma', firstName: 'Manan' },
  { email: 'aseth@argusoft.com', name: 'Anurag Seth', firstName: 'Anurag' },
];
const CTX = 'x'.repeat(MIN_CONTEXT_CHARS + 10);
const good = {
  email: 'mvarma@argusoft.com',
  prUrl: 'https://github.com/AgentWebPro/agentweb/pull/2301',
  branch: 'rui/some-feature',
  title: 'Some feature',
  context: CTX,
};
const v = (over) => validateHandoff({ ...good, ...over }, MEMBERS);

console.log('\n— what a valid handoff looks like —');
{
  const r = v({});
  ok(r.ok, 'a complete handoff is accepted');
  ok(r.value.prUrls.length === 1 && r.value.prUrls[0] === good.prUrl, 'the PR is normalised to a list');
  ok(r.value.email === 'mvarma@argusoft.com', 'the owner email is kept (it selects the GH token + git identity)');
  ok(r.value.branch === 'rui/some-feature', 'the branch is kept verbatim — the worktree is built from it');
}
{
  // Work that spans both repos opens two PRs; the merge drive handles them in dependency order.
  const r = v({ prUrl: ['https://github.com/AgentWebPro/agentweb/pull/1', 'https://github.com/AgentWebPro/agentweb-customer-portal/pull/2'] });
  ok(r.ok && r.value.prUrls.length === 2, 'a two-repo handoff may carry two PRs');
}
{
  const r = v({ title: '' });
  ok(r.ok && !!r.value.title, 'a missing title falls back rather than failing the handoff');
}

console.log('\n— the owner must be a configured member —');
{
  ok(!v({ email: 'nobody@example.com' }).ok, 'an unknown email is rejected (no GH token / git identity for them)');
  ok(!v({ email: '' }).ok, 'a missing email is rejected');
  ok(v({ email: 'MVarma@ArgusOft.com' }).ok, 'the email match is case-insensitive');
  const e = v({ email: 'nobody@example.com' }).error || '';
  ok(e.includes('mvarma@argusoft.com') && e.includes('aseth@argusoft.com'), 'the error names who IS allowed, so the skill can tell you');
}

console.log('\n— the PR is mandatory (the merge drive refuses to go looking for one) —');
{
  ok(!v({ prUrl: '' }).ok, 'no PR is rejected up front, not after a wasted turn');
  ok(!v({ prUrl: [] }).ok, 'an empty PR list is rejected');
  ok(!v({ prUrl: 'not-a-url' }).ok, 'a non-URL is rejected');
  ok(!v({ prUrl: 'https://github.com/AgentWebPro/agentweb/issues/12' }).ok, 'an issue link is not a PR link');
  ok(!v({ prUrl: 'https://evil.example.com/AgentWebPro/agentweb/pull/1' }).ok, 'only github.com PR URLs are accepted');
}

console.log('\n— the branch goes into git commands, so it is validated strictly —');
{
  ok(!v({ branch: '' }).ok, 'an empty branch is rejected');
  ok(!v({ branch: 'has space' }).ok, 'whitespace is rejected');
  ok(!v({ branch: '--upload-pack=evil' }).ok, 'a leading dash cannot become a git flag');
  ok(!v({ branch: '../../etc/passwd' }).ok, 'path traversal is rejected');
  ok(!v({ branch: 'a;rm -rf /' }).ok, 'shell metacharacters are rejected');
  ok(v({ branch: 'feat/ENG-123_thing.v2-final' }).ok, 'ordinary branch punctuation is allowed');
  ok(!v({ branch: 'main' }).ok, 'main is refused — a handoff must never adopt the base branch');
}

console.log('\n— the context IS the feature, so a thin one is refused —');
{
  ok(!v({ context: '' }).ok, 'no context is rejected');
  ok(!v({ context: 'lgtm, merge it' }).ok, 'a token context is rejected rather than silently accepted');
  const e = v({ context: 'too short' }).error || '';
  ok(/\d/.test(e), 'the error says how much is expected, so the skill can fix it');
}

console.log('\n— the document written to disk —');
{
  const doc = handoffDoc({ ...good, prUrls: [good.prUrl], author: 'Manan Varma', at: '2026-08-16T00:00:00.000Z' });
  ok(doc.includes(good.prUrl), 'names the PR');
  ok(doc.includes('rui/some-feature'), 'names the branch');
  ok(doc.includes(CTX), 'carries the developer context verbatim — nothing is summarised away');
  ok(doc.includes('2026-08-16'), 'stamped, so a stale handoff is obvious');
}

console.log('\n— what the agent is told —');
{
  const p = handoffPrompt({
    identifier: 'CHAT-11', title: 'Some feature', prUrls: [good.prUrl],
    branch: good.branch, handoffPath: '/home/ec2-user/autofix-worktrees/CHAT-11/HANDOFF.md',
  });
  ok(p.includes('/autofix-worktrees/CHAT-11/HANDOFF.md'), 'points at the doc by absolute path (survives a compact — it can re-read it)');
  ok(/did not write|another developer|someone else/i.test(p), 'tells it the code is NOT its own work');
  ok(/authoritative|intent/i.test(p), 'frames the doc as authoritative for INTENT');
  ok(/verify|check|diff/i.test(p), 'but still tells it to verify claims against the diff');
  ok(p.includes(good.prUrl), 'names the PR so the merge drive is scoped to it');

  // The doc lives IN the worktree, whose root is the repo root — so it is untracked and one careless
  // `git add -A` from being committed onto the PR. The prompt is the control; assert it is explicit.
  ok(/never commit it/i.test(p), 'explicitly says never commit the handoff doc');
  ok(/git add -A/.test(p) && /do NOT use/i.test(p), 'names the exact command that would sweep it in, and forbids it');
  ok(/stage the exact paths/i.test(p), 'tells it what to do INSTEAD — stage explicit paths');
  ok(/unstage/i.test(p), 'gives it a recovery step if the file ever does get staged');
}

console.log('\n— a handoff chat is the developer\'s to delete, never its own —');
{
  // A normal standalone chat is told it may self-close with [[CLOSE_CHAT]], which deletes the worktree
  // AND `git branch -D`s the branch. On a handoff that branch is the developer's real feature branch,
  // and the chat is the record of how the merge went — so the affordance must not exist here at all.
  const plain = workspaceLines({ branch: 'chat-7' }, '/wt/CHAT-7');
  ok(/\[\[CLOSE_CHAT\]\]/.test(plain.closeLine), 'a normal standalone chat keeps its self-close');
  ok(/fresh branch off main/i.test(plain.branchDesc), 'and is correctly described as a fresh branch');

  const ho = workspaceLines({ branch: 'rui/feature', handoff: { at: 'x', by: 'y' } }, '/wt/CHAT-8');
  ok(!/\[\[CLOSE_CHAT\]\]/.test(ho.closeLine), 'a handoff chat is never offered the self-close marker');
  ok(/do not close|never/i.test(ho.closeLine), 'it is told explicitly not to close or delete');
  ok(/developer|UI/i.test(ho.closeLine), 'and told who does delete it, and where');
  ok(/merged/i.test(ho.closeLine), 'including that finishing the merge is NOT a reason to close');

  // The stock wording would tell a handoff agent its branch is "a fresh branch off main". It is the
  // opposite: the developer's branch, already carrying their work and an open PR.
  ok(!/fresh branch off main/i.test(ho.branchDesc), 'a handoff branch is NOT described as fresh off main');
  ok(/developer/i.test(ho.branchDesc) && /rui\/feature/.test(ho.branchDesc), 'it is described as the developer\'s own branch');
}

console.log(`\n${fail ? '❌' : '✅'} ${fail ? 'FAILURES' : 'ALL PASSED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
