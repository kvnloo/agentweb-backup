# Cycle 028 — loops/adapters is the host package; Hermes discovers, we list

UTC: 2026-09-11T19:12Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** `imageGeneration|apiTools|loops/core|awsAdapters` on 20
   open `AgentWebPro/agentweb` PRs: **empty.** A-002 / A-007 / A-008 still
   clear.

2. **`loops/adapters` is the OMP host analog; `instances/` are not core.**
   `awsAdapters.ts` L1–12: sibling of `core/` so core never imports it.
   It binds `ports.ts` to `aws-sdk` + Slack (L14–30) and does **not**
   import `services/db.ts`. Instances *may* touch the host:
   `onboarding/index.ts` L35 `userDb`; **`ai-eval-funnel/rcaEnricher.ts`
   L25 + L227 `agentModeService.callLLM`**. A-002 walking `loops/**`
   would fail today. That `callLLM` leak is A-003 / Q-010, not a first
   architecture PR.

3. **Hermes live (NousResearch/hermes-agent `tools/registry.py`).**
   Documented DAG: `registry.py` (no tool imports) ← `tools/*.py`
   (`registry.register()` at import) ← `model_tools.py` via
   `discover_builtin_tools()` (AST scan, skip `mcp_tool.py`). AgentWeb
   `mcpServerCore.ts` L26–30 is a **manual** `import './apiTools'` /
   `evaluationTools` / `workflowTools`. A-007 first slice keeps that
   explicit barrel (ENG-982). Do **not** copy `discover_builtin_tools` in
   the same PR as `tools/infrastructure.ts`.

## DISCARD / rank

No rank change. A-006 stays discard. A-002 scope confirmed: `core/`
only. Product READY unchanged.

## Mapping evidence

A-002 sketch “not in scope” now cites `rcaEnricher.ts`. Hermes discovery
vs MCP manual list.

## Next

Cycle 29: collision-only. Unsubscribe after `stop_after` (2026-09-12T06:00Z).
