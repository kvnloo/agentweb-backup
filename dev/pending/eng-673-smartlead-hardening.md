## ENG-673: hardening after blind reviews of the push stack and the opt-out safeguards (2026-10-28)

A fresh reviewer with no context went through the merged own-sender skip (#3806) and withdrawal sweep (#3807) and found these. All fixed here.

- **Form-webhook auto-send had no do-not-contact check of its own (older than ENG-673).** (A live run on env1 showed the auto-DRAFT step already refuses a do-not-contact lead ("Cannot draft email for this lead: Do Not Contact"), so the gap was narrower than the review first said; the guard is kept as a second layer, for a draft that already exists on the lead.) `routes/webhooks.ts`: an existing lead that had unsubscribed and then resubmitted a form was auto-emailed, because the auto-draft step has no do-not-contact check and neither did the auto-send. It now skips with `autoSendStatus: "skipped_do_not_contact"`.
- **The sweep could mark a lead `withdrawn` when nothing was stopped.** A user can replace a connection's key with a key from another Smartlead account; Smartlead then answers 404 to every lead, which the sweep read as "gone". The sweep now checks per list and campaign that the key can SEE the campaign (`getCampaign` is not empty); if not, the pair is skipped, counted as `keyUnavailable` and logged once a day ("the connected key cannot see this campaign (it was deleted in Smartlead, or the key belongs to another Smartlead account)"); a deleted campaign looks the same as another account's key, so such pairs are left untouched and cost one `getCampaign` call each per pass.
- **Release no longer touches do-not-contact leads** (`skipped.doNotContact` in the reply). AgentWeb's own senders skip them anyway and the sweep must keep stopping them in Smartlead; releasing only churned the marker. Note: a `withdrawn` marker keeps AgentWeb's own senders off a lead even after it is re-subscribed, until a list editor releases it.
- **Hourly log lines are deduplicated**: no usable key, an invisible campaign, a list that throws and the run-limit warning are each logged once a day, not every pass.
- Dev note for the sweep corrected (400-day window; every run's key is tried).

### From the blind review of the whole push stack (engine, run store, API)
- **The cohort is pinned to the PREVIEW time.** The engine used the run's start as the cut-off for "created after the run started"; a lead imported between the preview and the start was therefore pushed in place of a previewed one. The service now records the approval token's issue time as `options.approvedAt` and the engine uses it (falling back to the run start for older runs). Still a count, not a list of ids: a lead that BECOMES eligible between preview and start (for example validated in the meantime) can take a slot; a hand-checked first cohort in a DRAFTED campaign covers that (tracker).
- **Stricter email shape**: zero-width, bidi and control characters, `,` `;` `|` and backtick, a repeated dot, a leading or trailing dot in either part and a top-level domain that is not letters are refused (they only mattered with "include unverified").
- **URL-type fields** (`website`, `company_url`, `linkedin_profile`) are left out when they contain quotes, backticks, spaces or a `javascript:`/`data:`/`vbscript:` scheme (they may land inside `href="..."` in the customer's template); ordinary values, and quotes in a company NAME, are unchanged.
- **`confirmStart` only confirms a run that is still running** and now returns whether it did; a refused confirmation (the resumer cancelled it) is reported to the user as a failed start with no worker.
- **A worker re-checks that the pusher still has edit access to the list** before working a run it picked up (a resume or a claim); otherwise the run pauses with `access_revoked`.
- **Measured, no change needed:** a 400-lead POST with `return_lead_ids` takes about 1.5 s on the real account (a resend 1.7 s), far under the client's 15 s timeout.

### From the fresh review of this change
- A key rejected (401/403) during the new visibility check is now REPORTED (flagged after a confirming probe) and the pass goes on; the visibility check runs only when someone opted out (a quiet pass costs no Smartlead call); the once-a-day log keys include the reason so a different problem on the same list is not hidden; the pass summary is deduplicated.

### Tests
Sweep (invisible campaign, deduplicated logs), service (release skips do-not-contact, sweep through the service refuses an invisible campaign), webhook (do-not-contact). Six deliberate breakages each fail a test.
