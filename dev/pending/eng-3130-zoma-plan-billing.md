## ENG-3130/3131: Zoma $50 plan + $1 trial paywall, dark behind ZOMA_BILLING_ENABLED (2026-11-16)

- **Plan:** $50/month, 5,000 successful tool calls included, then 1¢/call. A call is billable only
  if it succeeded: thrown calls were never metered, and now in-band failures (`success:false`
  that is not a PREVIEW or a write with a read-back verdict) are not metered either
  (`isBillableResult`, `mcp/zomaBilling.ts`). This also removes those failures from
  `mcp_tool_used` analytics.
- **Paywall:** only writes that make ads live (Meta `UPDATE status=ACTIVE`; Google Ads
  `status=ENABLED`) need the plan. Gated in `metaToolkitGateway.ts` before dispatch, preview
  included. Reads, drafts, paused creates, pauses and edits stay free. The refusal carries a pay
  link the agent relays (`/api/zoma/billing/checkout/<cs_id>` → Stripe Checkout).
- **No new persistence.** The plan lives on a Zoma-only Stripe customer
  (`metadata.zomaBillingUserId`, never `metadata.userId` or the user row's
  `stripe_customer_id`), so the Emma subscription code cannot pick it up. Plan state is read
  live from Stripe. Funnel events (`zoma_billing_funnel`) are rows in the existing MCP usage-event
  table. The day-3 reminder marker is subscription metadata (`zoma_trial_reminder_sent_at`).
- **Webhook:** `handleZomaBillingWebhookEvent` runs first in `stripeController.handleWebhook` and
  claims any object tagged `metadata.product=zoma_plan` (sessions, subscriptions, and their
  invoices via `subscription_details.metadata`), so the Emma tier-sync handlers never see them.
- **Stripe setup:** a Billing Meter (event name `zoma_tool_call`, sum aggregation, payload key
  `value`, customer key `stripe_customer_id`); a $50/month licensed price; a metered,
  *graduated* monthly price on that meter with tier 1 = 0–5,000 at $0 and tier 2 = $0.01/unit;
  a one-time $1 price. Enable `checkout.session.expired` on the webhook endpoint.
- **Not yet verified against live Stripe:** that the one-time $1 line item is charged at checkout
  when the subscription starts in trial. Confirm in test mode before turning the flag on.
