# Cycle 266 — XFF rediscovers `LoadBalancers[*]` after its own skip; do not share from `main()`

**Date:** 2026-09-12T11:30:00Z
**Question:** Delay already rediscovers `LoadBalancers[*]`
(`L802–809`). Health probe does too (`L302–306`) and does
**not** share a helper. Should a later XFF sibling
rediscover after its own skip, rather than a shared
discovery called from `main()` before both pins?
**Answer:** **Yes. Rediscover after skip. Do not share
from `main()`.** A pre-pin helper in `main()` would run
on partner/staging when both unset — the extra AWS call
cycle 261 forbade (test L814–825: opted-out is zero
DeregistrationDelay **and** still SUCCESS; L798 returns
before L802). This tree already duplicates
`describe-environment-resources` + `grep '^arn:'`
(probe L302–311 vs delay L802–809) because the
**contracts differ**: probe failed Describe is UNKNOWN
`return 0` (L306–308); delay `fail()`s (L806–807). Empty
ARN: probe UNKNOWN (L312–317); delay `fail()` (L810–811).
A shared helper would have to pick one. XFF is a pin
(cycle 264), so it copies delay’s `fail()`, not probe
UNKNOWN — in **its** function after **its** skip.
Duplicate Describe on backend SUCCESS when both opted
in is cheaper than partner elbv2 (cycles 244–247).
Do **not** add that pin from A-019. Do not un-park
A-020. Do not 503 `/health`. Do not add A-021.

## Evidence

### Same API, two contracts, no helper

```302:308:.github/scripts/eb-deploy.sh
  if ! lb_arns=$(aws elasticbeanstalk describe-environment-resources \
    --environment-name "${EB_ENVIRONMENT_NAME}" \
    --query 'EnvironmentResources.LoadBalancers[*].Name' \
    --output text 2>&1); then
    EB_UNHEALTHY_DETAIL="describe-environment-resources failed: ${lb_arns}"
    EB_HEALTH_VERDICT='UNKNOWN'
    return 0
```

```802:807:.github/scripts/eb-deploy.sh
  if ! lb_arns=$(aws elasticbeanstalk describe-environment-resources \
    --environment-name "${EB_ENVIRONMENT_NAME}" \
    --query 'EnvironmentResources.LoadBalancers[*].Name' \
    --output text 2>&1); then
    fail "could not resolve the load balancer for '${EB_ENVIRONMENT_NAME}' to set DeregistrationDelay. AWS reported: ${lb_arns}"
```

Hook discovery is a **third** `describe-environment-resources`
(L591) for `AutoScalingGroups[0]`, not LoadBalancers
(cycle 252). Zero extracted helper. XFF would be a
fourth caller with delay’s pin contract and its own
fail string (must not say DeregistrationDelay).

Hermes / Oh My Pi: no duplicated-Describe vs shared-helper
fork. AgentWeb’s cutting-edge SDLC is in-process 503; a
later XFF pin should skip first, then discover, like
ENG-823, not a `main()` prelude that reintroduces partner
elbv2.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** add a `main()` shared LB-ARN helper before
  both pins (would run when both unset).
- Rediscover after the XFF skip; `fail()` like delay,
  not probe UNKNOWN.
- Do **not** add that pin from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: delay’s empty-ARN `fail()` names
DeregistrationDelay (L811). Probe empty-ARN is UNKNOWN
(L312–317). Should XFF’s empty-ARN `fail()` use its own
string (XFF / `modify-load-balancer-attributes`), not
copy L811 or probe UNKNOWN? Do not copy L811. Do not
add that pin from A-019. Do not un-park A-020. Do not
503 `/health`. Do not add A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive A-006. Do not mint a timer
unless Kevin asks.
