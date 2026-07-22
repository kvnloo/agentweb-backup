# Linear → Claude auto-fix

A local poller that watches Linear for new `Bug` issues and, for each one:

1. Assembles the **full project** into an isolated workspace — all repos, nested exactly like your local checkout (so Claude has cross-repo context).
2. Runs Claude Code (`claude -p`) on **your Claude subscription** to investigate and fix the bug — the fixer only **commits** (no PR yet).
3. **Reviews the fix** with a multi-agent gate: expert reviewers (correctness, conventions, security, tests — lenses auto-scaled to the diff) inspect the diff in parallel, a **manager** adversarially verifies their findings, and a **re-fix** pass applies the confirmed ones. A `needs_rework` verdict triggers one **rework pass + manager re-check**.
4. Runs **deterministic checks itself** (`npx tsc --noEmit` per changed package with a 4GB heap, `npx jest <changed test files>` in backend) — agent self-reported "pass" is never trusted alone.
5. **Browser-tests** the reviewed code in a real browser (Playwright) against a per-bug preview. A deterministic HTTP **preflight** skips the agent entirely if the environment is down (`env_down`); a `not_fixed` verdict triggers one **re-fix + re-verify**. Then opens a **draft PR in each repo it changed**.
6. **Triages** the result with a label (`autofix:green` / `autofix:needs-manual-test` / `autofix:needs-rework`) and comments back on the Linear issue: a merge-confidence header, PR link(s), a 🧪 test report with the **verify session recording (video) and screenshots embedded**, a 🔎 code-review summary, and a 🔍 manual-test guide. Only **green** advances to In Review.

Nothing is auto-merged. If Claude can't confidently fix a bug, it posts its investigation as a Linear comment instead of opening a PR (label `autofix:cannot-fix`).

## Triage: what to do with each label

