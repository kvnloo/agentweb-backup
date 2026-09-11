# Cycle 019 — `services/*.ts` clusters; creative is the only cheap folder move

UTC: 2026-09-11T18:55Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Root `services/*.ts` is 201,295 lines / 348 files.** Top 30 = 109,563
   (54%). `agentModeService.ts` 40,571; `db.ts` 11,671; `v0Service.ts`
   7,348; `chatbotService.ts` 5,692. Heuristic “other” is still 67k / 219
   files — do not folder-spray the long tail.

2. **Fan-in forbids most moves.** Prod importers: `db.ts` **196**,
   `agentModeService` 39, `chatbotService` 36, `imageGeneration` **5**
   (`agentModeService.ts`, `onboardingAdImageService.ts`,
   `workPlanThumbnailService.ts`, `videoGeneration.ts`,
   `controllers/blog.ts`). `usageRecorderService` is a **hub** (20 prod:
   image, video, remotion, voice, `llmClients.ts`, search providers,
   coding agent, Emma recaptcha). Money stays shared.

3. **Creative cluster is already a leaf.**
   `imageGeneration.ts` L1–6: axios, `secretsManager`, `s3Utils`,
   `llmClients`, `usageRecorderService`, `llmPricing` — **no `db.ts`**.
   `videoGeneration.ts` adds `remotionService` + `mcp/client/mcpClientService`
   (one leak; leave it). Grep of creative files for `agentModeService` is
   empty. OMP-shaped package extract = folder + re-export, not a new
   Elastic Beanstalk env.

4. **Still no open PR on `imageGeneration.ts`** (cycle 16/18 collision
   set). Seven PRs still on `agentModeService.ts`. Moving the 40k file
   is still A-003/Q-013-adjacent and discarded as a rename.

## DISCARD / rank

- A-006 stays discard (HTTP).
- **A-008 KEEP → ready:** `git mv` creative files into
  `services/creative/` + barrel re-export. Score 21. After A-002/A-007,
  not instead of Q-014.
- Do **not** add a `services/gtm/` move (contractor).
- Product READY unchanged.

## Mapping evidence

`research/sdlc/SERVICES_DAG.md`.

## Next

Cycle 20: OMP `packages/ai` vs `packages/agent` import direction as the
template for `creative ↛ agentModeService`; do not rewrite ranks unless
a new PR hits `imageGeneration.ts`. Skip A-006.
