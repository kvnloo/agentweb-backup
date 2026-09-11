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
That is the same arrow as OMP `pi-ai ↛ pi-agent-core` (cycle 20
`package.json`). `videoGeneration.ts` also imports `mcpClientService`
(leave that leak). `utils/llmClients.ts` importing `usageRecorderService`
is the inverted layer vs OMP `pi-utils` (A-009).

Cycle 41: the **reverse** arrow is already live. `agentModeService.ts`
L29894 `await import('../controllers/blog')` then calls
`generateBlogImage` (L29962 / L30001). `blogPublishers.ts` L2 imports
CMS config helpers from the same controller. Intended DAG is
controllers → services; actual is services → controllers. A-012
parks lifting the helper. A-008 does not fix it.

Cycle 42 — full prod inventory (`services/` → `controllers/`):

| Service | Import |
|---|---|
| `agentModeService.ts` L29894, L29909 | `controllers/blog` (dynamic) |
| `blogPublishers.ts` L2 | `controllers/blog` |
| `emmaEmailService.ts` L5 | `agentModeController.generateSessionResponse` (static) + `agentModeService` L6 |
| `revisionService.ts` L144 / L385 | `runVerifiedChat`; `controllers/tasks` |
| `humanEvalActionService.ts` L30 | `runVerifiedChat` |
| `chatbotService.ts` L7, L9, L10 | `release`, `docsController`, and **Express `Request`/`Response` types** |

`revisionService.ts` L11–16 is the in-app `confirm=true` revision
path (Matt / Slack). Not MCP. A-013 parks the family. Do not HTTP-split.

Cycle 59 — prod importers of the **listen module** (`server.ts`), not
controllers:

| File | Import | Why |
|---|---|---|
| `routes/crm.ts` L24 | `import { io } from '../server'` | `app.ts` → CRM → `listen()` (ENG-1286). 7,815 lines; four `io.to().emit` |
| `crmEnrichmentService.ts` L67 | `require('../server')` | `getIO()` for `defaultSocketEmit` |
| `generateMarketingResponseWorkerService.ts` L184 | `require('../server')` | parent `socketEmit` IPC |

`sessionSockets.ts` already injects `io` for password-change
`fetchSockets`. A-017 expands that port with `to(room).emit`. Do not
add Socket.IO to `LoopPorts` (cycle 60: copy `getFathomLinearPort`,
`fathomWebhook.ts` L39). `#1790` still touches `crm.ts`. Cycle 62:
only `server.ts` L186 joins `user:`; CRM `socket.id`; codingAgent
`sessionId` with no join. A-017 does not unify rooms. Cycle 63: dynamic `import('../server')`
in gtmPlan / admin / durableLanding / agentModeController (seven)
is the rest of the leak. Do not start A-017 at the 15k controller.

## Proposed folders (logical nanoservices)

| Folder | Contents | Extract as process? |
|---|---|---|
| `services/creative/` | `imageGeneration`, `videoGeneration`, `remotionService`, `voiceoverService`, `onboardingAdImageService`, `workPlanThumbnailService` | **No.** Meter + C2PA + CRITICAL LOGO already live in the leaf (`imageGeneration.ts` L5 / L575–578 / L477–484). Policy (category / HITL / persisted logo) stays in `agentModeService`. First slice: `git mv` + path shim. |
| `services/money/` | `usageRecorderService`, stripe helpers | **No.** 20 prod importers; moving is path churn for billing tests. |
| `services/agent/` | later, after strangler | **No.** Live inbound root is still `agentModeController` three exports (cycle 43). #2393 adds `services/conversation/` — do not duplicate. |
| `services/gtm/` | meta, ads, hubspot, crm enrichment | **Do not pick up** (contractor PRs). |
| *(root)* | `db.ts`, `connectedAccountsDb.ts` | **Pinned.** |

## What this is not

- Not A-006 (HTTP image service). Cycle 68: a fifth process would
  also miss the ASG termination hook (`asgLifecycleGuard.ts`).
  Cycle 69: inbound MCP `CallTool` is already off `runDrain`'s
  wait list; a fifth listen would not join it. Cycle 70: wrap
  `CallTool` once for local + rehydrate faces. Cycle 73: even this
  process's `server.close()` is not in the await the hook waits on.
  Cycle 74: `workerShutdownGuards.ts` (ENG-201) is the in-tree
  rejection of “just add a process.” Cycle 75: the 900s ASG hook
  is never heartbeated from TypeScript. Cycle 76: `/mcp` is on
  the 600s nginx/ALB path; only `/socket.io/` is 3600s. Cycle 77:
  `generate_image` mcpFetch default abort is 5 min, not 10.
  Cycle 78: leaf withTimeout is 8 min (ENG-510); MCP is 5.
  Cycle 79: mcpFetch abort does not cancel the leaf or skip meter.
  Cycle 80: MCP generate-image is outside tryClaimSessionGeneration.
  Cycle 81: quota is check-then-act; increment after success.
  Cycle 82: image meter is $ / 0 tokens; default gate is tokens.
  Cycle 83: CallTool is not serialized (SDK streamId per POST).
  Cycle 84: extra-cost admission is dead; images do not write it.
  Cycle 85: default image is $0.134; gpt-image-2 is $0.04.
  Cycle 86: video same meter, not on MCP (Q-016 parked).
  Cycle 87: AgentWebPro empty on apiTools / meter / wrap files.
  Cycle 88: OMP 0.85.1 unpublished experimental client/server.
  Cycle 89: Hermes still MCP client; parallel opt-in default false.
  Cycle 90: self-MCP skip is file-config only; DB path can loopback.
  Cycle 91: live MCP face is /mcp; /mcp/server is stale.
  Cycle 92: inspector is SSE against that dead path.
  Cycle 93: mcpShutdown races runDrain on SIGTERM (closes first).
  Cycle 94: shutdown is local-only; ENG-114 store outlives SIGTERM.
- Not moving `db.ts` behind an API.
- Not npm workspaces (OMP publishes packages; AgentWeb does not need
  that until a second deploy unit exists). Folders + a boundary test
  are enough.

## First move when coding (after A-002 / A-007, not instead of Q-014)

1. `services/creative/imageGeneration.ts`
2. After `git mv`, leave a **compat shim** at the old path
   `services/imageGeneration.ts`: `export * from './creative/imageGeneration'`.
   That is **not** `services/swarm/index.ts` (folder barrel; **zero**
   prod importers — tests import siblings). Closer analog:
   `socialPlatformService.ts` L8 keeps the old specifier while types live
   under `./adapters/`. A-008 shim is thinner (no registry object).
   `agentModeService.generateImage`’s `await import('./imageGeneration')`
   (L28950) keeps compiling. **Do not edit `emmaApi.ts`** — the route
   never imported the leaf (cycle 25). Do not require importers to switch
   to `services/creative`.
3. Boundary test: `creative/**` must not import `agentModeService` or
   `db.ts`. **Already true for `imageGeneration.ts` today** (imports:
   `secretsManager`, `s3Utils`, `llmClients`, `usageRecorderService`,
   `llmPricing` only — no Dynamo). `videoGeneration.ts` also imports
   `mcp/client/mcpClientService` — leave that leak; do not “fix” it in
   the folder-move PR.
