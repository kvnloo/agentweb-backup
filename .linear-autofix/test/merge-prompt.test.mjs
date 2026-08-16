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
  // Auto-merge is the sharp edge here: this repo's checks are ADVISORY, so "merge when ready" merges
  // instantly rather than waiting for CI or the reviewer. The agent must hold the decision itself.
  ok(/never use auto-merge/i.test(p), 'auto-merge is forbidden outright');
  ok(/merge queue|merge when ready/i.test(p), 'and the other deferred-merge shapes with it');
  ok(/advisory/i.test(p), 'explains WHY — the checks are advisory, so it would not wait');
  ok(/you decide the moment|YOU decide/i.test(p), 'the agent holds the merge decision itself');
  ok(/genuinely finished|nothing red yet/i.test(p), 'CI must be finished-and-passing, not merely not-yet-red');
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
  // Assert the SECRET's VALUE is absent — read from the environment, never written here. An earlier
  // version of this test hardcoded the password in order to check for it, which put a live production
  // credential into the repo: exactly the thing the assertion exists to prevent.
  const secret = process.env.PROD_TEST_PASSWORD;
  ok(secret ? !p.includes(secret) : true,
    secret ? 'the password VALUE is never in the prompt — only the env var name' : 'no PROD_TEST_PASSWORD set; absence check skipped');
  ok(!/password\s*[:=]\s*\S/i.test(p), 'no literal credential of any shape is inlined');
  ok(/seed|create/i.test(p) && /clean/i.test(p), 'says to clean up data it seeded');
  ok(/only read|read-only|observ/i.test(p), 'and distinguishes the read-only case');
  ok(/proof|evidence/i.test(p), 'a read-only trace is left deliberately, as proof');
  ok(/production/i.test(p) && /real/i.test(p), 'makes clear this is real production, not a test env');
}

console.log('\n— access it has —');
{
  ok(/production database and production logs, READ-ONLY/i.test(p), 'prod DB + logs, read-only');
  ok(/preview database and preview logs, full access/i.test(p), 'preview DB + logs, full access');
}

console.log('\n— reporting back to Linear —');
{
  ok(/LINEAR_API_KEY/.test(p), 'tells it the key is already in its environment');
  ok(/if .*linear issue|when .*linear issue|has a linear/i.test(p), 'conditional — a laptop handoff often has no card');
  ok(/comment/i.test(p), 'asks for a comment on the card');
  ok(/Verifying/.test(p), 'names the state it MAY move the card to');
  ok(/everything (that )?the card asks/i.test(p), 'only when EVERYTHING the card asked for is done');
  ok(/live[- ]tested|verified (on|in) prod/i.test(p), 'and only after it was live-tested on production');
  ok(/never.*done|not.*mark it done/i.test(p), 'still must NOT close the card — a human owns that');
  ok(/partially|some of|not all/i.test(p), 'partial completion explicitly does not earn the move');
}

console.log('\n— preview-testing a review-driven change before merging —');
{
  ok(/preview/i.test(p), 'the agent knows a preview is available to it');
  ok(/before merging|pre-merge/i.test(p), 'and that it may use it BEFORE the merge');
  ok(/free to|may|your call|judgement/i.test(p), 'framed as permission/judgement, not an obligation');
  ok(!/preview\.mjs|proxy\.mjs|nip\.io/.test(p), 'but the preview MECHANICS are not scripted (they rot too)');
}

console.log('\n— where autonomy stops —');
{
  ok(/production decision|decision about production/i.test(p), 'a production decision blocks');
  ok(/big|significant|consequential|far-reaching/i.test(p), 'so does a big/consequential one');
  ok(/wait|stop|do not proceed/i.test(p), 'it must stop and wait rather than proceed');
  // The flip side matters just as much: everything else is the agent's to do alone.
  ok(/otherwise|everything else|anything short of/i.test(p), 'and everything else is full autonomy');
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
