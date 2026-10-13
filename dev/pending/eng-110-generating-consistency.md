## ENG-110: One source for the "generating" signals: /generating and isGenerating (2026-10-13)

### Problem
`GET /api/agent-mode/generating` was built from the per-user concurrent-generation cap map intersected with the session lock, while `isGenerating` on `GET /session/:id` is the lock alone. Auto-continuation runs (media / work-plan) hold the session lock WITHOUT a cap slot, so for them `isGenerating` was true but `/generating` omitted the session. The portal's reload reconcile polls `/generating` and treats absence as "not running", which could show the "response wasn't received / Resend" banner while a continuation run was live.

### Fix
- The lock claim records its owner: `tryClaimSessionGeneration(sessionId, ownerUserId?)` writes `sessionGenerationOwners` (in-memory Map) in the same synchronous step; `releaseSessionGeneration` deletes it. Every claim site already releases in a `finally`, so nothing can outlive the lock. No storage.
- `/generating` = the caller's sessions among the claimed locks (`getClaimedSessionIdsForUser`); `isGenerating` = lock held and owner === caller (`isSessionGeneratingForUser`).
- Owner is passed at every claim site: /generate, public/conversable generate, runVerifiedChat (scheduled, Slack, email, /verified-generate, result endpoint, revision, human eval) via `claimSessionGenerationWithRetry`, media + work-plan auto-continuation, preempt re-claim, approval-inbox resume, chat branching, model compare select.
- Safe fallback: a lock claimed with no owner is not invisible. `/generating` falls back to the caller's cap slot for it, and `isGenerating` stays lock-based (true for the session's own viewer).
- Owner record is the session OWNER (not an admin acting on the session), so the customer's portal sees admin-driven runs. Other users, admins, delegates and share views are never shown the flag or others' ids.

### ACCEPTED risk: deploy overlap
During an Immutable deploy the old instance can still run a chat while the new instance reports nothing (locks are per instance; AW-AgentRuns / AGENT_RUN_STORE is not provisioned and is owned by ENG-784). A Resend in that window could start a second generation. Narrow window, bounded by the 10-minute drain ceiling. Accepted; not fixed here.

### Tests
agentModeController.generatingConsistency, agentModeRoutes.generatingConsistency, and a real media-continuation case in agentModeController.autoMediaContinuation. Mutations that must fail: drop owner record on claim, never delete on release, expose other users' ids.

### Rollback
Revert the PR. No data, no schema, no config.
