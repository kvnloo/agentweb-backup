# Cycle 253 — this tree and AWS immutable do not return two `LoadBalancers[*]` ARNs during Updating

**Date:** 2026-09-12T09:20:00Z
**Question:** `LoadBalancers[*]` plus `grep '^arn:'` would pin
**every** ALB ARN if the environment ever had two. Cycle 242
assumes one environment balancer. Does this tree or AWS
immutable ever return more than one `LoadBalancers[*].Name`
during Updating?
**Answer:** **No.** AWS immutable updates create a second
Auto Scaling group **behind your environment's load balancer**
(singular). Cycle 242 already: two ASGs, one ALB. This
tree never declares `SharedLoadBalancer`, never sets
`loadbalancerType`, and never fixtures two `arn:` lines.
`ensure_deregistration_delay` would pin every ARN if two
ever appeared — that is a defensive loop, not evidence of
two ARNs today. Classic ELB names are dropped by
`grep '^arn:'`. Partner portal is a **different** environment
(`EB_PARTNER_ENVIRONMENT_NAME`), not a second row on the
backend env. Do **not** add a uniqueness check or that pin
from A-019. Do not un-park A-020. Do not 503 `/health`.
Do not add A-021.

## Evidence

### The loop already pins every ARN it sees

```802:814:.github/scripts/eb-deploy.sh
  if ! lb_arns=$(aws elasticbeanstalk describe-environment-resources \
    --environment-name "${EB_ENVIRONMENT_NAME}" \
    --query 'EnvironmentResources.LoadBalancers[*].Name' \
    --output text 2>&1); then
    fail "could not resolve the load balancer for '${EB_ENVIRONMENT_NAME}' to set DeregistrationDelay. AWS reported: ${lb_arns}"
  fi

  lb_arns=$(printf '%s' "${lb_arns}" | tr '\t' '\n' | grep '^arn:' || true)
  if [ -z "${lb_arns}" ]; then
    fail "environment '${EB_ENVIRONMENT_NAME}' has no Application Load Balancer ARN; cannot set DeregistrationDelay via elbv2 (classic ELB is not supported by this path)."
  fi

  while IFS= read -r lb; do
```

The health probe uses the same query and the same
`while IFS= read -r lb` (`L302–320`, `L366`). Copying
ENG-823 for XFF would therefore pin **every** remaining
ARN. That is the existing shape, not a second balancer
during Updating.

### Tests fixture exactly one Application ARN

```706:711:.github/scripts/eb-deploy.test.sh
set_healthy_underlying() {
  local dir="$1"
  printf 'i-0d6a42c54cfc58bd7\tOk\n' >"${dir}/instances_health"
  printf 'arn:aws:elasticloadbalancing:us-west-2:1:loadbalancer/app/awseb-AWSEB-X/abc\n' >"${dir}/lb_arns"
  printf 'arn:aws:elasticloadbalancing:us-west-2:1:targetgroup/awseb-AWSEB-UUBAGFYEVPQ1/def\n' >"${dir}/tg_arns"
```

The mock comment at `eb-deploy.test.sh` L184 allows
“tab/newline separated ALB ARNs”. **Zero** tests write two
`arn:` lines. The only other `lb_arns` writer is classic:

```791:799:.github/scripts/eb-deploy.test.sh
# A classic (non-ALB) load balancer exposes no target-group ARN, so the probe
# cannot speak for it and must not vouch for the deploy.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Red|backend-20260729-pr2216'
set_healthy_underlying "$M"
printf 'awseb-e-classic-lb\n' >"$M/lb_arns"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60'
check 'ENG-878: a classic load balancer leaves the verdict UNKNOWN, so it fails' 1 \
  'no Application Load Balancer ARN'
```

`grep '^arn:'` drops that bare name. Classic+ALB dual-stack
is not a fixture. `rg arn:aws:elasticloadbalancing` in the
test file hits only `set_healthy_underlying`.

### AWS immutable and this tree: one balancer per environment

[Immutable environment updates](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/environmentmgmt-updates-immutable.html):
“Elastic Beanstalk creates a second, temporary Auto Scaling
group behind your environment's load balancer.” The
capacity note is doubling **instances**, not balancers.
Cycle 252: `[0]` is the ASG footgun because **two ASGs**
exist; `LoadBalancers[*]` is the one surviving object.

[Shared Application Load Balancer](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/environments-cfg-alb-shared.html):
you pick **one** ARN at environment **creation**. You cannot
change type after create, and you cannot switch dedicated
↔ shared. `SharedLoadBalancer` is an
`aws:elbv2:loadbalancer` option (cycle 240). Zero hits in
`backend/.ebextensions`. `timeout.config` still only
`IdleTimeout: 600`. Shared would **replace** the dedicated
ALB, not add a second `LoadBalancers[*]` row. Several
environments can share one ALB; each environment’s
`describe-environment-resources` still names that one ARN.

Partner portal is a separate Elastic Beanstalk environment
(`.github/workflows/deploy.yml` `EB_PARTNER_ENVIRONMENT_NAME`
vs `EB_BACKEND_ENVIRONMENT_NAME`). Cycle 246: partner unset
is the only ENG-823 zero-call path. That is not a second
ARN on the backend env.

Hermes / Oh My Pi: no environment load-balancer list.
AgentWeb’s cutting-edge SDLC is in-process 503 in front of
one stable ALB, not composing two balancers as a mesh.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** treat `LoadBalancers[*]` as returning two ARNs
  during Updating (this tree and AWS immutable show one
  environment balancer).
- Do **not** add a uniqueness check from A-019 (the ENG-823
  loop already pins all ARNs; uniqueness would be new).
- Do **not** add that pin from A-019. Do not un-park A-020.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: if two ARNs **did** appear, should a later
XFF pin fail closed on `count != 1` instead of copying
ENG-823’s pin-all loop? ENG-823 pin-all is the existing
shape; uniqueness would be new. `[0]` would be the ASG
footgun (cycle 252). Do not add that check from A-019.
Do not un-park A-020. Do not 503 `/health`. Do not add
A-021. Do not un-ready Q-001 / Q-014 / Q-003. Do not revive
A-006. Do not mint a timer unless Kevin asks.
