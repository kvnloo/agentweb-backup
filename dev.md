## OTel spine shipped — spans over the agent loop, dual-emit with the loops recorder (2026-07-02, ENG-141)

Added `backend/src/observability/` (tracing.ts + semconv.ts) and three span sites: `invoke_agent` opens/closes exactly with the run-recorder lifecycle in `agentModeService` (verdict from `computeRunVerdict` on end), `chat` brackets the loop's `callLLM` including the backup-model retry, `execute_tool` wraps the gateway call inside `toolDispatch.runOne` (errorClass from `toolErrorClassifier`). Two direct OTLP/proto exporters — Langfuse (`LANGFUSE_OTEL_HOST`+`LANGFUSE_PUBLIC_KEY`+`LANGFUSE_SECRET_KEY`, Basic auth) and Okareo (`OKAREO_API_KEY`, api-key header) — each registered ONLY when its env config is present; no env = tracing off; no collector. `session.id` + `gen_ai.conversation.id` carry the Emma sessionId for Okareo sim-linking. DUAL-EMIT: `Dev-AW-LoopEvents` stays the policy/learning store; the bridge is by IDs only (`traceId` added to `agent_run_started` dimensions). Prompt/completion content capture is `AGENT_OTEL_CAPTURE_CONTENT`-flagged, default OFF.

**Design choices to remember:** provider is module-private and NOT registered on the global OTel API, no context manager — parenting is explicit via a runId-keyed span registry (async-context propagation through a 24k-line monolith would be un-auditable). `gen_ai.*` names are pinned in `semconv.ts` because the upstream semconv is Development-status (renames must land in one file).

**Assumptions to validate:**
- Spans are produced in the WORKER process; `flushTelemetry()` runs in the parent's `gracefulShutdown`. The 2s BatchSpanProcessor delay + the worker drain window should export worker spans before the child is killed, but a worker SIGKILL <2s after a run ends can still drop that run's spans. If deploy-window traces go missing, add a bounded flush to the worker's per-run tail (next to `flushAgentRunRecorderSafe`).
- Langfuse OTLP trace path is `{host}/api/public/otel/v1/traces` (signal-specific URL, since the exporter takes the full URL). Verify on first real export.
- Okareo protobuf ingest accepts the `api-key` header form and links sims via `session.id`.

## Prod outage: partner-portal "Failed to load users" — full disk + nginx PrivateTmp trap (2026-06-26)

Three stacked failures, only the last self-inflicted by the attempted fixes:

1. **What filled the disk (true root cause).** `services/devEnvService.ts` `teardownEnvironment()` only guarded `if (!instanceId)`, so a dev-env Notion page stuck at the placeholder `"pending"` made it call EC2 `terminateInstances(['pending'])` → `InvalidInstanceID.Malformed` on every webhook tick (~12.5k times), and each failure retried commenting on a maxed-out Notion thread, dumping full AWS-SDK + Axios error object graphs (request `config`+`data`) to stdout at ~79 MB/day → `/var/log/messages` = 424 MB (98.6% app stdout). Root volume was the AL2023 default **8 GB** (RootVolumeSize unset), no `RootFilesystemUtil` metric/alarm, instance up 11 days.
2. **Why only `/admin/users` broke.** That response is ~1.9 MB (AW-Users rows inline `marketStrategy`/`competitorResult`/`brandGuidelines` = 62%), exceeding nginx in-memory proxy buffers, so nginx must spill it to an on-disk temp file. At 03:17 UTC a scheduled deploy tipped the disk to 100% → temp write fails → response never completes → "Failed to load users". Smaller endpoints fit in RAM and kept working.
3. **Why the fixes made it worse.** A custom `client_body_temp_path /var/tmp/agentweb-nginx` + predeploy hook were added. AL2023 nginx.service runs `PrivateTmp=true`, so nginx can't see the host-created dir and fails startup: `nginx: [emerg] mkdir() ".../client_body" failed (ENOENT)`. `nginx -t` PASSES out-of-band (host namespace) but the unit's own `ExecStartPre nginx -t` runs in the private namespace and ENOENTs → `systemctl start` exit 1 → every fresh deploy fails → env can't self-heal. SELinux refuted (errno 2/ENOENT, not 13/EACCES; the only AVC was permissive on error.log).

**Assumptions validated:** the count fan-out in `getAllUsers` is real but was NOT the cause (GSI COUNT queries, ~1,181 ops/req, 4.1 s — a latency time bomb near ~1,000 users, separate follow-up). The #1968 payload whitelist (already on main) cuts 1.9 MB→130 KB and is behavior-preserving (FE reads none of the dropped fields).

**Fixes.** Mitigated by EB rollback to `backend-20260625-pr1955`. PR #1971: remove the custom nginx temp path + hook, keep `proxy_buffers.conf` (the 1.9 MB response stays in memory). Hardening PR: devEnv `'pending'` guard + concise error logging; root volume 8→40 GB gp3; publish `RootFilesystemUtil` + 80% alarm → `agentweb-oncall-alerts`; weekly instance refresh; log caps. **Never override nginx temp paths to a custom `/var/tmp` dir on AL2023 EB — stock `/var/lib/nginx/tmp` is outside PrivateTmp's isolation.** The scheduled prod deploy runs daily 02:00 UTC, so the broken main config had to be fixed before then.

## Landing-page builder reliability — telemetry-driven hardening of the GitHub commit path (2026-06-13)

Scanned `AW-LandingPages` (prod) to ground "the builder is unreliable" in data rather than one anecdote.

### What the telemetry says
- **110 pages, 26 failed = 23.6% failure rate.**
- Failure modes (clustered by errorMessage):
  - **15 "fetch failed"** (58% of all failures) — a Node transient network error to an upstream (v0 / GitHub / Vercel) that was NOT retried.
  - **6 × v0 HTTP 500** — v0 outage symptom.
  - **2 × 422, 2 × 409** — GitHub ref-update conflicts (non-fast-forward).
  - 1 stuck `generating` (the orphan/timeout-lie class — addressed separately by the durable-execution work).

### Root cause of the dominant failures
`withRetry` already covers `fetch failed`/5xx/429/ECONNRESET, and the **v0 calls** and the **first-page repo creation** (`createGitHubRepoAndPush`, ~line 1700) ARE wrapped. But the **sub-page commit path in `addPageToExistingRepo`** was **bare axios with no retry** — five sequential GitHub calls (get-ref → blobs → tree → commit → patch-ref). A transient blip on any one failed the whole build as "fetch failed". That path is exactly where the 15 "fetch failed" came from.

Plus a **race**: the ref-update `patch` used a parent SHA read ~40 lines earlier. If another commit landed on `main` in between — which happens when two pages generate into the **same repo concurrently** — GitHub returns 422 "not a fast forward" (the 422/409s). **Unified multi-site makes this worse**, because it routes more pages into one repo.

### The fix
New `commitFilesToRepoMain(repoFullName, ghHeaders, files, message, maxAttempts=4)` wraps the commit sequence with retry + **rebase**: every attempt re-reads the current `main` SHA and bases the new commit on it, so a concurrent commit is rebased onto rather than rejected. `isRetryableGithubPushError` decides retry: non-fast-forward 422 / 409 (race) and transient 5xx/429/408/`fetch failed`/ECONNRESET/timeout → retry with backoff; 404/auth/validation → fail fast. `addPageToExistingRepo` now calls it instead of the inline axios sequence.

This kills the dominant "fetch failed" class AND the concurrent-commit race in one move. Flag-independent — strictly more resilient, applies to `main` today. Branch `harsha/harden-landing-commit-retry`.

### Duplicate/unnecessary builds — does retrying make it worse? (the right question)
Telemetry says duplicate building ALREADY happens, independent of any retry: **18/110 orphaned failed records** (started, produced nothing), **11 `(repo,slug)` pairs built >1× (some 3×)**, **7 retry storms** (same user+page <10min apart). Source: users/Emma re-asking + orphaned/detached builds (the durable-reconnect work targets that class).

The naive commit-retry would have ADDED a vector: if `patch-ref` succeeds on GitHub but the response is lost ("fetch failed" on the reply), a blind retry re-commits → a 2nd commit + 2nd Vercel build for the same page. Fixed with **idempotency**: `commitFilesToRepoMain` tracks the commit it tried to set and, on any failure, re-reads `main` — if it's already at our commit, the patch landed (lost response) → return success, never re-commit. A non-fast-forward 422 (patch rejected, main NOT at our commit) correctly falls through to rebase+retry. So retries can rebase and recover transient failures but can never double-build.

### Route-level idempotency — kills the 11 duplicate builds at the source (DONE)
A multi-agent audit + a fresh telemetry pass established the key fact: **all 11 duplicate `(repo,slug)` routes came from DIFFERENT chat sessions re-asking the same route** — not concurrency, not the same session. So the right key is **route identity (userId, slug)**, not a session lock or a serial writer. `generateLandingPage` now calls `findReusablePageForRoute(userId, slug)` in the existing-site branch: if a non-archived page at that slug is already `deployed`/`generating`/`deploying`, it's returned (reuse) instead of building a duplicate. Explicitly NOT `failed` (a retry after a failure must rebuild); legitimate refreshes go through the dedicated iterate endpoint. ~15 lines, no lock — the lightweight "idempotent entry" the design research endorsed as the simplest first step.

### Design direction (research, separate doc) — platform-native, net-removes complexity
Research (Webflow/Framer/Vercel/v0 + canonical patterns) concluded the simplest *target* is "repo is the source of truth, content-addressed, read live state": Vercel already returns the existing deployment for an already-seen commit SHA and cancels superseded builds (`autoJobCancellation`), so the duplicate/race/orphan problems are best solved by leaning on that + a `generationKey` idempotency on the v0 call, which would let us DELETE the orphan-sweep + redeploy poller + scattered guards rather than add more. The route-dedup above is the first, direction-agnostic step toward it.

### Still open (audit-confirmed, safe, next)
- **Vercel calls are bare axios** (createVercelProject/triggerVercelDeployment/poll/status) — wrap in `withRetry` (extend the classifier for axios `err.response.status`), the same gap as the GitHub commit path. High value (the 6 v0-500 + transient deploy failures).
- **First-page push** (`createGitHubRepoAndPush` blob/tree/commit/ref-patch) is still bare — route it through `commitFilesToRepoMain`.
- `generateFirstPage` put + `cleanupOrphanedFailedPages` could use conditional writes (compare-and-swap) to close the first-page concurrency race.
- v0 HTTP 500s (6) are retried by `withRetry` but a sustained v0 outage still surfaces; consider a longer/again-later retry or a user-facing "v0 is down, try again" rather than a hard fail.
- Vercel deploy 422 (1) — check `createVercelProject` / `triggerVercelDeployment` retry coverage next.

## Loop Slack egress gated to prod — fixes "Emma Dev yaps" class (2026-06-13)

Root cause of the duplicate "Emma Dev" AI-readiness DMs: ≥2 stale test-env backends had AI_READINESS_LOOP_ENABLED=true set per-instance (not in the shared secret — verified: the shared `agentweb/test-env/backend-env` secret sets the emma_dev Slack token but NO loop flags), and the loop's Slack post was gated only by that per-loop flag. So any dev box with the flag flipped could DM the founder via the shared emma_dev bot. Only ai-readiness yapped because only that one flag was ever turned on in dev.

### Fix (this PR) — best-practice, defense-in-depth
`shouldSuppressLoopSlackPost(env)` in `loops/adapters/awsAdapters.ts`, applied at the single Slack egress (`SlackPort.postMessage`) every loop uses (digest, attribution, dispatcher). Non-prod (`NODE_ENV !== 'production'`) suppresses the post and logs instead; overridable with `LOOP_SLACK_ALLOW_NONPROD=true` for intentional dev-channel testing. The per-loop enable flag controls behavior; this controls blast radius — they're separate concerns. emma_dev stays usable for everything else; only loop DMs are gated.

### Note
This prevents recurrence but does NOT stop already-running stale backends (their process is up). Those were stopped separately (see below / ops action 2026-06-13). The durable systemic fix beyond this is a TTL reaper on test-env instances (the real enabler was boxes living Feb→June) — filed as follow-up.

### Assumptions to validate
- After deploy, the prod readiness loop still DMs (NODE_ENV=production on prod EB → not suppressed). Falsified if prod stops posting — would mean prod env isn't NODE_ENV=production (it is, verified).
- No other legit non-prod loop posting relied on the old behavior. If a dev/staging channel digest was wanted, set LOOP_SLACK_ALLOW_NONPROD=true there.

## AgentMode B2 — session-generation claim made atomic (no double-proceed race) (2026-06-14)

WS-B / B2 reliability increment. The `/generate` and the interactive-share `/generate`
endpoints in `controllers/agentModeController.ts` each rejected concurrent requests for the
same session via a hand-rolled `activeSessionGenerations.has(sessionId)` check followed by a
separate `.add(sessionId)`. The two statements were duplicated at both call sites (re-grepped:
the regular path was ~line 2185, the interactive-share path ~line 2980 on `harsha/swarm` at
`187a06a9`).

**Assumption validated:** the pair is race-free *today* only because nothing `await`s between
the `has` and the `add` (Node's single thread won't interleave synchronous code). The fragility
the spec names is structural — any future edit inserting an `await` between check and set
(easy to do, since the two statements look independent and are separated by other request
setup) re-opens a window where two near-simultaneous `/generate` calls both pass the check and
both proceed, corrupting the single-flight guarantee.

**Fix (behavior-preserving):** co-located check-and-set into one indivisible primitive,
`tryClaimSessionGeneration(sessionId): boolean` (returns `true` for the winner, `false` for a
busy session), plus a symmetric idempotent `releaseSessionGeneration(sessionId)`. Both call
sites now call the primitive; an `await` can no longer be wedged between the check and the set,
so the claim is atomic by construction. Single-request path is unchanged (same 409 SESSION_BUSY
body, same lock lifecycle). No new tables/flags/branches; net moving parts ~flat (one helper
pair added, two duplicated 2-statement blocks collapsed to one call each).

**Tests:** `agentModeController.atomicClaim.test.ts` (5 cases) pins the contract — two
back-to-back synchronous claims on one sessionId yield exactly one `true` + one `false`;
cross-session independence; release-then-reclaim; idempotent release. Existing
`agentModeController.concurrentRequests.test.ts` (6) + `errorHandling.test.ts` (24) +
`delegatedCrmAccess.test.ts` (3) stay green unchanged → behavior preserved. `npx tsc` clean.

---

## AgentMode B3 review fix — trim WeakMap memo DROPPED after splice-path staleness found (2026-06-14)

Independent review of PR #1878 found the B3 WeakMap memo unsafe — and it failed on exactly the assumption flagged below in "Assumptions to validate (a)": the append-only invariant does **not** hold. `updateConversationContext()` (agentModeService.ts ~:3411-3434) runs on the same `messages` array reference inside the loop (called ~:2547, before the trim call ~:2603) whenever the agent installs skills. Its install_skills path does `messages.splice(idx, 1)` (remove the prior skill-context message wherever it sits) then `messages.splice(1, 0, …)` (reinsert near the top) — a remove-then-reinsert that is **net-zero in length** but shifts every absolute index between the two positions. The memo's `cached.length <= messages.length` guard sees no growth, walks an empty tail, and serves STALE absolute indices (`toolIndices` / `toolIdToIndex`) against the shifted array → wrong `preserveSet` / `oldAssistantIndices` → trimmed output DIVERGES from the original algorithm. Not behavior-preserving; AC-breaking.

**Fix:** removed the WeakMap memo entirely. Kept the `tool_call_id → index` Map — that alone kills the originally-reported per-call nested O(n²) scan (O(1) lookups) and is fully behavior-preserving on every path including splice/reorder, because the scan is recomputed against the live array each call and can never go stale. Net effect: fewer lines and less per-instance state than the merged PR, no correctness caveat.

**Proof:** added a `splice/reorder safety` describe block to `agentModeService.trimToolContext.test.ts` with two cases (net-zero reorder that shifts the preserved tail + a length-changing reorder), each mutating the SAME array ref and asserting deep-equality against the golden oracle on the post-splice array. Both FAIL against the memo'd version (verified by reverting the service file) and PASS with the memo removed. Existing golden-oracle characterization + sub-quadratic perf tests retained and still pass (32/32 across trim + publishFixes suites; `npx tsc` clean).

**Lesson:** a length-only memo guard cannot detect an in-place reorder that preserves length. The "Assumptions to validate (a)" note below correctly predicted this; the safe move was to not ship the memo at all, since the Map already solves the reported defect.

---

## AgentMode B3 — `trimToolMessagesForContext` made incremental, killing per-iteration O(n²) reprocessing (2026-06-14)

`AgentModeService.trimToolMessagesForContext()` (agentModeService.ts ~:16612) is called once **per loop iteration** from the main agent loop (`while (iteration < maxIterations)` at :2501, call site :2603) on the full, monotonically-growing `messages` array. Old shape was O(n²) *per call*: the `oldAssistantIndices` pass ran a nested forward scan (for each assistant-with-tool_calls, scan all following messages looking for a preserved tool result). Across an N-iteration session that's O(N²)+ total reprocessing of the same history.

**Fix (behavior-preserving, internal only):**
1. Replaced the per-assistant nested forward scan with a single `tool_call_id → tool-message-index` map built in one linear pass, so the "is this assistant old?" predicate is O(1) lookups instead of an O(n) scan. A single call drops from O(n²) to O(n).
2. Added a per-instance `WeakMap<messagesArray, {length, toolIndices, toolIdToIndex}>` memo. The agent loop only ever **appends** to `messages` (verified: the sole in-loop mutation is `messages.push` at :3181 — no splice/shift/reorder), so on repeat calls with the same array reference the scan only walks the appended tail. Amortized per-call cost is O(tail); a full session is O(n) total. The memo is validated by `cached.length <= messages.length`; any reference/shrink mismatch falls back to a full O(n) rebuild, so a stale memo can never corrupt output.

**Exact predicate preserved:** the original flips `allOld=false` only when a resolving tool result exists at an index `> i` AND is in `preserveSet`. The map stores the first tool index per `tool_call_id` (ids are unique by construction), and the new check is `resolvedIdx !== undefined && resolvedIdx > i && preserveSet.has(resolvedIdx)` — identical semantics.

**Proof:** new characterization test `agentModeService.trimToolContext.test.ts` carries a golden reference that replicates the original nested-loop algorithm and asserts deep-equality of production output on a long synthetic session AND across the real incremental (append-per-turn, same array ref) calling pattern. Validated TDD-style by stashing the fix: against the ORIGINAL code the 4 characterization tests pass (golden == original) and the 2 sub-quadratic tests fail (4×-session work ratio 14.1× ≈ quadratic; incremental case 15,750 `role` reads). With the fix all 6 pass (ratio < 6, linear). Existing 24 `publishFixes` trim tests unaffected.

**Assumptions to validate:** (a) the in-loop append-only invariant holds for all code paths feeding this method — if a future change ever reorders/removes earlier messages on the same array reference *without* shrinking length, the memo could go stale; the `length`-only guard would not catch that. Mitigation if that ever happens: also stamp a cheap head-identity check. Today no such path exists. (b) `chatbotService.ts` has its own standalone copy of `trimToolMessagesForContext` (:3702) — NOT touched here; same optimization could be applied there in a follow-up.

---

## B5 — Dedupe/rate-limit context-limit oncall alerts (stop flooding) (2026-06-14)

The context-limit error path in `controllers/agentModeController.ts` fires `sendAgentModeOncallAlert` (`utils/agentModeAlerts.ts`) on **every** occurrence. Two sites hit it: the regular `/generate` path (re-grepped to ~line 2453) and the shared/interactive-response path (~line 3111). On a high-concurrency day, one user repeatedly retrying a too-long session would generate one oncall email **per request** — pure noise.

**Notion side was already deduped**: `autoReportContextLimitToNotion` sets a per-session `contextLimitReported` flag and skips if set, so Notion only ever files one issue per session. The flood risk was the **oncall email**, which had no dedupe at all.

**Fix (contained, behavior-preserving):** added an opt-in `dedupeKey` + `dedupeWindowMs` (+ injectable `now` for tests) to `sendAgentModeOncallAlert`. When `dedupeKey` is set, an in-memory `Map<key, lastAlertTs>` suppresses repeat alerts inside the window (default 10 min); the map is lazily pruned past 1000 entries. When `dedupeKey` is absent, behavior is unchanged — every call fires (all other ~14 call sites untouched). The two context-limit sites now pass `context_limit:<userId|sessionId>` and `context_limit_shared:<userId|shareId>` respectively (distinct error classes key independently).

**Assumptions to validate:**
- In-memory dedupe is per-process. With multiple backend workers, the worst case is ~1 alert per worker per window (still a >N× reduction from per-occurrence). A shared store (Dynamo/Redis) would make it global but adds a moving part — deferred unless per-worker volume is still noisy in prod.
- 10-min default window chosen to match a typical retry-storm; tune via `dedupeWindowMs` if oncall still sees clusters.
- The user-facing 413 `CONTEXT_LIMIT_EXCEEDED` response is unchanged — dedupe only gates the alert email, never the HTTP response (existing `errorHandling` test 1026 still passes).

---

## Layer 4→5 closed: real Slack-reaction approval gate that stamps shippedAt (INCREMENT C1, 2026-06-14)

The dev.md-named #1 learning-loop gap (2026-06-09): production `ApprovalGate` is `CaptureGate` (`loops/core/gates/captureGate.ts`), whose `pollDecision()` ALWAYS returns `pending` → `shippedAt` is never stamped → the attribution cron (`loops/core/learning/attribution.ts:143`, filter `decision.status in {approved,auto_shipped}` AND `shippedAt` set AND `verdict==null`) has nothing to grade → every loop sits at `pending_approval` forever.

**Shipped:** `loops/core/gates/slackReactionGate.ts` — `SlackReactionGate implements ApprovalGate`. `requestApproval` posts the proposal DM via the injected `SlackPort` and returns a handle (`{channel, ts, approver}`). `pollDecision` reads reactions and resolves via the pure `resolveReactionDecision(reactions, approver, now)`: ✅ `white_check_mark` from the approver → `approved`; ❌ `x` → `denied`; none → `pending`. **Reject wins over approve** when both present (safety). Reactions from non-approvers ignored (matches the `slack.aiEvalReaction` handler convention + `awsAdapters.getReactions`). `settleDecision(store, loopId, mutation, decision)` performs the Layer-5 write: approved → appends a record with `decision=approved` + `shippedAt` stamped (the exact shape attribution grades); denied → record `decision=denied`, NO `shippedAt`; pending → no-op. Idempotent per proposal (in-process `settled` set) so a repeated poll never double-ships.

**Assumptions to validate (NOT yet wired into the live runner):**
- This PR ships the capability + tests, NOT a prod flip. `CaptureGate` is still the registered `agentModeGate`. The gate is gated behind `AGENT_MODE_SLACK_REACTION_GATE` (default OFF) via `buildAgentModeSlackReactionGate()` in `instances/agent-mode/index.ts`, which builds-but-does-not-register.
- **Why deferred:** `createInstanceRunner` (`loops/core/instanceRunner.ts:48`) types its held `gate` as `CaptureGate` and `drain()`s it each tick to batch the digest DM. Promoting `SlackReactionGate` into the runner means restructuring that drain path — a separate, larger change with its own behavior-preserving proof. Doing it here would change the digest-batching behavior, which is out of C1's contained scope.
- C2 (attribution reaches a verdict) depends on this gate's `settleDecision` actually running in prod, which depends on the runner-wiring PR above. Until then `shippedAt` is stamped only in tests.
- Reaction polling is single-shot per `pollDecision` call; no long-poll. The watchdog cron cadence determines how fast an approval is observed — confirm the cron actually calls `pollDecision`+`settleDecision` once wired.

---

## C2 — approval→attribution→verdict path verified end-to-end; found + fixed a `computeLoopHealth` stall (2026-06-14)

Verified WS-C2 ("attribution reaches a verdict"): drove the real Layer-4→5 approval write (`recordLoopApproval`, the C1 gate contract — stamps `decision=approved` + `shippedAt`) → elapsed the settle window → ran the generic `runAttribution`. The grading path itself works: a verdict (`improved`/`regressed`) is computed and appended to the learning store, and the dedup is idempotent (a second pass writes nothing). New end-to-end mocked test: `backend/src/__tests__/loops.c2.approvalToVerdict.test.ts` (in-memory learning store + fake sensor, zero network).

**But the loop never visibly came off `pending_approval`, which is the AC.** Root cause = the learning store is **append-only**: one logical proposal accumulates a `pending` row → an `approved`+`shippedAt` row (from `recordLoopApproval`) → a graded `verdict` row. `computeLoopHealth` (`loops/core/health.ts`) counted EVERY matching row, so:
- the original `pending` row kept counting as `pendingApproval` even after the ✅ → state stuck at `pending_approval` forever; and
- the pre-verdict `approved`+`shippedAt` row kept counting as `inFlight` even after grading → state stuck at `in_flight`, never reaching `learned`.

`GET /api/admin/loops/health` reads with no status filter (`loopHealthService` → `queryHistory({loopId})`), and both `InMemoryLearningStore` and `DynamoLearningStore` return all rows — so this misreport is real in prod, not a test artifact.

**Fix (behavior-preserving, pure):** in `computeLoopHealth`, de-dup by proposal/mutation id — count a `pending` row only if no later row has resolved that proposal (approved/auto_shipped/shipped/graded), and count an `in_flight` row only if no graded verdict exists for it. Each logical proposal is now summarized by its furthest-progressed row. All 22 existing `loops.health.test.ts` cases stay green (single-row states are unaffected — there's no later row to supersede them).

**Assumptions to validate:**
- The attribution **scheduling** wasn't exercised here (this drives `runAttribution` directly); `loopAttributionCron` already iterates manifests + skips paused loops (covered by `loops.attributionCron.test.ts`). The settle-window gating is `runAttribution`'s own logic.
- C1 (the Slack-reaction `ApprovalGate` that calls `recordLoopApproval` on a ✅) is **not yet landed on `harsha/swarm`** — production gate is still `CaptureGate` (`pollDecision` always `pending`). This test builds against the documented C1 contract (the persistence primitive `recordLoopApproval` that produces `approved`+`shippedAt`). Once C1 lands, its gate must call that primitive for the health transition to fire in prod.
- The health de-dup keys on `proposalId ?? mutationId`, matching attribution's own `recordKey`. If a future loop emits rows with neither id, those rows can't be de-duped (they fall back to counting as-is) — acceptable since every current emitter sets a proposal.

---

---

## AgentMode B1 — worker-crash session-lock leak: already-released on crash, but session→request map leaked (2026-06-14)

Investigated WS-B1 (worker crash holds `activeSessionGenerations` until `GENERATION_TIMEOUT_MS`). Re-grepped the current sites:
- The session-generation lock is `activeSessionGenerations` (`controllers/agentModeController.ts:40`), claimed at `:2192`/`:2987`, released in a `finally` at `:2356`/`:3032`. `GENERATION_TIMEOUT_MS` = 600s (`:56`).
- `generateSessionResponse` (`:1592`) `await`s `generateMarketingResponseWorkerService.runInWorker` (`:1819`). The worker is a forked child (`services/generateMarketingResponseWorkerService.ts`).

**Finding (assumption corrected):** the literal "lock only releases after the timeout on crash" is NO LONGER true. The worker `error`/`exit` handlers (worker service `:201`/`:216`, added Feb 2026 in the "Improved Agent Mode Response Speed" change) already reject every in-flight `pendingRequests` entry on worker death. That rejection unwinds through `runInWorker` → `generateSessionResponse` → the controller's `try/finally`, which deletes the lock **immediately**. Pinned by `agentModeController.workerCrashLockRelease.test.ts` (simulated worker death → next `/generate` for the same session is accepted, no timer advanced) — passes on the pre-fix code.

**Real remaining defect in the same region (this is what the fix addresses):** both crash handlers (and `shutdown`) reject + `clear()` `pendingRequests` but never clear `sessionToRequestId`. So after a crash a dead session's `requestId` lingers — a later `cancelSession()` for that session mis-fires a `{type:'cancel'}` at the *fresh* worker, and the map grows unbounded across crashes. Fixed by a single `failAllPendingRequests(error)` helper that rejects pending requests and clears BOTH maps; `error`/`exit`/`shutdown` now call it (dedupes three near-identical handler bodies → net-negative branches). Behavior-preserving: the rejection path and error messages are unchanged; only the stale-mapping/leak is closed. Repro test: `generateMarketingResponseWorkerService.test.ts` "clears the session→request mapping when the worker crashes" (failed pre-fix: stale cancel fired; passes post-fix).

Assumptions to validate: (a) no caller depends on `sessionToRequestId` surviving a crash (verified: only `cancelSession` reads it, and post-crash there's nothing to cancel); (b) the controller path remains the sole lock owner (verified: lock lives only in the controller, worker service has no reference to it).


---

## B4 — SSE zombie progress: worker death now clears progressStore at the source (2026-06-14)

WS-B4 fragility fix. `progressStore` (`utils/sseProgress.ts`) is an in-memory `Map<sessionId, ProgressUpdate>` that backs the agent-mode progress SSE stream. The frontend treats a stored entry whose `status` is not `complete`/`suggestions` as "still generating" (`hasActiveProgress`, controller). Cleanup was entirely the controller's job: every terminal path calls `markProgressComplete(sessionId)` (emit `complete` → `progressStore.delete`).

**Re-grepped the spec's line refs (the monolith moves):** `progressStore` is set only in `emitProgress` (`sseProgress.ts:45`); deleted in `cleanupProgress`, `markProgressComplete` (controller ~1545), and inline at controller ~2213/2992/5695/5749. The generation worker is `generateMarketingResponseWorkerService` (fork child process); on `worker.on('error')`/`worker.on('exit')` it rejected all `pendingRequests` but did **nothing** to `progressStore`.

**The gap:** progressStore cleanup depended on the *awaiting* controller path reaching a `markProgressComplete`. The detached fire-and-forget plan-start path (controller ~5693, `.then().catch()`, not awaited by any HTTP handler) and any future caller that doesn't wrap in that exact catch leak a stale entry forever when the worker dies mid-iteration → frontend streams "Thinking…" indefinitely even after reload. This is the charter's "crash of a turn must not orphan a stream" invariant.

**Fix (behavior-preserving, additive on the crash path only):**
- New leaf helper `clearTerminalProgress(sessionId)` in `sseProgress.ts` — the single definition of terminal cleanup: emit `complete` *iff* a live entry exists (so it never resurrects an already-cleaned entry), then delete. Active SSE connections are intentionally left registered so a reconnecting client still gets `complete`.
- `generateMarketingResponseWorkerService` now calls `clearProgressForInFlightSessions()` (iterates `sessionToRequestId`, best-effort `clearTerminalProgress` per session) inside both the `error` and `exit` handlers, before clearing the maps. Also clears the previously-leaked `sessionToRequestId` map on death.

No change to chat outputs, tool selection, prompts, or model defaults — only guaranteed reliability cleanup on worker death.

**Assumptions to validate:**
- `sessionToRequestId` holds exactly the sessions with in-flight worker requests at death time — confirmed: set in `runInWorker`, deleted on the matching `message` response. A session whose request already settled is not in the map, so we don't touch its (possibly post-run `suggestions`) progress.
- Importing `sseProgress` (a zero-dependency leaf util) into the worker service introduces no import cycle — confirmed (`sseProgress.ts` imports nothing).
- The controller's happy/cancel paths are unchanged (`markProgressComplete` left intact), so this is purely a second, source-level safety net for the crash case.

## "Emma Dev" Slack chirping — agent-mode reliability loop DM'd Harsha on EVERY run, killed (2026-06-14)

**Symptom:** a recurring "Emma Dev" Slack DM chirp that only ever came from the **AI Reliability loop** (the agent-mode tool-reliability loop), arriving at seemingly **random** times with no obvious source.

**Where it came from:** the "Emma Dev" sender is the backend's `SLACK_BOT_TOKEN` Slack app (`loops/adapters/awsAdapters.ts` `awsSlackAdapter` → `chat.postMessage`). `server.ts:700` schedules the agent-mode tool-reliability loop behind `AGENT_MODE_LOOP_ENABLED` (on in prod): each booting process does `setTimeout(→ next 17:30 UTC)` then `setInterval(24h)`. After each run, `loops/instances/agent-mode/index.ts` `onRunComplete` called `postLoopDigest(...)`, which DMs `manifest.approval.slackUserId` (`U08TM4QFQ1L` = Harsha). That digest is the chirp.

**Why it chirped (the "for some reason"):**
1. **Only this loop is both scheduled AND enabled in prod.** Siblings `ai-eval` (`AI_EVAL_LOOP_ENABLED`), `ai-readiness` (`AI_READINESS_LOOP_ENABLED`), and `onboarding-v2` (`ONBOARDING_LOOP_V2`) are env-gated off, so they never fire. Only `AGENT_MODE_LOOP_ENABLED` is on.
2. **It DM'd unconditionally, even on empty/quiet windows.** `postLoopDigest`/`buildLoopDigestLines` (`loops/core/digest/loopDigest.ts`) always renders a message. `ai-eval` guards its post with `if (drained.length > 0 || result.eventsScanned > 0)`; agent-mode had **no such guard** (only `if (drained === null) return`, and `drained` is never null because the loop holds a `CaptureGate`). The recorder that feeds it is gated *separately* by `AGENT_RUNTIME_SPINE_ENABLED` (off in prod), so every run scanned **0 events** and still fired the "_No agent-mode tool events… not 'healthy', just empty_" DM. Pure noise content.

**Why it felt RANDOM (the part the first writeup missed) — no daily-dedup claim + multi-process prod:** `ai-readiness` wraps its DM in `claimDailyDigestPost()` (`ai-readiness-funnel/index.ts:285`) — a DynamoDB conditional `put` keyed on `(digestDate, slackUserId)`, so only ONE poster per calendar day wins and every other process gets `ConditionalCheckFailedException` → "already posted, skipping duplicate." **Agent-mode has no such claim** — `onRunComplete` posts directly. Prod runs on Elastic Beanstalk with **multiple instances + a worker process**, and each process schedules its own boot-aligned timer. Every redeploy, autoscale event, crash-restart, and the nightly 2am scheduled deploy spins up a fresh process with a fresh `setTimeout` → **duplicate DMs at staggered, unpredictable times**. That's the "random": not one daily chirp, but N-per-day from N independent processes with no lock.

**Note (correcting the loop's own dev.md §~110):** the gate being `CaptureGate` does NOT mean the DM is dead — approval is out-of-band (Harsha ✅ → `routes/slack.ts` → `recordLoopApproval`, and `shippedAt` IS stamped via `approvalPersistence.ts`). So the digest was *actionable*; it was just noisy + duplicated. The kill is about noise, not because the DM never worked.

**Fix (complete kill, reversible):** `onRunComplete` now returns before posting unless `AGENT_MODE_LOOP_DIGEST === 'true'` (default off) — the dedicated flag. This kills the chirp **regardless of how many instances/processes fire**, because every process checks the flag and stays silent (so it also sidesteps the missing-dedup problem). The loop still registers, records, runs, and surfaces via `GET /api/admin/loops/health` — it is simply **silent**. No EB env change needed: even with `AGENT_MODE_LOOP_ENABLED=true` the chirp is gone. To re-enable, set `AGENT_MODE_LOOP_DIGEST=true`. The exact digest wire format is still pinned by characterization tests (now under that flag) so the dispatcher contract is preserved.

**Proper follow-up if the digest is ever re-enabled:** add the `claimDailyDigestPost()` dedup (copy the `ai-readiness` pattern) so the multi-process duplication is fixed at the source, not just muted by the flag. Tracked as a TODO in the dev.md, not done here (the flag fully solves the reported problem).

**Tests:** `loops.digestCharacterization.test.ts` — added "is silent by default — posts NO digest DM even when tools are failing"; the 3 verbatim-format tests run under `AGENT_MODE_LOOP_DIGEST=true`. `npx tsc` clean, 22/22 pass.

---

## Live tool-failure telemetry — 227 failures classified; raw failure-rate OVERSTATES breakage (2026-06-13)

Pulled actual error strings from `Dev-AW-LoopEvents` (failure events carry `dimensions.errorClass`/`errorMessage`; `agent_tool_invoked`/`agent_tool_succeeded` do NOT — a failure = invoked-without-a-matching-succeed, which is how the loop derives rates). 227 sampled failures classified by root cause. Confirms + makes empirical the Section-C "tool-list truncation" finding below and the 2026-06-11 #eng thread with Rui (June 9–12 window: 223 runs, 1,016 calls, 78 failures).

**THE updated assumption (this changes retire/keep decisions): raw per-call failure rate ≠ breakage.** Only a minority of the 227 are real tool bugs. Buckets:
1. **Model calling tools that aren't installed** — "Tool X is not available. You must install the required skill first" (`search_tool_response` ×15, `describe_image` ×8, `linkedin_outreach` ×8, `read_file_content`, `wait_seconds`, `get_login_credentials`…). This is the **live symptom of the Section-C tool-list truncation** (~141 tools vs 128 Azure cap, `agentModeService.ts:2070`): dropped tools become "not available" when the model calls them. NOT per-tool bugs — fixing truncation (tool-search instead of drop) removes a large share of ALL failures at once.
2. **Validators correctly rejecting bad input (working-as-designed, NOT failure)** — `run_local_agent_task` "Task rejected: web browsing/data extraction only" ×10 + forbidden-pattern `post.*comment` ×2; `linkedin_outreach` "Should delay new invitation to this recipient" ×9 (LinkedIn anti-spam delay). These inflate the rate; a naive ">30% → retire" rule would kill tools that are working. (run_local was the "55%" in the thread — most of it is this.)
3. **Schema-validation rejections caught pre-execution (cheap)** — `read_tool_response` ×18, `search_tool_response`, `wait_seconds`: "arguments failed schema validation" / "s3_key and query required". Fix = mark args required; #1818 gateway pre-flight already catches these before execution.
4. **Real config/infra bugs (the actually-actionable list):**
   - **Legacy search-provider 429 — CONFIRMED LIVE across every variant** (web/news/video/local/image_search all "429 Too Many Requests"; summarizer failures were a *cascade* — nothing to summarize once web-search 429s). One shared key throttled. Fix: consolidate on `search_web` (failed only 2×, both benign "No search results").
   - `perform_data_analysis`: `404` / "The specified bucket does not exist" — missing/misconfigured S3 bucket.
   - `call_meta_ads_insights_api`: "Meta Insights Job timed out" — matches the Section-A background-job fix.
   - `slack_get_recent_messages`: "The Slack bot is not a member of channel …" ×4 — backend bot needs inviting (same class as the `LEAD_CAPTURE_ALERT_SLACK_CHANNEL` / #lead-capture caveat).
   - `coding_agent` "Not authorized to edit this landing page" / `get_file_contents` GitHub "Bad credentials" — per-user secret/auth gaps.

**Decision implication:** retire/keep cannot run off raw failure rate — it needs failure-**type** classification first (real-bug vs by-design vs model-error vs config). This is exactly Fangfang's #eng point (a human, then an LLM judge, classifies output + tool-call quality *before* fixes). The loop's *sensing* works; the missing layer is **failure classification, not more sensing**. Concretely: tag each `Dev-AW-LoopEvents` failure with one of {bug, by_design, model_uninstalled_tool, schema_reject, config} so the weekly scorecard reflects real tool health.

**UPDATE — classifier SHIPPED (`utils/toolFailureType.ts`, 100% cov; `runRecorder.toolFailed` now stamps `dimensions.failureType`; backfilled all 227 historical `agent_tool_failed` via `scripts/backfillFailureTypes.ts`).** Final distribution of the 227:

| failureType | count | share |
|---|---|---|
| bug (real candidates) | 63 | **28%** |
| config | 56 | 25% |
| schema_reject | 49 | 22% |
| model_uninstalled_tool | 34 | 15% |
| by_design | 25 | 11% |

So **only 28% of "failures" are real bugs** — the scorecard/policy should filter `dimensions.failureType = 'bug'`. Classifier reads signals from the error *message* too, so pre-classifier events (errorClass `'Error'`) still classify provider 429s correctly.

**UPDATE 2 — classifier TUNED + Theme 1 fixed.** Investigated the 63 `bug`s: many were misclassified. Tuned the classifier (LinkedIn "cannot resend"/"recipient cannot be reached"/"no results"/bad-PDF → by_design; invite-too-long → schema_reject; summarizer cascade / 404 / aborted-op → config) and re-tagged all 227 (`backfill --force`, 27 changed). **Real `bug` count: 63 → 36 (16%).** New split: config 66 / schema_reject 55 / by_design 36 / **bug 36** / model_uninstalled_tool 34.

The 36 real bugs cluster into: **opaque error propagation** (run_local "success=false", Meta "unknown error", linkedin "Invalid parameters", describe_image 400) · stale-file editing (`update_html_file` hash mismatch) · browser flakiness (playwright timeouts/snapshots) · misc (`get_leads` bad pagination key, `report_product_issues` self-failure).

**Theme 1 (opaque errors) — central fix SHIPPED:** extracted `toolResultError`/`extractToolResultMessage` to `utils/toolResultError.ts` and hardened it to surface object-shaped errors (Meta Graph `{error:{message,code,error_subcode}}`) + status/reason instead of the opaque "Tool returned success=false". **`run_local_agent_task` source fix SHIPPED:** `buildLocalAgentResult` (localAgentTools.ts) now always populates a failure reason (`error` → `result` → `returncode N`) so an ok:false relay response is never opaque. Remaining per-integration follow-ups: Meta subcode extraction at its handler, describe_image 400-body capture.

---

## Platform state audit — reliability fixes, complexity levers, SOTA gaps, learning-loop health (2026-06-13)

Whole-backend deep-dive (6 parallel agents; reliability + complexity findings adversarially verified, 0 false-positives). Recorded as the "where we are vs where we need to be" baseline so it isn't re-researched. Loop framework = `backend/src/loops`. Findings cross-checked vs `origin/harsha/dev`. Branch at audit time: `harsha/durable-landing-multisite` / `harsha/retire-stale-agent-models`.

### A. Reliability — fixes needed (all verified, file:line)

**CRITICAL**
- **Stripe webhook user lookup is a single-page full-table Scan → silently drops billing events at scale.** `findUserByStripeCustomerId` (stripeService.ts:1024) → `userDb.scanWithFilter` (db.ts:1133-1147) is one `.scan()` with NO `LastEvaluatedKey` loop; once `AW-Users` exceeds ~1MB a real paying user on a later page returns null. Called at the top of every webhook handler (handleSubscriptionUpdated stripeService.ts:534, handleInvoicePaymentSucceeded :643, +4). On null, `isNonRetryableError` (stripeController.ts:27-33) treats "user not found" as permanent → HTTP 200 → Stripe STOPS retrying. This IS the State-Reconciliation failure mode. Fix: GSI on `stripe_customer_id` + Query; interim, paginate the scan (`scanAllItems` helper already at db.ts:1193) and make "user not found" retryable (500). Effort M.

**HIGH**
- **No event-level idempotency + ordering bug on Stripe webhooks.** Switch dispatch (stripeController.ts:86-143) has no `event.id` dedup → redeliveries re-run; stale-guard (stripeService.ts:544-553) compares only `subscription.id`, never `event.created`, so out-of-order `.updated` events both pass and the later-arriving-older event clobbers `subscription_status`/`current_period_end` (stripeService.ts:569,596-601). Replayed `.created` (isNew bypasses guard) resurrects a canceled sub. event.id dedup exists ONLY in the fire-and-forget CRM mirror (stripeController.ts:307), not on user state. Fix: persist processed event.ids (TTL item + attribute_not_exists) + per-sub last-event-created ordering guard. Effort M. ← core of the State Reconciliation epic.
- **googleAdsService uses bare axios, no timeout** (6 calls; only image download :681 has one) while every peer (hubspot/attio/linkedIn 15s, apollo/enrichSo 30s) uses `axios.create({timeout})`. Hung socket blocks forever. Fix: module-level `axios.create({timeout:15000})` + 429/5xx backoff. Effort S.
- **call_meta_ads_insights_api blocks the agent run up to 10 min synchronously** (agentModeService.ts:12441-12492): 60×10s poll, no axios timeout, unbounded pagination — the documented 41% failure source. Fix: background-job pattern (return report_run_id + separate poller) + per-poll timeout + maxPages. Effort L.
- **uncaughtException handler only logs, never exits** (server.ts:298-304) → process serves traffic in an undefined state; EB won't restart a hung-but-alive instance. Fix: log+flush+metric+`process.exit(1)`; add unhandledRejection alarm metric. Effort S.

**MEDIUM**
- **Fire-and-forget `void` re-throws → unhandled rejection that only logs** (crmFindEmailRunner.ts:80-83 records then `throw`s; called `void` at autoEnrich.ts:165 with no `.catch`). With the no-exit handler, silent in prod. Effort S.
- **Boot crons are in-process setInterval, no distributed lock** (onboardingLoop server.ts:545-561 — gated by ONBOARDING_LOOP_ENABLED; watchdog :572). Multi-instance → double-fire; restart near schedule → skip. Copy the correct `claimAction` pattern from socialEngagementExecutor.ts:168. Effort M.
- **Generation timeout releases the lock but doesn't cancel upstream work** (agentModeController.ts:50-53) — no AbortController, so orphaned generations (the Meta poll, hung axios) keep running/spending. Effort L.
- **Agent-tool gateway has no per-tool timeout** (agentToolGatewayService.ts:488) — the (real, working) repeated-failure breaker only trips after 3 failures; a first-call HANG is never counted, blocks until the 10-min outer timeout. Fix: per-effect timeout feeding the breaker. Effort M.

**LOW**
- **updateUser is get-then-write, no conditional/version guard** (db.ts:1244-1297) — per-field SET avoids whole-record clobber, but same-field concurrent writers (webhook vs settings) are last-write-wins. Effort M.

**Verified GOOD (do NOT re-flag):** the agent-tool repeated-failure circuit breaker DOES exist + is correctly wired (agentToolGatewayService.ts:107-166, 459-505 — file is flagged binary, use `grep -a`); metered LLM factory is non-blocking (llmClients.ts:118-168); payment history dedups by invoiceId+eventType; the generation lock has a wall-clock timeout that fixed the 409-busy-forever deadlock.

### B. Complexity — reduction levers (verified behavior-preserving)

- **agentModeService.ts = 24,225 LOC / ~270 methods god-object.** Extract LeadCrm (8287-10521, 22 methods), GtmPlan (7238-8287, 13), Book, Media (describeImage:5850/describeVideo:5945/performDataAnalysis:6331) — ~5,000+ LOC verbatim relocation. Effort L.
- **getMockToolResult (973 LOC switch, agentModeService.ts:4648) is benchmark-only** (only benchmark.ts:351 sets mockMode:true). Move to a benchmark module. CAVEAT: prod-tree unit tests call it via `(svc as any).getMockToolResult` (mockResponses/searchKnowledgeBase/knowledgeBaseFiles tests) — move those too. Effort M.
- **Primitives.tsx (2,340 LOC dev gallery) is eager-imported into the prod customer bundle** (App.tsx:90 static import, route :197, no lazy/DEV guard; App.tsx has zero React.lazy). Fix: React.lazy + `import.meta.env.DEV` gate. Effort S — easy win.
- **13 copy-paste model-getter methods** (agentModeService.ts:999-1197) → one `resolveConfiguredModel(settingName, fallback)`. ~185 LOC. Effort S.
- **Agent-tool gateway policy runs observe-only on every call** (agentToolGatewayService.ts:289 `allowed = !enforce || ...`; AGENT_TOOL_GATEWAY_ENFORCE set NOWHERE in tree or origin/harsha/dev) → 726 LOC of per-call eval for zero enforcement. NOTE: the "double eval" is NOT redundant (first feeds arg-repair, second runs on repaired args — don't naively dedupe). Decide: enable enforcement or make it sampled/async.
- **CRM.tsx = 11,169 LOC / 183 useState single component.** Extract state islands into hooks/subcomponents (pattern exists: LeadDetailPanel, SequenceBuilder, ExternalCrmSyncDialog). Effort L.
- **crmEnrichment V1 (106KB) + V3 (51KB+65KB) co-live mid-migration** with dual waterfalls; old service has 13 prod importers and V3 imports a type from it → tracked cutover, not blind delete. ~130KB once done. Effort L.
- **loops framework 7,356 LOC, all 4 instances env-gated OFF; ai-eval-funnel (1,384 LOC) superseded by ai-readiness-funnel (501 LOC)** — delete ai-eval-funnel incl. server.ts:588-614 block + index.ts registration. Effort M.
- **Build lever: jest maxWorkers 2→4** (jest.config.js:8 + package.json:9,11; ts-jest preset, isolatedModules already on). Cost-negative (CI isn't the gate). Optional: @swc/jest transpile-only. Effort S.
- **~11,300 `any`/`as any` in backend/src** (agentModeService 818, crm.ts 234, db.ts 161) — root enabler of god-object growth. Type the 3 hottest boundaries (ToolArgs, DynamoRecord<T>, LLMToolResult) alongside the agentModeService split. Effort L, advisory.

### C. SOTA gaps — where we lag (the models themselves are current)

Good: model IDs are current (claude-opus-4-8, claude-sonnet-4-6, gpt-5.x, gemini-3.x); prompt caching IS wired (Bedrock cachePoint, agentModeService.ts:1544); native Bedrock toolConfig used.

- **HIGH — zero extended-thinking / effort on any Claude call.** grep for thinking/reasoningConfig/effort/budget_tokens returns no model-call hits; Converse sends only maxTokens (agentModeService.ts:1567-1576). Opus 4.8 / Sonnet 4.6 support adaptive thinking + effort — the single biggest quality lever, ~free given models are current. Pass `thinking:{type:'adaptive'}` + per-surface effort (high/xhigh agent loop & codingAgent, low/medium classify/score) via additionalModelRequestFields.
- **HIGH — tool failures handled by text-injected "do not retry" guidance + SILENT tool-list truncation.** ~141 emma tools vs a 128 Azure cap → tools dropped non-deterministically (agentModeService.ts:2070); args parsed with bare JSON.parse→{} (:1328,1777); no strict schemas / structured output / programmatic arg-repair. Upstream cause of the 27/55/41% tool failures. Fix: strict input schemas + validate-before-dispatch + one structured repair; tool-search instead of truncation.
- **HIGH — no eval harness / tracing.** No Okareo, no OTEL/Sentry/Langfuse; only shadow usage metering + an internal LLM-judge (sessionScoringService.ts). The repeated silent-telemetry-table failures (3 in 2 days) are the symptom. Stand up Okareo seeded from real sessions + per-turn trace ids.
- **MEDIUM — model selection not centralized.** agentModeService has its own Bedrock/Vertex/Azure/Gemini clients separate from the metered factory (llmClients.ts); inference-profile ARN map duplicated in 3 files (agentModeService.ts:1525, codingAgentService.ts:1375, llmService.ts:74) — a model swap touches 3-4 files. Route the agent loop through the factory + one shared ARN map.
- **MEDIUM — non-streaming agent loop** (ConverseCommand not Stream; maxTokens hardcoded 12384) → long Opus/Fable turns risk request-timeout truncation. Switch to ConverseStreamCommand (factory already meters streaming, llmClients.ts:280).

### D. Learning loop — ~30-40% closes, one instance only

Architecture (sensor→policy→tools→gate→learning, host-agnostic `core/`):
- **Sensor**: agent-mode runRecorder writes real tool telemetry → Dev-AW-LoopEvents (WORKING, gated by AGENT_RUNTIME_SPINE_ENABLED). Funnel sensors wired but starved (<10 captures/wk).
- **Policy**: agent-mode failure-clustering (DSL, no LLM) WORKS; the LLM-analyst policy used by ai-readiness + onboarding-V2 is INERT — the prod Bedrock adapter throws unconditionally (awsAdapters.ts:151-156), analyst swallows it → zero proposals from those two loops.
- **Gate**: CaptureGate.pollDecision() always returns 'pending' (captureGate.ts:30-34); no SlackReactionGate exists. Real approval is OUT-OF-BAND: digest DM → Harsha ✅ → routes/slack.ts:582 → recordLoopApproval. **CORRECTION to earlier notes (incl. the 2026-06-13 "wrote to a void" entry below): shippedAt IS now stamped** (approvalPersistence.ts:102-112) now that Dev-AW-LoopLearning exists.
- **THE structural break (highest-leverage, new): proposal-provenance bug.** orchestrator.ts:163-169 writes the pending record WITHOUT the `proposal` field; recordLoopApproval copies that undefined forward (approvalPersistence.ts:105-110); CooldownRuleSet.onCooldown (cooldownRuleSet.ts:61) and lastOutcomeForRule (dynamoLearningStore.ts:89) both key on `proposal.sourceRuleId` = undefined → the policy can NEVER read back its own outcomes. The loop records verdicts it structurally cannot consume. **Fix: carry `proposal` onto the pending record in orchestrator.ts:163-169 (~3 lines).** This is the one thing that makes everything else matter.
- Other gaps: analysis runs env-gated (likely OFF in prod) → attribution has nothing to grade; loop tables hardcoded to Dev- prefix (eventTableEventSource.ts:27, dynamoLearningStore.ts:27) even in prod.

**Verdict:** plumbing is genuinely impressive; ~30-40% closes for the agent-mode loop only (live sensor → DSL policy → fix-spec → ✅ → Notion+cloud-dev → shippedAt). It does NOT yet learn because (1) LLM-policy loops inert, (2) outcome read-back severed by the proposal bug, (3) gated on manual ✅ + likely-off flags. Fix order to actually close it: (1) proposal-provenance ~3-line fix; (2) implement awsBedrockAdapter.invoke against the existing Claude client; (3) confirm prod AGENT_RUNTIME_SPINE_ENABLED + AGENT_MODE_LOOP_ENABLED ON; (4) env-aware loop table names.

### Assumptions to validate
- **Stripe Scan blast radius:** check current `AW-Users` size + whether a `stripe_customer_id` GSI already exists in prod. If the table is already >1MB, billing events are ALREADY being dropped — look for webhooks that Stripe retried then gave up on. (Falsified if a GSI exists / table is small.)
- **"Settings.gmail crashes blocking Mega PR #600" is UNVERIFIED** (read-only audit) — the test has no skip markers and mocks cleanly, so a crash is likely environmental (jsdom/act), not a code defect.
- **Prod EB instance count (single vs multi)** sets the blast radius of the cron-lock + in-memory-breaker findings.
- **Which loop env flags are true in prod** (AGENT_RUNTIME_SPINE_ENABLED, AGENT_MODE_LOOP_ENABLED, AI_*_LOOP_ENABLED) — determines whether the learning loop runs at all.
- **Prod table prefix:** recorder/learning hardcode `Dev-AW-LoopEvents`/`Dev-AW-LoopLearning`; confirm prod isn't expecting unprefixed `AW-Loop*` (which would also be missing).

## report_product_issues was never on the EXTERNAL MCP surface — #1851 enriched the wrong registry (2026-06-13)

Reconnecting the claude.ai Emma connector surfaced that `report_product_issues` is not exposed to it at all. Root cause: AgentWeb has TWO tool registries — `emmaToolRegistry` (in-app Emma chatbot/agent mode, ~141 tools) and `mcpToolRegistry` (the EXTERNAL MCP server at api.agentweb.pro/mcp that claude.ai connectors talk to, ~72 tools from apiTools.ts). `report_product_issues` is registered only on `emmaToolRegistry`. PR #1851 enriched it there (attachment_urls, run_id, MCP-source tag) and its test asserted against `emmaToolRegistry` — so it went green while testing a surface the external connector never sees. Net: in-app Emma got the enrichment; Claude-Code-via-MCP bug reporting (the actual goal) was unreachable.

### Fix (this PR)
One-line bridge in emma/tools.ts after the registration block — `mcpToolRegistry.register(emmaToolRegistry.getTool('report_product_issues'))` — same pattern the codebase already uses for `visualContextTool` (tools.ts:5973). The handler reads `context.userId` (agentUserId for external clients) and `context.externalMcp` (true only on the external server, for the MCP Reported tag), so the same handler is correct on both surfaces.

### Lesson (process)
When a tool must be reachable from the external MCP connector, the test MUST assert against `mcpToolRegistry` (the external surface), not `emmaToolRegistry`. The new test `mcpReportProductIssuesExposure.test.ts` guards exactly this. Two registries existing is itself latent complexity — future consolidation candidate, but out of scope here.

### Assumptions to validate
- After deploy + connector refresh, `report_product_issues` appears in the claude.ai Emma tool list with attachment_urls + run_id. Falsified if the connector still doesn't show it — would mean the external server caches tool lists beyond a reconnect, or apiTools registration order drops the late bridge.

## Fix: self-healing telemetry-table provisioning — close the silent-missing-table class (2026-06-13)

Three missing-table incidents in two days (AW-OnboardingMetrics, Dev-AW-LoopLearning, and the loop tables) shared one root cause: tables are defined in create-tables.ts but the script is never run on deploy, and every writer swallows ResourceNotFound — so an absent table is invisible until someone reads the data weeks later. For the loop tables the entire gate→attribution→verdict chain ran as a no-op with zero signal.

### What shipped (this PR)
- `services/ensureCriticalTables.ts` — idempotent, non-fatal boot-time ensure for the three critical telemetry tables (LoopEvents, LoopLearning, OnboardingMetrics). Table-name constants imported from the modules that WRITE them, so the ensure can never drift from the writers. createTable swallows ResourceInUseException; any other failure logs loudly ("telemetry for this loop will be lost until fixed") but never blocks startup.
- Wired fire-and-forget into `server.ts` boot (after listen). On every deploy, missing telemetry tables self-create.
- Added the missing `createOnboardingMetricsTable()` to `scripts/create-tables.ts` (it was never in the script — the source-of-truth gap that caused the 2026-06-12 incident).

### Why self-heal instead of "run the script on deploy"
No ops dependency, no risk of a hard boot crash, and it fixes past + future instances in one place. Matches the silent→loud principle: the only way a missing telemetry table now persists is if createTable itself is denied, which logs an ERROR every boot.

### Assumptions to validate
- After deploy, prod logs show either "created missing table X" once or nothing (all present). A recurring "could NOT ensure" ERROR = IAM lacks CreateTable; fix the role.
- This does NOT cover non-telemetry tables (users, tasks, etc.) — those predate the issue and are assumed present. If a core table ever goes missing the symptom is louder (immediate 500s), not silent, so they are intentionally out of scope here.

## Dev-AW-LoopLearning table was missing — the entire gate→attribution→verdict chain wrote to a void (2026-06-13)

Checking for pending-approval proposals (now that gate persistence #1841 is live) surfaced that **`Dev-AW-LoopLearning` did not exist in this account.** `dynamoLearningStore.ts:27` hardcodes the table name; `scripts/create-tables.ts:2043` defines `createLoopLearningTable()` — but the script was never run against this account, so the table was absent. Every `learning.record()` (proposals, approvals, shippedAt, verdicts) hit ResourceNotFound and was swallowed best-effort.

Impact: the whole point of the "close Layer 4→5" sprint was inert. Even after #1841 wired Slack approvals to write shippedAt, the write went nowhere — so CooldownRuleSet read empty history, attribution had nothing to grade, and a ✅ on any loop proposal (e.g. the AI-readiness quiz-start-leak) would never reach a learned/regressed verdict.

**Fix applied 2026-06-13**: created `Dev-AW-LoopLearning` in us-west-2 (PK `loopId` HASH / `sortKey` RANGE, PAY_PER_REQUEST) mirroring the create-tables definition. The loop can now persist decisions.

### Systemic finding (third instance)
This is the THIRD table defined-in-code-but-never-created in this account: `AW-OnboardingMetrics` (2026-06-12), now `Dev-AW-LoopLearning`. Root cause: `create-tables.ts` is not run when new tables are added, and every writer is best-effort/swallowed so the absence is invisible until someone reads the data. **Follow-up: run `NODE_ENV=... create-tables.ts` against dev AND prod as part of deploy, or add a startup assertion that required tables exist (fail loud, not silent).**

### Assumptions to validate
- After this table exists, the next ✅ on a loop proposal should write a record with decision + shippedAt, visible via `GET /api/admin/loops/health` moving that loop to `in_flight`. Falsified if health still shows `empty`/`pending_approval` after an approval — would mean the prod backend uses an unprefixed `AW-LoopLearning` that ALSO doesn't exist (check prod table list).
- Prod (NODE_ENV=production) may resolve a different table name than dev. The recorder hardcodes `Dev-AW-LoopEvents` (env-agnostic); confirm the learning store does the same vs. honoring a prefix — if prod expects unprefixed `AW-LoopLearning`, that table needs creating too.

## Landing-Page Generation Failures — Empathia Incident Root-Cause + Durable-Execution/Multi-Site Fix (2026-06-12)

Triggered by Angela (Empathia, `demo@empathiaai.com`, userId `a643f408-4ddf-4790-a9ae-4aa7f99de87a`) reporting landing-page "bugs, it's matching things" during an active evaluation (decision ~Jun 17–18; campaign sends Jun 15). Reconstructed prod session `332dafe1-ec34-44c5-a55a-40ae4131a43a` (Jun 8, 14:03–14:55 UTC) from `AW-ChatMessages`. Five failures in one 52-minute session; they collapse into **two root causes**, both the same shape: **identity is implicit and reconstructed by runtime heuristics.**

### What failed (timeline)
1. **14:03 — attachment never read.** `read_knowledge_base_files` → "Knowledge base not found"; fallback file read threw `Cannot read properties of undefined (reading 'startsWith')`. Page built WITHOUT the product doc. Separate bug.
2. **14:13 — timeout lie #1.** Run hit `GENERATION_TIMEOUT_MS` (600s, `agentModeController.ts:55`) while `generate_landing_page` was still running (its MCP timeout is 25min, `apiTools.ts:1301`). The run lost a `Promise.race`, released the session lock, and showed "took longer than expected" — but the generation was **not aborted; it kept running detached and updated `AW-LandingPages` to `deployed`** (`agentModeController.ts:50-53`). Nobody reconnected to it.
3. **14:15 — prompt-as-name → poisoned repo.** Page `name` was the full multi-line prompt → broke the Next.js build and blocked all later builds; `deploy_landing_page` 404'd. (Prompt-as-name now capped/slugified at `landingPageGeneration.ts:335` / `v0Service.ts:104`.)
4. **14:42 / 14:54 — timeout lie #2**, two manual retries before it went live. Each retry started a *new* build racing the first (lock already released) — the source of the poisoned repo.
5. **Wrong project/subdomain.** Final URL `empathia-ai-cardiology-demo.agentwebforms.com/front-desk-emma-empathia-ai` — physician campaign on a subdomain named after a Jun 1 throwaway demo.

### RC1 — no durable job identity (telemetry ≠ durability)
The spine in flight (Agent Run/Event/Tool Gateway) is *telemetry* — makes failures visible, orthogonal, does NOT fix this. The failure is *durable execution*: the long tool runs inside the HTTP request; on run-timeout the work detaches and finishes but nothing reconnects → the timeout lie + the retry race. Rui's Jun 9 point (a redeploy on a long backend task "causes problems… also for other users") is the same class and correct. Fix: a tracked job (`originatingSessionId` + atomic `claimedCompletionAt`) — on late completion, post back into the session (`io.to('user:'+userId)`, primitive exists `gtmPlan.ts:1499`; `addMessagesToSession` already persists). A retry **reconnects** to the in-flight job instead of starting a second build. **Honest limit:** in-process detachment survives a run-timeout but not a backend redeploy — a `dripSequenceWorker`-style poller is the redeploy backstop; full mid-build survival is the eventual separate-engine's job.

### RC2 — no site identity
`findUserSiteRecord` (`v0Service.ts:2482`) returns the oldest repo forever (+ a read-time `isRootPage` mutation inside a `find`), so every page is a route in page #1's project and the subdomain is frozen to page #1's name. Fix: explicit `siteId` on each page; the tool gains `site_id` (omit → new site with its own domain; pass → add to existing). Opt-in, existing single-site users backfilled to their root id (byte-identical).

### Why the fix REDUCES complexity (the point)
Both bugs are heuristics compensating for missing explicit identity. Adding `siteId` + the job marker lets us DELETE: `findUserSiteRecord`'s 3-way guess + its read-time mutation; `isOrphanedFailedPage` + `cleanupOrphanedFailedPages` + the reusable/recyclable orphan-scavenging scan in `generateLandingPage` (these exist only to scavenge orphans the missing lifecycle creates); and the landing-page false-failure diagnostic branch. One explicit job+site identity model replaces four scattered heuristics, a side-effecting finder, and a lie. Flag-gated `DURABLE_LANDING_GENERATION`, fail-open, scoped to landing-page generation. Full spec: `docs/durable-execution-rc1-spec.md`. Plan: `~/.claude/plans/swift-humming-meadow.md`.

### Assumptions to validate
- The `startsWith` crash (#1) reproduces independently — needs its own repro/ticket.
- Late completion's `responseMessages` may be persisted before OR after the timeout race; the hook must handle both orderings (suppress the false-failure message, never double-append).
- Re-pointing Empathia's *current* live page is operational (custom-domain tooling); the multi-site change only prevents the *next* page from repeating it.

## Lander funnel was unmeasurable from agent-tool telemetry — service/route-layer lifecycle sensor added (2026-06-12)

Attempting to answer "why do 32 landing-page sessions produce only 3 publishes" exposed two instrumentation holes that made the funnel analysis come back blind (24 "created" sessions, 0 visible previews/publishes/errors — obviously wrong):

1. **The runtime spine only sees agent tool calls.** The lander lifecycle spans two channels — Emma tools AND portal UI buttons — and UI actions never touched the spine. The agent tools call the same `/api/landing-pages/v0/*` routes via `mcpFetch` that the UI calls directly, so the routes are the single chokepoint both channels share.
2. **`create_html_file` is generic** (email templates, analysis outputs), so tool-name-based session classification over-counts "landing-page sessions."

### What shipped (this PR)

- `services/landerLifecycleEvents.ts` — best-effort emitter (same swallow-errors contract as AgentRunRecorder) writing `lander_created / deploy_retried / iterated / edited / published / publish_reverted` events into the shared `Dev-AW-LoopEvents` table under loopId `lander-lifecycle`, keyed by pageId, with dimensions: channel (`agent`/`ui`), mode (`cold_start`/`incremental`), outcome, userId, sessionId.
- Hooks in all six mutation routes in `routes/landingPageGeneration.ts` (generate incl. failure path, deploy, iterate, github-edit, publish, revert-publish).
- `mcpFetch` now sends `X-AgentWeb-Channel: agent` so routes can attribute agent-channel requests; absence of the header = UI.

Complexity note: net simplification — a few emit lines replace an entire class of inference (guessing artifact lifecycle from ambiguous tool names across channels). No new tables, no new loop registration (sensor-only v1; events are queryable but the loop has no policy/manifest yet — deliberately, until the funnel data says what the policy should be).

### Assumptions to validate (next 1–2 weeks)

- **The routes are the complete chokepoint.** Falsified if landers get created/published through any path that bypasses these six routes (e.g. a batch job or admin script) — check for pageIds in the landing-pages store with no `lander_created` event.
- **Real funnel numbers within ~1 week of deploy**: cold-start publish rate, where sessions die (created→never-touched-again vs iterated→abandoned vs published). The June 12 estimate (9% publish rate) is unverified until this data exists.
- **Channel split matters**: expectation is agent-channel creations dominate, UI-channel publishes dominate. If everything is one channel, the header plumbing was unnecessary (cheap, but note it).
- **Junk-lander rate**: count of `created` events with no subsequent lifecycle event after 48h — the candidate definition of "junk." If that definition misfires (users legitimately park drafts for weeks), redefine before building any cleanup.

### Follow-up (deliberately NOT in this PR)
- Eval-loop wiring: commit-point (`lander_published`) → Slack tag to Matt with the Emma session link; enrichment execute → Fangfang (~5/wk and ~7/wk projected). Blocked on this sensor accumulating ~1 week of data first.

## Prod AW-OnboardingMetrics table was missing — heartbeat blind since launch (2026-06-12)

The onboarding heartbeat's recurring "No step timing data found yet; verify AW-OnboardingMetrics writes" warning had a trivial root cause: **the prod table `AW-OnboardingMetrics` never existed**. `Dev-AW-OnboardingMetrics` exists (100 items — dev writes work), but there is no entry for it in `scripts/create-tables.ts`, so the dev table was created ad-hoc and prod never got one. Every prod write hit ResourceNotFound and was swallowed by `logStepMetric()`'s fire-and-forget catch; the heartbeat's read hit the same missing table and degraded to empty.

**Fix applied 2026-06-12**: created `AW-OnboardingMetrics` in prod (us-west-2) via aws cli, mirroring the dev schema — PK `metricId` (S), GSI `StepStartedAtIndex` (`step` HASH / `startedAt` RANGE, ALL projection), PAY_PER_REQUEST.

### Assumptions to validate
- Step metrics should start appearing in tomorrow's heartbeat ("Step timings" section non-empty) as users complete brand/ICP/ad steps. If still empty after 48h with real onboarding activity, the writer has a second issue (IAM PutItem permission is next suspect).
- The 86% "(unset)" funnel state is a SEPARATE, expected artifact — legacy users predate `onboardingStage`; only users emitting onboarding events get a stage. No fix needed unless we want a backfill migration.

### Follow-up
- Add `AW-OnboardingMetrics` to `scripts/create-tables.ts` so environments stop diverging ad-hoc (small PR).

## Replay-eval groundwork — failed runs become eval cases (2026-06-12)

Frontier-agent robustness pattern: failed trajectories become regression tests. The spine records every run; nothing turned the failed/degraded ones into reusable eval material. This is the Phase-4 seed (white-box beats Okareo — we own the trace).

### What shipped (this PR)

1. **`loops/scripts/exportEvalCases.ts`** — CLI: queries agent-mode spine events (default 7d), exports each failed/degraded run as a JSON eval case (verdict + reasons, per-failure toolName/errorClass/errorMessage, decision context with upstream-redacted arg previews) plus a worst-first `toolName × errorClass` cluster summary. Output to `backend/eval-cases/` — gitignored, fixtures never committed.
2. **Pure core** (`buildEvalCases` / `summarizeEvalCases`) exported for tests + future runners. Pre-verdict-era runs are judged by `computeRunVerdict` over their counts so history exports too.

### How this becomes the eval harness

1. Run the export → `_summary.json` names the worst clusters (June data: linkedin_outreach × invalid_args, run_local_agent_task, legacy search × rate_limit).
2. Harsha + Fangfang curate: pick top clusters, write HUMAN expected-behavior assertions per cluster (per loop-acceptance-tests discipline).
3. v2 runner replays curated cases against the current contract layer / tool schemas on change — regression suite from production failures.

### Assumptions to validate

- Run the export once against real data: `cd backend && npx ts-node src/loops/scripts/exportEvalCases.ts --days 7` — expect ~35 cases. If far fewer, the grouping window or the tsSession key-condition prefix logic needs a look.
- Arg previews are sufficiently redacted for fixture storage (they go through AGENT_RUNTIME_REDACTED_ARG_KEYS upstream); spot-check one case file before sharing any externally.

## Post-run outcome verdicts — degraded-run detection (2026-06-12)

Telemetry blind spot: 165 runs in the June window, ZERO hard failures, 60+ tool failures silently absorbed. "Completed" ≠ "succeeded" — the user feels the degradation but nothing durable records it, so the agent-mode loop (whose sensor reads spine events) could never learn from degraded runs. The inspector's read-time flags don't help the policy: they exist only in the projection.

### What shipped (this PR)

1. **`agent_run_verdict` spine event** emitted alongside every terminal run event. Dims: `verdict: ok|degraded|failed`, machine-readable `reasons`, counts.
2. **`computeRunVerdict()`** (pure, exported): failed terminal → failed; ≥3 failed tool calls OR ≥1/3 failure ratio OR same tool failing ≥3× (the linkedin_outreach retry-spiral shape) → degraded; else ok. Thresholds tuned so the typical healthy-but-imperfect run (28 calls, 1-2 failures) does NOT flag.
3. **`maxSameToolFailures`** computed at both run-completion call sites from the toolCalls array — catches retry spirals a low overall ratio hides.
4. **Inspector surfacing**: `outcomeVerdict`/`outcomeReasons` on run summaries + a `degraded_run` warning flag.

### Assumptions to validate

- Degraded-rate baseline: expect ~20% of runs degraded based on June data (35/165 runs had ≥1 failure; threshold ≥3 cuts that down). If >40% flag degraded, thresholds are too tight to be actionable.
- The agent-mode loop's failureRuleSet does NOT yet consume verdict events — next step is a policy rule that clusters degraded runs by reasons + dominant errorClass. Verdicts accumulate from deploy time so that rule will have data when written.
- One extra event per run (~165/day) is negligible Dynamo volume.

## Semantic tool-error taxonomy + contract-layer counters (2026-06-12)

Telemetry finding from the June 9-12 window: every recorded tool failure had errorClass "Error" — tools throw plain `new Error(message)`, so the constructor-name fallback carried zero signal. The failure policy could only cluster by toolName; the model (and the breaker) could not distinguish retryable timeouts from terminal auth failures.

### What shipped (this PR)

1. **`utils/toolErrorClassifier.ts`** — `classifyToolErrorClass()`: stable semantic classes `timeout | auth | rate_limit | invalid_args | not_found | network | upstream_5xx | policy_blocked | repeated_failure`, derived from gateway error names, numeric status props, and message heuristics. Unrecognized errors keep the legacy name-based class (named custom errors lose nothing).
2. **Run recorder** uses it for `errorClass` on `agent_tool_failed` / `agent_run_failed` events.
3. **Decision telemetry counters** (#1818 follow-up): `argsRepairedCount` (contract layer repaired args pre-execution) and `schemaErrorCount` (failures classified invalid_args) per decision event — the data needed for the AGENT_TOOL_GATEWAY_ENFORCE go/no-go.

### Assumptions to validate

- The taxonomy covers the real distribution: after a few days, `SELECT errorClass COUNT` on new agent_tool_failed events should show <20% falling back to legacy names. If higher, extend classFromMessage patterns from actual messages.
- Provider 429s → rate_limit and Meta 5xx → upstream_5xx in prod (heuristics verified against June messages, not live traffic).
- errorClass consumers (failureRuleSet clustering, inspector) benefit rather than break from the rename — historical events keep old classes, so mixed-class clusters during transition are expected for ~7 days.

## Approval persistence closes the learning loop (Layer 4→5) (2026-06-12)

The June 8 audit's last open item: Slack ✅ approvals dispatched cloud-dev fixes but never wrote `decision`/`shippedAt`/`verdict` back to `Dev-AW-LoopLearning`. Net effect measured this week: CooldownRuleSet was wired but inert (reads `shippedAt`, always null) and the 18:00 UTC attribution cron had zero gradable records. The system sensed and proposed but could not learn.

### What shipped (this PR)

1. **`loops/core/learning/approvalPersistence.ts` — `recordLoopApproval()`**: finds the run's `decision:'pending'` records by the digest's Run ID, appends one `decision:'approved'` record per proposal with `shippedAt` set when its dispatch succeeded. Dispatch failures are recorded approved-but-not-shipped with `mutation.error` — auditable, still re-proposable.
2. **Dispatcher wiring** (`loopSlackApprovalDispatcher.ts`): both dispatch branches persist after launching, post a `📒 Learning store: N approved, M shipped` thread line, and loudly warn when no pending records match (legacy digests).
3. **Test-double parity fix**: `InMemoryLearningStore` status/ruleIds filters passed records with no decision/proposal; `DynamoLearningStore` excludes them. Aligned in-memory to Dynamo semantics — test doubles must match prod behavior or tests lock in bugs.

### Matching semantics (deliberate)

Digest item ↔ proposal matching: exact `sourceRuleId`, `:slug` suffix (AI Readiness analyst ids), `proposalId`, or `mutationId`. Unmatched proposals (generic digests use synthetic ids) are marked shipped only when EVERY dispatch succeeded. Bias: when uncertain, leave a rule re-proposable rather than wrongly suppress it for the 14-day cooldown.

### Assumptions to validate

- Digest Run IDs uniquely identify one loop's run (sort-key collision across loops would mis-attribute approvals).
- The first ✅ on a digest covers all its items — partial approval (✅ some items only) is not modeled; v2 could parse per-item reactions.
- Attribution at 18:00 UTC will now grade these records once the settle window elapses — verify the first `improved/regressed/no_change` verdict appears in `/api/admin/loops/health` within ~windowDays of the first persisted ship.
- The `📒 Learning store` thread line appears on the next real ✅ (first live validation of the whole write path).

## AgentRun Telemetry Failure Analysis → Gateway Circuit Breaker + Tool Guidance Fixes (2026-06-11)

First product decision driven by the runtime-spine telemetry. Analyzed all 3,172 agent-mode events in `Dev-AW-LoopEvents` (June 9–12: 223 runs, 1,016 tool calls, 78 failures = 7.7% tool failure rate; 35 runs had ≥1 failure; zero hard run failures — failures are absorbed and runs "complete" degraded).

### Top failure clusters found

- `linkedin_outreach` 16/59 (27%) — the single worst run retried it **15 times in 16 seconds**: 7× "Invitation message is too long (201–231 chars)" then 6× blind "Invalid parameters" retries in the same second.
- `run_local_agent_task` 11/20 (55%) — model keeps sending out-of-scope tasks; rejection message only echoed the forbidden regex.
- Legacy search tools ~41% (429 rate limits), `call_meta_ads_insights_api` 41% (sync wait on slow async job) — NOT fixed here; belong to search consolidation / background-job pattern respectively.

### Root cause of the LinkedIn cluster — misleading schema text

The tool schema said "message must be 300 characters or fewer". The real limit is **per-account: 200 free / 300 Premium** (`linkedInOutreachService.ts` `INVITE_MESSAGE_MAX_CHARS_FREE`). Every too-long failure was 201–231 chars — the model was *obeying the documented 300* and failing on a free account. Lesson: when telemetry shows the model consistently landing in a narrow wrong band, suspect the tool description before the model.

### What shipped (this PR)

1. **Per-run repeated-failure circuit breaker** in `agentToolGatewayService.ts`: same tool + same error head (80 chars) failing ≥3× in one run → subsequent calls return `AgentToolRepeatedFailureError` with model-visible "do not retry / change approach" guidance, without executing. A success for the tool clears its counts (mixed batches not punished). Keyed by `runId` (threaded from `agentRuntimeRunId` at both gateway call sites); no runId = no breaker, so non-AgentMode callers are untouched. State is in-memory, capped at 500 runs (oldest evicted) — acceptable because a runaway retry loop is intra-run by nature.
2. **Schema descriptions** for `linkedin_outreach` now teach 200-free/300-premium + "don't invite FIRST_DEGREE connections, use send-message" (the already-connected failure, independently the same branch Fangfang is adding to the event-lead skill).
3. **`run_local_agent_task` rejections** now state the read-only browsing scope and name the right alternative tools (`coding_agent`, `perform_data_analysis`, `search_web`).

### Assumptions to validate against next week's telemetry

- **Breaker threshold 3 / error-head 80 chars is right.** Watch for `AgentToolRepeatedFailureError` in `Dev-AW-LoopEvents` (it flows through the normal toolFailed path, so it's queryable via `/api/agent-runs`). If legit retry patterns trip it (e.g. polling tools that fail transiently), raise threshold or exempt tool classes.
- **The schema text alone fixes the too-long cluster.** If 201–231-char invite failures persist after deploy, the model isn't reading the description and the fix moves to a gateway pre-flight that knows `is_premium` from config.
- **Enforcement stays narrow.** This breaker is deliberately the ONLY enforcing gateway rule; `AGENT_TOOL_GATEWAY_ENFORCE` (policy flags) stays off pending trace review per PR #1808.
- **In-memory breaker state is fine on EB single-instance.** If prod backend scales to multiple instances, breaker counts fragment per instance — degrades gracefully (each instance still breaks at 3), but note it.

### Not fixed, filed for owners

- Legacy search-provider 429s (consolidate on `search_web` at 1% failure) — Rui/backend.
- Meta Insights timeout → background-job + poll pattern (same shape as CRM push #1791) — Rui.
- `coding_agent` landing-page auth — already fixed by Rui's open #1835.

## Resend Sender Domain DKIM Verification Failure — mail.incentivpay.com (2026-06-11)

Reported by user `info@pmps.ai` (userId `1359ace4-0565-4018-9926-f51efdcf4c47`): the email sender domain `mail.incentivpay.com` shows DKIM **failed** in Resend even though the user says they added the DKIM record in GoDaddy. Investigation only — no code changed.

### What the live data shows

The DB side is **correct** — no app/wiring bug. User `info@pmps.ai` is properly linked: `emailDomain = mail.incentivpay.com`, `resendDomainId = 7d133b9e-663d-4faf-8a89-ec88d60c49e7` (matches the Resend domain). (Lookup was a one-off scan of the prod `AW-Users` table by email/emailDomain/resendDomainId.)

Resend domain state (prod account, id `7d133b9e-663d-4faf-8a89-ec88d60c49e7`, US East, created 2026-06-02), pulled live from `GET https://api.resend.com/domains/{id}`:

| Record | Host (relative) | Type | Resend status |
|--------|-----------------|------|---------------|
| SPF (MX) | `send.mail` | MX | ✅ verified |
| SPF (TXT) | `send.mail` | TXT | ✅ verified |
| **DKIM** | `resend._domainkey.mail` | **TXT** | ❌ **failed** |

DKIM value Resend expects (TXT): `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCZNDIpPbcMn89NOxV5JtOfgx28SS2dDrRWMB6i4eBE2QySQ7HeiHObv1eQ1rwbqeEY+v9gbA7x6r3EAa4UvTPnigYOJti70VPMbdviX+nt2lTAFtFqqWaUGLBs96lpuSSK9tRMi80Mr7OwqViESrRArLrcrmoFN+x0wnywYD2YNwIDAQAB`

The overall domain badge reads "failed" **only** because of the single DKIM row; both SPF rows already passed.

### Root cause: the DKIM TXT record is NOT actually published in DNS

Live DNS-over-HTTPS lookups (Google DoH) confirm the DKIM TXT record returns **NXDOMAIN** at the correct host and at every common GoDaddy-mistake variant, while the SPF host resolves fine:

- `resend._domainkey.mail.incentivpay.com` (TXT, correct host) → **NXDOMAIN**
- `resend._domainkey.incentivpay.com` (TXT, "forgot the .mail") → NXDOMAIN
- `resend._domainkey.mail.incentivpay.com.incentivpay.com` (TXT, GoDaddy double-append) → NXDOMAIN
- `resend._domainkey.mail.incentivpay.com` as CNAME → NXDOMAIN
- `send.mail.incentivpay.com` (SPF TXT + MX) → **resolves** ✅ (this is why SPF verified)

So the user successfully added the two SPF entries but the DKIM TXT entry is absent from the zone — never saved, saved at the wrong host, or saved as the wrong type. Domain was created 2026-06-02, so 48h propagation is long past; this is a data-entry problem, not propagation.

### Likely GoDaddy entry mistakes (in order of likelihood)

1. **Host entered as FQDN.** Resend shows the host relative (`resend._domainkey.mail`). GoDaddy auto-appends the zone, so the user must enter `resend._domainkey.mail` (NOT `resend._domainkey.mail.incentivpay.com`, which GoDaddy stores doubled).
2. **Wrong record type.** This domain's DKIM is a **TXT** record (some Resend setups use CNAME). If added as CNAME it won't match.
3. **Value truncation.** GoDaddy can split/truncate the long `p=…` TXT value.
4. **Record silently not persisted** by GoDaddy.

### Exact record the user must add in GoDaddy

- **Type:** `TXT`
- **Name/Host:** `resend._domainkey.mail`  (relative — do NOT append `.incentivpay.com`)
- **Value:** the `p=MIGf…IDAQAB` key above
- **TTL:** default / 1 hour

Then click **Verify Domain** in the portal (no Resend dashboard needed — see below).

### Verify path in our UI

There IS a "Verify Domain" button in the customer portal: CRM page → Email Sender Domain section, shown whenever the domain is registered-but-unverified, directly under the DNS records table.
- `customer-portal/src/pages/CRM.tsx:10690` — the button → `handleVerifyDomain` (`CRM.tsx:1009`) → `POST /api/crm/email-domain/verify` → `resendService.verifyDomain(resendDomainId)`, which re-queries DNS and re-renders per-record status. "Change Domain" (`handleChangeDomain`) resets the config.
- Caveat: the button only **re-checks**; it has no effect until the record actually exists in DNS. Clicking it now will keep returning "failed."

### Note: same issue on mail.pmps.ai

`mail.pmps.ai` (resendDomainId `2b581c4e-3849-49da-b70b-6fdc3ae09bfa`) is also in `failed` state in the same Resend account — likely the same DKIM gap if the user intends to use it.

### Possible product improvement (not implemented)

The DNS records table (`customer-portal/src/pages/CRM.tsx:10625-10714`) renders `rec.name` raw from the Resend API (e.g. `resend._domainkey.mail`) with only generic "add at your registrar" helper text — no note that GoDaddy/Namecheap hosts are **relative** and the root domain must not be appended. That's exactly the trap that produced this failure. A short per-provider hint ("enter the host *without* your domain") would prevent repeat cases.

## Self-Learning Loop Adoption — Health Endpoint + AgentMode as a Loop (2026-06-09)

Follow-up to the YC-style learning-loop audit + retro. PR #1799 (branch `rui/self-learning-loop-adoption`). The retro's framing: a *bug-feedback* loop (user/Emma notices → Slack/Notion → eng fixes → next bug) is useful but is **not self-learning**. A *self-learning* loop must **store the decision, ship or reject the change, measure the outcome, and feed that result back into future policy** — the five layers Sensor → Policy → Tools → Quality gate → Learning, with Layer 5 writing back into Layer 2.

### Key finding: the audit predates Harsha's hardening commit

The audit was written **before** `6665655f feat(loops): harden product learning loop` (already on `main`). That commit closed most of the *product-loop* gaps, so they did **not** need redoing:
- Prod loops (`ai-eval-funnel`, `ai-readiness-funnel`, `onboarding` v2) switched `InMemoryLearningStore` → `DynamoLearningStore` (`Dev-AW-LoopLearning`). Without durable storage the loop forgot every proposal/outcome on redeploy and could never read its own history back.
- `loops/cron/loopAttributionCron.ts` → `runLoopAttributionOnce()` wired into `server.ts` at 18:00 UTC (gated `LOOP_ATTRIBUTION_ENABLED`). For each shipped mutation whose settle window elapsed, it computes the target metric before-vs-after and writes a verdict (`improved / no_change / regressed / inconclusive`) back to the store.
- `CooldownRuleSet` wraps every live policy — reads the learning store and suppresses re-proposing a fix that is still in flight or recently regressed/did-nothing (`improved` is not suppressed).
- Registry boot-order fragility removed via idempotent `registerOrReplace*` + `getRegisteredLoopManifests()` + dedup guards in each instance; `app.ts` registration wrapped in try/catch so one failing loop can't take down the rest.

So only audit items **#6 (loop health endpoints)** and **#7 (AgentMode wired into the apparatus)** were genuinely open. PR #1799 builds exactly those.

### What was built (#6 — operator visibility)

`GET /api/admin/loops/health` (admin-only). Per registered loop it reports one of **empty / blocked / pending_approval / in_flight / learned / regressed / idle**, plus counts and the last graded outcome.
- `loops/core/health.ts` — pure `computeLoopHealth` (no I/O, exhaustively unit-tested, most-urgent-state-wins precedence).
- `loops/health/loopHealthService.ts` — reads each loop's **own** learning store; a single failing loop degrades to an `error` entry instead of failing the whole report.
- `routes/loopHealth.ts` — mounted admin-only.

### What was built (#7 — AgentMode as a first-class loop, not a parallel system)

AgentMode reuses the **same** registry, `DynamoLearningStore`, attribution cron, and health endpoint as the funnel loops. In `loops/instances/agent-mode/`:
- `eventTypes.ts` — run/decision/tool/outcome vocabulary (`agent_run_started`, `agent_decision`, `agent_tool_invoked`/`_succeeded`/`_failed`, `agent_run_completed`/`_failed`).
- Hot-path hook in `agentModeService.ts` fires these into the shared `Dev-AW-LoopEvents` table keyed by `sessionId` (the debugging timeline). Best-effort + gated, so it never slows a live chat.
- Policy `AgentFailureRuleSet` clusters failures **per tool** over a 7d window; a tool past the count+rate threshold yields a cloud-dev fix-spec proposal (wrapped in `CooldownRuleSet`).
- Target metric `tool_success_rate = agent_tool_succeeded / agent_tool_invoked`. Risky changes (code, prompts) never auto-ship.
- Daily analysis cron at 17:30 UTC.

### Known remaining gap — why no loop reaches a verdict yet

The production `ApprovalGate` is still `CaptureGate`, whose `pollDecision()` always returns `pending` — so **`shippedAt` is never stamped by a gate**, and attribution only grades mutations that have `shippedAt`. Net effect: every loop runs Sensor → Policy → Tools → Gate (DM sent) then **stalls at `pending_approval`**; it never reaches `learned`/`regressed`. The new health endpoint makes that stall visible per loop. Building a real Slack-reaction gate that sets `shippedAt` + approval status is the single remaining piece that turns the apparatus from "wired" to "actually closing the loop" — the next highest-leverage work.

### Watch plan (next ~1–2 weeks)

Letting the loops run and observing before building the gate. What to watch:
- `GET /api/admin/loops/health` — confirm `agent-mode` + the funnel loops show up and accumulate events (state should move `empty` → `pending_approval` as proposals fire). If everything stays `empty`, telemetry/ingestion isn't landing.
- Whether the AgentMode policy surfaces *real* repeatedly-failing tools (signal) vs. noise — tune the count/rate thresholds in `AgentFailureRuleSet` from what we see.
- The 17:30 UTC Slack digest: are the proposed fix-specs actionable as-is?
- Once enough loops are stuck at `pending_approval`, that's the cue to prioritize the real approval gate.
## Judge Scoring False-Negative on Brand/Topic Mismatch (2026-06-05)

Systemic pattern across 3 sessions (satisfaction score 2): when a requested content topic (email, LinkedIn post, ad, analysis) does **not** match the stored brand guidelines, the agent correctly flags the mismatch and either asks a clarifying question or proceeds with placeholders (`[Brand Name]`, `[URL]`). This is the **desired** behavior — but the satisfaction judge was scoring these sessions low (`goalCompletion` 1–2), treating the flag/clarification as a failure. The fix is to the **judge**, not the agent.

Affected sessions: `4e39ce3e-...` (Webinar follow-up email), `9456689d-...` (Sustainable Packaging LinkedIn post), `fd071af6-...` (Budgeting App ad analysis).

### Key finding: the live scoring prompt is stored in DynamoDB, not code

`DEFAULT_SCORING_SYSTEM_PROMPT` in `backend/src/services/sessionScoringService.ts` is only a **fallback**. The active judge prompts are stored in the `AW-Settings` table (prefix `Dev-` in dev, none in prod):
- key `default-scoring-prompt` — overrides the default judge prompt
- key `scoring-judges` — JSON array of custom judges, each `{id, name, systemPrompt, ...}`. **Prod** has `Fangfang Judge` (the one that produced the score-2 evals) and `Matt Judge`; **dev** has `fangfang judge`.

The stored prod prompts are richer than the code constant (extra "Expected outcomes" / "Tool Execution after Nudges" clauses), confirming the DB is the source of truth. Any scoring-behavior change must update **both** the code constant (fallback + tests) **and** the DB rows (default + every custom judge, in dev and prod).

### The clause added

Inserted immediately before the "In addition to the overall score, rate three specific dimensions" section of each prompt:

```
IMPORTANT: Brand / topic mismatch:
- If the user requests content (an email, LinkedIn post, ad, analysis, etc.) on a topic that does NOT match the stored brand guidelines (e.g. brand guidelines describe an AI marketing company but the user asks for a budgeting-app post), it is CORRECT and desirable for the assistant to briefly flag the mismatch before proceeding
- Do NOT penalize the assistant for surfacing a brand/topic mismatch, asking a clarifying question about it, or proceeding with placeholders (e.g. [Brand Name], [URL]) — this is the expected, helpful behavior, not a failure
- Only lower the score for a mismatch if the assistant repeatedly refuses to produce ANY usable output after the user has clearly pushed back and asked it to proceed anyway. Flagging once (or flagging and then delivering a best-effort draft) should score as satisfied (score ≥ 4)
- A brief flag followed by a usable deliverable is ideal; a flag with a clarifying question is acceptable and should not be treated as the user "having to repeat themselves"
```

### Where applied

- **Code (PR #1774):** clause added to `DEFAULT_SCORING_SYSTEM_PROMPT` + 4 assertions in `sessionScoring.bugReported.test.ts`.
- **Dev DB:** applied directly via an idempotent script to `Dev-AW-Settings` (`default-scoring-prompt` + `fangfang judge`).
- **Prod DB:** the user applied the clause manually via the admin Scoring settings UI (default prompt + `Fangfang Judge` + `Matt Judge`). Direct prod DynamoDB writes are intentionally blocked from the test-env EC2 role (`AccessDeniedException` on `dynamodb:UpdateItem`), and the `test@example.com` account is deactivated in prod — so prod must be edited through the admin API/UI.

## LinkedIn Invite to Gundars Katlaps — "Sent Without Approval" Investigation (2026-06-03)

Reported by user `yuan@carley.ai` (userId `5fed2022-2e0f-4534-b09f-86ae95afc035`): angry that a LinkedIn connection invite was sent to lead **Gundars Katlaps** (Chief of Thoracic & Cardiovascular Surgery, Tampa General Hospital) without his approval. Investigation only — no code changed.

### What the production data shows

Lead `AW-Leads` (listId `list_1779111185801_aop37bg0b`, leadId `lead_1780320898801_ow2ank8ty`, LinkedIn `gundars-katlaps-ba684211`) has **`linkedInInviteSentAt = 2026-06-01T16:22:11.730Z`** — the invite.

Two separate events on 2026-06-01, often conflated but NOT the same:
1. **13:34–13:35 — scheduled session** "Daily ICP Lead Finder — docuCODER" (sessionId `d68dab40-e09f-4811-a434-ad98f8843c4b`, `sessionType=scheduled`). Its 26 messages (pulled from `AW-ChatMessages`, since the inline `messages` array on `AW-ChatSessions` is empty) show `linkedin_outreach` called 4× — **all `search-people` (read-only)** — plus one `add_leads_to_list`. This is only how Katlaps got *added to the CRM list*. **No `send-invite` occurred here.**
2. **16:22 — the invite itself**, stamped ~2.5h later, with **no chat/agent session at that timestamp**.

### Root cause: manual one-click send with no confirmation gate (NOT automation)

`linkedInInviteSentAt` is written in **exactly one place** in the codebase: the user-facing CRM route `backend/src/routes/crm.ts:4396` (`POST /lists/:listId/leads/:leadId/send-linkedin-invite`). The agent-mode `linkedin_outreach` `send-invite` handler (`agentModeService.ts:22200`) does **not** stamp it. So the invite went through the **CRM UI endpoint** — a logged-in click — not the scheduled agent and not any automation. Confirmed there is **no bulk-invite / auto-connect / drip / scheduled invite path**: the drip worker sends messages only, the sync cron is read-only, and this user has zero active schedules and zero drip/sequence enrollments.

Why it *felt* unapproved — the manual flow's UX (`customer-portal/src/components/crm/LeadDetailPanel.tsx`):
- Opening a lead's **LinkedIn tab** auto-drafts an invite note via Gemini and pre-fills the textarea (`useEffect` ~line 570, draft ~583).
- The **"Send LinkedIn Invite" button** (~line 902) → `handleSendLinkedInInvite` → `CRM.tsx handlePanelSendLinkedInInvite` (~1137) **POSTs immediately. There is no confirmation dialog.**

A single click on a pre-populated panel fires a real connection request instantly — easy to trigger thinking you're drafting/saving, especially since the note was auto-generated by an earlier scheduled lead-finder run that silently added the lead the same day.

### Recommendation (not implemented)

Add a confirmation step before the invite POST (e.g. a "Send connection request to {name}?" modal in `LeadDetailPanel.handleSendLinkedInInvite` / `CRM.handlePanelSendLinkedInInvite`), and optionally stop auto-arming the Send button on tab open. There is no automated-sending bug to fix — the gap is the missing confirmation gate on the manual action.

## Coding Agent Timeout Fix + Sonnet 4.6 vs Opus 4.8 Eval (2026-06-01)

Reported via session `ac42f498-a553-48b1-a63e-54503ec3ae33` (user `lyndi@every.io`): a landing-page compliance edit via `coding_agent` timed out before completing; the session showed "No tasks have been run."

### Root cause (FIXED)

The bug report hypothesized the edit was "too broad" and should be split into single-concern passes. **The evidence contradicts that.** Tracing the session messages against the code: both `coding_agent` calls — the broad one AND a narrow retry (font + CTA only) — returned `iterations: -1`. That value is produced *only* by the outer `timeoutPromise` in `runCodingAgent` winning the `Promise.race`; the loop never returned, didn't hit the 50-iteration ceiling, and didn't error. Task breadth was not the cause.

The trigger: the coding-agent default model (`agent_mode_coding_agent_default_model` setting) had been switched to `anthropic.claude-opus-4-8` hours earlier. Opus 4.8 routes through the bearer-token Bedrock client, which used the **blocking `/invoke` endpoint**. Each non-streaming turn (up to 16K tokens) had to fully complete before the loop advanced, and the 10-minute run budget allowed only ~2 slow Opus turns — exhausting the budget before the agent could read → edit → deploy.

**Fix (`backend/src/services/codingAgentService.ts`, 3 commits):**
- **Stream the bearer path:** replaced `/invoke` with `invoke-with-response-stream`. Added `_parseEventStreamFrames` (hand-rolled `vnd.amazon.eventstream` binary frame parser, no new dependency) + `_accumulateBedrockStream` (folds the streamed Anthropic events back into the exact `Anthropic.Message` the loop already consumes — `create()` contract unchanged). Wire format was empirically confirmed against the live dev endpoint (text + tool_use) before writing the parser.
- **Coherent timeouts:** replaced the fixed 5-min per-request cap with a **2-min inter-chunk idle timeout** (a long-but-progressing generation is healthy; only true stalls abort), and raised `AGENT_TIMEOUT_MS` 10m → 20m so several legitimate slow turns fit.
- **Honest aborts:** idle-timeout aborts are tagged `status: 408` + `isTimeout`, reported as "timed out" (not swallowed as a generic error) and not retried by `callWithRetry`. Applied to both the bearer and Vertex paths.
- **Cost observability:** added a guarded `context.onUsage` hook (the loop previously discarded `response.usage`); no behavior change when unset.
- Tests: `codingAgentService.test.ts` (+8) cover frame parsing (whole/partial/multi), message reconstruction, empty-stream → retryable 5xx, throttling-exception → 429, and 408-is-reported-not-retried. 61/61 pass. Verified end-to-end in a real browser (Opus 4.8 path completed iters=6, deployed, preview headline correct).

### Eval: Sonnet 4.6 vs Opus 4.8 (recommendation: STAY ON SONNET 4.6)

Built a real eval harness driving the actual `runCodingAgent` loop against a real test page (24 runs: 4 edit tasks of increasing complexity × 2 models × trials). Each run used a fresh `draft/` branch, deployed to a real Vercel preview, and correctness was scored objectively from the deployed DOM (required strings present, replaced strings absent). Cost measured via the `onUsage` hook. Eval branches/PRs cleaned up after.

| Metric | Sonnet 4.6 | Opus 4.8 |
|---|---|---|
| Success rate | **12/12 (100%)** | **8/12 (67%)** |
| Correct when completed | 12/12 | 8/8 |
| Latency (avg / median) | 51s / 51s | 79s / 54s (up to 166s) |
| Cost per successful edit | **$0.09** | **$0.48 (5.3×)** |

All 4 Opus failures were identical: `Bedrock request timed out after 120s of inactivity` — the bearer-token Bedrock account intermittently stalls with zero stream bytes (one stalled on the very first call). A clean confirmation run got Opus 8/8, confirming these are intermittent infrastructure stalls, not quality issues. On correctness the models tied — Opus produced no better edits, including on the 3-change task.

**Recommendation:** keep the coding agent on **Sonnet 4.6**. Opus 4.8 offers no correctness advantage on these edit tasks while costing 5×, running slower, and being less reliable (bearer-account stalls). Prod is already set back to Sonnet 4.6. The streaming fix is still worth keeping — it makes Opus usable when the account is healthy, and its honest 408 timeout is what surfaced the stall pattern.

## CRM Lead List & LinkedIn Message Sync Bugs (2026-05-30)

Reported against list `list_1770238037853_wh6sswaay` ("LinkedIn Connections - Rui", user `be754b6c-767e-44ec-b181-4042cfe45ea9`).

### Bug A — non-connected leads show hundreds of unrelated LinkedIn messages (FIXED)

**Symptom:** "first lead not even connected but many messages are synced."

**Production data:** The list had 1,021 `linkedin-<listId>` message events. They were attributed to 10 profile URLs; one lead (`karthy-chandra`) held 996 of them. The 996 messages were the user's entire sent history to many different people, dated 2022–2024 (e.g. "Hey Kevin…"), stamped `processedAt` 2026-04-15. All events have eventId prefix `linkedin_msg_*` → they came from the **live Unipile sync** (`POST /sync-linkedin-messages`), which is auto-fired on every lead-detail panel open (`CRM.tsx openLeadDetail`).

**Root cause:** `sync-linkedin-messages` synced for any lead with a LinkedIn URL, with no connection check. For a non-connected attendee, `linkedInOutreachService.getMessagesWithContact()` → `getAllChatsFromAttendee()` resolves to an unrelated chat and `getAllMessagesFromChat` dumps up to `MAX_PAGES*100` (~1000) messages onto that one lead. Cross-checked `AW-UnipileConnections` for account `LIBGE2pYS1eckwgo7wUIGQ` (69 real connections): **every** lead that received messages (karthy-chandra, billnbarry, aviharsh, …) is `connected=false`.

**Fix:**
- `crm.ts` `POST /sync-linkedin-messages`: gate on connection. Resolve the account as `list.linkedInAccountId || resolveAccountId(userId)`, then `getConnectionByProfileUrlAndAccount(leadLinkedIn, accountId)`. If not connected, stamp `linkedinMessageSyncAt` (so auto-sync doesn't re-hit Unipile every open) and return `{ synced: 0, connected: false }` without writing events. Connection cache is refreshed every ~10 min by `linkedInConnectionSyncCron`, matching the panel's 10-min auto-sync throttle.
- `linkedInOutreachService.getMessagesWithContact`: defense-in-depth — return `[]` if the resolved chat has no `id` (an empty `chat_id` makes Unipile return account-wide messages).
- Tests: `crm.syncLinkedInMessages.test.ts` (skip when not connected, stamp syncAt, prefer list account, `connected:true` on success).
- Cleanup of existing bad data: `backend/src/scripts/cleanup-misattributed-linkedin-messages.ts` (dry-run by default). Dry run on this list flags all 1,021 events for deletion (all attributed to non-connections). NOT yet applied to prod — destructive, awaiting approval.

### Bug B — "Lead list not found" when clicking leads + auto-sync (FIXED — hardening)

**Symptom (clarified by user):** "When I click on a lead, it will auto sync LinkedIn and I see the lead list not found error when I clicked many leads."

**Investigation:** Clicking a lead → `openLeadDetail` fires two background actions for this list (it has a `linkedInAccountId` and leads have LinkedIn URLs): the LinkedIn message auto-sync (`POST .../sync-linkedin-messages`) and, for leads without a draft, an agent-mode auto-draft. Both, plus `GET .../engagements`, call `getLeadListById(selectedList.listId)` and return 404 `'Lead list not found'` only when that listId does not exist. The referenced list and its 37 leads exist, and normal clicks send a valid id — so the 404 indicates a **stale `selectedList`**: a list deleted/recreated in another tab/session or by a re-import while the open tab kept the old id. "Many leads" fits — every lead in the stale view 404s on click. Confirmed a real correctness gap: `fetchLeadLists` only *updated* `selectedList` when the list was still present and never *cleared* it when gone, so the stale selection persisted and each lead click kept 404ing.

`handleDynamoDbError` always rethrows, so throttling under load yields a 500, never this 404 — ruling out load as the cause.

**Fix (customer-portal `CRM.tsx`):**
- `fetchLeadLists`: when the previously-selected list is no longer in the refreshed set, clear `selectedList`, close the detail panel, and drop the selected lead — so clicks stop auto-firing against a dead listId.
- Added `isLeadListNotFound(err)` + `handleStaleLeadList()`: on a 404 `'Lead list not found'` from the lead-click auto-sync or `fetchEngagements`, show a single toast ("Lead list unavailable …") and refresh lists (self-heal), guarded by `staleListNoticeRef` against toast spam across many clicks.
- Test: `CRM.test.tsx` "Stale lead list self-heal".

NOTE: this hardens the stale-list path (the only code path that yields this 404 on the click flow). If the user still sees it on a list that genuinely exists, the next datum needed is the exact `listId` in the failing Network request vs. the URL's listId.

## Gemini Interactions API Sunset — June 8, 2026 Assessment (2026-05-27)

### Background

Google sent a notice that the legacy schema in the **Interactions API v1 beta** will be permanently removed on June 8, 2026. After that date, the `Api-Revision: 2026-05-07` opt-out header stops working, and older SDK versions (Python 1.x, JS 1.x) will fail.

Affected Google Cloud projects: `gen-lang-client-0974358743`, `gen-lang-client-0298423887`.

### Investigation

Audited all Gemini/Google GenAI SDK usage across the codebase (backend TypeScript, agent engine Python, both frontends).

**SDK versions in use:**

| Package | Version | Status |
|---------|---------|--------|
| `@google/genai` (JS) | 2.0.0 | ✅ Already on new SDK |
| `@google/generative-ai` (JS) | 0.24.1 | ⚠️ Legacy package — not sunset-related (see below) |
| `google-genai` (Python) | `>=1.8.0` pin | ⚠️ Constraint allows 1.x installs |

**The Interactions API is not used anywhere in this codebase.** All Gemini calls use standard content generation APIs (`generateContent`, `generateContentStream`, `generate_content`, `generate_content_stream`, `generate_videos`). The live voice feature (`liveVoiceService.ts`) uses `ai.live.connect()` from `@google/genai` v2, which is the new SDK.

### Conclusion

**No action required for the June 8 deadline.** The sunset only affects the Interactions API schema, which we do not use.

### Optional Future Cleanup

Two files still import the legacy `@google/generative-ai` package (separate from `@google/genai`):
- `backend/src/services/agentModeService.ts` — data analysis file processing
- `backend/src/services/imageGeneration.ts` — `gemini-2.5-flash-image` generation

These could be migrated to `@google/genai` v2 to consolidate to a single SDK, but this is non-urgent. The Python `environment.yml` pin (`google-genai>=1.8.0`) could also be tightened to `>=2.0.0`.

## perform_data_analysis: Unknown Tool Errors and Timeout in Scheduled Reports (2026-05-15)

### Problem

Session `a01ef8a3-436b-403e-96c1-6590488e57e9` ("Scheduled: Daily User Activity Report") scored 2/10. The judge reported repeated "Unknown tool" errors and a timeout during `perform_data_analysis`.

### Investigation

The schedule had run successfully on May 10, 11, 13 — all completed without calling `perform_data_analysis`. On May 14 the same Gemini model non-deterministically decided to use it for the first time.

**What actually happened in the failing run (from `calledFunctions` and `failedFunctions`):**

1. `get_chat_history`, `list_all_clients` — succeeded, output offloaded to S3
2. `__other_skills__:read_tool_response` × 3 — **"Unknown tool" errors**. The LLM hallucinated skill-prefixed tool names (e.g. `__other_skills__:read_tool_response`) before installing the skill. These show up in `failedFunctions` as `__other_skills__:read_tool_response`.
3. `install_skills` — LLM self-corrected and installed `__other_skills__`
4. `read_tool_response`, `search_tool_response` × many — worked after install
5. `perform_data_analysis` — **timed out** on the large dataset (all 24h of session data sent as a single payload)

The root cause has two parts:
- `perform_data_analysis` was not in `FOUNDATION_TOOLS` and not in any published production skill. It lived in `__other_skills__`, which requires explicit `install_skills` to access. In sessions with no `requiredFunctionCalls`, skills are not auto-installed, so the LLM had to discover and install `__other_skills__` on its own — leading to the hallucinated prefixed tool names while it was figuring out the skill system.
- Once the tool was accessible, calling it with a full 24-hour dataset in a single request hit the 20-minute Gemini timeout.

### Fix

**Done by Rui in the partner portal (no code change):** Added `perform_data_analysis` to the `foundation_tools` setting in `AW-Settings`. This makes it immediately available in every session without requiring skill installation, consistent with other analytical primitives like `search_web` and `search_tool_response`.

**Code change (PR #1548):** Also improved timeout error handling — when the Gemini API call times out, the LLM now receives guidance to break the analysis into smaller subsets (by date range or category) rather than retrying the same large payload. Also fixed a condition ordering bug in `formatToolError` where timeout messages containing "too large for a single call" were misclassified as payload-too-large errors.

### Why `perform_data_analysis` Belongs in Foundation Tools

More scheduled reports and workflows are now using this tool organically. Keeping it in `__other_skills__` means any session that hasn't explicitly installed that skill will hit the same install-then-call friction, with the attendant hallucinated-prefix errors. It's a core analytical primitive — same category as `search_web`, `save_memory`, `search_tool_response`.

---

## DynamoDB Versioning for Brand Guidelines & Market Strategy (2026-05-14)

### Problem

Brand guidelines and market strategy data stored in `AW-Users` and `AW-Organizations` can be overwritten by agent actions or user edits with no way to recover a previous good state.

### Investigation

Considered an application-level versions table (`AW-ContentVersions`) with snapshot-on-write, but rejected it because:
- Requires wiring up every save path in code
- Doesn't cover future data fields automatically
- Adds write overhead and table maintenance

**Decision: DynamoDB Point-in-Time Recovery (PITR)**

PITR was already the right answer — it covers every field in every table automatically, requires zero application code, costs ~$0.20/GB/month, and retains 35 days of continuous backups.

### Status

PITR enabled manually via AWS Console on:
- `AW-Users`
- `AW-Organizations`

No code changes required.

### How to Recover a Corrupted Record

When a brand guideline, market strategy, or any other field is corrupted and needs to be reverted:

**Step 1 — Restore the table to a point in time**

In AWS Console → DynamoDB → Tables → select the table (e.g. `AW-Users`) → Backups tab → "Restore to point in time". Choose a timestamp just before the corruption occurred. Restore to a new table name, e.g. `AW-Users-restore-YYYYMMDD-HHMM`. This takes 5–20 minutes depending on table size.

Or via CLI:
```bash
aws dynamodb restore-table-to-point-in-time \
  --source-table-name AW-Users \
  --target-table-name AW-Users-restore-20260514-1400 \
  --restore-date-time 2026-05-14T14:00:00Z \
  --region us-west-2
```

**Step 2 — Extract the old item from the restored table**

```bash
# For AW-Users (key: email)
aws dynamodb get-item \
  --table-name AW-Users-restore-20260514-1400 \
  --key '{"email": {"S": "user@example.com"}}' \
  --region us-west-2

# For AW-Organizations (key: orgId)
aws dynamodb get-item \
  --table-name AW-Organizations-restore-20260514-1400 \
  --key '{"orgId": {"S": "org_abc123"}}' \
  --region us-west-2
```

To extract just the specific field (e.g. brandGuidelines):
```bash
aws dynamodb get-item \
  --table-name AW-Users-restore-20260514-1400 \
  --key '{"email": {"S": "user@example.com"}}' \
  --query 'Item.brandGuidelines' \
  --region us-west-2
```

**Step 3 — Write the recovered field back to the live table**

Use `update-item` to patch only the affected field without touching anything else:
```bash
# Save the recovered value to a file first
aws dynamodb get-item \
  --table-name AW-Users-restore-20260514-1400 \
  --key '{"email": {"S": "user@example.com"}}' \
  --query 'Item.brandGuidelines' \
  --region us-west-2 > /tmp/recovered-brand.json

# Then apply it back (wrap in the DynamoDB attribute format)
aws dynamodb update-item \
  --table-name AW-Users \
  --key '{"email": {"S": "user@example.com"}}' \
  --update-expression "SET brandGuidelines = :val" \
  --expression-attribute-values '{":val": <paste-recovered-value-here>}' \
  --region us-west-2
```

For orgs, use `AW-Organizations` with key `{"orgId": {"S": "org_abc123"}}`.

**Step 4 — Delete the restore table**

```bash
aws dynamodb delete-table \
  --table-name AW-Users-restore-20260514-1400 \
  --region us-west-2
```

### Notes

- Restored tables inherit no GSIs automatically — they're read-only lookup tables, so this is fine for recovery purposes.
- The restore operation creates a full independent copy of the table — it does not affect the live table at all.
- PITR window is 35 days. For older recovery needs, use DynamoDB on-demand backups (manual snapshots via AWS Console).
- If you need to recover a different field (e.g. `marketStrategy`, `configs`, any future field), the same procedure applies — just change the `--query` path and `--update-expression` field name.

---

## Emma Silent on Slack Third-Party Mentions — Investigation (2026-05-13)

### Problem

In Slack agent mode sessions, when a thread message mentions another person (e.g. `<@U08TWRKGESG> test`), Emma responds to it as if it's a task for her — creating noise. The message is directed at a third party, not at Emma.

### What Was Tried (All Failed)

**Attempt 1: BE_SILENT in system prompt**
Added a `[Silence Rule]` to the Slack session system prompt instructing Emma to respond with `BE_SILENT` if the message isn't directed at her. The Slack handler then checked for this sentinel and suppressed posting.
- Failed because the system prompt is only injected on the *first message* of a session. Thread replies in existing sessions never see the rule.

**Attempt 2: Structural pre-flight check (skip LLM entirely)**
Added `isMessageDirectedElsewhere()` — extract `<@USERID>` mentions from message text, and if none are Emma's bot ID, `return` before calling `generateSessionResponse`.
- Rejected by user: Emma loses context on silent turns because the message is never saved to the session, breaking future responses.

**Attempt 3: BE_SILENT appended to each thread reply message**
Appended `[Silence Rule] ... respond with exactly: BE_SILENT` to `formattedMessage` on every thread reply, so Emma sees the instruction on every turn regardless of when the session was created.
- Failed because Emma's agent instructions are stronger than the hint. She interpreted `<@U08TWRKGESG> test` as "send a Slack message tagging that user with text 'test'" rather than a side-conversation to ignore.

**Attempt 4: Save context + skip LLM (structural, with context preserved)**
Before calling `generateSessionResponse`, detect third-party mentions structurally. If found: save the message to the session (for context) then return. Emma sees the message in history but doesn't respond.
- User rejected this too — they want Emma herself to decide whether to be silent, not backend logic.

### Resolution

No code change applied. The actual solution is simple: the **user can just tell Emma to be silent** in the Slack thread (e.g. "ignore messages not directed at you"). Emma will honor a direct instruction from the user in conversation far more reliably than any injected hint or system prompt addition. No backend change needed — this is a prompt/UX pattern, not an engineering problem.

---

## SeaDance 2.0 Video Generation — Investigation & Blocked (2026-05-09)

### Context

Investigated adding SeaDance 2.0 (ByteDance's advanced video model) as an alternative to Google Veo for video generation. SeaDance 2.0 offers flexible durations (4–15s native), multiple resolutions, aspect ratio control, and native audio — advantages over Veo's fixed 8s/clip limit.

### Approach Attempted

Initial plan was to integrate via **Runway AI** (Gen-4 Turbo) as a well-supported third-party provider with an existing API. However, Runway Pro subscription requires a **debit card** — credit cards and other payment methods are not accepted — making sign-up impossible at this time.

SeaDance 2.0 itself (`bytedance/seedance-2.0`) is currently available on **fal.ai**, but fal.ai's pricing for this model is not yet stable/published, making it a less reliable integration target.

### Status: Parked

Will revisit when one of the following becomes available:
- ByteDance offers a direct API and subscription for SeaDance (no third-party intermediary)
- A reliable third-party API (fal.ai pricing stabilizes, or another provider) is confirmed

### Proposed Design (for when we revisit)

See investigation notes from 2026-05-09 conversation. Summary:
- Add `@fal-ai/client` npm package to backend
- Add secrets: `dev/AgentWeb/Fal/VideoApi` and `prod/AgentWeb/Fal/VideoApi`
- Add `generateWithSeadance2()` in `backend/src/services/videoGeneration.ts` using `fal.subscribe("bytedance/seedance-2.0/text-to-video")` or `image-to-video` endpoint
- fal.ai accepts image URLs directly (no base64 conversion needed, simpler than Veo)
- Multi-clip threshold: 15s native (vs. Veo's 8s), so fewer splits needed
- Files to update: `videoGeneration.ts`, `agentModeService.ts`, `emma/tools.ts`, `AdminDashboard.tsx`, `TaskDetails.tsx`

---

## Scaling to 100 PRs/Day — Investigation & Conclusion (2026-05-08)

### Context

Explored how to scale development throughput from ~20 PRs/day to 100+ PRs/day, inspired by reports that the Claude Code founder achieves this scale using parallel Claude Code sessions and the `/loop` feature.

### Options Investigated

**Option 1: Slot-based parallelism on a single EC2**
Multiple git worktrees on one instance, each running on offset ports (3001/5173/5174 for slot 0, 3011/5183/5184 for slot 1, etc.). Each slot gets its own DynamoDB table prefix (`Dev1-`, `Dev2-`, etc.) for data isolation. Rejected: complex to manage, slots contend for RAM, and the existing architecture already solves this more cleanly.

**Option 2: One EC2 per Claude session (current architecture extended)**
The current system already does the right thing — one EC2 instance per task, each fully isolated by default (separate filesystem, ports, tmux sessions, logs). The only missing piece is auto-dispatch: today a human manually launches each EC2 and terminates it when done. Auto-dispatch (claim task from Notion queue on boot, self-terminate on completion) would be ~100 lines of shell and is straightforward to implement when needed.

**Option 3: Approved task queue gate**
Add an `approved` status in Notion so auto-dispatch only pulls from curated tasks. Eliminates compute waste from low-priority backlog items. Makes sense as a companion to auto-dispatch.

### Root Cause of 20 PR/day Ceiling

The bottleneck is **not** infrastructure — it is task volume. There are genuinely only ~20 worthwhile tasks per day given the current product stage and team size. The EC2/Claude infrastructure is already capable of 50–80 PRs/day if the task supply existed.

Running 100 simultaneous instances against an empty or low-quality queue would produce:
- Noise features nobody needs
- Token burn with no product value
- PRs that slow review rather than accelerate delivery

### Conclusion

**Do not over-engineer for a throughput target we don't need yet.** 20 PRs/day on focused, high-value work is the correct operating mode now.

Throughput will improve organically by:
1. **Epic decomposition** — when a large feature is scoped, break it into 15–30 atomic tasks upfront rather than treating it as one PR
2. **Better task inflow** — user feedback, error monitoring, SEO signals, and competitor analysis will grow the natural task supply as the product matures
3. **Auto-dispatch when the queue is full** — implement the Notion claim/release + EC2 self-terminate pattern only when there are consistently more approved tasks than active instances

Revisit this when the backlog problem is real, not hypothetical.

---

## "Bounced" Users Investigation — info@pmps.ai, admin@btstravel.be (2026-05-04)

### Context

Two users appeared in the Admin Users tab with a "Bounced" subscription status despite having valid Stripe customer IDs (`cus_USLZ3JNSb1epH2` and `cus_UQlSsGMRJCJSZ0` respectively). No corresponding subscription records could be found in Stripe.

### Root Cause: Abandoned Checkout

The "Bounced" label is working correctly. It is a frontend-derived status defined in `partner-portal/src/pages/AdminDashboard.tsx` (around line 3774):

```
bounced = stripe_customer_id set  AND  subscription_status null  AND  subscription_amount null
```

The exact sequence that produces this state:

1. User registers → `subscriptionType: Free`, no Stripe fields set
2. User opens the checkout flow → `POST /create-checkout-session` (`backend/src/routes/stripe.ts:442–448`) runs a "find or create Stripe customer" step and saves the new `cus_xxx` ID to DynamoDB immediately
3. User **abandons the checkout page before entering payment info** → no subscription is ever created on Stripe
4. No `checkout.session.completed` webhook fires → `subscription_status`, `stripe_subscription_id`, `subscription_amount` are never populated

Result: DynamoDB has a `stripe_customer_id` but zero subscription fields → frontend labels the user "Bounced."

| User | Stripe Customer ID | Account Created |
|------|--------------------|-----------------|
| info@pmps.ai | cus_USLZ3JNSb1epH2 | 2026-05-04 |
| admin@btstravel.be | cus_UQlSsGMRJCJSZ0 | 2026-04-30 |

### Verification

You can confirm by searching these customer IDs in the Stripe dashboard — the customer objects exist but have no subscriptions attached.

### No Code Fix Required

The system is behaving as designed. "Bounced" is an accurate label for users who started but did not complete checkout. These users are candidates for re-engagement outreach.

---

## RankAI Meta Ads Account Security Investigation (2026-05-04)

### Context

Matthew Wilmer received a Meta Business Manager email notification at 12:56 AM on April 29, 2026: `Dmitriy Lizin (dmitriylizin@gmail.com)` had joined RankAI's ad account. The client is `dyllan@rankai.ai` (userId: `4e29ce4e-8661-45bd-9881-3075d9a76971`). Matthew removed Dmitriy immediately and flagged the incident for investigation.

Question: was AgentWeb the attack vector, and who added Dmitriy?

### Findings

**AgentWeb was not the attack vector.** Evidence:

- `dmitriylizin@gmail.com` has zero presence in AgentWeb — no account, no sessions, never authenticated against our system
- On April 29, 2026 (the incident date), the only AgentWeb activity for Dyllan's account was a scheduled **Website Scan** of rankai.ai — a pure Playwright browser audit with zero Meta API calls
- All three Meta Ads report schedules were paused before April 29
- No `AW-EmailEvents` records for this user — no phishing or exfiltration pattern through our platform

**Access structure is expected.** The Rankai Meta ad account has 3 AgentWeb team members with Full Control (Harsha Vankayalapati, Matthew Wilmer, Rui Wang) plus 3 system users (AdMgmt Integration, 2× Conversions API System User) — this reflects the managed-services agency relationship where AgentWeb operates Meta Ads on RankAI's behalf.

**Live token with elevated scope.** The Meta access token stored in `AW-Users.connected_accounts[].config.access_token` for this user was verified still valid as of the investigation date:
- `is_valid: true`, non-expiring long-lived token
- Scopes include `business_management` — grants ability to add/remove users from Meta Business Manager
- Token belongs to Matthew Wilmer's Meta account (Meta user ID `10240394354459797`), issued 2026-03-27

**Who added Dmitriy — inconclusive.** The Meta Graph API `/{business_id}/activity_logs` endpoint has been removed (returns OAuthException 2500 on all API versions). Production nginx logs from April 29 are unrecoverable — the EB instance that was running then has been terminated and logs rotated. Matthew confirmed he cannot see the Security Center activity log in the Meta Business Suite UI either.

### Current Status

**Investigation closed pending Dyllan's response.** Matthew will ask Dyllan whether they recognize adding Dmitriy Lizin. If Dyllan confirms they did not add this user, the investigation will be reopened.

### Reopen Criteria

If Dyllan does not recognize the add action, next steps are:
1. File a formal support request with Meta referencing Business Manager ID `1900317767512083` for April 29 audit trail — Meta retains internal logs even after the API endpoint was removed
2. Audit whether the `business_management`-scoped token was exposed anywhere (agent session logs, S3-hosted HTML reports, or API responses)
3. Rotate the Meta access token immediately (revoke via Meta app settings for app ID `1842366079956363`, re-authenticate via AgentWeb)

### Platform Risk Item (Separate from Incident)

Meta access tokens are stored **in plaintext** in `AW-Users.connected_accounts[].config.access_token`. Any DynamoDB read access exposes live third-party OAuth tokens. This is a pre-existing platform-level risk unrelated to this incident but should be addressed — tokens should be encrypted at rest.

## EB Autoscaling Flapping — Investigation (2026-05-01)

### Context

Multiple instance launches observed in production (`Agentweb-backend-env-prod-3`) within a short window: 3 new `t3.large` instances added between 16:31–16:46 UTC, one terminated, health warnings. Initially suspected OOM crashes or instance failures.

### Root Cause: NetworkOut autoscaling threshold too low

The EB autoscaling alarm was configured to trigger on **NetworkOut** (not CPU):
- **Scale up:** `NetworkOut > 6 MB / 5-min period`
- **Scale down:** `NetworkOut < 2 MB / 5-min period`

The backend serves large API responses that easily exceed 6 MB on a single instance:
- `GET /api/agent-mode/sessions?limit=50` → ~2.2 MB response
- `GET /api/tasks/executions/with-html-reports?limit=1` → ~4.2 MB response

A few concurrent users hitting these endpoints concentrate traffic on the single instance after a scale-down (min=1), causing the scale-up alarm to fire. The new instance takes ~7 minutes to become healthy, during which load stays on the original instance — appearing as repeated "crashes."

Peak NetworkOut observed: **23.9 MB/instance** at 16:35 UTC.

### Fix Applied

Raised autoscaling thresholds via EB console:
- **Scale up:** `NetworkOut > 30 MB / 5-min period` (was 6 MB)
- **Scale down:** `NetworkOut < 6 MB / 5-min period` (was 2 MB)

### Not Done: Minimum Instance Count

Raising the minimum from 1 → 2 would eliminate the "all load on one instance" window after scale-down, but adds ~$140/month in EC2 cost. There is no convincing evidence this is necessary given the threshold fix — the flapping was the symptom, not instance capacity. Revisit if flapping resumes after the threshold change.

### How to diagnose in future

1. Check EB events: `aws elasticbeanstalk describe-events --environment-name Agentweb-backend-env-prod-3 --region us-west-2 --max-records 20`
2. Check ASG scaling activities to distinguish scale-out (alarm-triggered) from crash-replacement (health-check failure)
3. Check which alarm fired: `aws cloudwatch describe-alarms --alarm-names <AlarmName>` — look at `Metric` and `Threshold`
4. Plot `NetworkOut` metric on the ASG to see what triggered the alarm

---

## coding_agent "No GitHub / No Vercel" — Investigation (2026-04-29)

### Context

John (`founders@agentweb.pro`) reported that the `coding_agent` tool failed on the "Free AI Eval" landing page (`ai-eval-85a928ad`, `https://audit.agentweb.pro/ai-eval`) after 8 iterations with "No GitHub repository / No Vercel project" errors on all file-editing and deployment tools.

### Root Cause 1: Missing `githubRepoUrl` / `vercelProjectId` on DynamoDB record

The page record existed with `status: deployed` and a live `deployedUrl`, but `githubRepoUrl` and `vercelProjectId` were completely absent. Every coding agent tool — `list_files`, `read_file`, `edit_file`, `check_deployment` — calls `getLandingPage()` and checks these fields before doing anything.

**Why it happened:** `addPageToExistingRepo()` copies these fields from a sibling page at record creation, but the final deployed-status `UPDATE` only wrote `status` and `updatedAt`. If the initial PUT was incomplete for any reason, the record was permanently broken.

**Fix:** The `UPDATE` in `addPageToExistingRepo()` now also re-writes `githubRepoUrl` and `vercelProjectId` (`v0Service.ts`). Backfilled the specific record in production using `repair-landing-page-repo-fields.ts`.

### Root Cause 2: Stale `vercelProjectId` across all pages

After fixing root cause 1, `get_landing_page_preview_url` and `get_deployment_status` failed with 500. The stored Vercel project ID `prj_8MJIkLDVNod9XRj5Kbl0FIk7EhJ3` was stale — the Vercel project had been recreated. All 5 of john's pages had the old ID.

**Fix:** Checked the Vercel dashboard (`vercel.com/agentweb/agentweb-landing-page`), found the new project ID `prj_lH8z68FO47QtpLrLa45FnFRc2xwV`, and ran `repair-vercel-project-id.ts` to update all 5 pages in production.

### How to diagnose this in future

1. Check the DynamoDB record directly: `aws dynamodb get-item --table-name AW-LandingPages --key '{"id":{"S":"<page-id>"}}'` — look for `githubRepoUrl` and `vercelProjectId`.
2. If `vercelProjectId` is present but deployment APIs return 500, test it: `curl -H "Authorization: Bearer <VERCEL_TOKEN>" "https://api.vercel.com/v9/projects/<vercelProjectId>"`. A 404 means the project was recreated — check the Vercel dashboard for the new project ID.
3. When a Vercel project is recreated, update all pages sharing the old ID using `repair-vercel-project-id.ts` (update `OLD_ID`/`NEW_ID` constants first).

### Lesson

When the Vercel project is recreated or migrated, all `AW-LandingPages` records pointing to the old project ID become silently broken. There is no automatic sync. Any time Vercel project management happens (delete, transfer, recreate), run the repair script immediately.

---

## Emma 3-Dimension Scores Missing — Investigation (2026-04-28)

### Context

Emma was asked to pull chat history with `sync=true` and report per-session dimensional scores (`goalCompletion`, `dataAccuracy`, `outputQuality`). The scores were consistently absent from all sessions — Emma could only see the top-level integer score.

### Root Cause

The production `AW-Settings` table has a custom `default-scoring-prompt` that was saved on **2026-04-15**, before the dimensional scoring feature was introduced on **2026-04-26**. The old prompt ends with:

```
Respond with ONLY valid JSON: {"score": <1-5>, "reason": "<brief explanation>"}
```

`getDefaultScoringPrompt()` in `sessionScoringService.ts` checks the DB first and uses whatever is stored there. Since the DB prompt predates dimensions, the LLM never returns a `dimensions` field, and `parseDimensions()` always returns `undefined`. All 57 production sessions in the queried window had `dims=None`.

### Why PR #1347 Didn't Fully Fix It

PR #1347 (`fix(scoring): re-score sessions missing dimensional scores on sync`, 2026-04-27) fixed the **re-scoring guard** — sessions with a score but no dimensions were previously being skipped as "already scored." That guard was updated to re-score when `dimensions` is absent. However, re-scoring still used the old DB prompt, so the LLM still returned no dimensions. The guard fix was correct but incomplete.

### Fix

Update the `default-scoring-prompt` in `AW-Settings` (via Admin → Scoring Judges → Default edit icon) to append the dimensions instruction before the JSON format line:

```
In addition to the overall score, rate three specific dimensions (1-5 each):
- goalCompletion: Did the assistant fully accomplish what the user asked?
- dataAccuracy: Did the output contain plausible, consistent, and factually coherent data?
- outputQuality: Was the output well-structured, specific, and actionable?

Respond with ONLY valid JSON:
{"score": <1-5>, "reason": "<brief explanation>", "dimensions": {"goalCompletion": <1-5>, "dataAccuracy": <1-5>, "outputQuality": <1-5>}}
```

The two custom `IMPORTANT` sections in the existing DB prompt ("Expected outcomes" and "Tool Execution after Nudges") should be preserved — they are prod-only additions not in the hardcoded fallback.

### Verification

Tested on dev by stripping dimensions from a live session, then calling `GET /api/admin/chat-sessions?sync=true`. Confirmed dimensions were backfilled correctly after the prompt update.

### Lesson

When adding new required fields to the scoring LLM output format, also update `AW-Settings` `default-scoring-prompt` if a custom version is stored. The hardcoded `DEFAULT_SCORING_SYSTEM_PROMPT` constant in `sessionScoringService.ts` is only a fallback — any stored DB override takes precedence.

---

# April 27, 2026: Investigation — Drip Campaigns vs. Sequences Overlap

## Context

Audit of the Drip Campaigns feature (customer-portal `/crm/drips`) added in PRs agentweb #1218, #1220, #1301 and agentweb-customer-portal #673 (all by Harsha Vankayalapati). The feature was originally built in partner-portal then migrated to customer-portal. Concern: it may duplicate or conflict with the Sequences feature already in the CRM.

## What Drip Campaigns Does

A drip campaign is a single-email broadcast that repeats on a cadence (every N hours/days/weeks) to all leads currently matching a segment filter. Key attributes:

- **Fields:** `name`, `subjectLine`, `templateHtml`, `segmentQuery` (lifecycle, minHeatScore, utmSource, leadListId), `cadenceUnit`, `cadenceValue`, `maxSends`, `isActive`, `killSwitch`
- **Execution:** `dripExecutor.ts` cron runs every 15 min; for each active campaign, queries matching leads and sends if cadence + safety gates pass
- **Emma tool:** `manage_drip_campaign` (list/get/create/update/pause/resume/delete)
- **Tables:** `AW-DripCampaigns`, `AW-DripSends`
- **Routes:** `backend/src/routes/dripCampaigns.ts`
- **UI:** `customer-portal/src/pages/Drips.tsx`

## What Sequences Does

A sequence is a multi-step email journey where leads enroll explicitly and advance through steps on configurable delays. Key attributes:

- **Fields:** `name`, `description`, `campaignType`, `status`, steps (each with `delayDays`, `subject`, `bodyHtml`), `enrollmentTrigger`, `enrollmentCondition`, `exitConditions`
- **Execution:** `dripSequenceWorker.ts` processes due enrollments; advances per-lead state, evaluates exit conditions
- **Emma tool:** None — UI only
- **Tables:** `AW-DripSequences`, `AW-SequenceEnrollments`
- **Routes:** `backend/src/routes/sequences.ts`
- **UI:** `customer-portal/src/components/crm/SequencesTab.tsx`, `SequenceBuilder.tsx`

## Comparison

| | Drip Campaigns | Sequences |
|---|---|---|
| Steps | Single email, repeating | Multi-step series |
| Trigger | Implicit cadence (cron matches leads) | Explicit enrollment (manual, lifecycle, list) |
| Per-lead state | `AW-DripSends` send history only | Full enrollment record with currentStep, nextSendAt |
| Exit conditions | Kill switch / isActive only | Lifecycle change, email engagement, unsubscribe |
| Emma tool | Yes | No |
| Use case | Broadcast to dynamic segment | Personalized nurture journey |

## Decision

**Drip Campaigns to be removed.** Sequences is the more capable and correctly designed feature — multi-step, per-lead state, enrollment conditions, exit conditions. Drip Campaigns was accidentally added by Harsha's Claude Code session and was not intentionally designed as a separate product feature. Harsha confirmed this and agreed to remove it.

Work required (tracked separately):
- Delete `customer-portal/src/pages/Drips.tsx` + route + nav entry
- Delete `backend/src/routes/dripCampaigns.ts`
- Delete `backend/src/services/dripCampaignDb.ts`, `dripSendsDb.ts`, `dripExecutor.ts`
- Remove `manage_drip_campaign` Emma tool from `backend/src/mcp/server/apiTools.ts`
- Re-assign `manage_drip_campaign` skill assignment (currently in CRM & Lead Management skill) to Sequences or remove
- Drop `AW-DripCampaigns` and `AW-DripSends` DynamoDB tables in prod (after confirming no active campaigns)

---

# April 26, 2026: Investigation — Design4Space Scheduled Chat 400 Error (Azure OpenAI Tool Limit)

## Context

Scheduled chat "Design4Space Website Scan" failed at `2026-04-26T14:19:08` with:

```
400 Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 143 instead.
```

Model: `gpt-5.4` (Azure OpenAI deployment). The earlier run at 04:59 succeeded; the 14:19 run failed.

## Root Cause

Azure OpenAI enforces a hard limit of 128 tools per API request. The session ended up with 143 tools split as:

- **34** foundation tools (always included)
- **22** Browser automation skill tools
- **2** SEO & Website Analytics skill tools
- **~85** from `__other_skills__` — the virtual catch-all skill

`__other_skills__` is auto-installed by `runVerifiedChat()` when a required function call isn't assigned to any named skill. The session needed `navigate_to` (which wasn't in any named skill), so the system installed `__other_skills__`, which at the time held ~85 orphaned tools — every registered tool not assigned to a published skill.

The 04:59 run succeeded because it had a different execution path that happened to stay under 128. The 14:19 manual test run hit the full tool list immediately after skill install.

## Fix 1 — Safety net (PR #1334)

Added `maxTools: 128` to all Azure OpenAI model configs (`gpt-5-chat-2`, `gpt-5.2-chat`, `gpt-5.4`) and truncation logic in `callLLM()` in `agentModeService.ts`. Prevents the hard 400 crash even if tool counts exceed the limit again.

## Fix 2 — Root cause (dev environment only, via partner portal UI)

Audited all registered tools against published skills. Found **65 orphaned tools** in `__other_skills__` that had never been assigned to any named skill. Assigned all of them to their proper skills via the Skills Management UI at `/skills`:

| Skill | Tools added |
|---|---|
| Meeting Intelligence | `fathom_route_action_items` |
| LinkedIn Outreach | `linkedin_outreach` |
| Meta Ads Management & Publishing | `list_meta_ads_campaigns`, `get_meta_ads_metrics` |
| CRM & Lead Management | `ask_crm`, `set_lead_contact_status`, `delete_leads_by_filter`, `update_lead_status`, `get_lead_list_statuses`, `configure_lead_statuses`, `analyze_crm_data`, `assign_lead`, `promote_to_deal`, `get_hot_leads`, `log_contact_event`, `import_leads_from_search`, `enrich_leads_preview`, `enrich_leads_execute`, `enrich_lead_custom`, `get_user_profile`, `report_product_issues`, `manage_drip_campaign` |
| Landing Page Builder | `get_landing_page_preview_url`, `publish_landing_page_changes` |
| Landing Page Design | `create_html_template` |
| Knowledge Base | `perform_deep_research`, `search_ads_knowledge_base`, `list_books`, `get_book_details`, `get_book_content`, `update_book_content`, `generate_book_content`, `create_book`, `create_book_outline`, `create_blog_article`, `publish_blog_article`, `list_cms_categories`, `repair_blog_article` |
| GTM Tracking | `account_summary`, `get_clarity_metrics`, `list_task_templates`, `create_task_from_template`, `create_task_from_prompt`, `create_image_task_from_prompt`, `create_revision`, `get_task_subscriber_metrics`, `remove_c2pa_from_image`, `rotate_primary`, `list_schedule_templates`, `manage_schedule_template`, `create_schedule_from_template`, `slack_list_channels`, `slack_get_recent_messages`, `slack_get_thread_replies`, `slack_send_message`, `send_for_review`, `notify_session`, `wait_seconds`, `search_tool_response`, `email`, `post_on_connected_account`, `perform_data_analysis` |
| B2B Ad Image Batch Generation | `search_web`, `read_page_source` |

After these assignments, `__other_skills__` is empty in dev.

## Decision

**Always assign new tools to a named skill when deploying them.** Do not leave tools unassigned — they silently pile into `__other_skills__` and inflate the tool count for any session that needs the catch-all. The `maxTools` truncation is a safety net, not a substitute for correct skill assignment.

---

# April 21, 2026: Investigation — Agent Mode "Unknown Error" with claude-opus-4-7

## Context

User `ftan@agentweb.pro` hit the generic "I apologize, but I encountered an error processing your request" error in Agent Mode when using model `anthropic.claude-opus-4-7`. This triggered an "Unknown Error in Generate Response" oncall alert.

## Root Cause

`anthropic.claude-opus-4-7` is registered in the model registry but **not provisioned on this AWS Bedrock account**. Bedrock returns:

```
ValidationException: anthropic.claude-opus-4-7 is not available for this account.
You can explore other available models on Amazon Bedrock.
```

This is a 400-class error, but the AWS SDK surfaces the HTTP status on `error.$metadata.httpStatusCode` rather than a top-level `error.status` field. The existing error classifier in `generateMarketingResponse` only checked `error.status === 400`, so the Bedrock ValidationException fell through to the generic catch-all and triggered the oncall alert instead of showing a sensible "issue processing your request" message.

## Fix

- Added `error.$metadata.httpStatusCode` as a fallback when reading the HTTP status in the error classifier (`agentModeService.ts`). Going forward, Bedrock validation errors will map to the correct user-facing message.
- The model is kept in the registry because: (1) it is admin-only (`getSupportedModels` filters out any model with "opus" for non-admins), so regular users are never exposed to it; (2) it may become available on this account in the future, at which point it will work automatically.
- If AWS provisions the model on this account, no code changes are needed — the inference profile ARN is already configured.

## Decision

**Do not remove `claude-opus-4-7` from the registry.** It is safely gated behind admin-only access, and the error classification fix means any future Bedrock unavailability errors will show a proper message rather than triggering a generic alert.

---

# April 8, 2026: Investigation — Lead Tech Stack Enrichment Options

## Context

Investigated options for enriching CRM leads to discover what software products/services lead businesses use — both customer-facing integrations and back-office tools.

## Current Enrichment Capabilities

- `crmEnrichmentService.ts` — web search (via agentModeService.searchWeb) + Gemini LLM extraction. Custom instructions + output fields. 20 parallel workers.
- ICP matching — OpenAI analysis of lead fields vs. user-defined ICPs.
- LinkedIn profile enrichment via Unipile integration.
- Existing guidance hint for `tech_stack` fields uses LLM inference from search results.

## Options Evaluated

**Option A: Pre-built "Tech Stack" enrichment template** — Add preset instruction + output fields to existing enrich-web flow. Zero new infrastructure. Misses back-office tools not in public web results.

**Option B: BuiltWith API** — REST API ($295/mo or $0.12/lookup), scans domains for frontend/web technologies. High accuracy for analytics, CDN, ecommerce, email marketing, payment processors. Doesn't cover internal back-office tools (Salesforce, payroll, etc.).

**Option C: Apollo.io Enrichment API** — `/organizations/enrich?domain=` returns `technology_names` array scraped from job postings and LinkedIn. Free tier 50/day. Best for back-office tools (Salesforce, NetSuite, Jira, AWS). Less accurate for smaller/newer companies.

**Option D: Job Posting Analysis via LLM** — Add second web search per lead targeting LinkedIn/Indeed job listings. "Experience with X required" reveals tech stack. Zero extra cost; only works for actively hiring companies.

**Option E: Browser automation (agent engine)** — Playwright scrapes company websites, integrations/partners pages, footer badges. Most thorough, ~30–60s per lead.

## Decision (final)

**Implement Option D (LLM + web search) via existing `CrmEnrichmentService`** — reuses the same LLM + Google Search pipeline already powering "Enrich with Web". The route uses a tech-stack-specific instruction that targets job postings ("Experience with X required"), integrations/apps pages, and partner badges.

- Route: `POST /api/crm/lists/:listId/leads/enrich-tech-stack` (in `crm.ts`)
- Service: `CrmEnrichmentService` with `sources: ['web_search']` and `TECH_STACK_INSTRUCTION` preset
- UI: "Discover Tech Stack" in CRM dropdown, dedicated dialog with LLM preview (2 sample leads enriched at preview time) + progress bar
- Fields: `tech_stack_analytics`, `tech_stack_cms`, `tech_stack_marketing`, `tech_stack_infrastructure`, `tech_stack_integrations`
- Zero extra cost; 20 parallel workers; ~2–5s per lead

**Note:** `builtWithService.ts` was created as an intermediate attempt (puppeteer scraping `builtwith.com`) but abandoned after BuiltWith captcha blocked automated access. The file remains in the repo but is no longer used by the route.

---

# April 8, 2026: Investigation — Who Started Running Ads for Waldium Account

## Background

User `amrutha@structuredlabs.com` (Waldium) has active Meta Ads campaigns and a recurring 48-hour performance check-in schedule running in their account. Rui (admin) did not recall initiating these, raising a question about which actions were taken by the admin vs. the user, and surfacing a broader gap: the platform has no comprehensive audit trail for actions taken via admin delegate access.

## Investigation

**User ID:** `1a9a40c5-5ec0-41de-996f-cee3b82fa74e`

Queried `AW-ChatSessions` (UserIdIndex GSI) and `AW-TaskSchedules` for this user. Found ~90 sessions spanning Dec 2025–Apr 2026.

### Session Attribution Summary

| Date | Session | Title | Initiated By | Notes |
|------|---------|-------|--------------|-------|
| Jan 7, 2026 | `37429d16` | Emotional Facebook Ad for Waldium DevRel Backlog | **User** (no delegate) | Ad creative only, no Meta Ads API |
| Feb 15–20 | `e13847b4` | AI Assistants Recommend Competitors Facebook Ad | **matthew@agentweb.pro** (delegate) | Ad creative only |
| Feb 15–Mar 25 | `3cccd7e3` | Waldium Multi-ICP AI Ad Video Generation Plan | **matthew@agentweb.pro** (delegate) | Ad video creation |
| **Mar 17** | `dc3b404d` | Meta Ads Multi-Campaign Performance Report | **ruiw@agentweb.pro** (delegate) | **First Meta Ads API session.** 58 msgs. Called `call_meta_ads_insights_api` x10, `call_meta_marketing_api` x1, `manage_scheduled_chat` x3. Created the recurring "Multi-Campaign Performance Report" schedule (every 3 days). |
| Mar 17 | `762ad27b` | Test: Waldium Meta Ads — Multi-Campaign Performance Report | Automated (scheduled) | First automated run of the above schedule |
| **Mar 31–Apr 2** | `d0a87f37` | Meta Ads Status Check – Running vs Paused Campaigns | **ruiw@agentweb.pro** (delegate) | 47 msgs, interactive. Called `call_meta_marketing_api` x4. Checked/changed campaign statuses, ran performance audit, helped with custom audience uploads. Judge score 5/5. |
| **Apr 2–6** | `3fcc89e8` | Meta Campaigns Schedule Lookup | **ruiw@agentweb.pro** (delegate) | 62 msgs, interactive. Set up the "Landing Page Lead Magnets - 48hr Check-in" monitoring schedule (every 2 days). Judge score 5/5. |

### Active Schedules

| Schedule ID | Created | Frequency | Status | Description |
|-------------|---------|-----------|--------|-------------|
| `135c535c` | Mar 17 | Every 3 days | Active | Waldium Meta Ads Multi-Campaign Performance Report |
| `77289d04` | Apr 6 | Every 2 days | Paused | Landing Page Lead Magnets - 48hr Check-in (campaign ID: 6865354788715, account: 883347640787043) |
| `623db84f` | Apr 7 | Daily | Active | Website Scan - waldium.com |

### Findings

1. **Admin (Rui, `ruiw@agentweb.pro`) initiated all Meta Ads API usage** via delegate access, starting March 17. The user (amrutha) never directly triggered Meta Ads API calls — her own sessions were limited to ad content creation (images, copy) in Jan–Feb.

2. **Rui does not recall these sessions.** The `delegateInfo` field records which admin account was used but not who was physically at the keyboard, nor what the original prompt was.

3. **The "Landing Page Lead Magnets" campaign (ID: 6865354788715) was pre-existing** in Meta Ads Manager — the monitoring schedule was set up to watch it, not to launch it.

4. **Root cause of the attribution gap:**
   - `AW-ChatSessions.startingMessage` is null for most sessions — original prompts are not persisted
   - `AW-TaskSchedules.createdBy` is null — no record of who created a schedule
   - Session messages are archived/cleared; only `calledFunctions` counts and judge scores survive
   - No dedicated admin action log exists

## Audit Gap Options Evaluated

Four options were considered:

- **Option A** — Persist `startingMessage` + add `createdByAdminEmail` to schedules (1–2 days, low effort)
- **Option B** — New `AW-AdminActions` table logging every delegate action (3–5 days)
- **Option C** — Email account owner when admin takes high-impact actions via delegate (2–3 days)
- **Option D** — Session message retention policy / compact session summaries (5–7 days)

## Decision

**No ad-hoc tracking added now.** These gaps are real but any point solution (e.g. logging just schedule creation, or just delegate sessions) would be incomplete and create a false sense of coverage.

The right fix is a **comprehensive user activity tracking solution** that covers all action types (sessions, schedules, task executions, config changes) across both user and admin-delegate contexts, with a queryable admin UI. That work should be scoped and prioritized as a standalone initiative rather than bolted on per-investigation.

**Until that exists:** When investigating admin delegate sessions, use `delegateInfo` on `AW-ChatSessions` + `calledFunctions` counts + judge scores as the best available signal.

---

# April 9, 2026: Investigation — Emma Taking Irrelevant Actions (CRM/Lead Creation During Website Scan)

## Context

Reported session: `f3e85582-8f82-4c62-a9d3-a37692e94088`
Schedule: `f6418b77-81a1-4dad-9c1f-6d77adff2c6e` ("Design4Space Website Scan")
User: `1f32123d-23b3-456e-81cd-52bae8bb5851`

A scheduled website scan session where Emma was observed creating a lead list and adding a contact to CRM — actions completely unrelated to the task.

## What Happened

The schedule's starting message was:
> "Visit and scan the website https://www.design4space.com.sg/. Report issues that are directly observable from the site..."

Emma completed the scan correctly (Playwright browser tools). The user then sent a follow-up in the same session:
> "write a short message to inform Connie about the results and suggested changes"

Emma's response to this follow-up:
1. Installed "CRM & Lead Management" skill (via `install_skills`)
2. Called `get_lead_lists` — checked for existing lead lists
3. Called `create_lead_list` — created a new list "Website Audit Contacts"
4. Called `add_leads_to_list` — added Connie as a CRM contact
5. Called `get_leads` + `update_email_draft_for_lead` — created a full email campaign draft

The user wanted a short text message to copy/paste. Emma instead built a full CRM workflow.

In addition, `install_skills` was called 3 times total across the session (Browser automation, CRM & Lead Management, other_skills), reflecting the same pattern: Emma installs whatever skill it thinks it needs, even when the requested output is plain text.

## Root Cause

Emma's system prompt instructs it to "analyze every request, identify all required skills/tools, and install them before executing." There is no rule saying: if the output is text, just write it — don't create data records.

When Emma saw "write a message to Connie," it interpreted this as needing CRM infrastructure (find the contact, draft a personalized email template, save to campaign). The system prompt actively encourages this kind of over-tooling via the Analyze-Install-Execute protocol.

### Relevant System Prompt Location

`backend/src/services/agentModeService.ts` — `getMarketingSystemPrompt()` method (~line 2046), the `## Critical Rules` section. This is where tool usage rules live.

## Fix Considered

Adding two Critical Rules to the system prompt:
- **Minimum Necessary Tools**: Only install skills when the output genuinely cannot be produced without them. "Write a message" = write text, no tools needed.
- **No Unsolicited Data Creation**: Never create persistent records (lead lists, contacts, GTM plans, campaigns) unless the user explicitly asks.

## Decision

**No action taken.** The fix direction is correct but the impact of modifying Emma's core system prompt is unclear. The Analyze-Install-Execute protocol is central to Emma's behavior across many workflows; adding blanket "don't use tools" rules could break legitimate flows where CRM or campaign tools are genuinely needed. The risk/reward tradeoff is uncertain without more testing.

**Longer-term options to consider:**
1. Add the two Critical Rules above and A/B test against a sample of real sessions
2. For scheduled chat sessions specifically, inject a stricter constraint in the schedule context (already injected at `agentModeController.ts:1403`) — e.g. "Only use tools required to complete the stated task. Do not install additional skills or create new records."
3. Add a session-level "allowed tool categories" config on the schedule definition, so the schedule creator can restrict which skill categories Emma can use at runtime

---

# April 6, 2026: Investigation — Claude Code Source Analysis (Agent Architecture Patterns)

## Background

Anthropic's Claude Code CLI source was recently deobfuscated and analyzed by the community (~386K–500K lines, ~1,900 files). Two primary analysis repositories surfaced:
- `github.com/chat2dev/ClaudeCodeAnalysis` — 7-part architectural breakdown
- `github.com/luzhenqian/Claude-Harness` — 31-article deep-dive series

Investigated what patterns could be borrowed into AgentWeb's agent infrastructure (`agentModeService.ts`, `toolRegistry.ts`, Emma pipeline).

## Key Findings

### 1. Tiered Context Compaction (three layers, zero-cost first two)

Claude Code uses a three-layer compaction strategy triggered before context overflow:

- **Layer 1 (free)**: Replace old `tool_result` content with `[result cleared]` placeholders. No LLM call — the model has already acted on these results.
- **Layer 2 (free)**: Use a pre-built "session memory" object maintained in the background after each turn (key decisions, completed actions, open questions). No extra API call — the summary is ready when needed.
- **Layer 3 (LLM call)**: Full summarization via a forked agent with an `<analysis>`/`<summary>` prompt structure. Strips reasoning from the stored output.

**Circuit breaker**: After 3 consecutive compaction failures, auto-compaction is disabled for the session. This was added after a production incident where 1,279 sessions experienced 50–3,272 consecutive failures, wasting ~250K API calls/day.

### 2. Hybrid Token Counting

Rather than re-estimating the full message history every turn (slow) or using pure heuristics (inaccurate), Claude Code uses the last API response's `usage.prompt_tokens` as an anchor and only estimates deltas for new messages (~4 chars/token). Four pressure thresholds: warning → auto-compact → blocking → effective-window.

AgentWeb already captures `response.usage` at `agentModeService.ts:1429-1445` — this data is available to implement the same pattern without any API changes.

### 3. Tool Safety Metadata + Smart Concurrency

Each tool declares `isConcurrencySafe(input)`, `isReadOnly(input)`, and optional `isDestructive(input)` at the type level. The `StreamingToolExecutor` runs read-only tools in parallel and serializes write tools. Critically, `isConcurrencySafe` accepts the actual input (same tool can be safe or unsafe depending on what it's operating on).

AgentWeb's `ToolRegistry` currently has no such metadata — `AgentTool` is `{name, definition, execute}` only. Tools already run in parallel (`agentModeService.ts:1503-1505`) but with no write-safety guarantee.

### 4. Tool Pair Integrity on Context Trim

When pruning old messages, Claude Code enforces that a `tool_use` (assistant message) is never left without its matching `tool_result`. An orphaned `tool_use` causes certain LLMs (especially Claude-family) to return an API error. The function `adjustIndexToPreserveAPIInvariants` enforces this.

AgentWeb's `trimToolMessagesForContext` (`agentModeService.ts:13144`) only trims `tool` role messages — it does not check or remove the paired assistant `tool_calls` block. This is a latent correctness issue for very long sessions.

### 5. Analysis-Output XML Separation in LLM Prompts

For complex structured outputs, Claude Code prompts include `<analysis>` (reasoning, gets stripped) and `<summary>` (output, gets stored) tags. The analysis block gets stripped before storing — the model reasons without the reasoning eating into future context budget. This reliably improves quality for structured generation (work plans, summaries, reports).

### 6. Max-Tokens Recovery Message

Claude Code's continuation injection explicitly bans preamble:
> *"Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces."*

AgentWeb's current version (`agentModeService.ts:1463`) says *"Please continue exactly where you left off"* — allows the model to start with an apology and restatement before resuming.

### 7. Error Withholding Pattern

Recoverable errors (`max_output_tokens`, `prompt_too_long`, media-size) are withheld from the caller while recovery is attempted. The error is only surfaced if all recovery strategies fail. This prevents SDK consumers from terminating sessions on transient errors.

AgentWeb has basic max-tokens continuation (3x) and backup model fallback, but `prompt_too_long` has no recovery path — it propagates immediately to the user.

## Current AgentWeb Gaps vs. Claude Code

| Area | AgentWeb Current | Claude Code Pattern |
|------|-----------------|---------------------|
| Context compaction | `trimToolMessagesForContext` (crude truncation) | 3-layer tiered strategy with circuit breaker |
| Token awareness | None | Hybrid counting + 4 pressure thresholds |
| Tool safety metadata | None (`AgentTool` has no `isReadOnly`) | `isConcurrencySafe`, `isReadOnly`, `isDestructive` per-tool |
| Tool pair integrity | Not enforced | `adjustIndexToPreserveAPIInvariants` |
| Prompt quality | Direct prompts | `<analysis>`/`<output>` separation for structured generation |
| Recovery message | Allows preamble | Explicitly bans apology/recap |
| `prompt_too_long` | Propagates immediately | Reactive compaction + retry |

## Decision

**No immediate adoption** — AgentWeb sessions are not yet long enough to make context compaction a user-visible problem. No urgent need to invest the engineering time.

**Future work signal**: If any of the following happen, revisit these patterns:

- Long agent sessions (>50 turns) start failing or degrading in quality
- Context window errors appear in production logs (`prompt_too_long` / 400 errors)
- Users report agents "forgetting" earlier context in long sessions
- We add sub-agent / coordinator-worker orchestration (then tool safety metadata becomes critical)

**Prioritized if/when adopted** (easiest wins first):
1. Fix max-tokens recovery message (1-liner, `agentModeService.ts:1463`)
2. Tool pair integrity in `trimToolMessagesForContext` (prevents latent API errors)
3. `<analysis>`/`<output>` separation in work plan / GTM plan generation
4. `isReadOnly` / `isDestructive` metadata on `AgentTool` interface
5. Token pressure thresholds using existing `response.usage` data
6. Full tiered context compaction (largest investment, highest long-session impact)

---

# April 4, 2026: Investigation — Axios Supply Chain Attack (AWS Security Alert)

## Background

Received an AWS Security email warning that our organization "may have been the target of potentially inappropriate activity" related to malicious axios npm package versions `1.14.1` and `0.30.4`, published March 30–31, 2026 via a hijacked maintainer account.

AWS recommended checking for network connections to `142.11.206.73:8000` during March 31, 5:15–8:15 PM PDT, rotating credentials on affected hosts, and auditing CloudTrail.

## Investigation

### Axios versions in our lock files

| Component | Resolved axios version | Status |
|---|---|---|
| backend | 1.9.0 | Safe |
| partner-portal | 1.11.0 | Safe |
| customer-portal | 1.11.0 | Safe |
| agent-engine | Python only — no axios | Not applicable |

The `1.14.1` hits that appeared in the lock file grep were for `tslib` (a TypeScript utility), not axios.

### Why we were never exposed

- **`npm ci` everywhere**: CI pipeline and cloud-dev test env both use `npm ci`, which installs exact lock file versions — no semver range resolution occurs.
- **Lock files were clean during the attack window**: Confirmed via `git show 32c1b508:backend/package-lock.json` — backend had axios `1.9.0` as of the March 31 commit. No package-lock.json changes landed during March 30–31.
- **EB deploys bundle the lock file**: The zip artifact includes `package-lock.json`, so EB also installs only locked versions.
- **Agent engine is Python**: No axios dependency at all.

### AWS Health Dashboard

Checked the Affected Resources tab — no resources listed. This confirms the alert was a false alarm. AWS sent these notifications broadly to any account that uses axios as a dependency, as a precautionary measure.

## Conclusion

No compromise. No credential rotation needed. No affected hosts.

The `package.json` semver ranges (`^1.9.0`, `^1.7.9`) would theoretically allow resolving to `1.14.1` under a bare `npm install`, but since all install paths use `npm ci` the lock file versions were always used. The malicious versions were removed from npm shortly after discovery. Low-priority housekeeping: update lock files to pin axios past `1.14.1` when convenient.

# March 29, 2026: Investigation — Sonnet 4.6 vs Opus 4.6 Cost & Quality Comparison for Agent Mode

## Problem

Agent Mode defaults to Opus 4.6 (`anthropic.claude-opus-4-6-v1`) for all sessions. Opus is the most expensive Claude model. Need to determine whether switching the default to Sonnet 4.6 would meaningfully reduce costs without degrading output quality for typical marketing tasks.

## Approach

Ran identical marketing tasks on both models using the test account (`test@example.com`) and compared cost, token usage, and output quality.

### Tasks Tested
1. **SWOT Analysis** — "Create a SWOT analysis for my business"
2. **LinkedIn Posts** — "Create 3 LinkedIn posts for my business"
3. **Email Nurture Sequence** — email marketing content
4. **Brand Guidelines Review** — brand strategy analysis
5. **Competitor Analysis** — competitive landscape research

## Results

### Cost Comparison (Same Tasks, Same Account)

| Task | Sonnet 4.6 Cost | Opus 4.6 Cost | Opus Premium |
|------|-----------------|---------------|--------------|
| SWOT Analysis | $0.091 | $0.677 | **7.4x** |
| LinkedIn Posts | $0.062 | $1.270 | **20.5x** |

**Average: Opus costs ~14x more per session for comparable marketing tasks.**

### Sonnet 4.6 — Full Test Results

| Task | Session | Cost | Output Tokens |
|------|---------|------|---------------|
| SWOT Analysis | 9246850b | $0.091 | 10,526 |
| LinkedIn Posts | 53c768c5 | $0.062 | ~7,000 |
| Email Nurture | d41e9b3c | $0.062 | ~7,000 |
| Brand Guidelines | dfdc46b6 | $0.106 | ~10,000 |
| Competitor Analysis | 067d7bd5 | $0.159 | ~14,000 |

**Average Sonnet session cost: $0.096**

### Opus 4.6 — Test Results

| Task | Session | Cost | Output Tokens |
|------|---------|------|---------------|
| SWOT Analysis | d3173b8a | $0.677 | 10,468 |
| LinkedIn Posts | 9b0603f3 | $1.270 | 8,654 |

**Average Opus session cost: $0.974**

### Pricing Reference

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|-------|----------------------|------------------------|
| Sonnet 4.6 | $3 | $15 |
| Opus 4.6 | $15 | $75 |

## Quality Assessment

Both models produced **excellent, production-quality** marketing outputs:

- **SWOT Analysis**: Both generated comprehensive strategic frameworks with tables, bullet points, and actionable recommendations. Indistinguishable quality.
- **LinkedIn Posts**: Both created well-crafted content. Opus was slightly more "feature-aware" — it discovered and used the `create_social_media_posts` tool to save posts directly, while Sonnet presented them inline. The extra tool usage drove Opus cost much higher.
- **Email/Brand/Competitor tasks** (Sonnet only): All produced thorough, well-structured outputs comparable to what Opus would generate.

### Key Observation

Opus's main advantage is being more likely to discover and use platform tools (e.g., `create_social_media_posts`, `install_skills`). However, this increases cost significantly (more iterations, more tool calls) and the end-user output quality is equivalent.

## Projected Monthly Savings

Assuming ~500 agent mode sessions/month:
- **Opus monthly cost**: ~$487 (500 × $0.974)
- **Sonnet monthly cost**: ~$48 (500 × $0.096)
- **Potential savings**: ~$439/month (~90% reduction)

## Recommendation

**Switch the default model to Sonnet 4.6.** The quality difference is negligible for marketing tasks, and the cost savings are dramatic (7-20x per session). Opus can remain available as a manual selection in the model dropdown for users who want it.

### Also Investigated: Auto_CostSaving Meta-Model

Explored building an `Auto_CostSaving` meta-model that dynamically routes between Claude models per iteration based on task complexity. Implementation was completed but ultimately unnecessary — since Sonnet handles all tested tasks at equivalent quality, a simple default switch is cleaner than a dynamic routing system.

**Decision:** Discard Auto_CostSaving code; switch default model to Sonnet 4.6 instead.

---

# March 28, 2026: Investigation — SESSION_MESSAGE_LIMIT_EXCEEDED on Scheduled Chat (BirdDog Blog Articles)

## Problem

Schedule `527a6748-abc5-4475-aa1e-e9e77cd09d09` ("BirdDog Blog Articles", user `7856055c-298f-4478-ba4c-183240fe2db2`) failed after ~80 minutes with:

```
SESSION_MESSAGE_LIMIT_EXCEEDED: Adding 14 message(s) would exceed the maximum of 300 messages per session (current: 289). Please start a new session to continue the conversation.
```

Session: `e1694c29-ca30-42cf-981a-2a30f1ed2eda`

## Root Cause

**The LLM refused to call `search_web` despite it being listed as a required function in the schedule config.** The `runVerifiedChat` retry loop kept requesting the LLM to call `search_web`, but the LLM repeatedly declined or ignored the instruction, causing the loop to retry up to its max attempts. Each retry added ~12-18 messages (user prompt + LLM response + tool calls + tool results), and after ~15 attempts the session had accumulated 289 messages — 11 short of the 300 hard limit.

This is fundamentally a **prompt-following issue** — the LLM did not comply with the instruction to call `search_web`, and the retry mechanism had no way to detect that the LLM was systematically refusing a specific tool call vs. simply needing another attempt.

A secondary issue: `runVerifiedChat` had **no pre-flight check** on the session message count before retrying, so it kept retrying until it hit the hard limit and crashed instead of stopping gracefully.

## Fix

1. **Config fix (immediate):** Removed `search_web` from `requiredFunctionCalls` in the schedule config. The tool is not essential for blog article generation — the LLM calls it organically when needed, and forcing it via `requiredFunctionCalls` creates a brittle dependency on the LLM's willingness to comply.

2. **Code fix (defensive):** Added a pre-flight message count check in `runVerifiedChat` (`agentModeController.ts`). Before each retry, the session's `messageCount` is compared against `MAX_MESSAGE_SIZE_PER_SESSION - 50`. If within 50 messages of the limit, the retry loop breaks gracefully and returns the partial result instead of crashing.

## Lesson

- **Don't require tool calls that aren't essential.** If the LLM can produce acceptable output without calling a specific tool, don't add it to `requiredFunctionCalls`. The retry loop will burn through attempts (and messages) trying to force a tool call the LLM may not see as necessary.
- **LLM prompt-following is not guaranteed** — especially for tool calls the model deems irrelevant to the task. Design retry logic to degrade gracefully rather than assuming the LLM will eventually comply.
- **Session message limits need proactive checking**, not just reactive enforcement. The hard limit at 300 was only checked when writing messages, not when deciding whether to retry.

---

# March 28, 2026: Investigation — Why Some Sessions Do Not Have Usage Data

## Problem

Some chat sessions in `AW-ChatSessions` have no `totalTokens` or `totalCost`, even though they contain messages and had LLM calls. Need to determine scope and root cause.

## Investigation

Analyzed last 500 sessions in production (queried `AdminUpdatedAtIndex`).

### Data Breakdown

| Portal Type | Total | With Usage | Without Usage | Multi-Msg Without Usage |
|-------------|-------|------------|---------------|------------------------|
| agent       | 118   | 96         | 22            | 4                      |
| emma-sidebar| 202   | 1          | 201           | 0                      |

### Emma-sidebar sessions (201 without usage) — NOT A BUG

These are auto-created sessions when a user navigates to a page. 196 of 200 `messageCount=1` sessions have `updatedAt ≈ createdAt` (within 1 second) — the session was created with a system message in AW-ChatMessages, but the user never actually chatted. No LLM calls were made.

The 1 Emma session that had a real conversation (7 messages) correctly has usage data.

### Agent sessions with messageCount=0 (18 without usage) — NOT A BUG

Sessions created but never started (e.g., predefined work plans set up but user hasn't interacted).

### Agent sessions with messages but no usage — 4 sessions

| Session | Type | Msgs | Model | Root Cause |
|---------|------|------|-------|------------|
| `f8cf70d9` | predefined-work-plan | 30 | gemini-3-pro | **Pre-dates usage tracking** (created 2026-03-16, earliest session with usage is 2026-03-26) |
| `c3615c1c` | predefined-work-plan | 25 | claude-opus-4-6 | **Same** — created 2026-03-16 |
| `a19cc80d` | scheduled | 2 | gemini-3.1-pro | Only system+user msgs, **AI response never persisted** (worker timeout/crash) |
| `1e5af232` | regular (slack-bot) | 2 | undefined | Only system+user msgs, **AI response never persisted**, model undefined |

### Root Causes

1. **Historical sessions**: Sessions created before usage tracking was deployed (pre March 26). All messages have `hasUsage=false`. No fix needed.

2. **Failed/incomplete sessions**: Worker crashed or timed out during `generateMarketingResponse`. Usage is completely lost because:
   - Usage extraction only happens when `response.responseMessages` are persisted via `addMessagesToSession`
   - If worker throws/times out, `responseMessages` is never populated
   - `incrementTokenUsage()` at chatbotService.ts:803 is never reached
   - No fallback to capture partial usage from the worker process

### Gap: Usage Lost on Worker Failure

When `generateMarketingResponseWorkerService.runInWorker()` fails:
- User message: saved (before worker call)
- AI response messages: NOT saved
- Token usage on session: NOT tracked
- User token allowance: NOT decremented (even though LLM was called)
- Error message: saved for scheduled sessions only

The worker (generateMarketingResponseWorker.ts) catches errors and sends them back to the parent process, but the error message contains no usage data. The LLM may have been called (and tokens consumed) before the error occurred.

## Architecture Note

**`chatbotService.ts` is legacy infrastructure** — it powers the partner portal chatbot and provides shared DB operations (session CRUD, message persistence, token tracking). The primary intelligence service is **`agentModeService.ts`** (Agent Mode), which handles all agent, emma-sidebar, scheduled, and Slack bot sessions. The `generateChatResponse()` function in chatbotService is only used by the partner portal's `/api/chatbot` endpoint and is not actively maintained. Future work should consolidate onto the Agent Mode path and deprecate the chatbot-specific response generation.

## Recommendations

1. **Capture partial usage on worker failure**: When the worker throws, include accumulated usage data in the error payload so the parent can still call `incrementTokenUsage()`.
2. **Backfill historical sessions**: For sessions created before usage tracking (pre March 26), usage data is unrecoverable since individual message usage was never recorded.
3. **Monitor for incomplete sessions**: Add alerting for sessions where `calledFunctions` is populated but `totalTokens` is missing — indicates a worker failure with lost usage.

# March 27, 2026: Investigation — Sessions Not Showing Up in Customer Portal

## Problem

Admin page (Users tab) shows 15+ sessions for a customer (`harshitshah1989@gmail.com`), but the customer portal only shows 1 session. The session counts between admin and customer views are inconsistent.

## Root Cause

**Portal type filtering mismatch between admin count and customer portal query.**

### Production data for the affected user (userId: `100c8fa5-8444-4dfb-81b3-805f29d8e39e`)

- **16 total sessions** in `AW-ChatSessions`
  - 1 session with `portalType = 'agent'` (main agent chat)
  - 15 sessions with `portalType = 'emma-sidebar'` (Emma assistant sidebar)
  - None archived

### Admin page count (`db.ts` → `getChatSessionCount`)

Queries `AW-ChatSessions` `UserIdIndex` with only an archived filter — counts ALL session types:
```
COUNT(sessions WHERE userId = :userId AND (archived not set OR archived = false))
```
Result: **16 sessions**

### Customer portal list (`agentModeController.ts:1570`)

Defaults `portalType` to `'agent'` when not passed by the frontend:
```typescript
const portalType = (req.query.portalType as string) === 'emma-sidebar'
  ? 'emma-sidebar' as const : 'agent' as const;
```
The frontend hook (`useAgentModeSessions.ts` → `loadSessions`) calls `GET /api/agent-mode/sessions?limit=50` without a `portalType` parameter, so it defaults to `'agent'` and only returns agent sessions.

Result: **1 session**

### Additional note on emma-sidebar session creation

The 15 emma-sidebar sessions were created in rapid bursts (many within seconds of each other around 09:13 and 09:59 UTC on March 26), suggesting repeated page loads or sidebar reconnections are creating new sessions each time.

## Fix Options

1. **Fix admin count** — filter `getChatSessionCount` by portalType so it matches what the customer sees (or show a breakdown)
2. **Show emma-sidebar sessions in customer portal** — include them in the session list
3. **Both** — accurate admin counts AND full session visibility in customer portal

---

# March 27, 2026: Investigation — Landing Page Preview URLs Returning `not_found`

## Problem

The coding agent's `get_landing_page_preview_url` tool was consistently returning `buildStatus: "not_found"` for draft branch preview deployments. Observed in session `2db6affe-75f1-4502-8cbc-5e2c476dab6b` (Waldium hero banner redesign) — the tool was called 3 times, all returning not_found despite the draft branch having valid commits pushed via the GitHub API.

## Root Cause

**Two Vercel projects existed for the same customer**, created at different times:

1. **Original project** (`waldium-lander`, `prj_P6X3YHKGydAVFN3xtml1dxl1Haqo`) — linked to the consolidated repo `AgentWebPro/v0-waldium-lander`, serving production at `start.waldium.com`, receiving all branch push webhooks and creating preview deployments correctly.
2. **Auto-generated project** (`lp-waldium-value-first-landing-pa-0ae94752`, `prj_ZlAxFRUuxfowuTCAsjyiDngVBj0p`) — created by the `createVercelProject()` flow in `v0Service.ts` when a new landing page was generated. Linked to a stale auto-generated repo `AgentWebPro/lp-waldium-value-first-landing-pa-0ae94752`, which had no draft branches and no recent deployments since March 18.

All 5 Waldium landing page records in `AW-LandingPages` had `vercelProjectId` pointing to the **wrong** (auto-generated) project. When `getPreviewDeploymentUrl()` queried Vercel's deployments API for `prj_ZlAxFRUuxfowuTCAsjyiDngVBj0p`, it found no deployments matching the draft branch — because the coding agent pushed code to `v0-waldium-lander`, which only the original project was watching.

## Investigation Steps

1. Retrieved session data from `AW-ChatSessions` — `calledFunctions` showed `get_landing_page_preview_url` called 3x, `coding_agent` called 2x (retried after preview failure).
2. Confirmed draft branch `draft/2db6affe-75f1-45` existed in `AgentWebPro/v0-waldium-lander` with 4 commits.
3. Used Vercel API (token from `dev/AgentWeb/Vercel` in Secrets Manager) to list deployments on the DB-referenced project — found only `main` branch deployments from March 18, zero draft branch deployments.
4. Discovered a second Vercel project (`waldium-lander`) linked to the correct repo, which had READY deployments for all draft branches including `draft/2db6affe-75f1-45`.

## Fix

Updated `vercelProjectId` in `AW-LandingPages` DynamoDB table for all affected records:

**Waldium** (5 pages): `prj_ZlAxFRUuxfowuTCAsjyiDngVBj0p` → `prj_P6X3YHKGydAVFN3xtml1dxl1Haqo`
**Haven** (2 pages): `prj_CRoy9Bt1h23v4az2NrRvRpq5DsRz` → `prj_U38WBYiLKZdjh1IUcfyIBhQTtzaE`

Full prod scan of all 32 landing pages across 6 Vercel projects confirmed only Waldium and Haven were affected. Other customers (xCures, AgentWeb SEO, Your360, AgentWeb Main) had matching repo/project configurations.

## Lesson

When a customer's landing pages are consolidated into a single `v0-*` GitHub repo, the `vercelProjectId` in DynamoDB must be updated to match the Vercel project that is actually linked to that repo. The auto-generated `lp-*` Vercel project (created by `createVercelProject()` during initial page generation) becomes stale after consolidation.

To diagnose similar issues in the future:
- Compare `githubRepoUrl` in `AW-LandingPages` against the Vercel project's `link.repo` via `GET /v9/projects/{id}`
- If they point to different GitHub repos, the preview URL flow is broken

---

# March 26, 2026: Investigation — Recurring S3 DeleteObject Errors on Prod EB

## Problem

EB event notifications for the production environment (`Agentweb-backend-env-prod-3`, `e-ag9bmkfczz`) were reporting S3 permission errors. The `agentweb-test-env-ec2-role` lacked `s3:DeleteObject` on the EB bucket, causing cleanup failures for both tail logs and bundle logs:

**Tail logs** (from cron-based log monitoring):
```
Service:Amazon S3, Message:User: arn:aws:sts::992382574572:assumed-role/agentweb-test-env-ec2-role/i-07d440d734bbbcf55
is not authorized to perform: s3:DeleteObject on resource:
"arn:aws:s3:::elasticbeanstalk-us-west-2-992382574572/resources/environments/logs/tail/..."
```

**Bundle logs** (from manual `request-environment-info --info-type bundle`):
```
Service:Amazon S3, Message:User: arn:aws:sts::992382574572:assumed-role/agentweb-test-env-ec2-role/i-03e403b3c8620a994
is not authorized to perform: s3:DeleteObject on resource:
"arn:aws:s3:::elasticbeanstalk-us-west-2-992382574572/resources/environments/logs/bundle/..."
```

## Root Cause

When any IAM role calls `aws elasticbeanstalk request-environment-info`, EB uploads logs to S3 and later tries to clean up (delete) old log files **using the caller's IAM role**. The `agentweb-test-env-ec2-role` had `elasticbeanstalk:RequestEnvironmentInfo` and `elasticbeanstalk:RetrieveEnvironmentInfo` but **not** `s3:DeleteObject` on the EB bucket. EB successfully collected and returned logs, but cleanup failed every time, generating ERROR events.

## Fix

Added `s3:DeleteObject` permission to `agentweb-test-env-ec2-role`, scoped to the entire EB bucket:

```json
{
  "Sid": "AllowEBLogCleanup",
  "Effect": "Allow",
  "Action": "s3:DeleteObject",
  "Resource": "arn:aws:s3:::elasticbeanstalk-us-west-2-992382574572/*"
}
```

Verified the fix by successfully deleting a bundle log object that previously failed.

## Lesson

When granting EB log retrieval permissions to an IAM role, also grant `s3:DeleteObject` on `elasticbeanstalk-<region>-<account>/*` so EB can clean up temporary log fragments (both tail and bundle types).

---

# March 25, 2026: Investigation — LiteLLM Vulnerability Impact on AgentWeb

## Background

Multiple CVEs have been disclosed against **LiteLLM** (BerriAI's LLM proxy/gateway library):

| CVE | Score | Severity | Description |
|-----|-------|----------|-------------|
| CVE-2024-4888 | 8.1 | High | Arbitrary file deletion via `/audio/transcriptions` endpoint |
| CVE-2024-10188 | 7.5 | High | DoS via `ast.literal_eval` on user input |
| CVE-2025-45809 | 5.4 | Medium | SQL injection via `/key/block` and `/key/unblock` API endpoints |
| CVE-2025-11203 | 3.5 | Low | API key information disclosure via health endpoint |

## Investigation Findings

**AgentWeb is NOT impacted.** LiteLLM is neither a direct nor transitive dependency.

### What we checked

- `agent-engine/requirements.txt` — no litellm
- `agent-engine/environment.yml` — no litellm
- `backend/package.json` — no litellm
- Full codebase grep for "litellm" — zero code references
- Transitive dependency check: browser-use, ag2 (AutoGen), and langchain packages do not pull in litellm

### How AgentWeb integrates with LLMs instead

AgentWeb uses direct SDK integrations, not a proxy layer:
- **AWS Bedrock SDK** — for Claude models (via `@aws-sdk/client-bedrock-runtime`)
- **Azure OpenAI SDK** — for GPT-4o/GPT-4.1
- **Google GenAI SDK** — for Gemini models
- **OpenAI SDK** — direct API access
- **LangChain** — abstraction layer in agent-engine (does not depend on litellm)

### Conclusion

No remediation action required. AgentWeb's direct-SDK approach avoids the proxy-layer attack surface that LiteLLM exposes.

---

# March 24, 2026: Investigation — Meta Pixel / CAPI Detection on Landing Pages

## Problem

Agent mode session `6219e856-e54a-45cb-b82f-2d14598957bc` (Your360.ai) generated a Meta Ads optimization report that flagged "No conversion tracking" as a critical blocker — the "Results" columns in Meta Ads Manager were empty, suggesting the Meta Pixel or Conversions API was not firing on lead form submissions.

## Investigation Findings

Double-checked Facebook Ads Manager directly. The **Event Match Quality score is 8.3** — pixel tracking is actually working correctly. The pixel is implemented through **PixelFlow** (a third-party pixel management tool), which is why it was not detected by our agent during the page inspection. PixelFlow loads the pixel asynchronously/indirectly, making it invisible to standard DOM-based pixel detection methods.

### Root Cause

Our agent's analysis relied on inspecting the landing page source for Meta Pixel base code (`fbq('init', ...)` or `connect.facebook.net/en_US/fbevents.js`). Since PixelFlow injects the pixel through its own loader, the standard detection approach missed it entirely, leading to a false-positive "no pixel installed" finding in the report.

### Next Steps

Enhance the Meta Ads API integration to support loading **Event Match Quality** scores directly from the Facebook Marketing API. This will allow future analyses to verify pixel health programmatically rather than relying solely on page source inspection. Key endpoints to integrate:

- `GET /{pixel-id}?fields=data_use_setting,event_match_quality` — pixel-level match quality
- `GET /{ad-account-id}/customconversions` — custom conversion event health

This will make the agent's pixel/CAPI assessments more accurate and avoid false positives when third-party pixel managers (PixelFlow, Google Tag Manager, Segment, etc.) are used.

---

# March 23, 2026: Investigation — Supporting Vendor Role in the System

## Background

Currently the system has two roles: **admin** (`isAdmin: true`) and **user** (default). We want to add a **vendor** role so external partners (e.g., agencies, consultants) can access the platform with appropriate permissions.

## Investigation

### Current Role Model

- Users table (`AW-Users`) has an `isAdmin` boolean field
- Backend `authenticateToken` middleware sets `req.user.isAdmin` from the JWT
- Admin checks are scattered across routes using `if (!req.user.isAdmin)` guards
- Frontend checks `user.isAdmin` from AuthContext to show/hide admin features

### Options Considered

1. **Add a `role` enum field** (`"admin" | "user" | "vendor"`) — cleaner long-term but requires migrating all `isAdmin` checks across backend and frontend
2. **Add `isVendor` boolean** — minimal change, mirrors `isAdmin` pattern, but doesn't scale if more roles are added
3. **Grant vendor users admin role temporarily** — zero code changes, quickest path

### Decision

For now, we grant vendor user **Harshit** the admin role for simplicity. This avoids any code changes and unblocks vendor access immediately. A proper role system can be implemented later when requirements are clearer and more vendors need distinct permissions.

### Action Taken

- Harshit's user record updated with `isAdmin: true` in the Users table

---

# March 22, 2026: Investigation — Scheduled Chat "Lead Auto-Enrichment" Not Completing

## Problem

User reported that the "Lead Auto-Enrichment" scheduled chat (scheduleId: `35b7c3eb-9cf2-4a61-b259-5b12040a302e`) was "not completing the requested ask" for three days in a row.

## Investigation Findings

The schedule was actually completing successfully — all three runs (March 20 attempt 1, March 20 attempt 2, March 21 attempt 2) had `status: "success"` and `passed: true` with all work plan steps completed.

The user's concern was that lead enrichment "didn't happen." Root cause: **enriched fields were written to custom fields** in the CRM, not the standard fields the user was checking. The enrichment was working correctly, but the results were in a different place than expected.

### Schedule Details

- **Prompt:** Enrich leads from 6 CRM lists, recommend top 10 for LinkedIn outreach, draft 2 post-connection messages
- **Model:** `anthropic.claude-opus-4-6-v1`
- **Validation:** `functionCallMinCalls: { linkedin_outreach: 1 }` — note: this requirement exists but the prompt only asks to "draft" messages, not send them. All runs passed validation regardless.
- **Runs examined:** 3 sessions, all enriching 214-221 leads with 0 failures

### Resolution

No code change needed. User confusion about where enriched data appears in the CRM (custom fields vs standard fields).

---

# March 20, 2026: Investigation — UseHaven.ai Meta Marketing Connected Account Issue

## Problem

Two issues reported by UseHaven.ai (usehaven.ai) when connecting Meta Marketing accounts:

1. **Matt (existing user):** When connecting Meta Marketing, Facebook asks him to reconnect because he previously connected with a different account.
2. **Harsha (new user):** When attempting to connect, sees an "App does not exist" error.

## Investigation Findings

### Architecture Overview

- Meta OAuth flow: `metaAuth.ts` handles init → Facebook Login popup → callback → finalize (token exchange) → connect-ad-accounts
- Credentials stored in AWS Secrets Manager at `prod/AgentWeb/MetaApp` (contains `clientId`, `clientSecret`, `instagramClientId`, `instagramClientSecret`)
- Connected accounts stored in DynamoDB `AW-Users` table under `connected_accounts` array
- Token sessions stored in-memory with 10-minute TTL

### Root Cause: App in Development Mode

The "App does not exist" error for Harsha is caused by the **Meta/Facebook App being in Development Mode**. In Development Mode, only users listed as App Admins, Developers, or Testers in the Facebook App settings can use the OAuth flow. All other users see "App does not exist."

Matt could connect because he was likely added as a tester/developer on the app. The "reconnect" prompt is standard Facebook behavior when a user re-authorizes an app — Facebook remembers the prior authorization and asks to confirm.

### Actions Taken

1. **Made the app Live** — switched from Development to Live mode in Meta Developer Console
2. **Completed Data Use Checkup** — required for Live mode compliance
3. **Harshit submitted for App Review** — required for advanced permissions (ads_management, ads_read, pages_show_list)

### Key Files

- `backend/src/routes/metaAuth.ts` — OAuth init, callback, finalize, connect endpoints
- `backend/src/routes/metaV2.ts` — Ad creation API using connected account tokens
- `backend/src/config/integrations.ts` — OAuth URLs, scopes, redirect URIs
- `backend/src/utils/secretsManager.ts` — `getMetaCredentials()` and `getInstagramCredentials()`
- `backend/src/services/connectedAccountsDb.ts` — Account storage (createAccount, updateAccountTokens)
- `customer-portal/src/pages/MetaOAuthCallback.tsx` — Frontend OAuth callback handler
- `customer-portal/src/pages/Settings.tsx` — `startMetaOAuth()` initiates the flow

### Status

Pending App Review approval from Meta. Will revisit once review is complete. After approval, all users should be able to connect Meta Marketing accounts without the "app does not exist" error.

---

# March 20, 2026: Proposal — Token Limits Per Subscription Tier

## Context

We have four subscription tiers (Free, Starter, Pro, Enterprise) but no token usage limits. All tiers currently allow unlimited Agent Mode token consumption. With $0 in cloud credits (AWS, Google Cloud, Azure), every token is a direct cost. We need per-tier limits that:
- **Free:** Let users see enough value to convert, but cap usage to incentivize upgrades
- **Starter/Pro:** Be generous enough to retain paying users while maintaining healthy margins
- **Enterprise:** Unlimited or custom-negotiated

## Current State

- Token usage is tracked **per message** in `ChatSession.messages[].usage` (prompt_tokens, completion_tokens, total_tokens, estimated_cost)
- No aggregate monthly tracking per user exists
- No enforcement or limits exist — all tiers have unlimited consumption
- Internal tiers: Free, Basic (Starter), Super Premium (Pro). Enterprise not yet in code.

## LLM Cost Reference (per 1M tokens)

| Model | Input | Output | Blended* | Provider |
|-------|------:|-------:|---------:|----------|
| Claude Sonnet 4.5/4.6 | $3 | $15 | $10.20 | AWS Bedrock |
| Claude Opus 4.6 | $15 | $75 | $51.00 | AWS Bedrock |
| GPT-5 | $2.50 | $10 | $7.00 | Azure |
| GPT-5.2 | $3 | $12 | $8.40 | Azure |
| Gemini 3 Pro | $1.25 | $10 | $6.50 | Google |
| Gemini 3 Flash | $0.15 | $0.60 | $0.42 | Google |
| Gemini 3.1 Flash Lite | $0.075 | $0.30 | $0.21 | Google |

*Blended = weighted avg assuming ~40% input, ~60% output tokens (typical agent conversations)*

Default model: GPT-5 (`gpt-5-chat-2`), blended cost ~$7/1M tokens.

## Typical Session Token Usage

| Session Type | Tokens/Session | Examples |
|-------------|---------------:|---------|
| Simple Q&A | 30K–50K | Quick marketing question, 2-3 turns |
| Content creation | 80K–150K | Blog post, social posts, with revisions |
| Research/analysis | 100K–200K | Market analysis, competitor research |
| Complex workflow | 200K–500K | Multi-step task with tool calls |
| Scheduled chat | 50K–150K | Automated recurring tasks |

**Median session: ~100K tokens**

## Proposed Token Limits

| Tier | Price | Monthly Token Limit | ~Sessions/Month | Our Blended Cost (GPT-5) | Gross Margin |
|------|------:|--------------------:|----------------:|-------------------------:|-------------:|
| **Free** | $0 | **1M** | ~10–15 | ~$7 | -$7 (acquisition cost) |
| **Starter** | $199 | **15M** | ~100–150 | ~$105 | ~$94 (47%) |
| **Pro** | $499 | **50M** | ~300–500 | ~$350 | ~$149 (30%) |
| **Enterprise** | Custom | **Unlimited** | Unlimited | Negotiated | Negotiated |

### Free Tier Rationale ($0/mo → 1M tokens)
- Enough for ~10–15 meaningful sessions (blog post, social content, brand strategy)
- Users see value within first few days but hit the wall within the first week of active use
- At ~$7/user/month cost, even a 5% conversion rate to Starter ($199) is profitable after ~3–5 free users per paid conversion

### Starter Tier Rationale ($199/mo → 15M tokens)
- ~5–7 sessions/day on weekdays — comfortable for SMB marketing teams
- 47% gross margin at GPT-5 blended rates; 23% margin if users primarily use Sonnet
- Power users may hit the limit in week 3–4, creating natural upsell to Pro

### Pro Tier Rationale ($499/mo → 50M tokens)
- ~15–20 sessions/day — heavy automation, scheduled chats, multi-step workflows
- 30% margin at GPT-5; margin is thin/negative if users predominantly use Opus
- Rarely hit limit unless running Opus-heavy workloads

### Enterprise Rationale (Custom → Unlimited)
- Custom pricing presumably $1,000+/mo
- Internal soft alert at 100M tokens/month for monitoring
- SLA-backed with negotiated terms

## Model Cost Multiplier (Recommended)

To protect margins across tiers, apply a multiplier so expensive models consume more of the budget:

| Model Tier | Multiplier | Rationale |
|-----------|----------:|-----------|
| Gemini Flash / Flash Lite | 0.1x | 10–50x cheaper than baseline |
| GPT-5 / Gemini Pro | 1x (baseline) | ~$7/1M blended |
| GPT-5.2 | 1.2x | Slightly more expensive |
| Claude Sonnet 4.5/4.6 | 1.5x | ~50% more expensive than GPT-5 |
| Claude Opus 4.6 | 7x | ~7x more expensive than GPT-5 |

Example: A 50K-token Opus session counts as 350K "weighted tokens" toward the monthly limit.

**Alternative (simpler):** No multiplier, but restrict model availability per tier:
- Free/Starter: GPT-5, Gemini models, Claude Sonnet only
- Pro: All models including Opus
- Enterprise: All models

## Overage Behavior (Recommended)

1. **Warning at 80%** — In-app banner: "You've used 80% of your monthly token budget"
2. **Soft block at 100%** — New sessions blocked, but current in-progress session allowed to finish
3. **Grace period** — Allow up to 5% overage to avoid mid-session cutoffs
4. **Reset** — Monthly, aligned to Stripe billing period (`current_period_end`)

## Implementation Plan

### Phase 1: Tracking Infrastructure
1. Add `tokenUsage` fields to `AW-Users` table:
   - `tokenUsage.currentMonth.year`, `tokenUsage.currentMonth.month`
   - `tokenUsage.currentMonth.totalTokensUsed` (weighted)
   - `tokenUsage.currentMonth.rawTokensUsed` (unweighted)
   - `tokenUsage.currentMonth.estimatedCostUSD`
   - `tokenUsage.currentMonth.resetDate` (ISO)
2. Update `agentModeService.ts` to increment user token usage after each LLM call
3. Add monthly reset logic (check on each request if month has rolled over)

### Phase 2: Limit Enforcement
4. Add `monthlyTokenLimit` to tier configs in `AW-Settings` → `subscription_types`
5. Add pre-check in Agent Mode: reject new sessions if user is at/over limit
6. Add 80% warning emission via Socket.IO
7. Allow in-progress sessions to complete (grace overage up to 5%)

### Phase 3: User-Facing
8. Add token usage display to customer portal Settings page
9. Add usage bar/indicator in Agent Mode sidebar
10. Add upgrade prompts when approaching/hitting limits

### Files to Modify
- `backend/src/services/agentModeService.ts` — token tracking, limit checks, model multiplier
- `backend/src/services/chatbotService.ts` — add `tokenUsage` to User interface
- `backend/src/services/db.ts` — add `updateUserTokenUsage()`, `getUserTokenUsage()`
- `backend/src/services/subscriptionService.ts` — add `monthlyTokenLimit` to tier configs
- `backend/src/controllers/agentModeController.ts` — pre-session limit check
- `customer-portal/src/pages/Settings.tsx` — usage display
- `customer-portal/src/components/AgentMode/` — usage bar, warning banner

---

# March 20, 2026: Investigation — AgentWeb.pro Lead Gen Path Broken

## Context

The lead generation process from AgentWeb.pro (our Webflow landing site) was broken for weeks without detection. Investigated the full lead capture flow using browser testing to identify all issues.

## Critical Finding: Nav Menu "Get Started" Links to Job Application Form

The hamburger menu's **"Get Started"** button links to a **job application form** on Surface:
- **Menu CTA URL:** `https://forms.withsurface.com/s/cmhlafdiv0001js0bfy1qaxhh` → "AgentWeb Job Application" (asks about work authorization, what you've built, etc.)
- **Correct URL (used by hero + bottom CTAs):** `https://forms.withsurface.com/s/cmdzs6o9i007rky04xg1157yk` → "Train Emma" lead capture form (asks for work email, name, company, phone)

**Impact:** On mobile, the hamburger menu is the primary navigation. Any visitor clicking "Get Started" from the nav menu was sent to a hiring form instead of becoming a lead. They likely bounced immediately. This silently killed lead conversion with no visible error.

## Other Issues Found

### Cloudflare Turnstile Error (600010)
- Console repeatedly logs `[Cloudflare Turnstile] Error: 600010` and `Failed to load resource` errors on all pages
- Turnstile is the bot-protection widget likely guarding the newsletter signup form
- The `failure_retry` path also fails, so it doesn't recover
- May allow spam submissions or block legitimate users in certain browsers

### No Lead Capture CTA on Content Pages
- `/case-studies` page lists 5 case studies but has no "Get Started" CTA in main content
- Same for `/blog` pages — only the footer newsletter form is available
- Visitors reading about results (e.g., "417 demo requests", "328 add to carts") have no obvious path to the lead form

### /build Page Skips Lead Capture
- "Start Free Trial" goes directly to Stripe checkout ($199/mo after 7-day trial)
- No email capture before the paywall — visitors who aren't ready to pay leave with zero data captured

### rankai.ai External Script
- Every page loads `https://rankai.ai/apply.js` which rewrites alt text, anchor titles, Open Graph meta tags, and injects schema markup after page load
- This external dependency modifies the DOM — worth verifying it's not interfering with lead capture elements or causing the Turnstile issue

## Lead Capture Paths Summary

| Location | CTA Text | Destination | Status |
|---|---|---|---|
| Homepage hero | "Get Started" | Surface lead form | OK |
| Homepage bottom | "Get Started" | Surface lead form | OK |
| **Nav menu** | **"Get Started"** | **Surface JOB APPLICATION** | **BROKEN** |
| /build hero | "Start Free Trial" | Stripe checkout | OK (no lead capture) |
| Footer (all pages) | Newsletter "Submit" | Webflow newsletter | OK (with Turnstile errors) |
| Nav menu | "Log In" | app.agentweb.pro/login | OK |
| Nav menu | "Contact" | mailto:founders@agentweb.pro | OK |

## Fix Required

These fixes must be made in the **Webflow editor** (not in this codebase):
1. **P0:** Fix nav menu "Get Started" link to point to `cmdzs6o9i007rky04xg1157yk` (the lead form, not the job application)
2. **P1:** Investigate and fix Cloudflare Turnstile error 600010
3. **P2:** Add "Get Started" CTAs to case studies and blog pages
4. **P3:** Update copyright year from 2025 to 2026

---

# March 19, 2026: Investigation — X/Twitter Outreach via Unipile

## Context

Investigated adding X/Twitter outreach support via Unipile, mirroring our existing LinkedIn outreach integration. Unipile's SDK includes `TWITTER` as a supported provider (`AvailableAccountProvider` union), and the hosted auth link API accepts `providers: ['TWITTER']`.

## Findings

### Unipile SDK Support

- The `unipile-node-sdk` package lists `TWITTER` as a valid provider alongside `LINKEDIN`, `WHATSAPP`, `INSTAGRAM`, `MESSENGER`, `TELEGRAM`, `MAIL`, `GOOGLE`, `OUTLOOK`, and `IMAP`.
- Account creation types (`accounts-create.types.d.ts`) include Twitter-specific schemas.
- The messaging API (`messaging.startNewChat`, `messaging.sendMessage`) is provider-agnostic and would work for Twitter DMs.
- The users API (`users.sendInvitation`, `users.getAllRelations`) maps to follow/following on Twitter.

### Implementation Plan (Designed but Not Built)

The plan was to mirror the LinkedIn outreach pattern:
- New platform type `'unipile_twitter'` in `connectedAccountsDb.ts`
- New service `xTwitterOutreachService.ts` reusing the shared Unipile client
- New auth route `xTwitterOutreachAuth.ts` with `providers: ['TWITTER']`
- New emma tool `x_twitter_outreach` with actions: `send-dm`, `get-profile`, `follow`, `search-users`, `list-following`, `get-posts`
- Frontend: callback page, Settings platform card, ConnectedAccountsList section

### Blocker: Unipile Twitter Support Suspended

Per Unipile's website and support team (March 2026): **Twitter/X integration is no longer actively maintained.** Their support indicated it may return in a few months. The SDK types still include `TWITTER` but the backend service may reject connections.

### Unipile Actively Maintained Integrations (as of March 2026)

Per Unipile support, the following providers are currently actively maintained:
- **Emails** (MAIL, GOOGLE, OUTLOOK, IMAP)
- **WhatsApp**
- **LinkedIn**
- **Telegram**
- **Instagram**

Twitter/X and Messenger are not on the active list.

## Decision

Paused implementation. Will revisit when Unipile confirms Twitter support is restored. The implementation design is documented above and in `.claude/plans/whimsical-conjuring-stroustrup.md` for when we're ready to proceed.

---

# March 19, 2026: Investigation — Sessions with 0 Messages

## Context

Production data shows a high ratio of sessions with 0 messages. For example, in a 24-hour window there were ~54 sessions but only ~22 had messages. This investigation identifies the root cause.

## Findings

### Session Creation Flow

1. **Frontend** (`customer-portal/src/pages/AgentMode.tsx:2176-2253`): `createNewSession()` calls `POST /api/agent-mode/sessions` eagerly — on page load when no sessionId is in the URL, or when the user clicks "New Chat".

2. **Backend controller** (`backend/src/controllers/agentModeController.ts:1529-1568`): Creates the session record immediately with `portalType: 'agent'`.

3. **Database layer** (`backend/src/services/chatbotService.ts:455-550`): For Agent Mode sessions (`portalType === "agent"`), the system message is `null`, so the session is created with **`messages: []`** (empty array). Messages are only added later when the user actually sends a message, and they go into the separate `AW-ChatMessages` table.

### Why So Many Empty Sessions

The primary cause is **eager session creation on page load**. Every time a user navigates to `/agent-mode` (or `/agent-mode/new`), a new session is created before they type anything. Common scenarios that produce empty sessions:

- **Page refresh**: User refreshes the Agent Mode page → new session created, old one abandoned
- **Navigation bounce**: User opens Agent Mode, then navigates away without sending a message
- **Multiple tabs**: Each tab/window opening Agent Mode creates its own session
- **URL routing**: When no sessionId is in the URL, the frontend routes to `/agent-mode/new` which triggers `createNewSession()`

Additional creation points that may produce empty sessions:
- **Admin/GTM Plan** (`backend/src/routes/admin.ts:3558`): Creates sessions for GTM work items
- **GTM Plan Route** (`backend/src/routes/gtmPlan.ts:1309`): Creates sessions during GTM plan operations
- **Slack Bot** (`backend/src/routes/slack.ts:230`): Creates sessions on Slack events

### Key Data Points

- `messageCount` on the session record reflects the count of messages in the `AW-ChatMessages` table (separate from the legacy `messages` array on the session itself)
- Sessions with `messageCount = 0` never had any user or assistant messages sent
- This is not a data integrity issue — the sessions genuinely have no messages

## Recommended Fix: Lazy Session Creation

**Approach**: Don't create a session until the user sends their first message.

### Frontend Changes (`customer-portal/src/pages/AgentMode.tsx`)

1. When navigating to `/agent-mode/new`, show an empty chat UI without calling `createNewSession()`
2. On first message send, call `createNewSession()` first, then send the message
3. The "New Chat" button should reset the UI state locally without creating a backend session

### Backend Changes (minimal)

No backend changes needed — the `POST /api/agent-mode/sessions` endpoint works fine. The change is purely about **when** the frontend calls it.

### Expected Impact

This should reduce empty sessions by ~60% (the ratio seen in production). Sessions created by admin/GTM/Slack flows would still exist but are a much smaller volume.

---

# March 19, 2026: storywithai.info Blog Publishing — GoDaddy Website Builder Investigation

## Context

Customer site `storywithai.info` uses GoDaddy for CMS. Investigated whether we can support GoDaddy API or MCP for automated blog publishing.

## Site Details

- **Platform:** GoDaddy Website Builder 8.0 (Starfield Technologies)
- **Generator meta tag:** `<meta name="generator" content="Starfield Technologies; Go Daddy Website Builder 8.0.0000"/>`
- **Site ID:** `137516a9-3722-4cf9-8003-6a1c6c535872`
- **Blog URL:** `https://storywithai.info/blogs` (50 existing posts)
- **Read-only feeds:** `/blogs/f.json`, `/blogs/f.rss`, `/blogs/f.atom`
- **Content CDN:** `img1.wsimg.com/isteam/ip/{siteId}/` (images), `img1.wsimg.com/blobby/go/{siteId}/` (scripts)
- **Blog server:** DPS/2.0.0 (Digital Publishing System)

## GoDaddy API Investigation

GoDaddy offers 12 REST APIs at `developer.godaddy.com`, **none of which support CMS or blog content management**:

| API | Purpose |
|-----|---------|
| Domains | Domain registration, DNS, availability |
| Certificates | SSL certificate management |
| Abuse, Aftermarket, Agreements, ANS, Auctions, Countries, Orders, Parking, Shoppers, Subscriptions | Infrastructure/account management |

**Authentication:** API Key + Secret via `Authorization: sso-key [KEY]:[SECRET]` header. Rate limit: 60 req/min.

**Key limitation:** GoDaddy's ToS prohibits commercial use of their API behind a paywall.

## GoDaddy MCP Investigation

- **No CMS/blog MCP exists.** Only domain-related MCPs found.
- One community MCP (`Harshalkatakiya/godaddy-mcp`) — domain availability checks only, 2 GitHub stars.
- Nine auto-generated MCP wrappers — all cover registrar APIs (domains, orders, certs), not content.
- GoDaddy is not listed in the official MCP servers directory.

## Internal API Discovery

GoDaddy Website Builder uses `content.godaddy.com/api` internally:
- Responds with `"Missing X-App-Key header."` when called without auth
- CORS headers allow `GET,POST,PUT,PATCH,DELETE` — confirms write operations exist
- Required headers: `x-app-key`, `authorization`, `x-csrftoken`
- Requires GoDaddy SSO JWT token — not accessible externally
- **Undocumented, likely violates GoDaddy ToS.** No one has reverse-engineered it publicly.

## Recommendation

**Browser automation via our agent engine (Playwright)** is the most practical path:
1. Fits our existing architecture — this is what our platform does
2. Customer doesn't need to change their site
3. Log into `websites.godaddy.com`, navigate to blog editor, create/publish posts through UI
4. Fragile to GoDaddy UI changes, but no better alternative exists for this proprietary CMS

**Alternatives considered:**
- **Migrate blog to supported CMS** (Webflow/BaseHub/WordPress) — most reliable long-term, but requires customer buy-in and migration effort
- **Subdomain approach** (`blog.storywithai.info` on supported CMS) — good option since blog already exists at `/blogs`, but changes URL structure
- **Reverse-engineer internal API** — fragile, undocumented, ToS-violating, not recommended

---

# March 18, 2026: Suspicious Bot Account Signups — No Payment Gate on Registration

## Accounts Investigated

Three suspicious accounts signed up over consecutive days with gibberish Gmail addresses using the Gmail dot trick (dots in local part are ignored by Gmail, allowing unique-looking emails that deliver to one inbox):

| Email | Signed Up (UTC) | User ID |
|-------|-----------------|---------|
| `noqid.eho.b.6.4@gmail.com` | 2026-03-14 23:39 | `3f4a357e-ecb6-41c1-9ffd-40de73d27725` |
| `s.a.c.e.wo.mag.or2.8.1@gmail.com` | 2026-03-15 14:54 | `0b989e86-e5cf-4947-bb1e-46f337e23c89` |
| `l.i.j.o.ba.yug.ido.4.7@gmail.com` | 2026-03-17 21:06 | `cf9ab519-7592-424c-b75e-609283057248` |

All three accounts were deactivated (`isActive: false`).

## Behavior

All accounts followed an identical automated pattern:
- Signed up via email/password (not Google OAuth)
- Within 1–6 seconds of signup, 4 chat sessions were auto-created as the bot navigated: `dashboard` → `plan-Onboarding` → `plan/Onboarding` → `agent-mode`
- Zero user messages sent, zero tasks created, zero executions — no actual product usage
- One account also hit `forgot-password` 16s after signup
- Two accounts returned days later and visited the `settings` page

## Root Cause: Registration Endpoint Has No Payment Verification

The Stripe payment flow is entirely optional and easily bypassed:

1. **Intended flow:** User visits pricing → Stripe Checkout → redirect to `/register?session_id=cs_xxx` → email pre-filled and locked → set password → account created
2. **Actual exploit:** Bot goes directly to `POST /api/auth/register` with `{email, password}` — no `session_id` required. The backend creates the account with `roles: ["customer"]` unconditionally.

**Backend** (`POST /api/auth/register`): No Stripe session validation. Assigns `customer` role to all signups regardless of payment.

**Frontend** (`Register.tsx`): The `session_id` query param only pre-fills the email field; it's completely optional. Registration works without it.

**ProtectedRoute**: Only checks for `customer` role (which all registrants get). No subscription status or payment verification.

The only protection is a rate limiter (10 req/15min per IP), which the bots circumvented by signing up once per day.

## Future Fix (Deferred)

Options to prevent this:
1. **Require Stripe session validation** in the register endpoint — verify `session_id` with Stripe before creating the account
2. **Don't assign `customer` role at registration** — use a `pending` role and upgrade to `customer` only after Stripe webhook `checkout.session.completed`
3. **Add email verification** — require confirmation link click before activation
4. **Add CAPTCHA** (reCAPTCHA/hCaptcha/Turnstile) to the registration form

---

# March 11, 2026: LinkedIn API Limitations — Activity URNs, Post Monitoring, and Metrics Caching

## LinkedIn Activity URN vs Share URN

LinkedIn uses two different URN systems for posts:
- **Activity URNs** (`urn:li:activity:NNNNN`) — used in post URLs (e.g., `/posts/username_title-activity-NNNNN-hash`, `/feed/update/urn:li:activity:NNNNN/`)
- **Share URNs** (`urn:li:share:NNNNN`) or **ugcPost URNs** (`urn:li:ugcPost:NNNNN`) — used by LinkedIn's API internally

**Critical finding:** The numeric IDs in activity URNs are DIFFERENT from share URN numeric IDs. There is NO LinkedIn API to convert between them. LinkedIn's Posts API (`GET /rest/posts/{urn}`) only accepts share or ugcPost URNs and returns 400 for activity URNs.

## Why "Monitor Post by URL" Was Removed

We attempted to build a feature that lets users paste a LinkedIn post URL to start tracking its metrics. This was abandoned because:

1. **Most LinkedIn post URLs use activity URNs** — The `/posts/username_title-activity-NNNNN-hash` format (most common when sharing) contains an activity ID, not a share ID.
2. **LinkedIn Posts API rejects activity URNs** — `GET /rest/posts/urn:li:activity:NNNNN` returns 400 "not a valid urn type".
3. **No activity→share conversion API exists** — We tested `q=activity` finders, social metadata, and other endpoints. None return the share URN for a given activity URN.
4. **socialMetadata endpoint** (`GET /rest/socialMetadata/urn:li:activity:NNNNN`) is the only API that accepts activity URNs, but it only returns reaction counts and comment counts — no impressions, no post content, no share URN.
5. **Personal tokens get 403** on the Posts API (`UGC_FORBIDDEN`), so even for share URNs, personal posts can't be fetched directly.

**Conclusion:** Monitoring arbitrary LinkedIn posts by URL is not viable with the current LinkedIn API. Posts must be created through AgentWeb to be tracked.

## Metrics Caching Fix

When the LinkedIn API rate-limits or errors, the adapter's `getPostMetrics()` was returning all-zero metrics to the frontend. On subsequent page loads, if the cache TTL had expired, another API call would fail again, showing persistent 0s.

**Fix:** On API failure, fall back to stale cached metrics from DynamoDB instead of returning 0s. Only return 0s if no cached metrics exist at all.

## Activity URN Metrics Fallback

For posts stored with `urn:li:activity:` URNs (legacy data from the removed monitor feature), the `memberCreatorPostAnalytics` API throws "Invalid post URN format". The adapter now detects activity URNs and uses the `socialMetadata` endpoint as a fallback, providing likes and comments (but not impressions).

---

# March 8, 2026: Daily AI News - Amino Scheduled Chat Failure — Missing Tools for Basic Subscription

**User:** `sue@aminocapital.com` (Amino Capital, Basic subscription)

**Problem:** The "Daily AI News - Amino" scheduled chat failed to run because some required tools are not available under the Basic subscription. New skills were recently created (e.g., Landing Page skill for Advanced/Super Premium) that claimed tools previously available via the `__other_skills__` virtual skill. This moved those tools out of `__other_skills__`, causing Basic subscription users to lose access.

**Root cause:** The `__other_skills__` virtual skill dynamically resolves to tools NOT associated with any published skill. When new skills are published and claim tools, those tools leave `__other_skills__`. If a subscription type (e.g., Basic) relies on `__other_skills__` for tool access, users silently lose tools whenever new skills are created.

**How subscription → tools resolution works:**
1. User's `subscriptionType` → `getSubscriptionTypeConfig()` → `allowedSkills[]` (skill IDs)
2. `resolveSkillsToToolNames(skillIds)` → expands each skill ID to its `toolNames[]`
3. `__other_skills__` resolves to tools not claimed by any published skill (dynamic, shrinks as skills are added)
4. Foundation tools (18) are always available regardless of subscription
5. Scheduled chat pre-flight check (`agentModeController.ts:810-867`) validates `requiredFunctionCalls` against allowed tools, fails with error email if any are disallowed

**Action taken:** Created a new skill "Tools for Basic Subscription" via admin UI with 38 explicit tools and no system prompt. This skill is added to the Basic subscription's `allowedSkills`, ensuring Basic users have a stable set of tools regardless of how other skills change.

**Tools in "Tools for Basic Subscription" (38):**
```
create_blog_article, publish_blog_article, repair_blog_article, create_social_media_posts,
list_cms_categories, generate_image, create_image_task_from_prompt, generate_video,
list_task_templates, create_task_from_template, create_task_from_prompt, create_revision,
perform_deep_research, list_connected_account_posts, load_connected_account_metrics,
post_on_connected_account, get_post_analytics, create_knowledge_base, update_knowledge_base_file,
attach_knowledge_base_files, create_gtm_plan, read_gtm_plan, update_gtm_plan, list_gtm_plans,
add_gtm_phase, update_gtm_phase, add_gtm_work_items, update_gtm_work_item, delete_gtm_items,
get_gtm_common_items, add_gtm_common_items, send_gtm_status_report, comment_on_linkedin_post,
react_to_linkedin_post, linkedin_outreach, create_html_from_template, update_html_file,
list_html_templates
```

**Tools excluded from Basic (in other premium skills):**
- CRM/Leads (17 tools): get_leads, get_lead_details, create_lead_list, etc.
- Books (8 tools): create_book, generate_book_content, add_characters, etc.
- Email: email, send_for_review
- Meta Ads: get_meta_ads_metrics, list_meta_ads_campaigns

**Key files:**
- `backend/src/services/subscriptionService.ts` — subscription → skill → tool resolution
- `backend/src/services/skillService.ts` — skill CRUD (AW-Skills table)
- `backend/src/controllers/agentModeController.ts:810-867` — scheduled chat tool validation
- `backend/src/services/agentModeService.ts:1717` — FOUNDATION_TOOLS definition

**Lesson:** When creating new skills, always check if the tools being claimed are currently accessed by subscription tiers via `__other_skills__`. Prefer explicit tool skills per subscription tier over relying on `__other_skills__` for stable access.

---

# March 6, 2026: xcures SEO Config — GA Permission Denied

**User:** `agentwebintegration@xcures.com` (userId: `f958eb3e-4e82-4227-8aa8-634476498a62`)

**Config in DynamoDB (AW-Users):**
- `seoDomains`: `["xcures.com"]`
- `googleAnalyticsPropertyId`: `"277333489"`
- `gaFilteredDomains`: `[]`

**Findings:**
- **Google Search Console:** Working. No errors in prod logs for `sc-domain:xcures.com`.
- **Google Analytics:** `PERMISSION_DENIED` — service account does not have access to GA4 property `277333489`.

**Prod log (Mar 6):**
```
Error fetching Google Analytics metrics: Error: 7 PERMISSION_DENIED: User does not have sufficient permissions for this property.
```

**Action needed:** xcures team must grant **Viewer** access to the service account email in GA4 Admin → Property access management for property `277333489`. The same service account (from `prod/AgentWeb/Google/SearchConsole` secret) is used for both GSC and GA.

---

# March 6, 2026: MCP Server IDOR Vulnerability — userId Override in Tool Arguments

**Problem:** The Emma MCP server (`backend/src/mcp/server/mcpServerCore.ts`) allows tool callers to override the authenticated user's identity by passing a `userId` in tool call arguments. In the request handler:

```typescript
const context = {
  userId: userId || sessionContext?.agentUserId,
  // userId from tool args takes precedence over the authenticated user
};
```

Any authenticated user (with a valid API key, OAuth token, or static MCP token) can pass any `userId` and operate on another user's private data.

**Reproduction (tested on production `api.agentweb.pro`):**

1. Initialize MCP session with a valid API key:
   ```
   POST /mcp with Authorization: Bearer aw_<key>
   → Returns mcp-session-id header
   ```

2. Call `list_knowledge_base_files` with a different user's ID:
   ```json
   {"method":"tools/call","params":{"name":"list_knowledge_base_files","arguments":{"userId":"<other_user_id>"}}}
   ```

3. Result: Returns the target user's **private** knowledge bases (16 KBs, 116 files), including private persona data, LinkedIn posts, Google Drive folders, ClickUp docs, and signed GCS download URLs.

**Severity:** High — IDOR (Insecure Direct Object Reference). Affects all MCP tools that accept `userId` in arguments, potentially including leads, tasks, GTM plans, brand guidelines, connected accounts, etc.

**Root cause:** The MCP tool execution layer trusts caller-supplied `userId` over the authenticated identity (`agentUserId` from the API key). Standard REST API routes don't have this issue because `req.user` is derived from the JWT token and cannot be overridden by request parameters.

**Architecture context:** We evaluated two approaches for exposing Emma capabilities:
- **Approach A (current):** 90+ internal Emma tools exposed directly via MCP. Suffers from this IDOR issue, large tool surface area, and tight coupling to internal schemas.
- **Approach B (recommended):** Expose AgentWeb backend REST APIs as MCP tools. All requests go through JWT auth middleware where `req.user` is derived from the token, not caller parameters. Smaller tool surface (~20-30 tools), stable API contract, consistent auth model.

**Immediate fix needed:** In `mcpServerCore.ts`, stop allowing `userId` from tool arguments to override the authenticated user:
```typescript
// Before (vulnerable):
userId: userId || sessionContext?.agentUserId,

// After (fixed):
userId: sessionContext?.agentUserId,  // Always use authenticated identity
```

**Long-term fix:** Migrate to Approach B — backend API MCP wrapper with JWT-based auth for all operations.

**Production log analysis (no external attacks detected):**

Reviewed full bundle logs from production (`Agentweb-backend-env-prod-3`) for March 6, 2026. All `/mcp` requests came from only two source IPs:
- `98.46.137.148` — external user via `claude-code/2.1.69-2.1.70`. Two sessions (`b773311b`, `485aac4a`) at 02:48-02:49 UTC. Actions: `initialize` → `tools/list` only. No `tools/call` with userId override.
- `73.157.80.155` — our IP. Four sessions for testing: two via claude-code (session setup), two via curl (IDOR reproduction).

No evidence of exploitation by external users beyond our own security testing.

**Fix deployed and verified (PR #613, merged March 6):**

The fix allows `userId` override only for internal clients (`isInternal=true`, i.e. backend-to-backend via `MCP_ACCESS_TOKEN`). External clients (API keys, OAuth) always use the authenticated `agentUserId`.

Post-deploy verification on production:
1. Called `list_knowledge_base_files` with `userId: "1743956381327"` (different user) → returned the API key owner's 19 KBs / 20 files (not the target user's data).
2. Called `list_knowledge_base_files` without userId → returned identical 19 KBs / 20 files.
3. Before the fix, the same call with userId override returned the target user's 16 KBs / 116 files (including private data like "Harsha's persona", "Harsha's worst LinkedIn posts").

The userId parameter is now correctly ignored for external clients.

**Files:** `backend/src/mcp/server/mcpServerCore.ts` (tool request handler), `backend/src/mcp/server/mcpServer.ts` (session/auth management), `backend/src/__tests__/mcp.userIdOverride.test.ts` (regression tests)

**Approach B implemented (March 7, 2026):**

Migrated from Approach A (90+ internal tools exposed directly) to Approach B (REST API wrappers). The MCP server now exposes ~26 tools that call backend REST APIs via HTTP self-calls with short-lived JWTs, going through the same `authenticateToken` middleware as web UI requests. This eliminates the entire class of IDOR vulnerabilities by design.

**Why Approach A (direct internal tools) was problematic:**
1. **IDOR vulnerability** — caller-supplied `userId` in tool args overrode the authenticated identity, allowing cross-user data access.
2. **No audit trail** — direct service calls bypass the REST API layer where request logging, rate limiting, and usage tracking happen. Actions taken via MCP tools were invisible to the audit/analytics pipeline.
3. **No data recording** — REST API route handlers record metrics (response times, error rates, request counts per user) and trigger side effects (webhooks, notifications, activity feeds). Direct service calls skip all of this, creating data gaps between MCP and portal usage.
4. **Large attack surface** — 90+ tools exposed internal schemas and service methods that were never designed for external consumption.

**Key changes:**
- Replaced `tools.ts` (75 tools) and `portalTools.ts` (12 tools) with `apiTools.ts` (~30 tools). Each tool calls `mcpFetch()` which generates a short-lived JWT for the authenticated user and makes an HTTP request to `localhost` REST endpoints.
- Internal tools (`install_skills`, `list_available_skills`, `search_web`, `generate_image`, `send_email`, `save_file`) are registered with `internal: true` flag — available to Emma's agent engine internally but hidden from external MCP clients via `getToolDefinitions()` filtering.
- External agents access AI capabilities (image gen, web search, email) through Emma chat sessions (`emma_send_message`) rather than direct tool calls.
- MCP Emma sessions use the exact same skill-first flow as the customer portal — no MCP-specific behavior.
- Tool count: External MCP clients see 26 tools, Emma's internal registry has 32.

**Architecture:**
```
MCP Client → MCP Server (API key auth) → mcpFetch() → localhost REST API → authenticateToken middleware → route handler → service → DB
```

**Verification — 10 side-by-side MCP vs REST API comparison tests (all passed):**

| # | Test | MCP Result | REST Result (Portal) |
|---|------|-----------|---------------------|
| 1 | list_tasks | 18 tasks | 18 tasks |
| 2 | list_lead_lists | 3 lists | 3 lists |
| 3 | list_gtm_plans | dict (matching) | dict (matching) |
| 4 | manage_brand (read) | same company_name | same company_name |
| 5 | manage_market_strategy (read) | dict (matching) | dict (matching) |
| 6 | list_knowledge_bases | dict (matching) | dict (matching) |
| 7 | list_connected_accounts | dict (matching) | dict (matching) |
| 8 | emma_create_session | `associatedSkills=[]`, `portalType=agent` | identical |
| 9 | emma_list_sessions | 36 sessions | 36 sessions |
| 10 | list_task_executions | 1 execution | 1 execution |

**End-to-end Emma session tests via MCP (all use same skill-first flow as customer portal):**

| Test | Tool Calls | Result |
|------|-----------|--------|
| Image generation | `install_skills` (147ms) → `search_knowledge_base` (1533ms) → `generate_image` (189s) | S3 image URL returned |
| Market report | `search_web` (439ms) → `search_web` (617ms) | 1916-char report with market data |
| Blog article | `install_skills` (126ms) → `generate_blog_post` (42s) | Full blog post generated via AI pipeline |
| Short video | `install_skills` (181ms) → `list_available_skills` (78ms) | Correctly reported video gen not available (skill not published on test env) |

Bug found and fixed during testing: `generate_blog_post` tool had wrong input schema (`title_draft`/`content_draft` instead of `topic`), causing 400 errors. Fixed to match the actual REST API (`POST /api/blog/generate` expects `topic`, `keywords`, `tone`, `length`).

**Files:** `backend/src/mcp/server/apiTools.ts` (tool registrations), `backend/src/mcp/server/httpClient.ts` (JWT + fetch helper), `backend/src/mcp/server/registry.ts` (internal flag support), `backend/src/__tests__/mcp.apiTools.test.ts` (tests)

# March 5, 2026: Dev Env Launch Fails on Elastic Beanstalk

**Problem:** Notion-triggered cloud dev env launch failed with `ENOENT: no such file or directory, open '/var/app/test-env/user-data-dev-auto.sh'`. The `devEnvService.ts` reads the script via `fs.readFileSync` with a path relative to `__dirname`, but `test-env/` is at the repo root and not included in the backend deploy zip.

**Fix:** Copy `user-data-dev-auto.sh` into `dist/` during CI packaging (both `tests.yml` and `deploy.yml`), and update the path in `devEnvService.ts` from `../../../test-env/user-data-dev-auto.sh` to `../user-data-dev-auto.sh`.

**Collateral fix:** Deleted orphaned security group `sg-075b576a4253b70d4` created before the failure. Also added DynamoDB permissions to `agentweb-test-env-ec2-role` IAM policy (prod read-only, dev read-write, plus ListTables/DescribeTable).

**Files:** `backend/src/services/devEnvService.ts`, `.github/workflows/tests.yml`, `.github/workflows/deploy.yml`

**PR:** #608

# March 4, 2026: Admin Users Tab Performance Fix

**Problem:** Admin Users tab was slow — `getAllUsers()` called `getTasksByUserId()` per user, which fetched full task details AND 3 sub-queries per task (executions, schedules, subscribers). For U users with T tasks each: U × (1 + 3T) DynamoDB calls.

**Fix:** Added `taskDb.getUserTaskCount()` using `Select: "COUNT"` on the existing `UserTasksIndex` GSI. Now `getAllUsers()` makes exactly U × 1 count queries (plus workflow count + chat session count, all parallelized). Zero sub-queries.

**Impact:** For 50 users averaging 10 tasks each: **1,550 queries → 50 queries** (~97% reduction). Response time scales linearly with user count, not user × task count.

**Files:** `backend/src/services/db.ts` (new `getUserTaskCount`, updated `getAllUsers`), `backend/src/__tests__/admin.usersPerformance.test.ts`
# March 4, 2026: Speed Up Reports/Images/Videos Loading — Incremental Asset Caching

**Problem:** The Images and Reports pages took ~10.5s to load for a test user with only 36 images / 74 reports.

**Root Cause:** `getExecutionsWithAssets()` in `backend/src/routes/tasks.ts` loaded ALL agent-mode sessions with ALL their messages on every page view:
1. `getUserSessions(userId, 'agent')` loaded 208 sessions with all messages (208 DynamoDB queries)
2. For each session, `getChatSession()` redundantly reloaded the same messages (another 208 queries)
3. This happened separately for images, videos, and html-reports — so the same data was loaded 2-3x
4. Total: ~400-600 DynamoDB queries per page load, most redundant

**Solution:** Rui's incremental asset caching approach — store discovered assets directly on the `AW-ChatSessions` record and only scan new messages on subsequent loads. This was the optimal solution, beating the alternatives considered (separate cache table, Redis cache, frontend pagination) by being simpler, requiring no new infrastructure, and achieving near-zero latency on warm loads.

**Implementation:**

1. **New fields on `ChatSession`:** `assetCache` (images/videos/htmlReports arrays), `assetScanIndex` (message index scanned up to), `messageCount` (total messages, atomically incremented)
2. **New methods on `ChatbotDB`:**
   - `getSessionsWithoutMessages()` — metadata-only session query (no message table reads), with DynamoDB pagination
   - `getMessagesFromIndex(sessionId, fromIndex)` — partial message loading for delta scans
   - `updateAssetCache()` — fire-and-forget cache writes to session record
3. **Refactored `getExecutionsWithAssets()`:** Single session load shared across all asset types, with 3-tier cache logic:
   - Cache up-to-date (`assetScanIndex >= messageCount`) → zero DB reads
   - Delta scan (`assetScanIndex < messageCount`) → only load new messages
   - First time (no cache) → full scan, then cache
4. **`scanMessagesForAssets()` helper:** Single-pass extraction of images, videos, and HTML reports from messages (consolidates 3 separate scanning loops)
5. **`messageCount` tracking:** Atomically incremented on `addMessageToSession`, `addMessagesToSession`, and `migrateMessagesToMessagesTable`
6. **Frontend:** Added `loading="lazy"` to image grid in `customer-portal/src/pages/Images.tsx`

**Bugs Fixed During Testing:**
- `getSessionsWithoutMessages()` initially lacked DynamoDB pagination — sessions beyond the 1MB page limit were silently dropped
- Cache logic for legacy sessions (no `messageCount` field) caused image count discrepancy between first/second loads
- `migrateMessagesToMessagesTable()` didn't set `messageCount`, causing cache to miss new messages added to migrated sessions

**Test Results:**

| Scenario | Before | After |
|---|---|---|
| Images page (36 images, 15 tasks) | ~10.5s | **~1.0s** (warm cache) |
| Reports page (74 reports, 34 tasks) | ~10.5s | **~1.0s** (warm cache) |

Consistency verified: all loads return identical counts (36 images / 15 tasks, 74 reports / 34 tasks).

**Tests Added:**
- `chatbotService.assetCache.test.ts` — 10 tests covering getSessionsWithoutMessages, getMessagesFromIndex, updateAssetCache, incrementMessageCount
- `scanMessagesForAssets.test.ts` — 12 tests covering image/video/HTML extraction, deduplication, timestamps, uploads, default filenames
- Updated existing test files to use new mock patterns (agentModeMessageLoading, videoFavorites, imageFeedback, messagesTable)

**Files Modified:**
- `backend/src/services/chatbotService.ts` — ChatSession interface, 4 new methods, messageCount tracking in migration
- `backend/src/routes/tasks.ts` — Refactored getExecutionsWithAssets, new scanMessagesForAssets helper, addCachedAssetsToResult helpers
- `customer-portal/src/pages/Images.tsx` — loading="lazy" on img tags

---

# March 3, 2026: AWS Bedrock Cost Investigation ($7.7k in February)

**Problem:** February AWS bill was $7,742.75, majority from Claude Opus 4.6 and Sonnet 4.6 on Bedrock.

**Root Cause:** Chat sessions (agent mode) are the primary cost driver — not task executions.

**February Bedrock Usage (Chat Sessions):**
- **Claude Sonnet 4.6:** 224 sessions — top user: `juan@usehaven.ai` (232 sessions, 9,046 function calls)
- **Claude Opus 4.6:** 139 sessions — top user: `childrenstorywithai@gmail.com` (40 sessions, 504 fn calls), plus anon users and `agentweb@xcures.com`
- Task executions used almost zero Bedrock (10 calls total, all Claude 3.5 Sonnet v2)

**Other LLM usage (not on AWS bill):** GPT-5.2 (320 sessions), GPT-5 (157), Gemini-3-pro (292) — these are Azure/Google costs.

**Monitoring Enabled:** Bedrock Model Invocation Logging → `s3://agentweb-bedrock-logs/invocation-logs/` (enabled 2026-03-03). This logs caller identity, model, and token counts per request.

**Cost Reduction Options:**
1. Default anon/demo users to Sonnet instead of Opus (5x cheaper per token)
2. Cap function calls per session to prevent runaway usage
3. Track per-user token usage in DynamoDB for billing visibility
4. Consider session-level token budgets

**Querying Cost Data:**
- AWS Cost Explorer only works from the parent/management account (not member account 992382574572)
- The `facetoon_image_user` IAM user now has `ce:GetCostAndUsage` permission but can only see the member account's own costs (~$0.12/month)
- For per-user breakdown, query `AW-ChatSessions` table: filter by date, group by `userId` + `llmModel`, count `calledFunctions`

---

# February 28, 2026: Notion MCP Integration for Sprint Task Management

**Purpose:** Enable Claude Code to pull dev items directly from the Notion "Sprint Tasks - Argusoft" database via MCP.

**Setup:**

1. **Create a Notion internal integration** at https://www.notion.so/profile/integrations
   - Choose **"Internal integration"** (not public/OAuth)
   - Copy the **Internal Integration Secret** (starts with `ntn_`)
   - No webhooks or redirect URIs needed

2. **Connect the integration to your Notion pages:**
   - Open the "Sprint Tasks - Argusoft" database in Notion
   - Click "..." menu (top right) → **Connections** → **Connect to** → select the integration
   - Repeat for any other pages/databases you want accessible

3. **Configure `.mcp.json`** in the repo root (already gitignored):
   ```json
   {
     "mcpServers": {
       "notion": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "@notionhq/notion-mcp-server"],
         "env": {
           "OPENAPI_MCP_HEADERS": "{\"Authorization\":\"Bearer <YOUR_NOTION_TOKEN>\",\"Notion-Version\":\"2025-09-03\"}"
         }
       }
     }
   }
   ```

4. **Restart Claude Code** to load the new MCP server

**How it works:**
- The Notion MCP server exposes tools for searching, reading, and querying Notion databases
- Claude Code calls these tools on demand (pull-based, no webhooks)
- `.mcp.json` is gitignored since it contains the API token

**Important: Database ID vs Data Source ID:**
- The Notion API has two ID types: `database_id` and `data_source_id`
- Use `mcp__notion__API-post-search` with `"filter": {"property": "object", "value": "data_source"}` to find the database
- For `mcp__notion__API-query-data-source`, use the **data_source_id** (found in relation properties), NOT the database_id
- Sprint Tasks database ID: `2bf09247-c951-8122-a327-ee39ef7a6ec7`
- Sprint Tasks data source ID: `2bf09247-c951-812a-bd0a-000bd4c05bbf` (use this for queries)

**Troubleshooting:**
- If Notion tools aren't available after restart, check `npx @notionhq/notion-mcp-server` runs without errors
- If queries return empty results, verify the integration is connected to the target page/database in Notion
- Token rotation: update the `ntn_` token in `.mcp.json` and restart Claude Code

---

# February 27, 2026: Agent Mode LLM Performance — Opus vs Sonnet Timing Investigation

**Problem:** A customer session (`5b1c1270-57b8-4de0-95c7-a787115b965e`) on `anthropic.claude-opus-4-6-v1` took ~49 minutes (29 min system time). No per-turn timing instrumentation existed to diagnose which LLM turns were slow.

**Investigation:**

Added per-turn timing instrumentation to `agentModeService.ts`:
1. **`callLLM()` timing** — logs model name, duration, token count after every LLM API call
2. **Iteration summary** — logs iteration number, model, tool names, sessionId per agent loop turn
3. **Tool execution timing** — logs tool name, duration, sessionId per tool call

Log format examples:
```
AgentMode: LLM call completed [model=anthropic.claude-opus-4-6-v1, duration=2883ms, tokens=N/A]
AgentMode: Iteration 1 [model=anthropic.claude-opus-4-6-v1, tools=search_web, sessionId=abc123]
AgentMode: Tool executed [name=search_web, duration=549ms, sessionId=abc123]
```

**Benchmark — same prompt ("What are the top 3 B2B lead generation strategies for SaaS companies?"):**

| Metric | Opus (`claude-opus-4-6-v1`) | Sonnet (`claude-sonnet-4-6`) |
|---|---|---|
| LLM call 1 | 2,883ms | 1,829ms |
| LLM call 2 | 2,808ms | 9,800ms (final) |
| LLM call 3 (final) | 19,656ms | — |
| Iterations | 3 | 2 |
| Tools used | search_web, read_page_source ×2 | install_skills |
| **Total wall clock** | **~28.3s** | **~11.8s** |

**Finding:** Opus is ~2.4x slower than Sonnet. The biggest bottleneck is the final response generation (19.6s vs 9.8s for Sonnet). Opus also uses more tools (3 iterations vs 2), compounding latency from extra LLM calls + tool execution.

**Performance improvement — parallel tool execution:** Tools within a single iteration were executed sequentially. When the LLM returns multiple tool_calls in one response, they are independent and can run concurrently. Changed the tool execution loop from sequential `for...await` to `Promise.all()` for parallel execution.

**Before/after comparison (Opus, Iteration 2 with 2× `read_page_source`):**

| | Before (sequential) | After (parallel) |
|---|---|---|
| read_page_source #1 | 1,208ms | 80ms |
| read_page_source #2 | 1,216ms | 1,291ms |
| **Tool phase wall clock** | **2,424ms** (sum) | **~1,291ms** (max) |

The parallel version runs both tools concurrently, so wall clock = max(individual durations) instead of sum. Savings grow with more concurrent tools and longer-running tools. In a full work plan session with dozens of multi-tool iterations, this compounds significantly.

**Full Opus session comparison (same prompt, same model):**

| Metric | Before (`abd13579`) | After (`240300f7`) |
|---|---|---|
| LLM call 1 | 2,883ms | 2,933ms |
| LLM call 2 | 2,808ms | 2,875ms |
| LLM call 3 (final) | 19,656ms | 19,177ms |
| Tool: search_web | 549ms | 347ms |
| Tool: read_page_source ×2 | 1,208 + 1,216ms (seq) | 80 + 1,291ms (parallel) |
| **Tool phase Iter 2** | **~2,424ms** | **~1,291ms** |

LLM call durations are consistent (network/model variability). The tool execution phase in Iteration 2 dropped from ~2.4s to ~1.3s — a **~47% reduction** in that phase.

**Heavy-context benchmark — production session `5b1c1270` (97 messages, "Facebook Marketing Strategy"):**

Same follow-up prompt ("Summarize the key findings from this session and give me 3 actionable next steps") sent to both models on the same session context:

| Model | LLM Call Duration | Tools | Relative |
|---|---|---|---|
| Opus | 29,855ms | none | 1.24x slower |
| Sonnet | 24,047ms | none | baseline |

On a heavy-context session, Opus is ~24% slower per LLM call — a smaller gap than the 2.4x on lightweight prompts because input processing (not generation) dominates. Across a full work plan with 20-30 iterations, this ~6s/call overhead compounds to minutes of extra wall time. Combined with Opus's tendency to use more tools per turn (3 iterations vs 2 in the lightweight test), total session time difference can be 2x+.

**Files changed:**
- `backend/src/services/agentModeService.ts` — timing logs + parallel tool execution
- `backend/src/__tests__/agentModeService.llmTiming.test.ts` — 10 tests (timing instrumentation + parallel execution)

---

# April 5, 2026: Do Parallel Tool Calls Consume More Tokens?

**Question:** When the LLM returns multiple tool calls in a single response (parallel), does that consume more tokens compared to making them one at a time (sequential)?

**Context:** Investigated a production session (`ce0f5737`) — "Daily Slack Check — All Channels". The agent made 1 `slack_list_channels` call followed by **65 `slack_get_recent_messages` calls** that all appeared grouped after Emma's final response in the share UI. This raised the question of whether those parallel calls came from the same LLM response and how they compare to sequential calls in terms of token cost.

**How parallel tool calls work in our backend:**

When a Gemini/Claude/GPT model returns a response with multiple `tool_calls` in one API response (e.g., 30 channel fetch requests at once), `agentModeService.ts` collects all of them in a single iteration and executes them concurrently via `Promise.all()` (see `agentModeService.ts:1502–1571`). This means **all N tool calls come from the same LLM API response** — the model generated all N tool-call JSON blocks in one shot.

**Token breakdown — parallel vs sequential for N tools:**

| | Parallel (what we do) | Sequential (hypothetical) |
|---|---|---|
| LLM API calls | 1 call returns all N requests | N calls, one per tool |
| Input tokens | Sent **once** | Resent + grows each round |
| Output tokens | More per call (N tool JSONs in one response) | Less per call, but N× calls |
| **Total tokens** | **Much lower** | **Much higher** (context accumulates N×) |

**Concrete example (the investigated session):**

The session made 30 `slack_get_recent_messages` calls in parallel from a single LLM response. Compared to doing them one at a time:

- **Parallel (actual):** 1 LLM call × (context + 30 tool-call outputs) + 1 final synthesis call
- **Sequential (hypothetical):** 30 LLM calls where each input = prior context + all prior tool results accumulated

For 30 channels, the sequential approach would have sent the full conversation context ~30 extra times, each iteration slightly larger. Parallel avoids that entirely — the context is sent once and the model generates all 30 requests in a single output.

**Answer:** Yes, the single LLM response that generates N parallel tool calls has **more output tokens** than a response with 1 tool call (it has to emit N tool-call JSON blocks). But the **total token cost across the conversation is dramatically lower** than sequential, because you avoid resending the full growing context N times. For the 30-channel session, parallel saved roughly 29× the input token cost of the mid-conversation context window.

**The 65 tool calls came from 2 LLM responses:**
1. First response: `slack_list_channels` → 1 tool call
2. Second response: all 30 `slack_get_recent_messages` at once → 30+ tool calls in parallel
3. Final response: synthesis/summary (no tool calls)

The share UI groups all tool calls after the final assistant message, which made it look like they all came from one response — they didn't. The sequential `slack_list_channels` was its own round trip.

---

# February 26, 2026: Instagram Business Login — "Unsupported request" in Production

**Symptom:** Connecting an Instagram Business account via Connected Accounts failed in production with `IGApiException` code 100: `"Unsupported request - method type: get"`. Both `getLongLivedToken` (`graph.instagram.com/.../access_token`) and `getInstagramBusinessMe` (`graph.instagram.com/.../me`) returned the same error. The initial OAuth token exchange (POST to `api.instagram.com/oauth/access_token`) succeeded.

**Investigation:**
- Confirmed `graph.instagram.com/v24.0/me` and `graph.instagram.com/v23.0/me` are valid endpoints (curl with invalid token returns code 190, not code 100).
- The code 100 "Unsupported request" error is not a version issue — it's specific to the access token being returned by the OAuth flow.
- Decoupled `META_INSTAGRAM_API_VERSION` from `META_API_VERSION` (PR #565) — did not fix the issue.

**Root cause:** The Facebook Developer App must have Instagram Business Login permissions approved through **App Review** for production use. Without approval, the OAuth flow still completes and returns a token, but that token cannot be used with `graph.instagram.com` API endpoints — all GET requests fail with code 100.

For **development/testing only**, adding the Instagram Business account in the "Generate access tokens" section under API Setup with Instagram Login allows the token to work without App Review. This is limited to accounts explicitly added in that section.

**Fix:**
- **Development/Testing:** In the Facebook Developer portal → your app → Instagram → API Setup with Instagram Login → "Generate access tokens" section: add the Instagram Business account. This grants test access for that specific account.
- **Production:** Submit the app for App Review with the required Instagram Business Login permissions (`instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_insights`). Once approved, any Instagram Business account can connect without being manually added.

**Key takeaway:** This is an app-level configuration, not a code issue. The OAuth flow succeeds without proper permissions setup, but the returned token is non-functional for API calls — making the error misleading.

---

# February 25, 2026: Long-Running Test Env & IP Allowlist Fix

- Added `--no-watchdog` flag to `./test-env/test-env.sh launch` to skip the 24-hour auto-shutdown cron. Use for long-running test environments that you teardown manually.
- Fixed bug where the test-env-access UI showed the developer's IP as "not accessible" on launch. The launch script added the IP to the AWS security group but not to `allowlist.json`. Now seeds the allowlist at launch.

---

# February 24, 2026: Growth Estimate — Month-over-Month Comparison

Ran `node src/scripts/growth-comparison.js 2026-02-24` to compare 3 rolling 30-day periods.

| Metric | Jan 25 - Feb 24 | Dec 25 - Jan 24 | Nov 25 - Dec 24 |
|---|--:|--:|--:|
| Agent Mode Sessions | 1,033 (+130, +14%) | 903 (+143, +19%) | 760 |
| Generated Articles | 989 (+485, +96%) | 504 (+264, +110%) | 240 |
| Approved Articles | 15 (+9, +150%) | 6 (+6, new) | 0 |
| Published Articles | 62 (+53, +589%) | 9 (+9, new) | 0 |
| Generated Posts | 298 (+37, +14%) | 261 (+198, +314%) | 63 |
| Approved Posts | 7 (-2, -22%) | 9 (+9, new) | 0 |
| Published Posts | 27 (+16, +145%) | 11 (+11, new) | 0 |
| Generated Images | 345 (+5, +1%) | 340 (+182, +115%) | 158 |
| Approved Images | 10 (-14, -58%) | 24 (+24, new) | 0 |

**Data sources:**
- Sessions & tool call counts: `AW-ChatSessions` (`calledFunctions` on each session, bucketed by session `createdAt`)
- Approved articles/posts/images: `AW-AssetApprovals` (status=`approved`, bucketed by `updatedAt`)
- Article = `blog-*` filename; Post = `social-media-post*`, `linkedin-post*`, `x_thread*`, `twitter-thread*` filenames; Image = `assetType=image`

**Script:** `backend/src/scripts/growth-comparison.js` — accepts an optional end date argument (defaults to today). Run from the `backend/` directory.

---

# February 24, 2026: SEO/GEO Engagement Time Is Total, Not Average

The "Top Pages by Engagement" table on the SEO/GEO page displays **total** engagement time, not average. The backend (`seo.ts`) requests GA4's `userEngagementDuration` metric, which is cumulative across all sessions. The frontend (`SEO.tsx`) renders it directly via `formatTime()` with no averaging. For product metrics, the backend separately computes `avgDuration` by dividing `totalDuration` by `pageViews`, but this is not used in the top pages table.

---

# February 24, 2026: `create_html_from_template` JSON Failure + Reports Model Admin Bug

## Problem 1 — Amino Daily News Template Failure

Production session `8400bace-...` (Daily AI News - Amino) using `gemini-3.1-pro-preview` failed 25 times on `create_html_from_template` with "LLM returned invalid JSON for variable substitution".

### Root Cause

Three issues combined:

1. **`tools.ts:1175` used `args.llmModel` but `llmModel` is in `context`, not `args`** — the model passed to `createHtmlFromTemplate` was undefined/wrong.
2. **Gemini doesn't reliably honor `response_format: { type: 'json_object' }`** — it returns JSON wrapped in markdown code blocks (`` ```json ... ``` ``), causing `JSON.parse()` to fail.
3. **No `max_completion_tokens` was set** — risking output truncation on large templates.

### Fix

- Changed `args.llmModel` → `context?.llmModel` in `tools.ts:1175`
- Added JSON code-block stripping fallback: first tries `JSON.parse`, then strips `` ```json ``` `` wrappers and retries, with raw response logging on failure
- Added `max_completion_tokens: 16384` to the `callLLM` call (matching `createHtmlFile` and `createHtmlTemplate`)

## Problem 2 — Reports Model Dropdown Shows All Models

The Reports Model dropdown in the admin page's Agent Mode tab showed all 8 agent mode models (GPT, Gemini, Claude) when it should only show models suitable for report generation.

### Root Cause

The `<Select>` at `AdminDashboard.tsx:7199` used `supportedModels` (from `/api/agent-mode/public/llm-models`) which returns all models in `llmModels`. This was always the case since commit `e324fb8f` (Jan 13), but became worse as models were added:
- Jan 13: 4 models → Feb 20: 8 models (every new model automatically appeared)

### Fix

- Added `getReportsModelOptions()` to `agentModeService.ts` — filters `llmModels` to `anthropic.*` keys only
- Added `GET /api/agent-mode/public/reports-model-options` endpoint
- Updated `AdminDashboard.tsx` to load and use the filtered list for the Reports Model dropdown (with fallback to `supportedModels` if endpoint fails)

---

# February 23, 2026: Updated User Guide — ClickUp & Google Drive Documentation

Added sections to the user-facing guide (Notion) documenting the ClickUp Knowledge Base integration and Google Drive Shared Folders integration. Covers setup instructions, agent capabilities, supported file types, and security.

---

# February 23, 2026: Enabled Branch Protection on Main

Neither `AgentWebPro/agentweb` nor `AgentWebPro/agentweb-customer-portal` had branch protection on `main`. Enabled protection on both repos via GitHub API with: strict status checks, force pushes blocked, branch deletion blocked, and enforce admins enabled. Required PR reviews was initially set to 1 but later removed.

**Verification:** After each change, read back the protection settings via `gh api repos/{owner}/{repo}/branches/main/protection` and confirmed `protected: true`, correct rule values, and `enforce_admins.enabled: true`. Also confirmed `required_pull_request_reviews` was absent from the response after removing the review requirement.

---

# February 21, 2026: Agent Mode — Dropped Assistant Messages (Aaron's Session)

## Problem
Production session `ec70e7f2-d42b-46df-a390-86c79879cfd5` (user Aaron, Claude Opus 4.6) failed with 400 errors after ~37 messages. All LLM models returned Bad Request.

## Root Cause
The assistant message between DB indices 22 (user "yes.") and 23 (tool result) was missing, creating an invalid user→tool sequence. Two orphaned `tool_call_id`s (`tooluse_s5lgU4Vkm2yK65qRQiodQ2` for `update_brand_guidelines`, `tooluse_ufMCSFsi6MNxI7pZByZr1T` for `update_market_strategy`) had no matching assistant message.

**Bug 1 — Stale `initialMessageCount`:** `generateMarketingResponse` captures `initialMessageCount = messages.length` once, then uses `messages.slice(initialMessageCount)` at the end to extract response messages. When `install_skills` fires mid-response, `updateConversationContext` splices context messages at the front of the array (net ±1 length change), but `initialMessageCount` was never adjusted. A net -1 (e.g., Available Skills removed, not re-added) causes the slice to skip the first assistant message.

**Bug 2 — Silent batchWrite drops:** `addMessagesToMessagesTable` ignored `UnprocessedItems` from DynamoDB `batchWrite`, silently losing throttled writes.

## Fix (PR #540)
1. Adjust `initialMessageCount += delta` after each `updateConversationContext` call
2. Retry `UnprocessedItems` with exponential backoff (up to 3 retries)

## Production Repair
After deploying the fix, the session still crashed because the corrupted data remained. Ran `/tmp/repair-session.py` to insert a synthetic assistant message at index 23 (with the two orphaned `tool_call_id`s) and shifted all subsequent messages up by 1. Session is now functional.

## Copied Session in Dev
Session was copied to dev tables (`Dev-AW-ChatSessions`, `Dev-AW-ChatMessages`) with userId `6c2ef3ca-c9fa-432e-b510-85127a0752f4` for testing. The dev copy was NOT repaired (same corrupted data as prod pre-repair).

**TODO: Delete the copied session from dev tables.**

---

# February 18, 2026: Runaway ts-node-dev Processes Overheating Machine

Two `ts-node-dev` processes (PIDs 70909, 70910) from the `agentweb` clone were stuck at 100% CPU each for ~10 hours, consuming ~200% CPU total. They were running `server.ts` via `ts-node-dev` and had accumulated 345+ minutes of CPU time. Regular `kill` was ignored; required `kill -9` to terminate. Machine cooled down immediately after.

**Lesson:** When running `npm run dev` in multiple repo clones, check for orphaned `ts-node-dev` processes if the machine gets hot. Use `ps aux | sort -k3 -rn | head -10` to find CPU hogs quickly.

# February 18, 2026: Subdomain Landing Page Setup for Haven (usehaven.ai)

## Approach
Use a CNAME record so we manage the subdomain on Vercel while the client's primary DNS stays untouched. No Nameserver access needed.

## Steps

1. **Add subdomain in Vercel**: Project Settings > Domains > add `start.usehaven.ai`. Vercel will show "Invalid Configuration" until DNS propagates.

2. **Client DNS request** — ask their IT/DNS admin to add one record:
   - **Type:** CNAME
   - **Name (Host):** `start`
   - **Value (Points to):** `ca0c21bca6304a7a.vercel-dns-016.com.`
   - **TTL:** 3600 (or default)

3. **SSL is automatic**: once the CNAME resolves to Vercel, they auto-provision a Let's Encrypt certificate and handle renewal every 90 days. No action needed.

## Creating a Vercel Project Synced to AgentWebPro Org

1. Go to [vercel.com/new](https://vercel.com/new)
2. Under "Import Git Repository", select the **AgentWebPro** GitHub org from the dropdown
3. Find and import the target repo (e.g. `haven-landing`)
4. Configure build settings (framework preset, build command, output directory) and environment variables as needed
5. Click **Deploy**

The project will now auto-deploy on every push to the default branch. To add the custom subdomain, go to Project Settings > Domains and follow the steps above.

**Make PR preview URLs public**: Project Settings > Deployment Protection > disable Vercel Authentication.


# February 18, 2026: Google Drive Integration — MCP vs Direct API

## Investigation
Explored options for integrating Google Drive into the knowledge base:

1. **Anthropic's `@anthropic-ai/google-drive-mcp`** — archived, no longer maintained
2. **Google Workspace MCP server** ([gemini-cli-extensions/workspace](https://github.com/gemini-cli-extensions/workspace)) — found via Google's official MCP list at https://github.com/Google/mcp
   - Provides Drive, Docs, Sheets, Slides, Calendar, Gmail, and Chat access
   - Uses OAuth with a built-in client ID — authenticates as a real Google user via browser login
   - **Incompatible with service account approach**: the admin-configured "shared folders" model requires a service account that has access to specific folders shared with it. The Workspace MCP server authenticates as the end user, so scoping access to admin-designated folders doesn't work.
   - Also requires an interactive browser session on first auth, which doesn't work headlessly on the agent engine
3. **`googleapis/gcloud-mcp`** — only covers GCP infrastructure (gcloud CLI, observability, Cloud Storage buckets), not Google Drive

## Decision
Integrate with the Google Drive API directly using a service account rather than relying on an MCP server. This allows:
- Admin configures folder IDs shared with the service account → stored on the user record
- Backend reads files from those folders via the Drive API using service account credentials
- No interactive browser login needed — works headlessly on the agent engine
- Access is scoped to only the folders explicitly shared by the admin

The Google Workspace MCP server can be reconsidered in the future if per-user OAuth MCP sessions are supported (see Feb 12 ClickUp investigation for similar pattern), or if a service-account-compatible Drive MCP server becomes available.

## Current State
- Admin endpoint and UI for configuring shared folder IDs on user records: done
- Customer portal Knowledge Base page shows configured folders with Drive links: done
- Direct Drive API integration for listing/reading files: TODO


# February 17, 2026: Foundation Tools Blocked by Subscription Filtering

## Problem
Scheduled chats failing with "required function calls are not allowed by your subscription" for `search_web` and other foundation tools. Multiple customer error emails sent. Additionally, foundation tools were hidden from the Skills config page and the customer-portal scheduled chat config, making them impossible to assign or select.

## Root Cause
Foundation tools (`search_web`, `read_file_content`, etc.) were never added to the allowed list returned by `getAllowedFunctionCalls()` in `subscriptionService.ts`. Three places were affected:
1. **Scheduled chat pre-flight check** (`agentModeController.ts:744`) — rejected foundation tools as disallowed
2. **`/api/agent-mode/function-calls` endpoint** — `filterFunctionCalls` stripped foundation tools for non-admin users, hiding them from customer-portal scheduled chat config
3. **Skills page** (`Skills.tsx`) — `?forSkillConfig=true` query param triggered a backend filter excluding foundation tools, preventing them from being assigned to skills

Bug introduced Dec 14, 2025 (`5bc0ad80`) but only surfaced after Feb 14, 2026 (`90005233`) when skills-based subscriptions replaced wildcard subscriptions.

## Fix
1. Scheduled chat check: filter out foundation tools from the disallowed list using `agentModeService.getFoundationToolNames()`
2. `getAvailableFunctionCalls` endpoint: inject foundation tools into the allowed list before filtering for non-admin users
3. Removed the `forSkillConfig` backend filter and frontend query param so all tools (including foundation) appear on the Skills page

Backend 27.6.4, partner-portal 12.7.2. Unit tests updated.


# February 16, 2026: Scheduled Chat Silent Failure Bug

## Problem
Session `097840bc-7338-4a09-8c90-bf112230e17b` ("What's Up with AI Daily") completed steps 1–4 of its work plan but step 5 ("Publish to LinkedIn") never executed. No error was recorded — messages array was empty, no run result saved, no email sent.

## Root Cause
In `agentModeController.ts`, the `runScheduledChat()` promise's `.catch()` handler (line ~3449) only called `console.error`. It never saved a failure `runResult` to DynamoDB or sent an error notification email. Runtime crashes (LLM timeouts, network errors) were silently lost.

## Fix
Added to the `.catch()` block:
1. Save a failure `runResult` via `scheduleDb.addRunResult()` so failures are visible in the UI
2. Send error notification email to configured recipients

Backend version bumped to 27.5.3. Unit test added to cover the new behavior.


# February 12, 2026: ClickUp Integration via MCP

## Investigation
- ClickUp provides a remote MCP server at `https://mcp.clickup.com/mcp` (OAuth 2.1, read-only scope)
- Supports 20+ tools: search, tasks, comments, time tracking, workspace hierarchy, members, chat, docs
- AgentWeb already has external MCP client infrastructure (`mcpClientService.ts`) — plan is to connect to ClickUp's MCP server directly with per-user OAuth tokens
- Main gap: current MCP client uses a single shared token per server; need to extend it to support per-user OAuth connections

## Approach
- Option A (chosen): Connect to ClickUp's remote MCP server directly, inheriting all their tools automatically
- Add ClickUp as a connected account type with OAuth flow
- Extend `mcpClientService` to support per-user MCP sessions

## Status
- Submitted ClickUp MCP Server Allowlist Request Form for redirect URIs:
  - `https://api.agentweb.pro/api/auth/clickup/callback` (Production)
  - `https://api-stage.agentweb.pro/api/auth/clickup/callback` (Staging)
  - `http://localhost:3001/api/auth/clickup/callback` (Development)
- Waiting for ClickUp approval before proceeding with implementation


# February 12, 2026: PixelFlow Form Tracking Audit — start.waldium.com

## Pages Checked
- `https://start.waldium.com/` (v1)
- `https://start.waldium.com/v2`

## Result: Form submission NOT tracked on either page

**Base script**: Installed correctly on both pages (same API key, site ID, endpoint).

**Missing event classes** (required per [PixelFlow docs](https://docs.pixelflow.so/articles/event-classes-on-html-websites-4c49z)):

| Element | Required Class | Status |
|---|---|---|
| Form container | `info-frm-cntr-pf` | Missing |
| Submit button | `action-btn-lead-011-pf` | Missing |
| Email input | `info-cust-em-pf` | Missing |

Both pages share the same `LeadForm` React component. Adding the three classes to that component will fix both pages.

# February 11, 2026: Staging Backend Down (Agentweb-backend-env-1)

## Problem
Staging EB environment `Agentweb-backend-env-1` was Severe/Red. Deployment of `backend_v26.6.1-staging-pr455` repeatedly failed with command timeout on instance `i-0645dba745fc59889`.

## Investigation
- Instance EC2 system checks passed (running, reachable) but EB agent was completely unresponsive
- All EB commands timed out: deployments, log retrieval, restart — nothing got through
- The first deployment of the version at 07:00 UTC succeeded, but a subsequent redeploy at 08:36 UTC hung and the instance never recovered
- 4 consecutive deployment attempts all timed out (600s command timeout)
- Root cause: `t3.small` (2GB RAM) exhausted memory — `npm install` during deployment + Node.js app exceeded available resources, freezing the EB agent

## Resolution
1. Rebooted the instance via EC2 Console — environment recovered to healthy
2. Upgraded instance types from `t3.small` to `t3.medium` / `t3.large` to prevent recurrence
3. Configuration update completed successfully, environment Green/Ok

# February 10, 2026: CRM Web Enrichment Production Failure Investigation (v26.2.0)

## Investigation Summary
- Environment checked: `Agentweb-backend-env-prod-3` (AWS Elastic Beanstalk, `us-west-2`)
- Logs inspected from full bundle and tail logs
- Main failing workflow: `POST /api/crm/lists/:listId/leads/enrich-web?mode=enrich`

## Key Findings
- Primary failure is Google Custom Search quota/rate limiting:
  - `Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'`
  - Observed repeatedly in `web.stdout.log` during enrich runs.
  - Example lines:
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:285`
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:45596`
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:46733`
- Nginx upstream timeout occurred for the enrich endpoint:
  - `/tmp/eb-prod3-bundle/var/log/nginx/error.log:247`
  - `upstream timed out ... POST /api/crm/lists/.../leads/enrich-web?mode=enrich`
- Secondary issue: occasional LLM JSON parsing failures:
  - `LLMService: Error generating content: SyntaxError...`
  - Examples:
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:45`
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:45252`
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:46165`
- `connect() failed (111: Connection refused)` entries align with deployment restarts and are not the main enrich failure cause.

## Impact
- Enrichment batch jobs report many failed leads due to `searchWeb` quota errors.
- Some enrich requests run long enough to hit upstream timeout.
- JSON parse failures reduce successful enrichments further.

## TODO (Feb 10, 2026)
- [ ] Add server-side rate limiting and retry/backoff for `searchWeb` (respect Google per-minute quota).
- [ ] Reduce effective enrichment search concurrency in production (current burst is too high).
- [ ] Move enrich processing to async job execution with progress polling to avoid long blocking HTTP request timeouts.
- [ ] Add early circuit-breaker behavior when quota errors spike (fail fast with clear status instead of repeated retries).
- [ ] Harden JSON extraction path:
  - [ ] enforce strict JSON response mode/instructions
  - [ ] keep retry with stricter prompt
  - [ ] add safe fallback parse guardrails
- [ ] Add metrics and alerts:
  - [ ] quota error count
  - [ ] enrich timeout count
  - [ ] per-batch success/fail rate
- [ ] Document operational limits for enrichment batch size and recommended concurrency.

# February 08, 2026: MCP Session Concurrency Fix (v25.9.0)

## Problem
Scheduled chats failing with "Bad Request: No valid session ID provided" errors. Multiple concurrent chat sessions in the same worker process were sharing a single MCP client connection, causing session ID conflicts.

## Root Cause
- Worker process creates ONE AgentModeService with ONE McpClientService
- All concurrent chat sessions used the SAME MCP client with SAME session ID
- When multiple chats ran simultaneously, MCP server returned "has session: false"
- Production logs showed: `MCP session: abf29003-1882-423c-ba87-57ee2c9e7749, chat sessionId: 9816f8e4...` but `has session: false`

## The Fix
Implemented session-based client pooling in `backend/src/mcp/client/mcpClientService.ts`:
- Added `sessionClientPools: Map<chatSessionId, ClientPool>` to isolate clients per chat session
- Created `getSessionClient(serverName, chatSessionId)` method - each chat gets its own MCP client
- Modified tool execution to use `getSessionClient()` instead of shared client
- Added automatic cleanup of stale session pools (1 hour timeout, configurable via `MCP_CLIENT_SESSION_TIMEOUT_MS`)
- Added `releaseSessionClients(chatSessionId)` for manual cleanup

## Changes
**Files modified:**
- `backend/src/mcp/client/mcpClientService.ts` (~150 lines added)
- `backend/src/__tests__/mcp.mcpClientService.test.ts` (6 new tests)
- `backend/src/scripts/test-mcp-session-isolation.ts` (test script)
- `backend/src/docs/user-release.ts` (Feb 08 entry)
- `backend/package.json` (version bump to 25.9.0)

**Key change in tool execution:**
```typescript
// Before: All sessions share same client
execute: async (args, context) => {
  const result = await client.callTool(...);  // ← Shared
}

// After: Each session gets its own client
execute: async (args, context) => {
  const sessionClient = await this.getSessionClient(name, context.sessionId);
  const result = await sessionClient.callTool(...);  // ← Isolated
}
```

## Testing
Run verification test (10 concurrent sessions):
```bash
cd backend
npx ts-node src/scripts/test-mcp-session-isolation.ts
```

Expected output:
```
✓ Result: 10/10 unique MCP sessions
✓ Session creation time: ~595ms
✓ Active session pools: 10
✓ Total MCP clients created: 10 (10 sessions × 1 servers)
✓ SUCCESS: Each chat session has isolated MCP client
```

All unit tests pass:
```bash
npm test
# Test Suites: 185 passed, 185 total
# Tests:       2226 passed, 2226 total
```

## Performance & Safety
**Connection overhead with 10 concurrent sessions:**
- Before: 3 MCP connections (shared, broken)
- After: 30 MCP connections (10 sessions × 3 servers)
- Creation time: ~600ms for 10 session pools
- Memory: ~50-100MB additional overhead
- ✅ Acceptable for Node.js (can handle 100+ connections easily)

**Memory safety:**
- Tool implementations are stateless (async functions)
- Each session has isolated MCP client pool with unique session IDs
- Shared state is minimal (read-only configs, safe caches)
- No threading issues (Node.js async model)
- All data passed as parameters (no mutable globals)

**Scalability:**
- Works well with 2-20 concurrent sessions
- If >50 concurrent chats needed, consider worker pool architecture

## Deployment Verification
After deployment, monitor for:
- `[MCP-SESSION] Creating new client pool for session: {id}` (new logs)
- `[MCP-SESSION] Connected to {server} with MCP session ID: {mcpId} for chat session: {chatId}` (new logs)
- No "has session: false" errors (old bug eliminated)
- Connection count: `netstat -an | grep :3001 | wc -l`

# February 07, 2026: MCP Session ID Issue in Worker Process

## Problem
Production scheduled chats and agent mode tool calls were failing with error:
```
StreamableHTTPError: Streamable HTTP error: Error POSTing to endpoint:
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: No valid session ID provided"},"id":null}
```

## Investigation Timeline

### Symptoms
- Production backend (v25.6.0) on AWS Elastic Beanstalk experiencing multiple failures
- Errors occurred at 16:23:30 UTC and 16:25:28 UTC on Feb 7, 2026
- Affected tools: `read_brand_guidelines`, `read_market_strategy`, `search_knowledge_base`, `create_work_plan`
- All errors originated from `[Worker]` process, not main backend

### Root Cause
The **Worker process** (generateMarketingResponseWorker.ts) creates its own AgentModeService instance with an independent MCP client. The StreamableHTTPClientTransport was not properly establishing the MCP session before tool calls were made:

1. Worker initializes and creates MCP client
2. Client calls `connect(transport)`
3. Connection completes but session handshake may not be fully established
4. Tool calls are made immediately without valid `mcp-session-id` header
5. MCP server rejects requests with error code -32000

### The Fix
Added session validation in `backend/src/mcp/client/mcpClientService.ts`:
- Wait 100ms after connection for session initialization to complete
- Validate that `transport.sessionId` is set before proceeding
- Throw error if session ID is not established
- Added comprehensive logging for debugging

### Architecture Notes
- Main backend has its own MCP client with independent session
- Worker process has a separate MCP client with its own session
- Both connect to the internal MCP server at `http://localhost:PORT/mcp/server`
- Sessions timeout after 1 hour of inactivity (configurable via `MCP_SESSION_TIMEOUT_MS`)
- Session cleanup runs every hour (configurable via `MCP_CLEANUP_INTERVAL_MS`)

### Production Deployment Requirements
After this fix, deploy to production with version bump to include:
- Session validation logic
- Enhanced debug logging (`[MCP-DEBUG]`, `[MCP-SERVER-DEBUG]`, `[Worker-DEBUG]`)
- Session ID tracking throughout the tool call lifecycle

### Testing
Local testing showed the fix working correctly:
- Worker MCP session established successfully
- Tool calls (`read_brand_guidelines`, `create_work_plan`) executed without errors
- Session ID properly included in all HTTP requests

# Continue with Google not working in dev
It could be due to auth related code was changed and the change would require restart `npm run dev` in order for the Google Login to work again.

# prod deployment on AWS Beanstalk
June 03, 2025: a deployment to backend failed and it failed to revert back to previous version. Restarting the app server and rebuilt the environemnt not worked. To resolve the issue, we had to clone the environment and then pointed the dns record in route 53 to the new environment.

# March 23, 2026: Path Traversal Attack Investigation

## Problem

Production nginx logs showed a high volume of suspicious requests probing for common web vulnerabilities (PHP, Java, .env files, path traversal). Investigation needed to determine if any attacks were successful and whether the codebase is vulnerable.

## Attack Evidence from Production Logs

**1,114 malicious requests** across Mar 19–23 from automated vulnerability scanners. **All returned 404** — no successful exploitation.

### Attack Types (by volume)
| Type | Count | Description |
|------|-------|-------------|
| PHPUnit/eval-stdin | 949 | Probing for exposed PHP test suites (`/vendor/phpunit/.../eval-stdin.php`) |
| .env probe | 67 | Attempting to read environment variables (`GET /.env`) |
| Path traversal (LFI) | 47 | PHP Local File Inclusion via `index.php?lang=../../../../usr/local/lib/php/pearcmd` |
| Spring actuator | 7 | Probing for Java Spring endpoints (`/actuator/health`) |
| Other | 44 | Mixed scanner fingerprinting (`/webui/`, `/developmentserver/metadatauploader`, etc.) |

### Scanner Fingerprints
- `libredtail-http` — automated vulnerability scanner
- `Mozilla/5.0 zgrab/0.x` — zgrab network scanner
- Spoofed Chrome/Firefox user-agents for .env probes

### Key Attacker IPs
`110.35.80.116`, `75.119.137.153`, `82.24.64.32`, `118.196.74.89`, `165.154.232.244`, `34.158.79.105`, `145.223.47.104`, `45.39.7.12`, `20.163.2.150`, `20.64.106.28`, `65.49.1.142`, `48.214.144.34`

## Code Audit Findings

### No Filesystem Path Traversal Vulnerabilities
1. **No `express.static` serving** — backend doesn't serve static files from the filesystem
2. **No `res.sendFile` / `res.download`** — no file download endpoints using filesystem paths
3. **No user-input in `path.join`** — all `fs.readFileSync` calls use hardcoded paths (`docs/AGENT_API.md`, `docs/skill.md`, font files, UUID-generated temp files)
4. **Asset serving via S3** — `/asset/:assetHash` decodes a hash to S3 bucket/key, not filesystem paths
5. **File uploads go to S3** — no local filesystem storage of user uploads

### Landing Page GitHub File Endpoints — Low Risk
4 endpoints in `landingPageGeneration.ts` accept user-supplied file paths passed to GitHub API. They have `..` checks but could be hardened:
- `GET /api/landing-pages/v0/generated/:id/file-content` (line 629)
- `PUT /api/landing-pages/v0/generated/:id/github-edit` (line 415)
- `GET /api/landing-pages/v0/generated/:id/commits` (line 681)
- `GET /api/landing-pages/v0/generated/:id/file-at-commit` (line 726)

Risk is low: paths go to GitHub API (not filesystem), require auth + ownership, and Express's `qs` parser auto-decodes `%2e%2e` preventing URL-encoded bypasses.

## Conclusion

All attacks are **automated internet background noise** targeting PHP/Java/Python stacks. The Node.js/Express backend with no filesystem file serving is not vulnerable. All attack requests correctly return 404. Consider AWS WAF and nginx rate limiting for defense-in-depth.

June 04, 2025: another outage of the backend. To resolve the issue and improve reliability, updated the environment to use t3-small instead of t3-micro as first option and t3-medium as second option. It was t3-micro then t3-small.

June 16, 2025:
# Known issues of Gemini model with browser use
Gemini models cannot work with the BaseModel argument with function call. Also it has a strange issue that require minimum 1 argument. We needed to add patch to use simpler argument for gemini models.

June 19, 2025
The latest version of browser-use (0.2.7) has an issue of using the same persistent storage for session data which mixed the cookie files from different users. 

June 21, 2025
When restoring a previous good version of browser-use, an issue about old_history table or index crash arised. It was initially suspected to be issue with browser use or playwright but after several round of testings the issue was with the memory dependency of browser use. Uninstall the component solved the issue as this is not a hard dependency:
`pip uninstall -y mem0ai`
To reinstall it, run
`pip install "browser-use[memory]"`
# Update September 24, 2025: got the error again but realized we are using python3 at dev which seems not an issue until Rui's MacBook Pro accidentally crashed and probably crashed the python3 install. The issue has been fixed with a reinstall of all dependencies with requirements.txt and playwright reinstall. No prod change should be made. It was purely a dev issue.
To fix browser-use version - 
pip install "browser-use[memory]==0.1.48"
Force to install on dev
python3 -m pip install "browser-use[memory]==0.1.48" --break-system-packages
python3 -m pip install -r requirements.txt --break-system-packages
python3 -m playwright install chromium
## Test playwright afterwards
python3 -c "from playwright.sync_api import sync_playwright; p = sync_playwright().start(); browser = p.chromium.launch(); print('✅ Chromium browser launched successfully'); browser.close(); p.stop()"

Issue with reverted PRs: when there are reverted PRs, there is risk that changes may mess up, possibly due to accumulated changes are too many that github seems may start truncate. We encountered such issue when deploying the data analysis PR. A resolution was to start clean which causes much less confusion.

July 28, 2025
# DynamoDB Index Management

## Adding UserIdIndex to TaskExecutions Table

When deploying the Images feature, you may encounter an error: `ValidationException: The table does not have the specified index: UserIdIndex`. This happens because the TaskExecutions table is missing the UserIdIndex that's required for the `getAllTaskExecutionsByUserId` method.

### Manual Fix via AWS Management Console

1. **Access DynamoDB Console**
   - Go to AWS Management Console
   - Navigate to DynamoDB service
   - Click on "Tables" in the left sidebar

2. **Select the TaskExecutions Table**
   - Find the table named `Dev-AW-TaskExecutions` (development) or `AW-TaskExecutions` (production)
   - Click on the table name to open its details

3. **Add the Index**
   - In the table details page, scroll down to the "Indexes" section
   - Click "Create index" button
   - Fill in the following details:
     - **Partition key**: `userId` (String)
     - **Sort key**: `startTime` (String)
     - **Index name**: `UserIdIndex`
     - **Index capacity**: Copy from base table
     - **Attribute project**: All
   - Click "Create index"

4. **Wait for Index Creation**
   - The index will show "Creating" status initially
   - This process can take several minutes depending on table size
   - Monitor the status until it changes to "Active"

5. **Verify the Index**
   - Once the index is active, you can verify it by:
     - Going back to the table's "Indexes" section
     - Confirming `UserIdIndex` shows "Active" status
     - The index should have `userId` as partition key and `startTime` as sort key

### Prevention for Future Deployments

The `create-tables.ts` script has been updated to include the `UserIdIndex` by default for new deployments. This ensures that future table creations will automatically include the required index.

August 07, 2025
testing with gpt-5 models: Azure does offer gpt-5-chat but has insufficient quota error; OpenAI offers all models but gpt-5 require removal of temperature but even after it is removed, it is not responding to extract-content call. gpt-5-chat-latest has error about tools not supported

August 25, 2025
deploying Growth Genius: creating a beanstalk service could easily got stuck because it would just fail: create a new environment failed, copy from customer portal environment and then deploy the genius app failed. It may not be able to recover from failure. be able to fetch the log or not makes a difference. For example, the first time I was not able to fetch the log, which indicates a different problem when next time I was able to fetch it which showed a different problem, though from the deployment log they were like same failure.

August 28, 2025
supporting multiple image input for openai model require using latest openai model
> pip install --upgrade openai

We have issues creating new environment in elastic beanstalk. We tested using AWSEBSSecurityGroup for EC2 security groups because the service instances (EC2) needs to communicate with the load balancer but it still not working.

Sept. 14, 2025
Debug with full log from Elastic Beanstalk: web.stdout.log has the app log.

October 10, 2025
## DynamoDB: Add UserIdIndex to AW-TaskSchedules

If you need to add the `UserIdIndex` GSI to the `AW-TaskSchedules` table (used by Scheduled Chats), use these commands.

Prerequisites:
- AWS CLI configured for the target account/region (`aws configure`)
- Region: `us-west-2` (override with `--region` if different)

Add index in Development (Dev- prefixed table, provisioned capacity):

```bash
aws dynamodb update-table \
  --table-name Dev-AW-TaskSchedules \
  --attribute-definitions AttributeName=userId,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"UserIdIndex","KeySchema":[{"AttributeName":"userId","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}}}]' \
  --region us-west-2
```

Add index in Production (no prefix, PAY_PER_REQUEST billing mode):

```bash
aws dynamodb update-table \
  --table-name AW-TaskSchedules \
  --attribute-definitions AttributeName=userId,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"UserIdIndex","KeySchema":[{"AttributeName":"userId","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}}}]' \
  --region us-west-2
```

Verify index status (repeat until `IndexStatus` is `ACTIVE`):

```bash
aws dynamodb describe-table \
  --table-name Dev-AW-TaskSchedules \
  --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`UserIdIndex`].{IndexName:IndexName,IndexStatus:IndexStatus}'
```

List all GSIs on the table:

```bash
aws dynamodb describe-table \
  --table-name Dev-AW-TaskSchedules \
  --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[].{IndexName:IndexName,IndexStatus:IndexStatus}'
```

Notes:
- GSI creation is asynchronous; queries against `UserIdIndex` work after status becomes `ACTIVE`.
- Replace `Dev-AW-TaskSchedules` with `AW-TaskSchedules` for production.

## DynamoDB: Add EmailDomainLeadEmailIndex to AW-EmailEvents

If you need to add the `EmailDomainLeadEmailIndex` composite GSI to the `AW-EmailEvents` table (for efficient lead engagement queries), use these commands.

Prerequisites:
- AWS CLI configured for the target account/region (`aws configure`)
- Region: `us-west-2` (override with `--region` if different)

Add index in Development (Dev- prefixed table):

```bash
aws dynamodb update-table \
  --table-name Dev-AW-EmailEvents \
  --attribute-definitions AttributeName=emailDomain,AttributeType=S AttributeName=leadEmail,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"EmailDomainLeadEmailIndex","KeySchema":[{"AttributeName":"emailDomain","KeyType":"HASH"},{"AttributeName":"leadEmail","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"},"ProvisionedThroughput":{"ReadCapacityUnits":5,"WriteCapacityUnits":5}}}]' \
  --region us-west-2
```

Add index in Production (no prefix):

```bash
aws dynamodb update-table \
  --table-name AW-EmailEvents \
  --attribute-definitions AttributeName=emailDomain,AttributeType=S AttributeName=leadEmail,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"EmailDomainLeadEmailIndex","KeySchema":[{"AttributeName":"emailDomain","KeyType":"HASH"},{"AttributeName":"leadEmail","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}}]' \
  --region us-west-2
```

Verify index status (repeat until `IndexStatus` is `ACTIVE`):

```bash
aws dynamodb describe-table \
  --table-name Dev-AW-EmailEvents \
  --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`EmailDomainLeadEmailIndex`].{IndexName:IndexName,IndexStatus:IndexStatus}'
```

List all GSIs on the table:

```bash
aws dynamodb describe-table \
  --table-name Dev-AW-EmailEvents \
  --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[].{IndexName:IndexName,IndexStatus:IndexStatus}'
```

After the index is active, run the repair-tables script to update the table schema:

```bash
cd backend
NODE_ENV=development npx ts-node src/scripts/@repair-tables.ts
```

For production, use:
```bash
cd backend
NODE_ENV=production npx ts-node src/scripts/@repair-tables.ts
```

## DynamoDB: Add AdminUpdatedAtIndex to AW-ChatSessions

If you need to add the `AdminUpdatedAtIndex` GSI to the `AW-ChatSessions` table (for admin chat history pagination), use these commands.

Prerequisites:
- AWS CLI configured for the target account/region (`aws configure`)
- Region: `us-west-2` (override with `--region` if different)

Add index in Development (Dev- prefixed table):

```bash
aws dynamodb update-table \
  --table-name Dev-AW-ChatSessions \
  --attribute-definitions AttributeName=adminListPartition,AttributeType=S AttributeName=updatedAt,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"AdminUpdatedAtIndex","KeySchema":[{"AttributeName":"adminListPartition","KeyType":"HASH"},{"AttributeName":"updatedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"},"ProvisionedThroughput":{"ReadCapacityUnits":5,"WriteCapacityUnits":5}}}]' \
  --region us-west-2
```

Add index in Production (no prefix):

```bash
aws dynamodb update-table \
  --table-name AW-ChatSessions \
  --attribute-definitions AttributeName=adminListPartition,AttributeType=S AttributeName=updatedAt,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"AdminUpdatedAtIndex","KeySchema":[{"AttributeName":"adminListPartition","KeyType":"HASH"},{"AttributeName":"updatedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}}]' \
  --region us-west-2
```

Verify index status (repeat until `IndexStatus` is `ACTIVE`):

```bash
aws dynamodb describe-table \
  --table-name Dev-AW-ChatSessions \
  --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`AdminUpdatedAtIndex`].{IndexName:IndexName,IndexStatus:IndexStatus}'
```

Notes:
- Do not specify `ProvisionedThroughput` when the table billing mode is `PAY_PER_REQUEST` (production).
- After the index is active, backfill `adminListPartition` for existing items so they show up in the index.

Backfill in Development:

```bash
cd backend
NODE_ENV=development npx ts-node src/scripts/repair-chat-sessions-admin-index.ts
```

Backfill in Production:

```bash
cd backend
NODE_ENV=production npx ts-node src/scripts/repair-chat-sessions-admin-index.ts
```

## Port Management

### Finding and Killing Processes on Port 3001

When you need to free up port 3001 (commonly used by development servers), use these commands:

1. **Find processes using port 3001:**
   ```bash
   lsof -ti:3001
   ```
   This will return the Process IDs (PIDs) of all processes using port 3001.

2. **Kill the processes:**
   ```bash
   kill -9 <PID1> <PID2> ...
   ```
   Replace `<PID1>`, `<PID2>`, etc. with the actual PIDs returned from the previous command.

## Memory System Issues (October 14, 2025)

### Azure OpenAI Models Failing with Database Errors

If Azure OpenAI models (gpt-4o, gpt-4.1) fail with errors like:
- `"there is already another table or index with this name: old_history"`
- `"no such column: prev_value"`

This indicates corrupted memory database files in the mem0 system used by browser-use.

### Quick Fix

Run the memory cleanup script:
```bash
cd agent-engine
conda activate agent-engine
python memory_fix_v2.py
```

This will:
- Clean up all corrupted mem0 database files
- Configure memory system to use in-memory database
- Resolve database schema issues

### Manual Cleanup (if script not available)

```bash
# Remove all mem0 directories
rm -rf /tmp/mem0_*
rm -rf ~/.mem0

# Set environment variables
export MEM0_DATABASE_URL="sqlite:///:memory:"
export MEM0_BACKEND="sqlite"
```

### Prevention

The memory fix only needs to be applied once when the issue occurs. It doesn't need to run automatically on every startup.

### Alternative: Disable Memory Entirely

If memory issues persist, you can disable the memory system:
```bash
export MEM0_DISABLED="true"
export BROWSER_USE_MEMORY_DISABLED="true"
```

### Files Created for Reference

- `agent-engine/memory_fix_v2.py` - Enhanced memory fix script
- `agent-engine/tests/test_memory_fix_v2.py` - Comprehensive tests
- `agent-engine/MEMORY_FIX_V2_SUMMARY.md` - Detailed documentation

November 23, 2025
There was two outages in recent three days. To debug, I downloaded the full log files and then asked Cursor to look into and she found that Emma was running workflows for too long and thus blocked health checks from AWS which then got Elastic Beanstalk to go unhealthy and go crazy to mess up.

November 24, 2025
Added oncall alert on Agentweb-backend-env-prod-3 env as it is currently the prod backend and most risky outage.

November 29, 2025
## Azure Anthropic Foundry API Hanging Issue with Long Prompts

The Azure Anthropic Foundry API (via `@anthropic-ai/foundry-sdk`) experiences hanging behavior when processing long prompts, particularly when combined with large `max_tokens` values. Testing revealed that prompts exceeding approximately 500 characters can cause the API to hang indefinitely, with requests timing out after 30-90 seconds or never completing. This issue appears to be a limitation of the Azure Anthropic Foundry service itself rather than a bug in the SDK libraries, as both `@anthropic-ai/foundry-sdk` (v0.2.0) and `@anthropic-ai/sdk` (v0.71.0) are at their latest versions.

Because of this, it is hard to use Anthropic LLM via Azure.

December 02, 2025
VEO 3.1 integration doc: https://ai.google.dev/gemini-api/docs/video?example=dialogue#javascript_2

December 06, 2025
## CVE-2025-55182 (React2Shell) Security Check

### Assessment: Project is NOT directly impacted

**Status**: ✅ Not vulnerable

### Findings

1. **Frontend Applications (Safe)**:
   - `customer-portal`: React 18.3.1 ✅
   - `partner-portal`: React 18.3.1 ✅
   - `growth-chat`: React 18.3.1 ✅
   - All frontend applications use React 18.x, which is NOT affected by CVE-2025-55182

2. **Backend (Low Risk)**:
   - Has React 19.0.0 installed as a transitive dependency via `reactflow` and `@reactflow/core`
   - **NOT using React Server Components (RSC)** - no `react-server-dom-*` packages found
   - No Next.js or RSC frameworks detected
   - Backend is a standard Express.js server, not using RSC functionality

### Why It's Not Vulnerable

CVE-2025-55182 (React2Shell) is a critical pre-authentication remote code execution (RCE) vulnerability that specifically affects:
- React 19.0.0, 19.1.0, 19.1.1, and 19.2.0
- **React Server Components (RSC)** functionality
- Frameworks using RSC (Next.js 15.x/16.x, React Router, Waku, Parcel RSC, Vite RSC)

While the backend has React 19.0.0 installed, it does **not** use React Server Components, so the vulnerability does not apply.

### Recommendations

1. **Monitor for Future Changes**:
   - If you plan to add React Server Components or upgrade to Next.js 15.x/16.x, ensure you use patched React versions:
     - React 19.0.1, 19.1.2, or 19.2.1+
     - Next.js 15.0.5+, 15.1.9+, 15.2.6+, 15.3.6+, 15.4.8+, 15.5.7+, or 16.0.7+

2. **Optional Cleanup**:
   - Consider removing React 19.0.0 from backend dependencies if `reactflow` is not actively used
   - Or pin `reactflow` to a version that doesn't require React 19

3. **Regular Security Audits**:
   - Run `npm audit` regularly to check for security vulnerabilities
   - Monitor React and Next.js security advisories

### Verification Commands

To verify React versions in the future:
```bash
# Check frontend React versions
cd customer-portal && npm list react react-dom
cd partner-portal && npm list react react-dom
cd growth-chat && npm list react react-dom

# Check backend React version (if needed)
cd backend && npm list react react-dom
```

### References
- CVE-2025-55182 Scanner: https://cve-2025-55182.com/
- React Security Advisory: https://github.com/facebook/react/security

## MAL-2026-2307 (Axios Supply Chain Attack) Security Check

**Date:** 2026-04-02 | **Status:** ✅ Not affected

### Summary

On 2026-03-31, the `axios` npm package was compromised and malicious versions `0.30.4` and `1.14.1` were published to npm. The compromised versions included a malicious dependency called `plain-crypto-js` that installs a **Remote Access Trojan (RAT)**. The RAT phones home to `sfrclak.com:8000/6202033` (IP `142.11.206.73`).

According to the advisory: _"Any computer that has this package installed or running should be considered fully compromised. All secrets and keys stored on that computer should be rotated immediately from a different computer."_

### Affected Versions

- `axios@0.30.4`
- `axios@1.14.1`

### AgentWeb Findings

All three components were checked and are **not affected**:

| Component | Declared | Installed | Status |
|-----------|----------|-----------|--------|
| backend | `^1.9.0` | **1.9.0** | ✅ Safe |
| partner-portal | `^1.7.9` | **1.11.0** | ✅ Safe |
| customer-portal | `^1.9.0` | **1.11.0** | ✅ Safe |

Additional IOC checks (all clean):
- No `plain-crypto-js` found in any `package-lock.json` or `node_modules`
- No references to `sfrclak.com` or `142.11.206.73` anywhere in the codebase

### References

- OSV Advisory: [MAL-2026-2307](https://osv.dev/vulnerability/MAL-2026-2307)
- GitHub Advisory: [GHSA-fw8c-xr5c-95f9](https://github.com/advisories/GHSA-fw8c-xr5c-95f9)
- StepSecurity Blog: https://www.stepsecurity.io/blog/axios-compromised-on-npm-malicious-versions-drop-remote-access-trojan

## Dec 15, 2025
to support pdf file uploads for Knowledge Base, add OCR Parser for PDF file formats so that Vertex AI Search will uses this parser to parse PDF files.

## Dec 23, 2025
After resolving conflicts, we need to use force push to remote. On Github Desktop, instead of clicking on the pull and push button, we should select force push from it because otherwise a pull will happen again which will get the conflicts happen again.

## Dev 30, 2025
If tests fail in PR, we could rerun the step in the PR to see whether it is a random issue. This worked for customer-portal.

## Jan 2, 2026
### LinkedIn Configuration Update
Renamed LinkedIn credential functions and updated secret paths to clarify personal vs. company credentials.

- **Personal Profile Integration**:
  - Dev Secret: `dev/AgentWeb/LinkedIn/Personal`
  - Prod Secret: `prod/AgentWeb/LinkedIn/Personal`

- **Organization/Company Page Integration**:
  - Dev Secret: `dev/AgentWeb/LinkedIn/Company`
  - Prod Secret: `prod/AgentWeb/LinkedIn/Company`

## January 06, 2026
### Scheduled Chat Run History: Optimized Storage to Prevent DynamoDB Size Limits

#### Problem
The `runResults` array stored in `AW-TaskSchedules` table was hitting DynamoDB's 400KB item size limit. The `actualResponse` field (containing the full AI response text) was the primary contributor to item size, often taking 1-20KB per entry.

#### Solution
Instead of storing `actualResponse` in the database, we now:
1. **Exclude `actualResponse` when storing** run results to DynamoDB
2. **Reconstruct `actualResponse` on-demand** from session messages only when needed (when sending emails)
3. **Keep `actualResponse` in error cases** where there's no session to reconstruct from

#### Implementation Details
- Helper function `getActualResponseFromSession()` extracts the last assistant message from the session
- `actualResponse` is removed from the result object before calling `addRunResult()`
- Reconstruction happens in:
  - `sendScheduledChatTestEmail()` - when user clicks "Send Email" in Run History
  - `sendDailyDigestEmail()` - when sending daily digest emails

#### Size Estimates

**Per Entry (without `actualResponse`):**
- Base fields: ~530 bytes
  - scheduleId, runId, sessionId (UUIDs): ~120 bytes
  - status, passed, attempt, executionTime: ~30 bytes
  - createdAt (ISO string): ~30 bytes
  - Arrays (keywordMatches, keywordMisses, functionCallMatches, etc.): ~200-400 bytes
  - functionCallDetails object: ~100-500 bytes
- **Average: ~800 bytes per entry**

**Per Entry (with `actualResponse` - old method):**
- Base fields: ~530 bytes
- actualResponse: 1-20KB (average ~3-5KB)
- **Average: ~3,800-6,500 bytes per entry**

**Savings per entry: ~3-5KB**

#### Capacity Estimates

DynamoDB item size limit: **400KB**
- Base schedule data (scheduleName, description, startingMessage, etc.): ~2-5KB
- Available space for runResults: **~395-398KB**

**Old Method (with `actualResponse`):**
- 395KB ÷ 6.5KB (worst case) = **~60 entries**
- 395KB ÷ 3.8KB (average) = **~104 entries**

**New Method (without `actualResponse`):**
- 395KB ÷ 0.8KB = **~490 entries**

**Improvement: ~8x more entries can be stored** (from ~60-100 entries to ~490 entries)

#### Notes
- `actualResponse` is still available when needed (emails) via on-demand reconstruction
- Error cases (no session) still store `actualResponse` since it can't be reconstructed
- Frontend Run History display doesn't need `actualResponse`, so no performance impact on viewing history

Ran repair script to clean up actualResponse
NODE_ENV=production npx ts-node src/scripts/repair-scheduled-chat-run-results.ts 
Repairing TaskSchedules table to remove actualResponse from runResults: {
  environment: 'production',
  region: 'us-west-2',
  tablePrefix: '',
  tableName: 'AW-TaskSchedules'
}
Starting repair process...

(node:82443) NOTE: The AWS SDK for JavaScript (v2) is in maintenance mode.
 SDK releases are limited to address critical bug fixes and security issues only.

Please migrate your code to use AWS SDK for JavaScript (v3).
For more information, check the blog post at https://a.co/cUPnyil
(Use `node --trace-warnings ...` to show where the warning was created)
Processing batch: 14 schedules (Total scanned: 14)
Processing batch: 8 schedules (Total scanned: 22)
  ✓ Updated 10 schedules, cleaned 734 runResults entries so far...
Processing batch: 34 schedules (Total scanned: 56)
  ✓ Updated 20 schedules, cleaned 1066 runResults entries so far...
Processing batch: 20 schedules (Total scanned: 76)
  ✓ Updated 30 schedules, cleaned 1533 runResults entries so far...
Processing batch: 13 schedules (Total scanned: 89)
Processing batch: 19 schedules (Total scanned: 108)
  ✓ Updated 40 schedules, cleaned 2179 runResults entries so far...

==================================================
Repair process completed!
==================================================
Total schedules scanned: 108
Total schedules updated: 43
Total schedules skipped: 65 (no runResults or already cleaned)
Total runResults entries cleaned: 2179
Total errors: 0
==================================================

✅ Repair completed successfully!

## Jan 14 2026
Configured Claude Code and use AWS Bedrock for the LLM: https://code.claude.com/docs/en/amazon-bedrock. In future, we could also use Azure as it starts to offer Claude models but no quota at the moment.

## Jan 29, 2026
Install playwright mcp for claude
claude mcp add playwright -- npx -y @playwright/mcp@latest

## Feb 2, 2026
### Google Analytics Not Receiving Data from app.agentweb.pro

#### Problem
After publishing GTM container updates to add tracking for app.agentweb.pro, no data was appearing in Google Analytics property 489864500. The Product Analytics API endpoint (`/api/seo/product-metrics`) returned zero data for app.agentweb.pro despite tracking being configured.

#### Initial Investigation
- GTM Preview showed events firing (page_view, scroll, user_engagement) ✅
- Network requests showed GA4 events being sent to `server-side-tagging-50006506707.us-central1.run.app/g/collect` ✅
- BUT no data appeared in GA4 Realtime reports or historical data ❌
- Even www.agentweb.pro stopped receiving data on Feb 2 (had data on Feb 1)

#### Root Cause Analysis

**Issue 1: Domain Configuration**
- GA4 data stream was configured with "exact match" for `agentweb.pro`
- This blocked app.agentweb.pro subdomain from being accepted
- **Fix**: Changed domain matching from "exact match" to "contains" with entries:
  - `agentweb.pro`
  - `withsurface.com`
  - `agentwebforms.com`
  - `app.agentweb.pro`

**Issue 2: GTM Tag Configuration (Primary Issue)**
- GTM had two GA4-related tags:
  1. `FB_CONVERSIONS_API-1430870751246428-Web-Tag-GA4_Config` (Type: "Google Tag")
  2. `FB_CONVERSIONS_API-1430870751246428-Web-Tag-GA4_Event` (Type: "Google Analytics: GA4 Event")
- The GA4_Event tag referenced a Google Tag named **"AgentWeb"** that didn't exist
- The GA4_Config tag was named differently and wasn't firing in GTM Preview
- Without the Config tag firing, Event tags had no configuration to send data to

**Issue 3: Incorrect Trigger**
- GA4_Config tag was using "DOM Ready" trigger
- "Google Tag" type must fire on "Initialization - All Pages" to load gtag.js before other tags

#### Debugging Process

1. **Verified tracking firing**: Used browser DevTools to confirm GA4 events in network tab
2. **Checked GA4 real-time data**: No activity showing for app.agentweb.pro
3. **Analyzed GTM Preview**: Found GA4_Config tag in "Tags Not Fired" section
4. **Discovered tag reference mismatch**: GA4_Event looking for "AgentWeb" tag that didn't exist
5. **Tested historical data**: Confirmed all tracking (even www.agentweb.pro) stopped on Feb 2

#### Solution

1. **Renamed GTM Tag**:
   - Changed `FB_CONVERSIONS_API-1430870751246428-Web-Tag-GA4_Config` to `AgentWeb`
   - This allowed GA4_Event tag to find and reference the correct config tag

2. **Fixed Trigger**:
   - Changed AgentWeb tag trigger from "DOM Ready" to **"Initialization - All Pages"**
   - "Google Tag" type must fire early to initialize gtag.js

3. **Updated GA4 Domain Settings**:
   - In GA4 Admin → Data Streams → Configure tag settings
   - Changed domain matching to "contains" instead of "exact match"
   - Added app.agentweb.pro to allowed domains list

4. **Published GTM Container**:
   - Saved all changes
   - Published new container version
   - Verified in GTM Preview that AgentWeb tag now fires at Initialization

#### Verification

**Immediate Results**:
- ✅ GTM Preview shows "AgentWeb" tag firing at Initialization
- ✅ GA4_Event tags firing successfully with configuration
- ✅ GA4 Realtime report shows activity from app.agentweb.pro
- ✅ Page titles like "AgentWeb - Marketing Operations" appearing in real-time data

**Expected Timeline**:
- Real-time data: Available immediately ✅
- Historical data (Product API): 24-48 hours for data to populate
- Full metrics backfill: Up to 72 hours

#### Configuration Details

**GA4 Property**:
- Property ID: `489864500`
- Measurement ID: `G-KKJE0Q33LF`
- Data Stream: "AgentWeb" (https://www.agentweb.pro)

#### Important Note on Localhost Traffic

**Localhost traffic is still sent to Google Analytics but filtered in Customer Portal**:
- Development traffic from `localhost` is currently being sent to GA4 property 489864500
- The backend Product Analytics API (`/api/seo/product-metrics`) filters out localhost traffic using dimension filters:
  ```typescript
  dimensionFilter: {
    andGroup: {
      expressions: [
        { filter: { fieldName: "hostName", stringFilter: { matchType: "CONTAINS", value: user.productDomain } } },
        { notExpression: { filter: { fieldName: "hostName", stringFilter: { matchType: "CONTAINS", value: "localhost" } } } }
      ]
    }
  }
  ```
- **Result**: Customer Portal shows accurate production-only metrics, but Google Analytics UI will show inflated numbers that include localhost traffic
- **Recommendation**: Follow the guide in `GA4_EXCLUDE_LOCALHOST_GUIDE.md` to prevent localhost traffic from reaching GA4 entirely (Method 3 or 4 recommended)

## February 04, 2026

### LinkedIn Import Stuck at 0% - WebSocket Connection Failure

**Symptom**: LinkedIn import feature in CRM page showed progress stuck at 0%, no data imported to database, WebSocket connection errors in browser console showing malformed URL: `ws://https/socket.io/`

**Root Causes**:

1. **Missing nginx WebSocket configuration in production**
   - Elastic Beanstalk's nginx proxy doesn't support WebSocket upgrade by default
   - Socket.IO connections were blocked at the nginx layer
   - Development worked because it connects directly to backend (no nginx proxy)

2. **Incorrect nginx configuration placement**
   - Initial fix placed `websocket.conf` in `.platform/nginx/conf.d/`
   - This directory is for `http` block context (global settings)
   - `location` blocks are NOT allowed in `http` context → deployment failed
   - Correct location: `.platform/nginx/conf.d/elasticbeanstalk/` (for `server` block context)

3. **Frontend Socket.IO URL parsing bug**
   - Code used: `buildApiUrl("").replace("/api", "")`
   - For staging URL `https://api-stage.agentweb.pro/api`:
     - Incorrectly replaced "api" everywhere including in "api-stage"
     - Result: `https://-stage.agentweb.pro` (broken URL)
     - Socket.IO saw malformed URL and created: `ws://https/socket.io/`
   - Fix: Use regex to only remove `/api` at the end: `.replace(/\/api\/?$/, "")`

**Resolution Steps**:

1. **Added WebSocket nginx configuration**:
   ```
   backend/.platform/nginx/conf.d/elasticbeanstalk/websocket.conf
   ```
   - Includes `location /socket.io/` block with WebSocket upgrade headers
   - `proxy_set_header Upgrade $http_upgrade`
   - `proxy_set_header Connection "upgrade"`
   - Extended timeouts for long-running imports (3600s)

2. **Fixed Socket.IO URL parsing** in `customer-portal/src/pages/CRM.tsx`:
   ```typescript
   const apiUrl = buildApiUrl("");
   const socketUrl = apiUrl.replace(/\/api\/?$/, ""); // Only remove /api at END
   ```

**Debugging Process**:

1. **Initial Investigation**:
   - Checked Elastic Beanstalk logs via AWS CLI
   - Required adding IAM permissions for CloudWatch Logs and Beanstalk access
   - Found no `mode=import` requests in nginx access logs (only `mode=preview`)
   - Realized import never started due to WebSocket connection failure

2. **Backend Log Analysis**:
   - Preview requests returned HTTP 200 with valid JSON (~2,185 bytes)
   - Successfully parsed 2,986-5,538 connections and 5,484-7,132 messages
   - No server-side errors logged
   - WebSocket server initialized correctly

3. **Deployment Failures**:
   - First attempt: Used `map` directive in `conf.d/` → failed (wrong context)
   - Second attempt: Used `location` block in `conf.d/` → failed (wrong context)
   - Third attempt: Moved to `conf.d/elasticbeanstalk/` → succeeded

4. **Frontend WebSocket Error**:
   - Browser console showed malformed WebSocket URL
   - Traced to `.replace("/api", "")` matching "api" in hostname
   - Fixed with regex to only match `/api` at end of string

**Key Learnings**:

- **Elastic Beanstalk nginx structure**:
  - `.platform/nginx/conf.d/` → `http` block (no location blocks allowed)
  - `.platform/nginx/conf.d/elasticbeanstalk/` → `server` block (location blocks allowed)
  - Refer to AWS docs: https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/platforms-linux-extend.proxy.html

- **IAM Permissions for Log Access**:
  - Need `AWSElasticBeanstalkReadOnly` policy
  - Need `CloudWatchLogsReadOnlyAccess` policy
  - Can also add `elasticbeanstalk:RetrieveEnvironmentInfo` permission

- **WebSocket Testing**:
  - Always test Socket.IO connections in staging before production
  - Check browser console for WebSocket connection errors
  - Verify correct URL format: `wss://domain.com/socket.io/` not `ws://https/socket.io/`

- **String Replace Gotchas**:
  - Be careful with `.replace()` when URL contains similar substrings
  - Use regex with anchors (`$` for end of string) for precise replacements
  - For staging URLs like `api-stage.agentweb.pro`, simple string replace is dangerous

## Research Session Investigation (2026-03-17)

Investigated session `b34576c1-70f9-40da-a628-6fc8f9a3b129` ("Test: Weekly Competitor News Researcher", user `f958eb3e`, schedule `6588424c`).

**Observation:** On attempt 3 the LLM ignored explicit instructions to perform a deeper re-search, simply repeating the previously generated output instead of running new searches.

**Root cause:** The schedule's `requiredFunctionCalls` includes `search_web`, but `search_web` is not actually required for this schedule — the LLM's research workflow already calls search tools organically. Having `search_web` as a required function causes `runVerifiedChat` to retry when the function hasn't been called yet, and on retries the LLM sees its previous output in the conversation history and repeats it rather than executing fresh searches.

**Mitigation:** Remove `search_web` from the schedule's `requiredFunctionCalls`. The schedule only truly requires `read_market_strategy` to load competitor info. The LLM will still call search tools as part of its natural research flow without needing them enforced as required calls.

**Broader notes:**
- The `runVerifiedChat` retry prompt (lines 583-618 of `agentModeController.ts`) intentionally avoids re-requesting tools that already ran. When all required functions have been called but the work plan isn't complete, it sends generic "complete pending steps" messages. This means retries don't force the LLM to use different search parameters.
- 229 sessions use `perform_deep_research`. Overall 84% succeed at producing blog articles. `gemini-3-pro-preview` has a 23% failure rate vs 1% for `gemini-3.1-pro-preview`.
- 42 sessions show durations >2 hours (stuck/zombie sessions), likely due to long-running deep research polls that don't properly clean up.

## Message Limit & Context Window Investigation (2026-03-19)

### Current State

Agent Mode sessions are capped at **300 messages** (`MAX_MESSAGE_SIZE_PER_SESSION` in `backend/src/config.ts`). Raised from 150 in a previous release.

### Bug Found: 10-User-Message Sliding Window

**`buildMarketingContext()`** (agentModeService.ts:1785) currently slices conversation history to only the **last 10 user messages** + associated assistant/tool responses. This means the LLM is blind to most of the conversation history in any session with more than ~10 exchanges. This is a bug — context from earlier messages is silently dropped.

**Code location:** Lines 1801-1813 in `buildMarketingContext()`:
```
let userCount = 0;
let startIdx = 1;
for (let i = filteredHistory.length - 1; i >= 0; i--) {
  if (filteredHistory[i].role === 'user') {
    userCount++;
    if (userCount === 10) { startIdx = i; break; }
  }
}
const sliced = filteredHistory.slice(startIdx);
```

**Fix:** Remove this sliding window entirely. All messages should be included in context.

### How Context is Built Today

```
1. System prompt
2. Skills context (available + installed skills)
3. Account memory (cross-session facts)
4. Last 10 user messages + their assistant/tool responses  <-- BUG: should be ALL messages
5. Task statuses
6. Work plan (if active)
7. Current user message
   |
trimToolMessagesForContext()  (truncate old tool outputs to 8000 chars)
   |
callLLM()
```

**Key files:**
- `agentModeService.ts:774` — `generateMarketingResponse()` main entry
- `agentModeService.ts:1785` — `buildMarketingContext()` slices to last 10 user msgs
- `agentModeService.ts:12015` — `trimToolMessagesForContext()` truncates old tool results
- `chatbotService.ts:806` — `getMessagesFromMessagesTable()` loads from DynamoDB
- `config.ts:4` — `MAX_MESSAGE_SIZE_PER_SESSION = 300`

### Proposed Solution: Summarization + `query_message_details` Tool

Two complementary mechanisms that together enable **unlimited messages**:

1. **Periodic Summarization:** Every 200 messages, generate a summary using Gemini Flash Lite and inject it as a system-level context message. Original messages are preserved in DB but replaced by summaries in the LLM context.

2. **`query_message_details` Tool:** A foundation tool that lets the LLM retrieve specific details from older messages on-demand. Uses Gemini Flash Lite (~$0.01/query, 1-2s latency) to answer questions against the full message history.

**Why this works:**
- Summaries give the LLM a high-level map of the full conversation
- The tool lets the LLM drill into details when needed (the LLM decides when)
- Gemini Flash Lite has ~1M token context window — can read hundreds of messages cheaply
- No new infrastructure needed — just another tool + cheap LLM call
- Scales infinitely — only summaries accumulate (~500 tokens each)

**Architecture:**
```
Messages 1-200:     [Summary A injected as system message]
Messages 201-400:   [Summary B injected as system message]
Messages 401-600:   [Summary C injected as system message]
Messages 601-700:   [Full detail messages in context]

System prompt says: "Use query_message_details to look up specific details
from earlier in the conversation when needed."

When LLM needs detail -> calls query_message_details("what was the blog URL?")
  -> Gemini Flash Lite reads relevant messages, answers the question
  -> Result returned as tool response
```

**Cost for a 1000-message session:** ~$0.18 extra (4 summaries + ~10 detail queries).

### Implementation Plan

**Phase 1: Core Changes**
1. Remove the 10-user-message sliding window in `buildMarketingContext()`
2. Add `generateConversationSummary()` method using Gemini Flash Lite
3. Add `query_message_details` foundation tool + `handleQueryMessageDetails()` handler
4. Inject summaries into context via `buildMarketingContext(summaries)` parameter
5. Store summaries on session record (`ChatSession.summaries[]`)
6. Add `updateSessionSummaries()` to `ChatbotDB`
7. Raise `MAX_MESSAGE_SIZE_PER_SESSION` to 10,000
8. Update system prompt with "Long Conversation Support" guidance

**Phase 2: Polish**
- Frontend: show "Conversation summarized up to message X" indicator
- Admin controls: summarization interval, enable/disable
- Smart triggers: summarize based on token count, not just message count

### Files to Modify
- `backend/src/config.ts` — raise message limit
- `backend/src/services/agentModeService.ts` — remove window, add summarization, add tool handler, add to foundation tools
- `backend/src/services/chatbotService.ts` — add `summaries` to ChatSession, add `updateSessionSummaries()`
- `backend/src/emma/tools.ts` — register `query_message_details` tool

---

## Token Usage Optimization (2026-03-25)

### Investigation Findings (231 tracked prod sessions, March 2026)

| Metric | Value |
|--------|-------|
| Total tokens consumed | 171M |
| Total cost | $1,315 |
| Avg tokens/session | 741K |
| Median cost/session | $0.59 |
| P95 cost/session | $34.96 |
| Prompt:completion ratio | 94:1 (98.5% prompt tokens) |

**Key insight:** prompt tokens dominate because each LLM call in the iteration loop (up to 20 per turn) resends the full conversation context. A 5-iteration turn with growing context pays prompt tokens on every iteration (e.g. 10K+20K+30K+40K+50K = 150K total).

Token growth by session length:
- Short (16 msgs): 1.8x growth per call
- Medium (71 msgs): 7.7x growth
- Long (142 msgs): 7.9x growth
- Heaviest (293 msgs, $51): 2.7x growth (started large from prior scheduled runs)

### Changes Implemented

**1. Anthropic Prompt Caching via Bedrock Converse API**
- Replaced LangChain `ChatBedrockConverse` with direct `ConverseCommand` from `@aws-sdk/client-bedrock-runtime`
- Added `cachePoint` markers: one after system prompt, one before the last message
- Within the tool-call iteration loop, each subsequent call only pays full price for the newest exchange; all prior turns hit the cache (90% discount on cached input tokens)
- Cache metrics logged: `AgentMode: Bedrock cache — read: X, write: Y, uncached input: Z, output: W`
- Cost estimation updated to account for cache read (10% of input price) and write (125% of input price) tokens
- Files: `agentModeService.ts` (getBedrockClient, convertToBedrockConverse, estimateCost)

**2. Aggressive Tool Result Summarization**
- Old tool results (beyond most recent 3) now compressed to ~200-char previews: `[Tool: tool_name — preview...]`
- Previously these were truncated to 8KB each — with 50+ tool results that's still 400KB of context
- New approach reduces old tool context by ~97% while preserving tool name and a content hint
- Files: `agentModeService.ts` (trimToolMessagesForContext)

### Estimated Savings
- Prompt caching: 30-50% on Claude model sessions (system prompt + conversation prefix cached)
- Tool summarization: 20-40% additional reduction on long sessions with many tool calls
- Combined: 50-70% cost reduction expected on typical sessions

### Future Optimization Opportunities
- Context window summarization (compress old turns into a recap instead of dropping them)
- Dynamic tool filtering (only send relevant tools based on conversation context)
- Scheduled session reset (start each run with summary of prior run instead of full history)
- See "Conversation Summarization Design" section above for the summarization design

## Known Limitation: `get_chat_history` Tool Crashes on Large Time Ranges (2026-03-27)

The `get_chat_history` admin tool (used by Emma to analyze usage) crashes when querying large time ranges (e.g. 7 days). Root cause:

1. `chatbotService.getRecentSessionsPage()` with a time range does an **unbounded fetch-all-then-slice** — a `do...while` loop paginates through ALL DynamoDB pages before applying `limit` as a post-fetch `Array.slice()`. For 7 days, this fetches ~1,100+ session records into memory.
2. The admin route (`GET /api/admin/chat-sessions`) then calls `getChatSession()` for each returned session (up to 100) via `Promise.all`, loading full message content — 100 parallel DynamoDB queries.
3. The full response (100 sessions with all messages) is returned as a tool result to the LLM, which can exceed context/memory limits and crash the agent mid-stream.

**Impact:** Session `1e5af232-1164-46cb-bce5-83d76edd6734` crashed when the user asked Emma to "fetch the chat history of last 7 days, then count the total usage and cost per accounts."

**Potential fixes (not yet implemented):**
- Push `Limit` into the DynamoDB query (early termination) instead of fetch-all-then-slice
- Add a `metadata_only` mode to skip loading full messages when only counts/costs are needed
- The tool's `limit` param defaults to 100, but the DynamoDB fetch still retrieves all 1,100+ sessions before slicing

## Usage & Cost Analysis — Week of March 21–27, 2026

### Summary

| Metric | Value |
|--------|-------|
| Total sessions | 987 |
| Sessions with cost tracking | 305 (31%) |
| Sessions without cost tracking | 682 (69%) |
| Total tracked cost | $1,414.14 |
| Projected monthly cost (×4.3) | ~$6,081 |
| Avg cost/session (tracked) | $4.64 |
| Median cost/session | $0.57 |
| Unique users | 62 |

**Note:** 69% of sessions have no cost data. These are likely sessions that either (a) errored out before any LLM call, (b) used models where cost tracking wasn't implemented, or (c) are predefined-work-plan previews from anonymous users that didn't complete.

### By Subscription Tier

| Tier | Users | Sessions | Cost | Avg/User (7d) | Avg/Session |
|------|------:|---------:|-----:|---------------:|------------:|
| Super Premium | 17 | 693 | $1,138.78 | $66.99 | $1.64 |
| Advanced | 4 | 47 | $131.21 | $32.80 | $2.79 |
| Free / Anonymous | 40 | 210 | $138.34 | $3.46 | $0.66 |
| Basic | 1 | 37 | $5.80 | $5.80 | $0.16 |

Super Premium users drive **80.5%** of total cost ($1,139 of $1,414). Advanced users are the most expensive per-session ($2.79 avg) — they tend toward complex research workflows. Free/anonymous users are mostly work-plan previews (single-session anonymous users) plus a few registered Free accounts.

### Cost Distribution (305 tracked sessions)

| Percentile | Cost |
|-----------|-----:|
| Min | $0.01 |
| P25 | $0.17 |
| Median | $0.57 |
| P75 | $3.32 |
| P90 | $11.05 |
| P95 | $23.25 |
| P99 | $56.25 |
| Max | $106.76 |

The distribution is heavily right-skewed: 75% of sessions cost under $3.32, but the top 5% cost $23+ each and drive a disproportionate share of total spend.

### Top Accounts by Cost (7 days)

| Account | Tier | Sessions | Cost | Avg/Sess | Primary Activity |
|---------|------|----------|------|----------|-----------------|
| renata@your360.ai | Super Premium | 112 | $324.64 | $2.90 | Regular chats, some scheduled |
| founders@agentweb.pro (internal) | Super Premium | 199 | $215.30 | $1.08 | Regular + 50 scheduled + testing |
| amrutha@structuredlabs.com | Super Premium | 36 | $204.38 | $5.68 | Regular chats (high complexity) |
| agentwebintegration@xcures.com | Super Premium | 70 | $156.07 | $2.23 | Scheduled + regular |
| juan@usehaven.ai | Advanced | 8 | $92.72 | $11.59 | Complex regular sessions |
| dyllan@rankai.ai | Super Premium | 54 | $57.15 | $1.06 | Regular chats |
| harsha@agentweb.pro (internal) | Super Premium | 71 | $49.35 | $0.70 | Regular + scheduled + work plans |

**Key observation:** The top 5 external users (all Super Premium / Advanced) account for $834.96 (59% of total cost). Since these tiers are not yet billed, this is pure cost with no revenue offset.

### By Session Type

| Type | Sessions | Cost | Avg/Session |
|------|----------|------|------------|
| Regular (live chat) | 752 | $948.06 | $1.26 |
| Scheduled | 180 | $265.27 | $1.47 |
| Predefined work plan | 49 | $188.31 | $3.84 |
| Result endpoint | 1 | $11.95 | $11.95 |
| Video/image gen | 5 | $0.56 | $0.11 |

Predefined work plans cost ~3× more per session than regular chats — they involve multi-step workflows with many tool calls.

### Daily Trend

| Date | Sessions | Cost |
|------|----------|------|
| Mar 21 | 60 | $132.04 |
| Mar 22 | 67 | $102.67 |
| Mar 23 | 82 | $208.82 |
| Mar 24 | 85 | $427.74 |
| Mar 25 | 213 | $92.86 |
| Mar 26 | 317 | $322.91 |
| Mar 27 | 163 | $127.09 |

Session volume is growing (~3× from Mar 21 to Mar 26). Mar 24 was the most expensive day ($427.74) despite having fewer sessions — likely driven by a few high-cost complex sessions. Mar 25 had the most sessions (213) but lowest cost ($92.86), likely due to prompt caching optimizations deployed that day.

### Top 10 Most Expensive Individual Sessions

| Cost | User | Type | Title |
|------|------|------|-------|
| $106.76 | renata@your360.ai | regular | Agent Mode Session |
| $78.05 | xcures.com | scheduled | Weekly Competitor News Researcher |
| $65.14 | renata@your360.ai | regular | Adding Videos to Landing Pages |
| $56.25 | dyllan@rankai.ai | regular | SEO/GEO/AEO Competitor Ad Scraping |
| $51.90 | amrutha@structuredlabs.com | regular | Waldium Hero Banner CSS Analysis |
| $51.35 | juan@usehaven.ai | regular | Competitor Meta Ads Analysis |
| $46.76 | renata@your360.ai | regular | Meta Campaign Overview |
| $43.45 | amrutha@structuredlabs.com | regular | Landing Page Hero Banner Redesign |
| $42.59 | amrutha@structuredlabs.com | regular | Waldium Hero Banner CSS Analysis |
| $37.36 | ruiwangwarm@gmail.com | regular | Ella's Book Sale Poster |

### Revised Token Limits (March 27, 2026)

Based on the usage data above and discussion, the revised token limits are:

| Tier | Current DB Value | Monthly Token Limit | Rationale |
|------|-----------------|--------------------:|-----------|
| **Free** | Free | **1M** | ~10–15 sessions. Enough to see value, caps within first week of active use |
| **Basic** | Basic | **20M** | ~130–200 sessions. Basic users are not yet active so current data is limited; 20M provides comfortable headroom for light-to-moderate daily use |
| **Pro** | Super Premium / Advanced | **100M** | ~650–1000 sessions. Covers most Pro users comfortably (avg Super Premium user projects to ~40-50M/month). Heavy users will approach the limit |
| **Enterprise** | Enterprise (new) | **500M** | Soft cap to prevent abuse. Effectively unlimited for any realistic usage pattern |

**Tier mapping (current DB `subscriptionType` → new tier names):**
- `Free` → Free
- `Basic` → Basic
- `Super Premium` / `Advanced` → Pro
- New: `Enterprise` (not yet in DB)

**How the top users fit under these limits:**

| Account | Current Tier | Monthly Cost (proj.) | Est. Monthly Tokens | Fits in? |
|---------|-------------|---------------------:|--------------------:|----------|
| renata@your360.ai | Super Premium → **Enterprise** | ~$1,396 | ~150–200M | Yes (Enterprise 500M) |
| founders@agentweb.pro (internal) | Super Premium → **Enterprise** | ~$926 | ~100–130M | Yes (Enterprise 500M) |
| amrutha@structuredlabs.com | Super Premium → Pro | ~$879 | ~100–120M | Tight — may hit 100M limit |
| agentwebintegration@xcures.com | Super Premium → Pro | ~$671 | ~80–90M | Yes, with room |
| juan@usehaven.ai | Advanced → Pro | ~$399 | ~50–60M | Yes |
| dyllan@rankai.ai | Super Premium → Pro | ~$246 | ~30–40M | Yes, comfortable |
| harsha@agentweb.pro (internal) | Super Premium → **Enterprise** | ~$49 | ~7M | Yes |

**Key decisions:**
- **renata@your360.ai** should be upgraded to Enterprise tier — her projected ~150–200M tokens/month exceeds the Pro 100M cap.
- **Internal accounts** (founders@, harsha@, ruiw@) should be Enterprise tier to avoid hitting limits during testing/development.
- **Basic users** are not currently active, so their usage data doesn't reflect real-world patterns. The 20M limit is set generously and can be adjusted once Basic users are onboarded and billing is active.
- **Model cost multipliers** (Opus = 7x, see March 20 proposal) are still recommended to protect margins on the Pro tier. Without multipliers, a Pro user running all-Opus sessions could consume $700+ in cost against a ~$499 price point.

**Margin analysis (post-caching, GPT-5 blended ~$2/1M effective):**

| Tier | Price | Limit | Max Cost to Us | Min Gross Margin |
|------|------:|------:|---------------:|-----------------:|
| Free | $0 | 1M | ~$2 | -$2 (acquisition) |
| Basic | $199 | 20M | ~$40 | ~$159 (80%) |
| Pro | $499 | 100M | ~$200 | ~$299 (60%) |
| Enterprise | Custom ($1K+) | 500M | ~$1,000 | Negotiated |

Post-caching margins are healthy across all paid tiers. The risk is Opus-heavy Pro users (effective cost ~$14/1M with caching) — at 100M tokens that's $1,400, well above the $499 price. Model multipliers or tier-restricted model access would mitigate this.

### Prompt Caching Impact (Mar 25 deployment)

The prompt caching optimization was deployed on Mar 25. Comparing per-session costs:
- Pre-caching (Mar 21–24, 294 sessions): $870.27 → $2.96/session avg
- Post-caching (Mar 25–27, 693 sessions): $542.86 → $0.78/session avg

**~74% reduction in avg cost per session.** Even accounting for session mix variation, caching is clearly delivering significant savings. The projected monthly cost of $6,081 already reflects the post-caching rates; without caching it would have been ~$16K+/month

## Meta Ad Spending Limit Investigation (2026-04-08)

### Context

Investigated options for controlling Meta ad spend to prevent overspending when the agent creates/modifies ad campaigns on behalf of users.

### Current State

- **Budget guardrails exist in `agentModeService.ts`** (hardcoded): daily budget max $5,000, lifetime max $50,000 per ad set
- **No user-configurable spending cap** — limits are hardcoded safety rails only
- Meta ad account config stored in `AW-Users` → `connected_accounts[]` (no spending cap field)
- Primary spend control is currently via Ramp virtual credit card with a hard limit set per card

### Options Evaluated

**Option A: App-level advisory cap per connected account**
- Store a `spendingCap` field in DynamoDB alongside each Meta ad account config
- Before creating/updating ad sets, query Meta Insights API for current month spend
- Reject if projected spend would exceed cap; show spend vs cap in Settings UI
- Pros: User-configurable, visible in UI, works alongside card limit
- Cons: Relies on Meta's reported spend (slight lag), doesn't hard-stop if Meta overbills

**Option B: Meta's native Account Spending Limit (ASL)**
- Meta's Marketing API supports `spend_cap` on the ad account (`/act_{id}?fields=spend_cap`)
- Surface this in Settings so users can set/update it via our UI
- Meta natively enforces it — pauses all ads when limit is hit
- Pros: Hard stop enforced by Meta, no lag, most reliable
- Cons: Requires manual reset after billing cycle, another API call surface

**Option C: Combined A + B**
- App-level soft cap (advisory, warns before creating) + Meta-level hard cap (ultimate backstop)

**Option D: Per-session budget envelope**
- User sets a max spend for the current agent session; agent tracks total allocated across ad sets
- Pros: Very simple, no schema changes, no Meta API calls
- Cons: Doesn't account for existing scheduled spend, resets each session

### Decision

**Continue using Ramp virtual card approach for now.** Each Meta ad account is funded via a Ramp virtual credit card with a hard spending limit configured on the card. This provides a reliable, externally-enforced hard stop without any additional code complexity. Revisit in-app controls (Option A or B) if:
- We manage ad accounts for customers where card-per-account isn't practical
- Users request the ability to self-configure limits without admin intervention

## Meta Marketing API Version Upgrade to v24.0 (2026-04-14)

Meta notified that all Marketing API versions prior to v24.0 will be deprecated on June 9, 2026 (v23.0 and below). Updated `META_API_VERSION` to `v24.0` in both staging and production Elastic Beanstalk environment configs.

**Code changes (on branch `rui/upgrade-meta-api-version`):** All hardcoded `v18.0` fallback defaults in source code will be updated to `v24.0` to match the env var. Affected files:
- `backend/src/routes/meta.ts` (3 locations)
- `backend/src/services/agentModeService.ts` (2 locations)
- `backend/src/services/clientHealthService.ts` (1 location)
- `backend/src/services/metaService.ts` (3 locations)
- Test files: `metaAuth.test.ts`, `instagramService.test.ts`, `agentModeService.metaMetrics.test.ts`, `agentModeService.listMetaAdsCampaigns.test.ts`

**Note:** `backend/src/config/integrations.ts` was already at `v24.0`. No customer-portal changes needed.

## Email Verification on Sign-Up — Decision to Postpone (2026-04-16)

### Context

Investigated and implemented email verification for email/password sign-ups (Option B — soft verification with a warning banner, no access gates). The implementation is complete and tested on branch `rui/support-email-verification-in-sign-up`.

### Decision: Postpone

**We are not shipping this now.** The team introduction email already serves a partial verification purpose — every new sign-up receives a personal email from the founders, which organically surfaces invalid/throwaway addresses. Adding a second verification email on top of that would create unnecessary friction for new users at a point where conversion matters most.

**The code is parked on the branch and can be picked up later if needed.** Revisit if:
- Spam/fake account volume becomes a real problem
- A compliance requirement demands explicit email confirmation
- The team introduction email flow changes or is removed

## CRM Enrichment Cost Investigation (2026-04-16)

### Context

Investigated the API cost structure for the lead enrichment feature (`crmEnrichmentService.ts`) to understand per-lead spend across web search, LLM extraction, and LinkedIn lookup.

### APIs and Cost per Lead

| Component | Provider | Calls/Lead | Est. Cost/Lead |
|-----------|----------|-----------|----------------|
| Web Search | Google Custom Search | 1–2 (fallback on empty) | ~$0.005–0.01 |
| LLM Extraction | Gemini 3.1 Flash Lite | 1–2 (retry on parse fail) | ~$0.00015 |
| LinkedIn Lookup | Unipile | 0–3 (if LinkedIn source enabled) | ~$0.03–0.15 |
| **Total** | | **2–7** | **~$0.005–0.16/lead** |

### Key Findings

- **Web search only:** ~$0.005–0.01/lead (dominant cost without LinkedIn)
- **With LinkedIn:** ~$0.04–0.16/lead (Unipile per-profile cost dominates)
- **LLM cost is negligible** (~$0.00015/lead) given Gemini Flash Lite pricing
- Concurrency: 20 parallel workers (no LinkedIn) or 5 (with LinkedIn) — peak burst can hit Google Custom Search quotas (known issue from Feb 2026)
- **No cost tracking or metering exists** for enrichment operations; usage is not counted against user token quotas

### Model Change (2026-04-16)

Switched `SUGGEST_MODEL` from `gemini-2.5-pro` to `gemini-3.1-flash-lite-preview` to match `ENRICH_MODEL`. Field suggestion is a structured extraction task (not complex reasoning), so the cheaper/faster model is sufficient.

### Cost Tracking Decision

**Delaying cost tracking for enrichment until the feature is used more widely.** Current usage volume does not justify the instrumentation overhead. When enrichment adoption grows, add per-enrichment token/API call accounting to `tokenUsageService.ts` and meter it against user subscription allowances. Revisit when:
- Enrichment is a standard part of multiple users' workflows
- Monthly enrichment API cost becomes visible in billing analysis
- Subscription tiers need to differentiate on enrichment volume

## Work Plan Parallel Step Execution — Investigation (2026-04-17)

### Context

Investigated whether work plan steps can be executed in parallel when they don't depend on each other.

### How Work Plans Execute Today

Work plans are **linear LLM-guided checklists**, not an execution engine. Steps are injected into the LLM's prompt context via `buildMarketingContext()` (`agentModeService.ts:2221`). The LLM reads the current pending step, does the work, calls `setWorkPlanStatus()` to mark it complete, then moves to the next. There is no dispatch loop — execution is driven by the single LLM conversation thread, one turn at a time.

`WorkPlanStep` has no dependency or grouping fields today (`stepCount`, `title`, `description`, `requiredFunctionCalls`, `skillIds`).

### Why True Step-Level Parallelism Is Not Well Supported

An Agent Mode session is a **single LLM conversation thread**: one LLM turn at a time, tools execute, then the next turn starts. Parallelizing multi-turn steps (steps that require multiple rounds of tool calls and LLM reasoning) would require each step to run its own independent LLM loop. The only mechanism for that is sub-agents (via the swarm infrastructure, `backend/src/services/swarm/`), but sub-agents have isolated contexts — they can't share session state mid-execution — and add significant spawn overhead. This makes step-level parallelism via sub-agents architecturally complex with limited practical benefit for the typical plan.

### Existing Parallelism: Tool Calls

**Claude already supports parallel tool calls within a single LLM turn.** When the LLM issues multiple tool calls in one response, they execute concurrently. This is the natural and well-supported parallelism primitive in Agent Mode.

### Decision

**We will not add a parallel step execution mechanism.** Instead, steps that could logically run in parallel should be **merged into a single step** with a description that instructs the LLM to accomplish both objectives. The LLM will naturally fire the required tool calls in parallel within that one step's turn, achieving the same concurrency without any infrastructure changes.

This keeps the work plan model simple (linear checklist) and leverages parallelism that already works reliably. Revisit if a future use case genuinely requires independent multi-turn parallel workstreams — at that point, sub-agent orchestration would be the right path.

## LinkedIn Outreach — Email Finding Investigation (2026-04-16)

### Context

Investigated whether the LinkedIn outreach feature can be used to find or retrieve email addresses for prospects.

### Findings

**LinkedIn does not expose email addresses via its API.** The Unipile SDK (used by `linkedInOutreachService.ts`) returns the following fields for a LinkedIn profile: `provider_id`, `public_identifier`, `first_name`, `last_name`, `headline`, `location`, `network_distance`, `is_open_profile`, `work_experience`, `summary`, `profile_picture_url`. Email is not among them — this is a deliberate LinkedIn platform restriction, not a gap in the Unipile integration.

All 10 LinkedIn outreach actions (`search-people`, `get-profile`, `send-invite`, `send-message`, `update-conversation-history`, etc.) operate on profile URLs and provider IDs only. The CRM lead record stores the LinkedIn profile URL in the `linkedin` field but no email derived from it.

### Decision

**Finding email from LinkedIn is not supported and will not be added to the LinkedIn outreach feature.** Email discovery is an enrichment concern, not an outreach concern. If email finding from a LinkedIn profile is needed, it should be implemented as part of the CRM enrichment feature (`crmEnrichmentService.ts`) using a third-party enrichment provider (e.g. Apollo.io, which accepts LinkedIn profile URLs and returns verified business emails). This keeps outreach and enrichment concerns cleanly separated.


## Goalden Hour Meta Ad Account — Ownership Investigation (2026-04-20)

### Context

Investigated who owns the Goalden Hour ad account in Meta (Facebook) Business Manager, and what steps are needed to transfer or grant access.

### Findings

The Goalden Hour Meta ad account is currently **owned by individual people**, not by a Business Manager. Only the AgentWeb team has full (Admin) control at this time.

### Short-Term Action: Grant Goalden Hour Admin Access

To give the Goalden Hour team full operational control without transferring ownership:

1. Go to [business.facebook.com](https://business.facebook.com) → **Business Settings**
2. Click **Accounts** → **Ad Accounts** → select the Goalden Hour ad account
3. Click **Add People** → search for the Goalden Hour contact by name or email
4. Set their role to **Admin** (full control: manage people, billing, settings, run ads)
5. Click **Confirm**

This gives them full operational access while ownership stays with the current individual.

### Future Action: Transfer Ownership to Business Manager

When ready to transfer formal ownership to the Goalden Hour Business Manager:

1. The current individual owner must be cooperative
2. **Option A (preferred):** In Meta Business Manager → Business Settings → Ad Accounts → Add → **Claim an Ad Account** → enter the account ID. The individual owner approves the claim.
3. **Option B:** The individual goes to their Ad Account Settings → Ad Account Roles → adds the Goalden Hour Business Manager as Admin, then initiates a transfer.
4. **Option C (last resort):** Contact Meta Support with proof of business ownership if the individual is unreachable.

> **Caveat:** Once an ad account is claimed by a Business Manager, it cannot be moved to another Business. Confirm the correct Business Manager before claiming.

### Decision

**Short term:** Grant the Goalden Hour contact Admin access so they have full operational control immediately. **Long term:** Initiate a formal ownership transfer/claim into their Business Manager when they are ready to do so.

## Security Breach Investigation — Lovable & Vercel (2026-04-21)

### Context

Investigated whether AgentWeb is impacted by two security incidents:
1. **Lovable security breach** — Lovable (vibe coding platform) disclosed a broken object-level authorization flaw in their API that allowed unauthorized access to user projects, source code, database credentials, and AI chat histories. The vulnerability was unpatched for 48 days after discovery on March 3, 2026.
2. **Vercel security breach** — Vercel disclosed a security incident. Vercel sent official email communication confirming: *"At this time, we do not have reason to believe that your Vercel credentials or personal data have been compromised."* **Status: Safe, no action required.**

### Lovable Exposure Analysis

The customer-portal repo originated as a Lovable project and remains connected to it. Artifacts found:

**1. External CDN script in `index.html:70`**
```html
<script src="https://cdn.gpteng.co/gptengineer.js" type="module"></script>
```
Loaded on every page, runs with full browser context. If Lovable's infrastructure is compromised this is a vector for client-side code execution. **Highest priority to remove.**

**2. `lovable-tagger` npm package (`package.json:112`, `vite.config.ts:4,38`)**
Sends component metadata to Lovable during dev builds. Not evidence of npm compromise, but is telemetry going to a breached vendor. Remove as hygiene.

**3. Fallback URL in `src/config.ts:9`** pointing to `https://preview--agentweb-customer-portal.lovable.app` — cosmetic, but should be cleaned up.

**Key clarification:** The Lovable breach is a **platform data leak** (their API exposed stored project data), not a CDN/supply chain attack. The primary risk to us is: if any real credentials (API keys, env vars, secrets) were ever entered into the Lovable project editor, those may have been exfiltrated.

### Status & Next Steps

- **Vercel:** Confirmed safe per official Vercel email. No action required.
- **Lovable:** Awaiting Lovable's official email notification to determine whether our specific project was accessed during the breach. Once received, assess whether any credentials need rotation.
- **Code cleanup (planned):** Remove CDN script, lovable-tagger, and Lovable URL fallback from customer-portal regardless of breach outcome — these are unnecessary Lovable dependencies.

## Meta Account Connection Failure — karthy@goaldenhour.com (2026-04-20)

### Context

karthy@goaldenhour.com (userId: `4027bc5c-0f89-4236-b63e-b0186c634a1c`) reported that connecting their Meta ad account failed.

### Root Cause

Production logs at `Apr 19 00:55:35` showed:

```
[Meta Finalize] getAdAccounts failed — code=n/a classification=n/a
message=Meta API Error: (#200) Requires business_management permission to manage the object
```

The OAuth flow (`flow=marketing`) exchanges the code and gets a valid access token, but the subsequent `/me/adaccounts` API call requires the `business_management` permission. Our current `marketingScopes` in `backend/src/config/integrations.ts` only requests `ads_management`, `ads_read`, and `pages_show_list`. The error is silently caught (`metaAuth.ts:248`) and returns 0 ad accounts, leaving the user unable to connect.

### Why `business_management` Was Not Added

Adding `business_management` to `marketingScopes` would fix the API error, but Meta only allows this permission under **Advanced Access** for customer-facing apps. Standard Access (which we currently have, status Active with 561 users) restricts the permission to users who have a developer/admin/tester role on the Facebook App — it does not work for general customers. Obtaining Advanced Access requires a Meta App Review with a detailed use-case submission and is slow/difficult to get. Decision made after discussion with Harshit@Argusoft.

### Short-Term Fix (Implemented)

The Goaldenhour ad account is now under our (AgentWeb's) control. **We granted karthy@goaldenhour.com full access to the ad account directly through Facebook Business Manager.** This means their user token already has access to the account without needing `business_management` — they can connect successfully today.

### Long-Term Fix

Pursue **transfer of ownership** of the Goaldenhour ad account to Goaldenhour itself via Facebook Business Manager. Once Goaldenhour owns the account, karthy (as an admin of that business) will be able to grant `ads_management` and `ads_read` access through normal OAuth without needing `business_management`. No code changes required for this path either.

## Google OAuth App Review — Gmail Connected Accounts (2026-04-24)

### Status

**App review submitted / in progress.** Review typically takes 4–6 weeks for restricted scopes.

### Google Cloud Project

- **Project Name:** AgentWeb
- **Project ID:** `gen-lang-client-0725723168`
- **Project Number:** `606140610214`
- **OAuth Client ID:** `606140610214-tqm4fkgp6o7m4e5aq4n13n09ijqfhaij.apps.googleusercontent.com`
- **Credentials stored in:** AWS Secrets Manager at `prod/AgentWeb/Google/Gmail`

### Scopes Under Review

| Scope | Classification | Purpose |
|---|---|---|
| `https://www.googleapis.com/auth/gmail.readonly` | **Restricted** | Read user's Gmail inbox for AI-assisted email management |
| `https://www.googleapis.com/auth/gmail.send` | **Restricted** | Send emails on the user's behalf in AI outreach workflows |
| `https://www.googleapis.com/auth/calendar.readonly` | **Sensitive** | Read calendar to avoid scheduling conflicts |

`userinfo.email` and `userinfo.profile` are non-sensitive and do not require review.

### How to Submit / Re-Submit

1. Go to [Google Cloud Console](https://console.cloud.google.com) → project **AgentWeb** (`gen-lang-client-0725723168`)
2. Navigate to **APIs & Services → OAuth consent screen**
3. Ensure app name, support email, homepage (`https://app.agentweb.pro`), privacy policy, and ToS URLs are filled in
4. Click **"Submit for Verification"**
5. Provide scope justifications:
   - **`gmail.readonly`**: Read inbox to surface relevant emails in the AgentWeb AI assistant for outreach management
   - **`gmail.send`**: Send emails on behalf of users as part of AI-assisted outreach workflows (user reviews before sending)
   - **`calendar.readonly`**: Read calendar to help schedule meetings and avoid conflicts
6. Record a **demo video** (required for restricted scopes): show the OAuth flow and how each scope is used in the UI
7. Submit. Review takes **4–6 weeks** for restricted scopes.

### Notes

- While pending review, only users listed under **Test users** on the consent screen can authorize the Gmail connection
- The privacy policy must explicitly state Gmail data is not shared or sold
- Redirect URI registered in the OAuth client: `https://api.agentweb.pro/api/oauth/gmail/callback`
- YouTube connected accounts reuse the same Google Cloud project and OAuth client (`prod/AgentWeb/Google/Gmail`)

## Emma Self-Improvement — Investigation (2026-04-25)

### Context

Investigated how to get Emma to self-improve over time, inspired by agent self-improvement patterns like Reflexion.

### What Already Exists

The memory system (`AW-AccountMemory`) already covers the core use case:

- Categories: `preference`, `history`, `insight`, `workflow`
- Emma tools: `save_memory` (save a fact mid-session), `delete_memory` (remove by ID)
- Full CRUD API at `/api/memory` for user management
- All active memories are injected into every new session's system prompt (up to 20, most recent)

Emma already self-improves incrementally **within** a session: she can detect corrections or "remember that…" instructions and save them immediately via `save_memory`. Users can manage their memories via the customer portal settings UI.

### Gap Considered: Post-Session Auto-Extraction

The one missing piece is a post-session job that sends the full conversation transcript to an LLM and asks it to extract net-new learnings, then writes them to `AW-AccountMemory` automatically.

### Why We're Not Building It Now

Post-session auto-extraction risks being **overly aggressive**: the LLM may extract low-quality, redundant, or incorrect facts from routine exchanges (e.g., "user asked about SEO" → saves "user is interested in SEO" every session). This would pollute the memory store with noise and degrade Emma's quality over time rather than improving it.

The existing in-session `save_memory` mechanism is more precise because it only fires when there is a clear signal (explicit user instruction or detected correction). Auto-extraction has no such signal — it runs on every session regardless of whether anything new was learned.

### Decision

No action. The current memory system is sufficient. Revisit post-session extraction if we add a quality-scoring or deduplication layer that can filter out noise before writing.

## Thunderbird Connected Account — Investigation (2026-04-27)

### Context

Investigated whether Thunderbird.net could be supported as a connected account (similar to Gmail, LinkedIn, etc.).

### What Thunderbird Actually Is

**Thunderbird is a local desktop email client, not a platform.** There is no "Thunderbird account" to OAuth into, no REST API, and no webhooks. It is analogous to Outlook the desktop app, not Outlook.com. The mail data lives on whatever IMAP/SMTP server the user configured (Gmail, Yahoo, a custom domain, etc.) — Thunderbird is just the local interface to it.

Mozilla launched **Thundermail** (tb.pro, 2024) as a paid cloud email hosting service, but it is a standard IMAP/SMTP provider with no published developer API or OAuth flow.

### Why Thunderbird as a Connected Account Is Not Practical

- No OAuth authorization server exists — there is nothing to redirect users to
- No REST API — no way for our backend to read or send email via Thunderbird
- No webhooks or event system accessible outside the local process
- The only programmatic access to Thunderbird is via a WebExtension Add-on running *inside* the local Thunderbird process — a fundamentally different architecture that requires users to install an extension and only works while Thunderbird is open on their machine

### What We Can Support Instead

The email accounts that Thunderbird users configure are standard providers that we can already support or could support through existing mechanisms:

- **Gmail accounts** — already fully supported as a connected account via Gmail OAuth
- **Outlook / Microsoft 365** — could be added via Microsoft OAuth (same pattern as Gmail)
- **Thundermail and other IMAP providers** — could be added as a generic IMAP/SMTP connected account using credential-based auth (not OAuth)

### Decision

Do not build a Thunderbird-specific connected account — it is not architecturally feasible without requiring users to install a local extension. Instead, direct Thunderbird users to connect the underlying email account they use in Thunderbird (e.g., Gmail via the existing Gmail connected account flow).

## AI Eval Work Plan Duration — Investigation (2026-04-30)

### Context

Investigated a predefined-work-plan session (`AI_GTM_Position_Eval`, session `85aabd21`) that appeared to be still running after several minutes.

### Findings

**The session completed successfully — no stall or bug.** Timeline:

- `06:31:49` — Session created, user sent their URL
- `06:38:16` — Work plan step completed (~6.5 minutes of actual work)
- `06:38:27` — Session record updated in DynamoDB
- `06:44:48` — Satisfaction score evaluated (triggered ~6 min later by admin `GET /api/admin/chat-sessions?sync=true` poll)

The 6.5 minutes was real work by the "AI GTM Positioning Audit" skill:
- 3× `read_page_source` calls (scraping homepage and blog)
- 2× legacy web search calls (one failed and retried)
- 1× `create_html_file` generating a full HTML audit report
- 1× `save_file` to S3
- 24,650 completion tokens of output (Sonnet 4.6 model)

### Backend Architecture Notes

- **Work plan step completion** is driven by `set_work_plan_status` tool, which validates `requiredFunctionCalls` counts before marking a step done.
- **No artificial delays** exist in the work plan execution path — no polling loops, sleep, or retries beyond per-tool exponential backoff on transient errors.
- **`install_skills` counted as 0** because the skill was auto-installed at session creation (`createSessionWithPlan` installs all associated skills upfront); the tool never needs to be called explicitly.
- **Satisfaction scoring is not automatic** — it only triggers when an admin hits `GET /api/admin/chat-sessions?sync=true` (batch) or `POST /api/admin/chat-sessions/score`. The 6-minute post-completion gap was the admin dashboard sync polling interval.

### Frontend Completion Detection

The customer portal detects completion via SSE `complete` event → 800ms `setTimeout` → `GET /api/agent-mode/session/{sessionId}` refresh. UI shows completion as soon as work plan steps are `status: 'completed'`, independent of `satisfactionScore`. If the session appeared "still running" after `06:38`, that likely reflects a stale tab or the share link being opened before the SSE event was received.

### Decision

No action required. The execution time is expected given the volume of tool calls and token output. If we want to reduce perceived latency, options are: (a) use a faster model (Haiku 4.5) for the audit, or (b) stream intermediate progress messages to the UI as each tool call completes.

## LinkedIn Outreach Rate Limits — Investigation (2026-05-04)

### Context

Session `998e3e33` ("Scheduled: Rui - Daily LinkedIn Connection Outreach") scored 2/5. The agent attempted a high volume of outreach actions, hit LinkedIn's "Cannot resend yet" / `errors/already_invited_recently` rate limit, and kept retrying rather than stopping. The execution log showed a large number of repeated failed `send-invite` tool calls, and the agent claimed to have "bypassed the safety limit" — suggesting it did not recognize the errors as hard stop signals.

The next day's scheduled run succeeded without issue, confirming LinkedIn's cooldown window had elapsed and there is no persistent issue in the schedule itself.

### Root Cause

The `errors/already_invited_recently` error from Unipile (HTTP 422) is **not caught specifically** in production code. It falls through to the generic `handleError()` in `linkedInOutreachService.ts` (lines 38–50), which classifies it as a generic `VALIDATION_ERROR` (same bucket as malformed input). The agent mode handler (`agentModeService.ts` ~line 20709) only special-cases `AUTH_ERROR` and disconnected account errors — it has no awareness that a `VALIDATION_ERROR` here means "rate limited, stop sending invites for now."

As a result, the agent received repeated "validation error" responses, did not interpret them as a stop signal, and looped.

### Code Gaps Found

| Gap | File | Lines |
|-----|------|-------|
| `errors/already_invited_recently` not caught — classified as generic `VALIDATION_ERROR` | `linkedInOutreachService.ts` | 38–50, 309–325 |
| No pre-flight check for pending invitations before `sendInvitation()` | `linkedInOutreachService.ts` | 331–355 |
| Agent mode handler only special-cases AUTH errors, not rate limit errors | `agentModeService.ts` | ~20709–20735 |

A test at `backend/src/__tests__/linkedInOutreachService.test.ts:163–178` covers the scenario and shows the correct Unipile error shape, but the corresponding production catch does not exist.

### Decision

No action yet. The schedule recovered on its own the next day. We will wait until this recurs before implementing fixes. If it does recur, the fix is:
1. Detect `errors/already_invited_recently` specifically in `handleError()` and return a distinct `RATE_LIMIT_ERROR` type (separate from generic `VALIDATION_ERROR`)
2. Surface a clear "rate limited — stop sending invitations" signal to the agent in the `send-invite` tool response
3. Optionally add a pending-invite pre-flight check in `sendInvitation()` before calling Unipile

## Quality Agent Tool for Emma — Design Decision (2026-05-04)

### Context

Explored adding a dedicated `assess_quality` tool that Emma could call after generating content (LinkedIn posts, blog articles, ad images, etc.) to score and justify the quality of her output. The existing `sessionScoringService.ts` already scores sessions on a 1–5 scale across three dimensions (goalCompletion, dataAccuracy, outputQuality) but operates at session level and is admin-only.

### Options Considered

1. **New `assess_quality` Emma tool** — standalone tool with per-content-type rubrics, called proactively or on-demand after content creation.
2. **Quality built into creation tools** — modify `create_social_media_posts`, `create_blog_article`, etc. to return a quality object alongside the content.
3. **Expose session scoring to Emma** — extend `scoreSessionIfNeeded` to extract and score individual artifacts from conversation history.

### Decision

**Defer all three options.** Chosen approach instead: add a Content Quality Standard section to Emma's system prompt (`agentModeSystemPrompt.ts`) instructing her to draw on brand/ICP context before generating content and briefly justify quality choices inline after generation. This is simpler, zero-latency, and directly addresses the root cause (generic/slop output) without added tooling complexity.

The quality agent tool approach was set aside for the following reasons:
- **UX impact**: Every content creation call would incur an additional LLM round-trip (~2–3s), visibly slowing Emma's responses.
- **Complexity**: Per-content-type rubrics require ongoing maintenance; scoring prompts would drift from actual quality criteria over time.
- **Diminishing returns**: The session scorer already captures output quality as a dimension. A separate per-artifact scorer adds infra without clear signal advantage until we have evidence the prompt-level fix is insufficient.

### Future Consideration

Revisit if prompt-level instruction proves insufficient — i.e., Emma continues producing generic content despite the quality standard directive. At that point, Option 1 (standalone `assess_quality` tool with content-type-specific rubrics) is the recommended starting point.

## Emma in Internal Slack Channels — Investigation (2026-05-08)

### Context

Investigated how to enable Emma to respond meaningfully when team members @mention her in AgentWeb's internal Slack workspace. The goal: a platform-wide Emma that can answer engineering and product questions in internal channels, not just serve customer accounts.

### The Core Tension

Emma's context pipeline is account-scoped. Every response call flows through:
1. `generateChatResponse()` (`chatbotService.ts:3610`) — requires a `userId` to anchor context
2. `searchPlatformKnowledgeBase(userId)` — queries Vertex AI Discovery Engine indexed per user
3. Per-session tool sets injected based on the current page URL and user account configs

In internal Slack channels there is no customer `userId` to anchor on. Calling Emma without this identity produces a context-starved response with no product knowledge, no KB results, and the wrong (customer-facing) system prompt tone.

### Existing Slack Infrastructure (Reusable)

The current `app_mention` event handler (`slack.ts:566`) already:
- Detects `@Emma` mentions and creates Agent Mode sessions
- Posts threaded replies via `handleSlackSessionResponse()`
- Maps threads to sessions (settings key: `slack_thread_{channel}_{ts}`)
- Has a Slack client instance and `postThinkingMessage()` / `postThreadResponse()` utilities

This plumbing is ~100% reusable. The work is in defining a new identity and context model for the internal context.

### Options Explored

**Option 1: Platform Admin Identity (Low effort)**
Designate a special internal identity (e.g. `emma-internal@agentweb.pro`). Route `app_mention` events from the internal workspace (`teamId` check) to this identity. Pre-populate its KB in Vertex AI with product docs, release notes, and runbooks. Emma's existing KB search pipeline works unchanged — just a different `userId`.

**Option 2: Dynamic Context Aggregation (Medium effort)**
Detect internal workspace via `teamId`, then compose context chunks before calling `generateChatResponse()`: recent PRs (`gh` API), deployment status, sprint tasks (Notion MCP), recent backend errors. Inject as structured context — same pattern Emma uses for page-aware tools.

**Option 3: Separate Internal System Prompt + Tool Set (Medium effort)**
Add `getInternalEmmaSystemContext()` alongside the existing `getEmmaSystemContext()`. Internal variant uses engineering-appropriate tone and exposes internal tools: `get_recent_prs`, `get_deployment_status`, `get_sprint_tasks`, `search_codebase_docs`. Add a parallel `handleInternalSlackSession()` path in the Slack event handler. Session storage and threading reused as-is.

**Option 4: Clarifying-Question Meta-Tool (High effort)**
Internal Emma gets a `clarify_context` tool. When context is insufficient, she asks a follow-up in the thread before answering. Combined with Option 3's tool set, she can answer "why is the LinkedIn connector failing?" by querying deployment logs, or ask "which user?" if she needs more info.

### Recommended Phased Approach

- **Phase 1 (Options 1 + 3):** Platform admin identity + internal system prompt. Gets Emma functional in internal channels with correct tone. ~1 day of work.
- **Phase 2 (Option 2):** Layer dynamic context: auto-inject release notes, recent PRs, sprint tasks. ~2 days.
- **Phase 3 (Option 4):** Clarifying questions + deeper tool integrations once pattern is proven. ~3 days.

### Decision

**Stick with the current account-scoped Emma implementation for now.** Internal Slack coverage is not a near-term priority. No changes planned in the immediate roadmap. Revisit when the team actively needs Emma to answer platform-level questions in Slack — at that point Phase 1 (admin identity + internal system prompt) is the recommended starting point given it reuses the most existing infrastructure.

---

## May 10, 2026: Lesson - CI Must Fail Cheaply When Tests Regress

### Incident

A customer portal PR had serious test-suite issues that exhausted GitHub Actions credits before the test job could finish. The suite had real failures, stale assertions, timer leakage, and a same-tab state synchronization loop, but the workflow allowed every run to consume the full job budget.

### Root Causes

- PR test workflow did not cancel older runs when newer commits were pushed.
- The test command did not fail fast, so one known failing area could leave the rest of the suite running.
- Vitest workers were too aggressive for a memory-heavy suite in CI.
- Fake timers leaked across files and caused unrelated tests to hang or time out later.
- A hook wrote localStorage, dispatched a same-tab event, re-read a fresh array, set state again, and repeated.
- Several tests were asserting obsolete UI output after the product had moved from raw JSON/debug text to humanized summaries.

### Guardrails To Apply

- Add PR workflow `concurrency` with `cancel-in-progress: true`.
- Run expensive suites with fail-fast behavior, for example `--bail=1`.
- Add a shell-level timeout shorter than the GitHub job timeout, so CI exits with useful logs before the platform kills the job.
- Keep CI worker counts conservative for large jsdom suites.
- Use fake timers only in tests that need them, and restore real timers in setup/cleanup.
- Treat stale tests as production risk when they hide real failures or force full-suite retries.
- Keep passing-test logs quiet enough that the first failure is obvious.

### Principle

Tests will occasionally fail or hang. CI must make that failure cheap, bounded, and easy to diagnose instead of letting a single regression consume the entire Actions budget.

## Emma "Forgot Brand" — Root Cause & Fix (2026-05-10)

### User Report

User `phoenixtech@agentweb.pro` (Phoenix Technologies) reported that Emma "forgot their brand" during a session (`a93853a9-923a-44bb-a176-6c6eaefbe587`). The user was asking Emma to generate Meta Image Ad Prompts. Emma replied asking *"What's the product or company these Meta image ads are for?"* — even though the user had a rich, fully-populated brand profile (Phoenix Technologies, Kevin Zhang, detailed tone of voice, key messages, etc.).

### Root Cause

Emma violated the system prompt rule at `agentModeSystemPrompt.ts:306`:

> "Before asking the user for business details... ALWAYS call `read_brand_guidelines` and `read_market_strategy` first."

The LLM skipped this rule and asked the user for context it already had access to via tools. This is a prompt-instruction compliance failure — the system prompt said what to do, but the model chose a clarifying-question flow instead.

Session transcript summary:
1. User: "Generate Meta Image Ad Prompts for ChatGPT Images 2.0"
2. Emma: "What's the product or company?" ← violated rule
3. User: "My brand!" (frustrated)
4. Emma: "Who is the target customer?" ← asked again
5. User: "Look at Market Strategy"
6. Emma: called `read_market_strategy`, then proceeded correctly

The brand data was present in DynamoDB (`AW-Users.brandGuidelines`) and would have been returned had Emma called `read_brand_guidelines` upfront.

### Fix Applied

Added `read_brand_guidelines` and `read_market_strategy` to the foundation tools list in the admin Agent Mode settings page. These tools were already in `DEFAULT_FOUNDATION_TOOLS` in `agentModeService.ts` (line 2817–2819) as the code-level fallback, but were not present in the DB-stored foundation tools config, which takes precedence over the default when set.

By ensuring these tools are present in the DB-configured foundation tools list, they are always available to Emma in every session — not just when the DB config falls back to defaults.

### Why This Helps (and Its Limits)

Guaranteeing tool availability prevents the "tool not available" failure mode, but does not prevent the LLM from choosing not to call the tool. The prompt instruction at line 306 remains the primary enforcement mechanism. If the "forgot brand" pattern recurs, the next step is **Option C** from the investigation: programmatic pre-flight injection of brand context into the context window at session start (same pattern as account memory injection at `agentModeService.ts:1635`), making brand context available without requiring any LLM tool call decision.

## Real Browser vs Headless for Emma (2026-05-12)

### Background

Emma uses `@playwright/mcp` as its browser automation tool, configured via the MCP Servers tab in the admin panel. The question was whether Emma could be switched to use a real (non-headless) Chrome instead of headless Playwright.

### How Playwright MCP is Launched

When the backend spawns a Playwright MCP stdio server, `mcpClientService.ts` (`createStdioTransport`, ~line 787) auto-detects the `@playwright/mcp` package and unconditionally injects `--headless`, `--no-sandbox`, and `--isolated` flags — even if the admin-panel config doesn't include them. The injection guard is:

```typescript
if (!resolvedArgs.includes('--headless')) {
  resolvedArgs.push('--headless');
}
```

So removing `--headless` from the MCP server config in the admin panel has no effect — the code re-adds it.

### Why Truly Headed Chrome Is Not Feasible on EB

The backend runs on AWS Elastic Beanstalk with no display server. A headed Chrome requires a real or virtual display (X11/Xvfb). Even with Xvfb it is still a virtual framebuffer, not a real browser, and adds significant operational complexity to the EB platform config.

### Bot Detection Mitigation Already in Place

The code already injects an extensive stealth script into every Playwright MCP session via a config file (`/tmp/playwright-mcp-configs/{key}.json`). It patches `navigator.webdriver`, `userAgentData`, `navigator.plugins`, `screen.colorDepth`, `document.visibilityState`, `IntersectionObserver`, and more. For most sites this is sufficient to avoid headless detection without needing a real browser.

### Using a Real Browser via the Local Agent

For use cases that genuinely need a real browser — particularly **testing or scraping public sites where no login is required** — the `run_local_agent_task` tool is the right path. This tool runs a task through the local agent relay (`local-agent-relay/`), which launches Playwright with `headless=False` against the user's local Chrome profile (`~/.codex-relay/chrome-profile`). Because the local agent runs on the user's machine, it has access to a real display and a persistent browser profile.

Relevant code: `local-agent-relay/src/codex_relay/browser.py`, `load_page_with_playwright()` at line 76 (`headless=False` by default, persistent profile via `profile_dir`).

**When to use `run_local_agent_task` vs Playwright MCP:**
- Public sites, no auth needed, real browser fidelity required → `run_local_agent_task`
- Any site where the user's saved cookies/session matter → `run_local_agent_task`
- Most automation tasks, API calls, content generation → Playwright MCP (headless, faster, no local agent needed)

## Drip Sequence Email — SVG Logo Display Issues (2026-05-14)

### User Report

A user reported that sequence emails sent from `founders@agentweb.pro` had a bad logo display in their email client. Two separate rendering bugs were discovered:

1. **Superhuman:** The bird logo SVG rendered at enormous size (native `viewBox` dimensions, ~500px wide).
2. **Slashy:** The bird logo appeared completely white (invisible on a white background).

### Investigation

**Superhuman (oversized SVG):**
Superhuman is an Electron/Chromium webview app that sanitizes email HTML before rendering. Its sanitizer strips `style` attributes from `<svg>` elements as an XSS precaution, so `style="max-width:100%;width:100%"` and even native `width` attributes were being removed, leaving the SVG to render at its `viewBox` intrinsic size.

**Slashy (white logo):**
Decoding the raw email HTML revealed the logo `<img>` (converted from SVG) had `filter:brightness(0) invert(1)` in its style attribute. This filter inverts the image to white, which is intentional for display on the purple gradient email header. Slashy strips the header's background color while preserving the filter, making the white logo invisible against the white background.

### Status

**Superhuman:** We contacted Superhuman support to report the SVG sanitization behavior. **Awaiting their response.** No fix has been applied at our end for this issue. If Superhuman confirms this is by design (i.e., SVGs will always have styles stripped), the mitigation would be to convert SVGs to PNGs server-side before sending (already prototyped: `convertEmailSvgsToPng` in `emailVariables.ts` using `sharp` + content-addressed S3 keys — `email-svgs/<sha256>.png`).

**Slashy:** A server-side fix was applied: `removeInvertedImgFilters()` in `emailVariables.ts` strips `filter:brightness(0) invert(1)` from `<img>` style attributes before send. This ensures the logo renders in its original colors on all clients. Trade-off: on clients that correctly render the purple header (Gmail, Apple Mail), the logo now appears dark against the purple background rather than white — acceptable since it remains legible. The proper long-term fix is a white-variant logo asset that does not rely on CSS filters.

## Session Judge Scoring — Bug-Reported Sessions (2026-05-16)

### Background

Session satisfaction scores were being computed too low for sessions where the assistant hit a known platform bug. The judge LLM was seeing friction and failures without understanding that the issue had been formally escalated — so it scored the session as if the user's problem was simply unresolved.

### Signal: `report_product_issues` Tool Call

The reliable signal that a bug was reported is the presence of `report_product_issues` in the serialized transcript's `[called tools: ...]` line. This is more deterministic than trying to parse natural-language acknowledgments ("I've filed a bug", etc.).

### Fix

The scoring judge prompt was updated (both the hardcoded `DEFAULT_SCORING_SYSTEM_PROMPT` in `sessionScoringService.ts` and the live prompt managed via the admin Settings → Scoring Judges page) to include:

> **IMPORTANT: Bug reported during session:**
> - If the transcript contains `[called tools: report_product_issues]`, a bug was formally reported
> - Treat the problematic behavior as a known platform limitation, not an assistant failure
> - Score the overall session as satisfied (score ≥ 4) unless the user expressed strong dissatisfaction **after** the tool was called
> - Dimension scores (e.g. `outputQuality`) may still reflect pre-report friction

### Live Prompt State

The prompt was manually updated in both dev and prod via the admin Scoring Judges page. No migration or deploy is needed — the page writes directly to the `default-scoring-prompt` DynamoDB setting at runtime. Custom judges were also updated to match.

## Large Brand Guidelines Files — Google Drive Workaround (2026-05-28)

### Context

Vivian Health provided their brand guidelines as a ~135 MB zip file. Our upload infrastructure has a 100 MB hard cap (`MAX_FILE_SIZE` in `backend/src/config.ts`) and a 50 MB Express body-parser limit, so the file could not be uploaded directly.

### Solution

Rather than increasing upload limits or adding server-side zip extraction (which would significantly increase backend complexity and S3 storage costs for large binary archives), the simpler approach is to use Google Drive as the storage layer:

1. Create a Google Drive folder for the client's brand assets.
2. Upload the brand guidelines zip (or its extracted contents) to that folder.
3. Share the folder with the client's AgentWeb account email so the Google Drive knowledge base connector can access it.
4. The files are then accessible through the existing Knowledge Base interface — the agent can read PDFs, DOCX files, images, etc. directly from Google Drive without any changes to our upload infrastructure.

### Why this is better than increasing upload limits

- No infrastructure changes required — no risk of destabilizing the upload path for all users.
- Google Drive is already integrated as a knowledge base source; files stored there are indexed and accessible to the agent the same way as any other KB file.
- Large zip files don't need to be stored redundantly in S3 — Google Drive handles storage and CDN delivery.
- The client retains direct access to their own files in Drive and can update them without going through our UI.

### Recommendation for the product

If large brand guideline uploads become a common need, consider adding a "Connect Google Drive folder" shortcut in the Brand Guidelines UI that guides users through sharing a folder with the service account — avoiding the upload flow entirely for large asset libraries.

---

# June 3, 2026: Investigation — LinkedIn "Invitation Accepted" Notifications Stopped Sending

## Symptom

The email notification a list owner should receive when a lead accepts their LinkedIn connection request stopped firing. Separately, when it *did* fire it also posted to Slack (which it should not), and it fired for lists that never sent the invite.

## Root causes

1. **Trailing-slash URL mismatch (the "stopped sending" bug).** `linkedInConnectionSyncCron.notifyNewConnections` looked up CRM leads via `crmDb.findLeadsByLinkedin(conn.publicProfileUrl)`. The connection URL is normalized by `unipileConnectionsDb.normalizeLinkedInUrl`, which **forces a trailing slash** (`.../in/john/`). But leads store their `linkedin` value **without** a trailing slash — CSV import (`crm.ts` normalizer) and enrichment (`enrichmentGroups.normalizeLinkedInUrl`) both strip it, and `db.createLead` only `.trim()`s. `findLeadsByLinkedin` does an **exact** GSI match on `LinkedinLookupIndex`, so the slash-terminated key never matched → zero leads → no email. The `__latest__` watermark had already advanced, so the connection was never reconsidered → permanent miss. (The sibling `enrollNewConnections` was unaffected because it normalizes *both* sides before comparing.)

2. **Slack notification.** `leadListAlertService.notifyLinkedInConnectionAccepted` posted to Slack via `sendLeadNotification` whenever the owner had a `slackChannel`. These acceptance alerts should be email-only.

3. **No sender gate.** The notification fired for any list containing the matching lead, regardless of whether the list had an assigned LinkedIn sender (`list.linkedInAccountId`).

## Fixes

- `notifyNewConnections` now queries both the slash and no-slash URL variants (deduping by `listId#leadId`) via a new `findLeadsForConnectionUrl` helper.
- It now only notifies when `list.linkedInAccountId` is set **and** equals the connection's `accountId` (the sender that actually sent the invite).
- Removed the Slack block from `notifyLinkedInConnectionAccepted`. Generic lead-list alerts in `notifyLeadListOwnerIfConfigured` still post to Slack.

## Tests

- `linkedInConnectionSync.notifyNewConnections.test.ts` — added slash-variant matching, variant dedup, and sender-gate cases; made the `normalizeLinkedInUrl` mock mirror the real (trailing-slash) behavior.
- `leadListAlertService.linkedInConnectionAccepted.test.ts` — added a case asserting Slack is never called even when a `slackChannel` is set.

## PRODUCTION INCIDENT — notification flood on initial backfill (2026-06-03 16:33–16:42 UTC)

While PR #1752 (above) was in review (NOT deployed), a live flood of "invitation accepted" emails hit `murray.newlands@gmail.com`.

### Diagnosis (from prod logs + DynamoDB)

- User `9fde4157-e73f-4f0e-9d3a-ac8fe97b35ec`, list `list_1776558909356_4e0g4dxrt` ("Master Contact Data with Enrichment"): **132,363 leads, 32,298 with LinkedIn URLs**, freshly imported.
- Unipile account `LIBGE2pYS1eckwgo7wUIGQ` (**3,447 cached connections**) ran a **one-time full backfill**. Commit `570dc302` (merged to `main` the same day) extended the forced full backfill from *empty* caches to *partial* caches too (gated on a new `__fullsync__` marker), so every pre-existing account backfills once. `notifyNewConnections` then treated every historical connection (e.g. `connectedAt` = Mar 22) as a freshly-accepted invitation → ~86 emails (+ Slack) in 9 minutes, all to one owner.
- The list had **no `linkedInAccountId` assigned**, yet it still notified (the missing sender gate).
- Dedup (`lead.system.linkedInConnectionNotifiedAt`) WAS working — each lead fired once — so it was a one-time burst, not a per-cron repeat. It self-terminated once the backfill completed (flat at 16:42; no growth across the 16:50 cron boundary).

### Root-cause fix (added to PR #1752)

`runLinkedInConnectionSync` now checks the `__fullsync__` marker (`getFullSyncCompletedAt`) BEFORE syncing each account. If absent, this run is the one-time full backfill — covering **both empty AND partial caches** (the partial-cache path is what actually flooded) — so it caches the connections silently and skips BOTH `notifyNewConnections` and `enrollNewConnections`. Keying off the fullsync marker (not the watermark) is essential: the flood account had a non-null watermark, so a watermark-based check would have missed it. Combined with the sender-gate fix, this list would have sent **zero** emails. Covered by `linkedInConnectionSync.initialBackfillNoNotify.test.ts` (includes a partial-cache case).

## POSTMORTEM — transparent-logo handling during newsletter HTML editing (2026-06-15)

Session `eadb9fda-d255-479f-b122-356ae36cbc50` (user Aquila). Task: header logo = 3-color brand mark on a purple gradient (#3F51B5→#6E49BF); footer logo = all-white mark on dark navy (#1a1a2e). Both needed a transparent background. The agent made four mistakes before the user manually supplied transparent PNGs.

### Mistakes & root causes

1. **Used `remove_c2pa_from_image` expecting transparency.** It only re-encodes to strip metadata (`imageService.removeC2PAMetadata` → Sharp `withMetadata:false`); it never touches pixels, so it cannot remove a background or create an alpha channel. The tool name/description implied more than it does.
2. **Used `generate_image` to "redraw the logo on a transparent background".** No real background-removal capability existed, so the only fallback was regenerating the mark — which risks icon/letter/color drift and cannot guarantee true alpha.
3. **Selector `p:contains(AQUILA):first` clobbered the wrong element.** "AQUILA BRIEFING" in the header appears first in DOM order, so a `:contains + :first` selector aimed at the *footer* wordmark hit the *header*. Required a corrective pass.
4. **Placed a black wordmark on the dark purple header** (illegible). No fg/bg contrast validation existed.

### What worked
User supplied real transparent PNGs (3-color for header, all-white for footer). Swapping `img src` via `update_html_file` CSS `setAttribute` preserved brand fidelity exactly, scoping by container background: header `td[style*="linear-gradient"] img[alt="Aquila"]`, footer `td[style*="#1a1a2e"] img[alt="Aquila"]`.

### Fixes (this branch)

- **New `remove_image_background` tool** (`imageGeneration.ts:removeImageBackground` + `agentModeService.removeImageBackground`, registered in `emma/tools.ts`). Edge-seeded flood fill over the original raw RGBA pixels via Sharp: detects the background color from the corner median, clears alpha on contiguous border-connected pixels within a tolerance. Produces a **genuine transparent-alpha PNG without redrawing the mark** — enclosed regions (e.g. a counter inside a letter) are preserved because the fill only follows border-connected pixels. Verified end-to-end: a real Google-logo PNG → 70.5% transparent / 26.4% opaque, `channels:4 hasAlpha:true`, foreground colors intact.
- **Optional `surface_color` contrast check.** Computes the WCAG contrast ratio between the logo's average opaque color and the target surface; warns below 3:1 (the "black logo on dark purple" failure). E2E run reported 4.39:1 against #1a1a2e for the colored Google mark → legible.
- **Description fixes.** `remove_c2pa_from_image` now states it does NOT remove backgrounds and points to the new tool. `generate_image` now forbids "redraw on transparent background" and routes such requests to `remove_image_background` / an existing transparent PNG.
- **Selector guidance.** `update_html_file` now instructs scoping by container/section background (not `:contains + :first`) when a brand word appears multiple times, with the header/footer examples above.
- **Bonus bug fix.** `removeC2PAFromImage`/`removeImageBackground` filename normalization truncated extension-less names (`"logo"` → `".png"`) because `lastIndexOf('.') || length` is dead code (`-1` is truthy). Fixed both to `dotIndex > 0 ? substring(0, dotIndex) : name`.

### Tests
`imageGeneration.backgroundRemoval.test.ts` (real Sharp — proves alpha, interior-counter preservation, tolerance, corner-median, WCAG helpers), `agentModeService.removeImageBackground.test.ts` (orchestration, filename, contrast, error paths), `remove_image_background.registration.test.ts` (tool registry + updated descriptions). 107 image-related tests pass; `npx tsc` clean.
