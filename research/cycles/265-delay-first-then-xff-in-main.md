# Cycle 265 — delay first in `main()`; do not reorder delay behind XFF

**Date:** 2026-09-12T11:20:00Z
**Question:** `main()` would then have delay then XFF, or
XFF then delay. Sequential `fail()` (cycle 256) means
the first miss never reaches the second. Calling XFF
**before** delay would let a new LB IAM miss skip today’s
ENG-823 TG pin. Should delay stay first?
**Answer:** **Yes. Delay first. Do not reorder delay
behind XFF.** `fail()` is `exit 1` (`eb-deploy.sh`
L155–159), not a collected error list. Production
backend always sets delay (`deploy.yml` L217). XFF is a
later opt-in (cycles 261–262). XFF-first would change
today’s SUCCESS path: a missing
`ModifyLoadBalancerAttributes` grant (cycle 244) would
`fail()` before `ensure_deregistration_delay` L897, so
DeregistrationDelay would not be reasserted on that
job. Delay-first: ENG-823 still runs; an XFF miss is
the additional cycle 247 fail after a successful TG pin.
Empty delay is `return 0` (L798), not `fail()`, so
delay-first still reaches XFF when only XFF is set.
Do **not** add that pin from A-019. Do not un-park
A-020. Do not 503 `/health`. Do not add A-021.

## Evidence

### `fail()` never continues

```155:159:.github/scripts/eb-deploy.sh
fail() {
  echo "::error::EB_DEPLOY_FAILED: $*" >&2
  echo "[eb-deploy] EB_DEPLOY_FAILED: $*" >&2
  exit 1
}
```

Cycle 256 already: sequential pin-all never reaches
later ARNs after that exit. Two sibling calls in
`main()` are the same control flow.

```895:898:.github/scripts/eb-deploy.sh
  log "Deployment of '${EB_VERSION_LABEL}' to '${EB_ENVIRONMENT_NAME}' is complete and verified."

  ensure_deregistration_delay
}
```

Today the only after-verify pin is delay. Inserting
XFF **above** L897 is a behavior change to ENG-823
when the new grant is missing. Inserting **below**
preserves L897 for every backend SUCCESS that already
opts into delay.

L798 `return 0` on unset delay is why delay-first does
not starve a delay-unset / XFF-set caller. Partner and
staging omit both (cycle 261); order is then two no-ops.

Hermes / Oh My Pi: no two-pin call-order fork.
AgentWeb’s cutting-edge SDLC is in-process 503; a later
XFF pin should not preempt the live TG pin.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** call XFF before `ensure_deregistration_delay`
  in `main()`.
- Delay first; XFF after. Unset delay still `return 0`
  into XFF.
- Do **not** add that pin from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: delay already rediscovers
`LoadBalancers[*]` (`L802–809`). Health probe does too
(`L302–306`) and does **not** share a helper. Should a
later XFF sibling rediscover after its own skip, rather
than a shared discovery called from `main()` before both
pins? A pre-pin helper would run on partner even when
both unset (cycle 261 zero-call). Do not share from
`main()`. Do not add that pin from A-019. Do not
un-park A-020. Do not 503 `/health`. Do not add A-021.
Do not un-ready Q-001 / Q-014 / Q-003. Do not revive
A-006. Do not mint a timer unless Kevin asks.
