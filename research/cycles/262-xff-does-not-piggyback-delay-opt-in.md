# Cycle 262 — do not piggyback XFF on `EB_DEREGISTRATION_DELAY_SECONDS`

**Date:** 2026-09-12T10:50:00Z
**Question:** Production backend already sets
`EB_DEREGISTRATION_DELAY_SECONDS`. Should a later XFF pin
**piggyback** on that var being set, rather than a
separate opt-in? Coupling would match today’s caller split
and would pin XFF whenever someone opts into delay.
**Answer:** **No. Do not piggyback.** Cycle 241 already:
sibling function, LB ARN, not the TG loop. Delay’s
`desired` is TG seconds (`eb-deploy.sh` L842–844
`deregistration_delay.timeout_seconds`). XFF desired is
LB `append`/`false` (cycle 240). One env var cannot hold
both. Gating XFF on delay-is-set would: (1) couple two
AWS objects and two IAM actions (`ModifyTargetGroupAttributes`
vs `ModifyLoadBalancerAttributes`, cycle 244); (2) pin
XFF on any later delay opt-in (staging already sets
`EB_SETTLE` independently and omits delay — cycle 261);
(3) forbid XFF without delay. Cycle 261’s empty-desired
skip is **per opt-in**. Independent opt-ins already
exist: delay L798 unset-skip, and
`EB_HEALTH_PROBE_DRYRUN` skip-unless-`1` (L403) — adjacent
in `deploy.yml` L213 / L217, not one flag. Do **not** add
that pin from A-019. Do not un-park A-020. Do not 503
`/health`. Do not add A-021.

## Evidence

### Delay `desired` is a TG timeout, not an XFF mode

```841:844:.github/scripts/eb-deploy.sh
      log "Setting DeregistrationDelay on target group ${arn##*/}: ${current}s -> ${desired}s."
      if ! out=$(aws elbv2 modify-target-group-attributes \
        --target-group-arn "${arn}" \
        --attributes "Key=deregistration_delay.timeout_seconds,Value=${desired}" 2>&1); then
```

`EB_DEREGISTRATION_DELAY_SECONDS: '600'` (`deploy.yml`
L217) is that integer. XFF keys are
`routing.http.xff_header_processing.mode` and
`xff_client_port.enabled` (cycle 240). Piggyback is not
“reuse the value”; it is “if this integer is set, also
hardcode LB attributes.” That is a second pin hiding
behind ENG-823’s opt-in.

### Two opt-ins already sit side by side

```213:217:.github/workflows/deploy.yml
          EB_HEALTH_PROBE_DRYRUN: ${{ inputs.probe_dryrun && '1' || '0' }}
          # ENG-823: `.ebextensions` silently failed to apply this twice, so
          # it is set directly against the live target group instead — see
          # ensure_deregistration_delay() in eb-deploy.sh.
          EB_DEREGISTRATION_DELAY_SECONDS: '600'
```

```402:403:.github/scripts/eb-deploy.sh
run_health_probe_dryrun() {
  [ "${EB_HEALTH_PROBE_DRYRUN}" = "1" ] || return 0
```

Probe dryrun defaults to `0` in the header (L80) and is
listed in Optional environment (L30–35). Delay is **not**
in that header list; its skip is function-local L798.
Partner and staging set neither (cycle 261). Today’s
caller split is two independent omissions, not proof
that XFF should ride delay.

A later staging delay opt-in (copy `600` because
DeregistrationDelay is the drain budget cycle 234 named)
would then take LB Describe+Modify without an XFF grant.
Cycle 247: that IAM miss is GitHub-red / prod-green.
Spreading it by piggyback is the cycle 261 blast-radius
again.

`main()` calls only `ensure_deregistration_delay` after
verify (L897). Sequential `fail()` (cycle 256) means a
piggybacked XFF IAM miss after a successful TG pin still
fails the job — and a delay miss never reaches XFF. Those
are two pins, two grants, two skip tests. They do not
share a var.

Hermes / Oh My Pi: no TG-timeout-vs-XFF deploy fork.
AgentWeb’s cutting-edge SDLC is in-process 503; a later
XFF pin should copy the independent-opt-in shape
(L798 / L403), not hitchhike on `600`.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** piggyback an XFF pin on
  `EB_DEREGISTRATION_DELAY_SECONDS` being set.
- Give XFF its own opt-in (cycle 261 skip-when-unset).
- Do **not** add that pin from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: cycle 241 said **sibling function**.
Should a later XFF pin be a new
`ensure_xff_header_processing` (own env, own L798 skip)
rather than stuffing XFF into `ensure_deregistration_delay`
behind a second var? Stuffing after L798 re-creates
piggyback; stuffing before L798 hides XFF calls from the
opted-out delay test (L814–825 greps
`DeregistrationDelay` only). Do not stuff. Do not add
that pin from A-019. Do not un-park A-020. Do not 503
`/health`. Do not add A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive A-006. Do not mint a timer
unless Kevin asks.
