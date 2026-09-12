# Thesis: nanoservices for AgentWeb

## One sentence

Do **not** explode Emma into a mesh of HTTP nanoservices. AgentWeb is
already a **multi-runtime system** with a **god-object backend**. The
cutting-edge move for *agentic* development is a **modular monolith**
(Hermes / OMP shape): in-process packages with ports, one tool per file,
   a typed loop, and extract-to-network only where a deploy unit already
exists. AgentWebPro **#2393** is already extracting a Slack channel port
in-process — that is the move; do not add a fifth HTTP service.

Q-013 (rewrite `agentModeService.ts`) stays **discard**. Network-splitting
the chat loop is the same idea with more latency and a billing footgun.

## What “nanoservice” should mean here

| Layer | Meaning | AgentWeb today |
|---|---|---|
| **Logical** | One operation, one contract, one test surface | Partial: `loops/core` ports, `agentMode/core/*` seams, MCP tool handlers |
| **Package** | Import boundary an agent can hold in context | Missing: `backend/package.json` has no `workspaces` and no dependency-cruiser (cycle 38). Folders + A-002 AST guard first; do not extract npm workspaces instead of Q-014 |
| **Process / deploy** | Independently shipped runtime | Already: backend EB **plus a `child_process.fork` worker that still `new AgentModeService()`** (cycle 44–46: parent = I/O — HTTP, Socket.IO, cron, MCP *server*; worker = compute — `generateMarketingResponse`; chatbot still `executeTool` on the parent). partner-portal EB, agent-engine GCP, remotion-lambda. The fork is event-loop isolation, not a package boundary |

2026 writing that uses “nanoservice” (e.g. telemetryagent.dev) is
explicit that this is **first a logical architecture**, compatible with
a modular monolith. Microsoft’s multi-agent reference architecture
recommends the same: start modular-monolith, extract when scale or
ownership forces it.