| Label | Meaning | What you do |
|---|---|---|
| `autofix:green` | review sound + verified in a **real browser** + deterministic checks pass → moved to **In Review** | Skim the PR, merge. No manual testing. |
| `autofix:needs-manual-test` | fix committed but not browser-verified (env down / inconclusive / api-only) — stays **In Progress** | Run the 🔍 manual steps from the comment, then merge. |
| `autofix:needs-rework` | a gate failed (manager `needs_rework`, browser `not_fixed`, or a check failed) — stays **In Progress** | Real human work; the draft PR is a starting point. |
| `autofix:cannot-fix` | no fix produced; investigation posted | Triage by hand. |
| `autofix:blocked` | fixability gate: blocked on an EXTERNAL action (disconnected account, pending credentials, someone's to-do) — no fix attempted, issue **stays in Todo** | Resolve the blocker, then remove the label; the poller picks it up next cycle. |

## Revisions: steering a fix without opening an editor

Comment **`revise: <what to change>`** on a fixed issue (e.g. `revise: also cover the empty-cart
case and rename the flag`). The next poll cycle applies it to the existing branch in the kept
workspace (rebuilt from the pushed branch if needed), pushes to the open PR(s), re-runs the
deterministic checks, and comments the result back. Tunables in `config.revise`.

> Runs on your subscription quota (no per-token API charge) because it's the Claude Code
> CLI on your own machine — the only compliant way to use subscription quota for automation
> (CI/GitHub Actions would require an API key).

## Chat UI: talk to the agent that made the fix

A local web UI (`chat/`) to chat about any issue the machine is handling — the interactive
sibling of `revise:`. Open an issue and you first see **every step the automation took**
(fixability gate, fixer, review lenses, manager verdict, re-fix, checks, browser verify —
each expandable to that agent's full report). Below it, ONE conversation — no mode toggle.
The first message **resumes the pipeline's own Claude session** (per-stage session ids are
recorded in `state.json`), so the agent natively remembers investigating and making the fix;
if that session is gone it falls back to a fresh one with the issue + pipeline context injected.

What a message may do follows the environment, not a switch:

- **Full access** (on the runner: `AUTOFIX_RUN_ENABLED=1`, pipeline not mid-run on the issue,
  fix branch exists): ask anything, or request changes — the agent edits the issue's branch in
  its worktree, verifies its own work (`npx tsc`, targeted tests), commits, and the server
  **auto-pushes to the open PR(s)**. Takes a per-issue lock (`chat/locks/<ID>.lock`) that
  `gc.mjs` respects. The full review/browser gates are NOT re-run — you're already in the loop.
- **Read-only** (anywhere else, or while the pipeline owns the issue): the agent answers from
  the workspace and pipeline logs but cannot change code — enforced by a tool allowlist
  (`config.chat.readOnly.allowedTools`), no permissions bypass, anything else auto-denies.
  The composer shows which level you're at and why.

The header also has an **Enable preview / Disable preview** button per issue: it drives
`preview/preview.mjs up|down` (starting the proxy if needed) and shows the live
Customer / Partner / API links right there once the services are up. Same nip.io URLs and
build-lock behavior as the pipeline's own previews.

```bash
chat/run-chat.sh start                          # on the runner (long-running, like the proxy)
ssh -L 8790:localhost:8790 ec2-user@<ip>        # from your laptop
# → http://localhost:8790
```

Binds `127.0.0.1` only, no auth layer — anyone with SSH to the box already has this access.
Chat transcripts persist in `chat/chat-state.json`; raw turn logs land in `logs/<ID>/chat-*.txt`.
Tunables in `config.chat`.

## Repositories (full-project workspace)

The AgentWeb checkout is **two separate git repos**, and the workspace reproduces that layout:

```
../autofix-worktrees/LIN-123/         <- main repo (AgentWebPro/agentweb)
├── backend/
├── partner-portal/
├── CLAUDE.md
└── customer-portal/                  <- customer-portal repo (AgentWebPro/agentweb-customer-portal), nested
    └── src/ ...
```

Claude works at the workspace root with both repos visible, fixes wherever the bug lives
(one repo or both), and opens a draft PR per changed repo — each PR lands in the correct
GitHub repo because `gh` is run from inside that repo's directory. Edit the repo list/paths
in `config.mjs` if the layout changes.

## One-time setup

1. **Node 18+** and the **`claude` CLI** logged in to your Claude subscription (run `claude`, then `/login`).
2. **GitHub CLI** authed with `repo` scope on **both** repos, and git wired to it:
   ```bash
   gh auth status
   gh auth setup-git      # lets `git push` use your gh credentials
   gh repo view AgentWebPro/agentweb-customer-portal --json viewerPermission  # confirm WRITE/ADMIN
   ```
3. The **customer-portal repo is cloned** at `./customer-portal` (it already is in your setup).
4. Create the env file (gitignored):
   ```bash
   cp .linear-autofix/.env.example .linear-autofix/.env
   # then edit it and paste your Linear personal API key (lin_api_...)
   ```
5. Review **`config.mjs`** — `bugLabel`, optional `teamKey`, the `repos` list, model defaults, and the Linear workflow state names (`inProgressState`, `reviewState`).

## Where it runs: EC2 only

Real fixes are gated by `AUTOFIX_RUN_ENABLED=1` in `.linear-autofix/.env` — set it **only on
the designated EC2 runner** (see `deploy/ec2/RUNBOOK.md`). On any other machine the poller,
autofix, and revise entrypoints refuse to run (dry-runs still work anywhere), so a laptop
can't accidentally burn quota or post to Linear.

## Run ONE bug by hand first (recommended)

```bash
set -a; . .linear-autofix/.env; set +a
node .linear-autofix/autofix.mjs LIN-123 --dry-run   # preview: workspace + repos + model + branch
node .linear-autofix/autofix.mjs LIN-123             # do it for real
```

Watch it: assemble workspace → investigate (full context) → fix → tests → draft PR(s) → Linear comment.

## Run the poller

```bash
bash .linear-autofix/run.sh
```

## Schedule it (cron, every 5 minutes) — INSTALLED

```cron
*/5 * * * * /usr/bin/env bash /home/ec2-user/agentweb/.linear-autofix/run.sh
```

This entry is installed in the local crontab (check with `crontab -l`). Each cycle: fix issues
carrying the `autofix` label (`config.requireForceLabel` — no autonomous pickup of un-labelled bugs),
recover crashed runs, apply pending `revise:` comments, then gc worktrees for Done issues.
`poll.log` auto-rotates at ~5MB.

## How issues flow

| Step | Linear state |
|---|---|
| Poller picks up issues carrying the **`autofix` label** (`config.forceLabel`, gated by `config.requireForceLabel`) in a backlog/unstarted state **assigned to one of `config.assigneeEmails`** (Manan / Anurag; unassigned bugs are skipped). Without the label nothing is picked up. | picked up |
| **Fixability gate** (cheap Sonnet pass over the issue text): blocked on an external action? | Blocked → `autofix:blocked` + comment, stays **Todo**, skipped until the label is removed. Fixable → **In Progress** (so it's not picked up twice) |
| Fix committed, ALL gates green incl. real-browser verify | PR link(s) + reports commented + `autofix:green` + → **In Review** |
| Fix committed but not browser-verified | Draft PR opened + `autofix:needs-manual-test`; stays **In Progress** |
| A gate failed (`needs_rework` / `not_fixed` / check failed) | Draft PR flagged `[needs human]` + `autofix:needs-rework`; stays **In Progress** |
| Can't fix / no change | Comment posted + `autofix:cannot-fix`; stays **In Progress**; workspace kept |
| Crashed run (a run **autofix started** sat In Progress `staleInProgressHours` with no result) | Reset to Backlog for ONE retry; a second crash is flagged for a human. Issues a human moved to In Progress are never touched. |

A local `state.json` (gitignored) is a secondary guard against reprocessing. Raw per-stage
transcripts + metadata (turns, duration, timeouts) land in `.linear-autofix/logs/<ID>/` for
debugging and budget tuning.

## Models / cost

The fixer, manager, re-fix/rework passes, and browser verify run on **Opus**; the four lens
reviewers run on **Sonnet** (`review.model`) — the Opus manager adversarially filters their
findings anyway, so cheap reviewers cost little quality and save ~4 Opus runs per bug.
`review.autoScaleLenses` additionally skips lenses that can't apply to the diff (security on
docs/styles-only diffs; tests when neither backend logic nor tests changed). Everything draws on
the same subscription quota pool as your interactive Claude use. Set `review.enabled: false` to
revert to the lean fix→verify→PR flow. Workspaces live in `../autofix-worktrees/<id>/` outside
the repos.

## Local full-copy preview (per bug)

Every bug gets a **full running copy of the app** (backend + customer-portal + partner-portal)
from its worktree, reachable through a proxy via nip.io — so you (or Playwright) can exercise
the fix in a real browser. The **port picks the portal** (5173 partner / 5174 customer / 3001
API) and the **bug-id host picks the bug**, so many bugs coexist. No new EC2; it all runs on
this machine.

```bash
# 1. start the proxy once (leave it running)
node .linear-autofix/preview/proxy.mjs            # listens on :5173 :5174 :3001

# 2. bring up a full copy for a bug's worktree
node .linear-autofix/preview/preview.mjs up LIN-123 ../autofix-worktrees/LIN-123
#   Partner portal:  http://lin-123.192.168.29.76.nip.io:5173/
#   Customer portal: http://lin-123.192.168.29.76.nip.io:5174/
#   Backend API:     http://lin-123.192.168.29.76.nip.io:3001/

# 3. open the customer URL in your browser to confirm it loads, then tear down
node .linear-autofix/preview/preview.mjs down LIN-123
node .linear-autofix/preview/preview.mjs list
```

- **Watcher-free:** the portals are `vite build`-once + `vite preview` (static) and the backend is
  plain `ts-node --transpile-only` — no HMR, no chokidar, **zero inotify watches**. Dev servers per
  kept preview used to exhaust `fs.inotify.max_user_watches` and 502 every verify run (that killed
  ENG-123's verification). Kept previews are now cheap; still, raising the kernel limits is a good
  belt-and-suspenders: `sudo sysctl fs.inotify.max_user_watches=1048576 fs.inotify.max_user_instances=1024`
  (persist in `/etc/sysctl.d/90-autofix.conf`).
- `node_modules` is symlinked and `.env`/`.env.local` copied from your local repos into the worktree, so copies boot fast with your dev config (the backend needs your local AWS dev creds).
- Set `PREVIEW_IP` (default `127.0.0.1`) to a LAN IP to reach previews from another device.
- **Browser verification (wired in):** after a fix passes the code-review gate, `autofix.mjs` auto-starts the proxy, brings up the full preview, and **preflights it with plain HTTP checks** — if the environment isn't healthy it retries the bring-up once, then records `env_down` and skips the agent run instead of burning a 12-min pass against a dead env. When healthy, a Playwright verify pass (`claude -p` with a Playwright-only MCP config) drives a real browser to confirm the bug is gone — *then* the draft PR(s) open with the verdict + screenshots attached. A `not_fixed` verdict triggers ONE re-fix + re-verify (`verify.retryNotFixed`). Toggle with `config.verify.enabled`.

## Testing a fix (after a PR opens)

With `cleanupWorktreeOnSuccess: false` (the default), each fixed bug's worktree is **kept** at
`../autofix-worktrees/<ID>/`, and the Linear/PR comment includes the commands. To try the fix
in a real browser:

```bash
node .linear-autofix/preview/proxy.mjs &                         # if not already running
node .linear-autofix/preview/preview.mjs up ENG-123 ../autofix-worktrees/ENG-123
# open the printed nip.io URL, test it, then:
node .linear-autofix/preview/preview.mjs down ENG-123
```

Worktrees accumulate (one per fixed bug). Remove one when you're done with it:

```bash
git -C customer-portal worktree remove --force ../autofix-worktrees/ENG-123/customer-portal
git worktree remove --force ../autofix-worktrees/ENG-123
```

**Automatic cleanup:** `gc.mjs` runs every poll cycle (via `run.sh`) and removes a kept worktree
as soon as its Linear issue reaches **Done/Canceled** (configurable via `gcDoneStateTypes`) — it
stops any running preview, removes both repos' worktrees + branches, and prunes the state entry.
So in normal use (merge PR → issue auto-moves to Done) you rarely clean up by hand.

(Set `cleanupWorktreeOnSuccess: true` if you'd rather have each worktree auto-removed the moment its PR opens, before you can test it.)

## Files

| File | Purpose |
|---|---|
| `config.mjs` | All tunables (label, team, repos, models, states, triage labels, checks, revise, paths) |
| `linear.mjs` | Linear GraphQL client (read issue, list bugs/stale, comment, move state, triage labels) |
| `autofix.mjs` | One bug, end to end — also `node autofix.mjs LIN-123` by hand |
| `poll.mjs` | Finds new bugs (parallel, priority-first), recovers crashed runs, dispatches revisions |
| `revise.mjs` | Applies human `revise:` comments to a fixed bug's branch/PR |
| `gc.mjs` | Removes kept worktrees once their Linear issue is Done/Canceled |
| `prompt.md` | The fixer prompt (full-project context + CLAUDE.md TDD + commit-only + can't-fix path) |
| `review-prompt.md` | Per-lens expert reviewer prompt (correctness / conventions / security / tests) |
| `manager-prompt.md` | Manager prompt that adversarially verifies the reviewers' findings |
| `refix-prompt.md` | Applies gate-verified findings (review, rework, or verify-failure) in the same worktree |
| `revise-prompt.md` | Applies human revision requests to the existing fix branch |
| `run.sh` | One poll cycle with a lock + log rotation; wired to cron |
| `chat/server.mjs` | Chat UI backend: issue list + SSE-streamed Ask/Fix turns that resume pipeline sessions |
| `chat/ui.html` | The chat UI (single static page, no build step) |
| `chat/run-chat.sh` | Start/stop the chat server (long-running; localhost-only, SSH tunnel to reach) |
| `chat/chat-state.json` | Per-issue chat sessions + transcripts (gitignored) |
| `preview/proxy.mjs` | Userspace host-based reverse proxy (nip.io → per-bug ports), no sudo |
| `preview/preview.mjs` | Start/stop a watcher-free full app copy per bug from its worktree |
| `verify-prompt.md` | Browser-verification prompt (drives the Playwright MCP, emits a verdict) |
| `verify-pw-config.json` | Playwright MCP config: records the verify session as video (recordVideo) |
| `.verify-mcp.generated.json` | Playwright-only MCP config, generated per verify run (gitignored) |
| `logs/<ID>/` | Raw per-stage transcripts + deterministic check output per bug (gitignored) |

## Security notes

The fixer runs `--dangerously-skip-permissions` with full Bash, **read-only prod DynamoDB
access**, and the Linear issue text injected into its prompt. The prompts instruct agents to
treat issue text as untrusted data and never paste prod PII anywhere, but that is soft
protection against prompt injection. Hardening that requires no code change here:

1. **Restrict who can apply the `Bug` label** in Linear (it is the automation's trigger) — e.g.
   don't let guests/customers set labels.
2. **Scope the AWS credentials/role** this machine uses to `dynamodb:GetItem`/`Query` on the
   specific `AW-*` tables only, and deny `Scan` — read-only creds are what make exfiltration of
   arbitrary customer data possible if an injected issue ever slips through.
3. PRs are always **draft** and nothing auto-merges — human review remains the final gate; skim
   PR bodies/comments for data that shouldn't be there before merging.
