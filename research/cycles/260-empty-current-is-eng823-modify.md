# Cycle 260 — treat empty XFF Describe like `20` (ENG-823 Modify); do not add hook `[ -z ]` from A-019

**Date:** 2026-09-12T10:30:00Z
**Question:** Events treats **empty string and** `None`
as the same no-op (`L522–523`). The hook fail-closed uses
**both** `[ -z ]` and `= None` (`L598`). ENG-823
special-cases neither; empty `!= 600` would Modify.
Should a later XFF pin treat empty like `20` (ENG-823)
rather than like hook empty-OR-None?
**Answer:** **Yes. Treat empty current like `20`. Do not
add hook `[ -z ]` from A-019.** Cycle 259: copy ENG-823.
`[ "${current}" = "${desired}" ]` is false for `""` vs
`append` / `false` / `600`, so Modify runs. The hook’s
`[ -z "${asg}" ] || [ "${asg}" = "None" ]` is missing-name
fail-closed (cycle 258 / 252). Events empty is “no ERROR
list” (`L522` then `L523`). Empty **desired** is a different
variable: `L798` `[ -z "${desired}" ] && return 0` is the
partner opt-in skip (cycle 246), not a Describe-value
gate. Do **not** add `[ -z "${current}" ]` from A-019.
Do not un-park A-020. Do not 503 `/health`. Do not add
A-021.

## Evidence

### Three empties, three variables

```522:523:.github/scripts/eb-deploy.sh
  [ -z "${out}" ] && return 0
  [ "${out}" = "None" ] && return 0
```

```598:599:.github/scripts/eb-deploy.sh
  if [ -z "${asg}" ] || [ "${asg}" = "None" ]; then
    fail "environment '${EB_ENVIRONMENT_NAME}' returned no Auto Scaling group; refusing to deploy without the ENG-764 termination lifecycle hook."
```

```797:798:.github/scripts/eb-deploy.sh
  local desired="${EB_DEREGISTRATION_DELAY_SECONDS:-}"
  [ -z "${desired}" ] && return 0
```

```836:838:.github/scripts/eb-deploy.sh
      if [ "${current}" = "${desired}" ]; then
        log "DeregistrationDelay already ${desired}s on target group ${arn##*/}; no change needed."
        continue
```

`current` is the Describe scalar. Empty `current` is not
empty `desired` and not empty `asg`. Collapsing them with
hook `[ -z ]` would `fail()` (or skip) a successful
Describe that returned `""` — a fifth policy (cycle 259).

AWS CLI `--output text` of JMESPath null is `None`
(cycle 257), not `""`. Zero tests write an empty
`tg_attrs` file. Empty current is unobserved on the
ENG-823 path. The copy still Attempts Modify, then
`fail()`s if the value does not become desired
(`L857–858`).

Hermes / Oh My Pi: no empty-vs-None deploy fork.
AgentWeb’s cutting-edge SDLC is in-process 503; a later
XFF pin should not import the hook’s missing-name
`-z` onto an attribute.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** add hook `[ -z "${current}" ]` from A-019
  (empty current is ENG-823 Modify, like `20`).
- Do **not** conflate empty **desired** (opt-in skip) with
  empty **current**.
- Do **not** add that pin from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: empty **desired** (`L798`) is the partner
zero-call path (cycle 246). Should a later XFF opt-in that
is unset skip like partner, rather than pin AWS defaults
`append`/`false`? Do not treat empty desired as “pin
defaults.” Do not add that pin from A-019. Do not un-park
A-020. Do not 503 `/health`. Do not add A-021. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006. Do
not mint a timer unless Kevin asks.
