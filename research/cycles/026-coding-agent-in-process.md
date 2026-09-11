# Cycle 026 — Coding agent is in-process; in-app generate_image skips HTTP

UTC: 2026-09-11T19:07Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision filter** `imageGeneration|apiTools|loops/core|codingAgentService`
   on 20 open `AgentWebPro/agentweb` PRs: **empty.** A-002 / A-007 / A-008
   still clear.

2. **THESIS item 4 was wrong.** `codingAgentService.ts` is **2,387 lines in
   this Node process**, not a child process (`spawn` / `fork` / `Worker`:
   **zero hits**). It statically imports `agentModeService` (L13) for **one
   call**: `getCodingAgentDefaultModel()` (L2176), while `CodingAgentContext.llmModel`
   is already passed from `emma/tools.ts` L7582 and then ignored. Landing-page
   file I/O uses `mcpFetch` (same localhost bus as MCP). Direct `@anthropic-ai/sdk`
   import is why it is on the `sdkConstructionGuard` allowlist. OMP
   `pi-coding-agent` is a **package** depending on `pi-agent-core`; this file
   depends on the 40k god object.

3. **In-app `generate_image` does not loopback.** `agentModeService` L4838
   `executePreparedTools` → `toolDispatch.ts` L930–936
   `ports.executePreparedAgentTool` → L8773 `this.executePreparedAgentTool` →
   L8804 `this.executeTool` (same process). External MCP still loopbacks
   (cycle 25). Two inbound faces, one policy method. Hermes has one
   in-process tool table plus MCP *outbound*.

## DISCARD / rank

No product rank change. **A-010 PARK** (score 23): stop
`codingAgentService` importing `agentModeService` — use `context.llmModel`
(already supplied) or `DEFAULT_CODING_AGENT_MODEL`. Not instead of Q-014 /
A-002 / A-007. A-006 stays discard. Product READY unchanged.

## Mapping evidence

THESIS item 4 corrected. `COMPOSITION.md` in-app path. A-010 in
`sdlc/queue.json`.

## Next

Cycle 27: collision-only. Unsubscribe after `stop_after` (2026-09-12T06:00Z).
