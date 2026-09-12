# Cycle 250 — a pin-only `schedule:` workflow would be the git-native Sunday XFF reassert; do not add it from A-019

**Date:** 2026-09-12T08:50:00Z
**Question:** Is a GitHub Actions `schedule:` cron (pin
only, not a full deploy) the only in-tree way to reassert
XFF on Sunday without waiting for a merge? Zero `schedule:`
on `deploy.yml` today.
**Answer:** **It is the only git-native path that reuses the
existing deploy IAM user without new AWS resource types.
It does not exist today. Do not add it from A-019.** Cycle
249: Sunday never runs `eb-deploy.sh`. `deploy.yml` `on:`
is `push` + `workflow_dispatch`. The only `schedule:` in
`.github` is Dependabot (`dependabot.yml` L30–32, weekly
**Monday**, opens a pin-SHA PR — it does not call
`modify-load-balancer-attributes`). A new pin-only
`schedule:` job with `environment: prod` would use
`github-actions-deploy-backend` keys (cycle 244) and
Describe/Modify the surviving LB ARN (cycles 241–246)
without `update-environment`. A `.ebextensions` `Resources:`
EventBridge/Lambda could also fire weekly in git, but that
is new AWS surface (today `Resources:` is only
`AWS::CloudWatch::Alarm` in `04-disk-alarm.config`) and
resource config (ENG-836). Instance `commands:` use the
wrong role (cycle 243). Recreate is out of band (cycle 243).
A-020 still does not run on Sunday (cycle 249). Do **not**
add a `schedule:` workflow from A-019. Do not disable
`InstanceRefreshEnabled`. Do not un-park A-020. Do not 503
`/health`. Do not add A-021.

## Evidence

### No weekly GitHub job talks to the ALB

| Clock | What it does on a week with no merge | Pins XFF? |
|---|---|---|
| `deploy.yml` | Idle (`push` / `workflow_dispatch` only) | No |
| `tests.yml` | Idle (`pull_request` only) | No |
| Dependabot `schedule:` Monday | Opens a `github-actions` SHA PR | No |
| EB `Sun:10:00` `InstanceRefreshEnabled` | Immutable instance recycle behind the same ALB | No (cycle 242) |
| A-020 second put | Unreachable (never called) | No (wrong object) |

A pin-only `schedule:` would be a **new** workflow, not a
line on A-019. It would still need Harsha’s
`DescribeLoadBalancerAttributes` /
`ModifyLoadBalancerAttributes` grant (cycles 244–246).
Denied Describe would fail that job without applying a
version — fail closed **and** not prod-green (cycle 247’s
split is after-verify of a version). Still not drain 503.

### The other “in-tree” shape is new AWS, not the deploy user

`04-disk-alarm.config` L29–46 is `AWS::CloudWatch::Alarm`.
Zero `AWS::Events::Rule` / `AWS::Lambda::Function` /
`AWS::ElasticLoadBalancingV2`. A scheduled Lambda that
called `modify-load-balancer-attributes` would be a new
role, not `github-actions-deploy-backend`. Mixing that
resource delta with `.platform` is ENG-836. Cycle 243:
do not add CFN LoadBalancer from A-019 either.

Hermes / Oh My Pi: no Sunday cron pinning a cloud balancer.
AgentWeb’s cutting-edge SDLC is in-process 503 on overlap;
a weekly XFF `schedule:` is later ops, not nanoservice
extract, not A-019.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** add a GitHub Actions `schedule:` XFF pin from
  A-019.
- Do **not** add EventBridge / Lambda `Resources:` from A-019
  to reassert XFF weekly.
- Do **not** treat Dependabot’s Monday `schedule:` as an ALB
  pin.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: a pin-only `schedule:` would not call
`update-environment`, so the Sun:10:00 “Must be Ready”
collision (`deploy.yml` L199–204) might not apply.
`wait_for_environment_ready` lives only inside
`update_environment`. Could that job still
`describe-environment-resources` during Updating and pin
the same surviving ALB (cycle 242)? Do not add that
workflow from A-019. Do not disable
`InstanceRefreshEnabled`. Do not un-park A-020. Do not
503 `/health`. Do not add A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive A-006. Do not mint a timer
unless Kevin asks.
