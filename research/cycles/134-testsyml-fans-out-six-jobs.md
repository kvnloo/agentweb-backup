# Cycle 134 — a `tests.yml` PR schedules six jobs; merge-evidence requires one

**UTC:** 2026-09-11T23:56:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 133: relay/remotion builds are unnamed in merge-evidence.
`tests.yml` is in those filters (L57, L60) **and** in
`BACKEND_PATHS`. Does editing `tests.yml` require only
`Backend build` at the gate while live CI fans out? File-level.

## Finding

**Yes. Six jobs on a `tests.yml`-only ready PR; section 7
requires `Backend build` only.**

`tests.yml` is named in four path filters, and `.github/**`
covers it as a fifth:

| Filter (`tests.yml`) | Job scheduled |
|---|---|
| (none — draft only) L18 | Detect changed projects |
| `backend` L43 | Backend build |
| `workflows` `.github/**` L47–48 | CI script tests |
| `relay` L57 | Local agent relay build |
| `remotion` L60 | Remotion lambda build |
| `ebconfig` L65 | ENG-836 conflict |

Comment L53–54 copies ENG-743 onto relay/remotion: “what
gates a project's merges has to gate its own changes.” That
**schedules** the builds when `tests.yml` moves. It does not
put those names in `evset`.

`BACKEND_PATHS` (script L152–154) includes
`.github/workflows/tests.yml`, so section 7 requires
`Backend build` (L160). Relay, remotion, CI script tests, and
ENG-836 are outside `evset`. Cancelled relay on a `tests.yml`
PR is the same cancelled PASS as ENG-836 (cycles 124–126).
Failure of any of the six still FAILs (`n_bad`).

Partner is **not** in this fan-out (no `partner-portal/**`).
Do not add A-021. Do not vendor `/mcp` instead of Q-014.
Hermes/OMP: no path-filter fan-out table.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 135: cheapest remaining. Candidate: agent-engine is a
deploy unit with **no** GitHub build job. Test L1199:
`agent-engine/web_agent.py` is `NON_BACKEND` and PASSes with
everything skipped. Remotion got ENG-1377; the Python worker
did not. Not a fifth `listen()`. File-level.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
