# Cycle 267 — XFF empty-ARN `fail()` uses its own string; do not copy L811 or probe UNKNOWN

**Date:** 2026-09-12T11:40:00Z
**Question:** Delay’s empty-ARN `fail()` names
DeregistrationDelay (L811). Probe empty-ARN is UNKNOWN
(L312–317). Should XFF’s empty-ARN `fail()` use its own
string (XFF / `modify-load-balancer-attributes`), not
copy L811 or probe UNKNOWN?
**Answer:** **Yes. Own `fail()` string. Do not copy L811.
Do not copy probe UNKNOWN.** Cycle 266: XFF rediscovers
after its own skip and copies delay’s **contract**
(`fail()`, not UNKNOWN). The **message** is per pin.
L811 says `cannot set DeregistrationDelay via elbv2`.
An XFF miss logged as that would send operators to the
TG timeout (ENG-823) while the missing object is the
LB `xff_*` attributes (cycle 241). Probe UNKNOWN
`return 0` (L312–317) is the cycle 264 cannot-fail
class: GitHub-green with no pin. Classic names already
fail delay (L809–811 `grep '^arn:'` then empty). XFF
opted-in must `fail()` the same way, with a string that
names XFF. Do **not** add that pin from A-019. Do not
un-park A-020. Do not 503 `/health`. Do not add A-021.

## Evidence

### Empty ARN: pin fail vs probe UNKNOWN

```809:811:.github/scripts/eb-deploy.sh
  lb_arns=$(printf '%s' "${lb_arns}" | tr '\t' '\n' | grep '^arn:' || true)
  if [ -z "${lb_arns}" ]; then
    fail "environment '${EB_ENVIRONMENT_NAME}' has no Application Load Balancer ARN; cannot set DeregistrationDelay via elbv2 (classic ELB is not supported by this path)."
```

```312:317:.github/scripts/eb-deploy.sh
  if [ -z "${lb_arns}" ]; then
    # A classic (non-ALB) load balancer reports a bare name, so there is no
    # target group to interrogate and this probe cannot speak for the ALB path.
    EB_UNHEALTHY_DETAIL='no Application Load Balancer ARN on this environment'
    EB_HEALTH_VERDICT='UNKNOWN'
    return 0
```

`::error::EB_DEPLOY_FAILED` (L155–157) is what GitHub
surfaces. Copying L811 makes that annotation a lie about
which pin failed. Cycle 263 already: fail strings inside
`ensure_deregistration_delay` name DeregistrationDelay;
a sibling must not inherit them.

Hermes / Oh My Pi: no empty-ARN fail-string fork.
AgentWeb’s cutting-edge SDLC is in-process 503; a later
XFF pin should `fail()` like ENG-823 with an XFF
sentence, not a TG-timeout sentence or a probe no-op.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** copy L811’s DeregistrationDelay empty-ARN
  string onto XFF.
- Do **not** copy probe UNKNOWN `return 0` on empty ARN.
- Own `fail()` naming XFF / `modify-load-balancer-attributes`.
- Do **not** add that pin from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: delay’s **CLI error** path (L806) also
names DeregistrationDelay. Probe’s failed Describe is
UNKNOWN (L306–308). Should XFF’s failed
`describe-environment-resources` `fail()` use its own
string, not copy L806? Do not copy L806. Do not add
that pin from A-019. Do not un-park A-020. Do not 503
`/health`. Do not add A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive A-006. Do not mint a timer
unless Kevin asks.
