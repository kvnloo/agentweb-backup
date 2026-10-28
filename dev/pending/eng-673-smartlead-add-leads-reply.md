## ENG-673: read Smartlead's real add-leads reply (2026-10-27)

A live Smartlead account showed that its add-leads reply is not the one its docs describe, and the merged reader (slice 2a) was wrong against it: it read `upload_count` as "leads added", but `upload_count` is everything submitted (invalid rows included); `total_leads` is what was newly added. Nothing calls `addLeadsToCampaign` yet, so no user was affected.

- `addLeadsToCampaign` now reads the real reply (`total_leads`, `already_added_to_campaign`, `invalid_emails`, `skipped_in_other_campaign_count`, `block_count`, ...) and still accepts the documented `added_count`. It always sends `return_lead_ids: true`, so the result says per lead whether it was newly added, already in this campaign, or already in another one, with the Smartlead lead id (needed later to pause or unsubscribe a lead).
- `skippedLeads` and `skippedKnown` are gone (the live reply has no per-lead reasons, only tallies and the id map).
- Contract tests now run the readers against replies recorded from a live account (`__tests__/fixtures/smartleadRealReplies.ts`, every value invented, shapes real).
- `test-env/smartlead-stub.js` returns the real shape.
- Also recorded from the live account: the campaign mailbox list and the campaign list are bare arrays; the mailbox list does carry the per-day limit (`message_per_day`); an A/B-variant sequence has empty step-level subject and body.