A 60-tool HTTP mesh would recreate MCP poorly: `apiTools.ts` already
`mcpFetch`s `http://localhost:${PORT}/api/emma/*`. The MCP *client* even
had a self-server `"agentweb-tools"` (`mcp_config.ts` L3–10) and
**skips it on the file-config path** (`mcpClientService.ts` L420–432)
as a circular dependency. Cycle 90: the Dynamo `mcp_servers` loader
does not copy that filter; admin localhost URLs still connect. Park
A-018 (copy the skip, do not HTTP-split). Q-014 lists `generate_image`
for *external* Hermes; it does not re-enable that self-client.
`ListTools` is `getToolDefinitions()` with **no skill
gate** (`mcpServerCore.ts` L76–83, cycle 48). Anonymous discovery
(cycle 49) may **list** that tool when the ENG-984 flag is on;
`ANONYMOUS_TOOLS` is empty so they cannot **run** it. Cycle 50: a leaked
`CallTool` still dies at `mcpFetch` `lookupUser` (`httpClient.ts` L57–66)
before a self-call JWT. Cycle 51: do not treat `requireEmmaTokenBudget`
as a substitute — it allow-lists `anon_*` (ENG-1163). Cycle 53: this
tool cannot skip `lookupUser` via ENG-1596 (`ctx()` has no
`overrideToken`). Cycle 54: A-007 copies ENG-982 mcpFetch shape, not
`workflowTools.ts` L37 `adminClientScope`. OMP 0.85.1 still has images
as `pi-ai` sideEffects (`images.js`). Cycle 55: remotion-lambda is the
isolate; identity stays in `remotionService` — same as `imageGeneration.ts`
already calling vendor HTTP. Cycle 56: `mcp/client` ↛ `mcp/server`
already (OMP DAG); park A-016 until A-002. Cycle 57: `app.ts` is the
composition root (`setupMcpServer` L204, loop `register*` L475–491);
#2271 owns its route table — A-007 still attaches at `mcpServerCore`.
Cycle 58: `server.ts` drain (ENG-1189) is why mcpFetch must share this
`listen()`. Cycle 59: `app.ts` → `crm.ts` L24 → `server.ts` already
cycles; `registerIo` exists but `MinimalIo` cannot emit — park A-017
(expand emit, do not HTTP-split CRM). Cycle 60: copy
`getFathomLinearPort`, not `LoopPorts` (L143–150). Cycle 63: dynamic
`import('../server')` is the rest of the leak (`gtmPlan.ts` L12–13 /
L1495). Cycle 64: SSE (`sseProgress.ts`) is a second in-process bus;
`RunEmitter` typed sink is empty (`agentModeService.ts` L3449). Cycle 65:
those Maps are parent-heap only (`instanceState.ts` L10–11 same
shape; child worker never imports `sseProgress`). Cycle 66:
`keyedMutex.ts` L12–15 — one session, one process;
`tryClaimSessionGeneration` is an in-memory Set. Cycle 67: MCP
ENG-114 is the scale-out template (Dynamo metadata, in-process
rehydrate, no sticky routing) — not a fifth `listen()`. Cycle 68:
ASG kill is faster than drain (`asgLifecycleGuard.ts` L4–16);
hook `agentweb-drain-before-terminate` parks **this** process
(`server.ts` L572–574). `.ebextensions` cannot install it (ENG-818).
Cycle 69: that drain’s wait list is four named units (`server.ts`
L397–420); inbound MCP `CallTool` is not one (`mcpServerCore.ts`
L88–120 has no `cronJobRegistry.track`). `mcpShutdown` is unused
by `runDrain`. Cycle 70: local Map (`mcpServer.ts` L307–315) and
`rehydrateAndServe` (L441) share that CallTool; wrap it once.
Rehydrate is finite HTTP (`mcpSessionRehydration.ts` L15–18);
mcpFetch still needs a new loopback. Cycle 71: AgentWebPro is
empty on that wrap set (`mcpServerCore.ts` / `cronJobRegistry.ts`
/ `mcpServer.ts`). Do not start it instead of Q-014. Cycle 72:
local GET `/mcp` (`mcpServer.ts` L508–531) disables timeouts; that
SSE is why `mcpShutdown` must follow the CallTool wait. Cycle 73:
`server.close()` / `io.close()` (`server.ts` L440–455) are not
awaited; the ASG hook (`asgLifecycleGuard.ts` L262–273) completes
on drain resolve anyway. Cycle 74: the compute fork ignores
SIGTERM (`workerShutdownGuards.ts` L1–18 / ENG-201); a fifth
`listen()` would not. Cycle 75: `RecordLifecycleActionHeartbeat`
is never called (`asgLifecycleGuard.ts` L26 comment only);
`--heartbeat-timeout 900` (`eb-deploy.sh` L608–613) is CONTINUE
fallback. `DRAIN_CEILING_MS` 10 min (`shutdownConstants.ts` L8)
fits inside EB rolling `Timeout: 900` (`.ebextensions/rolling.config`
L5–7). Cycle 76: GET `/mcp` is nginx/ALB **600s**
(`.platform/nginx/conf.d/agent-mode-timeout.conf` L5–7, no
location; `.ebextensions/timeout.config` L5–6), not Socket.IO’s
3600s (`websocket.conf` L5–16). Node `setTimeout(0)` does not
beat the proxy. Cycle 77: Q-014 `generate_image` mcpFetch uses
the **5 min** default abort (`httpClient.ts` L205); it does not
pass `timeoutMs` (`apiTools.ts` L2096–2108). Landing-page tools
already override to 25 min in-process. Cycle 78: the leaf is
**8 min** (`imageGeneration.ts` L69–79 ENG-510), so MCP’s 5 min
is a stricter face, not the vendor cap. Cycle 79: that 5 min
abort does **not** cancel the leaf (`emmaApi.ts` L174–187 has
no close listener; `generateImage` has no AbortSignal); meter
still runs after success (`imageGeneration.ts` L546–562). Cycle 80:
MCP `POST /generate-image` never calls `tryClaimSessionGeneration`
(`emmaApi.ts` L174–182 vs `agentModeController.ts` L951). Quota is
the brake. Cycle 81: that brake is a GET
(`checkTokenUsage` via UserIdIndex GSI) then `next()`; the ADD
is after success and does not condition on remaining allowance.
`reserveSpend` is unused here (ENG-1250 admission is Harsha).
Cycle 82: the leaf writes `$` with zero tokens
(`imageGeneration.ts` L551–563); default `allowed` is
`tokenAllowed` (`tokenUsageService.ts` L342–396). Cycle 83: MCP SDK Streamable
HTTP mints a `streamId` per POST (`webStandardStreamableHttp.ts`
v1.25.2 L678); AgentWeb adds no mutex. Cycle 84:
`checkExtraCostUsage` is tests-only; images do not write
`extraCostUsage`. Cycle 85: default image is $0.134
(`llmPricing.ts` L301); `gpt-image-2` is $0.04. Cycle 86:
video uses the same `$` / 0-token meter and is not on MCP.
Cycle 87: AgentWebPro empty on those files plus `apiTools.ts`.
Cycle 88: OMP 0.85.1 unpublished experimental client/server.
Cycle 89: Hermes MCP parallel is opt-in (default false).
Cycle 90: self-MCP skip is file-config only; DB path can loopback.
Cycle 91: live HTTP face is `/mcp`; `/mcp/server` is stale.
Cycle 92: inspector is SSE against that dead path; GET `/mcp` needs a session.
Cycle 93: SIGTERM closes inbound MCP before `runDrain` waits.
Cycle 94: that close does not evict ENG-114; only `DELETE /mcp` does.
Cycle 95: `MCP_SESSION_STORE` unset in git; default memory.
Cycle 96: Immutable deploys already overlap two backends.
Cycle 97: drain 503s scheduled chats only; `/health` and `/mcp`
stay open until unawaited `server.close`.
Cycle 98: `cronJobRegistry.drain()` is live; `track()` has no
gate. Worker already refuses new `runInWorker`.
Cycle 99: `chatbotTurn` already extends that live drain; wrap
CallTool after #2 must copy the worker pair.
Cycle 100: Slack/email ack HTTP then `track()`. Park A-019 —
one registry gate, not a Slack nanoservice.
Cycle 101: `/generate` uses `tryClaim` / the session Set, not
`track()`. A-019 must close both.
Cycle 102: auto-continuation re-fills that Set after release.
`tryClaim` refuse is required, not optional.
Cycle 103: listed MCP `emma_get_session` mcpFetchs the GET that
starts that continuation. Do not HTTP-split the leaf.
Cycle 104: listed `emma_send_message` is a 5 min mcpFetch around
`/generate` that *does* cancel on abort. Q-014’s image hop does
not. One process, two clocks.
Cycle 105: that POST is not retried after `server.close`. GET
`emma_get_session` retries 3× into a closed listener. Hermes on
the new instance is a different process.
Cycle 106: inbound `/mcp` (nginx) and loopback mcpFetch (`PORT`)
are different sockets. `closeIdleConnections` unused. Do not
HTTP-split to get a second close.
Cycle 107: refused upstream is nginx **502 now**; the 600s is
the SSE **504**. Three classifier classes for one close(). Do not
HTTP-split to unify them.
Cycle 108: ALB health cannot stop Hermes during drain. `/health`
must stay 200 until close (ENG-1189). A-019 is the gate, not a
health threshold.
Cycle 109: `underlying_health_verdict` is a GitHub Actions probe
(ENG-878), not runtime drain. Copying it into the process would
bless the dying instance. Do not HTTP-split to host it.
Cycle 110: Sunday recycle overlaps without that probe. A-019 is
weekly, not only on merge. Do not disable `InstanceRefreshEnabled`.
Cycle 111: Sunday + Immutable serialize or fail the GitHub deploy
(`Must be Ready`). Not a three-process mesh.
Cycle 112: 3×1200s is not a wait. Settle expiry `fail()`s
(`exit 1`); the 2700s total budget caps retries. Not a
3600s third clock.
Cycle 113: last deploy’s hook is on the ASG Immutable then
discards. Sunday recycle never calls `eb-deploy.sh` (A-020).
Cycle 232: AWS `InstanceRefreshEnabled` is weekly immutable, not
rolling; the L4–6 comment was the cycle 110/113 shorthand.
Park A-020 (second put after verify). Not
`.ebextensions` (ENG-818).
Cycle 114: the guard still drains on two IMDS `Terminated`
reads without a hook. ASG does not wait. 3m19s is overlap,
not park. A-019 fires only if drain starts (`disableCron` first).
Cycle 115: Sunday SIGTERM is OS/cgroup (ENG-201). This tree
does not ship a backend `TimeoutStopSec`. The 900s comment is
Immutable command Timeout, not recycle.
Cycle 116: `06-log-retention.config` names `systemd-journald`.
`web.stdout.log` is a log file. Sunday stop-timeout is
live-AWS-only. Do not copy agent-engine’s 30s.
Cycle 117: `runDrain` never stops `nginx.service`. Hermes inbound
needs nginx; mcpFetch does not. Stop order is live-AWS-only.
Cycle 118: `PORT=8080` is not in git. `.env.example` L1 is 3001.
Only git `proxy_pass` is `/socket.io/` → 8080. `/mcp` is
unvendored.
Cycle 119: cannot name the platform nginx.conf. `app.ts` L152–155
is the in-repo admission. Docs default upstream is 5000. Filename
and port are live-AWS-only.
Cycle 120: git never chooses among 3001 / 8080 / 5000. Zero
`application:environment` in `.ebextensions`. `websocket.conf`
hardcodes 8080 and does not read `$PORT`.
Cycle 121: a `/mcp` location is instance-only. ENG-836 allows it
alone and forbids it next to ALB `.ebextensions`. Do not add A-021.
Cycle 122: detect-changes skips drafts (`tests.yml` L18). Cycle
121’s draft-run claim is wrong; instance-only classification holds.
Cycle 123: re-draft is `NO_EVIDENCE` (`merge-evidence.sh` L264).
`gh pr checks` can still look green. Do not add A-021.
Cycle 124: ENG-836 skip is not draft. Discriminator has no path
filter. `BACKEND_JOBS` is only `Backend build`. Do not add A-021.
Cycle 125: 5-minute string is the #2491 receipt; live ceiling is
12. Hung ENG-836 still PASSes. Do not add A-021.
Cycle 126: in-flight ENG-836 is PENDING (script L726). Separate
concurrency groups; Backend does not keep ENG-836 in the
evidence set. Do not add A-021.
Cycle 127: ENG-1373 is still an unlanded comment
(`merge-evidence.sh` L875, `dev.md` L157). Nothing in git adds
Backend build to GitHub required contexts. Do not add A-021.
Cycle 128: merge-evidence labels Dependabot skip as a path-filter
skip. #2491 PASSes with it skipped (test L437 / L452). Do not
add A-021.
Cycle 129: GitHub treats a job-level `if` skip as Success.
Dependabot’s REQUIRED comment only bites when the job runs.
Do not add A-021.
Cycle 130: naming `Backend build` as required cannot reproduce
merge-evidence section 7. Every tests.yml job except Detect
changed projects is a job-level path skip. Do not add A-021.
Cycle 131: merge-evidence has no `PARTNER_JOBS`. Partner-only
PASSes with Partner skipped (test L1047). Do not add A-021.
Cycle 132: no `WORKFLOW_JOBS`. Editing `merge-evidence.sh`
PASSes with CI script tests skipped (test L1196–1198). Do not
add A-021.
Cycle 133: ENG-1377 relay and remotion builds are unnamed in
merge-evidence. Do not add A-021.
Cycle 134: a `tests.yml` PR schedules six jobs; merge-evidence
requires `Backend build` only. Do not add A-021.
Cycle 135: agent-engine is a deploy unit with no GitHub build
job. Remotion got ENG-1377; the Python worker did not. Do not
add A-021.
Cycle 136: customer-portal is a fifth repo (gitignored), not a
fifth process. CLAUDE.md L155 is stale. Do not add A-021.
Cycle 137: `customerPortalPages.ts` is the other repo’s IA as
an in-process list plus one GET. Not a fifth `listen()`. Do not
add A-021.
Cycle 138: `growth-chat/` is a sixth origin; Growth Genius
already calls `agentModeService.callLLM` (L85). Do not add
A-021.
Cycle 139: Growth Genius inlines `search_knowledge_base` and
executes Emma’s KB helper. Fifth catalog, still in-process.
Do not add A-021.
Cycle 140: the KB helper is a Vertex leaf (L4711–4867) trapped
in a file that cycles with `agentModeService`. Do not add A-021.
Cycle 141: ENG-1057 three faces; cap at the source. Same
lesson as `generate_image`. Do not add A-021.
Cycle 142: those faces do not share source sets. Agent Mode
is a Drive/ClickUp superset after the Vertex leaf; Emma RAG
and Growth Genius are not. Do not add A-021.
Cycle 143: listed MCP `search_knowledge_base` already hops to
that superset (`emmaApi.ts` L98–101); `generate_image` is
still `internal: true`. Q-014 is listing, not a new hop. Do
not add A-021.
Cycle 144: Agent Mode still recaps Vertex (L24065) after
ENG-1057 capped the leaf (L4800–4804 / L4852). L24062
comment is stale. Do not add A-021.
Cycle 145: three TypeScript `searchKnowledgeBase` symbols.
Emma L4674 is Azure embeddings; Agent Mode L24032 is the
superset; Growth Genius L66 is Vertex-only. Do not add
A-021.
Cycle 146: three JSON schemas for `search_knowledge_base`.
GG requires `reason`; Emma/MCP require `query` only. A-011
already parks this for `generate_image`. Do not add A-021.
Cycle 147: GG `reason` is required then discarded (L174 vs
L177) before the Vertex leaf. Unifying it away is a no-op
on retrieval. Do not add A-021.
Cycle 148: GG L71 and Emma RAG L5106 hardcode 10; Emma tool
/ MCP default 5. Cardinality is per-face. Do not add A-021.
Cycle 149: Agent Mode collects per source then slices
(L24233). Vertex-first prefix can discard Drive/ClickUp
after paying for them. Listed MCP hops here. Do not add
A-021.
Cycle 150: Vertex filling the cap does not skip Drive or
ClickUp (L24070 → L24073). Do not add A-021.
Cycle 151: ClickUp docs “search” is list-all then
`includes()` (`clickupService.ts` L103–119). Drive is
`fullText contains`. Do not add A-021.
Cycle 152: `listTasks` enriches attachments (`clickupService.ts`
L219–258); search only uses name+description. Do not add
A-021.
Cycle 153: `readDocContent` runs before `includes()` (L24155
vs L24156). Name miss still pays the page tree. Do not add
A-021.
Cycle 154: Drive has ENG-1624 count+time bounds; ClickUp
docs search has neither (`clickupService.ts` grep empty).
Do not add A-021.
Cycle 155: Drive folder trees `Promise.all` (L24080);
ClickUp docs sequential (L24148). Do not add A-021.
Cycle 156: Search helpers unbounded; 200MB/1M caps are
on materialize and named-read. Do not add A-021.
Cycle 157: Search Drive query omits `size` (L24093);
listing/named-read/materialize request it. Do not add
A-021.
Cycle 158: Workspace `files.export` empty `size`;
named-read fallback is after download (L25606). Do not
add A-021.
Cycle 159: Hermes MCP client ~24 files; OMP still
v0.85.1. Do not add A-021.
Cycle 160: Hermes loop still client; two opt-in stdio
MCP servers. Do not add A-021.
Cycle 161: hermes-tools `image_generate` is in-process
`handle_function_call`. Do not add A-021.
Cycle 162: Hermes `image_generate` schema is not MCP
`generate_image`. Third origin. Do not add A-021.
Cycle 163: Hermes capability-gates tools/list; AgentWeb
MCP is a literal. Do not add A-021.
Cycle 164: generateImage does not refuse input_images
on Emma’s t2i-described model. Do not add A-021.
Cycle 165: logo_image is mutated into inputImages before
routing. Do not add A-021.
Cycle 166: Four image-model catalogs; L2203 must-match
is false. Do not add A-021.
Cycle 167: HITL before Invalid imageModel. Do not add
A-021.
Cycle 168: Runway referenceImages from the mutated array.
Do not add A-021.
Cycle 169: Azure edits inputImages[0] only; logo-at-end
drops. Do not add A-021.
Cycle 170: L492 Gemini 3 default is because multi-input.
Do not un-ready Q-003. Do not add A-021.
Cycle 171: Azure edit skips processInputImage. Do not
add A-021.
Cycle 172: Azure FormData always image/png. Do not add
A-021.
Cycle 173: S3 upload always image/png. Gemini 3 data-URL
MIME discarded. Do not add A-021.
Cycle 174: Runway HTTPS skips C2PA and S3. Do not add
A-021.
Cycle 175: generateWithOpenAI else unreachable. Do not
add A-021.
Cycle 176: meter provider is prefix not dispatch. Do not
add A-021.
Cycle 177: BLOG_SETUP.md is a stale fifth catalog.
Blog heroes omit imageModel → Gemini / Google/Image.
Agent-engine still has OPENAI_IMAGE_API_KEY. Do not
add A-021.
Cycle 178: two deploy units, two image dispatch tables.
gpt-image-2 is Azure on the leaf, OpenAI-else on the
worker. Do not un-ready Q-003. Do not add A-021.
Cycle 179: ImageModelsSettings seed omits gpt-image-1.
Do not add A-021.
Cycle 180: onboarding pins Gemini 3 explicitly; Q-003
unspecified mapper never runs. Do not un-ready Q-003.
Do not add A-021.
Cycle 181: onboarding 180s race does not abort the 8 min
leaf. Nested Promise.race, no AbortSignal. Do not add
A-021.
Cycle 182: late Gemini success S3-uploads a key nobody
stores. s3Utils has no DeleteObject. Do not add A-021.
Cycle 183: uploaded-by is a hardcoded agent-mode
constant on both helpers; thumbnail writer tells the
truth. Do not add A-021.
Cycle 184: uploaded-by is write-only. HEAD callers
use ContentType. Helpers set no Tagging. Do not add
A-021.
Cycle 185: helpers omit CacheControl. README 60s is
CLI copy-object. Thumbnail L35 is immutable 1y. Do
not add A-021.
Cycle 186: serveAsset hardcodes max-age=300. Email
rewrite hops here. Do not add A-021.
Cycle 187: rewrite matches one S3 host; /asset/
accepts three. Brand already extracted deriveOwnBucketKey.
Do not add A-021.
Cycle 188: three S3 URL writers. Helpers return
Location; brand/db/tasks construct regional
virtual-hosted; Remotion path-style. Do not add
A-021.
Cycle 189: Family B is not one function. books
encodes segments; brand interpolates raw
originalname. extractS3KeyFromUrl does not decode.
Do not add A-021.
Cycle 190: CORS Origin is exact Family B host
(credentials: true). cors.test.ts never pins it.
Do not add A-021.
Cycle 191: HTML repair is a third S3 matcher.
Hardcoded prod `agentweb-user-files.s3`; same
class already uses extractS3KeyFromUrl (L28635).
Writer in the same method uses env bucket.
Do not add A-021.
Cycle 192: repair axios.gets S3 (L30316 / L30547).
Same class already SDK-streams and presigns.
Do not add A-021.
Cycle 193: Emma C2PA/background advertise S3 URL;
tests pin Path C axios.get of path-style S3.
Do not add A-021.
Cycle 194: leaf processInputImage is Path C.
Gemini has no data: skip. Do not un-ready Q-014.
Do not add A-021.
Cycle 195: video processInputImage is a second
Path C (no UA, no SVG). Seedance default uses
Higgsfield media_import_url. Q-016 parked.
Do not add A-021.
Cycle 196: generateKeyframes persist-then-Path-C
is Veo-only; Seedance ignores useKeyframes.
Do not add A-021.
Cycle 197: character referenceImageUrl is Path D
on the Seedance default. Emma create_character
hardcodes empty key. Do not add A-021.
Cycle 198: brand-guide matcher includes('.s3.')
misses Family A path-style. deriveOwnBucketKey
already parses it. Do not add A-021.
Cycle 199: downloadBrandLogoToS3 is Family A.
Drops result.Key; auto-logo-* blocks delete's
URL fallback. REST uploadBrandFile returns the
real key. Do not add A-021.
Cycle 200: classifyBrandLogoUrl Path-C GETs that
Family A URL. Ads fail closed on 4xx. Same repo
already SDK-streams (filesController L35). Do not add A-021.
Cycle 201: pin GET has no User-Agent; probe and
cssExtractor do. Same URL can fail pin and pass
ads. Do not add A-021.
Cycle 202: pin does not call ssrfGuard;
cssExtractor validateURL is company-URL-only.
describe_image already uses the in-process guard.
Do not add A-021.
Cycle 203: company-scrape validateURL misses
FORBIDDEN_HOSTNAMES / 169.254 / DNS-pin.
Tests pin localhost/10/192.168/ftp. Preferred
path is page.goto. Do not add A-021.
Cycle 204: that page.goto spoofs Mac Chrome/120;
axios fallback is Extractor/1.0. Tests pin
no-cache headers, not the UA. Do not add A-021.
Cycle 205: read_brand_guidelines LLM HTML shows
asset.filename (logo.png / 'url'), not logoUrl.
Discovery formatter already prints the URL.
Do not add A-021.
Cycle 206: pin/probe omit Referer; Chrome scrape
still sends it on <img>/icon during networkidle2.
Referer-gated CDN 403s both pin and probe. Ads
fail closed. Do not add A-021.
Cycle 207: generate_image.filename is the output
name (required, non-empty only), not cycle 205
asset.filename. logo_image optional; ENG-326
recovers omit. Hermes native schema requires
prompt only. Do not add A-021.
Cycle 208: extractGeneratedImageFilenames
de-dupes on filename; tests pin a.png twice →
one. Continue prompt uses that length. S3/URL
scan are unique per upload. Do not add A-021.
Cycle 209: Kevin asked to reprioritize.
Product order Q-014 → Q-004 → Q-001 → Q-003.
Architecture A-002 → A-019 → A-007 → A-008.
A-019 unparked (CallTool wrap + drain refuse).
A-008 persist is the prize; git-mv is the first
slice. Do not revive A-006. Do not add A-021.
Cycle 210: track() cannot refuse — callers
pass an already-started Promise (server.ts
L301). Worker refuse is inside runInWorker
before work. tryClaim false is 409. CallTool
handler-entry is the Q-014 image gate. Do
not wrap registry.execute. Do not add A-021.
Cycle 211: do not drain-gate ListTools or
initialize. A-019 admission is HTTP 503 on
POST `/mcp` `tools/call` (batch fail-closed),
not CallTool `isError`. Do not hide
`generate_image` from the list. Do not add
A-021.
Cycle 212: do not 503 GET `/mcp`. The
vendored Streamable HTTP client throws on
GET 503; 405 is the optional-SSE skip.
Existing SSE hang is `mcpShutdown` after
the wait, not this admission. Do not add
A-021.
Cycle 213: fold that close into A-019
first_slice. `await mcpShutdown` after the
four-way wait; drop sibling SIGTERM
(`mcpServer.ts` L269–270). Shared
transport: POST CallTool and GET SSE.
ASG drain never fires the closer; Sunday
SIGTERM runs it first. Do not add A-021.
Cycle 214: GET cleanup is
`streamController.close()`; Hono
`writable.end()`. Do not await
`server.close` for the hang. Local never
`enableJsonResponse`. Do not add A-021.
Cycle 215: rehydrate CallTool is the
`mcpServerCore` wrap. JSON `close()`
does not `resolveJson`. Do not
`sessions.set` that transport. Do not
add A-021.
Cycle 216: keep rehydrate `finally
close()`. `resolveJson` (L706) never
`stream.cleanup()`; SSE else does.
After `handleRequest` returns, close
is delete-only leftover
`_streamMapping` (initialize +
CallTool). Skipping it after resolved
JSON does not leak Express; JSON on
a reused transport would accumulate.
Do not add A-021.
Cycle 217: `mcpShutdown` never
cancels `generate_image`. `_onclose`
does not abort; CallTool ignores
`extra`; mcpFetch abort is
timeout-only. A-019 wait is the
billed hop. Do not add A-021.
Cycle 218: `send()` after `close()`
is Protocol `_onerror`, not
`mcpServerCore` `isError`. Handler
already billed. Wrap handler return,
not only `execute`. Drain polls size
every 2s and does not await `send()`.
Do not add A-021.
Cycle 219: closed POST SSE is not
404 reinit. Vendored POST
`_handleSseStream(..., false)`; no
`eventStore` so no priming. Q-001
fixture is httpx `next(data:)`.
Do not add A-021.
Cycle 220: 60s is client
`Protocol.request()`, not inbound
CallTool. `mcpClientService` 3600000
is AgentWeb as client. Hermes 315s
is OAuth add. Do not add A-021.
Cycle 221: `notifications/cancelled`
is a new POST. Client HTTP `send()`
ignores `relatedRequestId`. After
`mcpShutdown` it cannot abort the
original CallTool. Do not 503 it.
Do not add A-021.
Cycle 222: skip-send does not
`stream.cleanup()`. Local POST SSE
stays mapped until `mcpShutdown`
`close()` (same closer as GET).
Do not add A-021.
Cycle 223: skip-send POST is the
same `CompleteLifecycleAction` cut
as GET. Do not await `server.close`.
Do not add A-021.
Cycle 224: Sunday `process.exit(0)`
after drain can cut Hono `end()` I/O
(and can cut before `end()` if `flow`
is on `'drain'`). ASG does not exit.
Do not put `process.exit` on the ASG
path. Do not replace Sunday exit with
`exitCode` in A-019. Do not add A-021.
Cycle 225: SIGTERM on a settled
`drainPromise` is `process.exit(0)`
with no join to `completeAction`.
HeartbeatTimeout 900s CONTINUE is
the fail-safe. Do not await the hook
from `gracefulShutdown` in A-019.
Do not add A-021.
Cycle 226: L18–19 is a comment, not
a pin that EB withholds SIGTERM for
`Terminating:Wait`. Three SIGTERM
sources (`dev.md` L1853); only ASG
replacement is the hook. Do not add
`TimeoutStopSec` from A-019.
Do not add A-021.
Cycle 227: `IgnoreHealthCheck: false`
is a deploy command, not a Wait
SIGTERM. After A-019 close, `/health`
502 is a side effect. Do not 503
`/health` during the wait. Do not
add A-021.
The listed face is a
**thinner** schema than Emma’s in-app tool (cycle 39: no `confirm`,
`emmaApi.ts` L181) and a **different catalog** (cycle 47).
Hop diagram: `COMPOSITION.md`.

