# Cycle 004 — human-eval stored shape (Q-002)

**When:** 2026-09-11  
**Focus:** Can eval-informed image routing use existing items with no new GSI?

## Candidate record (`HumanEvalCandidate`)

PK: `candidateId` only. Fields: `reviewType`, `reviewer`, `status`, `category`
(ad / organic_post / uncategorized), `artifactUrl`, `outputSummary`,
`originalRequest`, `feedback[]` (Slack free text), no `imageModel` attribute.

`listCandidates` is a **paged table scan** with in-memory filters, capped at
20 pages / 200 items (`humanEvalService.ts` ~L476–515). The comment says the
queue is small. A router that scans on every `generate_image` is not
mergeable.

## Where the model name actually is

`agentModeService.generateImage` enqueue (~L29108–29110):

```
outputSummary: `Image generated: ${filename}. Model: ${imageModelUsed}. Size: …`
```

So model **is** in free text, not a typed field. A pure parser over reviewed
items can extract `Model: <id>` without a schema change. Fragile, but no
Harsha gate.

Feedback itself is unstructured Slack ("too busy", "logo wrong"). There is
no like/reject enum on the Matt queue. Like/reject **does** exist on
onboarding (`adImageVariantRatingService`) and is already aggregated by
`imagePromptQualityService` — but that is **archetype/prompt** quality, not
provider/model.

## Q-002 implication

| Approach | Schema | Verdict |
|---|---|---|
| Parse `outputSummary` + treat any Matt reply as a weak label | none | Possible offline job; too weak to drive live failover |
| Scan queue on each generate | none | Reject |
| New GSI / `imageModel` attribute | yes | Park (Harsha) |
| Cache win-rates into existing `settings` JSON on each review | settings put, no table | Possible later; still NLP on Slack text |
| **DesignArena live leaderboard (Q-003)** | none | Stronger first router; does not need Matt's queue |

**Q-002 stays triage**, mergeability stays 3 (parser exists, signal is
weak). **Q-003 is the better no-table router.** Human-eval remains the
taste loop, not the model picker, until someone stores structured verdicts.

Do not add Dynamo attributes in the first slice.
