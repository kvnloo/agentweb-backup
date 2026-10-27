## ENG-673: pure functions for the Smartlead push (PR-A, 2026-10-27)

The first building blocks of pushing a CRM list into a customer's own Smartlead campaign. All pure: no route, no table, no network call, nothing calls them yet.

- `smartleadSequence.ts`: reads a campaign's sequence (`GET /campaigns/{id}/sequences`): the merge tags it uses, whether it has content, whether it uses `{a|b}` spintax, and a hash that ignores ids and timestamps. Handles A/B variants, whose content sits in `sequence_variants` while the step's own subject and body are empty (seen on a live account); skips deleted variants.
- `smartleadPayload.ts`: builds what is sent for one lead: the standard Smartlead fields from the CRM lead, plus a custom field for each non-standard tag the customer's own sequence uses (the customer writes the email in Smartlead; AgentWeb is the orchestrator). Values go as plain text with newlines stripped; a value containing `{{`, `}}` or `{a|b}` is refused. A lead missing a value for a tag the sequence uses is refused, because Smartlead renders a missing variable blank.
- `smartleadEligibility.ts`: which leads of a batch may be sent and why the others may not (no or invalid email, do-not-contact, undeliverable, unverified, already pushed to this campaign, created after the run started, missing tag, template syntax, duplicate email in the run).
- `smartleadPreflight.ts`: the campaign status rule (DRAFTED and PAUSED allowed, ACTIVE needs a second confirmation, everything else refused) and the sequence check: findings are warnings for a DRAFTED or PAUSED campaign and blocks for an ACTIVE one, except a tag that would render blank for every lead and a near-miss tag such as `{{First_Name}}`, which block for every status.
- `smartleadMarkers.ts`: the per-lead record of a push (`system.smartlead_<campaignId>`, a flat key because `setLeadFields` sets whole top-level `system` keys) and `isPushedToSmartlead(lead)` for the later check in AgentWeb's own senders. Deliberately separate from `isDoNotContact`.
- `smartleadEstimate.ts`: days to send for the preview (leads over the mailboxes' limits, capped by the campaign's daily maximum).
- Tests use shapes recorded from a live Smartlead account; breaking the code on purpose (six ways) makes tests fail.

Review fixes (independent review, same day):
- The sequence reader's tag pattern backtracked badly on a stray `{{` followed by whitespace (measured 23 seconds at 6,000 spaces, which would freeze the shared backend on a customer's template). It is now linear; a text longer than 200,000 characters counts as unreadable; a regression test covers it.
- Values containing `<` or `>` are refused (Smartlead puts values into the customer's HTML email, so a scraped company name could become a link), zero-width and bidirectional-override characters are removed, values over 500 characters are refused, `NaN`, `Infinity` and booleans count as empty.
- `company_url` is a standard tag (read from the CRM website). Acknowledging a standard or mapped tag no longer switches off the missing-value guard.
- `createdAt` is compared as a time (strings, numbers and Dates; a lead with none is allowed, one that cannot be read is skipped).
- An opted-out address stops every record with that address in the batch and in later batches of the run.
- A missing or odd campaign status is refused instead of throwing; a non-string mapping value or a `__proto__` path reads as blank; the hash now includes follow-up delays; `[null]` is an unreadable sequence.

Second review fixes:
- The spintax pattern was quadratic too (`{` followed by 100,000 `|` took 3.5 seconds): replaced by a linear scan (`smartleadText.ts`, 4 ms for a million characters). `sanitizeValue` refuses an enormous raw value before running anything on it. A sequence over 200 steps counts as unreadable; tag de-duplication uses a set.
- The lead's email is checked like any other value: no quotes, angle brackets, braces or backslashes (it goes into the customer's HTML as `{{email}}`), at most 254 characters.
- `runStartedAt` is a required input of the eligibility function (without it nothing would stop an unapproved lead). A numeric `createdAt` below 1e11 is read as epoch seconds; a text `createdAt` must look like an ISO date or the lead is skipped.
- Acknowledging a near-miss tag (`{{First_Name}}`) no longer clears it: it still blocks.

