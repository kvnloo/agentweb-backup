## ENG-2837: forward-lead submission idempotency — feature and recovery limits (2026-11-06)

**What it does.** `POST /api/webhooks/forward-lead` and `/api/leads/public/:listId` dedupe on
`(listId, submission key)`. Key precedence: `idempotencyKey`, then top-level `submissionId`
(Flatfee landers), then `customFields.submissionId`. A malformed candidate (non-string,
whitespace, outside `[A-Za-z0-9._:-]{1,200}`) is skipped and the next one is tried; no valid
key means the request runs unkeyed, exactly as before. The first request claims the key with a
conditional put in `AW-Configs` under `userId = __system__:leadSubmissionClaims`
(`configId = leadSubmission:<sha256(listId\nkey)>`), writes the lead, records the response,
and only then fires notifications / CAPI / CRM sync. Every repeat replays that stored response
(`Idempotent-Replayed: true`) with no second write or side effect.

**No expiry, by requirement.** The same key must always replay, so completed claims are never
deleted. Replay returns the same public body the original got (`success/message/event/leadId/
listId`, no lead PII); the client-generated UUID key is the replay capability.

**Fail-closed behaviour (intentionally accepted).**
- Claim store unavailable → 503 retryable, nothing written.
- Failure before any lead write → claim released, retry processes normally.
- Failure after a lead write may have started, owner crash, or completion record not written →
  the claim stays `in_progress` forever. There is no stale takeover (no fencing, so takeover
  could double-write). Retries get 409 telling the client to contact support if it persists.
  If the lead was saved, its owner notification / CAPI / CRM sync are withheld.
- No automated reconciler or alert beyond the `[forward-lead] ENG-2837 ... claim left
  in_progress` error log. Scope is one submission, never the whole list.

**Operator recovery.** Find the log line (it names list and, for completion failures, leadId).
Check the lead in `AW-Leads`. If it exists, either re-fire its side effects manually or accept
the gap, then write the claim as `completed` (or delete it, accepting the next retry may update
the existing lead via the email path). If no lead exists, delete the claim item
(`userId = __system__:leadSubmissionClaims`, `configId` as above) so the next retry processes.

**Analytics.** `taskDb.getTaskAnalytics` scans all of `AW-Configs`; it now passes
`FilterExpression: userId <> :leadSubmissionClaimPartition` so claims are excluded server-side
(not counted as configs, not loaded into memory). Scan RCU still covers them — a Scan reads
before it filters.
