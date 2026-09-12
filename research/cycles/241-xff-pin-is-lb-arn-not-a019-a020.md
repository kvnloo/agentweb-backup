# Cycle 241 — an ENG-493 XFF pin is `modify-load-balancer-attributes` on the LB ARN; not A-019, not A-020

**Date:** 2026-09-12T07:20:00Z
**Question:** Cycle 240: A-019 does not pin ALB XFF attributes
(ENG-493 / later ops). If a later ops item pins them, would it
copy `ensure_deregistration_delay` but call
`modify-load-balancer-attributes` on the **load balancer ARN**
(not the target group)? Do not pile that onto A-019 or A-020.
**Answer:** **Yes — sibling function, LB ARN, after verify.
Not A-019. Not A-020.** `ensure_deregistration_delay` already
resolves `LoadBalancers[*].Name` ARNs (`eb-deploy.sh` L802–812)
then **descends into target groups** and
`modify-target-group-attributes` (`deregistration_delay.timeout_seconds`).
XFF keys are **load-balancer** attributes. Copying the inner TG
loop would describe the wrong object. A later pin reuses the
LB-ARN discovery, then `describe-load-balancer-attributes` /
`modify-load-balancer-attributes` on `$lb`, then re-read
(ENG-823). Zero `modify-load-balancer-attributes` in product
git today. Do **not** fold it into A-019 (in-process `/mcp`
503). Do **not** fold it into A-020 (second
`put-lifecycle-hook` on the surviving ASG). Do not add A-021.
Do not 503 `/health`.

## Evidence

### Today’s pin is the target group, after verify

```802:821:.github/scripts/eb-deploy.sh
  if ! lb_arns=$(aws elasticbeanstalk describe-environment-resources \
    --environment-name "${EB_ENVIRONMENT_NAME}" \
    --query 'EnvironmentResources.LoadBalancers[*].Name' \
    --output text 2>&1); then
    fail "could not resolve the load balancer for '${EB_ENVIRONMENT_NAME}' to set DeregistrationDelay. AWS reported: ${lb_arns}"
  fi

  lb_arns=$(printf '%s' "${lb_arns}" | tr '\t' '\n' | grep '^arn:' || true)
  if [ -z "${lb_arns}" ]; then
    fail "environment '${EB_ENVIRONMENT_NAME}' has no Application Load Balancer ARN; cannot set DeregistrationDelay via elbv2 (classic ELB is not supported by this path)."
  fi

  while IFS= read -r lb; do
    [ -z "${lb}" ] && continue
    if ! tg_arns=$(aws elbv2 describe-target-groups \
      --load-balancer-arn "${lb}" \
      --query 'TargetGroups[*].TargetGroupArn' \
      --output text 2>&1); then
      fail "describe-target-groups failed for load balancer ${lb}. AWS reported: ${tg_arns}"
    fi
```

Then L828–845 `describe-target-group-attributes` /
`modify-target-group-attributes` on `$arn` (the TG). `main`
calls this **once**, after `verify_deployment` (L897). Tests
(`eb-deploy.test.sh` L809–838) pin that TG path, including
opt-out when `EB_DEREGISTRATION_DELAY_SECONDS` is unset
(partner-portal). `timeout.config` L23 already names
`modify-target-group-attributes` as the real mechanism.

A later XFF pin would **stop at `$lb`**:
`aws elbv2 describe-load-balancer-attributes --load-balancer-arn`
then `modify-load-balancer-attributes` with
`routing.http.xff_header_processing.mode=append` and
`routing.http.xff_client_port.enabled=false`, then re-read.
Passing a target-group ARN to `modify-load-balancer-attributes`
is the wrong API. Do not mutate the ENG-823 tests to bless
that. New sibling, backend-opt-in, same after-verify slot as
`ensure_deregistration_delay` — a **second** call in `main`,
not an extra line inside the TG `for` loop.

### A-020 is the surviving ASG, not the ALB

A-020 first_slice: after verify, `ensure_termination_lifecycle_hook`
again so `AutoScalingGroups[0]` is the surviving Immutable ASG.
Cycle 113 / A-020 `why`: ALB **survives** ASG swap; the hook
does not. Folding XFF into that second `put-lifecycle-hook`
would mix two objects (ASG hook vs LB attributes) in one
function. Sunday never calls `eb-deploy.sh` (cycle 110);
because the ALB survives, last-merge attributes stay — same
as today’s 600s delay (`deploy.yml` L217). Console drift
would persist until the next backend merge that ran the
sibling. That is ENG-493 ops, not drain.

Hermes / Oh My Pi: no ALB, no `eb-deploy.sh`. AgentWeb’s
cutting-edge SDLC is in-process 503 (A-019) plus a parked
hook re-put (A-020) plus an optional later LB-ARN pin for
ENG-493 — not a nanoservice and not a third item on A-019.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** copy `ensure_deregistration_delay`’s target-group
  loop for XFF.
- Do **not** fold `modify-load-balancer-attributes` into A-019
  or into A-020’s second `put-lifecycle-hook`.
- Do **not** add A-021 for this pin.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: cycle 113 says the ALB survives Immutable
ASG swap. Does `LoadBalancers[*].Name` stay across
`update-environment` Immutable **and** Sunday
`InstanceRefreshEnabled`, so console XFF drift would survive
without a pin, while `IdleTimeout` still reapplies from
`timeout.config`? Do not add `modify-load-balancer-attributes`
from A-019. Do not un-park A-020 for this. Do not 503
`/health`. Do not add A-021. Do not un-ready Q-001 / Q-014 /
Q-003. Do not revive A-006. Do not mint a timer unless Kevin asks.
