# Cycle 269 — XFF `ERROR|` coverage needs delay unset; grep the XFF clause, not the shared prefix

**Date:** 2026-09-12T12:00:00Z
**Question:** The `lb_arns` `ERROR|` mock exists and has
zero callers. Should a later XFF pin add an ERROR| test
that greps the **XFF** fail string, not
`DeregistrationDelay`? Do not treat the missing L806 test
as license to skip XFF CLI-fail coverage.
**Answer:** **Yes, when the pin lands — with delay unset,
grepping the XFF clause. Do not add that test from A-019.**
Cycle 265: delay first, `fail()` is `exit 1`. Production
backend sets delay (`deploy.yml` L217). An `ERROR|` on
`lb_arns` (`eb-deploy.test.sh` L187–189, exit 255) hits
delay L806 first and never reaches the XFF sibling. A
test that copies the ENG-823 opted-in env
(`EB_DEREGISTRATION_DELAY_SECONDS='600'`, L833) therefore
asserts L806, not XFF. Cycle 268: L806 and XFF share
`could not resolve the load balancer`; grepping only that
prefix would pass a stuffed L806 (cycle 263). Grep the
XFF-specific clause (`modify-load-balancer-attributes` /
pin XFF). Zero `ERROR|` writers of `lb_arns` today
(L709 ARN, L796 classic). Missing L806 coverage is not
a reason to skip XFF’s. Do **not** add that pin or those
tests from A-019. Do not un-park A-020. Do not 503
`/health`. Do not add A-021.

## Evidence

### Delay-first eats the shared mock

```187:189:.github/scripts/eb-deploy.test.sh
      if [ "${first%%|*}" = "ERROR" ]; then
        printf '%s\n' "${first#*|}" >&2
        exit 255
```

`describe-environment-resources` is what both delay
(L802) and a later XFF sibling call (cycle 266). The
mock does not know which caller it is. `exit 255` makes
`if !` true. Delay L897 runs first (cycle 265) and
`fail()`s L806. XFF never runs.

ENG-823 opted-in tests all pass
`EB_DEREGISTRATION_DELAY_SECONDS='600'` (L833, L845,
L864, L875). Partner/opted-out (L814–825) never reaches
L802. No fixture writes `ERROR|` to `lb_arns`. The
unused mock cannot be “already covering XFF.”

### Shared fail prefix is a stuffing false-green

```806:806:.github/scripts/eb-deploy.sh
    fail "could not resolve the load balancer for '${EB_ENVIRONMENT_NAME}' to set DeregistrationDelay. AWS reported: ${lb_arns}"
```

Cycle 268: copy `AWS reported:`, not the
DeregistrationDelay clause. A later XFF test that
`check`s `'could not resolve the load balancer'` would
also match L806 if XFF were stuffed into
`ensure_deregistration_delay`. Denied TG modify already
greps the **API** name (`modify-target-group-attributes
failed for`, L877). XFF CLI-fail should grep its own
API/pin name the same way.

Hermes / Oh My Pi: no unused-ERROR-mock vs delay-first
fork. AgentWeb’s cutting-edge SDLC is in-process 503; a
later XFF pin’s CLI-fail test is delay-unset + XFF
clause, not A-019.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** treat an `ERROR|` + delay-opted-in test as
  XFF CLI-fail coverage (delay L806 wins).
- Do **not** grep only `could not resolve the load balancer`
  (shared with L806).
- Do **not** add that pin or those tests from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: classic name (`awseb-e-classic-lb`,
test L796) is the empty-after-grep path (L811). Probe
uses it on a **Red** rollup without delay. Should an XFF
empty-ARN test also unset delay, rather than reuse L796’s
Red+classic fixture? Delay-opted-in + classic would fail
L811 first. Do not copy the probe classic fixture as XFF
empty-ARN coverage. Do not add that pin from A-019. Do
not un-park A-020. Do not 503 `/health`. Do not add A-021.
Do not un-ready Q-001 / Q-014 / Q-003. Do not revive
A-006. Do not mint a timer unless Kevin asks.
