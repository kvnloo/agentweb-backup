# Lander Reliability — Shared Findings (Claude ⇄ Codex)

> Working file for the joint investigation on branch `defense/lander-reliability`
> (worktree `~/Desktop/AgentWeb/worktrees/lander-reliability`). Both agents read and
> append here. Delete before final PR merge or move content into dev.md.

## Status (updated 2026-07-11 by Claude)

- Branch contains: Manan's `manan/v0-subpage-generation-timeout` (ENG-287 fix, 2 commits)
  **merged with** Codex's `codex/landing-page-idempotency` (route-reuse guard + tests).
  Conflicts hand-resolved; `npx tsc` clean; 202 tests green across
  `v0UsageGuard` / `v0Service.withRetry` / `services.v0Service`.
- Resolution choices (deliberate, keep unless refuted):
  1. Kept Manan's guard structure (`isReservationBlocking`, `reserveInDynamo`,
     opts-based `bestEffortPut`, exported `V0_RESERVATION_TTL_MS = 20 min`).
     Dropped Codex's duplicate `RESERVED_LOCK_TTL_MS = 30 min` + `isFreshReserved`.
  2. **Tightened the Dynamo reserve condition** — both original versions could clobber
     a `succeeded` record (Manan via bare `#updatedAt < :stale`, Codex via
     `#status <> :reserved`). Now:
     `attribute_not_exists(idempotencyKey) OR #status = :failed OR (#status = :reserved AND #updatedAt < :stale)`.
  3. Adopted Codex's memory-Map resync on a lost reservation race (multi-instance
     hygiene), with `succeeded`-only reuse on the recovery read.
  4. `isReservationBlocking` falls back to `createdAt` when `updatedAt` is missing and
     fails OPEN on unparseable timestamps (one duplicate v0 call beats a permanent wedge).
  5. Kept Codex's `generateLandingPage` route-reuse check (skip duplicate build when the
     same slug is already `deployed|generating|deploying`) + null-name hardening in
     `findReusablePageForRoute`.

## The problem (canonical: Linear ENG-287, ENG-277)

Three stacked bugs made RankAI/Opsera/internal landing-page generation fail "routinely":
1. **v0 `chats.create` times out at 300s** (no chatId on any failed record 07-10) —
   root cause still being confirmed: v0-side degradation vs oversized enriched prompt
   vs account/credit issue. Investigation lane running.
2. **withRetry amplified our own 300s timeout 3× → ~15-min hang** (fixed on this branch:
   `retryOnTimeout: false` on the two interactive chat-create call sites).
3. **Idempotency guard never deduped (prompt hash in key) but did wedge retries**
   ("same idempotency key already in flight", no TTL, failed records blocked retries) —
   fixed on this branch.

Previous "Anurag fixes" (ENG-135/157/158/159/160/189, merged 07-02..07-08) were real but
addressed DIFFERENT failure modes (coding-agent 422 preview-branch deletion, zombie
builds, error-detail surfacing, model timeout). The 07-09/07-10 failures are mode (1)+(3)
above — new, now being fixed here.

## Known still-open (deep-fix scope, this branch or follow-up)

- ENG-277's wedged prod page (`e2a0c0c7-4fcf-43e1-9288-27f9e2daeeb9`, rankai-book-a-demo):
  code fix should unwedge on next retry (failed→retryable + stale TTL), but verify the
  actual AW-V0Usage record state; may need a one-off data fix.
- 300s single-attempt is still terrible interactive UX — chats.create normally returns in
  seconds; consider a much tighter create timeout (~60-90s) with clean retry.
- Portal state hygiene: failed cards accumulate, no bulk cleanup, no lock-clearing
  self-service, "No list" states, stuck `generating`. Deep-fix design pending
  investigation lanes (incl. competitor-process research: Lovable/Bolt/v0/Base44).
- MCP `generate_landing_page` runs inside a request budget → "fetch failed" to the
  caller while the build continues server-side (ENG-190 adjacent). Async/job model needed.

## Coordination protocol

- Both agents commit to `defense/lander-reliability`. Small, single-purpose commits.
- Run `npx tsc` + `npx jest v0UsageGuard v0Service.withRetry services.v0Service --no-coverage`
  before every commit (repo CLAUDE.md discipline).
- Before starting a work item, append a line under "Claims" below to avoid collisions.

## Claims

- [Claude] merge/reconciliation of Manan+Codex fixes — DONE (2a0727548)
- [Claude] v0 account/credits/auth + prod telemetry + competitor research + pipeline map — IN FLIGHT (workflow lanes)
