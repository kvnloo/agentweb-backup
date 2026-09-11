# Cycle 124 — ENG-836 path-filter skip is not a draft; conflict job is not the discriminator

**UTC:** 2026-09-11T23:33:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 123: re-draft is `NO_EVIDENCE`. `DRAFT_JOB` is `Detect
changed projects` with no path filter. The conflict job **is**
path-filtered (`ebconfig`). Would a ready `/mcp` PR that also
changes `backend/src` still use detect-changes as discriminator,
or could an ENG-836 skip be misread as draft?

## Finding

**No. An ENG-836 skip cannot be read as draft.** The
discriminator is `Detect changed projects` (`merge-evidence.sh`
L147), gated on `draft == false` **alone** with **no** `needs:`
(`tests.yml` L16–18). `merge-evidence.test.sh` L1426–1433 pins
that invariant: a path filter on that job would make a
path-skipped discriminator indistinguishable from a draft skip.

Once the discriminator **executes**, remaining skips are
path-filter (script L78–81, L970–976). Test AC5 (L352–371):
`CI script tests` skipped does not block PASS; the pass names
`skipped by path filter`. The conflict job is
`if: outputs.ebconfig == 'true'` (`tests.yml` L246) — a path
filter by design, so it **cannot** be the discriminator (script
L74–76).

`BACKEND_JOBS` default is **only** `Backend build` (L160).
`BACKEND_PATHS` is `backend/` plus two CI paths (L152–154).
`backend/.platform/**` is a backend path, so a `/mcp` location
requires Backend build success (section 7), not ENG-836
success. Q-014 (`apiTools.ts` only) skips ENG-836; discriminator
still executed; that skip is AC5, not cycle 122’s draft skip.

ENG-836 **failure** is still `n_bad` (blocks, exit 1). ENG-836
**timeout/cancel** is outside the evidence set (L586–591 names
this job). Do not add A-021. Do not vendor `/mcp` instead of
Q-014. Hermes/OMP: no draft/path-filter discriminator.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 125: cheapest remaining. Candidate: `merge-evidence.sh`
L588 still says the conflict job died at 4m59s against a
**5-minute** ceiling; `tests.yml` L248 is `timeout-minutes: 12`.
Is that comment stale, and does a hung ENG-836 still fail to
block merge?
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
