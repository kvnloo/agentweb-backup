# Cycle 257 — NLB `xff_*` Describe is `None`, then Modify, then fail; do not add a None-skip from A-019

**Date:** 2026-09-12T10:00:00Z
**Question:** ENG-823 skips Modify only after a successful
Describe that equals desired (cycle 246).
`describe-load-balancer-attributes` of `xff_*` on NLB —
empty/`None` vs error? Empty `!= append` would still
attempt Modify, then fail.
**Answer:** **`None`, then Modify, then fail. Do not add a
None-skip from A-019.** This tree has no
`describe-load-balancer-attributes` call (cycle 245). The
ENG-823 analogue is
`Attributes[?Key=='deregistration_delay.timeout_seconds'].Value | [0]`
(`eb-deploy.sh` L831) with `--output text`. AWS CLI prints
`None` for JMESPath null. The attribute path does **not**
`grep -v '^None$'` — that filter is only the health-probe
**list** of instances/targets (`L285`, `L352`). Skip
Modify is only `current = desired` (`L836–838`). `None`
is not `append` / `false` / `600`, so the copy attempts
Modify and `fail()`s (cycle 256). Treating `None` as
already-correct would hide a typo’d Key on an ALB.
Do **not** add that skip from A-019. Do not un-park
A-020. Do not 503 `/health`. Do not add A-021.

## Evidence

### Skip is equality after Describe, not “empty means OK”

```829:839:.github/scripts/eb-deploy.sh
      if ! current=$(aws elbv2 describe-target-group-attributes \
        --target-group-arn "${arn}" \
        --query "Attributes[?Key=='deregistration_delay.timeout_seconds'].Value | [0]" \
        --output text 2>&1); then
        fail "describe-target-group-attributes failed for ${arn}. AWS reported: ${current}"
      fi

      if [ "${current}" = "${desired}" ]; then
        log "DeregistrationDelay already ${desired}s on target group ${arn##*/}; no change needed."
        continue
      fi
```

Cycle 246: already-600s still Describes; it asserts no
Modify. Partner unset is the only zero-call path. A later
XFF pin that copied this would Describe
`routing.http.xff_header_processing.mode` (and
`xff_client_port.enabled`) the same way.

On an Application Load Balancer those keys exist with
defaults `append` / `false` (cycle 240 / AWS ALB
attributes). `None` is not the ALB path.

On a Network Load Balancer the keys are absent from the
attribute list. The same `| [0]` query is null.
`--output text` prints `None`. Describe **succeeds**.
`None != append`, so Modify runs, then ValidationError,
then `fail()` (cycle 256). That is not a Describe error
(`tg_attrs_exit` / cycle 245). Zero tests write `None`
into `tg_attrs`.

### `grep -v '^None$'` is the instance/target list, not attributes

```285:285:.github/scripts/eb-deploy.sh
  instances=$(printf '%s' "${out}" | grep -v '^None$' | grep -v '^[[:space:]]*$' || true)
```

```352:356:.github/scripts/eb-deploy.sh
      targets=$(printf '%s' "${targets}" | grep -v '^None$' | grep -v '^[[:space:]]*$' || true)
      if [ -z "${targets}" ]; then
        EB_UNHEALTHY_DETAIL="target group ${arn##*/} has no registered targets"
        EB_HEALTH_VERDICT='UNKNOWN'
```

Copying that filter onto XFF Describe would turn a
missing Key into “no-op already correct” or into UNKNOWN.
The attribute loop has neither. A None-skip would also
skip an ALB whose query Key was misspelled — the exact
silent-drop class ENG-823 exists to catch (re-read after
Modify, `tg_attrs_stuck` test L856–866).

Hermes / Oh My Pi: no JMESPath `None` vs desired equality.
AgentWeb’s cutting-edge SDLC is in-process 503; a later
XFF pin should copy `current = desired`, not invent
None-skip.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** treat CLI `None` from an XFF Describe as
  already-correct (skip is only `current = desired`).
- Do **not** copy health-probe `grep -v '^None$'` onto
  the attribute scalar.
- Do **not** add that pin from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: if XFF Describe on an ALB returned
`None`, that is a query bug (wrong Key), not an NLB.
Should a later pin `fail()` on `None` before Modify
(like no-targets fails closed) instead of attempting
Modify? That fail-closed would catch a typo earlier.
Do not add it from A-019. Do not un-park A-020. Do not
503 `/health`. Do not add A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive A-006. Do not mint a timer
unless Kevin asks.
