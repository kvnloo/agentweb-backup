# Cycle 259 — a later XFF pin copies ENG-823’s None policy; do not add a fourth from A-019

**Date:** 2026-09-12T10:20:00Z
**Question:** `eb-deploy.sh` already has **three** None
policies: events `None` → `return 0` (`L523`); hook ASG
`None` → `fail()` (`L598`); ENG-823 attributes: no special
case, Modify. Health-probe lists `grep -v None` is a
fourth. Should a later XFF pin copy ENG-823 and ignore
the others?
**Answer:** **Yes. Copy ENG-823. Do not add a fourth from
A-019.** Cycle 241: an XFF pin is a sibling of
`ensure_deregistration_delay`, not a lifecycle hook and
not the health probe. Cycle 258: hook None-fail is the
wrong object. Events `None` means “no ERROR events” —
copying that onto XFF would skip the pin (worse than
cycle 257’s None-skip). The probe’s `grep -v None` is a
list filter that yields UNKNOWN, not an attribute scalar
gate. Four existing policies; XFF must not mint a fifth.
Do **not** add that pin from A-019. Do not un-park
A-020. Do not 503 `/health`. Do not add A-021.

## Evidence

### Four Nones, four jobs

| Site | `None` means | Action |
|---|---|---|
| `read_error_events` `L522–523` | CLI null / empty event list | `return 0` (non-fatal) |
| `ensure_termination_lifecycle_hook` `L598–599` | no ASG name to put the hook on | `fail()` (test L1123–1127) |
| `ensure_deregistration_delay` `L836–845` | missing attribute value (`\| [0]`) | attempt Modify (no special case) |
| health probe `L285`, `L352` | empty instance/target **list** | drop the token; UNKNOWN if nothing left |

```522:523:.github/scripts/eb-deploy.sh
  [ -z "${out}" ] && return 0
  [ "${out}" = "None" ] && return 0
```

Copying events onto XFF: Describe `None` would log nothing
and leave `append`/`false` unpinned. That is cycle 257’s
None-skip with a quieter face.

Copying the hook: cycle 258 already refused. Cycle 252:
do not copy `AutoScalingGroups[0]`.

Copying the probe: UNKNOWN does not `fail()` the pin and
does not Modify. Cycle 257 already: do not copy
`grep -v '^None$'` onto the attribute scalar.

ENG-823 is the remaining copy: `current = desired` skip,
else Modify, else `fail()`. Cycle 241 named that sibling.
This tree never emits NLB `None` for those keys on the
live ALB (cycles 253–255).

Hermes / Oh My Pi: one None would be one policy. AgentWeb
already has four in one deploy script; composing a fifth
for XFF from A-019 would be nanoservice-shaped control
flow inside `eb-deploy.sh`. Cutting-edge SDLC is
in-process 503 plus copy-the-sibling, not a new None
enum.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** copy events `None` → `return 0` onto XFF
  (would skip the pin).
- Do **not** mint a fifth None policy from A-019.
- Do **not** add that pin from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: events treats **empty string and** `None`
as the same no-op (`L522–523`). The hook fail-closed uses
**both** `[ -z ]` and `= None` (`L598`). ENG-823 special-cases
neither; empty `!= 600` would Modify. Should a later XFF
pin treat empty like `20` (ENG-823) rather than like hook
empty-OR-None? Do not add `[ -z ]` from A-019. Do not
un-park A-020. Do not 503 `/health`. Do not add A-021.
Do not un-ready Q-001 / Q-014 / Q-003. Do not revive
A-006. Do not mint a timer unless Kevin asks.
