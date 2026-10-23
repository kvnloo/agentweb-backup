## ENG-2637: same-day #feature-launches rollout-note draft script (2026-10-22)

`.github/scripts/rollout-note.sh` prints a DRAFT note of PRs merged to main and covered by a successful prod Deploy run on DATE (skips dependabot/chore/docs-only; empty day = no output). It never posts to Slack (ENG-2634). Run: `REPO=AgentWebPro/agentweb bash .github/scripts/rollout-note.sh`.
