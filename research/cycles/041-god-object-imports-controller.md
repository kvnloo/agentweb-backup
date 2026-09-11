# Cycle 041 — God object imports a controller (inverted DAG)

UTC: 2026-09-11T19:50Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** (20 open PRs). Leaf image files and `controllers/blog.ts`
   empty. `agentModeService.ts` still **#2871 #2861 #2832 #2563 #2060
   #1584 #1076** — any fix that edits L29894 parks.

2. **`SERVICES_DAG.md` allowed arrow is already false.** Intended:

   ```
   creative leaf  ←  agentModeService  ←  controllers / mcpFetch
   ```

   Live: `agentModeService.ts` **L29894**

   ```
   await import('../controllers/blog')
   ```

   then L29962 / L30001 call `generateBlogImage` (controller helper that
   hits `imageService.generateImage` at `controllers/blog.ts` L648).
   `blogPublishers.ts` L2 also imports `getWebflowConfig` /
   `getWordPressConfig` from that controller.

   Hermes `registry.py` does not import the HTTP gateway. OMP `pi-ai`
   does not import the CLI. AgentWeb’s loop imports a **controller**.

3. **Not a nanoservice.** HTTP-splitting `imageGeneration` would still
   leave L29894. The modular-monolith move is lift `generateBlogImage`
   into `services/creative/` (or `services/blog/`) so the DAG matches
   the diagram. That edit touches the 40k file → **A-012 park** until
   the A-005 pile shrinks. A-008 (`git mv` of `imageGeneration.ts`) does
   **not** fix this; the helper stays in `controllers/blog.ts`.

4. **Quota path (cycle 40) still holds for this call.** L29962 runs
   *inside* a turn that already passed `checkTokenUsage` in the
   controller. `generateBlogImage` itself has no `checkTokenUsage`
   (`controllers/blog.ts` has none). Do not “fix” that by wrapping the
   helper in HTTP.

## DISCARD / rank

New parked **A-012** (score 14). Product READY unchanged. A-006 stays
discard. Q-014 / A-007 / A-008 first slices do not edit L29894.

## Mapping evidence

`SERVICES_DAG.md` live-violation note. `COMPOSITION.md`. `queue.json`
A-012.

## Next

Cycle 42: collision-only unless a cheaper mapping exists. Unsubscribe
after `stop_after` (2026-09-12T06:00Z).
