## ENG-3067: shadow-only claim check on server-side outreach drafts (2026-11-16)

`backend/src/services/outreachClaimCheck.ts` adds `findUnsupportedSenderClaims`, a pure function (no I/O, no LLM, no network) that returns percentages, money amounts, numbers with a unit and named customers/partners a draft states which the sender's `brandData` and market strategy text do not contain. Anything in the lead record counts as the recipient's and is not flagged. Missing facts return `{ status: 'no_facts' }`.

`updateEmailDraftForLead` (`backend/src/emma/impl/leads.ts`) calls `logOutreachClaimCheckShadow` after the email draft and after the LinkedIn note. It logs one JSON line, `event: outreach_claim_check_shadow`, with channel, lead list ID and counts by kind. No draft text is logged. It never blocks, rewrites or surfaces anything, and an error inside it is swallowed.

A zero count is not proof a draft is grounded. The check cannot see qualitative claims, spelled-out or paraphrased numbers, a supported number attached to the wrong thing, or customer names outside its trigger phrases.
