## ENG-673: AgentWeb's own senders skip leads pushed to Smartlead (PR-D1, 2026-10-28)

A lead pushed to a customer's Smartlead campaign carries a marker (`system.smartlead_<campaignId>`, state `pushed`, or `withdrawn` after an opt-out). It is emailed from Smartlead, so AgentWeb's own senders must not also email it (two senders, and Smartlead's unsubscribe and bounce handling would not see AgentWeb's mail). A `released` marker (a list editor cleared it, PR-D2) counts as not pushed. The check is `isPushedToSmartlead(lead)` in `services/smartleadMarkers.ts`. It is deliberately NOT part of `isDoNotContact`: bounce recording (`routes/webhooks.ts`, `outlookBounceMonitorCron`) and the unsubscribe page (`routes/crmPublic.ts`) use that and must not change (a test pins it).

### Where it applies
- **Drip sequences** (`dripSequenceWorker.sendEmailStep`): checked at SEND time, not enrolment, because a lead can be pushed after it was enrolled. The step is skipped like any step the lead cannot receive (the enrollment advances); LinkedIn steps are unaffected.
- **Group email**: `send` leaves pushed leads out and reports `skippedSmartlead`; `preview` reports `smartleadCount` and leaves them out of `eligibleLeads`; `prepare` leaves them out of `eligibleCount`. All three apply the same rule so the preview never promises recipients the send does not make. Resuming a pending batch re-posts to `send`, so it is covered.
- **Emma `send_email_to_lead`** (`emma/impl/leads.ts`): refuses, with a message that says why and what the customer can do.
- **Manual one-to-one send** (`POST /lists/:listId/leads/:leadId/send-email`): a confirmation, not a block. It answers 409 `{code: "pushed_to_smartlead", message}` unless the body has `confirmPushedToSmartlead: true`. The portal does not send that flag yet, so until PR-E a manual send to a pushed lead shows the message and sends nothing.

### Deliberately not changed
- **Webhook auto-send** (`routes/webhooks.ts`): it only emails a lead created moments earlier by the forward-lead webhook, which cannot carry a marker, so a check there would be dead code.
- **Manual reply** (`reply-email`): a reply to an inbound message is a conversation the person started; left alone.
- **Emma `send_email_from_sender`**, and any send to a raw address: no lead in hand, so it cannot be covered (a documented limit; the design says so).
- Test sends to caller-supplied addresses, `sendAsSender` itself (it only sees an address) and `dripSequenceDb` (storage only).
- Enrolment: leaving the enrolment paths alone is deliberate; the worker check is the one that closes the gap.

### Tests
`dripSequenceWorker.senderRouting.test.ts` (pushed and withdrawn skipped, released and plain sent, a later step advances), `crm.groupEmail.test.ts` (preview, prepare, send), `crm.routes.test.ts` (confirmation), `agentModeService.crmTools.test.ts` (Emma), `smartleadEligibility.test.ts` (a pushed lead is not do-not-contact). The RFC 8058 List-Unsubscribe test in `crm.groupEmail.test.ts` already fails on main (not from this change).