## What already exists (do not rebuild)

1. **Strangler, chosen 2026-06-14** — `backend/docs/AGENTMODE_MIGRATION.md`.
   Target loop: `model → parse → typed registry → terminate`. Seams 1
   (termination) and 3/dispatch (`core/toolDispatch.ts`) extracted.
   `executeAgentStep` is still a skeleton that throws.
2. **`loops/core`** — no `services/` / `db.ts` imports; AWS/Slack via
   `ports.ts` (`LoopPorts` L143–150: s3, dynamo, bedrock, slack, clock,
   logger — cycle 33). Wired at `productionLoopPorts()` in
   `loops/adapters/awsAdapters.ts` L219–227. `loops/index.ts` is Hermes
   `registry.py`: only import is `./core/types` (cycle 35). Instances
   register from `app.ts` L118–120, not from a registry scan. Core **does**
   import `loops/index` from `orchestrator.ts` / `instanceRunner.ts`.
   CI does **not** enforce the host-forbid rule. Folder map: `MODULE_MAP.md`.
3. **MCP** — the external composition bus (Hermes, Cursor, Claude).
   ENG-982 already extracted `workflowTools.ts` (5 mcpFetch tools).
   `evaluationTools.ts` is a *different* hop: in-process services + dual
   `emmaToolRegistry` register (cycle 32). A-007 copies workflowTools,
   not evaluationTools. `apiTools.ts` still has 85 registers; splitting
   along its section headers does **not** wait on #2832.
