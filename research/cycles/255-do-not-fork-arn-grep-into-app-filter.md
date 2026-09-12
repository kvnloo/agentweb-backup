# Cycle 255 — do not fork `grep '^arn:'` into an `/app/` filter from A-019

**Date:** 2026-09-12T09:40:00Z
**Question:** `grep '^arn:'` also matches NLB
(`loadbalancer/net/`) and GWLB (`loadbalancer/gwy/`) ARNs.
XFF `routing.http.xff_*` is ALB-only. The fixture is
`loadbalancer/app/`. Should a later pin filter `/app/`
instead of merely `^arn:`?
**Answer:** **No — do not add an `/app/` filter from
A-019.** Copy `grep '^arn:'`. This tree never emits `net/`
or `gwy/` (zero `LoadBalancerType` / `LoadBalancerIsShared`
in git; type is chosen at create and cannot change). The
only ARN fixture is `loadbalancer/app/`. `timeout.config`
already uses `aws:elbv2:loadbalancer` `IdleTimeout` — the
ALB behavior knob. `routing.http.xff_header_processing.mode`
and `xff_client_port.enabled` are Application Load Balancer
attributes. An `/app/` grep would **fork** XFF from
ENG-823: NLB target groups still have
`deregistration_delay.timeout_seconds`, so the existing
loop is right to keep `^arn:`. If a `net/` ARN appeared,
`modify-load-balancer-attributes` of `xff_*` would fail
the job, not silently pin the wrong type. Do **not** add
that filter from A-019. Do not un-park A-020. Do not 503
`/health`. Do not add A-021.

## Evidence

### Same grep, two jobs

```809:809:.github/scripts/eb-deploy.sh
  lb_arns=$(printf '%s' "${lb_arns}" | tr '\t' '\n' | grep '^arn:' || true)
```

Identical at the health probe (`L311`). Classic bare names
fail closed (`L810–811`; test L791–799
`awseb-e-classic-lb`). Cycle 253: that drop is not a type
filter among elbv2 ARNs. `^arn:` keeps ALB, NLB, and GWLB.

```709:710:.github/scripts/eb-deploy.test.sh
  printf 'arn:aws:elasticloadbalancing:us-west-2:1:loadbalancer/app/awseb-AWSEB-X/abc\n' >"${dir}/lb_arns"
```

Zero `loadbalancer/net/` or `loadbalancer/gwy/` in the
repo outside this cycle’s research notes. `rg
LoadBalancerType|LoadBalancerIsShared` in `*.{config,yml,sh}`
is empty. AWS: you can choose classic / application /
network only at environment **creation**; you cannot change
type later ([shared ALB](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/environments-cfg-alb-shared.html)).

### XFF keys are ALB-only; ENG-823 is not

[Application Load Balancer attributes](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html#load-balancer-attributes):
`routing.http.xff_header_processing.mode` default
`append`; `routing.http.xff_client_port.enabled` default
`false`. Cycle 240 already: those are ENG-493, not an EB
option. They do not exist on Network Load Balancers.

ENG-823 pins **target-group**
`deregistration_delay.timeout_seconds` (L829–845). That
attribute exists on ALB **and** NLB target groups. Filtering
`/app/` on the LB list would skip an NLB that ENG-823
should still repair. Cycle 254: copy pin-all, do not invent
a special case. An `/app/` XFF grep would be that special
case.

`timeout.config` L5–6 `IdleTimeout: 600` is itself ALB
resource config (ENG-836). This environment is already
treated as Application. Switching to NLB is recreate
(cycle 243 / DR L103), not a grep.

Hermes / Oh My Pi: no elbv2 ARN grammar. AgentWeb’s
cutting-edge SDLC is in-process 503 in front of the ALB
this tree already has; do not fork the deploy grep from
A-019.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** add a `loadbalancer/app/` grep from A-019
  (would fork XFF from ENG-823’s `^arn:`).
- Do **not** treat `net/` / `gwy/` as present in this tree.
- Do **not** add that pin from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: if a later XFF pin copied `grep '^arn:'`
and AWS returned a `net/` ARN, `modify-load-balancer-attributes`
of `xff_*` would ValidationError. ENG-823 would still pin
that NLB’s TGs. Is skip-non-app (`continue`) or fail the job
the copy? Skip would be new. After-verify fail is cycle 247.
Do not add skip from A-019. Do not un-park A-020. Do not
503 `/health`. Do not add A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive A-006. Do not mint a timer
unless Kevin asks.
