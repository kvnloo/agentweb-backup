# Cycle 109 — enhanced-health probe is deploy-verify, not drain

**UTC:** 2026-09-11T22:50:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 108: ALB HTTP `/health` cannot stop Hermes during drain.
`eb-deploy.sh` `underlying_health_verdict` *can* see per-instance
`Ok` and target-group `healthy`. Is that the runtime drain
signal — or a GitHub Actions probe that would bless the dying
instance as healthy?

## Finding

**Deploy-verify only. Zero callers in `backend/src`.** The
function lives in `.github/scripts/eb-deploy.sh` L270–375
(ENG-878). It is reached from `verify_deployment` only when the
environment is already Ready on *this* version and the rollup is
still Grey/Red past `EB_HEALTH_SETTLE_SECONDS` (default **180**,
L75 / L745–748). Optional `EB_HEALTH_PROBE_DRYRUN=1`
(`deploy.yml` L213) runs it **after** SUCCESS and cannot change
exit status (L377–391). Comment L379–384: it has **not** executed
on a real deploy since merge.

`LAGGING` means every instance `Ok` and every target `healthy`
while the *aggregate* is still Red — the **new** instance is
already in service and the old one is already gone (L251–257,
#2252 2026-08-03). That is the opposite of drain overlap.

During the four-way wait, `/health` is 200 (cycle 108) so
enhanced health stays `Ok` and the target stays `healthy`. If
this probe ran then it would return `LAGGING` (rollup Red) or
not be asked (rollup Green). It cannot refuse Hermes. Copying it
into the process as a “health nanoservice” would bless the dying
instance. A-019 refuse at `disableCron` is still the gate.

Do not `aws elasticbeanstalk describe-instances-health` from
`runDrain`. Do not HTTP-split to host this probe. Hermes/OMP:
no EB rollup. Cutting-edge SDLC already split *deploy verify*
from *runtime drain*; a fifth `listen()` would confuse them
again.

## Queue effect

A-006 stays **discard**. Q-001 stays **ready**. Q-014 stays
**ready**. A-019 stays **park**.

## Next

Cycle 110: cheapest remaining. Candidate: weekly instance
refresh (`05-instance-recycling.config`) vs this probe — does
refresh overlap the same way immutable does (cycle 96) without
ever hitting `underlying_health_verdict`. Do not un-ready
Q-001 / Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
