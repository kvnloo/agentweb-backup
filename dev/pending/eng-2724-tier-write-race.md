## ENG-2724: Stop a late tier write from restoring a paid tier after cancellation (2026-11-15)

`handleSubscriptionUpdated` writes the tier after a Stripe product lookup that can take seconds. If a `customer.subscription.deleted` for the same customer was handled in that window, the late tier write put the canceled customer back on the paid tier (Opslane run 2009, second P1). The tier write is now conditional on the stored `subscription_status` not being `canceled` or `incomplete_expired`, using the existing `condition` option of `userDb.updateUser`, so DynamoDB checks it in the same operation as the write. A refused write is logged and skipped; any other write error still fails the webhook so Stripe retries. No schema, key or stored-shape change.

Not covered: an `updated` event that arrives entirely after the cancellation still rewrites the status first, as it does on main.
