# Cycle 032 — Two MCP hop styles; copy workflowTools not evaluationTools

UTC: 2026-09-11T19:24Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** (20 open PRs). Expanded filter
   `apiTools|imageGeneration|loops/core|sdkConstructionGuard|workflowTools|evaluationTools|mcpServerCore|mcp/server/registry`:
   only **#2563** → `sdkConstructionGuard.test.ts` (cycle 31). A-007
   target files still empty.

2. **`mcpServerCore.ts` L26–30 is already three composition units**, not a
   mesh. Side-effect imports: `./apiTools` (85 `register()`),
   `./evaluationTools` (1), `./workflowTools` (5). Header L7–8 still says
   “All 30 tools are API-wrapping … No direct service calls.” Count is
   **91**. The no-service-call claim is already false on two of the three
   files.

3. **Two hop styles in the same process (the nanoservice answer).**

   | File | Registers | Hop | Service imports |
   |---|---|---|---|
   | `workflowTools.ts` L34–37, L67/191/226/260/300 | 5 (`WORKFLOW_TOOL_NAMES` L335–341) | `mcpFetch` only | **none** |
   | `evaluationTools.ts` L1–5, L7, L62 | 1 `evaluation_workspace` | **in-process** `evaluationStore` / `evaluationPolicy` / `runEvaluation`; then `emmaToolRegistry.register(mcpToolRegistry.getTool(...))` | **yes** |
   | `apiTools.ts` L1996–2146 infrastructure island | 5 | `mcpFetch` (same as workflowTools) | **none** on this island |

   Hermes / OMP: one in-process handler table. AgentWeb already has
   that for eval (dual registry, no localhost). `generate_image` is on
   the **workflowTools hop** (loopback into `emmaApi` → policy). Copying
   the evaluationTools hop onto image gen would skip category / HITL /
   logo — A-006 in a different spelling.

4. **`registry.ts` L22–40 already names the Q-014 design.** `internal`
   is hide-from-`tools/list` only; “cost-driven tools (image generation,
   the searches, `save_file`)” stay callable because ENG-973 meters the
   `/api/emma/*` routes. `generate_image` L2077 is `internal: true` and
   **not** `internalOnly`. `send_email` L2113–2115 is `internal` **and**
   `internalOnly` (ENG-974). Q-014 drops only L2077. A-007 must keep
   send_email’s dual flags.

## DISCARD / rank

No rank change. A-007 stays **ready**: first slice is the same *size* as
ENG-982 (5 tools) and the same *hop* as `workflowTools.ts`. Do **not**
add `import './evaluationTools'`-style `mcpServerCore` import for
infrastructure (that would double-register if also barreled from
`apiTools.ts`). A-006 stays discard. Product READY unchanged.

## Mapping evidence

`A-007-split-map.md` anti-template: evaluationTools. `COMPOSITION.md`
third face. `MODULE_MAP.md` hop column.

## Next

Cycle 33: collision-only unless a new file-level mapping is cheaper.
Unsubscribe after `stop_after` (2026-09-12T06:00Z).
