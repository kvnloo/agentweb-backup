# Cycle 031 — Collision: #2563 owns the A-002 copy source, not the walker

UTC: 2026-09-11T19:25Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Same 20 open PRs as cycle 30.** Filter
   `imageGeneration|apiTools|loops/core` still **empty** (A-007 / A-008 /
   A-002 *target* files). Cycle 30’s filter was too narrow for A-002’s
   *copy source*.

2. **#2563** (`swarm/eng-1459-delete-dead-agentmode-transports`, ENG-1459)
   edits `backend/src/__tests__/sdkConstructionGuard.test.ts` **+11 / −0**.
   Patch appends after L208:

   ```
   it('does not retain unreachable AgentMode text-provider adapter remnants…')
     agentModeSource = fs.readFileSync(…/agentModeService.ts)
     expect(…).not.toContain('vertex_client')
     expect(…).not.toContain('vertex_client_promise')
     expect(…).not.toContain('convertContentToAnthropicBlocks')
   ```

   That is a **string-contains remnant check**, not a change to
   `findDirectProviderSdkImports` (`sdkConstructionGuard.test.ts` L41–68:
   `ts.createSourceFile` + `ImportDeclaration` / `require` / dynamic
   `import()`). A-002 copies the walker into a **sibling**
   `loopsCoreImportGuard.test.ts`. Appending the loops/core ratchet onto
   the same `describe('SDK construction guard')` would fight this +11.

3. **#2563 other files** (do not compete): `agentModeService.ts` −44,
   `AGENTMODE_MIGRATION.md` +11, delete
   `agentModeService.anthropicImageBlocks.test.ts`. A-005 pile still
   includes this PR. Walker copy stays valid on current `main`.

4. Neighbors still not on A-007/A-008 paths: **#2861** convert_to_pdf
   adds `agentModeService.convertToPdfFoundation.test.ts` (monolith test,
   not `apiTools.ts`). **#2832** still `emma/tools.ts` (A-004 / Q-004).
   **#2871** work-plan seed scripts, not `workPlanThumbnailService.ts`.

## DISCARD / rank

No rank change. A-002 stays **ready**, collision **1** (copy-source file
is live; walker unchanged; first slice is a new file). A-007 / A-008
stay ready. A-006 stays discard. Product READY unchanged.

## Mapping evidence

A-002 sketch: copy L41–68 `visit()`, not #2563’s `not.toContain` pattern.
Do **not** edit `sdkConstructionGuard.test.ts` while #2563 is open.

## Next

Cycle 32: another collision pass, or map `workflowTools.ts` barrel vs
#2563 leftover if it lands. Unsubscribe after `stop_after`
(2026-09-12T06:00Z).
