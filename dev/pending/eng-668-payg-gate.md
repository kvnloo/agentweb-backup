## ENG-668: Pay-as-you-go overage gate and settings, shipped dark (PR-1) (2026-10-19)

**What.** A billing owner can opt their usage pool into pay-as-you-go: past the plan's hard cost threshold
they keep working up to a cap they chose, instead of getting the 429 `usage_paused`. PR-1 is the gate and
the settings only; it charges nothing. Settlement (metering the overage and billing it in Stripe, and
setting `suspended` when a charge fails) is PR-2.

**Switch.** AW-Settings row `payg_overage_enabled`. Only the exact string `true` turns it on; absent, any
other value, or a cold-start read failure is off. Cached ~60s per process (same pattern as
`work_plan_step_models_enabled`). Off = byte-identical admission to before, proven for both gates in
`paygOverage.gates.test.ts`. **Rollback: set the row to anything but `true`** (takes effect within ~60s);
stored opt-ins are inert while it is off.

**Where the decision lives.** `services/paygOverage.ts` `evaluatePaygAdmission` (pure). Both gates —
`checkTokenUsage` and `getEffectiveLlmUsagePolicy` (which `resolveEffectiveModelForUser` turns into the
/generate 429 and scheduled `usage_paused`) — now share `services/llmUsagePoolDecision.ts`
`resolveLlmUsagePoolDecision` (spend basis -> credits -> hard threshold -> PAYG). Never apply PAYG in one
gate only: gate 1 would admit a turn gate 2 then refuses. It acts only on `hard_threshold_reached` and
admits (`reason: 'payg_overage'`, `full_choice`) only when the switch is on, the tier has
`paygOverage.allowed === true`, the owner has `paygOverage.enabled === true` and no `suspended`,
`has_payment_method === true`, `subscription_status` is active/trialing, and overage < cap. Anything
missing keeps the 429. A non-opted account never reads the switch or writes anything.

**Data (additive, optional; no table/index).**
- AW-Users (billing owner) `paygOverage`: `{ enabled, capPercentOfPool: 25|50|100|200, capMicroUsd,
  poolHighWater?: { month, thresholdMicroUsd }, enabledBy, updatedAt, version, suspended?: { reason:
  'payment_failed'|'dispute', at, invoiceId? } }`. `capMicroUsd` is frozen at set time (percent x the
  effective pool after credits). Settings writes are field-by-field and conditional on `version`;
  `poolHighWater` is written by the gate only when it rises (conditional on the stored mark being lower)
  and only for opted-in accounts. Overage is measured above `max(today's pool, this month's high-water)`,
  so a mid-month downgrade never creates retroactive overage. High-water month is UTC
  (`getCurrentUsageMonth`).
- `subscription_types` tier `paygOverage: { allowed, markupBps }`. Admin save (`routes/admin.ts`) and GET
  both carry it; `markupBps` defaults to the tier's `llmUsageTopUp.minimumMarkupBps` and is required when
  there is none. The partner-portal tier editor has no fields for it yet and preserves it on save.

**API.** `GET/PUT /api/subscription/payg` (same auth as `/usage`). Percentages only — no dollars.
PUT errors: 404 `payg_unavailable`, 403 `not_billing_owner`, 400 `invalid_request`, 422 `invalid_cap`,
409 `payment_method_required` (live Stripe check on enabling), 503 `payment_check_unavailable`,
409 `payg_conflict` (version moved). Disabling never calls Stripe and is allowed even if the tier stops
offering PAYG.

**429 copy.** `usageBlock.reason` (`payg_cap_reached` | `payg_suspended`) is added only for those blocks;
`code: 'usage_paused'` is unchanged everywhere.

**Known gap.** `getCurrentMonth()` in tokenUsageService is still local time (UTC on the fleet, so no
effect today); it was left alone.
