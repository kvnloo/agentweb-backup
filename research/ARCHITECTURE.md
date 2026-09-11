# AgentWeb architecture — teach-in for Kevin

Status: **cycle 6 teach-in.** Evidence from cycles 000–005. This is the map
to read before we write product code.

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
email). `post_on_account` and `freeze_user_account` are still listed.

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

Failover is a **static list** and skips explicit model / edits / logo.
Human-eval stores **no `imageModel` field** (only `Model:` in
`outputSummary`). Onboarding like-rates score *prompts*, not providers.
**DesignArena (Q-003) is the live router; Matt's queue is taste, not a
picker.**

Video: Seedance (Higgsfield MCP) → Veo; Remotion `BrandedVideo` for brand
overlays. That is the only graph-like node today (Q-007 / Comfy later).

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

READY, no schema:

1. **Q-001** — Hermes login runbook / skill (`briefs/Q-001-hermes-oauth.md`)
2. **Q-014** — list `generate_image` on MCP (`briefs/Q-014-generate-image-mcp.md`)

Next KEEP: **Q-003** DesignArena → default image model; **Q-006** hide
deprecated full-file edit; **Q-015** hide admin tools from `tools/list`.

Parked: Comfy backend, Agent Mode strangler, ENG-381 until Harsha says it's
yours.

Customer-portal code is **not in this clone**. Anything you want to see in
the app UI needs the other repo.
