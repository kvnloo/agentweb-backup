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

## Exact IaC proposal (NOT applied)
`infra/sent-messages.yaml` declares AWS::DynamoDB::Table with orgId/sk string keys, on-demand billing,
AWS-managed SSE, PITR, deletion protection, Retain for deletion/replacement, and no TTL or GSI.
Default name is development; production would explicitly set TableName=AW-SentMessages after approval.
The template is standalone and is not wired into any deployment. No production table has been created.
Future integration must grant only required GetItem/PutItem/UpdateItem/Query/TransactWriteItems access
on the exact table ARN, without scan/delete, and configure an explicit table name in backend.

## Delivered in this draft
An injected DocumentClient service implements durable pre-send conditional claim, provider key,
fail-closed ambiguity, and atomic permanent record finalization. No existing outbound path is changed.
This is a storage foundation, **not completion of the entire ENG-2964 universal guard**.

## Remaining before rollout/merge
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

Rollback before activation: remove module/template (no runtime change). After activation: disable
routing to ledger only after assessing duplicate risk; retain table/history, never delete as rollback.
