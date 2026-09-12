# Cycle 248 — a later XFF pin can fail closed before `update-environment`; copying ENG-823’s after-verify slot is a choice

**Date:** 2026-09-12T08:30:00Z
**Question:** ENG-823 is after verify because it repairs the
surviving **target group** after Immutable ASG swap. The ALB
ARN itself already exists before `update-environment`
(cycle 242). Could a later XFF pin run **before**
`update-environment` so an IAM miss fails closed without
applying the version — unlike copying ENG-823’s after-verify
slot?
**Answer:** **Yes. That slot already exists, and it is not
A-020.** `update_environment` waits Ready, then
`ensure_termination_lifecycle_hook` (`eb-deploy.sh` L654–655),
**then** `update-environment` (L658–660). Cycle 247’s
GitHub-red / prod-green split is what you get if the XFF
sibling copies `ensure_deregistration_delay` at L897. The ALB
ARN is already `LoadBalancers[*].Name` on that Ready
environment (cycle 242: Immutable puts a temporary ASG
**behind** it). A later pin that wants fail-closed IAM
would Describe/Modify that ARN next to the hook, before
apply. Hook failure already refuses to start a deploy
(`L614`; test L1110–1117: no `update-environment` after
denied `PutLifecycleHook`). Same shape for denied LB
Describe. Do **not** add that pin from A-019. Do not fold
it into `ensure_termination_lifecycle_hook`. Do not un-park
A-020 (A-020 is a **second** put after verify on the surviving
**ASG**). Do not 503 `/health`. Do not add A-021.

## Evidence

### Fail-closed-before-apply is already the hook’s job

```649:660:.github/scripts/eb-deploy.sh
update_environment() {
  ...
    wait_for_environment_ready "pre-update settle ${attempt}/${EB_UPDATE_MAX_ATTEMPTS}"
    ensure_termination_lifecycle_hook

    log "Applying version '${EB_VERSION_LABEL}' to '${EB_ENVIRONMENT_NAME}' (attempt ${attempt}/${EB_UPDATE_MAX_ATTEMPTS})"
    if out=$(aws elasticbeanstalk update-environment \
```

`ensure_termination_lifecycle_hook` L614: denied put
`fail`s “refusing to start a deploy that could cut off
scheduled work.” Test L1116–1117: `update-environment` is
absent from `operations`. The version is not applied.

ENG-823’s own header (L781–782) says it re-asserts after
a **verified** deploy. That is drift repair once the
version is live, not “the TG did not exist yet.” Cycle 113:
target groups survive ASG replacement. Cycle 242: the ALB
ARN stays. After-verify is a **choice** so a failed apply
does not run the pin — and it is the choice that creates
cycle 247’s split.

XFF attributes are desired state of the **balancer**,
independent of this version. Mutating them before a later
failed `update-environment` is still the desired ALB. IAM
miss before apply leaves prod on the previous version —
fail closed.

### Do not steal A-020’s slot

A-020 is a second `put-lifecycle-hook` after verify on
`AutoScalingGroups[0]` because Immutable **replaces the
ASG**. The ALB is not replaced. Putting XFF in A-020’s
after-verify put would still be the wrong API (cycle 241)
and would keep GitHub-red / prod-green (cycle 247).

Sunday never calls `eb-deploy.sh` (cycle 110). Neither
pre-update nor after-verify runs on the weekly refresh.
Console XFF drift over Sunday still survives until the next
backend merge (cycle 242 IdleTimeout class).

Hermes / Oh My Pi: no pre-update vs after-verify pin slot.
AgentWeb’s cutting-edge SDLC is in-process 503; a later
XFF pin’s fail-closed-before-apply is deploy-script
placement, not A-019.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** treat copying ENG-823’s after-verify slot as
  required for XFF (ALB ARN exists before apply; that copy is
  what makes IAM miss prod-green).
- Do **not** fold an XFF pin into
  `ensure_termination_lifecycle_hook`.
- Do **not** un-park A-020 to hold a pre-update XFF pin.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: Sunday never calls `eb-deploy.sh` (cycle
110), so neither pre-update nor after-verify XFF pin runs
on weekly Immutable. Does fail-closed-before-apply only
help GitHub merges, leaving Sunday console XFF drift in the
same IdleTimeout class (cycle 242)? Do not un-park A-020
for a weekly XFF pin. Do not add that pin from A-019. Do
not 503 `/health`. Do not add A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive A-006. Do not mint a timer
unless Kevin asks.
