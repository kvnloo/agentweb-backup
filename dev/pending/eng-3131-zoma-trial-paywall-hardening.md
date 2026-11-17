## ENG-3131: Zoma trial paywall: reminder delivery, entitlement and cancel tracking (2026-11-17)

Follow-up on the ENG-3130/3131 billing implementation (still dark behind `ZOMA_BILLING_ENABLED`).

- **Day-3 email delivery.** `emailService.sendEmail` never throws; it returns `sent | suppressed | failed`. The job now acts on that: the subscription's `zoma_trial_reminder_sent_at` marker is written only after a send that was not `failed`, so a failed send is retried on the next hourly pass. A `suppressed` send (non-prod mail guard) is marked done and not counted. Staging needs the tester in `NONPROD_EMAIL_ALLOWLIST` to receive it.
- **One send across instances.** `isCronEnabled()` is a drain flag, not leader election. Each pass first claims `(subscription, hour)` with a conditional write on the existing MCP usage-event table (`trial_reminder_claimed`); the loser sends nothing. No new table.
- **Ad performance in the email.** Adds the account-level `zoma_ads_report` summary (Meta) for the trial window when the user has a usable ad account and delivery; otherwise the usage summary alone. Google Ads has no report yet.
- **Entitlement.** `active` always publishes. `trialing` publishes only when the latest invoice (the $1 fee) is expanded and `paid`; otherwise the refusal and `zoma_status` say payment is pending and no second checkout is minted. The invoice of an `active` plan is not consulted, because Stripe keeps a renewal invoice in draft for about an hour.
- **Cancel tracking.** Stripe does not substitute the session id into `cancel_url`, so the cancel redirect carries the user id plus an HMAC (`getJwtSecret`). Landing on it records `checkout_canceled` (once per user per hour). `checkout.session.expired` now records `checkout_expired`.
- **Still to prove in Stripe test mode:** the $1 one-time line with a trial, day-7 conversion, overage invoice and the test-clock/meter-event behaviour. Nothing here has run against Stripe.
