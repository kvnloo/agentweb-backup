# Cycle 258 — do not `fail()` on ALB XFF Describe `None` before Modify from A-019

**Date:** 2026-09-12T10:10:00Z
**Question:** If XFF Describe on an ALB returned `None`,
that is a query bug (wrong Key), not an NLB. Should a
later pin `fail()` on `None` before Modify (like
no-targets fails closed) instead of attempting Modify?
That fail-closed would catch a typo earlier.
**Answer:** **No — do not add fail-on-None-before-Modify
from A-019.** ENG-823 treats any `current != desired` as
attempt Modify, then re-read (`eb-deploy.sh` L836–858).
`None` is that branch, same as `20`. no-targets is the
health probe returning **UNKNOWN** (`L353–356`), not
`fail()` of the pin. The script’s fail-closed-on-None is
**hook discovery** (`L598–599`; test L1123–1127) — cycle
252 already: do not copy that object onto XFF. Events
`None` is the opposite: non-fatal `return 0` (`L523`).
A clearer pre-Modify message is new control flow, not a
new gate: same-Key typo still `fail()`s at Modify
(cycle 256) or at re-read (`L857–858`). After-verify is
cycle 247. Do **not** add that check from A-019. Do not
un-park A-020. Do not 503 `/health`. Do not add A-021.

## Evidence

### ENG-823 has no pre-Modify value gate

```836:858:.github/scripts/eb-deploy.sh
      if [ "${current}" = "${desired}" ]; then
        log "DeregistrationDelay already ${desired}s on target group ${arn##*/}; no change needed."
        continue
      fi

      log "Setting DeregistrationDelay on target group ${arn##*/}: ${current}s -> ${desired}s."
      if ! out=$(aws elbv2 modify-target-group-attributes \
        --target-group-arn "${arn}" \
        --attributes "Key=deregistration_delay.timeout_seconds,Value=${desired}" 2>&1); then
        fail "modify-target-group-attributes failed for ${arn} (desired ${desired}s). AWS reported: ${out}"
      fi
      ...
      if [ "${current}" != "${desired}" ]; then
        fail "modify-target-group-attributes reported success for ${arn} but the target group still reads ${current}s, not the desired ${desired}s. Refusing to report the deploy as fully applied."
      fi
```

`20` (test L832) attempts Modify. Zero tests write `None`
into `tg_attrs` (cycle 257). A later XFF copy would log
`None -> append` and then either ValidationError
(cycle 256) or re-read fail. Both already `exit 1`.
Pre-Modify `fail()` on `None` would not catch a silent
drop after a successful Modify of the **correct** Key
(`tg_attrs_stuck` L856–866) — that is the re-read.

### no-targets is the wrong function

```352:356:.github/scripts/eb-deploy.sh
      targets=$(printf '%s' "${targets}" | grep -v '^None$' | grep -v '^[[:space:]]*$' || true)
      if [ -z "${targets}" ]; then
        EB_UNHEALTHY_DETAIL="target group ${arn##*/} has no registered targets"
        EB_HEALTH_VERDICT='UNKNOWN'
        return 0
```

UNKNOWN lets the original rollup failure stand. It does
not `fail()` `ensure_deregistration_delay`. Copying that
onto XFF would not be fail-closed of the pin.

### Fail-closed-on-None is hook discovery

```598:604:.github/scripts/eb-deploy.sh
  if [ -z "${asg}" ] || [ "${asg}" = "None" ]; then
    fail "environment '${EB_ENVIRONMENT_NAME}' returned no Auto Scaling group; refusing to deploy without the ENG-764 termination lifecycle hook."
  fi
```

```1123:1127:.github/scripts/eb-deploy.test.sh
M=$(new_mock_dir)
printf 'None\n' >"$M/asg_name"
run_deploy "$M"
check 'ENG-764: an environment with no ASG fails loudly' 1 \
  'returned no Auto Scaling group'
```

That `None` is “the name we put the hook on is missing.”
Cycle 252: XFF must not copy `AutoScalingGroups[0]`.
Copying the hook’s None-fail onto an attribute scalar
would be the same class of object mix-up.

Events (`L523`): `[ "${out}" = "None" ] && return 0` —
CLI null means “no ERROR events,” not fail-closed.

Hermes / Oh My Pi: no three-way None policy. AgentWeb’s
cutting-edge SDLC is in-process 503; a later XFF pin
should copy ENG-823’s `current != desired` → Modify, not
the hook’s missing-name fail.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** `fail()` on XFF Describe `None` before Modify
  from A-019 (ENG-823 has no pre-Modify value gate; hook
  None-fail is the wrong object).
- Do **not** copy health-probe UNKNOWN onto the pin.
- Do **not** add that pin from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: `eb-deploy.sh` already has **three** None
policies: events `None` → `return 0` (`L523`); hook ASG
`None` → `fail()` (`L598`); ENG-823 attributes: no special
case, Modify. Health-probe lists `grep -v None` is a
fourth. Should a later XFF pin copy ENG-823 and ignore
the others? Do not add a fourth from A-019. Do not
un-park A-020. Do not 503 `/health`. Do not add A-021.
Do not un-ready Q-001 / Q-014 / Q-003. Do not revive
A-006. Do not mint a timer unless Kevin asks.
