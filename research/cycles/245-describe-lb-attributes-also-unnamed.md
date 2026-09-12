# Cycle 245 — `DescribeLoadBalancerAttributes` is also unnamed; ENG-823 re-read has no LB equivalent

**Date:** 2026-09-12T08:00:00Z
**Question:** A later sibling would also need
`DescribeLoadBalancerAttributes` for the ENG-823 re-read
(cycle 241). L61–65 names neither Describe nor Modify on the
**load balancer**. `DescribeTargetGroupAttributes` is used
by ENG-823 without being in that probe list. Is the re-read
action also live-AWS-only / unnamed?
**Answer:** **Yes. Both LB actions are unnamed, and Describe
is not even inferred from today’s SUCCESS path.** Cycle 241
said: resolve `LoadBalancers[*]`, then
`describe-load-balancer-attributes` /
`modify-load-balancer-attributes` on `$lb`, then re-read.
`rg describe-load-balancer-attributes` in `.github/scripts`
is empty. L61–65 still lists only probe Describe* on
instances / target **groups**. ENG-823 already calls
`describe-target-group-attributes` (`eb-deploy.sh` L829–833
pre-read, L851–855 post-verify) **without** listing that
action in L61–65 — that grant is inferred because backend
deploys reach SUCCESS. The mock has `tg_attrs_exit` for a
denied TG describe (`eb-deploy.test.sh` L228–233) but
**zero tests write that fixture**. There is no
`describe-load-balancer-attributes` mock branch at all. A
later sibling cannot copy a test that does not exist, and
cannot infer the LB Describe grant from a call this tree
never makes. Do **not** add that pin from A-019. Do not
un-park A-020. Do not add A-021. Do not 503 `/health`.

## Evidence

### ENG-823 already uses an unnamed Describe

```829:833:.github/scripts/eb-deploy.sh
      if ! current=$(aws elbv2 describe-target-group-attributes \
        --target-group-arn "${arn}" \
        --query "Attributes[?Key=='deregistration_delay.timeout_seconds'].Value | [0]" \
        --output text 2>&1); then
        fail "describe-target-group-attributes failed for ${arn}. AWS reported: ${current}"
```

L61–65 does not name `DescribeTargetGroupAttributes`. The
comment is probe extras, not an inventory of every elbv2
verb the script uses. Production SUCCESS after ENG-823
still implies the **TG** Describe grant. It does not imply
`elasticloadbalancing:DescribeLoadBalancerAttributes`.

Post-verify (L851–855) is the same TG Describe again. Cycle
241’s “then re-read (ENG-823)” for XFF would be
`describe-load-balancer-attributes` on `$lb`, querying
`routing.http.xff_header_processing.mode` and
`routing.http.xff_client_port.enabled`. That CLI does not
appear in this tree.

### The denied-Describe fixture is unused

`eb-deploy.test.sh` L228–233: if `tg_attrs_exit` exists, the
mock fails `describe-target-group-attributes`. `rg
tg_attrs_exit` hits only that mock. Denied **Modify** is
tested (L868–877). Denied **Describe** on the TG is not.
A later sibling that copied “fail like L876” would cover
Modify and still miss a denied LB Describe on the no-op
path (current already `append`/`false` → skip Modify).

### No LB-attribute mock exists

The mock understands `describe-target-groups`,
`describe-target-group-attributes`,
`modify-target-group-attributes`, `describe-target-health`.
Zero `describe-load-balancer-attributes` /
`modify-load-balancer-attributes` cases. Adding the pin is
new script **and** new mock surface, not a one-line IAM
comment on L61–65.

Hermes / Oh My Pi: no ENG-823 re-read. AgentWeb’s
cutting-edge SDLC is in-process 503; the later pin needs
Harsha for **two** unused IAM actions, not A-019.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** treat L61–65 as listing
  `DescribeLoadBalancerAttributes` (it also omits the TG
  Describe ENG-823 already uses).
- Do **not** infer an LB Describe grant from backend SUCCESS
  (that path never calls it).
- Do **not** add `describe-load-balancer-attributes` /
  `modify-load-balancer-attributes` from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: ENG-823 skips Modify when `current` already
equals desired (L836–839; test L840–852 already-600s). A
denied TG Describe fails **before** that skip (L829–833).
Would a later XFF no-op therefore require
`DescribeLoadBalancerAttributes` on every backend SUCCESS
path, even when attributes are already `append`/`false`?
Do not add that pin from A-019. Do not un-park A-020. Do
not 503 `/health`. Do not add A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive A-006. Do not mint a timer
unless Kevin asks.
