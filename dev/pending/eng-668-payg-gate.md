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

**How overage and the cap are measured.**
- The month's pool = `max(today's effective threshold after credits, poolHighWater for this UTC month)`.
  The high-water mark is written by the gate only when it rises (conditional write) and only for
  opted-in accounts, so a downgrade AFTER opting in never creates retroactive overage.
- Only usage after opting in is overage: the PUT that turns PAYG on (off -> on) records
  `optIn: { month, overageBaselineMicroUsd }` = the overage standing at that moment (same pool measure as
  the gates), subtracted for that month only. This covers a downgrade BEFORE opting in, when no
  high-water mark was kept.
- The cap is stored as `capPercentOfPool` only (25|50|100|200) and re-derived every check as percent x
  the month's pool, so "50% of your plan" stays true across top-ups, plan changes and months. No
  micro-USD cap is stored.

**Data (additive, optional; no table/index).**
- AW-Users (billing owner) `paygOverage`: `{ enabled, capPercentOfPool, poolHighWater?: { month,
  thresholdMicroUsd }, optIn?: { month, overageBaselineMicroUsd }, updatedBy, updatedAt, version,
  suspended?: { reason: 'payment_failed'|'dispute', at, invoiceId? } }`. Settings writes are field-by-field
  and conditional on `version`. `sanitizeUserForResponse` (/api/auth/me etc.) projects it to
  `{ enabled, capPercentOfPool }`.
- `subscription_types` tier `paygOverage: { allowed, markupBps? }`. Admin save (`routes/admin.ts`) and
  GET both carry it; `markupBps` defaults to the tier's `llmUsageTopUp.minimumMarkupBps` and is required
  only when `allowed: true`. The partner-portal tier editor has no fields for it yet and preserves it.

**API.** `GET/PUT /api/subscription/payg` (same auth as `/usage`). Percentages only — no dollars.
PUT errors (`{ error: <code> }`): 404 `payg_unavailable`, 403 `not_billing_owner`, 403
`delegate_cannot_consent` (a delegated admin may turn PAYG off or lower the cap, never turn it on or raise
it), 400 `invalid_request`, 422 `invalid_cap`, 409 `payment_method_required` (live Stripe check on
enabling), 503 `payment_check_unavailable`, 409 `payg_conflict` (version moved). Disabling never calls
Stripe and is allowed even if the tier stops offering PAYG.

**429 / runway copy.** `usageBlock.reason` is added only for PAYG's own blocks: `payg_cap_reached`,
`payg_suspended`, `payg_inactive` (+ `usageBlock.paygInactiveReason`: `no_payment_method` |
`subscription_inactive`). `code: 'usage_paused'` is unchanged everywhere. The scheduled-chat run result
and the token-limit email name the PAYG reason instead of a >100% plan figure. While PAYG is admitting,
`/usage-runway` returns `paygCovering: true` and withholds the exhaustion forecast (`onTrack`,
`estimatedDaysRemaining`, `estimatedExhaustionDate` null).

**Known gaps.** `getCurrentMonth()` in tokenUsageService is still local time (UTC on the fleet, so no
effect today); left alone. `sanitizeUserForResponse` still passes `llmUsageCredits` (micro-USD) through —
pre-existing, not changed here.
