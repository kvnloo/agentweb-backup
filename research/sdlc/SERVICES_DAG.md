# Proposed `services/` folder DAG (not HTTP)

Cycle 19. **Do not move `db.ts`.** Do not rename `agentModeService.ts`.
This is an in-process package map, the OMP analog inside one npm package.

## Facts

| Slice | Prod LOC (root `services/*.ts`) | Fan-in (prod importers) | Move? |
|---|---|---|---|
| `agentModeService.ts` | 40,571 | 39 prod / 320 total | **No** — 7 open PRs |
| `db.ts` | 11,671 | **196 prod** | **No** — Harsha / data-plane |
| `v0Service.ts` | 7,348 | 11 prod | No — landing contractor lane |
| `chatbotService.ts` | 5,692 | 36 prod | No — Emma sidebar; not first |
| Creative cluster (below) | ~6.5k | image: **5 prod** | **Yes, later (A-008)** |
| `usageRecorderService.ts` | hub | 20 prod (image, video, remotion, voice, llmClients, search, coding agent, …) | **Stay shared** — not a service |

Top 30 files are 109,563 of 201,295 root LOC (54%). The other 219 files are a long tail of “other”; do not folder-spray them.

## Dependency direction (allowed)

```
utils/llmPricing
        ▲
usageRecorderService.ts          ◄── shared meter (PROTOCOL invariant)
        ▲
services/creative/*              ◄── image, video, remotion, voice, thumbs
        ▲
agentModeService.ts / chatbot    ◄── stay put; import creative, never reverse
        ▲
routes / controllers / mcpFetch
```

Creative files today **do not import** `agentModeService` (grep clean).
`videoGeneration.ts` imports `imageGeneration` + `remotionService` +
`meterUserUsage` only. That is already a leaf package.

## Proposed folders (logical nanoservices)

| Folder | Contents | Extract as process? |
|---|---|---|
| `services/creative/` | `imageGeneration`, `videoGeneration`, `remotionService`, `voiceoverService`, `onboardingAdImageService`, `workPlanThumbnailService` | **No.** Keep meter + C2PA + logo in-process. First slice: `git mv` + re-export from old path. |
| `services/money/` | `usageRecorderService`, stripe helpers | **No.** 20 prod importers; moving is path churn for billing tests. |
| `services/agent/` | later, after strangler | **No.** |
| `services/gtm/` | meta, ads, hubspot, crm enrichment | **Do not pick up** (contractor PRs). |
| *(root)* | `db.ts`, `connectedAccountsDb.ts` | **Pinned.** |

## What this is not

- Not A-006 (HTTP image service).
- Not moving `db.ts` behind an API.
- Not npm workspaces (OMP publishes packages; AgentWeb does not need
  that until a second deploy unit exists). Folders + a boundary test
  are enough.

## First move when coding (after A-002 / A-007, not instead of Q-014)

1. `services/creative/imageGeneration.ts`
2. `export * from './creative/imageGeneration'` in the old path so the
   five prod importers (`agentModeService`, `onboardingAdImageService`,
   `workPlanThumbnailService`, `videoGeneration`, `controllers/blog`)
   do not all have to move in the same PR.
3. Boundary test: `creative/**` must not import `agentModeService` or
   `db.ts`. **Already true for `imageGeneration.ts` today** (imports:
   `secretsManager`, `s3Utils`, `llmClients`, `usageRecorderService`,
   `llmPricing` only — no Dynamo). `videoGeneration.ts` also imports
   `mcp/client/mcpClientService` — leave that leak; do not “fix” it in
   the folder-move PR.
