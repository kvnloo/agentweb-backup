# Cycle 268 — XFF CLI-fail `fail()` uses its own string; do not copy L806

**Date:** 2026-09-12T11:50:00Z
**Question:** Delay’s **CLI error** path (L806) also names
DeregistrationDelay. Probe’s failed Describe is UNKNOWN
(L306–308). Should XFF’s failed
`describe-environment-resources` `fail()` use its own
string, not copy L806?
**Answer:** **Yes. Own `fail()` string. Do not copy L806.
Do not copy probe UNKNOWN.** Cycle 267 was empty-after-
`grep` (CLI succeeded, filter empty, L811). This cycle
is the **other** branch: `if !` CLI non-zero (`L802–806`,
`2>&1` so `${lb_arns}` is the AWS error text). L806 says
`to set DeregistrationDelay`. Copying it on an XFF
discovery miss would send operators to ENG-823 while
`describe-environment-resources` failed before any
`modify-load-balancer-attributes` (cycle 241). Probe
UNKNOWN `return 0` (L306–308) is cycle 264 cannot-fail.
The mock already documents `ERROR|<msg>` on `lb_arns`
(`eb-deploy.test.sh` L184–189, exit 255) — that is this
`if !` branch. Zero tests write `ERROR|` to `lb_arns`,
so even ENG-823’s L806 string is unpinned; copying it
is still a lie. Hook L595 names the lifecycle hook and
queries `AutoScalingGroups[0]` (cycle 252). Do **not**
add that pin from A-019. Do not un-park A-020. Do not
503 `/health`. Do not add A-021.

## Evidence

### Failed Describe: pin fail vs probe UNKNOWN

```802:807:.github/scripts/eb-deploy.sh
  if ! lb_arns=$(aws elasticbeanstalk describe-environment-resources \
    --environment-name "${EB_ENVIRONMENT_NAME}" \
    --query 'EnvironmentResources.LoadBalancers[*].Name' \
    --output text 2>&1); then
    fail "could not resolve the load balancer for '${EB_ENVIRONMENT_NAME}' to set DeregistrationDelay. AWS reported: ${lb_arns}"
  fi
```

```302:308:.github/scripts/eb-deploy.sh
  if ! lb_arns=$(aws elasticbeanstalk describe-environment-resources \
    --environment-name "${EB_ENVIRONMENT_NAME}" \
    --query 'EnvironmentResources.LoadBalancers[*].Name' \
    --output text 2>&1); then
    EB_UNHEALTHY_DETAIL="describe-environment-resources failed: ${lb_arns}"
    EB_HEALTH_VERDICT='UNKNOWN'
    return 0
```

Copy delay’s **shape** (`fail()` + `AWS reported:`
interpolation). Do not copy the DeregistrationDelay
clause. Cycle 244: an IAM miss must be greppable; dropping
`${lb_arns}` would hide AccessDenied.

```184:189:.github/scripts/eb-deploy.test.sh
    # Fixture `lb_arns`: tab/newline separated ALB ARNs, NONE, or "ERROR|<msg>".
    if [ -f "${MOCK_DIR}/lb_arns" ]; then
      first=$(head -n 1 "${MOCK_DIR}/lb_arns")
      if [ "${first%%|*}" = "ERROR" ]; then
        printf '%s\n' "${first#*|}" >&2
        exit 255
```

`rg ERROR` writers of `lb_arns` in the test file: none
(only `set_healthy_underlying` ARN L709 and classic
L796). The mock is ready; the L806 sentence is not a
tested contract to reuse.

Hermes / Oh My Pi: no CLI-fail fail-string fork.
AgentWeb’s cutting-edge SDLC is in-process 503; a later
XFF pin should `fail()` like ENG-823 with an XFF
sentence.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** copy L806’s DeregistrationDelay CLI-fail
  string onto XFF.
- Do **not** copy probe UNKNOWN `return 0` on failed
  `describe-environment-resources`.
- Own `fail()` naming XFF; keep `AWS reported:`.
- Do **not** add that pin from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: the `lb_arns` `ERROR|` mock exists and
has zero callers. Should a later XFF pin add an ERROR|
test that greps the **XFF** fail string, not
`DeregistrationDelay`? Do not treat the missing L806 test
as license to skip XFF CLI-fail coverage. Do not add
those tests from A-019. Do not un-park A-020. Do not 503
`/health`. Do not add A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive A-006. Do not mint a timer
unless Kevin asks.
