# Prompt to give a local Claude session so it builds the handoff skill

Paste everything below the line into a Claude Code session on the laptop. It is self-contained —
nothing needs to be fetched from the box first.

---

Build me a Claude Code skill called `handoff` at `~/.claude/skills/handoff/`.

## What it's for

When I finish a piece of work on this laptop, the only thing left is the merge cascade: Greptile
review rounds, a 20+ minute CI run, a merge, a deploy, and then a live check on production. That's
hours of waiting that only occasionally needs a human answer, and it doesn't need my laptop open.

I run a long-lived agent on an EC2 box ("the autofix box") that does exactly this. The skill's job is
to package the finished work — the PR plus everything my session currently knows about it — and hand
it over. The box then drives Greptile → CI → merge → deploy → live verification autonomously, and
only comes back to me if it hits a genuine decision.

**The context document is the whole point of the skill.** The remote agent will face Greptile
comments arguing about approach. It can answer them without waking me *only* if my session wrote down
why the approach is what it is. A thin document silently defeats the feature — the agent escalates
constantly and I'd have been better off not handing off at all.

**Handing off ARMS THE MERGE IMMEDIATELY.** There is no confirmation step on the far side: the moment
the handoff lands, the agent starts driving that PR toward being merged and deployed to production,
and it will merge the instant the gates are green without asking anyone. So a handoff is not "park
this somewhere" — it is "ship this". Never hand off work I described as partial, experimental, or
wanting my review first; if there is any doubt about whether the work is final, ask me before sending
rather than after. That is also why the preflight below is not a formality.

## The API it talks to

`POST /api/handoff` on the box's chat server (port 8790). JSON body:

| field | required | notes |
|---|---|---|
| `email` | yes | the owner. Picks the GitHub token, git identity and Linear key the box acts with. Must be a configured member — currently `mvarma@argusoft.com` or `aseth@argusoft.com`. |
| `prUrl` | yes | a `https://github.com/<owner>/<repo>/pull/<n>` URL, or an array of them for work spanning both repos. |
| `branch` | yes | **the PR's actual head branch** — the server looks it up and rejects a mismatch, because the agent's worktree is built from this and its fixes would otherwise land on a branch the PR never sees. Must already exist on origin. Letters/digits/`.`/`_`/`/`/`-` only, can't start with a dash, can't be `main`/`master`/`develop`. |
| `title` | no | short description; falls back to "Merge #N". |
| `context` | yes | the markdown handoff document. Minimum 400 characters — the server rejects anything thinner. |

- **202** → `{ identifier, handoffPath, prs, branch, owner }`. `identifier` is the chat id, e.g. `CHAT-12`.
- **400** → `{ error }`, always phrased so you can fix it and retry. Don't report failure to me
  without trying the fix — e.g. "branch is not on origin" means push and try again, and a
  branch/PR mismatch means you sent the wrong branch name for that PR.
- **409** → this branch is already handed off, and the error names the chat that owns it. Do NOT
  start a second one: two agents on one PR race each other. Tell me the existing chat id instead.
- Request bodies are capped at 16 MB, so a large document is fine.

## Transport

The box's chat server binds `127.0.0.1` only, with no auth layer, deliberately. Two paths:

1. **`http://localhost:8790`** — I normally connect with
   `ssh -i ~/.ssh/agentweb-test-env-harshit.pem -L 8790:localhost:8790 ec2-user@<ip>`, and that
   forward makes my laptop's 8790 the box's chat server. When the tunnel is up this needs no key and
   no IP. **Try this first**, e.g. by probing `GET http://localhost:8790/api/health`.
2. **One-shot SSH** — when no tunnel is up:
   `ssh -i <key> ec2-user@<host> 'curl -sS -XPOST localhost:8790/api/handoff -H "content-type: application/json" --data-binary @-' < payload.json`

