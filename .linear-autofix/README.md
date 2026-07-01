# Linear → Claude auto-fix

A local poller that watches Linear for new `Bug` issues and, for each one:

1. Assembles the **full project** into an isolated workspace — all repos, nested exactly like your local checkout (so Claude has cross-repo context).
2. Runs Claude Code (`claude -p`) on **your Claude subscription** to investigate and fix the bug.
3. Opens a **draft PR in each repo it changed** (backend/partner-portal and/or customer-portal).
4. Comments the PR link(s) back on the Linear issue.

Nothing is auto-merged. If Claude can't confidently fix a bug, it posts its investigation as a Linear comment instead of opening a PR.

> Runs on your subscription quota (no per-token API charge) because it's the Claude Code
> CLI on your own machine — the only compliant way to use subscription quota for automation
> (CI/GitHub Actions would require an API key).

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

## Schedule it (cron, every 5 minutes)

```cron
*/5 * * * * /usr/bin/env bash /home/harshit/IdeaProjects/Agentweb/agentweb/.linear-autofix/run.sh
```

## How issues flow

| Step | Linear state |
|---|---|
| Poller picks up `Bug` issues in a backlog/unstarted state | → **In Progress** (so it's not picked up twice) |
| Draft PR(s) opened | PR link(s) commented + → **In Review** (if that state exists) |
| Can't fix / no change | Comment posted; issue stays **In Progress** for a human; workspace kept for inspection |

A local `state.json` (gitignored) is a secondary guard against reprocessing.

## Models / cost

Defaults to **Sonnet** to conserve subscription quota. Add an `opus` (or `hard` / `complex`)
label to a Linear issue to use **Opus** for that one. Workspaces live in
`../autofix-worktrees/<id>/` outside the repos. Heavy bug days draw on the same quota pool as
your own interactive Claude use.

## Local full-copy preview (per bug)

Every bug gets a **full running copy of the app** (backend + customer-portal + partner-portal)
from its worktree, on its own ports, reachable through one proxy via nip.io — so you (or
Playwright) can exercise the fix in a real browser. No new EC2; it all runs on this machine.

```bash
# 1. start the proxy once (leave it running)
node .linear-autofix/preview/proxy.mjs            # listens on :8080

# 2. bring up a full copy for a bug's worktree
node .linear-autofix/preview/preview.mjs up LIN-123 ../autofix-worktrees/LIN-123
#   Customer portal: http://lin-123.192.168.29.76.nip.io:8080/
#   Partner portal:  http://lin-123-admin.192.168.29.76.nip.io:8080/
#   Backend API:     http://lin-123-api.192.168.29.76.nip.io:8080/

# 3. open the customer URL in your browser to confirm it loads, then tear down
node .linear-autofix/preview/preview.mjs down LIN-123
node .linear-autofix/preview/preview.mjs list
```

- `node_modules` is symlinked and `.env`/`.env.local` copied from your local repos into the worktree, so copies boot fast with your dev config (the backend needs your local AWS dev creds).
- Set `PREVIEW_IP` (default `192.168.29.76`) for a different reachable IP (e.g. `127.0.0.1` for this-machine-only).
- **Browser verification (wired in):** after a fix opens a PR, `autofix.mjs` auto-starts the proxy, brings up the full preview, runs a Playwright verify pass (`claude -p` with a Playwright-only MCP config) that drives a real browser to confirm the bug is gone, then tears the preview down and attaches the verdict + screenshots to the draft PR and the Linear comment. The PR opens regardless of the verdict. Toggle with `config.verify.enabled`; test creds + model live in `config.verify`.

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
| `config.mjs` | All tunables (label, team, repos, models, states, paths) |
| `linear.mjs` | Linear GraphQL client (read issue, list bugs, comment, move state) |
| `autofix.mjs` | One bug, end to end — also `node autofix.mjs LIN-123` by hand |
| `poll.mjs` | Finds new bugs, runs `autofix.mjs` per bug |
| `gc.mjs` | Removes kept worktrees once their Linear issue is Done/Canceled |
| `prompt.md` | The fixer prompt (full-project context + CLAUDE.md TDD + per-repo draft PRs + can't-fix path) |
| `run.sh` | One poll cycle with a lock; wire to cron |
| `preview/proxy.mjs` | Userspace host-based reverse proxy (nip.io → per-bug ports), no sudo |
| `preview/preview.mjs` | Start/stop a full app copy per bug from its worktree |
| `verify-prompt.md` | Browser-verification prompt (drives the Playwright MCP, emits a verdict) |
| `verify-mcp.json` | Playwright-only MCP config for the headless verify pass |
