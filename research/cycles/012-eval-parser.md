# Cycle 012 — Q-002 eval parser is not a live router

**When:** 2026-09-11T17:40Z  
**Focus:** Pin the `outputSummary` parser so Q-002 cannot be “just add
imageModel to Dynamo.” Do not un-ready Q-001 / Q-014 / Q-003.

## Citations (beyond cycle 4)

- `HumanEvalCandidate` (`humanEvalService.ts` L99–120): PK `candidateId`.
  **No `imageModel`.** `feedback[].text` is free-form Slack (L122–128).
  Status becomes `reviewed` on any reply (L518–535). There is no
  like/reject enum.
- Enqueue format is load-bearing (`agentModeService.ts` L29108–29110):

  `Image generated: ${filename}. Model: ${imageModelUsed}. Size: … Quality: …`

  Parser: first match of `/Model:\s+([A-Za-z0-9._-]+)/` on
  `reviewType === 'creative_image'`. Unknown / missing → skip the row.
  Do not invent a model id.
- `listCandidates` (L476–515): paged **scan**, max 20 pages / 200 items.
  Comment: queue is small. Still forbidden as a per-`generate_image`
  path.
- `imagePromptQualityService` like-rates are **onboarding archetypes**
  (`archetype-A`…`L`), not providers. Do not mix into failover order.
- Adding `imageModel` on `AW-HumanEvalQueue` is a new persistent
  attribute → **Harsha / data-plane**. Out of scope.

## Verdict

Q-003 (live DesignArena, already READY) is the no-table router.
Q-002 is an **offline** report over scanned reviewed rows. It must not
reorder `getImageGenerationFallbackModel` in the request path.

## Queue effect

- **Q-002** triage → **park**. Spec:
  `research/mappings/eval-output-summary.md`.
- No READY shuffle.
