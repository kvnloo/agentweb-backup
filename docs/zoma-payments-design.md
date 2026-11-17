# Zoma payments: design and launch gates

## Source of truth

This is a follow-up to [billing PR #4156](https://github.com/AgentWebPro/agentweb/pull/4156), not a second billing stack. That PR implements ENG-3130/3131. This branch is stacked on `yugo/eng-3130` and must be reviewed/merged after it (or cherry-picked into it).

Confirmed requirements from Harsha's Slack DM (`D0BV3GUHULX`):
- `1794866660.361669`: “instead of 49/mo let's just do 50/mo for 5K calls.” This supersedes the older $49/4,900 proposal.
- `1794866551.773449` and `1794866691.144789`: successful-call metering, 1¢/call overage; no card at signup; first-publish paywall; $1 for seven days, then $50/month; day-3 reminder; off-by-default billing.
- Existing implementation and its current test limitations were discussed at `1794874271.334639`.

The requested Bookface post, https://bookface.ycombinator.com/posts/128626, redirected to YC account login. No YC login was available in the browser vault. Its contents have **not** been read or inferred; comparing this design with that post is still a launch prerequisite.

## Architecture retained from #4156

1. Signup, ad-account connection, read-only queries and draft creation have no subscription gate.
2. The gateway intercepts writes that activate ads before calling Meta/Google. Without entitlement, the agent relays a hosted Stripe Checkout link.
3. Checkout has a one-time $1 line and a seven-day subscription trial. Afterwards a $50 licensed monthly price plus a graduated metered price (first 5,000 calls $0, then $0.01/call) is billed by Stripe.
4. Zoma uses a dedicated Stripe customer, tagged `zomaBillingUserId`; Emma customer ids and user subscription tiers are untouched.
5. Only successful tool results reach usage metering. Subscription state is read from Stripe; existing MCP usage rows provide display/funnel reporting.
6. Stripe owns invoice/subscription state. Webhooks are isolated from Emma handlers. The hourly reminder is inherited from #4156.
7. `ZOMA_BILLING_ENABLED` remains off unless explicitly configured. This branch does not set flags, create prices, deploy, charge cards or touch ad accounts.

## Safety correction in this branch

A `trialing` subscription can exist before payment of its one-time trial invoice completes. Subscription status alone is therefore not proof of the required $1 payment.

- Expand `data.latest_invoice` on the subscription list read.
- Allow publishing only when status is `trialing` or `active` **and** the expanded latest invoice has `status=paid`.
- Missing, unexpanded, draft, open and void invoices fail closed. A canceled/past-due/unpaid/incomplete/paused subscription stays blocked even if its last invoice was paid.
- A pending payment on an otherwise live subscription returns a pending-payment explanation, not another subscription checkout. `zoma_status` has the same entitlement and does not display a checked plan or offer a second trial in that state.
- No new persistence or data-plane changes.

## Required evidence before enabling live billing

- Read the Bookface post with authorized YC access and reconcile any additional requirement.
- Complete the real hosted Checkout journey in Stripe **test mode**, including asynchronous/unpaid states. Prior Slack claims of direct test-mode subscription creation are not hosted-checkout evidence and were not rerun here.
- Verify $1 invoice payment, trialing entitlement, day-7 $50 conversion and an invoice for usage above 5,000. Verify cancellation and payment-failure behavior. No real ads need to run.
- Validate configured Stripe price amounts/currency, recurring cadence, meter and graduated tiers against displayed config. The current implementation trusts price ids; env copy alone is not price validation.
- Decide whether “reads/drafts are free” means before subscription only or forever. #4156 meters every successful gateway call once a billing customer exists, including reads/previews during a paid billing period. Do not promise permanently unmetered reads without changing that implementation.
- Resolve existing #4156 risks: concurrent/repeated checkout sessions, retry/reconciliation for failed fire-and-forget Stripe meter sends, cancellation tracking only on session expiry, and multi-instance reminder claiming (subscription metadata writes are not atomic locks).
- Require the customer-visible billing announcement and explicit live-enablement approval. A successful CI build is not evidence of any live payment.

## Verification and rollback

Negative tests reproduce the unpaid-invoice publish bug before the fix and verify both the entitlement rule and pending-payment presentation. Existing billing tests retain explicit paid-invoice fixtures. Scoped Jest only; no full-repository test/typecheck or staging/prod deployment is required for this draft.

Rollback: keep billing disabled. If enabled later, unset `ZOMA_BILLING_ENABLED` to remove the publish gate/meter path. This correction itself can be reverted without any migration; reverting while billing is enabled reintroduces the unpaid-trial entitlement gap.
