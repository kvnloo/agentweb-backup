// Tests for the autonomous merge drive's prompt.
//
// The point of these is unusual, so it's worth stating: this prompt is deliberately NOT a script. The
// GitHub CLI, check names, review scoring and deploy plumbing change without anyone remembering this
// file exists, and a prompt full of exact commands rots silently — the agent follows a stale recipe,
// fails, and does something worse than it would have unaided.
//
// So these tests assert two things:
//   1. the POLICY survives — the gates, the scope rule, the judgement calls, the honesty rules;
//   2. the MECHANICS stay absent — no scripted command lines the agent would follow off a cliff.
//
// A future edit that "helpfully" pastes the current gh incantation back in should fail here.
// Run: node test/merge-prompt.test.mjs
import { mergeMsg, entryPrUrls, prShortRef } from '../chat/merge-prompt.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const PR = 'https://github.com/AgentWebPro/agentweb/pull/2301';
const p = mergeMsg({ prs: [PR] });

console.log('\n— PR scoping —');
{
  ok(entryPrUrls({ prs: [PR] })[0] === PR, 'plain string PRs are read');
  ok(entryPrUrls({ prs: [{ url: PR }] })[0] === PR, 'object PRs are read');
  ok(entryPrUrls({}).length === 0, 'no PRs is empty, not a crash');
  ok(prShortRef(PR) === '#2301', 'short ref for display');
  ok(p.includes(PR), 'the prompt names the PR it owns');
  ok(/only.*PR\(s\)|only on the PR/i.test(p), 'and says these are the ONLY ones it may act on');
  ok(/do not enumerate|not.*any other PR/i.test(p), 'forbids discovering other PRs');
  const none = mergeMsg({ prs: [] });
  ok(/MERGE_BLOCKED/.test(none) && /no PR/i.test(none), 'no PR → told to escalate, not to go looking');
}

console.log('\n— the invariants that must never be softened —');
{
  ok(/never bypass branch protection/i.test(p), 'no bypassing branch protection');
  ok(/admin|force|disabling a check/i.test(p), 'names the bypass shapes without depending on one flag');
  ok(/merge commit/i.test(p) && /never delete the branch/i.test(p), 'merge commit, branch kept');
  ok(/MERGE_BLOCKED/.test(p), 'has an escalation channel');
  ok(/\[\[WATCH:/.test(p) && /\[\[WATCH_DONE\]\]/.test(p), 'the watch loop markers are exact — they are OUR protocol, parsed by us');
  ok(/never sit on a blocking wait|never block/i.test(p), 'forbids blocking waits');
  ok(/autofix|label/i.test(p), 'admission gate (label/assignee/state) is still part of the merge gate');
}

console.log('\n— the judgement that keeps it autonomous —');
{
  ok(/mechanical/i.test(p) && /do not come back to the developer/i.test(p), 'mechanical fixes are handled alone');
  ok(/decision/i.test(p) && /do not guess/i.test(p), 'real decisions are escalated, not guessed');
  ok(/handoff document/i.test(p), 'checks the handoff doc BEFORE escalating a decision');
  ok(/pass is not permission to skip reading/i.test(p), 'a passing review still must be read');
  ok(/costs a full cycle|costs another full verification cycle|every new commit costs/i.test(p), 'the cost of another commit is explained');
  ok(/nit|polish/i.test(p) && /never loop the merge on polish/i.test(p), 'optional polish never blocks the merge');
}

console.log('\n— finishing means live, and honestly so —');
{
  ok(/merging is not finishing|not at merge/i.test(p), 'merge is not the end');
  ok(/do not infer it from a green deploy/i.test(p), 'a green deploy is not proof');
  ok(/serving the old build/i.test(p), 'names the actual failure mode');
  ok(/never write "deployed and verified"/i.test(p), 'forbids claiming verification it did not do');
  ok(/cannot verify it live/i.test(p) && /what a human would have to do/i.test(p), 'has an honest out when it truly cannot check');
}

console.log('\n— mechanics stay OUT (this is the part that rots) —');
{
  // The prompt must not hand the agent a recipe. Each of these was in the previous version and is
  // exactly the kind of thing that breaks when the tooling moves.
  const banned = [
    ['gh pr merge', /gh pr merge/],
    ['gh pr checks', /gh pr checks/],
    ['gh pr ready', /gh pr ready/],
    ['gh pr update-branch', /gh pr update-branch/],
    ['gh pr view --json', /gh pr view .*--json/],
    ['gh api .../pulls/<pr>/comments', /gh api repos/],
    ['gh run view --log-failed', /gh run (view|list)/],
    ['@greptile review', /@greptile/],
    ['--log-failed', /--log-failed/],
    ['statusCheckRollup', /statusCheckRollup/],
  ];
  for (const [name, re] of banned) ok(!re.test(p), `no scripted \`${name}\``);

  ok(/may already be out of date|confirm.*not.*instructions|orientation you should confirm/i.test(p),
    'tells the agent specifics here may be stale and to confirm them');
  ok(/trust what you observe/i.test(p), 'tells it to prefer observation over this prompt');
  ok(/do not report failure because something in this prompt did not work/i.test(p),
    'a stale detail must not become a reported failure');
}

console.log('\n— verifying on production —');
{
  ok(/PROD_TEST_EMAIL/.test(p) && /PROD_TEST_PASSWORD/.test(p), 'points at the env vars holding the account');
  ok(!/Argus@123/.test(p), 'the password itself is NEVER in the prompt — it lives only in the gitignored .env');
  ok(/seed|create/i.test(p) && /clean/i.test(p), 'says to clean up data it seeded');
  ok(/only read|read-only|observ/i.test(p), 'and distinguishes the read-only case');
  ok(/proof|evidence/i.test(p), 'a read-only trace is left deliberately, as proof');
  ok(/production/i.test(p) && /real/i.test(p), 'makes clear this is real production, not a test env');
}

console.log('\n— reporting back to Linear —');
{
  ok(/LINEAR_API_KEY/.test(p), 'tells it the key is already in its environment');
  ok(/if .*linear issue|when .*linear issue|has a linear/i.test(p), 'conditional — a laptop handoff often has no card');
  ok(/comment/i.test(p), 'asks for a comment on the card');
  ok(/do not.*(mark|move).*(done|status)|never.*(mark|move) it (to )?done/i.test(p),
    'must NOT close the card — the human owns that transition');
}

console.log('\n— orientation that is still allowed —');
{
  // Naming the reviewer and its current pass shape is useful, as long as it is flagged as checkable
  // rather than assumed. This asserts the hedge exists, not the value.
  ok(/greptile/i.test(p), 'still names the reviewer (orientation)');
  ok(/5\/5/.test(p) && /confirm what a pass actually looks like/i.test(p),
    'the 5/5 shape is given as a hint AND hedged, not asserted as permanent');
}

console.log(`\n${fail ? '❌' : '✅'} ${fail ? 'FAILURES' : 'ALL PASSED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
