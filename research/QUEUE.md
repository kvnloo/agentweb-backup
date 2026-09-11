# Feature queue

Source of truth: `queue.json`. Protocol score is research leverage.
**Implementation order** (first PRs): Q-001, Q-014, Q-003.
Land **Q-004 with or before Q-014**.

Artifact (findings + priorities at the top): [`README.md`](README.md).
Teach-in: `ARCHITECTURE.md`. Working agreement: `HOW_TO_HELP.md`.
`coding_unlocked: true`. `briefing_ready: true`.

## How Kevin can help (thesis)

Hermes operator + MCP creative discovery first. Then a fail-open
DesignArena → `SUPPORTED_MODELS` mapper (not mcp-bench-router's OpenRouter
chat map). Do not port HyperFrames, MoneyPrinterTurbo, or ComfyUI —
Remotion already owns intro/outro. Local logged-in browser is ENG-381.

## Ranked (by score)

| Rank | ID | Score | Status | Title |
|---|---|---|---|---|
| 1 | Q-003 | 38 | **ready** | DesignArena adapter — `briefs/Q-003-designarena-adapter.md` |
| 2 | Q-001 | 34 | **ready** | Emma-via-Hermes operator path — `briefs/Q-001-hermes-oauth.md` |
| 3 | Q-014 | 34 | **ready** | Expose generate_image on MCP tools/list — `briefs/Q-014-generate-image-mcp.md` |
| 4 | Q-004 | 32 | **ready** | post_on_account internalOnly — `briefs/Q-004-post-on-account-internalOnly.md` |
| 5 | Q-006 | 27 | **ready** | Hide edit_landing_page_file — `briefs/Q-006-hide-edit-landing-page.md` |
| 6 | Q-015 | 27 | **ready** | Hide admin MCP tools — `briefs/Q-015-hide-admin-mcp-tools.md` |

## Parked

| ID | Score | Why parked |
|---|---|---|
| Q-016 | 26 | MCP video after Q-014; $1.55/clip vs $0.04 image (ENG-973) |
| Q-011 | 26 | Hermes as ENG-381 local-agent successor; confirm ownership; not #2271 |
| Q-007 | 24 | Intro/outro already in BrandedVideo; do not port HyperFrames/MPT |
| Q-002 | 23 | Offline Model: parser only; live router is Q-003; no new eval attribute |
| Q-005 | 22 | Tool prompt already requires parallel variant calls |
| Q-008 | 22 | Eval workspace just shipped (ENG-1870) |
| Q-009 | 21 | ComfyUI backend — ops-heavy; Remotion is the existing graph node |
| Q-010 | 19 | callLLM strangler — Harsha gravity; target loop is Hermes-shaped |

## Discarded

| ID | Why |
|---|---|
| Q-012 | Kerdoios duplicates usage runway |
| Q-013 | God-object rewrite cannot merge |

## First coding (when unlocked)

1. **Q-001** — Kevin operator smoke on the existing `HERMES_MCP_OAUTH.md`
   recipe (not another in-repo doc PR).
2. **Q-014** — list `generate_image` on MCP (metering unchanged).
3. **Q-003** — fail-open DesignArena mapper; Matt before flipping the
   production default to `gpt-image-2`.
4. **Q-006 / Q-015 / Q-004** — MCP hygiene. Land **Q-004 with or before
   Q-014** so listing `generate_image` does not leave live social publish
   in the same `tools/list`.

None of these needs a database change.

## Architecture / SDLC (parallel; not product ranks)

