# AgentWeb research artifact

**Do not explode Emma into HTTP nanoservices.** AgentWeb already has four
deploy units. The pain is a 40k-line god object, not missing Kubernetes.
Hermes and Oh My Pi win on **in-process packages and one tool catalog**,
not on a tool-per-HTTP mesh.

Coding is unlocked. First product PRs are **in flight**:
[Q-014 + Q-004](https://github.com/kvnloo/agentweb/pull/2),
[A-002](https://github.com/kvnloo/agentweb/pull/3). Q-001 is Kevin
Hermes smoke (existing runbook). Q-003 waits on Matt before a default flip.

---

## Priorities (implementation order, not score)

### Product

| Order | ID | Do this | Do not |
|---|---|---|---|
| 1 | **Q-014** | Drop `internal: true` on MCP `generate_image` (`apiTools.ts` L2077). Test: `mcp.apiTools.test.ts` L91. Metering unchanged. **In flight: [kvnloo#2](https://github.com/kvnloo/agentweb/pull/2).** MCP `ListTools` is `getToolDefinitions()` with no skill gate (`mcpServerCore.ts` L76–83). | Dual-register like `evaluationTools`. Unify Emma vs MCP schema (`confirm`). Add to `DEFAULT_FOUNDATION_TOOLS`. Copy chatbot page-gating. Add to `ANONYMOUS_TOOLS` (A-015). |
| 1b | **Q-004** | Same PR or before: `internal` + `internalOnly` on MCP `post_on_account` only | Edit `emma/tools.ts` (#2832). Unlist `manage_*` (ENG-983). |
| 2 | **Q-001** | Kevin OAuth smoke on `HERMES_MCP_OAUTH.md` (315s PTY). Parent already refreshes OAuth (`server.ts` L586). | Rewrite the in-repo runbook unless smoke finds a lie. |
| 3 | **Q-003** | Fail-open DesignArena → `SUPPORTED_MODELS`. Live: `gpt-image-2` image **#3 / $0.04**, logo **#1**. Hardcoded default `gemini-3-pro-image-preview` is image **#22 / $0.134**, logo **#40**. | Flip prod default without Matt. Add Riverflow / `gpt-image-2.5` in the first slice. |
| hygiene | Q-006 / Q-015 | Hide `edit_landing_page_file` and admin MCP tools | — |

None of the first slices needs a Dynamo table.

### Architecture (after or beside Q-014, not instead)

| Order | ID | Do this | Do not |
|---|---|---|---|
| 1 | **A-002** | New `loopsCoreImportGuard.test.ts` on `loops/core` + `loops/index.ts`. **In flight: [kvnloo#3](https://github.com/kvnloo/agentweb/pull/3).** | Append to `sdkConstructionGuard.test.ts` (#2563). Walk `loops/instances/` (`rcaEnricher` imports `agentModeService`). |
| 2 | **A-007** | `mcp/server/tools/infrastructure.ts` copying `workflowTools.ts` | Copy `evaluationTools.ts`. First file is **not** `content.ts`. Edit `emma/tools.ts`. |
| 3 | **A-008** | `git mv` `imageGeneration.ts` → `services/creative/` + path shim | HTTP-split the leaf. |

**Discarded:** A-006 (HTTP nanoservice per tool). **Parked:** A-013 — do not start at Slack (`AgentWebPro#2393` owns `conversation/channelPort`).

---

## Findings (cycles 17–47)

### 1. Four deploy units already exist

Backend EB, partner-portal EB, agent-engine GCP VM, remotion-lambda.
A fifth process for images would split **policy** (`generateImage`:
category / HITL / persisted logo) from the **leaf** (`imageGeneration.ts`:
meter, C2PA default-on, CRITICAL LOGO) and miss blog / thumbs / video /
onboarding callers.

### 2. The EB box already forked — that is I/O vs compute, not a package

| Process | Role |
|---|---|
| Parent | HTTP, Socket.IO, in-memory cron, MCP **server**, OAuth refresh, Emma chatbot |
| Worker | `new AgentModeService()` then `generateMarketingResponse`. No Socket.IO (`socketEmit` IPC). |

Same 40k class on both sides. Hermes keeps sockets **and** the loop in one
process. Oh My Pi stays in-process packages (`pi-ai` ↛ `pi-agent-core`).

### 3. `generate_image` is one name, three faces, three catalogs

| Face | Process | How it runs | Who sees it |
|---|---|---|---|
| MCP (Q-014) | Parent | `mcpFetch` → `/api/emma/generate-image` → policy | Hidden by `internal: true` until Q-014. No page, no skill. |
| Emma chatbot | Parent | `executeTool` in-process (no fork) | Injected on the `images` page only |
| Agent Mode | Worker | emma registry → `generateImage` | Skill / `__other_skills__`. **Not** foundation (`describe_image` is). |

MCP schema is thinner (no `confirm`). Quota is per-face, not in
`generateImage`. Do not HTTP-split this method — both OS processes would
become clients of a fifth hop.

When `MCP_ANONYMOUS_DISCOVERY=true` (default **off**), anonymous
`tools/list` will include listed `generate_image`. `ANONYMOUS_TOOLS`
is empty — look but not run (`anonymousTransport.ts`). Do not add
`generate_image` to that set (A-015). If that allowlist leaked,
`mcpFetch` `lookupUser` still throws `User not found` **before** minting
a self-call JWT (`httpClient.ts` L57–66 / L169) — no leaf, no vendor.
ENG-822 does not rewrite that error (`generate_image` has no
`requiresUserAccount`). Copying `emmaApi` “because it is metered” is
not a spend door: `checkTokenUsage` **allows** `anon_*` under a $2
ChatSessions cap (`tokenUsageService.ts` L293–305) and `_svc` JWTs skip
`getUserById` (`auth.ts` L155–167). The leaf `meterUserUsage` is
fire-and-forget and drops `no_user` (cycle 51).

### 4. Hermes / Oh My Pi vs this tree

| Practice | Hermes / OMP | AgentWeb |
|---|---|---|
| Agent loop | One process, packages | 40,571-line `agentModeService.ts` |
| Tool catalog | One registry / `tools/list` | Four in-process registries + three availability policies |
| MCP | **Client** to other servers | **Server** for Hermes *and* client to vendors; self `"agentweb-tools"` skipped |
| Extract | MCP outbound; OMP packages | Fork for health checks; DAG inverted (`services/` import `controllers/`) |

Cutting-edge 2026 (Microsoft modular-monolith first): folders + AST
guards, then extract. `backend/package.json` has **no** `workspaces`
and **no** `dependency-cruiser`.

### 5. What not to compete with (AgentWebPro)

`emma/tools.ts`: **#2832 #1076 #689**. `sdkConstructionGuard.test.ts`: **#2563**.
`agentModeService.ts` pile: **#2871 #2861 #2832 #2563 #2060 #1584 #1076**.
Slack: **#2393**. Never #2862 / #2271 / #2861. `#1076` also touches
`chatbotService.ts`. `#2861` is promoting `convert_to_pdf` to foundation
— do not piggyback `generate_image`.

---

## Invariants

Billing meter / `llmPricing`. C2PA default-on in the **leaf**. Brand
`logoImage` / CRITICAL LOGO in the **leaf**. No Dynamo schema without
Harsha. No `localStorage.getItem("token")`. End-user UI only in
**customer-portal**.

## Read next

| If you want | Open |
|---|---|
| Teach-in | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Product queue + briefs | [`QUEUE.md`](QUEUE.md), [`briefs/`](briefs/) |
| Architecture thesis | [`sdlc/THESIS.md`](sdlc/THESIS.md) |
| Hop diagram | [`sdlc/COMPOSITION.md`](sdlc/COMPOSITION.md) |
| Hermes / OMP comparison | [`sdlc/COMPARISON.md`](sdlc/COMPARISON.md) |
| Cycle receipts | [`cycles/`](cycles/) |

Rollback: delete `research/`.
