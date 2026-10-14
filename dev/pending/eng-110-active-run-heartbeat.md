## ENG-110: Cross-instance active-run guard for interactive /generate (2026-10-13)

Problem: production runs one backend instance but deploys are Immutable (two instances overlap) and the old one
drains for up to 10 min (`DRAIN_CEILING_MS`). The per-session generation lock, its owner map and `/generating` are
process memory, so during an overlap the OLD instance can still run a chat while the NEW instance reports nothing:
after a reload the portal shows the "response wasn't received / Resend" banner and a Resend click starts a SECOND
generation (duplicate user message, two assistant replies, double cost).

Fix (additive, switch-gated, fail-open): an optional attribute on the existing `AW-ChatSessions` item,
`activeRun: { runId, instanceId, startedAt, heartbeatAt }` (epoch ms). No GSI, no backfill, no new table or index.
The run-store guard (`AGENT_RUN_STORE`, `AW-AgentRuns`) is NOT used.

- Switch: AW-Settings `session_active_run_guard_enabled`, exactly `'true'` enables. Absent / anything else / cold-start
  read failure = off = today's behaviour with ZERO session-table calls. ~60s cache, last-known on a failed refresh
  (same pattern as `compareProviderPolicy.ts`). Not an env var. Turn it ON only after the deploy that ships this is live.
- Claim (interactive `/generate` only, right after the in-memory claim): one conditional `UpdateItem`
  (`attribute_exists(sessionId) AND (attribute_not_exists(activeRun) OR activeRun.heartbeatAt < :staleBefore OR
  activeRun.runId = :me OR activeRun.instanceId = :instanceId)`). Condition lost => release lock/owner and answer
  409 `SESSION_BUSY` (same body as the in-memory busy path). Any other error => log and proceed (fail-open).
  The `instanceId` clause (not in the original design) lets the same process re-claim: its in-memory lock already
  proved the earlier run there ended (Stop then an immediate resend before the old run's clear landed).
- Beat: every 30s `SET activeRun.heartbeatAt` conditional on our `runId`; a failed or lost beat is only logged.
  Timer is `unref`'d and cleared synchronously in the existing `finally` (success, throw, timeout, stop, 429, crash path).
- Clear: `REMOVE activeRun` conditional on our `runId` in the same `finally`, best-effort (never clears a newer run).
- Staleness 90s (3 beats). Writes never touch `updatedAt` / `adminListPartition`.
- Reads: `GET /session/:id` `isGenerating` = in-memory OR (fresh activeRun of ANOTHER instance AND genuine owner view),
  no extra read. `GET /generating?sessionId=<id>` (optional; owner only, not delegates) adds that one session via one
  record-only `getChatSessionRecord`; without the param it is unchanged.
- `activeRun` is never serialised: every ChatbotDB session read makes it non-enumerable (invisible to spread / JSON /
  lists / exports / share / admin views), and the owner view and MCP tools also omit it explicitly.
- Whole-item overwrites (`put`) of a session: only `createChatSession` (a new item) and the dev/test scripts
  `copy-session-to-dev.ts` / `seed-imageresume-testenv.ts`. A dropped attribute only means a missed guard.
- Out of scope (phase 1): conversable-share generate and system paths (scheduled / Slack / email / verified-generate).
- Rollback: set the switch to anything but `'true'`; leftover attributes go stale harmlessly.

Switch read is bounded: the (at most once per ~60s) AW-Settings read that /generate awaits is raced against a 2s
timeout (`SETTING_READ_TIMEOUT_MS`); a hung read behaves like a failed refresh (last-known value, off if none, one log
line, retry in 5s) and never stalls the core path.

Accepted tradeoffs (phase 1):
- A >90s event-loop / GC stall of the running instance makes a live run look dead, so a Resend elsewhere is allowed; the
  stalled run's later beat then only logs `lostClaim` and the two runs can overlap.
- After a crash / SIGKILL, Resend on the new instance gets 409 and `isGenerating` stays true for up to 90s (until the
  heartbeat goes stale).
- Out of scope: the conversable / ishare generate path and the GET /session media-continuation durability backstop.
- A malformed existing `activeRun` (e.g. a non-numeric `heartbeatAt`) would stay busy; nothing in the codebase writes one,
  and handling it would need `NOT attribute_type(...)` in the claim condition, which is not worth the complexity.
