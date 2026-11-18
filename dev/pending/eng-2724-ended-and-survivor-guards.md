## ENG-2724: no metadata tier from ended subscriptions; guarded survivor write (2026-11-15)

- `plan` metadata no longer grants a tier from a subscription whose own status is `canceled` / `incomplete_expired` (admin reconcile and `customer.subscription.updated`). Ended subscriptions keep the env-only Starter/Pro mapping they had before.
- The survivor write in `handleSubscriptionDeleted` is now a conditional write (stored status not ended). If refused, the webhook errors so Stripe redelivers and the retry re-reads live subscriptions.
- The survivor path and admin reconcile read the tier from `findBasePlanItem`, so an extra-seat item sorting first no longer hides a Max base plan.
- Not covered: two `updated` events for a live subscription arriving out of order. There is no event-ordering marker on the user row; adding one is a stored-data change that needs approval.
