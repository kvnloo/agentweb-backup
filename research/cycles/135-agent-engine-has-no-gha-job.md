# Cycle 135 — agent-engine is a deploy unit with no GitHub build job

**UTC:** 2026-09-11T23:58:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 134: `tests.yml` fans out six jobs. Remotion got
ENG-1377. Does agent-engine — already a deploy unit — have a
GitHub build job, or is it the `NON_BACKEND` PASS with
everything skipped? File-level.

## Finding

**No GitHub job. The Python worker is off this Actions graph
by design.**

Grep of `.github/workflows/` for `agent-engine`: **empty**
(`tests.yml` and `deploy.yml`). ENG-1377 added relay and
remotion filters (`tests.yml` L49–60) because those trees
“had no CI of any kind.” Agent-engine was not in that list.

Test L1194–1205: `agent-engine/web_agent.py` is in
`NON_BACKEND` and **must** PASS with backend / partner / CI
script tests skipped. That is the AC: a Python-worker-only
diff is not a backend change and does not require
`BACKEND_JOBS`. There is no job that could have been required.

SDLC for this unit is `agent-engine/deploy/RUNBOOK.md` (GCP
VM, systemd, `agentengine` OS user) — not a GitHub path
filter. Thesis finding 1 already counts it as a deploy unit.
A-006 would add a fifth process next to four that already
exist; agent-engine’s missing GHA job is not a reason to
HTTP-split Emma.

`n_bad` cannot catch an agent-engine build failure: no check-
run is produced. Skip/cancel does not apply. This is a
**missing reporter**, not a skipped required check (cycle
129). Do not add A-021. Do not vendor `/mcp` instead of Q-014.
Hermes/OMP: in-process packages, no sibling Python VM.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 136: cheapest remaining. Candidate: `customer-portal/`
is listed in the same `NON_BACKEND` fixture (test L1044–1047)
and is a **separate GitHub repo**. This tree’s GHA cannot
build it. The four deploy units in the thesis are backend EB,
partner-portal EB, agent-engine GCP, remotion-lambda — customer
portal is a fifth **repo**, not a fifth process on this box.
File-level.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
