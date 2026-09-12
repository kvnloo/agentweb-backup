# Cycle 242 — `LoadBalancers[*].Name` stays across Immutable and Sunday; IdleTimeout is not a weekly re-pin

**Date:** 2026-09-12T07:30:00Z
**Question:** Cycle 113 says the ALB survives Immutable ASG swap.
Does `LoadBalancers[*].Name` stay across `update-environment`
Immutable **and** Sunday `InstanceRefreshEnabled`, so console
XFF drift would survive without a pin, while `IdleTimeout`
still reapplies from `timeout.config`?
**Answer:** **The ALB ARN stays. Console XFF drift survives
both paths. `IdleTimeout` does not reapply weekly.** AWS
immutable updates create a temporary Auto Scaling group
**behind the environment’s load balancer** — they do not
replace that balancer. Cycle 113: target groups survive ASG
replacement (`ensure_deregistration_delay` after verify;
ENG-823 already-600s is a no-op). Sunday is also Immutable
(cycle 232) and never calls `eb-deploy.sh` (cycle 110).
`IdleTimeout` is `aws:elbv2:loadbalancer` **resource** config
(ENG-836 / PR #2237). Unchanged `timeout.config` cannot ride
an instance Immutable deploy alongside `.platform`; Sunday
does not apply the bundle at all. Do **not** add
`modify-load-balancer-attributes` from A-019. Do not un-park
A-020 for this (A-020 is the surviving **ASG** hook). Do not
503 `/health`. Do not add A-021.

## Evidence

### AWS: second ASG behind the same balancer

[Immutable environment updates](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/environmentmgmt-updates-immutable.html):
“Elastic Beanstalk creates a second, temporary Auto Scaling
group behind your environment's load balancer.” New instances
serve beside the old; on success EB terminates the temporary
group and old instances. The environment’s ALB is the
constant. `eb-deploy.sh` L802–805 queries
`EnvironmentResources.LoadBalancers[*].Name` and keeps ARNs
(`grep '^arn:'`). That is the same object
`ensure_deregistration_delay` repairs after verify.

Cycle 113 already: “Target groups survive ASG replacement;
lifecycle hooks do not.” `main()` L897 pins the surviving TG.
`eb-deploy.test.sh` L840–852: already `600s` is a **no-op** —
the suite’s ground truth is a TG that still holds last
deploy’s value, not a freshly created group at AWS default
20. If Immutable recreated the ALB/TG every merge, that
no-op would never be the live path.

`asgLifecycleGuard.ts` L51–57: “a hook created once by hand
does not survive Elastic Beanstalk replacing the **ASG**.”
The missing piece is the ASG, not the balancer. ALB
`DeregistrationDelay` 600s (L12) is why drain still needs
Wait — the target stays registered on the surviving LB.

Sunday `InstanceRefreshEnabled` is weekly Immutable (cycle
232; AWS managed updates always use immutable updates).
Same “behind your environment's load balancer.” Cycle 110:
Sunday never runs `eb-deploy.sh`, so it never
`ensure_deregistration_delay` and never applies
`timeout.config`.

### IdleTimeout is not a weekly re-pin

```5:6:backend/.ebextensions/timeout.config
  aws:elbv2:loadbalancer:
    IdleTimeout: 600
```

```6:11:.github/scripts/eb-config-conflict.sh
# Production deploys immutable. AWS refuses:
#
#   ERROR  Cannot update resource configuration and instance configuration
#          simultaneously with immutable deployments.
#
# On 2026-08-01 PR #2237 changed `aws:elbv2:loadbalancer IdleTimeout` (resource)
```

Every backend bundle already ships `timeout.config` **and**
`.platform/nginx`. If unchanged `IdleTimeout` counted as a
resource delta, every merge would be ENG-836. Merges succeed;
therefore EB does not treat the already-applied 600s as a
resource update. Console IdleTimeout drift would survive app
Immutable the same way XFF would. The difference: IdleTimeout
**can** be a dedicated resource-only PR (it is a valid EB
option). XFF cannot (cycle 240: not in
`aws:elbv2:loadbalancer`). Cycle 241’s later pin remains
`modify-load-balancer-attributes` on that stable LB ARN.

Hermes / Oh My Pi: no environment load balancer. AgentWeb’s
cutting-edge SDLC is in-process 503 on overlap in front of a
**stable** ALB, not recreating the balancer as a composition
bus.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** treat `timeout.config` `IdleTimeout` as reapplied
  on every Immutable or Sunday.
- Do **not** un-park A-020 to re-pin XFF (ALB ARN already
  survives without the second put).
- Do **not** add `modify-load-balancer-attributes` from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: IdleTimeout console drift is the same
survival class as XFF, but IdleTimeout **is** an EB option
and can be a resource-only PR. XFF cannot. Does that make a
later ENG-493 pin the only in-tree mechanism that can reassert
`append`/`false` without waiting for someone to recreate the
environment? Do not add that pin from A-019. Do not un-park
A-020. Do not 503 `/health`. Do not add A-021. Do not un-ready
Q-001 / Q-014 / Q-003. Do not revive A-006. Do not mint a timer
unless Kevin asks.
