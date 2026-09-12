# Context: Kevin's work × AgentWeb

Kevin Rajan (`kvnloo`, Linear workspace **zer0** / `0ism`) forked
`AgentWebPro/agentweb` on 2026-09-11 and is a member of the org. This is not
an OSS-factory spray target. AgentWeb is a commercial multi-tenant marketing
agent (Emma) with strict merge gates.

## Who is already shipping AgentWeb

Contractor/core lane (open PRs): CRM, HubSpot, Meta/Google ads plumbing,
billing/renewal health, work plans, partner-portal tokens. **Do not compete
there.** Unique help is at the intersection of *creative generation, model
routing/eval, and external-agent (Hermes/MCP) operation*.

## Adjacent systems (live this week)

| Repo / project | What it is | AgentWeb overlap |
|---|---|---|
| `kvnloo/kerdoios` | Hermes plugin: allot scarce compute, don't treat LiteLLM $0 as free | AgentWeb **already has** usage runway, cost tiers, quality scores, dominance hiding. Porting Kerdoios would duplicate. Learn from its "never treat zero-price as free" rule when reading OpenRouter BYOK (gateway reports $0). |
| `kvnloo/mcp-bench-router` | MCP that routes **code/design** (HTML/UI) to DesignArena's #1 via OpenRouter | `STATIC_MAP` is chat-model IDs. Emma images are Azure/Gemini/Runway, **not** OpenRouter. Reuse the *leaderboard fetch* (`category=image\|logo`), not `query_design_model`. Cycle 8 snapshot: already-supported `gpt-image-2` is arena #3 / $0.04; hardcoded default `gemini-3-pro-image-preview` is #22 / $0.134. |
| `kvnloo/ComfyUI` | Fork of Comfy-Org/ComfyUI, tracking upstream | AgentWeb image gen is one-shot prompt→provider. No graph, ControlNet, LoRA, or reusable workflows. Optional backend, not a rewrite. |
| `kvnloo/hermes-agent` (+ `hermes-keel`, `hermes-talk`, Linear Hermes HITL) | Deep Hermes contributor | AgentWeb just shipped **Hermes native OAuth** for Emma MCP (`backend/docs/HERMES_MCP_OAUTH.md`). Operator UX is still PTY+paste. Kevin can make Emma-via-Hermes actually usable. |
| `kvnloo/frontier-kb` | Cross-harness research (OMP/Hermes/Codex/Claude/Cursor/Pi) | Agent-mode loops already emit reliability events. Read-only harness export, not a runtime swap. |
| `kvnloo/oss-factory` + `verified-oss-loop` | HITL contribution factory, KEEP/DISCARD receipts | Use the *protocol* here (this research loop). Do not run factory spray against AgentWeb. |
| `kvnloo/hyperframes`, `open-design`, `MoneyPrinterTurbo`, `openavatar` | HyperFrames: HTML→MP4. MPT: LLM short-video. open-design: local design + HyperFrames. | Remotion `BrandedVideo` already has intro lower-third + CTA end card on Veo/Seedance clips. **Do not port.** Extra compositions are product intent (Q-007 parked). Video MCP is Q-016, after Q-014. |
| `kvnloo/headroom` | Compress tool output before the LLM | Agent Mode already has message-size guards and S3 offload seams; worth a later cycle, not first. |
| `kvnloo/harbor`, `factorio-learning-environment` | Agent eval environments | Evaluation workspaces (ENG-1870) are a **connector-free Meta simulator**, not an LM arena. Different product; possible creative-eval harness later. |

## "LM Arena fork"

No repo named `lmarena` under `kvnloo`. The live arena-shaped work is:

1. **DesignArena** via `mcp-bench-router` — crowdsourced leaderboard, refresh
   ~2h. The published MCP routes *website/UI code* through OpenRouter. The
   **image / logo / graphicdesign** categories overlap AgentWeb
   `SUPPORTED_MODELS` by exact `modelId` (see
   `research/mappings/designarena-image-models.md`). That intersection is Q-003.
2. AgentWeb's own **hand-snapshotted Artificial Analysis** quality scores on the
   *text* model picker (`agentModeService` `qualityScore` / ENG-1786).
3. **Human eval** for images: Slack queue to Matt (`humanEvalService`), plus
   onboarding swipe ratings. Preference is captured; **it does not route
   models** (no `imageModel` attribute; `listCandidates` is a scan).

Gap: arena *signals* exist for images; Emma still hardcodes the default.

## AgentWeb in one paragraph

Emma (Agent Mode) is a billed marketing operator: chat + 60+ tools for ads,
CRM, social, landing pages, images, video, books. Backend (Express) owns
policy, metering, and tools. `agent-engine/` is a separate Python Playwright
worker for classic web tasks. Partner portal is admin. Customer portal is a
**different GitHub repo**. Persistence is DynamoDB. Production deploy is
path-filtered Elastic Beanstalk on merge to `main`.

## Best help thesis (bootstrap)

Kevin should not be a generic AgentWeb engineer. The first useful role is:

1. **Operator of Emma-from-Hermes** (OAuth path that already exists, UX that does not).
2. **Creative routing scientist** — wire DesignArena + Matt's image eval into model choice without a new database.
3. **Do not port Comfy/HyperFrames/MPT.** Remotion is already the graph node
   (intro + outro). Comfy stays an optional image backend (Q-009). Hermes
   video listing waits on Q-014 (Q-016).

CRM, Stripe, Meta payload plumbing, and `agentModeService.ts` rewrites are
someone else's lane.

## Linear past-ideas (cycle 228)

Kevin's Linear workspace **zer0 / `0ism`** is the human-viewable dump of
ideas from other projects. Do **not** file AgentWeb issues there
(PER-80: no zer0-company 26k dump).

| Linear | What it is | AgentWeb |
|---|---|---|
| [PER-1522](https://linear.app/0ism/issue/PER-1522) + [Host-0 product lineage map](https://linear.app/0ism/document/host-0-product-lineage-map-a88b2a7a1758) | 2026-09-12 audit of `/products` vs Linear. Lesson: **narrow twins ship; operating systems of everything do not.** | AgentWeb is already a narrow twin (Emma + MCP for Hermes). Do not become zerOS. |
| PER-299 / PER-80 | Linear = company mind; Hermes Kanban = execution | AgentWeb is not a fourth control plane. |
| PER-1257 / PER-1355 | OMP/Hermes MCP Tasks | Factory leaves. Not an AgentWeb first slice. |
| PER-1074 / PER-868 | Codex `additionalProperties:false`; GitNexus initialize `instructions` | Parked Q-017. File-level: `apiTools.ts` L2081–2094 omits the flag; `mcpServerCore.ts` L58–65 has no `instructions`. |
| PER-620 | crush RFC 9207 `iss` | Crush-side. Do not rewrite `HERMES_MCP_OAUTH.md`. |
| PER-1506 / MEMORY Ad Arena / Pipeline Studio | Flux Comfy stills; creative DAG; ad ranking | Q-009 / Q-007 / Q-003 already cover the AgentWeb twins. Do not port the products. |

Homebase, OpenAvatar, Spatial Canvas, Pythia, Paperclip, Dash, ACE,
PitchTwin, Hardware Studio stay zer0 products.
