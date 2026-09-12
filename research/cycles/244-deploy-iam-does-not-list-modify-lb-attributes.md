# Cycle 244 — deploy IAM does not list `ModifyLoadBalancerAttributes`; that grant is live-AWS-only

**Date:** 2026-09-12T07:50:00Z
**Question:** Does deploy IAM even include
`elbv2:ModifyLoadBalancerAttributes`? `eb-deploy.sh` L61–65
lists probe Describe* only. A later sibling would fail the
same way denied `modify-target-group-attributes` already
fails the job (`eb-deploy.test.sh` L876). Are IAM policies
in this repo, or live-AWS-only?
**Answer:** **Live-AWS-only. This tree cannot prove the
grant.** GitHub Actions `permissions:` is `contents: read`
(`deploy.yml` L31–32) — that is the GitHub token, not AWS.
Deploy AWS is access keys for IAM user
`github-actions-deploy-backend` (`README.md` ~L3087;
`configure-aws-credentials` with `secrets.AWS_ACCESS_KEY_ID`,
not OIDC). The only IAM JSON in git is
`backend/src/config/onboarding-loop-iam-policy.json` — an
**instance-role** attach for `aws-elasticbeanstalk-ec2-role`
(S3 / Dynamo / Bedrock / Slack secrets). Zero `elbv2` /
`elasticloadbalancing:` actions there. Header L61–65 is a
**comment** listing extra **probe** Describe* “beyond what
the deploy already used,” not a policy. ENG-823 already
calls `modify-target-group-attributes`; a denied call fails
the job (test L876). That is a **different** IAM action from
`elasticloadbalancing:ModifyLoadBalancerAttributes`. Having
TG modify does not imply LB modify. Do **not** add that pin
from A-019. Do not treat L61–65 as a grant. Do not un-park
A-020. Do not add A-021. Do not 503 `/health`.

## Evidence

### The header comment is not an IAM policy

```61:69:.github/scripts/eb-deploy.sh
# Extra IAM needed for that probe, beyond what the deploy already used:
#   elasticbeanstalk:DescribeInstancesHealth
#   elasticbeanstalk:DescribeEnvironmentResources
#   elbv2:DescribeTargetGroups
#   elbv2:DescribeTargetHealth
```

That list is ENG-878 probe extras. It uses CLI-style
`elbv2:` prefixes. AWS IAM action names are
`elasticloadbalancing:DescribeTargetGroups` etc. Copying
`elbv2:ModifyLoadBalancerAttributes` into a policy from this
comment would be the wrong API string.

`rg ModifyLoadBalancerAttributes` in product git is empty
(research-only). Zero IAM policy documents for
`github-actions-deploy` / `github-actions-deploy-backend`
(DR L272–273). Those users are live-AWS.

### What the script already calls is still not LB-attribute modify

`ensure_deregistration_delay` (`eb-deploy.sh` L842–845)
calls `aws elbv2 modify-target-group-attributes`. Denied:
job fails (`eb-deploy.test.sh` L868–877). That path is
backend-opt-in (`EB_DEREGISTRATION_DELAY_SECONDS: '600'`
at `deploy.yml` L217; partner job unsets it, L793–798
skip). Production deploys that reach SUCCESS after ENG-823
**do** have `ModifyTargetGroupAttributes` on this user —
inferred from the live path, not from a file.

AWS IAM treats
`elasticloadbalancing:ModifyTargetGroupAttributes` and
`elasticloadbalancing:ModifyLoadBalancerAttributes` as
separate actions. Cycle 241 already: TG ARN is the wrong
object for XFF. The same split applies to the grant.

ENG-764 `PutLifecycleHook` is the same pattern: denied
fails closed (`eb-deploy.test.sh` L1110–1114). Still not
an LB-attribute grant.

### Instance role cannot stand in

`onboarding-loop-iam-policy.json` L1: “attach to the EB
backend instance role (`aws-elasticbeanstalk-ec2-role`).”
`aw_backend_user` lacks `iam:CreatePolicy`. Cycle 243:
instance `commands:` would use that role, which has no
elbv2. Deploy-script pin uses the GitHub Actions user, not
the instance.

Hermes / Oh My Pi: no deploy IAM user pinning a cloud
balancer. AgentWeb’s cutting-edge SDLC is in-process 503
plus a later Harsha-granted deploy-script pin if console
XFF drift must be closed — not A-019 guessing the grant.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** treat `eb-deploy.sh` L61–65 as granting
  `ModifyLoadBalancerAttributes`.
- Do **not** treat `ModifyTargetGroupAttributes` (ENG-823)
  as implying the LB-attribute action.
- Do **not** add `modify-load-balancer-attributes` from
  A-019 (grant is live-AWS / Harsha; not in git).

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: a later sibling would also need
`DescribeLoadBalancerAttributes` for the ENG-823 re-read
(cycle 241). L61–65 names neither Describe nor Modify on the
**load balancer**. `DescribeTargetGroupAttributes` is used by
ENG-823 without being in that probe list. Is the re-read
action also live-AWS-only / unnamed? Do not add that pin
from A-019. Do not un-park A-020. Do not 503 `/health`. Do
not add A-021. Do not un-ready Q-001 / Q-014 / Q-003. Do not
revive A-006. Do not mint a timer unless Kevin asks.
