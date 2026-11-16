## ENG-2783: hot lead calls add-on, findings from the Stripe sandbox run (2026-11-16)

The real add-on code was run against a Stripe sandbox account (test mode); two problems turned up.

- The idempotency key repeats within a minute, so cancelling the add-on and buying it again at once made Stripe replay the first response, an item that was already removed. The add reported success and mirrored an item that does not exist. It now writes the mirror only when the created item is really on the subscription, and otherwise asks the customer to try again in a couple of minutes.
- The plan lookup (`findBasePlanItem`) skipped only the seat item. The add-on item comes from price_data, so if it ever listed first it would be read as the plan: wrong tier, and a plan change could overwrite the add-on's price. It now skips the add-on item too, and the three tier-derivation sites that read `items.data[0]` use it.
