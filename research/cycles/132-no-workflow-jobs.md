# Cycle 132 — no `WORKFLOW_JOBS`; editing `merge-evidence.sh` PASSes with CI script tests skipped

**UTC:** 2026-09-11T23:52:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 131: no `PARTNER_JOBS`. Same hole for CI script tests?
`tests.yml` L122 runs them when `.github/**`. Test L1196–1198:
editing `merge-evidence.sh` itself PASSes with `CI script tests`
skipped. File-level.

## Finding

**No `WORKFLOW_JOBS`. The gate that tests merge evidence does
not require the job that tests the gate.**

`tests.yml` L116–118: CI script tests “protect the deployment
and merge mechanisms themselves” and run when `.github/**`
(`workflows` filter L47–48). L142 runs
`merge-evidence.test.sh`. Job `if:` is only
`workflows == 'true'` (L122) — no draft clause; drafts still
skip it because it `needs: detect-changes` (cycle 122).

`BACKEND_PATHS` (script L152–154) is `backend/`, `tests.yml`,
`eb-deploy.sh`. `merge-evidence.sh` is **deliberately not** on
that list. Test comment L1183–1185: those CI-path files are
“the easiest place to over-reach when widening BACKEND_PATHS.”
ENG-743 put `tests.yml` / `eb-deploy.sh` in the backend filter;
it did not put the merge-evidence scripts there.

Test L1194–1205: a PR touching **only**
`.github/scripts/merge-evidence.sh` PASSes with
`CI script tests` skipped (`NON_BACKEND_RUNS` L1192). Live
CI would schedule that job (`.github/**`). merge-evidence
would still PASS if the job were skipped or cancelled. Failure
still FAILs (`n_bad`).

Name-exists invariant (test L1498–1505) lists `Backend build`
and `Partner portal build` only. `CI script tests` is not even
required to exist as a string.

This is the self-gate form of cycles 130–131: section 7 is
path-conditional for backend builds; there is no equivalent for
the control-plane suite that includes this script. Do not add
A-021. Do not vendor `/mcp` instead of Q-014.
Hermes/OMP: no merge-evidence analog.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 133: cheapest remaining. Candidate: ENG-1377/1463 added
`Local agent relay build` and `Remotion lambda build`
(`tests.yml` L156 / L191). `merge-evidence.sh` and
`merge-evidence.test.sh` never name those jobs or
`local-agent-relay/` / `remotion-lambda/` paths. Same skip/cancel
hole, and unlike partner it is not even in the `NON_BACKEND`
loop. File-level.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
