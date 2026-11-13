## ENG-2984: Storage-free duplicate-send guards (2026-11-13)

- `send_email_to_lead` now claims the stored draft with a conditional DynamoDB `REMOVE emailDraft`
  (`crmDb.claimLeadEmailDraft`, condition `emailDraft = :expected`) before calling the provider, so
  two concurrent invocations for one lead send at most once. The loser returns
  "Email draft already sent or changed". A failed send restores the draft best-effort
  (`crmDb.restoreLeadEmailDraft`, only if no newer draft was written). No new attributes, tables or indexes.
- `resendService.sendEmail` computes one deterministic `Idempotency-Key`
  (`buildResendIdempotencyKey`: tenant, sorted recipients, content hash, intent) per send and passes it
  on every attempt, so a timed-out request that actually landed is replayed by Resend rather than delivered
  twice. Callers can pass `tenantId` + `idempotencyIntent` for cross-call dedupe; without an intent a per-call
  nonce is used, so separate identical sends are still not merged (unchanged behaviour). Resend keys expire after 24h.
- LinkedIn `send-message` without `list_id`/`lead_id` runs a fire-and-forget SHADOW check after sending:
  it reads the chat the send returned (`getOutboundMessagesInChat`, no profile lookup) and logs
  `SHADOW would-block (ENG-2984)` if an identical outbound message was already there. It never blocks.
  Grep that marker in prod logs to size the would-block rate before deciding on enforcement.
