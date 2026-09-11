# Cycle 125 — 5-minute comment is the #2491 receipt; live ceiling is 12; hung ENG-836 still does not block merge

**UTC:** 2026-09-11T23:35:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 124: ENG-836 skip is not draft; timeout/cancel is outside
the evidence set. `merge-evidence.sh` L588 still says the conflict
job died at 4m59s against a **5-minute** ceiling; `tests.yml`
L248 is `timeout-minutes: 12`. Is that comment stale, and does a
hung ENG-836 still fail to block merge?

## Finding

**The 5-minute string is the #2491 receipt, not the live
ceiling. Live is 12. A hung job still does not block merge.**

`tests.yml` L248 is `timeout-minutes: 12`. ENG-1371
(`3d52a7655`) raised 5→12 because #2491 checkout ran 4m59s
against 5 and GitHub reported `cancelled` (not `timed_out`).
ENG-1463 (`354fc1432`) then **deleted that comment** from
`tests.yml`; the live file has the number and no rationale.
`merge-evidence.sh` L586–591 still narrates the 5-minute
receipt. Two files, two numbers; only one is the ceiling.

`bad` is `failure|neutral|timed_out|action_required|stale`
(script L596) — **not** `cancelled`. GitHub job-timeout is
`cancelled`. Test L860–877: discriminator green + conflict
job `cancelled` is **PASS** (exit 0) — “MUST NOT block”.
Section 6 FAIL is only `n_bad` (L713–715). ENG-1381 inverted
the older “refuses to read as a pass” claim.

The expensive bit remains: conflict job `fetch-depth: 0`
(L255) vs detect-changes `fetch-depth: 1` (L34). 12 minutes
makes #2491’s 4m59s checkout survivable; a hang or
`cancel-in-progress` (L251) still yields `cancelled`, still
outside `BACKEND_JOBS`. A `/mcp` location that never gets
classified can merge if Backend build succeeded. Failure of
the classifier still blocks (`n_bad`). Do not add A-021. Do
not vendor `/mcp` instead of Q-014. Hermes/OMP: no
timeout-as-cancel taxonomy.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 126: cheapest remaining. Candidate: conflict job
`cancel-in-progress: true` (`tests.yml` L251). A second push on
a `/mcp` PR cancels the in-flight classifier — same `cancelled`
PASS as a timeout. Is that the remaining hole, and does Backend
build’s own concurrency group (`L73–75`) save the evidence set?
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
