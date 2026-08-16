# Handoff skill (install on the laptop)

The laptop half of `POST /api/handoff`. Your local Claude session finishes a piece of work, packages
the PR plus everything it learned while doing it, and hands it to the autofix box — which drives
Greptile → CI → merge → deploy → live check on its own, and only comes back for a real decision.

The box half lives in `chat/handoff.mjs` + `chat/server.mjs`; nothing here runs on the box.

## Install

```bash
# on the laptop
mkdir -p ~/.claude/skills/handoff
scp -i ~/.ssh/agentweb-test-env-harshit.pem \
  ec2-user@<box-ip>:/home/ec2-user/agentweb/.linear-autofix/handoff-skill/{SKILL.md,send-handoff.sh} \
  ~/.claude/skills/handoff/
chmod +x ~/.claude/skills/handoff/send-handoff.sh

# set the owner once (see autofix-handoff.conf.example)
printf 'AUTOFIX_OWNER=%s\n' 'you@argusoft.com' > ~/.autofix-handoff.conf
```

Then say "hand this off" in a session where the work is done.

## Transport

Two paths, tried in order — no ports are opened and no auth layer is added, because the chat server
binds `127.0.0.1` with no auth by design.

1. **`http://localhost:8790`** — free whenever you are already connected with
   `ssh -i <key> -L 8790:localhost:8790 ec2-user@<ip>`, since that forward makes the laptop's 8790
   the box's chat server. This is the normal case: no key, no IP, no second connection.
2. **one-shot `ssh … 'curl …'`** — when no tunnel is open. Uses `AUTOFIX_HOST` / `AUTOFIX_KEY`.

**The public IP changes on every stop/start.** Path 1 doesn't care. Path 2 does, and prints the
`aws ec2 describe-instances` command for the current one when it can't connect.

## Attribution

The payload's `email` is the whole of it — it picks the GitHub token, git identity, and Linear key
the box acts with. Set `AUTOFIX_OWNER` once; the skill reads it and never asks again. It must be
someone on the box's roster (`config.assigneeGitIdentity`), and a wrong value cannot be corrected
after the PR is merged.

## What gets rejected

The endpoint validates before burning an agent turn, and every message says what to fix:

| Rejection | Why |
|---|---|
| unknown owner | no GitHub token or git identity exists for that email |
| no `prUrl` | the merge drive is scoped to named PRs and never discovers one |
| not a github.com PR URL | a malformed URL would point the drive at nothing |
| branch missing / `main` / starts with `-` | it goes into `git fetch` and `worktree add -B` |
| branch not on origin | the box builds its worktree from `origin/<branch>` — push first |
| context under 400 chars | a thin document defeats the entire feature |

Request bodies are capped at 16 MB for this route (real handoff documents run past 200 KB).
