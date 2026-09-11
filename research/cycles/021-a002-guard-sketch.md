# Cycle 021 — Collision clear; A-002 copies sdkConstructionGuard, not depcruise

UTC: 2026-09-11T19:00Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision (AgentWebPro/agentweb open PRs, file filter
   `imageGeneration|apiTools|loops/core|usageRecorder|llmClients`):**
   **empty.** A-002 / A-007 / A-008 still unblocked by live PRs. The
   seven `agentModeService.ts` PRs (cycle 18) still park A-005.

2. **A-002 should not add an npm linter.**
   `backend/src/__tests__/sdkConstructionGuard.test.ts` L15–68 already
   AST-walks imports with TypeScript. Same file is the metering
   invariant guard. A-002 is a sibling test over `loops/core/**`,
   forbidding `/services/` `/emma/` `/db`, **allowing** `../index`
   (`instanceRunner.ts` L8–22 documents that import).

3. **Today’s `loops/core` already passes that contract.** Grep of
   imports: only `../index`, `./ports`, `./types`, in-core relatives.
   No `services/` / `emma/` / `db.ts`. Sketch:
   `research/sdlc/A-002-import-guard-sketch.md`.

## DISCARD / rank

No rank change. A-002 first_slice narrowed (copy sdkConstructionGuard,
do not add dependency-cruiser). Product READY unchanged.

## Mapping evidence

Import-guard sketch. Collision empty vs first-slice files.

## Next

Cycle 22: same collision filter. If still empty, do not rewrite the
architecture queue. Optional: whether `agentMode/core` already imports
`agentModeService` (would block copying the guard there in the same PR).
Unsubscribe after `stop_after`.
