# Prompt for a teammate setting up the handoff skill on their own laptop

Generic version — nothing in it is specific to one person's machine. The skill asks for whatever it
needs (owner email, SSH key, box IP) rather than assuming.

**Before pasting, the teammate needs:** SSH access to the autofix box (their own `.pem`), and to know
which roster email is theirs — that decides whose GitHub token and git identity the box commits as.

---

Build me a Claude Code skill called `autofix-handoff` at `~/.claude/skills/autofix-handoff/`.

## Background — what this is for

When I finish a piece of work, the only thing left is the merge cascade: Greptile review rounds, a
20+ minute CI run, a merge, a deploy, then a live check on production. That is hours of waiting that
only occasionally needs a human answer, and it does not need my laptop open.

We run a long-lived agent on an EC2 box (the "autofix box") that does exactly this. The skill's job
is to package finished work — the PR plus everything my session knows about it — and hand it over.
The box then drives Greptile → CI → merge → deploy → live production verification autonomously, and
comes back only for a genuine decision.

**Two things decide whether this works at all. Put both in SKILL.md prominently.**

**(a) Handing off ARMS THE MERGE.** There is no confirmation step on the far side: the moment the
handoff lands, the agent starts driving that PR toward production and will merge the instant the
gates are green, without asking anyone. A handoff is not "park this somewhere" — it is "ship this".
Never hand off work I called partial, experimental, WIP, a spike, or wanting my review first. If
there is any doubt that the work is final, ask me before sending, not after.

**(b) The context document is the point.** The remote agent will face Greptile comments arguing about
approach. It can answer them without waking me *only* if my session wrote down why the approach is
what it is. A thin document silently defeats the feature — the agent escalates constantly and I would
have been better off not handing off. Never pad it to clear the length check.

## Setup this skill must do on first use

These are per-person, so **ask me rather than guessing**, then persist to `~/.autofix-handoff.conf`
(shell `KEY=value`) so I am never asked twice:

| key | what it is |
|---|---|
| `AUTOFIX_OWNER` | **My** email on the box's roster — currently `mvarma@argusoft.com` or `aseth@argusoft.com`. This picks the GitHub token, git identity and Linear key the box acts with, so wrong attribution cannot be corrected after a merge. **Never guess this.** |
| `AUTOFIX_KEY` | path to my SSH private key for the box, e.g. `~/.ssh/<something>.pem` |
| `AUTOFIX_HOST` | the box's current public IP |
| `AUTOFIX_PORT` | `8790` (default) |

If any is missing when the skill runs, ask me for it and write it to the config.

## The API it talks to

`POST /api/handoff` on the box's chat server (port 8790). JSON body:

| field | required | notes |
|---|---|---|
| `email` | yes | the owner — use `AUTOFIX_OWNER`. Must be a configured roster member. |
| `prUrl` | yes | a `https://github.com/<owner>/<repo>/pull/<n>` URL, or an **array** for work spanning both repos. |
| `branch` | yes | **the PR's actual head branch** — the server looks it up and rejects a mismatch, because the agent's worktree is built from this and its fixes would otherwise land on a branch the PR never sees. Must exist on origin. Letters/digits/`.`/`_`/`/`/`-` only; cannot start with `-`; cannot be `main`/`master`/`develop`. |
| `title` | no | short description; falls back to `Merge #N`. |
| `context` | yes | the markdown handoff document. **Minimum 400 characters** — the server rejects anything thinner. |
| `dryRun` | no | `true` runs every check for real and returns 202 **without creating anything or arming a merge**. |

Responses:

- **202, real** → `{ identifier, turnId, handoffPath, prs, branch, owner }`. `identifier` is the chat id, e.g. `CHAT-12`.
- **202, dry run** → `{ dryRun: true, wouldCreate, prs, branch, title, owner, note }`. Note the shapes
  differ: a dry run has no `identifier`/`handoffPath` (nothing was created), a real one has no
  `wouldCreate`/`title`. Branch on `dryRun` being present, and never read a field from the wrong shape.
- **400** → `{ error }`, always phrased so it can be fixed and retried. Do not report failure to me
  without trying the fix — "branch is not on origin" means push and retry; a branch/PR mismatch means
  the wrong branch name was sent for that PR.
- **409** → this branch is **already handed off**, and the error names the chat that owns it. Do not
  start a second one — two agents on one PR race each other. Tell me the existing chat id instead.
- Bodies are capped at 16 MB, so a large document is fine.

## Transport

The box's chat server binds `127.0.0.1` only, with no auth layer, deliberately. Two paths, in order:

1. **`http://localhost:$AUTOFIX_PORT`** — when I am connected with
   `ssh -i $AUTOFIX_KEY -L 8790:localhost:8790 ec2-user@$AUTOFIX_HOST`, that forward makes my laptop's
   8790 the box's chat server. Needs no key and no IP. **Try this first**, probing `GET /api/health`.
