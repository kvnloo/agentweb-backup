# AgentWeb research artifact

**Do not explode Emma into HTTP nanoservices.** AgentWeb already has four
deploy units. The pain is a 40k-line god object, not missing Kubernetes.
Hermes and Oh My Pi win on **in-process packages and one tool catalog**,
not on a tool-per-HTTP mesh.

Coding is unlocked. First product PRs are **in flight**:
[Q-014 + Q-004](https://github.com/kvnloo/agentweb/pull/2),
[A-002](https://github.com/kvnloo/agentweb/pull/3). Cycle 209:
Kevin asked to reprioritize. Q-001 is Kevin Hermes smoke after #2
(existing runbook). Q-003 waits on Matt before a default flip.
Next architecture after #2+#3 is **A-019** (HTTP 503 POST `/mcp` `tools/call`; GET 405 not 503; `mcpShutdown` after the wait).
Cycle 228: arsenal + Linear PER-1522 + frontier-kb re-rank did **not**
invert that order. Park Q-017. Cycle 229: Linear dump deep-read (issue
bodies + Host-0 map) still does not invert it and does not mint Q-018.
Cycle 230: A-019 `tools/call` 503 is Application 5xx color, not a
`Terminating:Wait` replace. Cycle 231: that 5xx on the dying
instance does not fail the **new** Immutable instance
(`HealthCheckSuccessThreshold` unset; default `Ok` is the temp ASG).
Cycle 232: Sunday `InstanceRefreshEnabled` is **also Immutable**
(AWS weekly, whether or not a platform version exists), not
health-based rolling on one ASG. The L4–6 “rolling” comment is
stale. Dying-instance 5xx cannot fail the new weekly instances.
Cycle 233: Sunday-without-hook still `disableCron`s (IMDS
`Terminated` + SIGTERM `gracefulShutdown`). `Terminating:Wait`
is the park, not the 503.
Cycle 234: Hermes can see that 503 while `/health` stays 200.
Nginx 502 is after `server.close`. 600s DeregistrationDelay
starts at deregister, not `disableCron`.
Cycle 235: that POST `/mcp` 503 is a **one-shot** in this tree.
Q-001 fixture asserts 200. SDK `send()` throws; only 401
recurses. Do not add a 503 retry in A-019.
Cycle 236: 503 does not poison `transport.sessionId`. A later
`tools/call` can rehydrate (ENG-114). Do not 404 drain.
Cycle 237: JSON 503 is enough for SDK `send()`. Content-Type is
only read after `response.ok`. Do not emit SSE 503.
Cycle 238: this tree cannot rewrite that JSON 503. Zero
`error_page` in `.platform`. Do not add one.
Cycle 239: ALB passes Application 503 through. Zero
listener rules. AWS 502 is TCP RST / malformed / target
gone, not a rewrite. Do not add listener rules from A-019.
Cycle 240: A-019 does not pin ALB XFF attributes. AWS
defaults; not an EB option. MCP has zero `req.ip`. That
is ENG-493. Do not add `modify-load-balancer-attributes`.
Cycle 241: that pin, if ever, is `modify-load-balancer-attributes`
on the LB ARN after verify — not A-019, not A-020. Do not
add A-021.
Cycle 242: that LB ARN stays across Immutable and Sunday.
Console XFF drift survives. `IdleTimeout` does not reapply
weekly (ENG-836). Do not un-park A-020 for this.
Cycle 243: a later ENG-493 pin is the only in-tree
reassert of `append`/`false` without recreate. IdleTimeout’s
resource-only PR does not transfer. Recreate is out of
band (DR L103). Do not add that pin from A-019.
Cycle 244: deploy IAM does not list
`ModifyLoadBalancerAttributes`. Grant is live-AWS-only.
Do not treat L61–65 as a grant. Do not treat ENG-823 TG
modify as implying LB modify.
Cycle 245: `DescribeLoadBalancerAttributes` is also unnamed.
ENG-823 TG Describe is used but not in L61–65; LB Describe
is never called. Do not add that pin from A-019.
Cycle 246: an XFF no-op still needs LB Describe on every
opted-in backend SUCCESS. ENG-823 skip is after Describe.
Do not add that pin from A-019.
Cycle 247: a later XFF IAM miss is GitHub-red / prod-green,
not an A-019 503. SUCCESS is logged before the pin. Do not
503 `/health` because the deploy job is red.
Cycle 248: a later XFF pin can fail closed before
`update-environment` (hook slot L655). Copying ENG-823
after-verify is a choice. Do not fold into the hook. Do not
un-park A-020.
Cycle 249: fail-closed-before-apply only helps GitHub
merges. Sunday XFF drift is IdleTimeout class. Do not
un-park A-020 for a weekly XFF pin. Do not add that pin
from A-019.
Cycle 250: a pin-only `schedule:` workflow would be the
git-native Sunday XFF reassert. It does not exist. Do not
add that workflow from A-019.
Cycle 251: a pin-only Sunday job would not hit Must be
Ready (`UpdateEnvironment` only). Do not add that workflow
from A-019.
Cycle 252: during Sunday Updating, XFF must use
`LoadBalancers[*].Name`, not `AutoScalingGroups[0]`. Do not
copy hook discovery. Do not un-park A-020.
Cycle 253: this tree and AWS immutable do not return two
`LoadBalancers[*]` ARNs during Updating. Tests fixture one
ARN. SharedLoadBalancer unused. Do not add a uniqueness
check from A-019.
Cycle 254: if two ARNs appeared, copy ENG-823 pin-all.
Do not fail closed on `count != 1`. Do not take `[0]`.
Cycle 255: do not fork `grep '^arn:'` into an `/app/`
filter from A-019. XFF keys are ALB-only; ENG-823 is not.
Cycle 256: a `net/` XFF modify fails the job. Do not add
skip-non-app from A-019.

---

## Priorities (implementation order, not score)

### Product

| Order | ID | Do this | Do not |
|---|---|---|---|
| 1 | **Q-014** | Drop `internal: true` on MCP `generate_image` (`apiTools.ts` L2077). Test: `mcp.apiTools.test.ts` L91. Metering unchanged. **In flight: [kvnloo#2](https://github.com/kvnloo/agentweb/pull/2).** MCP `ListTools` is `getToolDefinitions()` with no skill gate (`mcpServerCore.ts` L76–83). | Dual-register like `evaluationTools`. Unify Emma vs MCP schema (`confirm`). Add to `DEFAULT_FOUNDATION_TOOLS`. Copy chatbot page-gating. Add to `ANONYMOUS_TOOLS` (A-015). Add `additionalProperties` or initialize `instructions` in this listing PR (Q-017 park, cycle 228). |
| 1b | **Q-004** | Same PR or before: `internal` + `internalOnly` on MCP `post_on_account` only | Edit `emma/tools.ts` (#2832). Unlist `manage_*` (ENG-983). |
| 2 | **Q-001** | Kevin OAuth smoke on `HERMES_MCP_OAUTH.md` (315s PTY) **after #2**, so `tools/list` includes `generate_image`. Parent already refreshes OAuth (`server.ts` L586). | Rewrite the in-repo runbook unless smoke finds a lie. Rewrite it for crush RFC 9207 `iss` (PER-620). |
| 3 | **Q-003** | Fail-open DesignArena → `SUPPORTED_MODELS`. Live: `gpt-image-2` image **#3 / $0.04**, logo **#1**. Hardcoded default `gemini-3-pro-image-preview` is image **#22 / $0.134**, logo **#40**. Mapper does **not** run when caller passed `imageModel` or `logoImage`. | Flip prod default without Matt. Add Riverflow / `gpt-image-2.5` in the first slice. Azure `[0]` would drop logo bytes (cycle 170). |
| hygiene | Q-006 / Q-015 | Hide `edit_landing_page_file` and admin MCP tools | — |
| park | **Q-017** | After #2 + Q-001 smoke: `additionalProperties: false` on advertised MCP roots; optional initialize `instructions` (`mcpServerCore.ts` L58–65). | Add either in kvnloo#2 (A-011). Copy GitNexus `tools/list` fanout (PER-1089). MCP Tasks (PER-1257). Rewrite `HERMES_MCP_OAUTH.md` for RFC 9207 (PER-620). |

None of the first slices needs a Dynamo table.

### Architecture (after or beside Q-014, not instead)

| Order | ID | Do this | Do not |
|---|---|---|---|
| 1 | **A-002** | New `loopsCoreImportGuard.test.ts` on `loops/core` + `loops/index.ts`. **In flight: [kvnloo#3](https://github.com/kvnloo/agentweb/pull/3).** | Append to `sdkConstructionGuard.test.ts` (#2563). Walk `loops/instances/` (`rcaEnricher` imports `agentModeService`). |
| 2 | **A-019** | After #2: HTTP 503 on POST `/mcp` when the body contains `tools/call`; GET `/mcp` **405** (not 503) if draining; wrap CallTool **handler return** in `track('mcpCallTool')` in `mcpServerCore` (covers rehydrate; not only `execute`). `/generate` 503 before `tryClaim`. Leave ListTools / initialize ungated. After the four-way wait: `await mcpShutdown` then `server.close`; **remove** `mcpServer.ts` L269–270 sibling SIGTERM. **Keep** rehydrate `finally close()`. | Drain-gate ListTools or initialize. 503 GET `/mcp` (SDK throws `StreamableHTTPError`). Return CallTool `isError` for drain. Refuse inside `track()`. Make `tryClaim` return false (409 `SESSION_BUSY`). Wrap `registry.execute`. Wrap execute only (cycle 218: drain can empty before Protocol `send()`). Expect `mcpServerCore` `isError` for a post-close `send()` throw (Protocol `_onerror` only). Treat ENG-97 404 as covering an in-flight CallTool whose POST already returned 200 SSE (cycle 219: POST `_handleSseStream(..., false)`; no `eventStore`). Copy `mcpClientService` 3600000 onto inbound CallTool (cycle 220: 60s is client `Protocol.request()`; AgentWeb handler has none). 503 `notifications/cancelled` (cycle 221: new POST; copy `method === 'tools/call'`). Treat skip-send as `stream.cleanup()` (cycle 222: POST SSE stays mapped until `mcpShutdown` `close()`). Await `server.close` to join skip-send POST (cycle 223: same ASG `CompleteLifecycleAction` cut as GET). Put `process.exit` on the ASG path (cycle 224: would strand `Terminating:Wait`). Replace Sunday `process.exit(0)` with `exitCode` in A-019 (cycle 224: Sunday lifetime is A-020 / cycle 115; Sunday exit can cut Hono `end()` I/O). Await `completeAction` from `gracefulShutdown` (cycle 225: settled `drainPromise` then `process.exit(0)` can cut CONTINUE; HeartbeatTimeout 900s is the fail-safe). Treat `asgLifecycleGuard.ts` L18–19 as a pin that SIGTERM is withheld for the whole `Terminating:Wait` (cycle 226: comment, not a test; deploy / health-check restart still SIGTERM). Add `TimeoutStopSec` / `KillMode` from A-019 (cycle 116: unit name live-AWS-only). Treat `IgnoreHealthCheck: false` as a runtime restart that SIGTERMs `Terminating:Wait` (cycle 227: deploy command; after close, `/health` 502 is a side effect). 503 `/health` during the wait (cycle 108 / ENG-1189). Add `HealthCheckPath` from A-019. Call `mcpShutdown` during the wait (closes the shared transport; does **not** cancel `generate_image` — cycle 217). Leave sibling `process.on` (Sunday SIGTERM closes first). Await `server.close` to finish GET (Hono `writable.end` after `controller.close`). Set `enableJsonResponse` on the live transport. `sessions.set` a rehydrate transport (JSON `close()` hangs `handleRequest`). Drop rehydrate `finally close()` (cycle 216: leftover `_streamMapping`; after `resolveJson` it cannot hang). Treat `mcpShutdown` as `generate_image` cancel (cycle 217: `_onclose` does not abort; handler ignores `extra`). Treat omitted `ApplicationRequests5xx` as disabled (cycle 230: 4xx is the only ConfigDocument switch; 503 is color, not Wait replace). Set `HealthCheckType: ELB` from A-019 (after close, `/health` 502 would be ASG unhealthy). Set `HealthCheckSuccessThreshold` from A-019 (cycle 231: default `Ok` is the **new** Immutable instance bar, not the dying row). Treat Sunday `InstanceRefreshEnabled` as health-based rolling on one ASG (cycle 232: AWS weekly immutable; `05-instance-recycling.config` L4–6 comment is stale). Disable `InstanceRefreshEnabled`. Treat missing `Terminating:Wait` as “A-019 never 503s” (cycle 233: IMDS `Terminated` and SIGTERM `gracefulShutdown` both `disableCron`; Wait is the park). 503 `/health` so ALB drains faster (cycle 234: would replace Node 503 with ALB/nginx 502). Treat DeregistrationDelay 600s as a Sunday-without-hook drain budget. Add an inbound 503 retry / `Retry-After` in A-019 (cycle 235: Q-001 fixture asserts 200; SDK `send()` throws `StreamableHTTPError`; `mcpClientService` retries browser tools only). Copy `3600000` onto inbound CallTool. 404 drain `tools/call` hoping for ENG-97 auto-reinit (cycle 236: `send()` keeps `sessionId`; 503 is not the 404 face). `sessions.clear()` / `sessionStore.delete` on the 503 path. Emit `text/event-stream` on drain 503 (cycle 237: `send()` only reads Content-Type after `ok`; SSE 503 still throws `StreamableHTTPError(503)`). Add `Retry-After`. Add `error_page` / `proxy_intercept_errors` from A-019 (cycle 238: would replace Node JSON 503 with nginx HTML; cycle 107 already: this tree never remaps nginx statuses). Treat ALB as rewriting Application 503 to 502 (cycle 239: ALB forwards target HTTP errors; AWS 502 is TCP RST / malformed / target gone). Add `aws:elbv2:listener` / `fixed-response` from A-019. Pin `routing.http.xff_header_processing.mode` / `xff_client_port.enabled` from A-019 (cycle 240: AWS defaults; not an EB option; MCP has zero `req.ip`; ENG-493). Add `modify-load-balancer-attributes` from A-019. Fold an ENG-493 XFF pin into A-020’s second `put-lifecycle-hook` (cycle 241: LB ARN sibling of `ensure_deregistration_delay`, not a lifecycle hook). Copy `ensure_deregistration_delay`’s target-group loop for XFF. Treat `timeout.config` `IdleTimeout` as reapplied on every Immutable or Sunday (cycle 242: ALB ARN stays; IdleTimeout is resource config and cannot ride instance Immutable — ENG-836). Un-park A-020 to re-pin XFF. Treat a resource-only IdleTimeout PR as also pinning XFF (cycle 243: IdleTimeout is the only `aws:elbv2:loadbalancer` behavior knob; XFF is not an EB option; recreate is out of band). Add `commands:` AWS CLI, `.platform/hooks`, or CFN `AWS::ElasticLoadBalancingV2::LoadBalancer` from A-019. Treat environment recreate as an in-tree pin. Treat `eb-deploy.sh` L61–65 as granting `ModifyLoadBalancerAttributes` (cycle 244: probe Describe* comment; live-AWS-only; TG modify does not imply LB modify). Treat L61–65 as listing `DescribeLoadBalancerAttributes` (cycle 245: also unnamed; ENG-823 TG Describe is used without being listed; LB Describe is never called). Treat an already-`append`/`false` ALB as skipping LB Describe (cycle 246: ENG-823 skip is after a successful Describe; already-600s still Describes). Set an XFF opt-in on partner-deploy. Treat a later XFF pin IAM miss as an A-019 503 (cycle 247: GitHub-red / prod-green; version already Ready; no abort). 503 `/health` because the deploy job is red. Treat copying ENG-823’s after-verify slot as required for XFF (cycle 248: ALB ARN exists before apply; that copy is what makes IAM miss prod-green). Fold an XFF pin into `ensure_termination_lifecycle_hook`. Un-park A-020 to hold a pre-update XFF pin. Treat fail-closed-before-apply as a weekly XFF reassert (cycle 249: Sunday never runs `eb-deploy.sh`; deploy.yml has zero `schedule:`). Un-park A-020 for Sunday XFF drift. Disable `InstanceRefreshEnabled` from A-019. Add a GitHub Actions `schedule:` XFF pin from A-019 (cycle 250: git-native Sunday reassert does not exist; Dependabot Monday `schedule:` is not an ALB pin). Add EventBridge / Lambda `Resources:` from A-019. Treat Sun:10:00 Must be Ready as blocking a pin-only elbv2 call (cycle 251: that error is `UpdateEnvironment`; `describe-environment-resources` has no Status gate). Copy `wait_for_environment_ready` into drain. Copy `AutoScalingGroups[0]` discovery for XFF (cycle 252: Sunday Updating has two ASGs, one ALB). Un-park A-020 to become a Sunday XFF pin. Treat `LoadBalancers[*]` as returning two ARNs during Updating (cycle 253: this tree and AWS immutable show one environment balancer; tests fixture one ARN; SharedLoadBalancer unused; classic names filtered). Add a uniqueness check or that pin from A-019. Fail closed on `LoadBalancers` `count != 1` (cycle 254: uniqueness would be new; ENG-823 pin-all is the existing shape; `[0]` is the cycle 252 ASG footgun). Add a `loadbalancer/app/` grep from A-019 (cycle 255: would fork XFF from ENG-823’s `^arn:`; this tree never emits `net/` / `gwy/`). Add skip-non-app `continue` on `net/` (cycle 256: fail-the-job is the ENG-823 copy; `fail()` exits 1 and never reaches later ARNs). Edit `slack.ts` (#2393). |
| 3 | **A-007** | `mcp/server/tools/infrastructure.ts` copying `workflowTools.ts` (wait for #2) | Copy `evaluationTools.ts`. First file is **not** `content.ts`. Edit `emma/tools.ts`. |
| 4 | **A-008** | `git mv` `imageGeneration.ts` → `services/creative/` + path shim. Persist unification after the pile shrinks. | HTTP-split the leaf. Patch occupied `app.ts` / `emma/tools.ts` / `agentModeService.ts`. |

**Discarded:** A-006 (HTTP nanoservice per tool). **Parked:** A-013 — do not start at Slack (`AgentWebPro#2393` owns `conversation/channelPort`). **A-017** — stop CRM/worker importing `server.ts`; expand `sessionSockets` emit (not `crm.ts`, not LoopPorts). **A-018** — copy file-config `isInternal` skip onto Dynamo `mcp_servers` (not a fifth `listen()`). **A-020** — second `put-lifecycle-hook` after Immutable verify (surviving ASG; do not `.ebextensions`). **A-011** — do not unify MCP vs Emma `generate_image` schemas in Q-014. **Q-016** — MCP video after Q-014; 40× cost. **Q-017** — MCP initialize `instructions` + `additionalProperties:false` after #2 and Q-001 smoke (cycle 228; PER-868 / PER-1074).

### If we only do one thing

| Constraint | Do this |
|---|---|
| One product thing | **Q-014** — land [kvnloo#2](https://github.com/kvnloo/agentweb/pull/2) |
| One Kevin-unique thing after #2 | **Q-001** smoke so `tools/list` includes `generate_image` |
| One architecture thing after #2 and #3 | **A-019** HTTP 503 POST `/mcp` `tools/call`; GET 405 not 503; `mcpShutdown` after wait |

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
fire-and-forget and drops `no_user` (cycle 51). Cycle 53: MCP
`generate_image` uses `ctx()` and cannot take the ENG-1596
`overrideToken` skip; chatbot/ishare `$2` is a different face.
Cycle 54: A-007 copies `workflowTools` **shape**, not its
`adminClientScope` import. OMP 0.85.1 still keeps images in `pi-ai`.
Cycle 55: remotion-lambda is the isolate; `imageGeneration.ts` is already
the host adapter (vendor HTTP). Do not copy the Lambda process onto images.
Cycle 56: MCP client/server folders are already acyclic (OMP DAG). Park
A-016 until A-002. Do not HTTP-split them. Cycle 57: **#2271** owns
`app.ts` route table; A-007 still attaches at `mcpServerCore` not `app.ts`.
Never compete with #2271 / #2862 / #2861.
Cycle 58: `server.ts` drain (ENG-1189) proves mcpFetch is loopback to this
`listen()`. A fifth image process would need a copy of that drain.
Cycle 59: `app.ts` → `crm.ts` L24 → `server.ts` already cycles. `registerIo`
exists; `MinimalIo` is password-change `fetchSockets` only, so worker
L184 and `crmEnrichmentService` L67 still `require('../server')`. Park
A-017 (expand emit; do not HTTP-split CRM; do not edit 7,815-line
`crm.ts` while #1790 is open). Cycle 60: that expand is
`getFathomLinearPort`, not `LoopPorts`. `chatSocketHandler.ts` L17–20
already extracted the right direction (`server.ts` L18 imports the
handler). Cycle 62: the only `socket.join` is `server.ts` L186
(`user:${userId}`). CRM emits to `socket.id`; codingAgent L1828 emits
`sessionId` with no join. A-017 is a passthrough, not a room enum.
Cycle 63: `gtmPlan.ts` L12–13 already documents dynamic
`import('../server')` to dodge the static cycle; L1495 still loads
the listen module. Same at admin L4749, durableLanding L237, and
**seven** `agentModeController` sites (`session-message-appended` to
`user:`). Partner-portal `GTMPlans.tsx` L292–300 listens with no
client join — server L186 is enough. A-017 first slice stays the two
`require`s, not the 15k controller. Cycle 64: Agent Mode progress is
**SSE** (`sseProgress.ts` L43, controller L8282–8284 / L7791), not
Socket.IO. Worker IPC already has two types (`progress` vs
`socketEmit`). `RunEmitter` (`streamEvents.ts`) typed sink is empty
(`agentModeService.ts` L3449); only `emitLegacy` runs. Do not absorb
SSE into A-017. Do not HTTP-split either bus. Cycle 65: those SSE
Maps are parent-instance-local (`sseProgress.ts` L10–14;
`instanceState.ts` L10–11 same shape). Child worker never imports
them; parent `clearTerminalProgress` L322 on worker death. Chatbot
is `chatSocketHandler.ts` L94 `socket.emit('message')` — a third
fanout, still this process. MCP `text/event-stream` Accept
(`mcpSessionRehydration.ts` L40) is Streamable HTTP, not Agent Mode
progress. Cycle 66: concurrency is the same shape.
`keyedMutex.ts` L12–15 states different processes never write the
same session; `tryClaimSessionGeneration` L936–956 is an in-memory
Set. Do not extract `generateImage` out from under that claim.
Cycle 67: that claim is **per-instance**. MCP ENG-114 already
handles “no sticky routing” by Dynamo metadata + in-process
rehydrate (`mcpSessionRehydration.ts` L3–8 / `mcpSessionStore.ts`
L7–19). Do not HTTP-split images to copy that. Do not copy the
MCP session table onto generate locks (Harsha). Cycle 68: even
that in-process work is killed on deploy unless `asgLifecycleGuard`
parks the ASG (`asgLifecycleGuard.ts` L4–16 / `server.ts` L572–574).
A fifth image process would need its own hook + `eb-deploy.sh`
install (ENG-818: not `.ebextensions`). Cycle 69: even on this
process, inbound MCP `CallTool` is not in the four-way wait list
(`server.ts` L397–420 vs `mcpServerCore.ts` L88–120). Q-014
`generate_image` mcpFetchs localhost; chatbot was wrapped
(`chatbotTurn`); MCP was not. Do not HTTP-split to “fix” drain.
Cycle 70: local `/mcp` reuse vs ENG-114 rehydrate are two faces of
the same untracked `CallTool`. Wrap `mcpServerCore`, not a fifth
process. Cycle 71: that wrap set is empty on AgentWebPro (20 PRs).
Do not compete on `emma/tools.ts` / `app.ts` / `crm.ts`.
Cycle 72: GET `/mcp` keep-alive SSE (`mcpServer.ts` L508–531) is
why `mcpShutdown` follows the wait. Rehydrate has no SSE. Do not
HTTP-split the stream.
Cycle 73: even after that order, `server.close()` is not joined
(`server.ts` L440–446). The ASG hook (`asgLifecycleGuard.ts`
L262–273) treats drain resolve as “instance may terminate.” Do not
HTTP-split to get a second close() to forget to await.
Cycle 74: the existing fork is protected by
`workerShutdownGuards.ts` (ignore SIGTERM, parent SIGKILL,
ENG-201). A fifth image process would receive the cgroup SIGTERM
and die — the failure that file exists to prevent. Q-014 is
parent MCP, not the worker.
Cycle 75: `RecordLifecycleActionHeartbeat` is IAM-only
(`asgLifecycleGuard.ts` L26). The 900s ASG hook and EB rolling
`Timeout: 900` (`.ebextensions/rolling.config` L5–7) are stacked
above a 10 min drain ceiling. A fifth process is in none of those
clocks.
Cycle 76: GET `/mcp` is the global nginx 600s path
(`.platform/nginx/conf.d/agent-mode-timeout.conf` L5–7), not
`/socket.io/` 3600s. ALB IdleTimeout 600. DeregistrationDelay is
the deploy script (ENG-823), same pattern as the ASG hook.
Cycle 77: Q-014’s inner mcpFetch aborts at 5 min
(`httpClient.ts` L205) unless `timeoutMs` is set. `generate_image`
does not set it. Do not HTTP-split to get a longer clock; v0
already overrides `timeoutMs` on this hop.
Cycle 78: the leaf allows 8 min (`imageGeneration.ts` L69–79
ENG-510) so a hung provider leaves 2 min under the 10 min turn.
MCP’s 5 min abort is stricter than that leaf. Align `timeoutMs`
on mcpFetch after listing; do not extract a process to get the
8 min.
Cycle 79: that 5 min abort does not cancel `generateImage`
(`emmaApi.ts` L174–187) and does not skip the leaf meter
(L546–562). Do not HTTP-split to get a cancel protocol; do not
touch billing.
Cycle 80: that orphan leaf is also **unclaimed**.
`tryClaimSessionGeneration` is Agent Mode only. MCP generate_image
has quota (`requireEmmaTokenBudget`), not the session Set.
Q-014 lists the tool; it does not add a lock. Do not HTTP-split
to get one.
Cycle 81: that quota is **check-then-act**.
`requireEmmaTokenBudget` GETs `checkTokenUsage` then `next()`.
`meterUserUsage` is `void` after vendor success; ADD conditions
on month, not remaining allowance. `spendChargingService`
reservation exists; admission is Harsha and unused here. Two
parallel Hermes `CallTool`s can both pass. A fifth process
copies the GET. Do not wire a reservation onto Q-014.
Cycle 82: that GET is the **token** dimension by default.
The leaf meters `$` with 0 tokens (`imageGeneration.ts` L551–563).
`ENFORCE_COST_CAP` is observe-only unless flipped or a versioned
policy enforces cost. `spendChargingService` has zero production
callers. Q-014 still lists into `metered` middleware; do not flip
billing to “fix” A-006.
Cycle 83: the MCP server does not serialize `CallTool`. SDK
Streamable HTTP mints a `streamId` per POST; OAuth 60/min is a
count window; ENG-114 rehydrate is one transport per in-flight
request. Hermes’ loop is the concurrency bound. Do not HTTP-split
to get a lock.
Cycle 84: `checkExtraCostUsage` has zero production callers.
Images do not write `extraCostUsage` (CRM enrichment does).
Do not wire that dead API onto Q-014.
Cycle 85: omitting MCP `image_model` hits leaf default
`gemini-3-pro-image-preview` at **$0.134**. `gpt-image-2` is
$0.04 (Q-003). Cost caps are Dynamo; in-repo Free fallback is
unlimited. Do not HTTP-split the price book.
Cycle 86: `generate_video` uses the same `$` / 0-token meter
(`videoGeneration.ts` L1098–1106) and is **not** on MCP. Q-016
is list-like-Q-014 at 12–39× image price. Do not delay Q-014.
Cycle 87: AgentWebPro (20 PRs) still empty on `apiTools.ts`,
`loops/core`, and the cycle 81–86 meter files. `#2875` is
cron. `#2862` still `toolErrorClassifier.ts`. Land Q-014 on
the empty file; do not HTTP-split to dodge collision.
Cycle 88: Oh My Pi still **0.85.1**. They unpublished 0.85.0’s
experimental client/server. Images stay in `pi-ai`. Cutting-edge
is in-process packages; MCP is AgentWeb’s *external* bus (Q-014).
Cycle 89: Hermes `mcp_tool.py` is still a **client**. Parallel
`CallTool` is `supports_parallel_tool_calls` (default false).
The Emma OAuth runbook does not set it. Q-014 lists; do not add
a server mutex; do not rewrite Q-001.
Cycle 90: self `"agentweb-tools"` skip is **file-config only**
(`mcpClientService.ts` L420–432). Dynamo `mcp_servers` has no
`isInternal` filter; admin localhost URLs connect. Park A-018;
do not HTTP-split; do not delay Q-014.
Cycle 91: live MCP face is **`/mcp`** (`mcpServer.ts` L298).
`package.json` `mcp:inspector` and `AGENT_API.md` L129 still say
`/mcp/server`. Q-001 runbook already uses `/mcp`. Do not rewrite it.
Cycle 92: that inspector is **SSE**. Live initialize is POST
`/mcp` Streamable HTTP. GET `/mcp` without `mcp-session-id` is
400 (`mcpServer.ts` L512–515). Do not HTTP-split to fix `npm run mcp:inspector`.
Cycle 93: `mcpShutdown` is still unused by `runDrain`, but SIGTERM
closes inbound MCP **first** (`mcpServer.ts` L269–270 registered
via `app.ts` L204). Wrap CallTool after #2; then call `mcpShutdown`
after the wait. Do not treat GET SSE as dead — Hermes can open it.
Cycle 94: `mcpShutdown` / stale cleanup never `sessionStore.delete`.
Only client `DELETE /mcp` evicts the ENG-114 mirror. Dynamo
sessions rehydrate on the next instance. Do not HTTP-split that
metadata; do not delete it on drain.
Cycle 95: this tree never sets `MCP_SESSION_STORE` (zero hits in
`.env.example`, `.ebextensions/`, `.github/`). Default is memory.
Do not treat Dynamo rehydrate as a production fact from git.
Cycle 96: `DeploymentPolicy: Immutable` and weekly instance refresh
already overlap two backends (`asgLifecycleGuard.ts` L4–9).
`socialPosts.ts` MinSize=MaxSize=1 is not in this tree. Hermes
404-reinits across that window (cycle 95 memory default).
Cycle 97: drain 503s only `POST /run-scheduled-chats`
(`agentModeController.ts` L13032). `/health` stays 200 (`app.ts`
L551–553). `backend/src/mcp/` has zero `isCronEnabled`. The new
instance is already serving (`IgnoreHealthCheck: false`) when
unawaited `server.close` runs on the old one.
Cycle 98: `cronJobRegistry.drain()` is a live `while (size > 0)`
(`cronJobRegistry.ts` L68). `track()` has no `draining` flag.
The worker already refuses new `runInWorker` (L443). Wrap
CallTool after #2 must copy that pair, or Hermes POSTs during
overlap hold the 10 min ceiling.
Cycle 99: that wrap already exists for Emma chat.
`cronJobRegistry.track('chatbotTurn', …)` (`server.ts` L301) has
no `isCronEnabled`. `io.close` is after the four-way wait.
`/socket.io/` is 3600s. Do not HTTP-split to get a draining flag.
Cycle 100: Slack and Resend **ack HTTP 200** then `track()`
(`slack.ts` L468 then L249; `webhooks.ts` L348 then
`emmaEmailAgentTurn`). Park **A-019**: refuse new `track()` while
draining. Do not edit `slack.ts` (#2393). Do not HTTP-split Slack.
Cycle 101: `POST /generate` never `track()`s (`generateResponse`
L8817). It `tryClaimSessionGeneration`s (L9016). A-019’s first
slice is one `instanceState` bit on **both** `track()` and
`tryClaim`, not a `/generate` HTTP service.
Cycle 102: auto-continuation `setImmediate`s after that lock
releases (L9406–9409) and `tryClaim`s again (L1350). The live
Set goes 1→0→1. `disableCron` does not cancel `setImmediate`.
Do not HTTP-split `generate_image` to isolate this scheduler.
Cycle 103: listed MCP `emma_get_session` (`apiTools.ts` L274–288,
not `internal`) mcpFetchs `GET /session/:id`. The handler
comment says “passive READ” then `setImmediate`s a continuation.
Hermes polling during overlap starts billed generation on this
PORT. Do not hide the tool; A-019 `tryClaim` refuse is the gate.
Cycle 104: listed `emma_send_message` (`apiTools.ts` L213–216)
mcpFetchs POST `/generate` with **no** `timeoutMs` (5 min
default). Inner `/generate` **does** cancel on `req.close`
(L9094–9104). Q-014 `generate_image` mcpFetch does not cancel the
leaf. Do not HTTP-split either hop.
Cycle 105: that POST is **not** retried on `fetch failed`
(`httpClient.ts` L116–118; `mcp.httpClient.test.ts` L163–176).
GET `emma_get_session` retries 3× into `server.close` and still
fails (L411–413). Hermes already on the new instance never sees
the old session’s `isError`. Do not add POST retry (duplicate
risk). Do not HTTP-split the hop.
Cycle 106: inbound `/mcp` and loopback mcpFetch are **different
sockets**. `closeIdleConnections` is typed (`http.d.ts` L420–425)
and unused. Hermes hits nginx; mcpFetch is `localhost:${PORT}`
and bypasses nginx. GET `/mcp` SSE is not idle. Do not add a
close API from this cycle; A-019 refuse at `disableCron` is the
gate. Do not HTTP-split `/mcp`.
Cycle 107: after close, new Hermes `/mcp` is nginx **502 now**,
not a 600s 504. `proxy_connect_timeout 600s` does not wait on
refused listen. SSE already connected still 504s at
`proxy_read_timeout`. Classifier: 502 `upstream_5xx`, 504
`timeout`, loopback `network`. Do not add `error_page`. Do not
HTTP-split to unify the three.
Cycle 108: ALB health **cannot** stop Hermes during drain. Zero
`HealthCheckPath` in git. `/health` stays 200 until close because
mcpFetch needs the listen (ENG-1189). Hook
`CompleteLifecycleAction` then deregisters (600s). Do not 503
`/health` during the wait. A-019 refuse is the gate.
Cycle 109: `underlying_health_verdict` (`eb-deploy.sh` L270–375)
is **deploy-verify**, not drain. Zero `backend/src` callers.
`LAGGING` is stale Red after the old instance is already gone.
Do not call it from `runDrain`. Do not HTTP-split to host it.
Cycle 110: weekly refresh (`05-instance-recycling.config` L8–13,
`Sun:10:00`) overlaps **without** `eb-deploy.sh`. GitHub Actions
does not start it (`deploy.yml` L199–204). Cycle 232: that
overlap is **Immutable** (AWS), not rolling; L4–6 comment is
stale. No ENG-878 probe. A-019’s window is weekly. Do not disable
`InstanceRefreshEnabled`.
Cycle 111: Sunday recycle and Immutable **do not stack** a third
`listen()`. `update-environment` Must be Ready (`eb-deploy.sh`
L668–680). Wait 1200s then fail. ENG-1127 is a 31s ASG join abort,
not a third fleet. Do not HTTP-split to survive a stack this tree
already refuses.
Cycle 112: 3×1200s settle is **not** a wait. Never-Ready
`fail()`s attempt 1 (`eb-deploy.sh` L639–640 / L155–158). The
2700s total budget caps retries (`deploy.yml` L187; test
L518–534). Recycle overlap continues without CI adding a listen().
Cycle 113: last deploy’s hook dies with the Immutable ASG.
`put-lifecycle-hook` is before `update-environment` (test
L1066–1091 exactly one). After swap the serving group is unhooked.
Sunday `InstanceRefreshEnabled` never calls `eb-deploy.sh`. Park
**A-020** (second put after verify). Do not restore `.ebextensions`
hook (ENG-818).
Cycle 114: guard still drains without a hook; ASG does not wait.
Two IMDS `Terminated` reads then `disableCron`. 3m19s is overlap,
not park. A-019 fires only if drain starts.
Cycle 115: Sunday SIGTERM is OS/cgroup (ENG-201), not the hook.
`.platform` is nginx. The 900s `rolling.config` Timeout is
Immutable deploys, not `InstanceRefreshEnabled`. Only
`TimeoutStopSec` in git is agent-engine 30s.
Cycle 116: `06-log-retention.config` names `systemd-journald`,
not the Node unit. `web.stdout.log` is a log file. Sunday
stop-timeout is live-AWS-only. Do not copy agent-engine 30s.
Cycle 117: `runDrain` never stops nginx (`server.ts` L404–440).
`nginx.service` is named in `dev.md` L1934; `websocket.conf` L6
hardcodes `127.0.0.1:8080`. mcpFetch skips nginx. Sunday
nginx-vs-Node stop order is live-AWS-only.
Cycle 118: `PORT=8080` is **not** in git. `.env.example` L1 is
`PORT=3001`. Tests pin mcpFetch to 3001. Only git `proxy_pass` is
`/socket.io/`. Hermes `/mcp` is unvendored platform nginx.conf.
Cycle 119: **cannot name** that file. `app.ts` L152–155 says the
general proxy location is not in this repo. No
`.platform/nginx/nginx.conf`. AWS docs (`dev.md` L6235) default
upstream is **5000**, a third number. Hermes `/mcp` filename and
port are live-AWS-only.
Cycle 120: git **never chooses** among 3001 / 8080 / 5000. Zero
`application:environment` in `.ebextensions`. That namespace is
test fixtures only (`eb-config-conflict.test.sh` L304).
`websocket.conf` hardcodes 8080 and does not read `$PORT`.
Cycle 121: a `/mcp` location is **instance-only**. ENG-836 allows
it alone (test L188–192) and forbids it next to `timeout.config`
(L124–130). `eb-deploy.sh` is not classified. Do not add A-021.
Cycle 122: **detect-changes skips drafts** (`tests.yml` L18).
The conflict job never runs on a draft `/mcp` PR. A pass still
refuses deployability (test L200–201).
Cycle 123: **re-draft is `NO_EVIDENCE`** (`merge-evidence.sh`
L264). Missing `converted_to_draft` does not let a `/mcp` PR
merge. `gh pr checks` can still look green (L14–25).
Cycle 124: **ENG-836 skip is not draft.** Discriminator is
`Detect changed projects` with no path filter (test L1426–1433).
`BACKEND_JOBS` is only `Backend build` (script L160). Conflict
job timeout/cancel is outside the evidence set (L586–591).
Cycle 125: **5-minute string is the #2491 receipt.** Live
`timeout-minutes: 12` (`tests.yml` L248). Hung ENG-836 is
`cancelled` (test L860–877 PASS). Failure still blocks.
Cycle 126: **in-flight ENG-836 is PENDING** (script L726).
Separate concurrency groups; Backend cannot keep ENG-836 in
the evidence set. Required context is only `Detect changed
projects` (script L871).
Cycle 127: **ENG-1373 is still an unlanded comment**
(`merge-evidence.sh` L875, `dev.md` L157). Nothing in git adds
`Backend build` or ENG-836 to GitHub required contexts.
`BACKEND_JOBS` is script-local (L160). Dependabot yml L20 is
also a comment. Auto-merge waits on the required set only
(`tasks/lessons.md` L237).
Cycle 128: **merge-evidence labels Dependabot skip as a
path-filter skip.** The #2491 fixture includes
`Dependabot Integrity Check` `skipped` (test L437, different
check_suite) and PASSes (L452). L974 cannot tell that job-level
`if` from a path-filter skip.
Cycle 129: **GitHub treats a job-level `if` skip as Success.**
Dependabot’s “REQUIRED” comment, if true, only bites on
Dependabot PRs. Workflow-level skip stays Pending and blocks.
Docs vs API: skipped reports Success for merge; API conclusion
is still `skipped`.
Cycle 130: **naming `Backend build` as required cannot
reproduce merge-evidence section 7.** Every `tests.yml` job
except Detect changed projects is a job-level path skip
(L70). GitHub required checks are names, not path-conditional.
Cycle 131: **no `PARTNER_JOBS`.** Test L1047: partner-only diff
PASSes with Partner skipped. Fixtures still say `Partner portal
tests`; live job is `Partner portal build` (`tests.yml` L92).
Failure still FAILs (`n_bad`). Skip/cancel does not.
Cycle 132: **no `WORKFLOW_JOBS`.** Test L1196–1198: editing
`merge-evidence.sh` PASSes with `CI script tests` skipped.
That job runs `merge-evidence.test.sh` (`tests.yml` L142).
Name-exists invariant does not list it (test L1498).
Cycle 133: **ENG-1377 relay and remotion builds are unnamed**
in merge-evidence. Zero mentions of those jobs or paths in
the gate or its tests. Not in `NON_BACKEND`. Failure still
FAILs (`n_bad`). Skip/cancel does not.
Cycle 134: **a `tests.yml` PR schedules six jobs;
merge-evidence requires `Backend build` only.** `tests.yml`
is in backend / workflows / relay / remotion / ebconfig
filters. Cancelled relay is the same cancelled PASS as ENG-836.
Cycle 135: **agent-engine is a deploy unit with no GitHub
build job.** Grep of `.github/workflows/` is empty. Test L1199
PASSes `agent-engine/web_agent.py` as `NON_BACKEND`. Remotion
got ENG-1377; the Python worker did not.
Cycle 136: **customer-portal is a fifth repo (gitignored).**
`.gitignore` L121–124. No directory in this tree. `tests.yml`
/ `deploy.yml` grep empty. Test L1044–1047 path is synthetic.
CLAUDE.md L155 (“in this repo”) is stale vs L894.
Cycle 137: **the other repo’s IA is a typed list in this
backend.** `customerPortalPages.ts` L28–124;
`GET /customer-portal-pages` (`subscription.ts` L322–325).
Policy is the constant; HTTP is the other origin. Not A-006.
Cycle 138: **`growth-chat/` is a sixth origin; `callLLM` stays
here.** Gitignored L122; Actions grep empty. README L2214
points at `growth-genius-chat`. `growthGeniusService.ts` L1 /
L85 imports `agentModeService.callLLM`.
Cycle 139: **Growth Genius is a fifth in-process catalog.**
Inline `search_knowledge_base` (`growthGeniusService.ts`
L129–150) executes Emma’s `searchPlatformKnowledgeBase`
(`chatbotService.ts` L4711). Two god-objects, one turn, no HTTP.
Cycle 140: **the KB helper is a leaf; the file cycles.**
Function L4711–4867 is Vertex-only. `chatbotService.ts` L24
imports `AgentModeService`; `agentModeService.ts` L26 imports
the leaf from that file. A-002 does not cover this.
Cycle 141: **ENG-1057 already named three KB faces.** Test
header L1–10; callers L5106 / L24059 / L71. Cap at the
source after a 2026-08-10 single-instance crash. Same lesson
as `generate_image`.
Cycle 142: **those faces do not share source sets.** Agent
Mode L24072 / L24141 / L24181 walks Drive + ClickUp after the
Vertex leaf. Emma RAG is Vertex + local chunks (L5093 /
L5106). Growth Genius is Vertex-only (L71). Emma’s *tool*
(`emma/tools.ts` L5593) is the Agent Mode superset. HTTP-split
the leaf would not equalize Drive.
Cycle 143: **listed MCP `search_knowledge_base` already hops
to that superset.** `apiTools.ts` L1264–1284 has no
`internal: true`; `emmaApi.ts` L98–101 calls Agent Mode.
Sibling `generate_image` is still hidden (L2077). Test L78
vs L91. Q-014 is listing, not a new hop.
Cycle 144: **Agent Mode still recaps Vertex.** Leaf already
caps at `chatbotService.ts` L4800–4804 / L4852. Face L24065
plus test L321–334 mock the leaf to 6000 chars. L24062
“never capped” is stale. Drive/ClickUp caps stay on the
face (cycle 142). Not a fifth hop.
Cycle 145: **three `searchKnowledgeBase` symbols.** Emma
export L4674 is Azure embeddings over in-memory docs
(`findRelevantChunks` L515). Agent Mode L24032 is the
superset. Growth Genius L66 is Vertex-only and requires
`reason` on the inline tool. Hermes: one name, one handler.
Cycle 146: **three JSON schemas for that name.** GG L147
requires `query`+`reason`. Emma L5590 and MCP L1275 require
`query` only and have `max_results`. A-011 already parks
this pattern for `generate_image`. Do not add A-021.
Cycle 147: **GG `reason` never reaches the leaf.** L174 logs
it; L177 calls `searchKnowledgeBase(query, userId)` only.
Tool result L188–192 omits it. Unifying that field away is a
no-op on Vertex, unlike `confirm` on `generate_image` (A-011).
Cycle 148: **cardinality is per-face.** GG L71 and Emma RAG
L5106 hardcode **10**. Emma tool L5594 and MCP L1281 default
**5**, then Agent Mode `Math.min(..., 10)` (L24050). Emma
disagrees with itself. Not a leaf port.
Cycle 149: **per-source collect, then slice.** L24230–24233
is the receipt. Vertex is first in `results`; Drive tree
walk and ClickUp reads still run; `slice(0, N)` can drop
them. Listed MCP hops here (cycle 143). Not a fifth hop.
Cycle 150: **no short-circuit after Vertex.** L24070 → L24073
`if (userId)` Drive with no cap check. ClickUp L24142 /
L24182 same. Only `results.length === 0` (L24216). Listed
MCP always fans out the superset.
Cycle 151: **ClickUp docs “search” is list-all then
`includes()`.** `clickupService.ts` L103–119 paginates every
doc (no query). L24156 reads each doc’s pages until N
matches. Drive L24092 is `fullText contains`. Listed MCP hops
here. Not a fifth hop.
Cycle 152: **`listTasks` enriches attachments; search ignores
them.** `clickupService.ts` L219–258 `getTask`s in batches
of 10. Search L24194–24196 uses name+description only. List
tool L24887 uses `attachmentCount`. One adapter, two
contracts. Not a fifth hop.
Cycle 153: **`readDocContent` runs before `includes()`.**
L24155 computes `nameMatch`; L24156 always fetches pages
(`clickupService.ts` L137–165). Name miss still pays the
page tree. Drive reads hits only (L24104–24109).
Cycle 154: **Drive has count+time bounds; ClickUp does not.**
ENG-1624 `DRIVE_LIST_WALK_MAX_MS = 90_000` (L23581) and
`perBatchTarget` (L23879). `clickupService.ts` grep
TIMEOUT/MAX_MS/deadline is empty. Copy the bound shape
in-process.
Cycle 155: **ClickUp docs walk sequentially; Drive trees
do not.** Drive L24080 `Promise.all` across registered
roots, then one `fullText` query. ClickUp L24148 nested
`for`/`await` (workspace, then every doc, then every
page). Do not wrap ClickUp in unbounded `Promise.all`.
Cycle 156: **Search reads are uncapped; other faces are
not.** `readGoogleDriveFileContent` L25194 downloads
the whole file. Materialize refuses at 200MB (`L25626`).
Named-read truncates to 1M after fetch. Search then keeps
5000 chars (`L24113` / `L24161`). Copy the materialize
shape onto the search helper in-process.
Cycle 157: **Search Drive query omits `size`.** L24093
`files(id, name, mimeType, parents)`. Listing L24690,
named-read L25482, materialize L25678 all request `size`.
The helper already interpolates the caller’s string
(L23941). Adding `size` is a call-site change, not a hop.
Cycle 158: **Workspace exports have empty `size`.**
Docs/Sheets/Slides use `files.export` (`L25198–25206`).
Named-read L25606 falls back to `contentStr.length` after
the buffer. Materialize treats missing size as 0 then
checks `buffer.length`. A metadata refuse misses the
common KB hit. Bound the helper after export.
Cycle 159: **Hermes MCP client is ~24 in-process files.**
Live `NousResearch/hermes-agent` main: `mcp_tool.py` still
a client; registry skip moved L92→L97. OMP still
`@earendil-works/pi-ai` v0.85.1. A-007 is that split, not
A-006.
Cycle 160: **Loop still client; two opt-in stdio servers.**
`mcp_tool_server_run.py` `/mcp` is a slash-command refresh.
`hermes mcp serve` = conversations (`mcp_serve.py` stdio).
`hermes-tools` lists `image_generate` for Codex (stdio).
Not inbound HTTP `/mcp`. Not A-006.
Cycle 161: **Hermes listed `image_generate` without an
HTTP hop.** `handle_function_call` in the same process
(`hermes_tools_mcp_server.py` L90). Q-014 lists AgentWeb’s
leaf; the mcpFetch hop is the adapter, not a nanoservice.
Cycle 162: **Hermes `image_generate` schema is not MCP
`generate_image`.** Live `IMAGE_GENERATE_SCHEMA` L522–554:
required `prompt` only; `aspect_ratio`; no `filename` /
`category`. MCP requires the eval triple (L2093). A-011
already parks Emma vs MCP. Do not add A-021.
Cycle 163: **Hermes capability-gates tools/list.**
`_build_dynamic_image_schema` L781–815 hides `image_url`
when the model is t2i-only. AgentWeb MCP L2081–2093 is a
literal. Tests in `test_image_generate_schema.py`.
Cycle 164: **AgentWeb does not refuse the unadvertised
edit.** Emma L5035 says gemini-2.5-flash-image is t2i-only;
`generateWithGoogleGemini` L924 still edits. Hermes
`_prepare_fal_request` L367–370 raises. Two layers vs a
comment.
Cycle 165: **`logo_image` becomes `inputImages` before
routing.** Leaf L477–485, then `hasInputImages` L488.
Logo-only skips HITL (L28893 keys off caller images) and
still takes `/images/edits`. Catalog vs mutation.
Cycle 166: **Four image-model catalogs, one leaf.** MCP
free string; Emma enum (7, Runway, no preview);
`SUPPORTED_MODELS` (8); `IMAGE_API_MODELS` (6, no
Runway). L2203 “must match” is false. Hermes has one
`FAL_MODELS`.
Cycle 167: **HITL before `Invalid imageModel`.** Order
is category → confirm → leaf includes(). MCP can waste
a confirm on a typo.
Cycle 168: **Runway does not drop the mutation.** L1363
`referenceImages` from `params.inputImages`. Admin
omitting Runway is a default-picker subset, not a gate.
Cycle 169: **Azure `/images/edits` uses `[0]` only.**
L651. Logo is pushed last, so edit+logo on gpt-image-2
drops the logo bytes and keeps CRITICAL LOGO in the
prompt. Hermes raises rather than silently dropping.
Cycle 170: **L492 already documents why the default is
not `gpt-image-2`.** “supports multiple input images.”
Q-003 mapper stays ready; the prod default flip stays
Matt-gated for this reason, not only $/rank.
Cycle 171: **Azure edit skips `processInputImage`.**
Bare `axios.get` L654: no 30s timeout, no User-Agent, no
SVG→PNG. Gemini/Runway use the helper. Persisted logos
are already raster (ENG-933); explicit URLs are not.
Cycle 172: **Azure FormData always claims `image/png`.**
L660–662. Gemini/Runway send `processedImage.mimeType`.
Two silent lies on the same vendor path as cycle 169.
Cycle 173: **S3 upload always claims `image/png`.**
L582–587 literal. Gemini 3 L1319–1320 puts vendor MIME
on the data URL; `split(',')[1]` discards it. Default-on
C2PA `sharp().png()` makes the successful strip honest;
`removeC2PA: false` or strip fail can lie. Result type
has no `mimeType`.
Cycle 174: **Runway HTTPS skips C2PA and S3.** L570–572
returns vendor URLs; meter already ran. `gen4_image` /
`gemini_2.5_flash` are 2 of 8 models. Strip exists as
Emma `remove_c2pa_from_image` + `POST /remove-c2pa`, not
on MCP. Cycle 36’s L575–578 invariant is after the
data-URL gate.
Cycle 175: **`generateWithOpenAI` else is unreachable.**
L533–534. Every `SUPPORTED_MODELS` id hits Azure /
Gemini / Gemini 3 / Runway. Cycle 174’s URL skip is
Runway-only; DALL-E persist is dead. `getOpenAIClient`
is imported only for that method.
Cycle 176: **Meter `provider` is a prefix, not dispatch.**
L554–558. `gemini_2.5_flash` (underscore) meters as
runway by accident; `gpt-image-*` is Azure and labelled
**openai**. Dollars use `costUsdOverride(model)`. Video
uses `isHiggsfieldModel` from the same catalog as
dispatch.
Cycle 177: **`BLOG_SETUP.md` is a stale fifth catalog.**
L9 / L46–67 still name GPT Image 1 + DALL-E 3 + Picsum
and `OpenAI/Image`. `generateBlogImage` omits
`imageModel` (`blog.ts` L648–655) so L492 Gemini 3
fires; `isAvailable()` probes `Google/Image`. Backend
grep of Picsum / DALL-E / `OPENAI_IMAGE_API_KEY` is
empty. Agent-engine still has a live OpenAI env
(`web_agent.py` L3299). A-012 already parks the controller
import.
Cycle 178: **Two deploy units, two image dispatch tables.**
Intersection is `gpt-image-1` + `gemini-2.5-flash-image`.
Unspecified Emma → Gemini 3; unspecified browser task →
`openai-image-1` → OpenAI else. `gpt-image-2` is Azure
on the leaf and OpenAI-else on the worker. Q-003 already
parks `image-models.ts` L11.
Cycle 179: **Admin seed omits Azure `gpt-image-1`.**
`ImageModelsSettings.tsx` L71–89 auto-inits
openai-image-1 + FLUX + gemini-2.5. Grep of that file
for `gpt-image-1` is empty. CLI help L4216 same two-id
lie. Worker named branch L3281 is unadvertised.
Cycle 180: **Onboarding pins Gemini 3; Q-003 unspecified
path never runs.** L84 / L493 always pass
`imageModel`. Brief item 4 also skips `logoImage`.
L83 “1080×” is Gemini aspect-ratio, not pixels. Azure
L712 would send `1080x1350` as size.
Cycle 181: **Onboarding 180s race does not abort the 8 min
leaf.** Nested `Promise.race`, no `AbortSignal`. Meter
L551 after inner success; UI already has placeholder.
Test L375 blesses elapsed, not cancel.
Cycle 182: **Late Gemini success S3-uploads a key nobody
stores.** Data URL path L566–587; `users/{userId}/files/…`.
`s3Utils.ts` has no DeleteObject. ENG-792 only fails
all-placeholder. C2PA still strips the discarded buffer.
Cycle 183: **`uploaded-by` is a hardcoded `agent-mode`
constant.** Both helpers (L276 / L352); signature has
no caller tag. Thumbnail writer stamps
`workplan-thumbnails`. Screenshots wrap the helper
and inherit the lie. Tests never pin the metadata.
Cycle 184: **`uploaded-by` is write-only.** HEAD
callers use `ContentType` / `ContentLength`.
`assetController` imports `getS3ObjectMetadata` and
never calls it. Helpers set no `Tagging`.
Cycle 185: **Helpers omit `CacheControl`.** HTML-form
save (`filesController` L379) is the README’s subject
and still omits it. README L1537’s `max-age=60` is a
CLI `copy-object`. Thumbnail L35 is immutable 1y.
Cycle 186: **`serveAsset` hardcodes `max-age=300`.**
HEAD then overwrites. Email rewrite hops here; work-plan
thumbs use the raw S3 URL. Tests never import
`serveAsset`.
Cycle 187: **Email rewrite matches one S3 host;
`/asset/` accepts three.** `includes()` of
`s3.us-west-2` only. Brand delete already extracted a
bucket matcher (`brand.ts` L84). Rewrite tests never
use the region-less URL `/asset/` tests pin.
Cycle 188–208: S3 writers, matchers, fetch paths.
Latest (208): work-plan continue de-dupes on
`filename` (tests pin `a.png` twice → one).
S3 keys and `scanMessagesForAssets` are unique
per upload / URL. N variants named `logo.png`
surface as one already-made asset.
Cycle 209–226: A-019 billed-image drain.
Latest (226): `asgLifecycleGuard.ts` L18–19
is a **comment**, not a pin that EB withholds
SIGTERM for the whole `Terminating:Wait`.
`dev.md` L1853 names three SIGTERM sources;
only ASG replacement is the hook. Sunday
`TimeoutStopSec` is live-AWS-only (cycle 116).
Cycle 225 still stands: SIGTERM on a settled
`drainPromise` can `process.exit(0)` before
`completeAction`; HeartbeatTimeout is the
fail-safe. Cycle 227: `IgnoreHealthCheck:
false` is a deploy command, not a Wait
SIGTERM. Do not 503 `/health` during the wait.
Cycle 228: Linear PER-1522 + frontier-kb +
ten-agent arsenal scan. Implementation
order unchanged. Park Q-017
(`mcpServerCore.ts` L58–65 has no
`instructions`; `generate_image` schema
omits `additionalProperties`). Do not port
Homebase / OpenAvatar / Pipeline Studio /
SoL-Pi / AODL / MCP Tasks. A-006 stays
discarded.
Cycle 229: Linear dump deep-read. PER-1522
is still **DRAFT**. Hermes lineage cards are
task prompts, not a public idea list.
PER-1261 is OMP DesignArena roles (not
Q-003). PER-469 is Content Factory, not
Remotion. No new Q-id.
Cycle 230: A-019 `tools/call` 503 is
Application 5xx **color**, not a
`Terminating:Wait` replace. 4xx is the
only ConfigDocument switch. Zero
`HealthCheckType` in git. Do not set
`HealthCheckType: ELB`. Do not 503
`/health`.
Cycle 231: dying-instance 5xx does not fail
the new Immutable instance.
`HealthCheckSuccessThreshold` unset (default
`Ok`) is the temporary ASG bar. Do not set
it from A-019. `socialPosts.ts` Min=Max=1
is a comment (cycle 96).
Cycle 232: Sunday `InstanceRefreshEnabled` is
weekly Immutable, not rolling. L4–6 comment
is stale. Zero `RollingUpdateType` in git.
Do not disable refresh. Do not set
`HealthCheckSuccessThreshold`.
Cycle 233: Sunday-without-hook still
`disableCron`s. Wait is the park, not the
503. TODAY sibling `mcpServer.ts` SIGTERM
closes `/mcp` first (cycle 213).
Cycle 234: Hermes can see A-019 503 while
`/health` is 200. Do not 503 `/health`.
Do not treat 600s as the no-Wait clock.
Cycle 235: POST `/mcp` 503 is a one-shot in
this tree. Do not add a 503 retry in A-019.
Cycle 236: 503 does not poison `sessionId`.
Do not 404 drain. Do not `sessionStore.delete`
on the 503 path.
Cycle 237: JSON 503 is enough for `send()`.
Do not emit SSE 503. Do not add `Retry-After`.
Cycle 238: this tree cannot rewrite JSON 503.
Do not add `error_page`.
Cycle 239: ALB passes Application 503 through.
Do not add listener rules. Do not treat ALB 502
as a rewrite of Node 503.
Cycle 240: A-019 does not pin ALB XFF attributes.
Do not add `modify-load-balancer-attributes`. That
is ENG-493.
Cycle 241: an ENG-493 XFF pin is
`modify-load-balancer-attributes` on the LB ARN.
Do not fold it into A-019 or A-020. Do not add A-021.
Cycle 242: `LoadBalancers[*].Name` stays across Immutable
and Sunday. Console XFF drift survives. Do not treat
`IdleTimeout` as a weekly re-pin.
Cycle 243: a later ENG-493 pin is the only in-tree
reassert of XFF without recreate. Do not treat a
resource-only IdleTimeout PR as also pinning XFF.
Cycle 244: deploy IAM does not list
`ModifyLoadBalancerAttributes`. Do not treat L61–65 as a
grant.
Cycle 245: `DescribeLoadBalancerAttributes` is also unnamed.
Do not infer it from backend SUCCESS.
Cycle 246: an XFF no-op still needs LB Describe on every
opted-in backend SUCCESS. Do not treat already-correct as
skipping Describe.
Cycle 247: a later XFF IAM miss is GitHub-red / prod-green,
not an A-019 503. Do not 503 `/health` because the job is red.
Cycle 248: a later XFF pin can fail closed before
`update-environment`. Do not fold it into the hook. Do not
un-park A-020 for that slot.
Cycle 249: fail-closed-before-apply only helps GitHub
merges. Sunday XFF drift is IdleTimeout class. Do not
un-park A-020 for a weekly XFF pin.
Cycle 250: a pin-only `schedule:` would be the git-native
Sunday XFF reassert. Do not add it from A-019. Do not treat
Dependabot’s Monday `schedule:` as an ALB pin.
Cycle 251: a pin-only Sunday job would not hit Must be Ready.
Do not treat Updating as blocking elbv2 on the surviving ALB.
Cycle 252: during Sunday Updating, XFF must use
`LoadBalancers[*].Name`, not `AutoScalingGroups[0]`. Do not
copy hook discovery.
Cycle 253: this tree and AWS immutable do not return two
`LoadBalancers[*]` ARNs during Updating. Do not add a
uniqueness check from A-019.
Cycle 254: if two ARNs appeared, copy ENG-823 pin-all.
Do not fail closed on `count != 1`. Do not take `[0]`.
Cycle 255: do not fork `grep '^arn:'` into an `/app/`
filter from A-019.
Cycle 256: a `net/` XFF modify fails the job. Do not add
skip-non-app from A-019.

### 4. Hermes / Oh My Pi vs this tree

| Practice | Hermes / OMP | AgentWeb |
|---|---|---|
| Agent loop | One process, packages | 40,571-line `agentModeService.ts` |
| Tool catalog | One registry / `tools/list` | Four registries + Growth Genius inline `search_knowledge_base` (cycle 139) + three `searchKnowledgeBase` symbols (cycle 145) + three availability policies |
| MCP | **Client** to other servers | **Server** for Hermes *and* client to vendors; self `"agentweb-tools"` skipped on file config; DB path can still loopback (cycle 90) |
| Extract | MCP outbound; OMP packages | Fork for health checks; DAG inverted (`services/` import `controllers/`) |

Cutting-edge 2026 (Microsoft modular-monolith first): folders + AST
guards, then extract. `backend/package.json` has **no** `workspaces`
and **no** `dependency-cruiser`.

### 5. What not to compete with (AgentWebPro)

`emma/tools.ts`: **#2832 #1076 #689**. `sdkConstructionGuard.test.ts`: **#2563**.
`agentModeService.ts` pile: **#2871 #2861 #2832 #2563 #2060 #1584 #1076**.
Slack: **#2393**. Never #2862 / #2271 / #2861. `#1076` also touches
`chatbotService.ts`. `#2861` is promoting `convert_to_pdf` to foundation
— do not piggyback `generate_image`. Cycle 57: still empty on
`apiTools.ts` / `loops/core`. **#2271** owns `app.ts` (+7 WhatsApp) plus
`slackChannelAdapter.ts` and `db.ts`. Cycle 61: **#1814** also edits
`app.ts` (HubSpot `crmSync`). A-007 does not touch `app.ts`.
`crm.ts` is **#1544 + #1790** — A-017 first slice is not that file.
Cycle 87: **#2875** is `renewalIntegrationHealthCron.ts` (not MCP).
`#2862` still `toolErrorClassifier.ts`. Meter/price files
(`llmPricing.ts`, `emmaTokenBudget.ts`, `imageGeneration.ts`)
empty. `agentModeService.ts` also **#2832 #1076**.

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