4. **Coding agent** — `codingAgentService.ts` is an **in-process**
   sub-loop (2,387 lines, no `spawn`/`fork`), not a deploy unit. It
   imports `agentModeService` for one settings read (A-010 park). OMP
   `pi-coding-agent` is a package; do not copy that into a fifth process.

## Cutting-edge vs this tree

| Strategy | Hermes | Oh My Pi | AgentWeb |
|---|---|---|---|
| One process for the agent loop | Yes | Yes (`pi-agent-core` package) | Yes, but 40.5k-line file |
| Package / folder graph | `agent/`, `tools/`, `gateway/`, plugins | bun workspaces: `pi-agent-core`, `pi-ai`, `pi-catalog`, … | Three *repos-in-folder* (backend / partner / engine) + one backend blob. Cycle 41: loop imports `controllers/blog` (L29894) — DAG inverted vs Hermes/OMP |
| One file per tool | `tools/*.py` self-register | 31 tools, split packages | `emma/tools.ts` 9.8k lines; `apiTools.ts` 3.6k |
| Typed tool registry | `tools/registry.py` | package `agent` | **Four** in-process tables (cycle 37): `mcpToolRegistry`, `emmaToolRegistry` (3-line `emma/registry.ts`), vendor MCP client, per-session `this.toolRegistry`. Monolith copies Emma tools at L1891 |
| Characterization / eval | ~25k pytest files claimed | edit benchmarks, metaharness | Characterization harness exists; god file still grows (24k → **40.5k** since Jun) |
| Boundary linter | import chain documented | workspace packages | **None**. Cycle 42: at least six `services/` files import `controllers/` (A-013). Cycle 59: CRM/worker import the listen module (`server.ts`); park A-017 |
| Network extract | MCP *clients* to other servers | browser-relay, collab-web as packages | MCP *server*; don’t invert it |

