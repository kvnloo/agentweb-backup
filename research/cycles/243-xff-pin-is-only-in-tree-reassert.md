# Cycle 243 — a later ENG-493 pin is the only in-tree reassert of ALB XFF without recreate

**Date:** 2026-09-12T07:40:00Z
**Question:** IdleTimeout console drift is the same survival
class as XFF, but IdleTimeout **is** an EB option
(resource-only PR). XFF is not. Is a later ENG-493 pin the
only in-tree mechanism that can reassert `append`/`false`
without recreating the environment?
**Answer:** **Yes — and today that mechanism does not exist
in product git.** IdleTimeout can be a dedicated
`timeout.config` resource-only PR because
`aws:elbv2:loadbalancer` names `IdleTimeout`. That namespace
cannot name `xff_*` (cycle 240). Recreate-to-defaults would
heal both as a side effect of a **new** ALB, but this tree
has no automated rebuild path
(`docs/disaster-recovery-investigation.md` L103). Among
designs that mutate the **live** balancer without replacing
it, a later `modify-load-balancer-attributes` sibling of
`ensure_deregistration_delay` (cycle 241) is the only one
that can reassert `append`/`false`. Do **not** add that pin
from A-019. Do not un-park A-020. Do not add A-021. Do not
503 `/health`.

## Evidence

### Every in-tree surface that could set XFF, and why it cannot

| Candidate | What it actually does | Can it reassert `append`/`false`? |
|---|---|---|
| `timeout.config` `aws:elbv2:loadbalancer` | `IdleTimeout: 600` only | **No.** Cycle 240: that namespace’s knobs are AccessLogsS3*, `IdleTimeout`, `IpAddressType`, `ManagedSecurityGroup`, `SecurityGroups`, `SharedLoadBalancer`. No `xff_*`. No `LoadBalancerAttributes` JSON. A resource-only IdleTimeout PR is the IdleTimeout heal, not an XFF pin. |
| `.ebextensions` `commands:` / `files:` | `chromium.config` installs Chrome; `06-log-retention.config` is logrotate + CloudWatch logs | **No today.** Zero `aws elbv2` in those keys. They are **instance** keys (`eb-config-conflict.sh` L102–107). Pairing them with `aws:elbv2:` in one Immutable deploy is ENG-836. Instance role is `aws-elasticbeanstalk-ec2-role` (DR L120), not the deploy role that already talks to elbv2. |
| `.platform/hooks` | **Zero** files in this tree | **No.** Cycle 238 already: catch-all `/mcp` nginx is not in git. Hooks are not a hidden pin. |
| `.ebextensions` `Resources:` | `04-disk-alarm.config` L29–46 is `AWS::CloudWatch::Alarm` | **No.** `rg AWS::ElasticLoadBalancing` is empty. A new `AWS::ElasticLoadBalancingV2::LoadBalancer` would create a **second** balancer, not pin attributes on AWSEB’s. |
| `ensure_deregistration_delay` | `modify-target-group-attributes` on TGs after `LoadBalancers[*].Name` | **No.** Cycle 241: wrong object. Passing a TG ARN to `modify-load-balancer-attributes` is the wrong API. |
| `app.set('trust proxy', 2)` | ENG-493 hop count (`app.ts` L168–177; `trustProxy.test.ts`) | **No.** In-process. If ALB mode is `preserve`, hop-count 2 **is** the spoof the comment exists to prevent. It does not write ALB attributes. |
| Recreate the EB environment | Not in `eb-deploy.sh`. DR L103: “No automated rebuild path exists.” | **Out of band.** A new ALB would come up at AWS defaults (`append`/`false`) — a heal by replacement, not a pin on the surviving ARN (cycle 242). |

`rg ModifyLoadBalancerAttributes` / `modify-load-balancer-attributes`
in product git is empty (research-only). `eb-deploy.sh` L61–65
documents probe IAM (`DescribeTargetGroups` /
`DescribeTargetHealth`), not `ModifyLoadBalancerAttributes`.

### IdleTimeout’s resource-only PR does not transfer

ENG-836 / PR #2237: `IdleTimeout` is resource config. A
dedicated resource-only deploy can reassert 600s because
EB **has** that option. The same PR shape cannot name XFF.
Treating “resource-only PR” as a generic ALB-attribute pin
would put unknown keys next to `IdleTimeout` — the ENG-823
silent-drop lesson (cycle 240).

Hermes / Oh My Pi: no environment load balancer. AgentWeb’s
cutting-edge SDLC is in-process 503 on overlap in front of a
**stable** ALB, plus a later deploy-script pin if console
drift must be closed — not recreating the environment as a
composition bus, and not a fifth HTTP service.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** treat a resource-only IdleTimeout PR as also
  pinning XFF (`IdleTimeout` is the only
  `aws:elbv2:loadbalancer` behavior knob).
- Do **not** add `commands:` AWS CLI, `.platform/hooks`, or
  CFN `AWS::ElasticLoadBalancingV2::LoadBalancer` from A-019
  to reassert XFF.
- Do **not** treat environment recreate as an in-tree pin.
- Do **not** add `modify-load-balancer-attributes` from A-019
  (still the later ENG-493 sibling; still not in git).

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: does deploy IAM even include
`elbv2:ModifyLoadBalancerAttributes`? `eb-deploy.sh` L61–65
lists probe Describe* only. A later sibling would fail the
same way denied `modify-target-group-attributes` already
fails the job (`eb-deploy.test.sh` L876). Are IAM policies
in this repo, or live-AWS-only? Do not add that pin from
A-019. Do not un-park A-020. Do not 503 `/health`. Do not add
A-021. Do not un-ready Q-001 / Q-014 / Q-003. Do not revive
A-006. Do not mint a timer unless Kevin asks.