2. **One-shot SSH** when no tunnel is up:
   `ssh -i $AUTOFIX_KEY ec2-user@$AUTOFIX_HOST 'curl -sS -XPOST localhost:8790/api/handoff -H "content-type: application/json" --data-binary @-' < payload.json`

**The box's public IP changes every time the instance is stopped and started.** Path 1 does not care;
path 2 does. So when SSH cannot connect, say so clearly and print how to get the current IP rather
than failing opaquely:
`aws ec2 describe-instances --instance-ids i-0cb38aac2332941dc --query 'Reservations[].Instances[].PublicIpAddress' --output text`
(If I do not have AWS access, tell me to ask a teammate for the current IP.)

## What the skill must do

**1. Preflight — refuse to hand off broken work.** This ships straight to production, so it is not a
formality. Everything committed; branch pushed and present on origin; a PR open (open one if not);
both PRs if the work spans `agentweb` and `agentweb-customer-portal`; and run the cheap checks now
(`npx tsc --noEmit`, the tests covering what I touched) rather than letting CI find a type error 20
minutes later. Fix what you can and tell me what you did.

**2. Write the context document** from what is actually in this session's context right now — the
discoveries, dead ends and judgement calls that happened here. **Not a summary of the diff**; the
agent can read the diff. Everything the diff cannot tell it. Write it to a file, with sections:

- **START HERE** — what this PR does, what state it is in, what still needs doing.
- **What changed and why** — problem, root cause, shape of the fix, real file and function names.
- **Decisions taken, and the alternatives rejected** — *the most important section.* For each real
  choice: what was chosen, what else was considered, why it lost. Greptile's "why did you do it this
  way?" comments are answered from here; this is the difference between the agent finishing alone and
  it waking me.
- **Known trade-offs and deliberate non-goals** — so the agent does not "fix" something intentional.
- **Verified vs assumed** — split honestly. The agent repeats this to reviewers, so anything under
  "verified" becomes a claim made on my behalf. When in doubt, it is assumed.
- **Files and areas touched** — a short map, one line each on why.
- **Gotchas** — what looks wrong but is not; surprising constraints.
- **If Greptile raises X** — pre-empt the objections you expect; this session knows the code better
  now than anyone will later.

Length follows the work — ~60 lines for a one-file fix, several hundred for a cross-repo feature.
Never pad, never compress away a reason.

**3. Build the payload programmatically.** The document contains quotes, newlines and backticks that
must be escaped properly, so never hand-build the JSON in a shell string — write the markdown to a
file, then read both in `python3`/`node` and emit JSON.

**4. Dry-run first, then send for real.** Post with `"dryRun": true`, which validates everything and
creates nothing. On a dry-run 202, report `wouldCreate` and the echoed fields to me, confirm, then
re-post the **identical** payload with the `dryRun` key removed — do not rebuild it, since a dry run
only proves the payload it was given.

**5. Report back**, briefly: the chat id, the PR(s), and — most important — **anything that could not
go in the document**: an open question, a decision made under uncertainty, a check skipped. That is my
last chance to correct course before I walk away, so do not bury it. Then tell me I can watch it at
`http://localhost:8790` while my tunnel is up, and that the agent ends a turn with `MERGE_BLOCKED:`
and waits if it needs me.

## Hard rules

- Never hand off uncommitted or unpushed work — it is silently invisible to the box.
- Never guess the owner email.
- Never pad the document to clear the 400-character check.
- Never claim something is verified that was not verified — the agent repeats it to reviewers as fact.
- Never send a second handoff for a branch that returned 409.
- Never real-send without a passing dry run.
- Never hand off work that is not final. If unsure, ask first.

## Deliverables

- `~/.claude/skills/autofix-handoff/SKILL.md` — YAML frontmatter with `name: autofix-handoff` and a
  `description` that triggers on "hand this off", "merge this while I'm out", "get this merged, I'm
  heading home", "ship this once it's green", "take it from here".
- `~/.claude/skills/autofix-handoff/send-autofix-handoff.sh` (executable) — reads the JSON payload on
  stdin, passes it through **unchanged** (it must not strip unknown keys like `dryRun`), tries
  localhost then falls back to SSH, prints the response, and exits non-zero with a readable message on
  rejection. Distinct exit codes for accepted / rejected / duplicate / bad payload / no transport.
- `~/.autofix-handoff.conf` with whatever I gave you.

Then show me the SKILL.md, and confirm the script handles a bad payload with a readable rejection
rather than a stack trace. Use a dry run to prove the success path — it creates nothing, so it is safe
to run even on unfinished work.
