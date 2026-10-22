## ENG-668: Pay-as-you-go month-end settlement through Stripe, shipped dark (PR-2) (2026-10-20)

**What.** PR-1 let an opted-in billing owner keep working past the plan pool up to their cap. PR-2 bills
that overage once the month closes: a daily sweep invoices each owner's previous month in Stripe and
charges the card on file, and the invoice webhooks record the outcome (and suspend PAYG on a failed or
disputed charge). **Data-plane change — needs Harsha's approval before merge** (new off-session charges,
new webhook branches, new AW-Users attributes, credit-ledger rollover).

**Switch.** AW-Settings `payg_settlement_enabled`, separate from the gate's `payg_overage_enabled`. Only
the exact string `true` turns it on (same reader and ~60s cache as PR-1's switch). The switch gates NEW
charges only. Off = the sweep returns before reading anything, and the refund webhook makes no extra Stripe
call (byte-identical to before). Ships off. Every invoice webhook for an overage invoice already issued,
and both dispute webhooks, are handled either way: a chargeback on an overage charge still holds PAYG,
and closing it still lifts (or keeps) that hold. For any other charge a dispute's outcome is unchanged; it
costs one more Stripe call (`invoicePayments.list`), and a failure of that call answers 500, which is the
same failure the existing `charges.retrieve` already has.

**Schedule.** `cron/paygSettlementCron.ts`, registered in server.ts at 12:00 UTC daily (after the 10:00
seat-credit sweep; `utils/dailySchedule.ts` anchoring). Day 1 of a month: nothing. From day 2 it scans
owners with a `paygOverage` record and, one owner-month at a time (a failure is counted with its owner and
month and never stops the rest), works the last 12 months: any admitted month with no settlement record
(normally just the month that closed), any month still `pending` (a dead run's draft is never orphaned),
and any month set to `retry` by hand.

**Rollout note.** Turn `payg_settlement_enabled` on no later than the gate's switch. Admitted months older
than the month that just closed have lost their credits / pool mark / opt-in from the row, so a backlog
(settlement switched on months after the gate) is held as `inputs_unavailable` — one alert per owner-month,
nothing billed — rather than billed blind.

**What is billed — only what was in force DURING the month** (`services/paygSettlement.ts`, pure).
Nothing written after month M ends can change M's bill:
- The gate writes `paygOverage.admittedMonths` (newest first, 13 months: the current one plus settlement's
  12-month window) on PAYG admissions:
  `{ month, capHighWaterMicroUsd, tierPoolHighWaterMicroUsd, markupBps, spendBasis }` — the highest cap
  (`capPercentOfPool` x that moment's pool) and plan pool (tier hard threshold before credits), the
  lowest markup, and the spend basis (`spend_ledger` | `legacy` | `mixed`) any admission that month was
  measured against. Conditional on the list it read; written only when an admission changes it.
- **Only a turn gate writes PAYG state.** `checkTokenUsage(userId, TURN_ADMISSION)` — passed only where a
  turn is about to run (/generate, chat, the socket, MCP, scheduled and auto-continued runs, Compare, shared
  sessions, verified chat) — may write the pool high-water mark and the admission record. Everything that
  only reads usage (gate 2 / model resolution, the PAYG settings view, runway, drivers, decline, model lists,
  `GET /usage`, the admin view) gets the same decision and writes nothing, so reading usage can never make
  a month billable or raise its cap.
- A month is billed only if its admissions were measured on the spend ledger throughout
  (`spendBasis === 'spend_ledger'`); `legacy` or `mixed` is held `legacy_spend_basis`. The cutover
  setting at settlement time plays no part.
- Settlement uses that record, never the cap setting or tier as they stand at settlement. **The cap is a
  monthly total** (product decision): raising it during the month applies to the whole month, including
  overrun admitted earlier in it; lowering it after the usage still bills what was admitted; no change
  after the month (cap, plan, markup) reaches back. The consent copy must say so ("Your limit applies to
  the whole month").
- Overage = `paygNetOverageMicroUsd` (extracted from the gate's `measurePaygOverage`, which now calls it)
  over the gate's pipeline (`applyLlmUsageCredits` -> `paygOverageThresholdMicroUsd`) on the month's own
  plan pool, credits, pool mark and opt-in. The credits, pool mark and opt-in come from the row only while
  M is the month that just closed (each is kept one month past its own), and are frozen on the settlement
  record (`inputs`) the first time M is measured, so any later re-measurement (`retry`) uses M's own. Spend = settled AW-SpendEvents for the month, checked against the
  persisted projection the gate read within max(50c, 1% of settled spend) (`paygSpendDriftTolerable`): the
  projection is a best-effort ADD per settled batch (failures swallowed) and trails the events by a few
  events' cost in normal operation, which leaves the bill (computed from the events) untouched; a broken
  ledger moves a month by whole events and passes 1%, and that is still held.
- Billable = min(overage after the opt-in baseline, the month's `capHighWaterMicroUsd`) x `markupBps`/10000,
  rounded down to µ$, then to whole cents.

**Opt-in baseline (PR-1 fix).** An off -> on re-measures the month's baseline only on the month's first
opt-in AND only if PAYG has not admitted anything in that month. Once it has, the month keeps its baseline
(0 for an opt-in carried over from an earlier month), so a toggle cannot reset the cap.

**Never billed / held.** A month PAYG never admitted a turn in is never billed. 0 cents ->
`nothing_to_bill` (no_overage); under Stripe's 50c minimum -> `nothing_to_bill` (below_minimum). `held`
(no charge; on-call is told in ONE alert per daily run listing every month that run held, `Alert Class:
payg-settlement-held`. The write that holds a month also sets `alertPending` on it, which is cleared only
after the alert went out. A sweep that dies, or whose alert fails, before alerting is caught up at the
start of the next sweep. Delivery is at least once.) for: spend drift or real spend with no
projection; an owner the gate measured on the legacy counter; no valid markup recorded for the month;
unmeasurable state; no live Stripe customer; Stripe's total not the recorded amount (a customer discount
or coupon — a credit balance lowers `amount_due`, not the total); or the invoice the record names is void,
deleted or unknown to Stripe (recorded as `uncollectedInvoice`, never invoiced over automatically — e.g. a
draft deleted on a mismatch whose hold write was lost). The alert says what to do: with an invoice id on
the record, **never** remove the record (check the invoice in Stripe; void it there if it must not be
collected); otherwise, once the cause is fixed, **set `paygSettlements.<month>.status` to `retry`**
(do not delete the record — it holds the frozen inputs): the next daily run re-measures the month from them
and fresh spend and searches Stripe before creating anything. Wording per case: a deleted draft was never
finalized (nothing collected); a **void** invoice was finalized and voided by someone in Stripe — check
whether a payment was taken before it was voided; a missing one is deleted or unknown to Stripe. A month
with no record that is older than the month that just closed is held as `inputs_unavailable`.

**Idempotency.** `paygSettlements[M]` is written with `attribute_not_exists` BEFORE any Stripe call
(`pending`, amount fixed); only `pending` is ever resumed, with the stored amount. With no invoice id on
the record, Stripe is ALWAYS searched (`metadata` purchaseType + billingUserId + month, void ones ignored)
before anything is created. Writes carry keys `payg:{billingUserId}:{M}:{record createdAt}` + `:invoice` /
`:item` / `:finalize` (covers search-index lag; a record re-created after a cleared hold starts fresh). The
invoice id is recorded as soon as it is known. In the search, an EMPTY draft over an hour old (a run that
died before recording its id, key since expired) is deleted, never adopted; if more than one live invoice
remains for the month, nothing is picked — the month is held `multiple_invoices` with their ids. The draft is `auto_advance: false` +
`pending_invoice_items_behavior: 'exclude'`; **its total is compared with the recorded amount before
finalizing** — on a mismatch (a customer discount or balance) the draft is deleted and the month held,
nothing finalized or collected. Finalize sets `auto_advance: true`, so Stripe charges. Customer =
`stripeService.resolveUserPaymentMethod(user, userId).customerId` (ENG-2571). A payment method is pinned on
the invoice (`default_payment_method`) ONLY when the customer has no invoice default — an invoice's own
method overrides the customer's for every automatic retry, so pinning would keep charging the old card after
the owner updates theirs. A customer who saved their card through the setup-mode Checkout (ENG-2571) has
no invoice default, so their invoice IS pinned. `setup_intent.succeeded` therefore points every OPEN
overage invoice of that customer that is pinned to another method at the newly saved one
(`invoices.update default_payment_method`; key `payg-repoint:{invoice}:{pm}`), and Stripe's next retry
charges it. It re-points only to the customer's NEWEST attached card (`paymentMethods.list({customer,
type: card})`), because events are not ordered: an older card's late event never moves the invoice back,
and a detached or non-card method is never used. Finding the invoices depends on the SetupIntent:
- Tagged with the user (Zoma's Checkout): one indexed row read.
- Untagged: one Stripe call, `invoices.list({customer, status: open})`. AW-Users has no
  `stripe_customer_id` index, so the account is not looked up by scanning the table.

Either way an invoice is moved only while its owner's settlement record still names it as unpaid. If
that lookup fails, the error is logged and the event acknowledged. If Stripe refuses one update (the card
was detached meanwhile), the refusal is logged, the other invoices are still re-pointed, on-call is
alerted once (`payg-settlement-repoint`) and the webhook is acknowledged. No checkout, customer or
subscription field is touched. An
invoice Stripe already collected when settlement adopts it is recorded `paid`. Records older than 12 months are pruned in the same write.

**Webhooks.** `handleInvoicePaymentSucceeded/Failed` hand any `metadata.purchaseType === 'payg_overage'`
invoice to `paygSettlementService` before touching anything, so an overage invoice never writes
`subscription_status`, `subscription_amount`, period or offer fields. Paid -> `paid`. Failed -> `failed`,
`paygOverage.suspended = {reason:'payment_failed', at, invoiceId}` (PR-1's gate refuses while set), one
owner email. **The payment-failure suspension lasts while ANY month is `failed`.** A failure event may set
`suspended` only while the month's record says THAT invoice failed (`status = failed` AND `invoiceId`,
checked in the same write), so a failure that lost a race with the payment, or names an invoice settlement
set aside, never suspends. The event that newly fails a month re-stamps `suspended` (`at` and `invoiceId`;
never over a dispute); a redelivered failure for a month already failed changes nothing. A paid webhook
lifts the suspension only if a strongly consistent read taken AFTER its own `paid` write shows no month
still failed AND `suspended` is still exactly the value that read saw — so of two months paid at once at
least one webhook sees both paid, and a month that fails after the read (even one created after it) keeps
the suspension. Paying never lifts a dispute suspension.
**3-D Secure.** For a payment that needs authentication, Stripe sends `invoice.payment_failed` as well as
`invoice.payment_action_required` (the PaymentIntent is then `requires_action`). Before failing a month,
the failure handler reads the invoice's default invoice payment
(`invoicePayments.list({invoice, expand: data.payment.payment_intent})`; Basil has no
`invoice.payment_intent`). `requires_action` is not a failure: nothing is suspended, no failure email is
sent, the month stays `invoiced`, and the owner gets the once-only "confirm your payment" email. The
first such report stamps `actionRequiredAt` (once; a later report never moves it). If the PaymentIntent is
`succeeded`, `processing` or `requires_capture` (the owner confirmed late, or a bank debit is in flight),
it is not a failure either, and `invoice.paid` follows. A decline or a failed authentication
(`requires_payment_method`), `canceled`, `requires_confirmation`, or no PaymentIntent at all still fails
the month. If the lookup fails, the webhook answers 500 and Stripe redelivers; the handler never guesses.
**A payment never confirmed.** Suppose a month is still `invoiced`
`PAYG_PAYMENT_CONFIRMATION_GRACE_DAYS` (7) days after `actionRequiredAt`, and Stripe still has its
payment waiting or declined. The daily sweep then treats it as unpaid: the month becomes `failed`
(`paymentUnconfirmedAt`), PAYG is held (`{reason: payment_failed, unconfirmed: true}`), and the owner is
sent one email with the invoice to confirm it. The `invoiced -> failed` write is the dedupe. Paying or
confirming the invoice lifts the hold like any payment failure. A payment that went through or is
processing is left for its `invoice.paid`. Every webhook ignores (logs) an invoice the record set aside
(`uncollectedInvoice`). A record that names no invoice yet (a `pending` re-created by `retry`) accepts an
event only for the invoice its own run created: this record's key AND its `createdAt` in the invoice
metadata (`recordCreatedAt`, stamped at creation; the key alone is the same for every record of the
month), and not void. So a late `invoice.voided`, or a redelivered failure, for an older invoice of the
month never touches the new record. An older live invoice that the run's search adopts becomes the
record's as soon as the run records its id. A `held` record that carries the invoice's id is moved to paid/failed too. Dispute on
an overage charge -> `suspended = dispute` (see Disputes below). Refund -> `refundedCents` (cumulative,
only ever raised), PAYG not resumed. Overage recognition uses PaymentIntent -> `invoicePayments.list` ->
invoice metadata (Basil). For refunds it runs only while the switch is on; for disputes it always runs. A failed lookup on a **dispute** errors the webhook (500) so Stripe redelivers — a chargeback must
never be dropped; on a **refund** the refund is recorded as before and on-call is alerted
(`payg-settlement-lookup`). `resyncAllSubscriptionAmounts` skips overage invoices. The webhook controller
records overage invoices neither as subscription payments (`payment_succeeded` / `payment_failed`, which
`accountHealthClassifier` reads as subscription health) nor in the CRM mirror; settlement records them
under their own payment-history types, `payg_overage_payment_succeeded` / `payg_overage_payment_failed`
(deduped per invoice) — kept for the billing audit trail, invisible to the classifier.

**Closed-month state (additive, optional attributes).**
- `llmUsageCreditsClosed`: kept by the write that rolls `llmUsageCredits` into a new month
  (`grantMonthlyLlmUsageCredit` incl. the admin transaction, `recordLlmUsageDebit`), without the per-debit
  list — **only for an account with a `paygOverage` record**; every other account's rollover is unchanged.
- `paygOverage.poolHighWaterClosed` (gate's first mark of a month, conditional on the exact mark it read;
  the settings opt-in also keeps it) and `paygOverage.optInClosed` (the month's first opt-in).
- `paygOverage.admittedMonths` (above) and `paygSettlements` (AW-Users, by month): `{status,
  idempotencyKey, overageCostMicroUsd, billedMicroUsd, amountCents, markupBps, percentOfCap,
  settledMicroUsd, projectedMicroUsd, createdAt, updatedAt, inputs?, retriedAt?, invoiceId?, uncollectedInvoice?,
  heldReason?, nothingToBillReason?, invoicedAt?, paidAt?, failedAt?, refundedCents?, dispute?}`.
`sanitizeUserForResponse` drops `paygSettlements` and `llmUsageCreditsClosed`.

**Invoice lifecycle (webhooks beyond paid/failed).** The Stripe webhook endpoint **must subscribe to**
`invoice.voided`, `invoice.marked_uncollectible`, `invoice.payment_action_required`,
`charge.dispute.closed` and `setup_intent.succeeded` (besides the invoice paid/failed and dispute/refund events it already has).
- `invoice.voided` (support forgave it): the month becomes `written_off` (`writtenOffReason: invoice_voided`,
  invoice id kept), a payment-failure suspension is lifted once no other month is `failed` (never a
  dispute), one on-call alert. Settlement never re-invoices it (only a hand-set `retry` would, after a search).
- `invoice.marked_uncollectible`: the month stays (or becomes) `failed` with PAYG suspended, `uncollectibleAt`
  recorded; the invoice can still be paid on its hosted page, and `invoice.paid` then lifts as usual.
- `invoice.payment_action_required` (3-D Secure, a mandate): the month stays `invoiced`, nothing is
  suspended; the owner gets one email with the hosted page to confirm the payment.
- Disputes are tracked one by one: `paygSettlements.<month>.disputes.<disputeId> = {at, status?, closedAt?}`.
  Opening a dispute records it open AND (re-)stamps `suspended = {reason: dispute, at, invoiceId,
  disputeId}` in ONE conditional write, and pages on-call once. A dispute already recorded closed is final.
  A `created` that arrives after its `closed` (reordered, retried or resent) changes nothing: no hold, no
  history row, no page. `charge.dispute.closed` records the closing once. If the dispute was won (or was a
  closed inquiry), the hold is lifted only when NO dispute on the account is still open, and only if the
  hold was set by a recorded dispute (its `disputeId` is one of them, so a hold set by hand stays). If
  another month is still failed, the hold becomes that month's payment-failure hold. That write is also
  conditional on THAT month still being `failed` on that invoice: if it is paid or voided after the read,
  the write fails and the lift reads again, so the account is never held for a month that is settled.
  The lift's write is conditional on `suspended` being exactly what it read. A dispute opened after that read re-stamps the
  hold. A month that fails under a dispute hold stamps `suspended.paymentFailedAt`. Either one makes the
  lift's write fail; the lift then reads again (up to 5 times, then 500 and Stripe redelivers). If the
  dispute was lost, the month is written off (`dispute_lost`) and PAYG is held as `{..., lost: true}` in
  the same write that closes the dispute. Only a person lifts a lost hold: winning another dispute does
  not, and a redelivered `lost` never re-imposes a hold someone removed.
- Refunds on an overage charge: one payment-history row PER Stripe refund, with that refund's own amount
  (`refunds.list({charge})`; a webhook's charge carries no refunds), deduped by refund id (`refund:<re_id>`).
  Two partial refunds of $12 and $8 are two rows summing to $20. (The pre-existing non-PAYG refund path
  still records the charge's cumulative `amount_refunded`, without a dedupe key. Unchanged, a follow-up.)
- A cancellation scheduled for the period end (`subscription_status: canceling`) keeps PAYG covering, like
  the plan itself; only `canceled` (or past_due etc.) is `subscription_inactive`.
- The owner of a suspended account is pointed at the unpaid invoice. `GET /api/subscription/payg` returns
  `openInvoiceUrl` (newest month still `failed`; no amount), and the 429 `usageBlock` carries
  `openInvoiceUrl` with `reason: payg_suspended`. Both are owner only and never under a dispute hold
  (open or lost), because paying an invoice does not lift that. Both are read from settlement records,
  with no Stripe call. The block names why (`paygSuspendedReason`: `payment_failed` |
  `payment_unconfirmed` | `dispute` | `dispute_lost`), and the copy says what lifts it:
  - payment failure: "Pay the open invoice to resume pay-as-you-go."
  - unconfirmed payment: "Open the invoice to confirm the payment and resume pay-as-you-go."
  - dispute: "…while a recent payment is under review with your bank. Please contact us…"
  - lost dispute: "…following a dispute about a recent payment. Please contact us…"

  A pooled member (`paygOwnerResolves`) is told "Your organization owner can resolve this." instead. The
  copy no longer says "update your payment method", because updating a card does not pay an open invoice.

**Emails.** Copy in one place: `utils/paygSettlementCopy.ts` (needs copy review). Invoice created: sent
exactly once per month (`emailedAt`, claimed conditionally on the invoice AND the state it describes). It is
sent only by the write that recorded the month: the run, when it moved the month to invoiced or paid, or an
`invoice.paid` that beat it. The paid wording ("...and it has already been paid") is used when Stripe
already collected it: paid at adoption, paid before the run, or a held month's invoice paid later. A failure
or void that landed first means no invoice email, so the owner never reads "will charge your card" after
"didn't go through". The email states the month and the percentage of the **highest** limit the owner had set that month (the bill follows
that limit, so the percentage matches the amount), plus the Stripe invoice link — no dollars. Payment
failed: PAYG on hold, update the card and pay the invoice. Payment needs confirming (new): the bank asked
for confirmation; open the invoice to confirm; PAYG stays on. Payment still unconfirmed after 7 days (new, rv6): PAYG on hold until it
is confirmed; open the invoice to confirm it.

**Rollback.** Set `payg_settlement_enabled` to anything but `true`: the sweep stops within ~60s and the
refund/dispute webhooks return to exactly today's handling. A month left `pending` stays pending (no new
charge); if the switch returns it resumes with the stored amount and Stripe is searched first, so nothing
is charged twice. Invoices already issued are Stripe's to collect; their webhooks keep being recorded. To
stop collecting one, void it in Stripe: the month is written off (never billed again), and if it was the
only unpaid month the customer's PAYG hold is lifted.

**How to run the real-runtime suites.** Two opt-in suites run the money paths against real runtimes
instead of the unit suites' in-memory row fake (`__tests__/helpers/userRowFake.ts`) and hand-written
Stripe fakes. Both are `describe.skip` unless their env var is set, so CI never runs them; run them by hand
before changing a condition expression or a Stripe call. From `backend/`:
```bash
docker run -d --rm --name ddb -p 127.0.0.1:8124:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -inMemory
docker run -d --rm --name smock -p 127.0.0.1:12111:12111 stripe/stripe-mock:v0.195.0   # bundles 2025-05-28.basil
DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8124 npx jest src/__tests__/paygOverage.dynamodbLocal.test.ts
STRIPE_API_BASE=http://127.0.0.1:12111 npx jest src/__tests__/paygSettlement.stripeMock.test.ts
docker stop ddb smock
```
- `paygOverage.dynamodbLocal.test.ts` creates its own AW-Users (`email` key, `UserIdIndex`) and
  AW-PaymentHistory tables and drives the production writers — the turn gate (mark, admission record,
  rollover), the credit-ledger rollover (`llmUsageCreditsClosed`, incl. the admin transaction), the
  settings PUT (version, opt-in baseline, closed copies, payment-method repair), settlement (`pending`
  lock, every transition, frozen inputs, `retry`, `uncollectedInvoice`) and the suspension set/lift —
  with each race forced at an exact point, so DynamoDB itself decides the loser. It also pins where the
  row fake differs from DynamoDB (`<>` on a missing attribute is true in DynamoDB; REMOVE below a missing
  parent, unused expression names/values and overlapping paths are ValidationExceptions the fake accepts).
  DynamoDB Local updates GSIs synchronously, unlike production's `UserIdIndex`.
- `paygSettlement.stripeMock.test.ts` sends every Stripe request the PR makes through the real SDK to
  stripe-mock, which rejects any parameter the pinned API version does not accept, and checks every field
  the code reads exists in that version's objects; the webhook controller is driven with real signatures.
  stripe-mock is stateless, so it proves request and response shapes, not Stripe's behaviour (search,
  idempotency replay, discounts, deletion).

**Follow-ups (known, not fixed here).** A closed high-water mark can be stale if a check raises it in the
last instant of a month while another rolls it over; a higher mark lost to a month-change race is only
saved at the next check; `mrrCollectionGapService` counts
paid overage invoices as "has ever paid"; a
refund of a closed month's top-up after the month ends is not reflected in `llmUsageCreditsClosed`
(billed less, never more); `capHighWaterMicroUsd` includes revocable top-up credit in the pool it is a
percentage of (the pool mark excludes it — within the consent given at the time); the gate records the
admission month with `getCurrentUsageMonth()` while its caller's billing month comes from
`getCurrentMonth()` (identical on the UTC fleet; pre-existing). With settlement switched off, the
7-day unconfirmed-payment check does not run (it is part of the sweep).
