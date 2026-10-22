## ENG-2571: Zoma cards live only in Stripe — portal "Pay as you go" is derived, never stored (2026-10-19)

- Zoma's setup-mode Checkout saves the card on a Stripe customer found by `metadata.userId`
  and never touches AW-Users (ENG-2303). The portal reads the user row, so Zoma users showed
  "Free, no card" and could not open Manage Billing (404 without `stripe_customer_id`).
- Fix keeps the user row untouched: `stripeService.resolveUserPaymentMethod` is the one live
  answer to "card on file, which customer, came from Zoma?". `GET /api/stripe/billing-summary`
  serves it to the portal (never a customer id); the portal-session route uses it for
  non-subscribers. "Pay as you go" is a display label; `subscriptionType` stays `Free`.
- Zoma marker = a succeeded SetupIntent with `metadata.purchaseType === zoma_payment_method`.
  Customer `metadata.source` is NOT reliable: `paymentSetupLink` reuses an existing customer
  (row id or any `metadata.userId` match) before creating a `zoma_mcp` one.
- Plan names are the entitlement key and an unknown name fails OPEN (`getAllowedPages` → all
  pages, token allowance → unlimited). That is why PAYG is not a new `subscriptionType` value.
- Stripe replays an idempotency key for 24h even after the customer is deleted;
  `createCustomerForUser` now chains to a key derived from the dead customer's id.
- `has_payment_method` on the user row is never cleared on customer/card removal, so Zoma
  readiness no longer trusts it.
