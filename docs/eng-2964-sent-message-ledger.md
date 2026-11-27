# ENG-2964: permanent sent-message records (dark draft)

## Decision
One DynamoDB table, `AW-SentMessages` (development `Dev-AW-SentMessages`).
Partition key `orgId`, sort key `sk`. No TTL, indexes, streams, backfill, or automatic claim expiry.

- `IDEMP#sha256(channel, canonicalRecipient, campaignId, step)`: permanent claim/sent/ambiguous guard.
- `SENT#<ISO sentAt>#<message UUID>`: permanent chronological sent record with providerId and identity.
- Email recipient: trim/lowercase. LinkedIn: trim only; provider IDs are case-sensitive opaque IDs.
- Org is resolved by server authorization, never accepted from untrusted tool arguments. Campaign and
  step must be stable across retries (including drip replay). Never generate a new intent on retry.
- Conditional PutItem precedes provider invocation. Only one contender proceeds. No TTL or lease
  reclaim: crashed claims block until reconciliation. Provider receives a stable org-scoped key.
- Provider success: TransactWriteItems atomically sets guard sent(providerId,sentAt) and writes history.
- Unknown/throwing provider response: mark ambiguous; no automatic retries. A failed ambiguity write or
  success-finalization write leaves claimed blocking. Reconcile against provider before any release.
- No content/body stored. Recipient and campaign metadata remain sensitive; restrict IAM to backend.

## Applied production shadow rollout
`infra/sent-messages.yaml` was deployed as `agentweb-sent-messages-prod` in us-west-2 with
TableName=AW-SentMessages after engineering approval. Table is ACTIVE with PITR, SSE,
deletion protection and Retain. Production instance role has PutItem on the exact table ARN
through its existing inline policy. No new IAM policy was created.

`recordSuccessfulSend` observes successful sendAsSender (Resend/Gmail/Outlook) and LinkedIn
sendMessage/sendInMail dispatches. SENT_MESSAGE_LEDGER_MODE defaults to shadow; off disables
recording. Writes are detached, success-only and fail-open. No blocking claims or provider-key
changes are activated. Email resolves org from user, falling back to labelled user scope;
LinkedIn uses labelled account scope pending server org attribution. Direct-provider bypasses
remain a coverage gap. No message body is stored.

The original injected enforcement service remains dark. DynamoDB transaction members require
underlying PutItem/UpdateItem permissions; no TransactWriteItems IAM action exists.

## Remaining before enforcement
1. Review/approve persistence design and IaC; provision development and run real Dynamo concurrency tests.
2. Wire server-resolved org + stable intent across sendAsSender, work-plan delivery, drip, LinkedIn
   message/InMail; preserve keys through provider adapters. Define explicit one-off send intents.
3. Add recipient cross-campaign cooldown/content fingerprint lock policy. This requires a product choice
   for org configuration; do not silently equate the campaign identity with cross-run cooldown.
4. Add reconciliation tooling for claimed/ambiguous and explicit confirmed-failed outcomes. No operator
   reset API exists yet, intentionally. Provide org-scoped paginated history reads.
5. Shadow observation for 48 hours separately from enforce: never create blocking claims in shadow and
   then mistake those claims for delivery. Enforce only after approval and negative/concurrency tests.
6. Real Dynamo transaction conditions and integration tests; mocked tests are not AWS acceptance.

Rollback shadow recording: set SENT_MESSAGE_LEDGER_MODE=off and retain the table/history.
Review enforcement readiness after approximately three clean days; an enforce flag is deliberately
not implemented in the observational adapter and must not be enabled without the remaining guards.
