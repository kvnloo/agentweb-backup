# Cycle 246 — an XFF no-op still needs LB Describe on every opted-in backend SUCCESS

**Date:** 2026-09-12T08:10:00Z
**Question:** ENG-823 skips Modify when `current` already
equals desired (L836–839; test L840–852 already-600s). A
denied TG Describe fails **before** that skip (L829–833).
Would a later XFF no-op therefore require
`DescribeLoadBalancerAttributes` on every backend SUCCESS
path, even when attributes are already `append`/`false`?
**Answer:** **Yes, on every opted-in backend SUCCESS.** Copy
ENG-823: Describe is the gate; skip Modify only after a
successful read whose value already matches desired.
Already-600s (`eb-deploy.test.sh` L840–852) still needs a
working Describe (fixture `tg_attrs=600`); it asserts **no
Modify call**, not “no elbv2.” Denied Describe fails the job
at L829–833 before L836 can `continue`. An XFF sibling
already-`append`/`false` is the same shape: every backend
deploy that sets the opt-in env still calls
`describe-load-balancer-attributes`, even when there is
nothing to pin. Partner skip (env unset) still makes zero
extra calls (L793–798; test L814–825). Harsha must grant
`elasticloadbalancing:DescribeLoadBalancerAttributes` before
that sibling can land as a no-op, or the first merge fails
every backend job while attributes are already correct. Do
**not** add that pin from A-019. Do not un-park A-020. Do
not add A-021. Do not 503 `/health`.

## Evidence

### Skip Modify is after a successful Describe

```829:839:.github/scripts/eb-deploy.sh
      if ! current=$(aws elbv2 describe-target-group-attributes \
        --target-group-arn "${arn}" \
        --query "Attributes[?Key=='deregistration_delay.timeout_seconds'].Value | [0]" \
        --output text 2>&1); then
        fail "describe-target-group-attributes failed for ${arn}. AWS reported: ${current}"
      fi

      if [ "${current}" = "${desired}" ]; then
        log "DeregistrationDelay already ${desired}s on target group ${arn##*/}; no change needed."
        continue
```

The already-correct test (`eb-deploy.test.sh` L840–852)
sets `tg_attrs=600`, expects the “already 600s” log, and
fails if `modify_tg_calls` exists. The Describe still
happens. A later XFF no-op that copied this would query
`routing.http.xff_header_processing.mode` and
`routing.http.xff_client_port.enabled` on `$lb` (cycle 241)
and skip Modify only when both already match. Cycle 245:
that CLI is not in this tree; the grant cannot be inferred
from SUCCESS.

Denied Describe never reaches the skip. Cycle 245: the
`tg_attrs_exit` mock exists and has **zero** tests, but the
script’s `fail` at L833 is unambiguous. An XFF sibling
without the LB Describe grant fails **every** opted-in
backend deploy, including the common already-correct case
(AWS defaults `append`/`false` — cycle 240).

### Partner skip is still the only zero-call path

`EB_DEREGISTRATION_DELAY_SECONDS` unset returns at L797–798
before any elbv2. Partner job does not set it (`deploy.yml`
backend L217 only). An XFF sibling must keep that opt-in
(cycle 241). Sharing the env with partner-deploy would put
LB Describe on the partner SUCCESS path too — same IAM
user, different ALB. Do not.

Hermes / Oh My Pi: no post-verify elbv2 no-op. AgentWeb’s
cutting-edge SDLC is in-process 503; the later pin’s no-op
is still a live AWS read on every backend merge, not A-019.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** treat an already-`append`/`false` ALB as
  skipping LB Describe (ENG-823 skip is after Describe).
- Do **not** add that pin from A-019 (Harsha must grant
  Describe before a no-op sibling can land).
- Do **not** set an XFF opt-in on partner-deploy.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: `main()` logs “complete and verified”
(`eb-deploy.sh` L895) **then** `ensure_deregistration_delay`
(L897). A denied Describe would fail GitHub **after** the
environment is already Ready on the new version. Is a
later XFF pin therefore GitHub-red / prod-green on IAM
miss, not an A-019 503? Do not add that pin from A-019. Do
not un-park A-020. Do not 503 `/health`. Do not add A-021.
Do not un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.
Do not mint a timer unless Kevin asks.
