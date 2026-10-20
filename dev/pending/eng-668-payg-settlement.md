## ENG-668: Pay-as-you-go month-end settlement through Stripe, shipped dark (PR-2) (2026-10-20)

**What.** PR-1 let an opted-in billing owner keep working past the plan pool up to their cap. PR-2 bills
that overage once the month closes: a daily sweep invoices each owner's previous month in Stripe and
charges the card on file, and the invoice webhooks record the outcome (and suspend PAYG on a failed or
disputed charge). **Data-plane change — needs Harsha's approval before merge** (new off-session charges,
new webhook branches, new AW-Users attributes, credit-ledger rollover).

**Switch.** AW-Settings `payg_settlement_enabled`, separate from the gate's `payg_overage_enabled`. Only
the exact string `true` turns it on (same reader and ~60s cache as PR-1's switch). Off = the sweep returns
before reading anything. Ships off. Webhooks for invoices already issued are handled either way.

**Schedule.** `cron/paygSettlementCron.ts`, registered in server.ts at 12:00 UTC daily (after the 10:00
seat-credit sweep; `utils/dailySchedule.ts` anchoring). Day 1 of a month: nothing. From day 2 it settles
the previous month for every owner whose `paygOverage.admittedMonths` lists it (scan filter), one owner at
a time; later days only resume what is still `pending`.

**What is billed** (`services/paygSettlement.ts`, pure): the gate's own measurement — `applyLlmUsageCredits`
-> `paygOverageThresholdMicroUsd` -> `measurePaygOverage` (extracted from `evaluatePaygAdmission`, which
now calls it) — fed with the closed month's inputs. Spend = settled AW-SpendEvents for the month
(`listSpendEvents` + `sumSettledMicroUsd`), reconciled with `reconcileProjection` against the persisted
projection the gate read (1 µ$ tolerance, the §3 invariant). Billable = min(overage after the opt-in
baseline, the month's cap) x `markupBps`/10000, rounded down to µ$, then to whole cents. Pool uses the
owner's tier policy at settlement time (no per-month tier history exists; the closed month's high-water
mark still covers a downgrade). The cap uses the current `capPercentOfPool`.

**Never billed / held.** A month PAYG never admitted a turn in (`admittedMonths`) is never billed — spend
past the pool there is the ordinary in-flight overrun. 0 cents -> `nothing_to_bill` (no_overage); under
Stripe's 50c minimum -> `nothing_to_bill` (below_minimum, Stripe would push it onto the subscription
invoice). `held` (no charge, one on-call alert, `Alert Class: payg-settlement-held`) for: spend drift or
real spend with no projection; an owner the gate measured on the legacy counter
(`isSpendLedgerEnforcementEnabled` false); no valid `markupBps`; unmeasurable state; no live Stripe
customer; the Stripe invoice void or a different total. **A held month stays held**: investigate, then
remove `paygSettlements.<month>` on the AW-Users row and the next daily run settles it again.

**Idempotency.** `paygSettlements[M]` is written with `attribute_not_exists` BEFORE any Stripe call
(`pending`, amount fixed), and only `pending` is ever resumed, with the stored amount. Stripe keys derive
from `payg:{billingUserId}:{M}` (`:invoice`, `:item`, `:finalize` — one key cannot span endpoints). The
draft's id is recorded before the line item is added. A `pending` with no invoice id older than 24h
(Stripe forgets keys) searches `invoices.search` by `metadata.idempotencyKey` before creating. The draft is
`auto_advance: false` + `pending_invoice_items_behavior: 'exclude'`; finalize sets `auto_advance: true`, so
Stripe charges. Customer = `stripeService.resolveUserPaymentMethod(user, userId).customerId` (ENG-2571),
with its `paymentMethodId` (new optional field: invoice default, else newest card) as the invoice's
`default_payment_method`. Invoice metadata: `purchaseType: 'payg_overage'`, `billingUserId`, `month`,
`idempotencyKey`. Records older than 12 months are pruned in the same write.

**Webhooks.** `handleInvoicePaymentSucceeded/Failed` hand any `metadata.purchaseType === 'payg_overage'`
invoice to `paygSettlementService` before touching anything, so an overage invoice never writes
`subscription_status`, `subscription_amount`, period or offer fields. Paid -> `paid`, and a
`payment_failed` suspension for that same invoice is lifted. Failed -> `failed`, `paygOverage.suspended =
{reason:'payment_failed', at, invoiceId}` (PR-1's gate refuses while set), one owner email. Dispute on an
overage charge -> `suspended.reason = 'dispute'` (replaces payment_failed, never lifted automatically).
Refund -> `refundedCents` recorded, PAYG not resumed. Basil (2025-05-28): a charge has no `invoice`, so
`findPaygOverageInvoiceForCharge` goes PaymentIntent -> `invoicePayments.list` -> invoice metadata. The
existing handlers still read `invoice.subscription`, which Basil moved under `parent.subscription_details`
— pre-existing, not changed here; overage invoices never reach that code. `resyncAllSubscriptionAmounts`
now skips overage invoices when it reads "the latest paid invoice".

**Closed-month state (additive, optional attributes).** Settlement runs after the month closes, when the
month-scoped state may already belong to the new month. Each write that replaces the old month keeps it:
- `llmUsageCreditsClosed` (AW-Users): set by `grantMonthlyLlmUsageCredit` (incl. the admin transaction)
  and `recordLlmUsageDebit` in the same conditional write that rolls `llmUsageCredits` over; without the
  per-debit list. Without it, day-2 settlement saw no credits and billed top-up/seat-credit usage.
- `paygOverage.poolHighWaterClosed`: the gate's first mark of a month, conditional on the stored mark being
  exactly the one it read; the settings opt-in also keeps it (accepting a mark the gate rolled over a moment
  earlier in the same request — a month's mark is final once the month ends).
- `paygOverage.optInClosed`: the month's first opt-in keeps the previous opt-in (version-conditional).
- `paygOverage.admittedMonths` (newest first, at most 2): the gate adds the month on its first PAYG
  admission, conditional on the list it read; a lost race never fails the check.
- `paygSettlements` (AW-Users, by month): `{status, idempotencyKey, overageCostMicroUsd, billedMicroUsd,
  amountCents, markupBps, percentOfCap, settledMicroUsd, projectedMicroUsd, createdAt, updatedAt,
  invoiceId?, heldReason?, nothingToBillReason?, invoicedAt?, paidAt?, failedAt?, refundedCents?, dispute?}`.
`sanitizeUserForResponse` drops `paygSettlements` and `llmUsageCreditsClosed`.

**Emails.** Copy in one place: `utils/paygSettlementCopy.ts` (needs copy review). Invoice created: the
month and the percent of the cap only, plus the Stripe invoice link — no dollars. Payment failed: PAYG on
hold, update the card and pay the invoice.

**Rollback.** Set `payg_settlement_enabled` to anything but `true`: the sweep stops within ~60s. A month
left `pending` stays pending (no new charge); if the switch returns it resumes with the same key and
amount, so nothing is charged twice. Invoices already issued are Stripe's to collect and their webhooks
keep being recorded. To stop collecting one, void it in Stripe (its record stays `invoiced`).

**Known gaps.** Tier and cap percentage are read at settlement time (no history). A refund of a closed
month's top-up after the month ends is not reflected in `llmUsageCreditsClosed` (reversals only apply to
the live month) — the pool stays larger, i.e. the customer is billed less. Dispute closed is not handled
for overage charges (the suspension stays until an operator clears it).
