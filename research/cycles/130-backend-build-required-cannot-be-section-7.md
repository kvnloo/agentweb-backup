# Cycle 130 — naming `Backend build` as required cannot reproduce merge-evidence section 7

**UTC:** 2026-09-11T23:48:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 129: GitHub treats a job-level `if` skip as Success.
Does the same rule apply to `Backend build` (`tests.yml`
L70: path + draft)? If ENG-1373 added that name to required
contexts, would a partner-only PR still merge without it?
File-level.

## Finding

**Yes. Every `tests.yml` job except the discriminator is a
job-level path skip.** Naming `Backend build` as a GitHub
required context would not gate a partner-only PR.

Ready-PR `if:` on every job:

| Job (`tests.yml`) | `if` |
|---|---|
| Detect changed projects | `draft == false` only (L18). **No path filter.** |
| Backend build | `backend == 'true' && draft == false` (L70) |
| Partner portal build | `partner == 'true' && draft == false` (L94) |
| CI script tests | `workflows == 'true'` (L122) |
| Local agent relay build | `relay == 'true' && draft == false` (L158) |
| Remotion lambda build | `remotion == 'true' && draft == false` (L193) |
| ENG-836 conflict | `ebconfig == 'true'` (L246) |

Cycle 129’s GitHub rule: a skipped required job is Success.
A partner-only ready PR therefore:

1. Runs `Detect changed projects` (the only always-reporting
   ready-PR job).
2. Skips `Backend build`. If that name were required
   (ENG-1373 as “add Backend build”), GitHub still merges.
3. merge-evidence section 7 (`BACKEND_JOBS`, script L160)
   requires Backend success **only when** `BACKEND_PATHS`
   (L152–154) are in the diff. GitHub required checks cannot
   express that. They are names, not path-conditional.

`merge-evidence.sh` L869–871 already says requiring Detect
changed projects “does not run the test suite at all.” Cycle
127 showed ENG-1373 never landed. This cycle shows the
plausible landing (“add Backend build”) would still not be
section 7. The script-local path gate is the thing GitHub
required checks cannot do.

Do not add A-021. Do not vendor `/mcp` instead of Q-014.
Hermes/OMP: no path-conditional required checks.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 131: cheapest remaining. Candidate: merge-evidence has
**no** `PARTNER_JOBS`. Test L1498 only asserts the job *name*
exists in `tests.yml`. A cancelled / skipped Partner portal
build is the same hole as ENG-836: failure FAILs (`n_bad`);
skip/cancel does not NO_EVIDENCE. File-level.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
