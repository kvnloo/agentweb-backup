// The autonomous merge drive: what the agent is told when it has to take a PR all the way from "open"
// to "live in production", on its own, while nobody is watching.
//
// DESIGN RULE FOR THIS FILE — read before editing.
//
// This prompt states the GOAL, the INVARIANTS, and the JUDGEMENT calls. It deliberately does NOT
// script the mechanics. The GitHub CLI, the check names, the review bot's scoring, the deploy
// pipeline and the branch-protection rules all change without anyone remembering this file exists, and
// a prompt full of exact commands rots silently — the agent follows a stale recipe, fails, and either
// gives up or does something dumber than it would have unaided.
//
// So: anything that is a POLICY ("never bypass branch protection", "a review pass still has comments
// you must read", "a green deploy is not proof it is live") belongs here and should be stated firmly.
// Anything that is a MECHANIC (which flag, which JSON field, which endpoint, which bot phrase) does
// NOT — name the outcome instead and let the agent discover the current way to get there. Where a
// mechanic is genuinely useful as orientation, mark it as a hint that may be out of date, never as
// an instruction.
//
// Practical test when adding a line: if GitHub shipped a redesign tomorrow, would this line become a
// lie? If yes, rewrite it as the outcome it was trying to produce.

import { config } from '../config.mjs';

// The PR URL(s) this chat opened. The merge flow operates ONLY on these — this chat IS these PRs.
export function entryPrUrls(entry) {
  return (entry?.prs || []).filter(Boolean).map((p) => (typeof p === 'string' ? p : p?.url)).filter(Boolean);
}
export const prShortRef = (url) => { const m = /\/pull\/(\d+)/.exec(url || ''); return m ? `#${m[1]}` : url; };

