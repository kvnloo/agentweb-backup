# Cycle 261 — unset XFF opt-in skips like partner (and staging); do not pin AWS defaults

**Date:** 2026-09-12T10:40:00Z
**Question:** Empty **desired** (`L798`) is the partner
zero-call path (cycle 246). Should a later XFF opt-in that
is unset skip like partner, rather than pin AWS defaults
`append`/`false`? Do not treat empty desired as “pin
defaults.”
**Answer:** **Yes. Skip when unset. Do not pin defaults.**
Copy `[ -z "${desired}" ] && return 0` (`eb-deploy.sh`
L797–798). That skip is not partner-only: production
backend is the **only** caller that sets
`EB_DEREGISTRATION_DELAY_SECONDS: '600'` (`deploy.yml`
L217). Partner (`L315–322`) and staging
(`staging-backend.yml` L127–133) omit it. Test L814–825:
opted-out makes **zero** DeregistrationDelay calls and
still SUCCESS. Treating empty desired as “pin
`append`/`false`” would put LB Describe+Modify on partner
**and** staging (cycles 244–247 IAM), inverting the skip
ENG-823 exists to keep. Cycle 241 already: backend-opt-in.
AWS defaults being the desired values is why an **opted-in**
no-op still Describes (cycle 246), not a reason to drop
the opt-in. Do **not** add that pin from A-019. Do not
un-park A-020. Do not 503 `/health`. Do not add A-021.

## Evidence

### The skip is the first line of the function

```793:798:.github/scripts/eb-deploy.sh
# Skipped entirely when EB_DEREGISTRATION_DELAY_SECONDS is unset, so a caller
# that hasn't opted in (e.g. the partner-portal deploy, which has no such
# requirement) makes zero extra AWS calls.
ensure_deregistration_delay() {
  local desired="${EB_DEREGISTRATION_DELAY_SECONDS:-}"
  [ -z "${desired}" ] && return 0
```

```814:825:.github/scripts/eb-deploy.test.sh
# Not opted in (EB_DEREGISTRATION_DELAY_SECONDS unset): zero extra AWS calls.
...
check 'ENG-823: opted-out deploy still succeeds' 0 'SUCCESS: environment'
...
pass 'ENG-823: opted-out deploy makes no DeregistrationDelay call'
```

A later XFF sibling that copied this would return before
`describe-environment-resources` / elbv2. Pinning defaults
on empty desired would **not** copy L798; it would make
every caller opted-in with hardcoded `append`/`false`.

### Only production backend opts in

```217:217:.github/workflows/deploy.yml
          EB_DEREGISTRATION_DELAY_SECONDS: '600'
```

Partner-deploy env block (`deploy.yml` L315–322) has
`EB_APPLICATION_NAME` / `EB_ENVIRONMENT_NAME` /
timeouts — **no** delay var. Staging
(`staging-backend.yml` L127–133) sets settle/total
timeouts and **no** delay var. `rg
EB_DEREGISTRATION_DELAY_SECONDS` in `.github/workflows`
hits only backend-deploy L217.

Always-on “empty means pin defaults” therefore adds
`DescribeLoadBalancerAttributes` /
`ModifyLoadBalancerAttributes` to:

- partner SUCCESS (cycle 246 already forbade sharing the
  opt-in)
- staging SUCCESS (this cycle: staging never opted into
  ENG-823)

Cycle 247: an IAM miss after verify is GitHub-red /
prod-green. Spreading that to partner and staging is a
larger blast radius, not A-019.

Hermes / Oh My Pi: no opt-in vs pin-defaults fork.
AgentWeb’s cutting-edge SDLC is in-process 503; a later
XFF pin should copy the ENG-823 skip, not turn AWS
defaults into a mandatory elbv2 call.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** treat empty XFF desired as pin AWS defaults
  `append`/`false` (would invert L798; partner **and**
  staging would take elbv2).
- Do **not** set an XFF opt-in on partner-deploy or
  staging-backend (cycle 246).
- Do **not** add that pin from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: production backend already sets
`EB_DEREGISTRATION_DELAY_SECONDS`. Should a later XFF pin
**piggyback** on that var being set, rather than a separate
opt-in? Coupling would match today’s caller split and
would pin XFF whenever someone opts into delay.
Do not piggyback. Do not add that pin from A-019. Do not
un-park A-020. Do not 503 `/health`. Do not add A-021.
Do not un-ready Q-001 / Q-014 / Q-003. Do not revive
A-006. Do not mint a timer unless Kevin asks.
