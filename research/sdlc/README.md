# Architecture / SDLC research track

Kevin asked (2026-09-11): methods to break AgentWeb into nanoservices that
compose; compare agentic-dev code quality to Hermes and Oh My Pi (OMP);
compare to cutting-edge strategies; improve the SDLC to get there.

This is a **parallel track** to the product queue (`QUEUE.md`). It does
**not** un-ready Q-001 / Q-014 / Q-003. `coding_unlocked` is **true**
(Kevin asked for real PRs; product work is on `#2` / `#3`, not this
research branch). Cycle 59 parked A-017 (CRM/worker → `server.ts`).
Cycle 90 parked A-018 (copy the file-config `isInternal` skip onto
the Dynamo MCP loader; do not HTTP-split).

| Artifact | Role |
|---|---|
| `THESIS.md` | What to copy vs discard |
| `COMPARISON.md` | Hermes / OMP / AgentWeb, with file-level numbers |
| `queue.json` + `QUEUE.md` | A-items (architecture), not product ranks |
| `A-007-split-map.md` | Section → file map; first slice is infrastructure.ts |
| `COMPOSITION.md` | MCP loopback, in-app dispatch, agent-engine JWT |
| `../cycles/017-*.md` | First architecture cycle receipt |

Product work when unlocked is still Q-014. This track answers “how the
repo should be shaped so agents can change it.”
