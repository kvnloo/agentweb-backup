# Cycle 272 — XFF’s one empty-ARN string names classic ELB; do not copy DeregistrationDelay

**Date:** 2026-09-12T12:30:00Z
**Question:** Delay L811’s parenthetical names
`classic ELB is not supported by this path`. Probe’s
operator string does **not** (`L315`; classic lives in
the comment). Cycle 271: one XFF empty-ARN string for
`None` and classic. Should that string also name
classic ELB, or stay XFF / `modify-load-balancer-attributes`
only?
**Answer:** **Name classic in the one string. Copy the
parenthetical, not “DeregistrationDelay.”** After
`grep '^arn:'` the original token is gone (cycle 271).
The fail() sentence is the only GitHub annotation
(`::error::EB_DEPLOY_FAILED`, L155–157) that can tell
an operator with a live classic name why elbv2 cannot
pin `xff_*`. Delay already combines both audiences in
one sentence: first clause covers `None` (“no Application
Load Balancer ARN”); parenthetical covers classic.
Cycle 267 forbade copying L811’s **DeregistrationDelay**
clause (would send operators to the TG timeout), not the
classic hint. Probe L315 is UNKNOWN `return 0` — the
cannot-fail class (cycle 264); XFF is a pin, so it copies
delay’s **shape**, with XFF words. Do **not** add that
pin from A-019. Do not un-park A-020. Do not 503
`/health`. Do not add A-021.

## Evidence

### Delay names classic in the fail string; probe does not

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

Zero tests grep `classic ELB` (only L811 contains it).
The probe classic fixture greps `'no Application Load
Balancer ARN'` (test L799) — a prefix of L811, which
is why cycle 270 forbade reusing L799 for XFF. Cycle
269: grep the pin-specific clause. An XFF empty-ARN
test still greps `modify-load-balancer-attributes` /
pin XFF (cycle 267), **and** may include the classic
parenthetical in the same sentence. It does not become
two strings (cycle 271).

Omitting classic leaves an operator who knows they have
a load balancer with “no ALB ARN” and no hint that a
bare name is why. Interpolating the pre-grep token
would be a later fork (delay L811 does not).

Hermes / Oh My Pi: one miss string, not a comment-vs-
fail fork. AgentWeb’s cutting-edge SDLC is in-process
503; a later XFF pin should fail like ENG-823 with an
XFF sentence that still names classic.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- XFF empty-ARN `fail()` names classic ELB in the **one**
  sentence (cycle 271).
- Do **not** copy L811’s `cannot set DeregistrationDelay`
  clause (cycle 267).
- Do **not** add that pin from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: zero tests grep `classic ELB` even
for delay. Should an XFF empty-ARN test grep only the
classic parenthetical, or still grep the XFF /
`modify-load-balancer-attributes` clause (cycle 267 /
269)? Grep the XFF clause. Do not add that pin or that
test from A-019. Do not un-park A-020. Do not 503
`/health`. Do not add A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive A-006. Do not mint a timer
unless Kevin asks.
