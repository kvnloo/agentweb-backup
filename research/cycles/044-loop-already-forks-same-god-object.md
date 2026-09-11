# Cycle 044 — The loop already forks; MCP generate_image hits the parent

UTC: 2026-09-11T19:56Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** (20 open PRs). Worker files empty.

2. **Emma chat already runs in a child process.** Not HTTP. Not a
   deploy unit.

   | File | What |
   |---|---|
   | `generateMarketingResponseWorkerService.ts` L6 / L98 | `fork(workerScript)` + IPC; `--max-old-space-size=4096` |
   | `workers/generateMarketingResponseWorker.ts` L6–16 | `new AgentModeService()` — **same 40k class** |
   | L123 | `agentModeService.generateMarketingResponse(...)` |
   | `agentModeController.ts` L8254–8256 | `runInWorker` so health checks keep working |

   IPC already serializes `publishAuthorizationOverride` and
   `approvedRevisionImageSources` (worker service L26–40) — the
   `confirm=true` revision path (cycle 42) is **plain data across the
   fork**, not a REST nanoservice.

3. **Q-014 and in-app Emma already land in different OS processes.**

   - Hermes MCP `mcpFetch` → `localhost:${PORT}` → **parent** Express
     (`emmaApi` + `requireEmmaTokenBudget`) → `generateImage`
   - In-app `generate_image` runs **inside the worker** via
     `generateMarketingResponse`

   Same module graph, two processes per EB instance. A-006 as another
   HTTP image service would be a **third** hop on the same box and
   would still be called from both parent (MCP) and worker (chat).

4. **Hermes/OMP comparison.** Hermes tools stay in the agent process.
   OMP packages stay in-process. AgentWeb forked for **event-loop
   isolation**, then loaded the god object in the child. Cutting-edge
   SDLC here is packages + ports (#2393, A-002), not a second HTTP
   mesh in front of a fork that already exists.

## DISCARD / rank

No rank change. A-006 stays discard (new citation: fork already exists).
Product READY unchanged.

## Mapping evidence

`COMPOSITION.md` parent-vs-worker. `queue.json` A-006 why. `THESIS.md`
runtime processes vs deploy units.

## Next

Cycle 45: collision-only unless a cheaper mapping exists. Unsubscribe
after `stop_after` (2026-09-12T06:00Z).