## SDLC to get there (when coding is unlocked)

Order is process, not a rewrite:

1. **Ratchet, don’t rewrite.** New code in `agentMode/core/` or sibling
   modules; net-negative-or-flat `agentModeService.ts` on loop PRs
   (already the migration rule). Monolith grew +16k lines since the
   June baseline — the ratchet is not running.
2. **Enforce the one good boundary.** CI check: `loops/core` must not
   import host services (A-002). Then the same rule for `agentMode/core`.
3. **One-tool-per-file on MCP first (A-007).** Split `apiTools.ts` into
   **section files** like `workflowTools.ts`, not 85 files in one PR.
   First file is `tools/infrastructure.ts` (`generate_image` is **not** in
   the Content section). Keep the barrel. Never `emma/tools.ts`
   while #2832 is open (A-004). A-005 (LOC ratchet) waits until seven
   open `agentModeService.ts` PRs shrink.
4. **Keep deploy units at four.** Agent-engine already extracted the
   Playwright workload and still JWT-calls `/api/internal/usage` (cycle 27).
   A fifth service for images/video would split the **leaf**
   (`imageGeneration.ts`: meter, C2PA L575–578, CRITICAL LOGO L477–484)
   from policy (category / HITL / persisted logo) and miss blog/thumbs/
   video/onboarding callers (cycle 36). It would also skip monthly quota
   (cycle 40) and pile onto the existing `fork` worker that already loads
   `AgentModeService` (cycle 44). Cycle 46: `generateImage` is already
   called from parent MCP, parent chatbot (`chatbotService.ts` L5461),
   and worker chat — a fifth HTTP process would be a client of both OS
   processes. Forbidden.
