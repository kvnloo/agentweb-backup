# Cycle 263 — new `ensure_xff_*` sibling; do not stuff XFF into `ensure_deregistration_delay`

**Date:** 2026-09-12T11:00:00Z
**Question:** Cycle 241 said **sibling function**. Should a
later XFF pin be a new `ensure_xff_header_processing` (own
env, own L798 skip) rather than stuffing XFF into
`ensure_deregistration_delay` behind a second var?
Stuffing after L798 re-creates piggyback; stuffing before
L798 hides XFF calls from the opted-out delay test.
**Answer:** **Yes. New sibling. Do not stuff.** Cycle 262
already forbade piggyback on the delay var. Putting XFF
**after** L798 (`[ -z "${desired}" ] && return 0`) makes
empty delay skip XFF even when an XFF env is set — that
is piggyback inside one function. Putting XFF **before**
L798 still always enters via `main()` L897; the opted-out
test (`eb-deploy.test.sh` L814–825) greps
`DeregistrationDelay` only, so an XFF Describe/Modify
would not fail that case. Every fail string in the
function names DeregistrationDelay (L806, L811, L825,
L858). `run_health_probe_dryrun` is already a second
named after-success function (L402, own skip L403), not
stuffed into delay. Do **not** add that pin from A-019.
Do not un-park A-020. Do not 503 `/health`. Do not add
A-021.

## Evidence

### Stuffing after L798 is piggyback

```796:798:.github/scripts/eb-deploy.sh
ensure_deregistration_delay() {
  local desired="${EB_DEREGISTRATION_DELAY_SECONDS:-}"
  [ -z "${desired}" ] && return 0
```

```895:898:.github/scripts/eb-deploy.sh
  log "Deployment of '${EB_VERSION_LABEL}' to '${EB_ENVIRONMENT_NAME}' is complete and verified."

  ensure_deregistration_delay
}
```

Partner/staging always call this function and return at
L798 (cycle 261). XFF after that line cannot have its own
opt-in. Cycle 262.

### Stuffing before L798 hides from ENG-823 tests

```814:825:.github/scripts/eb-deploy.test.sh
# Not opted in (EB_DEREGISTRATION_DELAY_SECONDS unset): zero extra AWS calls.
...
if grep -qF 'DeregistrationDelay' "${WORKDIR}/out.txt"; then
...
pass 'ENG-823: opted-out deploy makes no DeregistrationDelay call'
```

`describe-load-balancer-attributes` /
`modify-load-balancer-attributes` do not match that grep
(cycle 245: those strings are absent from `.github/scripts`
today). Already-correct delay (L840–853) asserts **no**
`modify_tg_calls` file, not “no LB Modify.” A stuffed XFF
pin would need new mocks (`lb_attrs`) the ENG-823 section
does not have. Sibling keeps ENG-823’s name, logs, and
tests about the TG timeout.

Probe dryrun is the existing sibling shape: own function,
own skip, own tests (L899–991 `did not affect this deploy`).
It is **not** inlined into `ensure_deregistration_delay`.

Hermes / Oh My Pi: no two-pins-in-one-deploy-function
fork. AgentWeb’s cutting-edge SDLC is in-process 503; a
later XFF pin should be a named sibling like dryrun, not
a second `desired` inside ENG-823.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** stuff XFF into `ensure_deregistration_delay`
  (after L798 is piggyback; before L798 hides from the
  opted-out delay test).
- New sibling function, own env, own skip.
- Do **not** add that pin from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: `run_health_probe_dryrun` runs **inside**
`verify_deployment` after the SUCCESS log (L740–742) and
**cannot** `fail()` the job (header L32–35; INERT L453).
`ensure_deregistration_delay` runs from `main()` after
verify returns (L897) and **does** `fail()`. Should a later
XFF sibling be called from `main()` next to delay, not
from verify next to dryrun? Do not copy dryrun’s
cannot-fail contract. Do not add that pin from A-019. Do
not un-park A-020. Do not 503 `/health`. Do not add A-021.
Do not un-ready Q-001 / Q-014 / Q-003. Do not revive
A-006. Do not mint a timer unless Kevin asks.
