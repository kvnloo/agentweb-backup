## ENG-668: Stripe's own receipt for the overage invoice, and the extra test-mode cases (2026-10-26)

Owner decision: customers also receive Stripe's successful-payment receipt for the month-end extra usage invoice. It cannot be suppressed per invoice, and turning receipts off account-wide was rejected. So the copy says so: "Stripe will also email you a receipt for the payment." appears in the "invoiced" email's "will charge" wording (`paygInvoiceCreatedEmailCopy`, not the paid, failed, action-required or unconfirmed emails) and in the portal's Extra usage card description. Percentages only: no dollar amounts.

### Extra test-mode cases for the staging rehearsal (beyond PR #3659's plan)

- Receipt timing vs the invoiced email: with an instant charge, which lands first, Stripe's receipt or our "invoiced" email? The email must not contradict the receipt (the `paid` wording covers an invoice already collected when the email goes out).
- Invoice paid from the customer's credit balance: no card charge, so check what Stripe sends (receipt or not) and that the `paid` wording is used.
- Decline sequence: after a failed attempt, read `next_payment_attempt` on the invoice and follow each retry through to the final one; check PAYG goes on hold exactly once and the failed email is sent once.
- 3-D Secure: `payment_action_required` email, then confirm on the hosted invoice and see the hold lift; also leave one unconfirmed past the grace days (unconfirmed email and hold).
- Hosted-invoice payment: pay an open or failed invoice from the hosted invoice page and check `invoice.paid` lifts the hold.
- Void, uncollectible, refund and dispute on a settled invoice: each must leave PAYG state and usage accounting coherent (dispute puts it on hold).

### Live Dashboard settings Harsha must confirm (not testable in code)

- One-off invoice retry policy (Billing > Revenue recovery > Retries): about 3 tries over 1 week, ending with "mark the invoice as uncollectible".
- Failed-payment email setting (Billing > Revenue recovery > Customer emails): on or off as intended, so the customer does not get a Stripe failure email on top of ours, or does when we rely on it.
- 3-D Secure confirmation emails (Settings > Billing > Customer emails): on, since the action-required path relies on the bank challenge being reachable from the invoice.
- Successful-payment receipts stay on (the copy promises them).
