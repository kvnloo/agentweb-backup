# Cycle 270 — do not copy the probe classic fixture as XFF empty-ARN coverage

**Date:** 2026-09-12T12:10:00Z
**Question:** Classic name (`awseb-e-classic-lb`, test
L796) is the empty-after-grep path (L811). Probe uses it
on a **Red** rollup without delay. Should an XFF
empty-ARN test also unset delay, rather than reuse L796’s
Red+classic fixture?
**Answer:** **Yes. Unset delay. Do not copy L796.** L796
is Ready+**Red** (`L794`). SUCCESS is only logged when
health is neither Grey nor Red (`eb-deploy.sh` L739–742).
Red waits for settle then `underlying_health_verdict`;
classic is UNKNOWN (L312–317) so the job `fail()`s inside
`verify_deployment` and **never** returns to `main()`
L897. Delay and a later XFF sibling never run. Cycle 269:
delay-opted-in eats the shared mock; here the **health**
path eats the fixture before either pin. An XFF
empty-ARN test needs Green/Yellow SUCCESS, delay unset
(else L811 wins), classic or `None`, XFF opted in, grep
of the cycle 267 string — not `'no Application Load
Balancer ARN'` (L799), which is the probe UNKNOWN detail.
Do **not** add that pin or that test from A-019. Do not
un-park A-020. Do not 503 `/health`. Do not add A-021.

## Evidence

### Red never reaches `main()` pins

```739:742:.github/scripts/eb-deploy.sh
      if [ "${EB_HEALTH}" != "Grey" ] && [ "${EB_HEALTH}" != "Red" ]; then
        log "SUCCESS: environment '${EB_ENVIRONMENT_NAME}' is Ready, running version '${EB_VERSION_LABEL}', health=${EB_HEALTH}."
        run_health_probe_dryrun
        return 0
```

```791:799:.github/scripts/eb-deploy.test.sh
# A classic (non-ALB) load balancer exposes no target-group ARN, so the probe
# cannot speak for it and must not vouch for the deploy.
...
check 'ENG-878: a classic load balancer leaves the verdict UNKNOWN, so it fails' 1 \
  'no Application Load Balancer ARN'
```

L796 does not pass `EB_DEREGISTRATION_DELAY_SECONDS`.
Even if it did, verify would still fail first. Green
without `set_healthy_underlying` (L803–806) defaults
`lb_arns` to `None` (mock L196–198) and **skips** the
probe; that would reach L897. ENG-823 opted-in tests
always call `set_healthy_underlying` (ARN L709), so they
never hit L811. Zero Green+classic+delay tests.

L799 greps the probe UNKNOWN detail (`no Application Load
Balancer ARN`), which is a **prefix** of L811 (`has no
Application Load Balancer ARN; cannot set
DeregistrationDelay`). Reusing L799 for XFF would match
probe **or** delay. Cycle 267: XFF empty-ARN has its own
sentence.

Hermes / Oh My Pi: no Red-classic vs Green-empty-ARN
fork. AgentWeb’s cutting-edge SDLC is in-process 503; a
later XFF pin’s empty-ARN test is Green + delay-unset,
not A-019 and not L796.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** copy the probe classic (L796 Red) fixture as
  XFF empty-ARN coverage (verify never returns).
- Green + delay unset + XFF opt-in; grep the cycle 267
  string, not L799.
- Do **not** add that pin or that test from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: mock `NONE` prints `None` (L191–193);
classic prints a bare name (L796). Both fail
`grep '^arn:'` and hit the same empty-ARN `fail()`.
Should XFF use **one** empty-ARN string for `None` and
classic, rather than two? Do not split. Do not add that
pin from A-019. Do not un-park A-020. Do not 503
`/health`. Do not add A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive A-006. Do not mint a timer
unless Kevin asks.