Config lives in `~/.autofix-handoff.conf` (create it if missing, shell `KEY=value` format):
`AUTOFIX_OWNER`, `AUTOFIX_HOST`, `AUTOFIX_KEY`, `AUTOFIX_PORT`. Defaults: host `54.148.185.209`,
key `~/.ssh/agentweb-test-env-harshit.pem`, port `8790`.

**The box's public IP changes every time the instance is stopped and started.** Path 1 doesn't care.
Path 2 does — so when it can't connect, say so clearly and print the command for the current IP
rather than failing opaquely:
`aws ec2 describe-instances --instance-ids i-0cb38aac2332941dc --query 'Reservations[].Instances[].PublicIpAddress' --output text`

## What the skill must do

**1. Preflight — refuse to hand off broken work.** (Remember this ships straight to production.) Everything committed; branch pushed; a PR open
(open one if not); both PRs if the work spans `agentweb` and `agentweb-customer-portal`; and run the
cheap checks now (`npx tsc`, the tests I touched) rather than letting CI find a type error 20 minutes
later. Fix what you can and tell me what you did.

**2. Write the context document** from what's actually in your context right now — the discoveries,
dead ends and judgement calls of this session. Not a summary of the diff; the agent can read the
diff. Everything the diff can't tell it. Sections:

- **START HERE** — what this PR does, what state it's in, what needs doing.
- **What changed and why** — problem, root cause, shape of the fix, with real file and function names.
- **Decisions taken, and the alternatives rejected** — the most important section. For each real
  choice: what was chosen, what else was considered, why it lost. Greptile's "why did you do it this
  way?" comments are answerable from here, and that's the difference between the agent finishing
  alone and it waking me.
- **Known trade-offs and deliberate non-goals** — so the agent doesn't "fix" something intentional.
- **Verified vs assumed** — split honestly. What did you actually run or observe, versus merely
  believe? The agent must never repeat an assumption to a reviewer as fact.
- **Files and areas touched** — a short map with a line on why each.
- **Gotchas** — what looks wrong but isn't; surprising constraints.
- **If Greptile raises X** — pre-empt the objections you expect. You know this code better right now
  than anyone will later.

Length follows the work — 60 lines for a one-file fix, several hundred for a cross-repo feature.
Never pad, never compress away a reason.

**3. Send it.** Build the JSON programmatically (write the markdown to a file, then use `python3 -c`
or `node -e` to read both and emit the JSON) — the document has quotes, newlines and backticks that
must be escaped properly, so never hand-build it in a shell string. Read the owner from
`AUTOFIX_OWNER`; if unset, ask me once and offer to write it to the config so it's never asked again.
**Never guess the owner** — wrong attribution can't be corrected after a merge.

**4. Report back**, briefly: the chat id, the PR(s), and — most important — **anything you couldn't
put in the document**: an open question, a decision made under uncertainty, a check you skipped. That
is my last chance to correct course before I walk away. Then tell me I can watch it at
`http://localhost:8790` while my tunnel is up, and that the agent will end a turn with
`MERGE_BLOCKED:` and wait if it needs me.

## Hard rules for the skill

- Never hand off uncommitted or unpushed work — it's silently invisible to the box.
- Never invent the owner email.
- Never pad the document to clear the 400-character check. Padding defeats the entire feature.
- Never claim something is verified that you didn't verify — the agent repeats it to reviewers.

## Deliverables

- `~/.claude/skills/handoff/SKILL.md` — YAML frontmatter with `name: handoff` and a `description`
  that triggers on things like "hand this off", "merge this while I'm out", "get this merged, I'm
  heading home", "ship this once it's green".
- `~/.claude/skills/handoff/send-handoff.sh` — reads the JSON payload on stdin, tries localhost then
  falls back to SSH, prints the response, and exits non-zero with a clear message on rejection.
- Create `~/.autofix-handoff.conf` if it doesn't exist, with `AUTOFIX_OWNER` set to
  `mvarma@argusoft.com`.

Then show me the SKILL.md you wrote and confirm the script runs (a bad payload should come back with
a readable rejection rather than a stack trace).
