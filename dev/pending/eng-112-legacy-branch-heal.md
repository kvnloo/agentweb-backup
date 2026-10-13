## ENG-112: Legacy branches heal themselves when their owner opens them (2026-10-13)

### Problem
Branches created before agentweb#3463 (2026-10-09..10-13; `chat_branching_enabled` was only turned on 2026-10-09) carry the row-0 `metadata.branchOrigin` marker but no session-level `branchedFrom`. They are not grouped in the sidebar, not listed by `GET /session/:id/branches`, and a branch of one starts a NEW family root.

### Fix (self-healing, bounded, no backfill)
- `GET /api/agent-mode/session/:id`, genuine OWNER view only (not admins, not delegated, not share/MCP views), only when `chat_branching_enabled` is exactly "true", only when the loaded session has no `branchedFrom` and its already-loaded row 0 carries a well-formed `branchOrigin`.
- Derives `branchedFrom {sessionId: sourceSessionId, rootSessionId, messageIndex: sourceMessageIndex, branchedAt}` (the exact values #3463 writes) and persists it with ONE conditional update: `attribute_exists(sessionId) AND userId = :owner AND attribute_not_exists(branchedFrom)`. Concurrent opens are idempotent, an existing value is never overwritten, `updatedAt` is not touched (sidebar order unchanged). The healed value is returned in the same response.
- rootSessionId = the source's `branchedFrom.rootSessionId`, else the source itself (a legacy source without `branchedFrom` is not walked further: that would need its message rows). Inline-message records (very old sessions) are followed up to 10 record reads, cycle-safe. Only `getChatSessionRecord` reads; never message rows.
- Source must exist and belong to the SAME owner (archived is fine); otherwise skipped silently.
- Best effort: any failure is logged and swallowed; GET never fails. Sessions that already have `branchedFrom` or are not branches cost nothing (no flag read, no store call). A legacy session costs the bounded record reads once, ever.

### Known limitation
A chain of two or more legacy hops (C branched from legacy B branched from A) heals C with root B until B itself is opened and healed; C is then in B's family, not A's. Walking further would need message rows, which this change deliberately never reads.

### Approval / rollout / rollback
- `branchedFrom` is the additive optional attribute already owner-approved with #3463; no new attribute, index, table or backfill.
- Rollback = revert this PR. Values already written are harmless (owner-only, optional, read by the same code as #3463 branches).
- Tests: `chatBranching.legacyHeal.test.ts` (real controller + real ChatbotDB over the in-memory store with enforced ConditionExpressions). Mutation-checked: dropping the owner condition, the attribute_not_exists condition, the owner-view gate, the flag check or the same-owner source check each fails tests.
