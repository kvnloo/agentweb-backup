# Cycle 252 — during Sunday Updating, XFF must use `LoadBalancers[*].Name`, not `AutoScalingGroups[0]`

**Date:** 2026-09-12T09:10:00Z
**Question:** During Immutable Updating, `AutoScalingGroups[0]`
may be the temporary ASG (cycle 113 / A-020).
`describe-environment-resources` returns both ASGs and
LoadBalancers. A pin-only job that copied hook discovery
(`eb-deploy.sh` L591–594 `AutoScalingGroups[0]`) would
target the wrong object. Must XFF use only
`LoadBalancers[*].Name`?
**Answer:** **Yes.** Cycle 241 already: XFF is
`modify-load-balancer-attributes` on the LB ARN. Cycle 251:
a pin-only Sunday job can call `describe-environment-resources`
while Status is Updating. That API returns **both** resource
lists. Hook discovery takes `AutoScalingGroups[0].Name`
(`L593`) — one group, index zero, `awseb-*` check, then
`put-lifecycle-hook`. Cycle 113: that put is on the group
that Immutable **replaces**; the mock is a single
`asg_name` file (`eb-deploy.test.sh` L180–181) and “cannot
see a post-swap second group.” During Sunday refresh there
are two ASGs behind one balancer (cycle 242). `[0]` is
undefined in this tree. Copying L591 for XFF would be the
A-020 footgun on a schedule: pin a temp ASG (or put a hook
on it) while the surviving ALB stays undrifted. XFF must
copy `ensure_deregistration_delay`’s
`LoadBalancers[*].Name` query (`L802–805`, `grep '^arn:'`),
**not** the hook’s `[0]`. Do **not** add that workflow from
A-019. Do not un-park A-020 to hold Sunday XFF. Do not 503
`/health`. Do not add A-021.

## Evidence

### Two queries, two objects

```591:594:.github/scripts/eb-deploy.sh
  if ! asg=$(aws elasticbeanstalk describe-environment-resources \
    --environment-name "${EB_ENVIRONMENT_NAME}" \
    --query 'EnvironmentResources.AutoScalingGroups[0].Name' \
    --output text 2>&1); then
```

```802:805:.github/scripts/eb-deploy.sh
  if ! lb_arns=$(aws elasticbeanstalk describe-environment-resources \
    --environment-name "${EB_ENVIRONMENT_NAME}" \
    --query 'EnvironmentResources.LoadBalancers[*].Name' \
    --output text 2>&1); then
```

The mock branches on whether the query string contains
`AutoScalingGroups` vs LoadBalancers (`eb-deploy.test.sh`
L180–199). They are not interchangeable. Cycle 241: passing
a TG ARN to `modify-load-balancer-attributes` is the wrong
API; passing an ASG name is not even an elbv2 argument.

Cycle 113 L37–40: after verify, `ensure_deregistration_delay`
repairs the **surviving** TG; there is no matching second
hook put — that is A-020. Sunday never reaches after-verify
(cycle 249). A pin-only job that used `[0]` during Updating
would not wait for the surviving ASG to become `[0]`.

AWS immutable: one load balancer, two ASGs for a while.
`LoadBalancers[*]` is the XFF object on both the old and new
instance fleets (cycle 251: pin applies to both).
`AutoScalingGroups[0]` is the A-020 object.

Hermes / Oh My Pi: no ASG vs ALB discovery fork. AgentWeb’s
cutting-edge SDLC is in-process 503; a later Sunday pin must
not steal A-020’s `[0]` query.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** copy `AutoScalingGroups[0]` discovery for XFF
  (Sunday Updating: two ASGs, one ALB).
- Do **not** un-park A-020 to become a Sunday XFF pin.
- Do **not** add that `schedule:` workflow from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: `LoadBalancers[*]` plus `grep '^arn:'`
would pin **every** ALB ARN if the environment ever had two.
Cycle 242 assumes one environment balancer. Does this tree
or AWS immutable ever return more than one
`LoadBalancers[*].Name` during Updating? Do not add that
workflow from A-019. Do not un-park A-020. Do not 503
`/health`. Do not add A-021. Do not un-ready Q-001 / Q-014 /
Q-003. Do not revive A-006. Do not mint a timer unless Kevin
asks.