5. **Agent context map.** Draft: `research/sdlc/MODULE_MAP.md`. A short
   `backend/src/AGENTS.md` (module index, max file size, “do not edit X”)
   beats another 40k-line CLAUDE dump. LinkedIn’s 2026 MCP playbook is
   curated context, not every tool.

## Harsha gates

- Dynamo / `db.ts` (11.7k) is not a nanoservice candidate.
- Billing meter stays one success-path.
- Strangler PRs are his lane (Q-010 / A-003). Kevin’s unique help is
  still Hermes operator + MCP listing, plus *researching* this map.

## Cycle 228 (arsenal / Linear / frontier-kb)

`perm-20260910-no-universal-harness-plugin`: leapfrog is steal typed
slots, not import OpenHands into Emma. `perm-20260911-hermes-pi-plugin-adapter-is-host-port-not-abi`:
SoL-Pi is a host port; AgentWeb MCP is already the external bus.
Linear PER-1522: **narrow twins ship**. A-006 stays discarded. Product
order unchanged. Parked Q-017 is MCP handshake hygiene, not a fifth
`listen()`.

## Cycle 229 (Linear dump deep-read)

PER-1522 + Host-0 lineage map are the past-ideas dump. Four buckets
only. Turning AgentWeb into zerOS / Pipeline Studio / Dash / an HTTP
nanoservice mesh is the named failure mode. Hermes lineage cards
(PER-150 family) are private synthesis jobs, not a public idea list.
No new Q-id. A-006 stays discarded.

