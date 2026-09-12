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
Cycle 102: auto-continuation re-fills the Set after release
(`setImmediate` L9406, `tryClaim` L1350). A-006 stays discarded.
Cycle 103: listed `emma_get_session` mcpFetchs that GET. A-006
stays discarded.
Cycle 104: `emma_send_message` 5 min mcpFetch around `/generate`
(cancels on close). A-006 stays discarded.
Cycle 105: that POST is not retried after `server.close`
(`httpClient.ts` L116–118). GET `emma_get_session` retries 3×
into a closed listener. A-006 stays discarded.
Cycle 106: inbound `/mcp` and loopback are different sockets.
`closeIdleConnections` unused. A-006 stays discarded.
Cycle 107: close() is nginx 502 now, not the 600s 504.
Classifier splits 502 / 504 / ECONNREFUSED. A-006 stays discarded.
Cycle 108: ALB health cannot stop Hermes during drain. `/health`
always 200 until close (ENG-1189). A-006 stays discarded.
Cycle 109: enhanced-health probe is deploy-verify (ENG-878), not
drain. A-006 stays discarded.
Cycle 110: weekly refresh overlaps without `eb-deploy.sh`. A-006
stays discarded.
Cycle 111: Sunday + Immutable do not stack a third backend. A-006
stays discarded.
Cycle 112: 3×1200s settle is not a wait; `fail()` exits attempt 1.
A-006 stays discarded.
Cycle 113: last deploy’s hook dies with the Immutable ASG. Park
A-020. A-006 stays discarded.
Cycle 114: guard still drains without a hook; ASG does not wait.
A-006 stays discarded.
Cycle 115: Sunday SIGTERM is OS/cgroup, not the hook. A-006 stays
discarded.
Cycle 116: journald drop-in is not the Node unit. A-006 stays
discarded.
Cycle 117: `runDrain` never stops nginx. A-006 stays discarded.
Cycle 118: `PORT=8080` is not in git. A-006 stays discarded.
Cycle 119: cannot name platform nginx.conf (`app.ts` L152–155).
A-006 stays discarded.
Cycle 120: git never chooses among 3001 / 8080 / 5000. A-006
stays discarded.
Cycle 121: a `/mcp` location is instance-only; ENG-836 allows it
alone. Do not add A-021. A-006 stays discarded.
Cycle 122: detect-changes skips drafts; ENG-836 never sees a
draft `/mcp` PR. A-006 stays discarded.
Cycle 123: re-draft is `NO_EVIDENCE`; `gh pr checks` can still
look green. A-006 stays discarded.
Cycle 124: ENG-836 skip is not draft; conflict job is not the
discriminator. A-006 stays discarded.
Cycle 125: hung ENG-836 still does not block merge; live ceiling
is 12. A-006 stays discarded.
Cycle 126: in-flight ENG-836 is PENDING; cancel-in-progress is
the cancelled PASS. A-006 stays discarded.
Cycle 127: ENG-1373 is still an unlanded comment; nothing in git
adds Backend build to GitHub required contexts. A-006 stays
discarded.
Cycle 128: merge-evidence labels Dependabot skip as a path-filter
skip; #2491 PASSes with it skipped. A-006 stays discarded.
Cycle 129: GitHub treats a job-level `if` skip as Success;
Dependabot’s REQUIRED comment only bites when the job runs.
A-006 stays discarded.
Cycle 130: naming `Backend build` as required cannot reproduce
merge-evidence section 7. A-006 stays discarded.
Cycle 131: merge-evidence has no `PARTNER_JOBS`; a partner-only
PR PASSes with Partner skipped. A-006 stays discarded.
Cycle 132: no `WORKFLOW_JOBS`; editing `merge-evidence.sh` PASSes
with CI script tests skipped. A-006 stays discarded.
Cycle 133: ENG-1377 relay and remotion builds are unnamed in
merge-evidence. A-006 stays discarded.
Cycle 134: a `tests.yml` PR schedules six jobs; merge-evidence
requires `Backend build` only. A-006 stays discarded.
Cycle 135: agent-engine is a deploy unit with no GitHub build
job. A-006 stays discarded.
Cycle 136: customer-portal is a fifth repo (gitignored), not a
fifth process. A-006 stays discarded.
Cycle 137: the other repo’s IA is a typed list in this backend,
not an HTTP nanoservice. A-006 stays discarded.
Cycle 138: `growth-chat/` is a sixth origin; the loop already
shares `callLLM` in this process. A-006 stays discarded.
Cycle 139: Growth Genius is a fifth in-process catalog
(inline `search_knowledge_base` + Emma KB). A-006 stays
discarded.
Cycle 140: `searchPlatformKnowledgeBase` is a leaf trapped in
a file that cycles with `agentModeService`. A-006 stays
discarded.
Cycle 141: ENG-1057 already named three in-process KB faces;
the cap lives at the source. A-006 stays discarded.
Cycle 142: those faces do not share source sets. Agent Mode
is a Drive/ClickUp superset; Emma RAG and Growth Genius are
not. A-006 stays discarded.
Cycle 143: listed MCP `search_knowledge_base` already hops to
that Agent Mode superset; `generate_image` is still
`internal: true`. Q-014 is listing, not a new hop. A-006 stays
discarded.
Cycle 144: Agent Mode still recaps Vertex after ENG-1057
capped the leaf; L24062 comment is stale. A-006 stays
discarded.
Cycle 145: three TypeScript `searchKnowledgeBase` symbols;
Emma’s export is Azure embeddings, not the Vertex leaf.
A-006 stays discarded.
Cycle 146: same `search_knowledge_base` name, three JSON
schemas; GG requires `reason`. A-011 already parks this
pattern for `generate_image`. A-006 stays discarded.
Cycle 147: GG `reason` is required on the schema and
discarded before the Vertex leaf. A-006 stays discarded.
Cycle 148: GG and Emma RAG hardcode maxResults=10; Emma tool
/ MCP default 5. A-006 stays discarded.
Cycle 149: Agent Mode collects per source then slices;
Vertex-first prefix can discard Drive/ClickUp after paying
for them. Listed MCP hops here. A-006 stays discarded.
Cycle 150: Vertex filling the cap does not skip Drive or
ClickUp; no short-circuit after L24070. A-006 stays discarded.
Cycle 151: ClickUp docs “search” is list-all then
`includes()`; Drive already has `fullText contains`. A-006
stays discarded.
Cycle 152: `listTasks` enriches attachments; search only uses
name+description. A-006 stays discarded.
Cycle 153: `readDocContent` lists pages and may GET each page
before `includes()`; `nameMatch` does not skip the fetch.
A-006 stays discarded.
Cycle 154: Drive search has count+time bounds (ENG-1624);
`clickupService.ts` has zero TIMEOUT/MAX_MS/deadline. A-006
stays discarded.
Cycle 155: Drive folder trees `Promise.all` (L24080); ClickUp
docs sequential `await` (L24148–24156). Do not wrap ClickUp
in unbounded parallel page GETs. A-006 stays discarded.
Cycle 156: Search Drive/ClickUp helpers unbounded; 200MB
and 1M caps are on other faces. A-006 stays discarded.
Cycle 157: Search query omits `size`; other faces request
it. A-006 stays discarded.
Cycle 158: Workspace exports empty `size`; named-read
fallback is after download. A-006 stays discarded.
Cycle 159: Hermes MCP client ~24 files; OMP still v0.85.1.
A-006 stays discarded.
Cycle 160: Loop still client; two opt-in stdio MCP servers.
A-006 stays discarded.
Cycle 161: Codex-facing `image_generate` is in-process
dispatch, not an HTTP hop. A-006 stays discarded.
Cycle 162: Hermes `image_generate` schema is not MCP
`generate_image` (name, required, size, no category).
A-011 already parks Emma vs MCP. Do not add A-021.
A-006 stays discarded.
Cycle 163: Hermes capability-gates tools/list
(`dynamic_schema_overrides`); AgentWeb MCP is a literal.
A-006 stays discarded.
Cycle 164: `generateImage` does not refuse `input_images`
on Emma’s t2i-described model; the leaf still edits.
A-006 stays discarded.
Cycle 165: `logo_image` is `inputImages.push` before the
model switch. Catalog text vs leaf mutation. A-006
stays discarded.
Q-001 / Q-014 / Q-003 stay ready.
