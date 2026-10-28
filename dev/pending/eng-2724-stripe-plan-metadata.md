## ENG-2724: Stripe webhook syncs Max/custom-price tiers from plan metadata (2026-10-28)

`resolveSubscriptionTypeForPrice` (backend/src/services/stripeService.ts) falls back to
subscription → price → expanded product `metadata.plan` when a price is outside the
Starter/Pro env mapping, accepting it only if `getTierConfig` finds the tier in
`subscription_types` (Super Premium is never granted from metadata). Used by
handleSubscriptionUpdated, the subscription-deleted fallback, and the admin reconcile.
Unmappable prices now log a warning instead of skipping silently.
