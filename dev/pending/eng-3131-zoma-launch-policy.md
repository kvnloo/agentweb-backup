## ENG-3131: Zoma launch policy: one $1 trial per user, USD-only Checkout, reads-metering copy (2026-11-17)

Zoma launches to everyone at once (no pilot users), so there is no exemption list. Still dark behind `ZOMA_BILLING_ENABLED`.

- **One trial per user.** A user who has held a Zoma plan before (a cancelled or paused one counts; an `incomplete`/`incomplete_expired` one that never started does not) is sold the plan itself: Checkout has the plan and metered price only, no $1 line, no trial, starting today. The refusal and `zoma_status` say "$50/month, charged today". Before, cancelling on day 6 and buying again gave another trial for $1, indefinitely.
- **USD-only Checkout.** `adaptive_pricing.enabled=false` on the session, because every price in the tool text and email is in dollars (the sandbox Checkout showed INR with a conversion fee). The rehearsal script now asserts it; not yet run against Stripe with this change.
- **Reads copy.** The paywall says reads and drafts are free until the plan starts, after which every successful call, reads included, counts toward the 5,000 (what ENG-3130 specifies).
