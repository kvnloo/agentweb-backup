# Cycle 018 — Module map, apiTools split, agentModeService collisions

UTC: 2026-09-11T18:50Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **`backend/src` is one npm package with folder-shaped modules.**
   Prod TS LOC: `services/` 217,708 (of which **201,295 in `services/*.ts`
   root**, only 10,167 in `services/agentMode/`). `routes/` 59,572.
   Cross-folder: `routes → services` 398, `services → utils` 250.
   No workspace packages. This is the opposite of OMP `packages/agent`.

2. **`loops/core` is not import-free of the host barrel.**
   `orchestrator.ts` L22–27 and `instanceRunner.ts` L14–22 import
   `../index` (the LOOP_REGISTRY). `instanceRunner.ts` L8–11 says that is
   deliberate. Grep of `loops/core` finds **no** `services/` / `db.ts`
   imports. A-002 CI rule must be: forbid `services|emma|db`, **allow**
   `core → loops/index`.

3. **`apiTools.ts` is already a catalog waiting to be files.**
   85 `mcpToolRegistry.register` calls; section headers at L162, 317,
   426, 495, 746, 883, 1091, 1249, 1319, 1381, 1453, 1519, 1653, 1699,
   1935, 2148, 2489, 2604, 2919, 2935, 3139, 3230, 3359, 3577.
   `workflowTools.ts` is the ENG-982 proof that a sibling file +
   `mcpServerCore.ts` `import './workflowTools'` works. Core still says
   “All 30 tools” (`mcpServerCore.ts` L7) — actually 85+5+1.

4. **Split does not touch #2832.** Open PRs whose files include
   `agentModeService.ts` or `emma/tools.ts`: **#2871, #2861, #2832,
   #2563, #2060, #1584, #1076**; `emma/tools.ts` only: **#689**.
   **None include `apiTools.ts`.** `emma/tools.ts` L7240 imports
   `../mcp/server/apiTools` as a side-effect barrel — keep that path.

5. **A-005 ratchet would fight seven live PRs** on `agentModeService.ts`.
   Park until that set shrinks. Do not land a LOC gate that fails
   convert_to_pdf / X ranking / work-plan PRs.

## DISCARD / rank

- A-006 stays discard.
- **A-007 KEEP → ready:** split `apiTools.ts` along existing section
  comments into `mcp/server/tools/*` + barrel. Hermes one-file-per-tool
  without editing `emma/tools.ts`.
- **A-005 KEEP → park** (collision 2→3, seven PRs). Score 25 unchanged
  enough; status park.
- A-002 first_slice narrowed (allow `../index`).
- Product READY unchanged.

## Mapping evidence

`research/sdlc/MODULE_MAP.md` — draft of a future `backend/src/AGENTS.md`.

## Next

Cycle 19: whether `services/` root files cluster into OMP-like packages
(image/video/billing/crm) without moving `db.ts`; sample 10 largest
`services/*.ts` for a proposed folder DAG. Skip A-006.
