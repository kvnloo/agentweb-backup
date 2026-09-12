# Cycle 256 — a `net/` XFF modify fails the job; do not add skip-non-app from A-019

**Date:** 2026-09-12T09:50:00Z
**Question:** If a later XFF pin copied `grep '^arn:'` and
AWS returned a `net/` ARN, `modify-load-balancer-attributes`
of `xff_*` would ValidationError. ENG-823 would still pin
that NLB’s TGs. Is skip-non-app (`continue`) or fail the
job the copy? Skip would be new. After-verify fail is
cycle 247.
**Answer:** **Fail the job is the ENG-823 copy. Do not add
skip-non-app from A-019.** `fail()` exits 1 (`eb-deploy.sh`
L155–158). Denied `modify-target-group-attributes` fails
the job (`eb-deploy.test.sh` L868–877). The pin-all loop
is sequential; that `exit` never reaches later ARNs.
Cycle 255: this tree never emits `net/`. Cycle 247: an
after-verify fail is GitHub-red / prod-green, not an
A-019 503. Skip-non-app is the same new fork as `/app/`
(cycle 255). Do **not** add skip from A-019. Do not
un-park A-020. Do not 503 `/health`. Do not add A-021.

## Evidence

### `fail()` aborts the remaining list

```155:158:.github/scripts/eb-deploy.sh
fail() {
  echo "::error::EB_DEPLOY_FAILED: $*" >&2
  echo "[eb-deploy] EB_DEPLOY_FAILED: $*" >&2
  exit 1
}
```

```842:845:.github/scripts/eb-deploy.sh
      if ! out=$(aws elbv2 modify-target-group-attributes \
        --target-group-arn "${arn}" \
        --attributes "Key=deregistration_delay.timeout_seconds,Value=${desired}" 2>&1); then
        fail "modify-target-group-attributes failed for ${arn} (desired ${desired}s). AWS reported: ${out}"
```

```868:877:.github/scripts/eb-deploy.test.sh
# A denied elbv2 call fails loudly rather than reporting the deploy as fully
# applied when it was not.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Green|backend-20260729-pr2216'
set_healthy_underlying "$M"
printf '20\n' >"$M/tg_attrs"
printf '1\n' >"$M/modify_tg_exit"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_DEREGISTRATION_DELAY_SECONDS='600'
check 'ENG-823: a denied modify-target-group-attributes call fails the job' 1 \
  'modify-target-group-attributes failed for'
```

A later XFF sibling that copied this would `fail()` on
NLB ValidationError for `routing.http.xff_*`. That is
loud, greppable, and the same `EB_DEPLOY_FAILED` prefix.
`continue` on non-`app/` would be new control flow: the
TG loop has no type skip. Cycle 254: do not invent a
special case the TG path does not have.

If two ARNs appeared and `net/` were first, `exit 1`
would also skip pinning a later `app/` ARN. Cycle 253:
this tree does not show two. That ordering hazard is a
reason a later ops PR might skip, not a reason to add skip
from A-019. After-verify that fail is cycle 247
(SUCCESS already logged at L740; Hermes on the new
instance). Do not 503 `/health` to match the job.

Classic with no ARN already fails closed before the loop
(`L809–811`). `net/` **has** an ARN, so it enters the loop.
Treating it like classic UNKNOWN would also be new.

Hermes / Oh My Pi: no elbv2 ValidationError vs skip fork.
AgentWeb’s cutting-edge SDLC is in-process 503; a later
XFF pin should copy `fail()`, not continue.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** add skip-non-app (`continue`) from A-019
  (fail-the-job is the ENG-823 copy).
- Do **not** treat a `net/` ValidationError as an A-019
  503 (cycle 247).
- Do **not** add that pin from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: ENG-823 skips Modify only after a
successful Describe that equals desired (cycle 246).
`describe-load-balancer-attributes` of `xff_*` on NLB —
empty/`None` vs error? Empty `!= append` would still
attempt Modify, then fail. Do not add a None-skip from
A-019. Do not un-park A-020. Do not 503 `/health`. Do not
add A-021. Do not un-ready Q-001 / Q-014 / Q-003. Do not
revive A-006. Do not mint a timer unless Kevin asks.
