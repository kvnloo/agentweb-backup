# Cycle 030 — Leaf vs policy callers; OMP npm scope is earendil-works

UTC: 2026-09-11T19:17Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** `imageGeneration|apiTools|loops/core` on 20 open
   `AgentWebPro/agentweb` PRs: **empty.**

2. **Same leaf, two in-process APIs — not two processes.** Policy path:
   `emma/tools.ts` L5062 `agentModeService.generateImage` (category
   required L5052) and `emmaApi.ts` L178. Leaf path (no HITL/logo/category
   wrapper): `controllers/blog.ts` L648, `workPlanThumbnailService.ts` L98,
   `videoGeneration.ts` L875, `onboardingAdImageService.ts`. A-006 as HTTP
   in front of `emmaApi` would miss those callers. A-008 `git mv` +
   `export *` covers **both** because they all import `./imageGeneration`.

3. **OMP live DAG (2026-09-11, `earendil-works/pi` v0.85.1).** Cycle 20
   used `@oh-my-pi/*`. Live packages are `@earendil-works/pi-ai` and
   `@earendil-works/pi-agent-core`. `pi-ai` `package.json` has **no**
   `pi-agent-core` dependency. `pi-agent-core` **does** depend on `pi-ai`.
   Arrow unchanged. AgentWeb mapping still holds; npm scope renamed.

## DISCARD / rank

No rank change. A-006 stays discard (leaf callers would bypass an
emmaApi-only mesh). A-008 stays ready. Product READY unchanged.

## Mapping evidence

`COMPARISON.md` npm names. `COMPOSITION.md` policy vs leaf.

## Next

Cycle 31: collision-only. Unsubscribe after `stop_after` (2026-09-12T06:00Z).
