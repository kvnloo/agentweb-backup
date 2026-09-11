# Cycle 022 — `agentMode/core` ↛ monolith; do not copy the loops/core forbid-all-services rule

UTC: 2026-09-11T19:05Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **`backend/src/services/agentMode/core/` does not import
   `agentModeService.ts`.** Grep for `from '...agentModeService'` and
   `import('...agentModeService')` in `core/` is empty. The strangler
   core is already a one-way leaf relative to the 40.5k file.

2. **Copying the loops/core “no `services/`” rule onto `agentMode/core`
   would fail today.** `core/toolDispatch.ts` L28:
   `import type { AgentToolPolicyDecision } from '../../agentToolGatewayService'`.
   Tests import the same module. Gateway is an injected port (migration
   scorecard). Allowed. A-002 first PR stays `loops/core` only.

3. **`services/agentMode/` (the parent folder) is not a package.**
   `brandLogo.ts` L600–603: `await import('../agentModeService')` with
   comment “agentModeService imports this module, so the reverse edge
   must resolve at call time.” Sibling files import `connectedAccountsDb`,
   `metaService`, `chatbotService`, `attioService`. A folder-wide
   `agentMode/** ↛ agentModeService` guard is false on this tree.

4. **OMP analog:** `pi-agent-core` *may* depend on `pi-ai` (cycle 20).
   AgentWeb `core/toolDispatch` depending on `agentToolGatewayService` is
   that arrow. The 40k `agentModeService.ts` is the blob OMP would put in
   `pi-coding-agent`, not a dependency of core.

## DISCARD / rank

A-002 first_slice narrowed (do not copy forbid-all-services onto
`agentMode/core`). Optional follow-up test: `core ↛ agentModeService.ts`
only. Product READY unchanged. A-006 stays discard.

## Mapping evidence

Sketch `A-002-import-guard-sketch.md` updated with cycle-22 section.

## Next

Cycle 23: collision-only on `apiTools.ts` / `imageGeneration.ts` /
`loops/core`. If still empty, do not rewrite ranks. Unsubscribe after
`stop_after`.
