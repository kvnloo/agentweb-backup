## ENG-3131: second review round on the Zoma trial paywall (2026-11-17)

- **Reminder cannot repeat.** The "sent" marker is now written before the send. If that write fails nothing is sent (retried next hour); a failed send clears the marker so it retries. Before, a failed marker write after a delivered email could resend every hour until the trial ended.
- **Failed payments never sell a second plan.** A `past_due` or `unpaid` plan now gets "update your card on the existing plan" (portal link when `ZOMA_BILLING_PORTAL_URL` is set) instead of a fresh $1 Checkout.
- **Copy.** The pending-payment message no longer points at a Checkout that is already closed. The day-3 email and the done page say the card is charged automatically after day 7. A cancelled active plan shows "active until <date>, cancelled, it will not renew" (`cancels_at_period_end`).
- **Not changed:** a user who cancelled can still buy another $1 trial (founders to decide), and two simultaneous first paywall hits can still open two Checkouts (the live-plan 410 limits the damage).