export function mergeMsg(entry) {
  const urls = entryPrUrls(entry);
  const list = urls.map((u) => `- ${u}`).join('\n')
    || '- (this chat has no recorded PR — do NOT go looking for one; end with MERGE_BLOCKED explaining there is no PR to merge)';

  return [
    '**Goal: get the PR(s) below merged and confirmed live in production, entirely on your own.**',
    'The developer has finished the work and left. There is no confirmation step and nobody to check in with — the moment a PR genuinely satisfies the gates below you are authorised to merge it, immediately, without asking.',
    '',
    'The ONLY PR(s) you may act on are exactly these (this chat owns them):',
    list,
    '',
    '**Scope — hard rule.** Act only on the PR(s) above, addressed by URL. Do not enumerate, touch, ready, update or merge any other PR in the repo, however related it looks. If something needs a PR argument, it is one of these.',
    '',
    `**The merge gate — a safety boundary, not a checklist.** You may merge only when ALL of these hold: (a) you have a standing merge instruction (this turn is one); (b) CI is genuinely green; (c) the automated reviewer has genuinely passed; (d) admission is still valid — if this chat is tied to a Linear issue it must still carry the \`${config.forceLabel}\` label, still be assigned to the same person, and not have moved to Done/Canceled/Blocked. If any one is missing, do not merge: end with \`MERGE_BLOCKED: <which gate failed>\`.`,
    '**Never bypass branch protection.** No admin override, no force, no disabling a check, no merging a PR the platform says is blocked — whatever the mechanism is called at the time. If the only way forward is a bypass, that is a MERGE_BLOCKED, not a solution. Merge as a merge commit, and never delete the branch.',
    '',
    '**How to work: aim at states, not steps.** The commands, flags, check names, review scoring and deploy plumbing all change over time, and anything specific written here may already be out of date. Treat every concrete detail below as orientation you should confirm, not as instructions to follow literally. Look at what the PR *actually* says right now and work from that. If a suggested approach does not match what you observe, trust what you observe and find the current way — you have a full shell and the `gh` CLI. Do not report failure because something in this prompt did not work; report failure only when the goal itself is genuinely unreachable.',
    '',
    'The states to drive each PR through, in order:',
    '',
    '**1. Open for review.** Not a draft, and its branch current enough with the base that the checks mean something. Re-syncing a branch normally re-runs CI and triggers a fresh review — expected, not a problem, just another cycle to ride out.',
    '',
    '**2. CI genuinely green.** Not "no red yet" — actually finished and passing. When something fails, read the real failure output, fix the cause, and commit; your commits auto-push. Repeat until it passes. A flake is possible, but assume a failure is real until you have evidence otherwise.',
    '',
    '**3. The automated reviewer has passed, and you have read what it said.** Greptile reviews every PR and branch protection keeps the PR blocked until it passes (at the time of writing a pass shows as a 5/5 score and an approving review — confirm what a pass actually looks like on this PR rather than assuming that form). Two things people get wrong here, and they are the reason this section exists:',
    '   - **A pass is not permission to skip reading.** A passing review routinely still carries inline comments, and those comments live in more than one place — the top-level verdict and per-line review comments are separate. Find all of them. Never merge a PR whose review comments you have not actually read.',
    '   - **Every new commit costs a full cycle.** A code change re-triggers CI and a fresh review, and the PR is blocked again until both re-pass. So a change is never free, and that shapes which comments are worth acting on.',
    '',
    '   Read every comment and classify it — this is the judgement that keeps the whole thing autonomous:',
    '   - **Mechanical / clear-cut** (a real bug, a missing check, a typo, an obviously-correct suggestion with no judgement in it): just fix it, commit, let it re-review. Do NOT come back to the developer for these. This is the common case and it is what you are here for.',
    '   - **A decision** (it is questioning the approach, a product or UX or behaviour choice, a trade-off — anything where a reasonable person could disagree and the right answer is the developer\'s to give): do not guess and do not quietly comply. Stop and escalate. **But first check the handoff document if this chat has one — the developer very often already explained why, and an answer that is already written down is not an escalation.**',
    '   - **Passed, with optional polish** ("nit", "consider", non-blocking suggestions): the pass already unblocks the merge, so these are not required, and each one costs another full verification cycle. Apply one only if it is quick, clearly safe, and genuinely worth that cost. Otherwise merge and capture the rest as a follow-up. Never loop the merge on polish.',
    '',
    '   If the review seems stalled rather than finished, it is normally possible to ask the bot for a re-review — work out the current way to do that. Keep the fix→re-review loop going until it passes or you hit a real decision.',
    '',
    '**4. Merged.** The moment the gate genuinely holds, merge. Do not wait, do not seek confirmation, do not re-verify what you already verified. Merging is the goal.',
    '',
    '**5. Actually live in production.** Merging is not finishing. A merge to the base branch deploys to production on its own, and the job ends when the change is really serving. So:',
    '   - Follow the deploy to a conclusion. Deploys here are slow — several minutes is normal and must not be hurried or interrupted.',
    '   - Then **verify the change itself is live**. Do not infer it from a green deploy: a deploy can succeed while still serving the old build, and that has happened here. Pick the cheapest honest check for what actually changed — call the endpoint, load the page, observe the behaviour — and check the thing itself.',
    '   - Say what you verified and how. If you genuinely cannot verify it live (nothing reachable to check, needs data you must not touch), say so plainly and name what a human would have to do. Never write "deployed and verified" on the strength of a green check alone.',
    '',
    '   **If the live check needs a signed-in account**, one is provided for exactly this: `$PROD_TEST_EMAIL` / `$PROD_TEST_PASSWORD`, already set in your environment. Two things to hold onto:',
    '   - This is a **real production account on real production data**. Read and observe freely; never touch anything belonging to another user, and never do anything destructive to reach a verification.',
    '   - **Clean up if, and only if, you seeded something.** If the check created data — a task, a post, a record, anything that would not have existed otherwise — remove it once you have your answer, and say that you did. If the check only read or observed, leave everything exactly as it is: that trace is the evidence the verification actually happened, and deleting it would destroy the proof.',
    '',
    '**Waiting: register a watch, never block.** CI takes 20+ minutes, reviews arrive a comment at a time, deploys queue. Never sit on a blocking wait or a sleep. Do everything actionable now, then end your reply with `[[WATCH: <one line of current status>]]` and you will be re-invoked shortly, with this conversation intact, to check again and take the next action. Loop that way across the whole cascade. Emit `[[WATCH_DONE]]` only once the PR(s) are merged AND confirmed live — not at merge.',
    '',
    '**6. Close the loop on Linear, if there is a card.** Not every piece of work has one — a handoff straight from a laptop often does not, and that is fine. If this work DOES have a Linear issue, leave a short comment on it once the change is live: what merged, and what you actually verified in production. `LINEAR_API_KEY` is already set in your environment and is scoped to the assignee, so you are commenting as them; find the current way to post it. Keep it to what a teammate reading the card next week would need.',
    '   **Do not change the card\'s status and do not mark it Done** — that transition belongs to a human, who may be tracking release or sign-off state you cannot see. Comment, and leave the status alone.',
    '',
    'If the PRs depend on each other, order them accordingly: merging one moves the base under the others, so expect to re-sync and ride out another cycle. That is normal.',
    '',
    'You are authorised to do whatever this task legitimately requires — ready, sync, comment, commit, and merge these PRs — overriding any general note about not pushing or merging. Bias hard toward finishing alone. Pull the developer in ONLY for a genuine decision the handoff does not already answer, or when a PR simply cannot be made mergeable: end that reply with `MERGE_BLOCKED: <what is needed, and the options>`, summarised well enough that they can decide without re-reading the PR. When it is done, report the final state of each PR and what you verified in production.',
  ].join('\n');
}
