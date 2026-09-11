# Cycle 133 — ENG-1377 relay and remotion builds are unnamed in merge-evidence

**UTC:** 2026-09-11T23:54:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 132: no `WORKFLOW_JOBS`. ENG-1377/1463 added
`Local agent relay build` and `Remotion lambda build`. Does
merge-evidence name those jobs or their paths? File-level.

## Finding

**No. Zero mentions.** The fourth deploy unit’s sibling
packages gained GitHub build jobs; the agent merge gate never
learned the names.

`tests.yml` L149–193 (ENG-1377 / ENG-1463): `Local agent relay
build` if `relay` (L158); `Remotion lambda build` if `remotion`
(L193). Filters: `local-agent-relay/**` and
`remotion-lambda/**`, plus `tests.yml` itself (L56–60).

`merge-evidence.sh` has no `RELAY_JOBS` / `REMOTION_JOBS`.
Grep of `.github/scripts/merge-evidence.sh` and
`merge-evidence.test.sh` for `local-agent-relay`,
`remotion-lambda`, `Local agent relay`, `Remotion lambda`:
**empty**. `paths-filter-hygiene.test.sh` is also empty on
those strings.

Unlike partner (cycle 131), these paths are **not** in the
`NON_BACKEND` loop (test L1194–1199). Partner-only PASS with
Partner skipped is an explicit AC. Relay/remotion skip/cancel
is the same hole **without a regression fixture**. Failure of
either live job still FAILs (`n_bad`). Skip/cancel does not
NO_EVIDENCE, because they are not in `evset` (L606: only
`DRAFT_JOB` + `BACKEND_JOBS`).

Thesis: remotion-lambda is already a deploy unit (finding 1).
A-006 would add a fifth process. These jobs prove
**buildability**, not a product suite (`tests.yml` L150–154).
Unnamed in merge-evidence does not justify HTTP-splitting
Emma. Do not add A-021. Do not vendor `/mcp` instead of Q-014.
Hermes/OMP: no remotion/relay jobs.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 134: cheapest remaining. Candidate: `tests.yml` is in
the `relay` and `remotion` filters (L57, L60) **and** in
`BACKEND_PATHS`. Editing `tests.yml` schedules Backend + relay +
remotion builds (and CI script tests via `.github/**`).
merge-evidence only requires `Backend build`. A cancelled relay
build on a `tests.yml` PR is the same cancelled PASS as ENG-836.
File-level.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