Kevin asked to research breaking the repo into nanoservices and
comparing Hermes / Oh My Pi. **Do not HTTP-split Emma.** See
`sdlc/THESIS.md`. Track queue: `sdlc/QUEUE.md`. First SDLC coding
(after unlock, not instead of Q-014): A-002 then A-007 then A-008.
Cycle 46: parent is I/O, worker is compute; chatbot still `executeTool`
on the parent. Cycle 47: three catalogs for `generate_image`; A-014
parks copying page/skill gates onto MCP. Cycle 50: A-015 leak still
cannot spend (`httpClient.ts` `lookupUser`). Cycle 51: copying the
Emma meter is not that door (`anon_*` is allow-listed). Cycle 53: MCP
image execute cannot skip `lookupUser` via ENG-1596. Cycle 54: A-007
copies workflowTools **shape**, not admin identity. Cycle 55: remotion
isolate vs image host adapter. Cycle 56: MCP client/server already
acyclic; A-016 parked. Cycle 57: #2271 owns `app.ts`; A-007 does not
touch it. Cycle 58: ENG-1189 drain is the listen() proof. Cycle 59:
`crm.ts` L24 imports `server.ts` (ENG-1286); park A-017. Cycle 60:
A-017 copies Fathom get/register, not LoopPorts. Cycle 61:
AgentWebPro still empty on Q-014/A-002/A-017 first-slice files;
`crm.ts` is #1544+#1790; `app.ts` is #2271+#1814. Cycle 62: only
`server.ts` L186 joins `user:`; A-017 is a string-room passthrough
(do not unify socket.id / sessionId). Cycle 63: ten dynamic
`import('../server')` sites (GTM/admin/durableLanding + seven in
`agentModeController.ts`); A-017 first slice still the two `require`s.
Cycle 64: SSE (`sseProgress.ts`) is a different bus from Socket.IO;
`RunEmitter` typed sink is a no-op (`agentModeService.ts` L3449).
Cycle 65: `sseProgress` Maps are parent-local (`workerService` L322
clears them on child death); chatbot is per-socket `message`, not
SSE. Cycle 66: `keyedMutex.ts` L12–15 + `activeSessionGenerations`
Set — one session, one process. A fifth `listen()` would race that
claim. A-006 stays discarded.
Cycle 67: MCP ENG-114 (`mcpSessionRehydration.ts` L3–8) — no sticky
routing; share Dynamo metadata, rehydrate in-process. Not a fifth
`listen()`. A-006 stays discarded.
Cycle 68: ENG-764 ASG hook (`asgLifecycleGuard.ts`) is why drain
runs before the instance dies. A fifth `listen()` is not parked in
`Terminating:Wait`. A-006 stays discarded.
Cycle 69: `runDrain` (`server.ts` L397–420) does not wait on inbound
MCP `CallTool`. Q-014 `generate_image` is that hop. Copy
`chatbotTurn`; do not call `mcpShutdown` from drain. A-006 stays
discarded.
Cycle 70: local MCP Map vs `rehydrateAndServe` share `CallTool`.
Wrap that once (`cronJobRegistry.ts` L1–9). A-006 stays discarded.
Cycle 71: AgentWebPro empty on CallTool-wrap files. Do not start
that wrap instead of Q-014. A-006 stays discarded.
Cycle 72: local GET `/mcp` (`mcpServer.ts` L508–531) is timeout-0
SSE. Ordered drain: track CallTool, then `mcpShutdown`, then
`server.close()`. A-006 stays discarded.
Cycle 73: `server.close` / `io.close` are not awaited
(`server.ts` L440–455). The ASG hook completes on drain resolve
anyway. A-006 stays discarded.
Cycle 74: `workerShutdownGuards.ts` ignores SIGTERM (ENG-201);
parent SIGKILLs after drain. A fifth `listen()` gets default
SIGTERM. A-006 stays discarded.
Cycle 75: `RecordLifecycleActionHeartbeat` is never called;
`--heartbeat-timeout 900` is CONTINUE fallback (`eb-deploy.sh`
L612). `DRAIN_CEILING_MS` 10 min fits inside. A-006 stays discarded.
Cycle 76: nginx/ALB 600s on `/mcp`; Socket.IO 3600s. Node
`setTimeout(0)` does not beat the proxy. A-006 stays discarded.
Cycle 77: `generate_image` mcpFetch aborts at 5 min default
(`httpClient.ts` L205). v0 already raises `timeoutMs` in-process.
A-006 stays discarded.
Cycle 78: leaf `IMAGE_GENERATION_TIMEOUT_MS` is 8 min (ENG-510);
MCP mcpFetch is 5. Align `timeoutMs` after Q-014. A-006 stays
discarded.
Cycle 79: `emmaApi` generate-image has no abort listener; leaf
meters after success even if MCP already aborted. A-006 stays
discarded.
Cycle 80: MCP `POST /generate-image` is not under
`tryClaimSessionGeneration`. Do not copy that Set onto Q-014.
A-006 stays discarded.
Cycle 81: `requireEmmaTokenBudget` is check-then-act; increment
is after vendor success and does not condition on remaining
quota. Do not wire ENG-1250 admission. A-006 stays discarded.
Cycle 82: image spend does not increment `totalTokens`; default
hard gate is tokens. Do not flip `ENFORCE_COST_CAP`. A-006 stays
discarded.
Cycle 83: MCP CallTool is not serialized (SDK streamId per POST;
rate limiter is count/min). A-006 stays discarded.
Cycle 84: `checkExtraCostUsage` is tests-only; images do not
write `extraCostUsage`. A-006 stays discarded.
Cycle 85: default image is $0.134; Q-003 is $0.04. Cost caps are
Dynamo. A-006 stays discarded.
Cycle 86: `generate_video` is not on MCP; same meter as images
at 12–39×. Q-016 stays parked. A-006 stays discarded.
Cycle 87: AgentWebPro empty on Q-014 / meter / wrap files.
A-006 stays discarded.
Cycle 88: OMP 0.85.1 unpublished experimental client/server.
A-006 stays discarded.
Cycle 89: Hermes still MCP client; parallel opt-in default
false. A-006 stays discarded.
Cycle 90: file-config still skips `"agentweb-tools"`; DB
`mcp_servers` does not. Park A-018. A-006 stays discarded.
Cycle 91: live MCP face is `/mcp`; `/mcp/server` is stale
inspector + AGENT_API L129. Q-001 runbook already matches.
Cycle 92: inspector is `--transport sse` against that dead
path; GET `/mcp` without session is 400. A-006 stays discarded.
Cycle 93: `mcpShutdown` runs on SIGTERM **before** `runDrain`
(`mcpServer.ts` L269–270 vs `server.ts` L474–475). A-006 stays
discarded.
Cycle 94: `mcpShutdown` does not evict ENG-114; only `DELETE /mcp`
does. A-006 stays discarded.
Cycle 95: `MCP_SESSION_STORE` unset in this tree; default memory.
A-006 stays discarded.
Cycle 96: Immutable deploy already overlaps two instances;
`socialPosts.ts` MinSize=1 is not in `.ebextensions`. A-006 stays
discarded.
Cycle 97: drain 503s scheduled chats only; `/health` and `/mcp`
stay open until unawaited `server.close`. A-006 stays discarded.
Cycle 98: `cronJobRegistry.drain()` is live; `track()` has no gate.
Wrap CallTool after #2 must copy worker `draining`. A-006 stays
discarded.
Cycle 99: `chatbotTurn` already extends that live drain (`server.ts`
L301, no `isCronEnabled`). A-006 stays discarded.
Cycle 100: Slack/email ack HTTP then `track()`. Park A-019 (one
`track()` gate). Do not edit `slack.ts` (#2393). A-006 stays
discarded.
Cycle 101: `/generate` uses `tryClaim` into the session Set, not
`track()`. A-019 first slice now covers both waiters. A-006 stays
discarded.
Q-001 / Q-014 / Q-003 stay ready.
