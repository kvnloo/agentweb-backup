## ENG-2686: Engagement email + app lifecycle server signals (2026-10-26)

Extends `backend/src/services/serverSignalEmitter.ts` (ENG-2684) with two signal families written to the
hireemma.ai session list via the same `ingestTrackerEvent` path (`acct-<userId>` row; no schema change):

- **Platform email engagement** — `emitResendEngagementSignal` in the Resend webhook maps
  sent/suppressed/opened/clicked/bounced, and complained → `email_unsubscribed`. Only mail FROM
  `RESEND_SYSTEM_EMAIL` (hi@updates.agentweb.pro) qualifies; customer/Emma mail is dropped in the pure
  mapper. Recipient resolved by email to an AgentWeb account; no account → dropped.
- **App lifecycle** — `login` (password + Google), onboarding (`onboarding_completed|skipped|abandoned`,
  other lifecycle events → `onboarding_step_completed {step}`, lateral events skipped),
  `integration_connected {platform}` on first `connectedAccountsDb.createAccount` per account,
  `trial_activated` for a `trialing` `customer.subscription.created`.
- Not wired (no server hook yet): `logout` (client-only), platform `email_unsubscribed` via a preference
  link, `retargeting_audience_added`. Entry points exist (`emitAppSignal`, `emitEmailEngagementSignal`).

All emission is fire-and-forget (`void`), never throws. Tests: `serverSignalEmitter.eng2686.test.ts`.
