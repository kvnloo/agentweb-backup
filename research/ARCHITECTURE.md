# AgentWeb architecture — teach-in for Kevin

Status: **cycle 6 teach-in**, refined in cycle 8 (DesignArena mapping).
Evidence from cycles 000–008. This is the map to read before we write
product code.

## 1. What you forked

AgentWeb is a **billed, multi-tenant AI marketing operator**. The product
persona is **Emma** (CMO, not a generic chatbot). Customers talk to her in
the **customer portal** (separate GitHub repo, not in this tree). This repo
is backend + **partner-portal** (admin) + **agent-engine** (Python worker).

You forked `AgentWebPro/agentweb` on 2026-09-11. The people already shipping
here are Harsha (CEO), Fangfang (CPO), Matt (CMO), and Argusoft contractors
(CRM, ads plumbing, billing). Your comparative advantage is **Hermes, MCP,
arena-style model routing, and generative graphs** — not another CRM ticket.

## 2. Picture

```
customer-portal (other repo)  ─┐
partner-portal (admin, here)  ─┼─► Express API  :3001
                                │     JWT / delegate tokens
                                │     DynamoDB + S3
                                │
                                ├─ Agent Mode worker  (Emma chat, 60+ tools)
                                │     callLLM → OpenRouter (text/tool/vision)
                                │     SSE progress (not Socket.IO for the turn)
                                │
                                ├─ MCP  /mcp + /oauth
                                │     Hermes / Claude / Cursor as *clients*
                                │
                                ├─ Playwright MCP  @playwright/mcp@0.0.70
                                │     --headless --isolated  (per session)
                                │
                                └─ agent-engine  (GCP VM, Python)
                                     browser-use + Playwright
                                     polls AW-TaskExecutions, max 3 concurrent
```

## 3. The three runtimes you will actually touch

**Agent Mode** is the product. HTTP `POST /api/agent-mode/.../generate` →
`agentModeController` (session lock, timeouts, scheduled-chat policy) →
`generateMarketingResponseWorkerService` (fork) →
`agentModeService.generateMarketingResponse` (LLM ↔ tools). Progress is
**SSE** via `RunEmitter`. Socket.IO is the Emma *sidebar* and some fanout —
the README picture is stale.

Gravity wells (do not "split the file" as a first PR):

| File | ~Lines | Role |
|---|---|---|
| `backend/src/services/agentModeService.ts` | 40.5k | Loop, model registry, image/video tools, billing hooks |
| `backend/src/controllers/agentModeController.ts` | 15k | Locks, scheduled chats, auto-continuation |
| `backend/src/emma/tools.ts` | 9.8k | In-process Emma tool schemas |
| `backend/src/mcp/server/apiTools.ts` | 3.6k | What Hermes sees (REST wrappers) |

A strangler already lives under `backend/src/services/agentMode/`
(dispatch, finalize, work-plan, streams). The target loop in
`AGENTMODE_MIGRATION.md` is explicitly "Claude-Code / Hermes / OpenClaw
shaped". That is **Q-010**, Harsha's lane, not your first PR.

**agent-engine** is the *other* product: classic "do this website task in
natural language." It is not Emma. OpenRouter is already wired
(`openrouter_gateway.py`). Cookie files sync to S3. Leave it unless ENG-381
becomes yours.

**Coding agent** (`codingAgentService.ts`) is a *sub-agent* Emma delegates
to for landing-page diffs. The 2026-03 "Emma can't edit files" write-up is
**stale for landing pages**. MCP still lists the deprecated
`edit_landing_page_file` and *tells clients to use `coding_agent`*, which is
**not registered on MCP**. That is Q-006.

## 4. Two tool registries (this is the Hermes trap)

| Registry | Loaded by | `generate_image` |
|---|---|---|
| `emmaToolRegistry` (`emma/tools.ts`) | Agent Mode / in-app Emma | Full schema, parallel-variants instruction, required `category` |
| `mcpToolRegistry` (`apiTools` + `workflowTools` + `evaluationTools`) | Hermes / OAuth / API keys | Hidden (`internal: true`). Video tools absent. |

`tools/list` drops `internal`. `internalOnly` also **refuses** execute for
`externalMcp` (ENG-974). Only four tools are `internalOnly` (blog, skills,
email). `post_on_account` and always-admin tools (`freeze_user_account`,
`list_all_clients`, `manage_user_notes`, …) are still listed. ListTools
has **no** `isAdmin` (cycle 9). `edit_landing_page_file` is listed and
points at missing `coding_agent` (Q-006).

