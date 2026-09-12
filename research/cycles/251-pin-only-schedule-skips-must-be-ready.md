# Cycle 251 — a pin-only Sunday job would not hit Must be Ready; elbv2 talks to the surviving ALB during Updating

**Date:** 2026-09-12T09:00:00Z
**Question:** A pin-only `schedule:` would not call
`update-environment`, so the Sun:10:00 “Must be Ready”
collision (`deploy.yml` L199–204) might not apply.
`wait_for_environment_ready` lives only inside
`update_environment`. Could that job still
`describe-environment-resources` during Updating and pin
the same surviving ALB (cycle 242)?
**Answer:** **Yes, file-level: Must be Ready is
`UpdateEnvironment` only.** The quoted AWS error in
`eb-deploy.test.sh` L475 is `when calling the
UpdateEnvironment operation: … Must be Ready.`
`wait_for_environment_ready` is called only from
`update_environment` L654. `fail_on_terminal_status`
(`eb-deploy.sh` L479–487) fails only `Terminated` /
`Terminating` — **Updating is not terminal**.
`describe-environment-resources` has no Status check inside
the call (`L302–305` probe, `L591–594` hook,
`L802–805` deregistration). The mock always returns
`lb_arns` regardless of environment state
(`eb-deploy.test.sh` L177–199). `aws elbv2` then talks to
that ARN, not to Elastic Beanstalk. Cycle 242: Immutable
puts a temporary ASG **behind** the environment’s load
balancer — the ALB is the constant while Status is
Updating. A pin-only job that skipped `update-environment`
would not wait Ready and would not take the L199–204
settle-timeout path. Do **not** add that workflow from
A-019. Do not disable `InstanceRefreshEnabled`. Do not
un-park A-020. Do not 503 `/health`. Do not add A-021.

## Evidence

### Must be Ready is the apply API, not Describe/elbv2

```668:671:.github/scripts/eb-deploy.sh
    # EB rejects an update while another is running with "Environment named X is
    # in an invalid state for this operation. Must be Ready." That is the one
    # error worth retrying, because the environment settling makes it go away.
    if grep -qiE 'invalid state|concurrentupdate|concurrent update' <<<"${out}"; then
```

That `out` is from `aws elasticbeanstalk update-environment`
(L658–660). `deploy.yml` L199–204 explains why a **human
deploy** landing in the Sunday window needs
`EB_SETTLE_TIMEOUT_SECONDS: '1200'`: it must wait Ready
before it can apply. A pin-only job that never calls that
API does not need that wait.

`wait_for_environment_ready` L631: `if Ready; return 0`.
Used only as pre-update settle. `ensure_deregistration_delay`
and the health probe call `describe-environment-resources`
**after** Ready in this script’s current call graph. That
is call-site habit, not an AWS requirement encoded here.
The probe even treats a failed describe as `UNKNOWN` and
returns 0 (L306–308) rather than Must be Ready.

### Updating is a live ALB

Cycle 232: Sunday InstanceRefresh is Immutable. Cycle 242:
AWS “creates a second, temporary Auto Scaling group behind
your environment's load balancer.” Hermes keeps talking to
that ALB (cycle 234: `/health` 200 on the dying instance;
A-019 503 is in-process). Changing
`routing.http.xff_header_processing.mode` on that ARN
during refresh would apply to **both** fleets at once —
the desired pin, not a fifth HTTP hop.

This tree has no fixture where
`describe-environment-resources` fails solely because
Status=Updating. Do not invent one from A-019.

Hermes / Oh My Pi: no EB Updating vs elbv2 split. AgentWeb’s
cutting-edge SDLC is in-process 503 during Sunday overlap;
a later pin-only cron talking to the surviving ALB is
ops, not A-019.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** treat Sun:10:00 Must be Ready as blocking a
  pin-only elbv2 call (that error is `UpdateEnvironment`).
- Do **not** wait Ready from A-019 / copy
  `wait_for_environment_ready` into drain.
- Do **not** add that `schedule:` workflow from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: during Immutable Updating,
`AutoScalingGroups[0]` may be the temporary ASG (cycle 113 /
A-020). `describe-environment-resources` returns both ASGs
and LoadBalancers. A pin-only job that copied hook discovery
(`L591–594` `AutoScalingGroups[0]`) would target the wrong
object. Must XFF use only `LoadBalancers[*].Name`? Do not
copy hook discovery. Do not add that workflow from A-019.
Do not un-park A-020. Do not 503 `/health`. Do not add A-021.
Do not un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.
Do not mint a timer unless Kevin asks.
