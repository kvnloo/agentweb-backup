## ENG-673: AgentWeb's own senders skip leads pushed to Smartlead (PR-D1, 2026-10-28)

A lead pushed to a customer's Smartlead campaign carries a marker (`system.smartlead_<campaignId>`, state `pushed`, or `withdrawn` after an opt-out). It is emailed from Smartlead, so AgentWeb's own senders must not also email it (two senders, and Smartlead's unsubscribe and bounce handling would not see AgentWeb's mail). A `released` marker (a list editor cleared it, PR-D2) counts as not pushed. The check is `isPushedToSmartlead(lead)` in `services/smartleadMarkers.ts`. It is deliberately NOT part of `isDoNotContact`: bounce recording (`routes/webhooks.ts`, `outlookBounceMonitorCron`) and the unsubscribe page (`routes/crmPublic.ts`) use that and must not change (a test pins it).

### Where it applies
- **Drip sequences** (`dripSequenceWorker.sendEmailStep`): checked at SEND time, not enrolment, because a lead can be pushed after it was enrolled. The step is skipped like any step the lead cannot receive (the enrollment advances); LinkedIn steps are unaffected.
- **Group email**: `send` leaves pushed leads out and reports `skippedSmartlead`; `preview` reports `smartleadCount` and leaves them out of `eligibleLeads`; `prepare` leaves them out of `eligibleCount`. All three apply the same rule so the preview never promises recipients the send does not make. Resuming a pending batch re-posts to `send`, so it is covered.
- **Emma `send_email_to_lead`** (`emma/impl/leads.ts`): refuses, with a message that says why and what the customer can do.
- **Manual one-to-one send** (`POST /lists/:listId/leads/:leadId/send-email`): a confirmation, not a block. It answers 409 `{code: "pushed_to_smartlead", message}` unless the body has `confirmPushedToSmartlead: true`. The portal does not send that flag yet, so until PR-E a manual send to a pushed lead shows the message and sends nothing.

- **Webhook auto-send** (`routes/webhooks.ts`): that block also runs for an EXISTING lead that resubmits a form (it is `isUpdated`), and that lead keeps its marker, so it skips with `autoSendStatus: "skipped_smartlead"` (a review caught that my first reading, "it only emails a brand-new lead", was wrong).
- **Drip worker, read failure:** a failed read of the lead (not "no such lead") now throws, so the enrollment is neither sent nor advanced and is retried. Before, it carried on with no lead and skipped every per-lead check (do-not-contact included).

### Deliberately not changed
- **Manual reply** (`reply-email`): a reply to an inbound message is a conversation the person started; left alone.
- **Emma `send_email_from_sender`, the `email` tool and `/email` in `emmaApi.ts`**, and any send to a raw address: no lead in hand, so they cannot be covered without a lookup (a documented limit, tracker row 35). Emma's refusal text tells the agent not to reach the person another way.
- Test sends to caller-supplied addresses, `sendAsSender` itself (it only sees an address) and `dripSequenceDb` (storage only).
- Enrolment: the worker check is the one that closes the gap (a lead can be pushed after it was enrolled).
- **A drip step skipped while a lead is pushed is lost, not snoozed**: if the marker is released later the sequence continues with the next step (a follow-up to an email AgentWeb never sent). Chosen on purpose for v1; tracked.
- The portal (separate repo) does not show `smartleadCount`/`skippedSmartlead` or offer the confirmation yet: PR-E.

### Tests
`dripSequenceWorker.senderRouting.test.ts` (pushed and withdrawn skipped, released and plain sent, a later step advances, a failed lead read does not send), `webhooks.leadForwarding.test.ts` (auto-send skipped), `crm.groupEmail.test.ts` (preview, prepare, send), `crm.routes.test.ts` (confirmation), `agentModeService.crmTools.test.ts` (Emma), `smartleadEligibility.test.ts` (a pushed lead is not do-not-contact). The RFC 8058 List-Unsubscribe test in `crm.groupEmail.test.ts` already fails on main (not from this change).
