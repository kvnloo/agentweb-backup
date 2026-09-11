# Cycle 034 — A-002 oracle is 20 files; Q-014 is a flag not a wrapper

UTC: 2026-09-11T19:30Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** (20 open PRs). Filter
   `apiTools|imageGeneration|loops/core|sdkConstructionGuard|mcp.apiTools.test|httpClient|workflowTools`:
   still only **#2563** → `sdkConstructionGuard.test.ts`.

2. **A-002 oracle file count was wrong; escapes were not.** Walk of
   `backend/src/loops/core/**/*.ts` excluding `__tests__` today:

   | | Cycle 27 | Cycle 34 |
   |---|---|---|
   | Prod `.ts` files | 18 | **20** |
   | `from` / `import()` specifiers | 35 | **35** |
   | Escapes outside `loops/core/` | `orchestrator.ts` L27 `../index`; `instanceRunner.ts` L22 `../index` | **same** |

   Cycle 27 undercounted files (likely skipped `ports.ts` / `types.ts` or
   `digest/` + `tools/`). Specifier count was already right. First-PR
   walker must walk **20** files and still allow only those two escapes.
   Zero `services/` / `emma/` / `db`. No `import()`.

3. **Q-014 first_slice contradicted its own acceptance.** Brief acceptance
   #1: `getToolDefinitions()` includes `generate_image` (`registry.ts`
   L82–86 filters `!t.internal` only). That is **drop `internal: true` at
   `apiTools.ts` L2077**. The brief also said “prefer `emma_generate_image`
   in `workflowTools.ts`.” A wrapper would **leave** `generate_image`
   hidden, so L91 would stay green and acceptance #1 would fail.

   Characterization that **must** change on the flag flip:
   `mcp.apiTools.test.ts` L91 lists `generate_image` among `internalTools`
   (`expect(externalNames).not.toContain(name)`). L405–407 still reads
   the schema via `getTool()` (category required) — keep that; do not
   switch it to `getToolDefinitions()` as the only read. `send_email`
   stays on the L91 list (`internalOnly` L2115).

   **DISCARD** wrapper-as-first-slice. An `emma_*` image job can be a
   later ENG-982 tranche; it is not Q-014. Do not register both names in
   the first PR.

4. **A-007 is a file split, not a `loops/core` package.** `httpClient.ts`
   L63 `await import('../../services/db')` inside `lookupUser`. Every
   mcpFetch (including post-A-007 `infrastructure.ts`) still hits
   Dynamo in-process before the localhost hop. Do not copy the A-002
   forbid-db rule onto `mcp/server`.

## DISCARD / rank

No rank change. Q-014 stays **ready** (flag + L91). A-002 stays **ready**
(oracle files 20). A-006 stays discard. Product READY unchanged.

## Mapping evidence

`A-002-import-guard-sketch.md` oracle. `briefs/Q-014-generate-image-mcp.md`
first_slice. `COMPOSITION.md` httpClient note.

## Next

Cycle 35: collision-only unless a cheaper mapping exists. Unsubscribe
after `stop_after` (2026-09-12T06:00Z).
