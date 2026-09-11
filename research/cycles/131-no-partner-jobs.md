# Cycle 131 — merge-evidence has no `PARTNER_JOBS`; a partner-only PR PASSes with Partner skipped

**UTC:** 2026-09-11T23:50:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 130: GitHub required checks cannot express a
path-conditional gate. Does merge-evidence itself require
`Partner portal build` when the diff is partner-only? File-level.

## Finding

**No. There is no `PARTNER_JOBS`.** Section 7 is backend-only
(`BACKEND_PATHS` L152–154, `BACKEND_JOBS` L160). A partner-only
diff with Partner skipped is an explicit PASS.

Test L1041–1047: same payload as a gate-skipped backend suite
(`GATED_RERUN_RUNS`, Partner portal **tests** skipped L1026)
plus `partner-portal/src/App.tsx` is **PASS**. Comment: “a
frontend-only diff still passes with the backend suite skipped.”
There is no symmetric “partner diff whose Partner job was
skipped is NO_EVIDENCE.”

Test L1194–1205: `partner-portal/src/App.tsx` is in the
`NON_BACKEND` loop that **must** PASS with that skipped payload.

`merge-evidence.test.sh` L1498–1505 only asserts the job *name*
`Partner portal build` exists in `tests.yml`. That is a workflow
invariant, not a ran-successfully requirement. The fixtures still
say **`Partner portal tests`** (L187, L440, L1026, L1191) —
the live job is `Partner portal build` (`tests.yml` L92).
merge-evidence never matches either name for a partner diff.

What still catches a Partner **failure**: `n_bad` (script L596,
L713) is every failed check-run, not only `evset`. Skip and
cancel are the hole, same as ENG-836 (cycles 124–126). Live
failure of `Partner portal build` would still FAIL. A cancelled
or skipped one would not.

Do not add A-021. Do not vendor `/mcp` instead of Q-014.
Hermes/OMP: no partner evidence set.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 132: cheapest remaining. Candidate: the same hole for
CI script tests. `tests.yml` L122 runs them when `.github/**`
(`workflows` filter L47–48). Test L1196–1198: editing
`merge-evidence.sh` itself PASSes with `CI script tests`
skipped. No `WORKFLOW_JOBS`. File-level.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