## Cycle 230 (A-019 503 is color, not Wait replace)

`04-disk-alarm.config` L21–25 enables 4xx only because AWS enhanced
health cannot ignore 5xx. POST `/mcp` `tools/call` 503 is
Application 5xx in logs — same class as `runScheduledChats`
L13031–13032. Zero `HealthCheckType` in git; default ASG check is
EC2, not ELB. `Terminating:Wait` is already the replace. Do not set
`HealthCheckType: ELB` (would treat post-close `/health` 502 as ASG
unhealthy). Not a fifth `listen()`.

## Cycle 231 (dying 5xx ≠ new Immutable fail)

`HealthCheckSuccessThreshold` unset; AWS default `Ok` is the
**temporary ASG** bar. `IgnoreHealthCheck: false` + Timeout 900
wait on the **new** instance. Environment Red after the old row
is gone is ENG-878 lag (`eb-deploy.sh` L251–257), not overlap
5xx failing the new Ok. `socialPosts.ts` L16–21 is a comment.
A-006 stays discarded.

## Cycle 232 (Sunday refresh is Immutable, not rolling)

AWS: `InstanceRefreshEnabled` runs an **immutable update every
week**, with or without a platform version. Managed updates
always use immutable overlap (new set beside old; terminate
old if the new set passes). `05-instance-recycling.config` L4–6
“rolling” is a stale comment. Zero `RollingUpdateType` in git.
Cycle 110/113 “rolling on the surviving ASG” was that comment.
Dying 5xx still cannot fail the new Ok (cycle 231). Sunday
still never calls `eb-deploy.sh` (A-020 stays park). Not a
fifth `listen()`.

