# Cycle 249 — fail-closed-before-apply only helps GitHub merges; Sunday XFF drift is IdleTimeout class

**Date:** 2026-09-12T08:40:00Z
**Question:** Sunday never calls `eb-deploy.sh` (cycle 110),
so neither pre-update nor after-verify XFF pin runs on
weekly Immutable. Does fail-closed-before-apply only help
GitHub merges, leaving Sunday console XFF drift in the
same IdleTimeout class (cycle 242)?
**Answer:** **Yes.** Cycle 248’s fail-closed slot
(`ensure_termination_lifecycle_hook` at
`eb-deploy.sh` L655, before `update-environment`) runs only
when GitHub runs `eb-deploy.sh`. `deploy.yml` `on:` is
`push` to `main` and `workflow_dispatch` — **zero**
`schedule:`. `rg EventBridge` / `aws.events` in this tree
is empty. Sunday `InstanceRefreshEnabled` is Elastic
Beanstalk managed actions (`05-instance-recycling.config`
L8–13, `PreferredStartTime: "Sun:10:00"`). `deploy.yml`
L199–204: nothing in GitHub Actions starts that update; EB
does. Cycle 242: the ALB ARN stays across that weekly
Immutable, so console XFF drift survives the recycle the
same way IdleTimeout drift does — no script re-pins until
the next backend merge that actually calls the pin. Do
**not** un-park A-020 for a weekly XFF pin (A-020 is also
`eb-deploy.sh`, after GitHub verify, on the surviving **ASG**).
Do not add that pin from A-019. Do not disable
`InstanceRefreshEnabled`. Do not 503 `/health`. Do not add
A-021.

## Evidence

### GitHub never wakes on Sunday

```3:6:.github/workflows/deploy.yml
on:
  push:
    branches: [main]
  workflow_dispatch:
```

`tests.yml` is `pull_request` only. `staging-backend.yml` is
`workflow_dispatch`. Dependabot has its own `schedule:` in
`dependabot.yml`; that does not run `eb-deploy.sh`. A later
XFF pin in either L655 or L897 is unreachable from Sunday.

```8:13:backend/.ebextensions/05-instance-recycling.config
  aws:elasticbeanstalk:managedactions:
    ManagedActionsEnabled: true
    PreferredStartTime: "Sun:10:00"
  aws:elasticbeanstalk:managedactions:platformupdate:
    UpdateLevel: minor
    InstanceRefreshEnabled: true
```

Cycle 110: `backend/src` has zero `InstanceRefresh` /
`managedactions` hits. Recycle never calls
`update-environment` from this repo. Cycle 232: Sunday is
Immutable, not rolling. Cycle 242: temporary ASG behind
the **same** load balancer; IdleTimeout does not reapply
weekly because Sunday never applies the bundle.

### A-020 cannot be the weekly XFF clock

A-020 is a second `put-lifecycle-hook` after GitHub
`verify_deployment` succeeds. Sunday never reaches
`verify_deployment`. Un-parking it does not create a Sunday
`modify-load-balancer-attributes`. The hook A-020 would
re-put is still the **ASG** drain hook (cycle 113: hooks die
with the ASG; the ALB does not).

IdleTimeout **can** be a dedicated resource-only PR (cycle
242 / ENG-836). That PR is still a GitHub merge, not a
Sunday action. XFF cannot use that PR shape (cycle 243: not
an EB option). Both wait for a human/agent merge. Fail-closed
before apply only makes **that** merge refuse to start if
IAM is missing. It does not reassert `append`/`false` at
Sun:10:00.

Hermes / Oh My Pi: no weekly managed-update pair behind a
stable ALB. AgentWeb’s cutting-edge SDLC is in-process 503
on Sunday overlap (A-019; cycle 233: Wait is the park);
weekly XFF reassert is later ops, not drain, not A-020.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** treat fail-closed-before-apply as a weekly XFF
  reassert (Sunday never runs `eb-deploy.sh`).
- Do **not** un-park A-020 for Sunday XFF drift (same
  GitHub-only clock; wrong object).
- Do **not** disable `InstanceRefreshEnabled` from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: is a GitHub Actions `schedule:` cron (pin
only, not a full deploy) the only in-tree way to reassert
XFF on Sunday without waiting for a merge? Zero `schedule:`
on `deploy.yml` today. Do not add that workflow from A-019.
Do not disable `InstanceRefreshEnabled`. Do not un-park
A-020. Do not 503 `/health`. Do not add A-021. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006. Do not
mint a timer unless Kevin asks.
