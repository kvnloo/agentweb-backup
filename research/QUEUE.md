# Feature queue

Source of truth: `queue.json`. Protocol score is research leverage.
**Implementation order** (first PRs): Q-014, Q-004, Q-001, Q-003.
Land **Q-004 with Q-014** (kvnloo#2). Cycle 209: Kevin asked to
reprioritize; score ≠ shipping order. Cycle 228: Linear PER-1522 +
frontier-kb + ten-agent arsenal scan; order unchanged; park Q-017.
Cycle 229: deep-read of that dump (issue bodies + Host-0 map) still
does not invert order and does not mint Q-018.

Artifact (findings + priorities at the top): [`README.md`](README.md).
Teach-in: `ARCHITECTURE.md`. Working agreement: `HOW_TO_HELP.md`.
`coding_unlocked: true`. `briefing_ready: true`.
`product_queue_frozen: false` (Kevin asked 2026-09-12).

## How Kevin can help (thesis)

Land kvnloo#2 (`generate_image` on MCP `tools/list` + hide
`post_on_account`). Then Kevin Hermes OAuth smoke so that list includes
the image tool. Then a fail-open DesignArena → `SUPPORTED_MODELS`
mapper (not a default flip; not mcp-bench-router's OpenRouter chat map).
Do not port HyperFrames, MoneyPrinterTurbo, or ComfyUI — Remotion already
owns intro/outro. Local logged-in browser is ENG-381. Cycle 228: do not
port Homebase / OpenAvatar / Pipeline Studio / SoL-Pi; park Q-017.
Cycle 229: PER-1522 remains DRAFT; do not YES-create Linear projects.

## Ranked (by score)

Score ≠ shipping order (cycle 209). Ship Q-014 / Q-004 first.

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
| Q-011 | 26 | Hermes as ENG-381 local-agent successor; confirm ownership; not #2271 |
| Q-016 | 25 | MCP video after Q-014; 40× cost + Path C/D (cycles 195–197) |
| Q-007 | 24 | Intro/outro already in BrandedVideo; do not port HyperFrames/MPT |
| Q-002 | 23 | Offline Model: parser only; live router is Q-003; no new eval attribute |
| Q-005 | 22 | Filename identity collapses N variants named `logo.png` (cycle 208) |
| Q-008 | 22 | Eval workspace just shipped (ENG-1870) |
| Q-009 | 21 | ComfyUI backend — ops-heavy; Remotion is the existing graph node |
| Q-010 | 19 | callLLM strangler — Harsha gravity; target loop is Hermes-shaped |
| Q-017 | 28 | MCP initialize instructions + `additionalProperties:false` after #2 and Q-001 smoke (cycle 228; PER-868 / PER-1074). Cycle 229: Linear dump did not mint a second handshake item. Not the listing PR. |

## Discarded

| ID | Why |
|---|---|
| Q-012 | Kerdoios duplicates usage runway |
| Q-013 | God-object rewrite cannot merge |

## First coding (when unlocked)

1. **Q-014** — list `generate_image` on MCP (metering unchanged).
   **In flight: kvnloo#2.**
2. **Q-004** — same PR: `internal`+`internalOnly` on MCP `post_on_account`.
3. **Q-001** — Kevin operator smoke on the existing `HERMES_MCP_OAUTH.md`
   recipe after #2, so `tools/list` includes `generate_image`.
4. **Q-003** — fail-open DesignArena mapper; Matt before flipping the
   production default to `gpt-image-2` (cycle 170 Azure `[0]`; cycle 180
   onboarding already pins Gemini 3).
5. **Q-006 / Q-015** — MCP hygiene after #2 merges (same `apiTools.ts`).
6. **Q-017** — parked. After #2 and Q-001 smoke: `additionalProperties: false`
   on advertised roots and optional initialize `instructions` (cycle 228).
   Not in kvnloo#2.

None of these needs a database change.

## Architecture / SDLC (parallel; not product ranks)

Kevin asked to research breaking the repo into nanoservices and
comparing Hermes / Oh My Pi. **Do not HTTP-split Emma.** See
`sdlc/THESIS.md`. Track queue: `sdlc/QUEUE.md`. First SDLC coding
(after unlock, not instead of Q-014): A-002 then A-019 then A-007 then A-008.
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
Cycle 166: Four image-model catalogs; `IMAGE_API_MODELS`
comment “must match SUPPORTED_MODELS” is false. A-006
stays discarded.
Cycle 167: HITL runs before leaf `Invalid imageModel`.
MCP free-string can waste a confirm. A-006 stays
discarded.
Cycle 168: Runway honors mutated `inputImages` as
`referenceImages`; admin omitting Runway is not a gate.
A-006 stays discarded.
Cycle 169: Azure `/images/edits` uses `inputImages[0]`
only; logo-at-end drops. A-006 stays discarded.
Cycle 170: L492 Gemini 3 default is because multi-input;
Q-003 default flip would land on that drop. Do not
un-ready Q-003. A-006 stays discarded.
Cycle 171: Azure edit axios.get skips processInputImage
(no 30s timeout, UA, SVG). A-006 stays discarded.
Cycle 172: Azure FormData always claims image/png;
Gemini/Runway pass sniffed MIME. A-006 stays discarded.
Cycle 173: S3 upload L582–587 always image/png. Gemini 3
vendor MIME on the data URL is discarded. C2PA
`sharp().png()` makes the default path honest.
A-006 stays discarded.
Cycle 174: Runway HTTPS skips C2PA and S3; meter still
fires. Emma strip + REST exist; MCP has no
`remove_c2pa`. A-006 stays discarded.
Cycle 175: `generateWithOpenAI` else L533–534 is
unreachable after `SUPPORTED_MODELS` includes().
A-006 stays discarded.
Cycle 176: meter `provider` ternary L554–558 is prefix
not dispatch; gpt-image labelled openai. Dollars use
model id. A-006 stays discarded.
Cycle 177: BLOG_SETUP.md is a stale fifth catalog.
Blog heroes omit imageModel → Gemini / Google/Image.
Agent-engine OpenAI env is a second deploy unit.
A-006 stays discarded.
Cycle 178: two deploy units, two image dispatch tables.
gpt-image-2 is Azure on the leaf, OpenAI-else on the
worker. Q-003 already parks image-models.ts L11.
A-006 stays discarded.
Cycle 179: ImageModelsSettings seed omits gpt-image-1.
Empty Dynamo auto-inits openai-image-1. A-006 stays
discarded.
Cycle 180: onboarding pins Gemini 3 explicitly; Q-003
unspecified path never runs. Do not un-ready Q-003.
A-006 stays discarded.
Cycle 181: onboarding 180s race does not abort the 8 min
leaf. Nested Promise.race, no AbortSignal. A-006 stays
discarded.
Cycle 182: late Gemini success S3-uploads a key nobody
stores. s3Utils has no DeleteObject. A-006 stays
discarded.
Cycle 183: uploaded-by is a hardcoded agent-mode
constant on both helpers; thumbnail writer tells the
truth. A-006 stays discarded.
Cycle 184: uploaded-by is write-only. HEAD callers
use ContentType. Helpers set no Tagging. A-006 stays
discarded.
Cycle 185: helpers omit CacheControl. README 60s is
CLI copy-object. Thumbnail L35 is immutable 1y. A-006
stays discarded.
Cycle 186: serveAsset hardcodes max-age=300. Email
rewrite hops here; thumbs use raw S3 URL. A-006 stays
discarded.
Cycle 187: rewrite matches one S3 host; /asset/
accepts three. Brand already extracted a bucket
matcher. A-006 stays discarded.
Cycle 188: three S3 URL writers. Helpers return
Location; brand/db/tasks construct regional
virtual-hosted; Remotion is path-style. A-006 stays
discarded.
Cycle 189: Family B is not one function. books
encodes; brand interpolates raw originalname.
extractS3KeyFromUrl does not decode. A-006 stays
discarded.
Cycle 190: CORS Origin is exact Family B host
(credentials: true). cors.test.ts never pins it.
A-006 stays discarded.
Cycle 191: HTML repair is a third S3 matcher.
Hardcoded prod bucket; same class already has
extractS3KeyFromUrl. Tests set test-bucket.
A-006 stays discarded.
Cycle 192: repair axios.gets S3. Same class
already SDK-streams and presigns. A-006 stays
discarded.
Cycle 193: Emma C2PA/background advertise S3;
tests pin Path C. REST only for C2PA. MCP empty.
A-006 stays discarded.
Cycle 194: leaf processInputImage is Path C.
Gemini has no data: skip. Do not un-ready Q-014.
A-006 stays discarded.
Cycle 195: video processInputImage is Path C
(no UA, no SVG). Seedance default never calls it.
Q-016 stays parked. A-006 stays discarded.
Cycle 196: generateKeyframes persist-then-Path-C
is Veo-only; Seedance ignores useKeyframes.
Q-016 stays parked. A-006 stays discarded.
Cycle 197: character referenceImageUrl is Path D
on Seedance default. Q-016 stays parked.
A-006 stays discarded.
Cycle 198: brand-guide matcher misses Family A
path-style. A-006 stays discarded.
Cycle 199: auto-pin is Family A and drops result.Key;
auto-logo-* blocks delete's URL fallback. A-006
stays discarded.
Cycle 200: ENG-792 probe is Path C of own-bucket
Family A. Ads fail closed on 4xx. A-006 stays discarded.
Cycle 201: pin GET has no UA; probe/discovery do.
A-006 stays discarded.
Cycle 202: pin skips ssrfGuard; cssExtractor
validateURL is company-URL-only. A-006 stays discarded.
Cycle 203: company-scrape validateURL misses
FORBIDDEN_HOSTNAMES / 169.254 / DNS-pin; page.goto
follows after the string check. A-006 stays discarded.
Cycle 204: page.goto spoofs Mac Chrome/120; axios
fallback is Extractor/1.0. A-006 stays discarded.
Cycle 205: read_brand_guidelines shows filename
not logoUrl. A-006 stays discarded.
Cycle 206: pin/probe omit Referer; Chrome scrape
still sends it on <img>/icon. Ads fail closed.
A-006 stays discarded.
Cycle 207: generate_image.filename is the output
name, not asset.filename. Leaf accepts 'url'.
A-006 stays discarded.
Cycle 208: work-plan continue de-dupes on
filename; tests pin a.png twice → one. A-006
stays discarded.
Cycle 209: Kevin asked to reprioritize.
Product order Q-014 → Q-004 → Q-001 → Q-003.
Architecture A-002 → A-019 → A-007 → A-008.
A-019 unparked. Q-016 product 3→2. A-008
product 2→3. Q-001 / Q-014 / Q-003 stay ready.
A-006 stays discarded.
Cycle 210: track() cannot refuse — callers
pass an already-started Promise. tryClaim
false is 409 SESSION_BUSY. A-019 refuse is
handler-entry. A-006 stays discarded.
Cycle 211: do not drain-gate ListTools or
initialize. A-019 admission is HTTP 503 on
POST `/mcp` `tools/call`. JSON-RPC `isError`
is the wrong face. A-006 stays discarded.
Cycle 212: do not 503 GET `/mcp`. SDK throws
on GET 503; 405 is the optional-SSE skip.
A-006 stays discarded.
Cycle 213: `mcpShutdown` after the wait
belongs in A-019 first_slice. Drop sibling
SIGTERM (`mcpServer.ts` L269–270). ASG
never fires it; Sunday SIGTERM aborts the
shared transport first. A-006 stays
discarded.
Cycle 214: GET closer is SDK
`streamController.close()` then Hono
`writable.end()`. Do not await
`server.close` for the hang. A-006 stays
discarded.
Cycle 215: rehydrate CallTool is the
`mcpServerCore` wrap, not `mcpShutdown`.
JSON `close()` hangs `handleRequest`.
Do not `sessions.set` that transport.
A-006 stays discarded.
Cycle 216: keep rehydrate `finally
close()`. `resolveJson` never
`stream.cleanup()`; leftover
`_streamMapping` until `close()`.
After `handleRequest` returns,
close is delete-only and cannot
hang. Skipping it after resolved
JSON does not leak Express. JSON
on a reused transport would
accumulate. A-006 stays discarded.
Cycle 217: `mcpShutdown` never
cancels `generate_image`. `_onclose`
does not abort; CallTool ignores
`extra`; mcpFetch abort is
timeout-only. A-019 wait is the
billed hop. A-006 stays discarded.
Cycle 218: `send()` after `close()`
is Protocol `_onerror`, not
`mcpServerCore` `isError`. Handler
already billed. Wrap handler return,
not only `execute`. Drain polls size
every 2s and does not await `send()`.
A-006 stays discarded.
Cycle 219: closed POST SSE is not
404 reinit. Vendored POST
`_handleSseStream(..., false)`; no
`eventStore` so no priming. Q-001
fixture is httpx `next(data:)`.
A-006 stays discarded.
Cycle 220: 60s is client
`Protocol.request()`, not inbound
CallTool. `mcpClientService` 3600000
is AgentWeb as client. Hermes 315s
is OAuth add. A-006 stays discarded.
Cycle 221: `notifications/cancelled`
is a new POST, not the CallTool SSE.
Client HTTP `send()` ignores
`relatedRequestId`. After
`mcpShutdown` it cannot abort the
original CallTool. Do not 503 it.
A-006 stays discarded.
Cycle 222: skip-send does not
`stream.cleanup()`. Local POST SSE
stays mapped until `mcpShutdown`
`close()`. A-006 stays discarded.
Cycle 223: skip-send POST is the
same `CompleteLifecycleAction` cut
as GET. Do not await `server.close`.
A-006 stays discarded.
Cycle 224: Sunday `process.exit(0)`
after drain can cut Hono `end()` I/O.
ASG does not exit. Do not put
`process.exit` on the ASG path. Do
not replace Sunday exit with
`exitCode` in A-019. A-006 stays
discarded.
Cycle 225: SIGTERM on a settled
`drainPromise` can `process.exit(0)`
before `completeAction`.
HeartbeatTimeout 900s CONTINUE is
the fail-safe. Do not await the hook
from A-019. A-006 stays discarded.
Cycle 226: L18–19 is a comment, not
a pin that EB withholds SIGTERM for
`Terminating:Wait`. Three SIGTERM
sources (`dev.md` L1853); only ASG
replacement is the hook. Do not add
`TimeoutStopSec` from A-019. A-006
stays discarded.
Cycle 227: `IgnoreHealthCheck: false`
is a deploy command, not a Wait
SIGTERM. After A-019 close, `/health`
502 is a side effect. Do not 503
`/health` during the wait. A-006
stays discarded.
Cycle 228: arsenal + Linear
PER-1522 + frontier-kb + ten
agents. Implementation order
unchanged. Park Q-017. Do not
port Homebase / OpenAvatar /
Pipeline Studio / SoL-Pi /
AODL / MCP Tasks. A-006 stays
discarded.
Cycle 229: Linear dump deep-read
(PER-1522 bodies + Host-0 map +
Muse / Vercel / PER-1261 /
PER-469). No new Q-id. PER-1522
stays DRAFT. A-006 stays discarded.
Cycle 230: A-019 tools/call 503
is Application 5xx color, not
Wait replace. 04-disk-alarm names
4xx because that is the only
ConfigDocument switch. Zero
HealthCheckType in git. Do not
set HealthCheckType ELB. Do not
503 /health. A-006 stays discarded.
Cycle 231: dying-instance 5xx
does not fail the NEW Immutable
instance. HealthCheckSuccessThreshold
unset (default Ok) is the temp
ASG bar. socialPosts Min=Max=1
is a comment. Do not set that
threshold from A-019. A-006
stays discarded.
Cycle 232: Sunday InstanceRefreshEnabled
is weekly Immutable (AWS), not
rolling. L4-6 comment is stale.
Zero RollingUpdateType in git.
Dying 5xx cannot fail the new
weekly instances. Do not disable
refresh. A-006 stays discarded.
Cycle 233: Sunday-without-hook still
disableCron (IMDS Terminated and
SIGTERM gracefulShutdown). Wait is
the park, not the 503. A-006 stays
discarded.
Cycle 234: Hermes can see A-019 503
while /health is 200. Nginx 502 is
after server.close. 600s starts at
deregister. A-006 stays discarded.
Cycle 235: POST /mcp 503 is a one-shot
in this tree. Q-001 fixture asserts
200. Do not add a 503 retry in A-019.
A-006 stays discarded.
Cycle 236: 503 does not poison
sessionId. Later tools/call can
rehydrate. Do not 404 drain. A-006
stays discarded.
Cycle 237: JSON 503 is enough for
SDK send(). Do not emit SSE 503.
A-006 stays discarded.
Cycle 238: this tree cannot rewrite
JSON 503. Do not add error_page.
A-006 stays discarded.
Cycle 239: ALB passes Application 503
through. Zero listener rules. Do not
add aws:elbv2:listener from A-019.
A-006 stays discarded.
Cycle 240: A-019 does not pin ALB XFF
attributes. AWS defaults; not an EB
option. MCP has zero req.ip. ENG-493.
A-006 stays discarded.
Cycle 241: an ENG-493 XFF pin is
modify-load-balancer-attributes on the
LB ARN, not A-019 or A-020. Do not add
A-021. A-006 stays discarded.
Cycle 242: LoadBalancers[*].Name stays
across Immutable and Sunday. Console
XFF drift survives. IdleTimeout does
not reapply weekly. A-006 stays discarded.
Cycle 243: a later ENG-493 pin is the
only in-tree reassert of XFF without
recreate. IdleTimeout resource-only PR
does not transfer. A-006 stays discarded.
Cycle 244: deploy IAM does not list
ModifyLoadBalancerAttributes. Grant is
live-AWS-only. A-006 stays discarded.
Cycle 245: DescribeLoadBalancerAttributes
is also unnamed. LB Describe is never
called. A-006 stays discarded.
Cycle 246: an XFF no-op still needs LB
Describe on every opted-in backend
SUCCESS. A-006 stays discarded.
Cycle 247: a later XFF IAM miss is
GitHub-red / prod-green, not an A-019
503. A-006 stays discarded.
Cycle 248: a later XFF pin can fail
closed before update-environment. Do
not un-park A-020 for that slot. A-006
stays discarded.
Cycle 249: fail-closed-before-apply
only helps GitHub merges. Sunday XFF
drift is IdleTimeout class. A-006
stays discarded.
Cycle 250: a pin-only schedule: would
be the git-native Sunday XFF reassert.
Do not add it from A-019. A-006 stays
discarded.
Cycle 251: a pin-only Sunday job would
not hit Must be Ready. A-006 stays
discarded.
Cycle 252: XFF must use
LoadBalancers[*].Name, not
AutoScalingGroups[0]. A-006 stays
discarded.
Cycle 253: this tree and AWS immutable
do not return two LoadBalancers[*]
ARNs during Updating. A-006 stays
discarded.
Cycle 254: if two ARNs appeared, copy
ENG-823 pin-all. Do not fail closed
on count != 1. A-006 stays discarded.
Cycle 255: do not fork grep ^arn: into
an /app/ filter from A-019. A-006 stays
discarded.
Cycle 256: a net/ XFF modify fails the
job. Do not add skip-non-app. A-006 stays
discarded.
Cycle 257: NLB xff_* Describe is None,
then Modify, then fail. Do not add a
None-skip. A-006 stays discarded.
Cycle 258: do not fail() on ALB XFF
Describe None before Modify. A-006 stays
discarded.
Cycle 259: a later XFF pin copies ENG-823
None policy. Do not add a fourth. A-006
stays discarded.
Cycle 260: treat empty XFF Describe like
20. Do not add hook -z. A-006 stays
discarded.
Cycle 261: unset XFF opt-in skips like
partner. Do not pin AWS defaults. A-006
stays discarded.
Cycle 262: do not piggyback XFF on the
delay opt-in. A-006 stays discarded.
Cycle 263: new ensure_xff_* sibling. Do
not stuff XFF into delay. A-006 stays
discarded.
Cycle 264: call XFF from main() next to
delay. Do not copy dryrun cannot-fail.
A-006 stays discarded.