## Cycle 233 (Sunday-without-hook still 503s)

Missing `Terminating:Wait` skips the park, not `disableCron`.
IMDS `Terminated` (cycle 114) and OS SIGTERM (cycle 115) both
start `runDrain`. TODAY sibling `mcpServer.ts` closer 502s
`/mcp` first; A-019 drops that listener. Not systemd. Not
ENG-818 `.ebextensions`. A-006 stays discarded.

## Cycle 234 (Hermes sees 503 while `/health` is 200)

Always-200 `/health` (`app.ts` L547–553) keeps the ALB target
through `disableCron`. Nginx 502 is after `server.close`.
DeregistrationDelay 600s starts at deregister; ENG-764 3m19s
is the Sunday-without-hook clock. Not A-006.

## Cycle 235 (A-019 503 is a one-shot in this tree)

Q-001 fixture asserts HTTP 200. Vendored `send()` throws
`StreamableHTTPError` on `!ok`; only 401 recurses.
`mcpClientService` retries `playwright_` / `browser_` only.
mcpFetch does not retry POST. The 5s poll is
`/run-scheduled-chats`, not `/mcp`. Not A-006.

## Cycle 236 (503 does not poison sessionId)

`send()` keeps initialize-time `_sessionId`. Only
`terminateSession` clears it. Later POST can
`rehydrateAndServe` if the store has the row. Do not 404
drain. Do not `sessionStore.delete` on 503. Not A-006.

## Cycle 237 (JSON 503 is enough for `send()`)

`send()` reads Content-Type only after `response.ok`. On
`!ok` it `text()`s and throws `StreamableHTTPError(status)`.
SSE-shaped 503 would not reach `_handleSseStream`. GET 503
still throws (405 skip only). Copy `runScheduledChats` L13032
`.json()`. Not A-006.

## Cycle 238 (this tree cannot rewrite JSON 503)

Zero `error_page` / `proxy_intercept_errors` in `.platform`
(cycle 107). Catch-all `/mcp` nginx is not in git (`app.ts`
L152–155). Do not add `error_page` from A-019. Not A-006.

## Cycle 239 (ALB passes Application 503 through)

ALB forwards target HTTP errors (`HTTPCode_Target_5XX_Count`).
ALB-generated 502 is TCP RST / malformed / target gone.
Listener actions are only forward / redirect / fixed-response.
This tree’s only `aws:elbv2:` knob is `IdleTimeout: 600`.
Zero listener rules. Do not add them from A-019. Not A-006.
