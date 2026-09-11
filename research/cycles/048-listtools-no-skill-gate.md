# Cycle 048 — MCP ListTools is getToolDefinitions with no skill gate

UTC: 2026-09-11T20:14Z. Architecture track. `coding_unlocked` true
(Kevin asked for real PRs). Do not un-ready Q-001 / Q-014 / Q-003.
Do not revive A-006. This cycle is research-only (no product edits).

## File-level citations

1. **Collision.** AgentWebPro still 20 open PRs. `apiTools.ts` /
   `imageGeneration.ts` / `loops/core` empty there. Avoid `emma/tools.ts`
   (#2832 #1076 #689), `sdkConstructionGuard.test.ts` (#2563).
   **This fork now owns the first slices:**
   - [kvnloo#2](https://github.com/kvnloo/agentweb/pull/2) — Q-014 + Q-004
   - [kvnloo#3](https://github.com/kvnloo/agentweb/pull/3) — A-002
   Do not open a second `generate_image` listing PR. Do not start A-007
   until #2 merges (`apiTools.ts`).

2. **Hermes `tools/list` is `getToolDefinitions()` with no second filter.**
   Cycle 47 named three catalogs. This cycle names the live MCP handler:

   ```
   mcpServerCore.ts L7–8   "No skill-gating for external clients."
   L76–83  ListToolsRequestSchema → mcpToolRegistry.getToolDefinitions()
           "ALL clients now see all tools (no skill-gating)."
   ```

   There is no `buildSkillContext`, no `pageToolMap`, no foundation
   set on this path. Q-014’s flag drop **is** Hermes discovery. That
   is why A-014 parks copying chatbot/Agent Mode gates onto MCP: the
   handler already promises one catalog. Hermes would not add a
   second filter here.

3. **Execute is still not a nanoservice.** `CallToolRequestSchema`
   (`mcpServerCore.ts` L88) runs in-process `registry.execute` with
   `externalMcp: isInternal !== true` (L114–116). Q-014 listing does
   not add a hop. A-006 stays discarded.

## DISCARD / rank

No rank change. Q-001 / Q-014 / Q-003 stay **ready** (Q-014/Q-004
and A-002 are in flight as #2 / #3, not discarded). A-006 stays
discard. A-007 waits on #2.

## Mapping evidence

`COMPOSITION.md` ListTools. `README.md` points at #2 / #3.

## Next

Cycle 49: collision-only unless a cheaper mapping exists. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006. Unsubscribe
after `stop_after` (2026-09-12T06:00Z).
