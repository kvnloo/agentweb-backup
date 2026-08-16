---
name: handoff
description: Hand finished work to the autofix box so it drives the merge without you — Greptile rounds, CI, merge, deploy, and the live check. Use when the code is done and only the merge cascade is left, e.g. "hand this off", "merge this while I'm out", "get this merged, I'm heading home", "ship this once it's green".
---

# Handoff

Everything before a merge needs the developer. Everything after it is waiting: Greptile drips
comments one at a time, CI runs 20+ minutes, a deploy queues, and only then can anything be checked
live. That's hours of babysitting that only occasionally needs a human answer.

This skill packages the work — PR plus everything you currently know about it — and hands it to a
long-running agent on the autofix box, which drives the rest and only comes back for a genuine
decision. The laptop can close.

**The context document is the whole point.** The agent will face Greptile comments arguing about
approach; it can answer them without waking the developer *only* if you wrote down why the approach
is what it is. A thin document is the one way this feature fails, and the box refuses handoffs under
400 characters for exactly that reason.

## 1. Preflight — do not skip

The handoff is rejected without these, and each check is cheaper now than a confused agent later.

1. **Everything is committed.** `git status --short` is clean of the work. Uncommitted changes are
   invisible to the box and will simply be lost.
2. **The branch is pushed.** `git push`. The box builds its worktree from `origin/<branch>`; an
   unpushed branch fails the call.
3. **A PR is open**, and you have its URL. Open one if not (`gh pr create`). The merge drive is
   scoped to the PR you name and is deliberately forbidden from discovering PRs, so there is no
   "it'll find it" — no PR means no handoff.
4. **Work spanning both repos needs both PRs.** `agentweb` and `agentweb-customer-portal` are
   separate repos; pass both URLs and the agent handles them in dependency order.
5. **Checks you can run in seconds, run now** (`npx tsc`, the tests you touched). Letting CI find a
   type error costs a 20-minute round trip.

If any of these fail, fix it and tell the developer what you did — don't hand off broken.

## 2. Write the context document

Write it from what is *actually in your context right now* — the discoveries, dead ends, and
judgment calls of this session. This is not a summary of the diff; the agent can read the diff. It is
everything the diff cannot tell it.

Use this structure. Keep every section concrete: real file paths, real identifiers, real numbers.

```markdown
## START HERE
One paragraph: what this PR does, what state it's in, and what you need to do with it.

## What changed and why
The problem, the root cause, and the shape of the fix. Name files and functions.
If it fixes a bug, say how the bug actually happened — not just what the symptom was.

## Decisions taken, and the alternatives rejected
THE MOST IMPORTANT SECTION. For each real choice: what was chosen, what else was
considered, and why it lost. Greptile's "why did you do it this way?" comments are
answerable from here, and that is the difference between the agent finishing alone
and it having to wake the developer.

## Known trade-offs and deliberate non-goals
What this knowingly does not do, and why that was the right call. Prevents the agent
"fixing" something that was intentional.

## Verified vs assumed
Split it honestly. What did you actually run or observe, and what do you merely believe?
The agent must not repeat an assumption as a fact to a reviewer.

## Files and areas touched
A short map, with a line on why each was touched. Orientation, not a changelog.

## Gotchas
Anything that looks wrong but isn't. Surprising constraints. Things that bit you.

## If Greptile raises X
Pre-empt the objections you expect. You know this code better right now than anyone
will later — spend the effort here and the agent almost never needs the developer.
```

Length follows the work: a one-file fix might be 60 lines, a cross-repo feature several hundred.
Existing handoffs on the box run past 200 KB. Never pad, and never compress away a reason.

## 3. Send it

The `email` field is the owner, and it is the only thing that decides attribution — it selects the
GitHub token the merge commits and Greptile replies come from, plus the git identity and Linear key.
Read it from `AUTOFIX_OWNER` in `~/.autofix-handoff.conf`. If that file has no owner, ask the
developer once and offer to write it there so it never has to be asked again. **Never guess it** —
the wrong owner attributes the work to the wrong person, and that cannot be corrected after the fact.

```bash
# Build the payload in a file — the context is large and must not go through shell quoting.
cat > /tmp/handoff.json <<'JSON'
{
  "email": "<owner@argusoft.com>",
  "prUrl": "https://github.com/AgentWebPro/agentweb/pull/1234",
  "branch": "<the PR's head branch>",
  "title": "<short, what the work does>",
  "context": "<the full markdown document, JSON-escaped>"
}
JSON

bash <path-to-this-skill>/send-handoff.sh < /tmp/handoff.json
```

Build the JSON programmatically rather than by hand — the document contains quotes, newlines, and
backticks that must be escaped properly. In practice: write the markdown to a file, then use a
one-liner (`python3 -c` / `node -e`) to read both and emit the JSON.

A `202` returns `{ identifier, handoffPath, prs, branch, owner }`. Anything else is a rejection whose
message says exactly what to fix — fix it and retry rather than reporting failure.

## 4. Report back

Tell the developer, in one short block:

- the chat id (e.g. `CHAT-12`) and that it's now driving the merge autonomously
- the PR(s) handed off
- **anything you could not put in the document** — an open question, a decision you made under
  uncertainty, a check you skipped. This is their last chance to correct course before they walk away.

Then say how to watch it: the chat UI at `http://localhost:8790` while their SSH tunnel is up. The
agent works the PR through Greptile, CI, merge, deploy, and a live check, and comes back only if it
hits a genuine decision (it ends that turn with `MERGE_BLOCKED:` and waits).

## What this skill must never do

- **Never hand off uncommitted or unpushed work.** It is silently lost.
- **Never invent the owner email.** Wrong owner means commits attributed to the wrong person.
- **Never write a thin document to get past the length check.** Padding defeats the entire feature —
  the agent will escalate constantly, which is worse than not handing off at all.
- **Never claim something is verified that you did not verify.** The agent repeats this to reviewers.
