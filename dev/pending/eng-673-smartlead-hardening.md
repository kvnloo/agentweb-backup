## ENG-673: hardening after a blind review of the opt-out safeguards (2026-10-28)

A fresh reviewer with no context went through the merged own-sender skip (#3806) and withdrawal sweep (#3807) and found these. All fixed here.

- **Form-webhook auto-send ignored do-not-contact (older than ENG-673).** `routes/webhooks.ts`: an existing lead that had unsubscribed and then resubmitted a form was auto-emailed, because the auto-draft step has no do-not-contact check and neither did the auto-send. It now skips with `autoSendStatus: "skipped_do_not_contact"`.
- **The sweep could mark a lead `withdrawn` when nothing was stopped.** A user can replace a connection's key with a key from another Smartlead account; Smartlead then answers 404 to every lead, which the sweep read as "gone". The sweep now checks per list and campaign that the key can SEE the campaign (`getCampaign` is not empty); if not, the pair is skipped, counted as `keyUnavailable` and logged ("the connected key cannot see this campaign").
- **Release no longer touches do-not-contact leads** (`skipped.doNotContact` in the reply). AgentWeb's own senders skip them anyway and the sweep must keep stopping them in Smartlead; releasing only churned the marker. Note: a `withdrawn` marker keeps AgentWeb's own senders off a lead even after it is re-subscribed, until a list editor releases it.
- **Hourly log lines are deduplicated**: no usable key, an invisible campaign, a list that throws and the run-limit warning are each logged once a day, not every pass.
- Dev note for the sweep corrected (400-day window; every run's key is tried).

### Tests
Sweep (invisible campaign, deduplicated logs), service (release skips do-not-contact, sweep through the service refuses an invisible campaign), webhook (do-not-contact). Six deliberate breakages each fail a test.
