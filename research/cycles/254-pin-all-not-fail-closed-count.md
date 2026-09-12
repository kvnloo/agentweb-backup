# Cycle 254 — if two ARNs appeared, copy ENG-823 pin-all; do not fail closed on `count != 1`

**Date:** 2026-09-12T09:30:00Z
**Question:** If two ARNs **did** appear, should a later XFF pin
fail closed on `count != 1` instead of copying ENG-823’s
pin-all loop? ENG-823 pin-all is the existing shape;
uniqueness would be new. `[0]` would be the ASG footgun
(cycle 252).
**Answer:** **Copy pin-all. Do not fail closed on
`count != 1`. Do not take `[0]`.** Cycle 253: this tree and
AWS immutable do not show two ARNs. The hypothetical is
ops shape, not A-019. `ensure_deregistration_delay` already
loops every remaining ARN, then every target group — zero
`exactly one` / `wc -l` / `LoadBalancers[0]` checks in
`eb-deploy.sh`. Multiple TGs are the expected EB-process
case; uniqueness on LB count would invent a special case
the TG path does not have. `[0]` is cycle 252’s A-020
footgun (two ASGs during Updating). A uniqueness fail after
verify would be cycle 247 GitHub-red / prod-green. Do
**not** add that check from A-019. Do not un-park A-020.
Do not 503 `/health`. Do not add A-021.

## Evidence

### Pin-all is already the script’s contract

```814:828:.github/scripts/eb-deploy.sh
  while IFS= read -r lb; do
    [ -z "${lb}" ] && continue
    if ! tg_arns=$(aws elbv2 describe-target-groups \
      --load-balancer-arn "${lb}" \
      --query 'TargetGroups[*].TargetGroupArn' \
      --output text 2>&1); then
      fail "describe-target-groups failed for load balancer ${lb}. AWS reported: ${tg_arns}"
    fi

    tg_arns=$(printf '%s' "${tg_arns}" | tr '\t' '\n' | grep '^arn:' || true)
    if [ -z "${tg_arns}" ]; then
      fail "load balancer ${lb} has no target groups; cannot set DeregistrationDelay."
    fi

    for arn in ${tg_arns}; do
```

Empty is fail (`L809–811` no ALB ARN; `L824–825` no TGs).
Non-empty is pin **all**. `rg` of `eb-deploy.sh` for
`count !=`, `exactly one`, `wc -l`, `LoadBalancers[0]` is
empty. The JMESPath `| [0]` at `L831` is the first matching
**attribute** on one TG, not “pick one balancer.”

Tests fixture one TG (`set_healthy_underlying` L710) the
same way they fixture one LB (cycle 253). Zero tests write
two TGs either. The script still pins N TGs if AWS returned
them — that is how extra EB processes work. A later XFF
sibling that copied this loop would pin every ALB ARN the
same way. Fail-closed `count != 1` would refuse a two-ARN
list that this function would have pinned.

### `[0]` is the wrong uniqueness

Cycle 252: hook discovery `AutoScalingGroups[0]` during
Sunday Updating can be the temporary ASG. Taking
`LoadBalancers[0]` would reintroduce that class (first row
of an unordered `--output text` list) even if two ARNs were
real. Pin-all does not need a first row.

### Uniqueness fail is the cycle 247 split

If a later pin ran after `verify_deployment` SUCCESS
(ENG-823 slot L897) and then `fail()`d on `count != 1`,
Hermes would already be on the new instance (cycle 247).
That is GitHub-red / prod-green, not an A-019 503. Do not
503 `/health` to match the job. Do not add the check from
A-019 to avoid that split.

SharedLoadBalancer (unused, cycle 253) is still **one**
ARN per environment. Uniqueness would not catch
cross-environment blast on a shared ALB; pin-all of one
env’s list would still be one pin.

Hermes / Oh My Pi: no pin-all vs uniqueness fork.
AgentWeb’s cutting-edge SDLC is in-process 503; a later
XFF pin should copy the existing elbv2 loop, not invent a
count gate.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** fail closed on `LoadBalancers` `count != 1`
  (uniqueness would be new; ENG-823 pin-all is the existing
  shape).
- Do **not** take `LoadBalancers[0]` (cycle 252 ASG footgun).
- Do **not** add that check from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: `grep '^arn:'` also matches NLB
(`loadbalancer/net/`) and GWLB ARNs. XFF
`routing.http.xff_*` is ALB-only. The fixture is
`loadbalancer/app/`. Should a later pin filter `/app/`
instead of merely `^arn:`? Do not add that filter from
A-019. Do not un-park A-020. Do not 503 `/health`. Do not
add A-021. Do not un-ready Q-001 / Q-014 / Q-003. Do not
revive A-006. Do not mint a timer unless Kevin asks.