ENG-982 added job-shaped `emma_*` tools (`emma_run_marketing_task`, …).
**ENG-983 will unlist the CRUD catalogue.** Do not do ENG-983 for them.

OAuth for MCP is done (ENG-1869). Remaining work is the **operator path**
(PTY + paste callback URL). See `briefs/Q-001-hermes-oauth.md`.

## 5. Skills vs work plans

From the product README, still true:

- **Skill** = how to use tools ("when posting to LinkedIn, stay under 1300
  chars"). Lives in `systemPrompt` + tool bundle. `install_skills` is how
  Emma loads them. Foundation tools are DB-overridable
  (`foundation_tools` in AW-Settings).
- **Work plan** = a sequenced outcome with gates (`requiredFunctionCalls`).
  Onboarding, GTM, "build the ads" are work plans.

If you can say it as "when using X, always Y" → skill. If you can say it as
"to achieve X, do A → B → C" → work plan.

## 6. Creative stack (your Comfy / arena overlap)

```
generate_image → imageGeneration.ts
  Azure GPT-image | Gemini | Runway gen4
  → C2PA strip → S3 → chat
  → enqueueAutoHumanEval (Matt, Slack)
```

Failover is a **static list** (`gpt-image-2` already first) and skips
explicit model / edits / logo. Human-eval stores **no `imageModel` field**
(only `Model:` in `outputSummary`). Onboarding like-rates score *prompts*,
not providers.

**DesignArena (Q-003) is the live router; Matt's queue is taste, not a
picker.** Cycle 8 proved `mcp-bench-router` cannot pick Emma providers
(OpenRouter chat map). The `image` leaderboard *does* share IDs:
`gpt-image-2` is #3 and $0.04; the hardcoded default
`gemini-3-pro-image-preview` is #22 and $0.134. Map with fail-open; do not
flip the production default until Matt says so. See
`mappings/designarena-image-models.md`. Cycle 12: `outputSummary` has
`Model: <id>` but feedback is untyped Slack — Q-002 is an offline parser
only (`mappings/eval-output-summary.md`), never a per-request scan.

Video: Seedance (Higgsfield) → Veo; Remotion `BrandedVideo` for brand
overlays. Cycle 10: that composition **already** has the lower-third intro
and CTA end card (`Root.tsx` has one id). HyperFrames (HTML→MP4) and
MoneyPrinterTurbo are not drop-in providers. Extra compositions: Q-007
parked. Video on MCP: Q-016, after Q-014. Comfy: Q-009.

**Do not touch:** `meterUserUsage`, C2PA default-on, `logoImage` preservation.

## 7. Three browsers

1. **Playwright MCP** in Agent Mode — headless, isolated, cookies in
   `AW-BrowserCookies`. Fine for landing-page QA. Cannot hold WhatsApp Web.
2. **agent-engine / browser-use** — cloud VM, S3 cookie jar, 3-wide. Same
   detection problem for locked-down social.
3. **local-agent-relay** — Codex + ngrok, **retired ENG-383**. Successor is
   **ENG-381**. That is Hermes-on-a-real-browser (Q-011, parked). Do not
   fight WhatsApp Cloud API PR #2271.

## 8. Money

Text models have Artificial Analysis quality scores, cost tiers, and
same-family dominance hiding. Usage runway already recommends cheaper models.
OpenRouter BYOK can report $0 — AgentWeb must still meter from the price
book (the only Kerdoios lesson worth stealing). **Do not port Kerdoios.**

Image/video are **not** on OpenRouter. They have their own price functions
and a single meter point on success.

## 9. Trust and merge gates

- `req.user` after delegation is the **customer**, not the admin.
- Never `localStorage.getItem("token")` in frontend; `useAuth()`.
- End-user UI goes in **customer-portal**, not partner-portal.
- **No Dynamo schema** without Harsha.
- Merge proof is `merge-evidence.sh`, not `gh pr checks` alone.
- Don't compete with open PRs #2862 (OpenRouter 429), #2271 (WhatsApp),
  #2861 (pdf tool).

## 10. How you help (queue)

READY, no schema. **Code in this order**, not by raw score:

1. **Q-001** — Hermes login runbook / skill (`briefs/Q-001-hermes-oauth.md`)
2. **Q-014** — list `generate_image` on MCP (`briefs/Q-014-generate-image-mcp.md`)
3. **Q-003** — DesignArena → `SUPPORTED_MODELS` (`briefs/Q-003-designarena-adapter.md`)
   Score is highest (38) because the arena evidence is now live, but a
   default flip has customer blast radius. Matt before production.

Hygiene READY (after the first three): **Q-004** hide MCP
`post_on_account` (land with Q-014); **Q-006** hide deprecated full-file
edit; **Q-015** hide always-admin tools.

Parked: Comfy backend (Q-009), extra Remotion compositions (Q-007 —
intro/outro already ship), MCP video (Q-016, after Q-014), Agent Mode
strangler, ENG-381 until Harsha says it's yours.

Customer-portal code is **not in this clone**. Anything you want to see in
the app UI needs the other repo.

## 11. Nanoservices vs modular monolith (cycle 17)

You asked whether to break this repo into nanoservices. **Deploy-layer
split already exists** (backend EB, partner-portal EB, agent-engine VM,
remotion-lambda). The 40.5k-line loop is an *in-process* problem.

Cutting-edge agentic SDLC (Hermes, Oh My Pi, Microsoft modular-monolith
guidance) is: **packages + ports in one process**, MCP as the *external*
bus, extract a fifth process only for scale or isolation. A HTTP
nanoservice per Emma tool would split billing/C2PA/logo and fight MCP.

In-tree gold standard: `backend/src/loops/core` (ports; no `services/`
imports; may import `loops/index` registry). Incomplete strangler:
`agentMode/core` (`executeAgentStep` still throws). MCP already started
the Hermes split (`workflowTools.ts`); `apiTools.ts` is 85 tools in one
file. Cycle 24: do not put Q-014 in a `content.ts` extract — Content
already imports `agentModeService`. Cycle 25: that MCP tool already
loopbacks `http://localhost` into `generateImage` (`COMPOSITION.md`).
Cycle 26: in-app path is `toolDispatch` → `executeTool` (no HTTP);
`codingAgentService.ts` is not a subprocess.
Cycle 27: agent-engine still JWT-calls `/api/internal/usage`; A-002
oracle is 18 `loops/core` files / two `../index` escapes.
Cycle 28: `awsAdapters.ts` is the host; do not copy Hermes
`discover_builtin_tools` into A-007.
Cycle 29: `mcp_config` `"agentweb-tools"` self-MCP is skipped as circular
(`mcpClientService.ts` L420–432).
Cycle 30: leaf callers skip `generateImage`; OMP is `@earendil-works/pi-ai`
0.85.1 (arrow unchanged).
Cycle 31: **#2563** appends remnant `not.toContain` checks to
`sdkConstructionGuard.test.ts`; A-002 copies walker L41–68 into a
sibling file, does not append. `apiTools.ts` / `imageGeneration.ts` /
`loops/core` still have no open PR.
Cycle 32: A-007 copies `workflowTools.ts` (mcpFetch); do not copy
`evaluationTools.ts` (in-process services + emma dual-register).
Cycle 33: A-008 is a **path shim** at `services/imageGeneration.ts`, not
`swarm/index.ts` (zero prod importers). `LoopPorts` (6 interfaces) is
the in-process composition bus.
Cycle 34: A-002 oracle is **20** `loops/core` files (35 specifiers, two
`../index` escapes). Q-014 drops `internal` at L2077 and edits
`mcp.apiTools.test.ts` L91 — not an `emma_generate_image` wrapper.
Cycle 35: `loops/index.ts` is Hermes `registry.py` (only `./core/types`).
`app.ts` L118–120 is the composition root. MCP `registry.ts` already
imports `evaluationPolicy`.
Cycle 36: C2PA default-on (`imageGeneration.ts` L575–578) and CRITICAL
LOGO (L477–484) are **leaf** invariants; policy owns category / HITL /
persisted logo. A-006 stays discarded.
Cycle 37: four in-process registries (`emma/registry.ts` is 3 lines).
Q-014 is `mcpServerCore.ts` L81–83 `getToolDefinitions()`, not an Emma
dual-register. A-005 pile still 7 PRs (40,571 vs scorecard 23,895).
Map: `research/sdlc/A-007-split-map.md`.
Folder map: `research/sdlc/MODULE_MAP.md`. Services DAG:
`research/sdlc/SERVICES_DAG.md`. Full thesis: `research/sdlc/THESIS.md`.
