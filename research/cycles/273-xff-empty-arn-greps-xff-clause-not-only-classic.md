# Cycle 273 — XFF empty-ARN test greps the XFF clause, not only `classic ELB`

**Date:** 2026-09-12T12:40:00Z
**Question:** Zero tests grep `classic ELB` even for
delay (only L811 contains it). Cycle 272: XFF’s one
empty-ARN string names classic. Should an XFF
empty-ARN test grep only that parenthetical, or still
grep the XFF / `modify-load-balancer-attributes` clause
(cycles 267 / 269)?
**Answer:** **Grep the XFF clause. Do not grep only
`classic ELB`.** `check()` is one `grep -qF` needle
(test L353–372). `classic ELB is not supported by this
path` is a **prefix of delay L811**. Green + classic +
**delay set** hits L811 inside `ensure_deregistration_delay`
and never reaches XFF (cycle 265 `fail()` is `exit 1`;
cycle 270: delay unset is required). A test that greps
only `classic ELB` would pass that stuffed fixture and
never prove cycle 267’s XFF sentence. Cycle 269 already:
do not grep only a shared prefix (`could not resolve the
load balancer`). Denied TG modify greps
`modify-target-group-attributes failed for` (L877) —
the pin-specific clause. Copy that shape. Do **not**
add that pin or that test from A-019. Do not un-park
A-020. Do not 503 `/health`. Do not add A-021.

## Evidence

### Classic parenthetical is inside delay L811

```809:811:.github/scripts/eb-deploy.sh
  lb_arns=$(printf '%s' "${lb_arns}" | tr '\t' '\n' | grep '^arn:' || true)
  if [ -z "${lb_arns}" ]; then
    fail "environment '${EB_ENVIRONMENT_NAME}' has no Application Load Balancer ARN; cannot set DeregistrationDelay via elbv2 (classic ELB is not supported by this path)."
```

```353:372:.github/scripts/eb-deploy.test.sh
check() {
  # check <description> <expected_exit> <expected substring>
  local desc="$1" expected_exit="$2" needle="$3"
  ...
  if [ -n "${needle}" ] && ! grep -qF "${needle}" <<<"${LAST_OUTPUT}"; then
```

Cycle 269: `ERROR|` + delay-opted-in never reaches XFF.
Here: classic name + delay-opted-in hits L811, which
**contains** `classic ELB`. Cycle 272 copied that
parenthetical into XFF so delay-**unset** output also
contains it — which is why classic-only is not
discriminative when the fixture forgets to unset
delay.

`rg 'classic ELB' .github/scripts` is only L811.
Probe L799 greps `'no Application Load Balancer ARN'`
(cycle 270: also a prefix of L811). Same class of
shared substring.

Hermes / Oh My Pi: one assertion on the distinctive
miss. AgentWeb’s cutting-edge SDLC is in-process 503;
a later XFF empty-ARN test greps the XFF sentence, not
A-019.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** grep only `classic ELB` for XFF empty-ARN
  coverage (shared with L811).
- Grep the cycle 267 XFF / `modify-load-balancer-attributes`
  clause (cycle 269 shape).
- Do **not** add that pin or that test from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: `check()` is one needle; consecutive
`check()` on the same `LAST_OUTPUT` is the existing
shape (AC1 L404–405). Should an XFF empty-ARN test add
a **second** `check()` for `classic ELB` so omitting
cycle 272’s parenthetical fails, or is the XFF-clause
grep enough? Second `check()` for classic. Do not add
that pin or those tests from A-019. Do not un-park
A-020. Do not 503 `/health`. Do not add A-021. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.
Do not mint a timer unless Kevin asks.
