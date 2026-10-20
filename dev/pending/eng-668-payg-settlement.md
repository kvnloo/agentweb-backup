## ENG-668: Pay-as-you-go month-end settlement through Stripe, shipped dark (PR-2) (2026-10-20)

**What.** PR-1 let an opted-in billing owner keep working past the plan pool up to their cap. PR-2 bills
that overage once the month closes: a daily sweep invoices each owner's previous month in Stripe and
charges the card on file, and the invoice webhooks record the outcome (and suspend PAYG on a failed or
disputed charge). **Data-plane change — needs Harsha's approval before merge** (new off-session charges,
new webhook branches, new AW-Users attributes, credit-ledger rollover).

**Switch.** AW-Settings `payg_settlement_enabled`, separate from the gate's `payg_overage_enabled`. Only
the exact string `true` turns it on (same reader and ~60s cache as PR-1's switch). Off = the sweep returns
before reading anything, and refund/dispute webhooks make no extra Stripe call (byte-identical to before).
Ships off. Invoice paid/failed webhooks for overage invoices already issued are handled either way.

**Schedule.** `cron/paygSettlementCron.ts`, registered in server.ts at 12:00 UTC daily (after the 10:00
seat-credit sweep; `utils/dailySchedule.ts` anchoring). Day 1 of a month: nothing. From day 2 it scans
owners with a `paygOverage` record and, one owner-month at a time, settles the previous month when
`paygOverage.admittedMonths` has a record for it, and resumes any month of the last 12 still `pending`
(a dead run's draft is never orphaned).

**What is billed — only what was in force DURING the month** (`services/paygSettlement.ts`, pure).
Nothing written after month M ends can change M's bill:
- The gate writes `paygOverage.admittedMonths` (newest first, at most 2) on PAYG admissions:
  `{ month, capHighWaterMicroUsd, tierPoolHighWaterMicroUsd, markupBps }` — the highest cap
  (`capPercentOfPool` x that moment's pool) and plan pool (tier hard threshold before credits) and the
  lowest markup any admission that month was measured against. Conditional on the list it read; written
  only when an admission changes it (first of the month, a higher cap/pool, a lower markup).
- Settlement uses that record, never the cap setting or tier as they stand at settlement: lowering the cap
  after the usage still bills what was admitted; raising it after the month never reaches back; a plan or
  markup change after the month leaves the bill unchanged.
- Overage = `paygNetOverageMicroUsd` (extracted from the gate's `measurePaygOverage`, which now calls it)
  over the gate's pipeline (`applyLlmUsageCredits` -> `paygOverageThresholdMicroUsd`) on the month's own
  plan pool, credits, pool mark and opt-in. Spend = settled AW-SpendEvents for the month, reconciled with
  `reconcileProjection` against the persisted projection the gate read (1 µ$, the §3 invariant).
- Billable = min(overage after the opt-in baseline, the month's `capHighWaterMicroUsd`) x `markupBps`/10000,
  rounded down to µ$, then to whole cents.

**Opt-in baseline (PR-1 fix).** An off -> on re-measures the month's baseline only on the month's first
opt-in AND only if PAYG has not admitted anything in that month. Once it has, the month keeps its baseline
(0 for an opt-in carried over from an earlier month), so a toggle cannot reset the cap.

**Never billed / held.** A month PAYG never admitted a turn in is never billed. 0 cents ->
`nothing_to_bill` (no_overage); under Stripe's 50c minimum -> `nothing_to_bill` (below_minimum). `held`
(no charge, one on-call alert, `Alert Class: payg-settlement-held`) for: spend drift or real spend with no
projection; an owner the gate measured on the legacy counter; no valid markup recorded for the month;
unmeasurable state; no live Stripe customer; Stripe's total not the recorded amount. The alert says what to
do: with an invoice id on the record, **never** remove the record (check the invoice in Stripe; void it
there if it must not be collected); with none, nothing was collected — fix the cause, then remove
`paygSettlements.<month>` and the next run settles it again.

**Idempotency.** `paygSettlements[M]` is written with `attribute_not_exists` BEFORE any Stripe call
(`pending`, amount fixed); only `pending` is ever resumed, with the stored amount. With no invoice id on
the record, Stripe is ALWAYS searched (`metadata` purchaseType + billingUserId + month, void ones ignored)
before anything is created. Writes carry keys `payg:{billingUserId}:{M}:{record createdAt}` + `:invoice` /
`:item` / `:finalize` (covers search-index lag; a record re-created after a cleared hold starts fresh). The
invoice id is recorded as soon as it is known. The draft is `auto_advance: false` +
`pending_invoice_items_behavior: 'exclude'`; **its total is compared with the recorded amount before
finalizing** — on a mismatch (a customer discount or balance) the draft is deleted and the month held,
nothing finalized or collected. Finalize sets `auto_advance: true`, so Stripe charges. Customer =
`stripeService.resolveUserPaymentMethod(user, userId).customerId` (ENG-2571), its `paymentMethodId` the
invoice's `default_payment_method`. Records older than 12 months are pruned in the same write.

**Webhooks.** `handleInvoicePaymentSucceeded/Failed` hand any `metadata.purchaseType === 'payg_overage'`
invoice to `paygSettlementService` before touching anything, so an overage invoice never writes
`subscription_status`, `subscription_amount`, period or offer fields. Paid -> `paid`. Failed -> `failed`,
`paygOverage.suspended = {reason:'payment_failed', at, invoiceId}` (PR-1's gate refuses while set), one
owner email. **The payment-failure suspension lasts while ANY month is `failed`**: a paid webhook lifts it
only if no other month is failed (re-checked in the write's condition); a dispute suspension is never
lifted automatically. A `held` record that carries the invoice's id is moved to paid/failed too. Dispute on
an overage charge -> `suspended = dispute`. Refund -> `refundedCents`, PAYG not resumed. Refund/dispute
recognition (Basil: PaymentIntent -> `invoicePayments.list` -> invoice metadata) runs only while the switch
is on and is best-effort: a failed lookup is logged and the charge is handled as before.
`resyncAllSubscriptionAmounts` skips overage invoices.

**Closed-month state (additive, optional attributes).**
- `llmUsageCreditsClosed`: kept by the write that rolls `llmUsageCredits` into a new month
  (`grantMonthlyLlmUsageCredit` incl. the admin transaction, `recordLlmUsageDebit`), without the per-debit
  list — **only for an account with a `paygOverage` record**; every other account's rollover is unchanged.
- `paygOverage.poolHighWaterClosed` (gate's first mark of a month, conditional on the exact mark it read;
  the settings opt-in also keeps it) and `paygOverage.optInClosed` (the month's first opt-in).
- `paygOverage.admittedMonths` (above) and `paygSettlements` (AW-Users, by month): `{status,
  idempotencyKey, overageCostMicroUsd, billedMicroUsd, amountCents, markupBps, percentOfCap,
  settledMicroUsd, projectedMicroUsd, createdAt, updatedAt, invoiceId?, deletedDraftInvoiceId?,
  heldReason?, nothingToBillReason?, invoicedAt?, paidAt?, failedAt?, refundedCents?, dispute?}`.
`sanitizeUserForResponse` drops `paygSettlements` and `llmUsageCreditsClosed`.

**Emails.** Copy in one place: `utils/paygSettlementCopy.ts` (needs copy review). Invoice created: the
month and the percent of the cap only, plus the Stripe invoice link — no dollars. Payment failed: PAYG on
hold, update the card and pay the invoice.

**Rollback.** Set `payg_settlement_enabled` to anything but `true`: the sweep stops within ~60s and the
refund/dispute webhooks return to exactly today's handling. A month left `pending` stays pending (no new
charge); if the switch returns it resumes with the stored amount and Stripe is searched first, so nothing
is charged twice. Invoices already issued are Stripe's to collect; their paid/failed webhooks keep being
recorded. To stop collecting one, void it in Stripe.

**Follow-ups (known, not fixed here).** A closed high-water mark can be stale if a check raises it in the
last instant of a month while another rolls it over; a higher mark lost to a month-change race is only
saved at the next check; `paymentMethodId` can be a non-card default; `mrrCollectionGapService` counts
paid overage invoices as "has ever paid"; `charge.dispute.closed` is not handled for overage charges; a
refund of a closed month's top-up after the month ends is not reflected in `llmUsageCreditsClosed`
(billed less, never more).
