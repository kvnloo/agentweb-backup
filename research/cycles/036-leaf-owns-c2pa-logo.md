# Cycle 036 — C2PA and CRITICAL LOGO live in the leaf, not generateImage

UTC: 2026-09-11T19:35Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** (20 open PRs). Filter including `imageGeneration` /
   `brandLogo`: still only **#2563** → `sdkConstructionGuard.test.ts`.

2. **COMPOSITION.md L8 was wrong.** The policy method
   `agentModeService.generateImage` does **not** own metering, C2PA, or
   the CRITICAL LOGO prompt. Those are in the **leaf**:

   | Invariant | File | Lines |
   |---|---|---|
   | `meterUserUsage` / `recordUsage` | `imageGeneration.ts` | L5 import |
   | C2PA strip default-on | `imageGeneration.ts` L575–578 (`removeC2PA !== false`) | `removeC2PAMetadata` L110–128 |
   | CRITICAL LOGO prompt | `imageGeneration.ts` L477–484 (only if `params.logoImage`) | |
   | `category` `ad` \| `organic_post` | `agentModeService.ts` L28876–28884 | ENG-343 |
   | HITL confirm for edits | `agentModeService.ts` L28893–28916 | |
   | Persisted brand logo inject | `agentModeService.ts` L28920–28947 | ENG-326 / 393 |
   | Dynamic import of leaf | `agentModeService.ts` L28950 | A-008 keeps this resolving |

3. **Leaf callers already have C2PA + meter, not category/HITL.**
   `controllers/blog.ts` L648–655 (no `logoImage`, no `category`).
   `workPlanThumbnailService.ts` L98–104 (`removeC2PA: true` explicit,
   `userId: 'workplans'`). `videoGeneration.ts` L875–880. Onboarding
   **does** pass `logoImage` (`onboardingAdImageService.ts` L494) into the
   leaf — so CRITICAL LOGO runs without going through ENG-326 persistence
   gate. A-006 as HTTP in front of `emmaApi` still **misses** those
   callers. It would not “steal C2PA” from them; they already strip in
   the leaf. The discard is: extra hop after policy **and** a second
   face that never sees the mesh.

4. **A-008 is the OMP `pi-ai` move.** Folder-move the leaf so C2PA +
   meter + CRITICAL LOGO stay one package (`creative ↛ agentModeService`).
   Policy stays in the 40k file until the strangler (A-003 / Q-010).
   Q-003 still imports `SUPPORTED_MODELS` via the path shim.

## DISCARD / rank

No rank change. A-006 stays **discard** (leaf vs policy still two
in-process faces; HTTP in front of only one). A-008 stays ready.
Product READY unchanged. COMPOSITION L8 corrected.

## Mapping evidence

`COMPOSITION.md` invariant table. `queue.json` A-006 why. `THESIS.md`
deploy-unit bullet.

## Next

Cycle 37: collision-only unless a cheaper mapping exists. Unsubscribe
after `stop_after` (2026-09-12T06:00Z).
