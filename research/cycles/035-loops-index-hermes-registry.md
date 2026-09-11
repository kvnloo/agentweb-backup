# Cycle 035 — loops/index.ts is Hermes registry.py; MCP registry is not

UTC: 2026-09-11T19:32Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** (20 open PRs). Filter including `loops/index` /
   `mcp/server/registry`: still only **#2563** →
   `sdkConstructionGuard.test.ts`.

2. **`loops/index.ts` is already the Hermes `registry.py` DAG.** The
   only import is `./core/types` (L20–28). No `instances/`, no
   `services/`, no `db`, no adapters. Comment L15–17: “registry with no
   instances … registered.” Tools/instances plug in from **outside**:
   `app.ts` L118–120 + L475/482/491 explicitly import
   `registerAiEvalFunnelForProduction` / `registerAiReadinessFunnel` /
   `registerAgentModeLoop`. Fourth instance (`onboarding`) is a
   `server.ts` dynamic `import()` (L1151), not a registry scan.
   Four instance folders exist; the composition root lists three
   statically. That is ENG-982 / A-007 explicit imports, **not**
   Hermes `discover_builtin_tools`.

3. **A-002’s two `../index` escapes do not pull the host.**
   `orchestrator.ts` L22–27 and `instanceRunner.ts` L14–22 import
   get/register helpers. Because `index.ts` does not import instances,
   the AST walker will not see `db` through that edge. Runtime sensors
   may close over Dynamo via `DynamoPort`; that is ports, not an import.
   **Second A-002 clause:** also walk `loops/index.ts` and allow only
   `./core/types`. Adding `import './instances/onboarding'` there would
   be auto-discover and would fight cycle 28.

4. **`mcp/server/registry.ts` is not that clean.** L1–3 import
   `evaluationPolicy`, `anonymousToolAccess`,
   `scheduledPublishConsentGuard`. MCP’s registry is already a host
   citizen. Do not copy the loops/index purity rule onto MCP in A-007.
   Keep A-007 as a tool-file split behind `mcpFetch`.

## DISCARD / rank

No rank change. A-002 stays **ready** (add the index.ts allowlist).
Do **not** add instance auto-discovery to `loops/index.ts` (same
family as copying Hermes `discover_builtin_tools` into A-007). A-006
stays discard. Product READY unchanged.

## Mapping evidence

`A-002-import-guard-sketch.md` second clause. `THESIS.md` / `COMPARISON.md`
registry DAG. `COMPOSITION.md` composition root.

## Next

Cycle 36: collision-only unless a cheaper mapping exists. Unsubscribe
after `stop_after` (2026-09-12T06:00Z).
