# Cycle 042 — Services import HTTP controllers (family, not a one-off)

UTC: 2026-09-11T19:52Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** (20 open PRs). `#1076` still touches `chatbotService.ts`.
   `apiTools` / `imageGeneration` / `loops/core` still empty.

2. **Cycle 41 was not a singleton.** Prod `services/` → `controllers/`:

   | Service | Specifier |
   |---|---|
   | `agentModeService.ts` L29894 / L29909 | dynamic `../controllers/blog` |
   | `blogPublishers.ts` L2 | `controllers/blog` CMS helpers |
   | `emmaEmailService.ts` L5 | **static** `generateSessionResponse` from `agentModeController` (also imports `agentModeService` L6) |
   | `revisionService.ts` L144 | dynamic `runVerifiedChat` from `agentModeController`; L385 `controllers/tasks` |
   | `humanEvalActionService.ts` L30 | dynamic `runVerifiedChat` |
   | `chatbotService.ts` L7 / L9 | `controllers/release`, `controllers/docsController` — and L10 `import { Request, Response } from "express"` |

   Hermes `registry.py` does not import the gateway. OMP packages do not
   import the CLI. AgentWeb’s “service” layer already calls the HTTP
   controller, which calls back into the 40k loop.

3. **Matt’s image revision is the confirm=true path Q-014 must not copy.**
   `revisionService.ts` L11–16: user already approved the asset, so the
   prompt tells Emma to pass `confirm=true` and skip HITL. That runs via
   `runVerifiedChat` (controller / quota-gated), not MCP. MCP still has
   `emmaApi.ts` L181 `confirm=undefined` (cycle 39 / A-011). Listing
   `generate_image` on Hermes does not need this path.

4. **A-002 first PR still must not walk `loops/instances/`.** Live:
   `rcaEnricher.ts` L25 imports `agentModeService`, L227 `callLLM`.
   Expanding the AST guard to instances would fail on day one. Keep the
   sketch’s “not in scope” clause.

## DISCARD / rank

New parked **A-013** (inventory of service→controller imports). A-012
stays the blog-only first lift. Product READY unchanged. A-006 stays
discard (HTTP-splitting the leaf does not break these controller imports).

## Mapping evidence

`SERVICES_DAG.md` inventory. `queue.json` A-013. A-002 sketch already
named rcaEnricher; cycle 42 re-verified L227.

## Next

Cycle 43: collision-only unless a cheaper mapping exists. Unsubscribe
after `stop_after` (2026-09-12T06:00Z).
