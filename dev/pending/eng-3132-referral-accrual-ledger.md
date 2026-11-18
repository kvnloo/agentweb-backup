## ENG-3132: Zoma referral accrual, ledger and refund reversal, slices B1-B5 (2026-11-18)

Builds on the registry (slice A). Everything is dark: the webhook entry returns at once unless `ZOMA_REFERRAL_ENABLED` is exactly `true` with valid values.

- **Data-plane:** second new table `AW-ZomaReferralLedger` (PK `referredUserId`, SK `entry`, no GSI, pay-per-request, deletion protection, PITR attempted) in `scripts/create-tables.ts`. Anurag approved it (2026-11-18); Yugo creates it after review, before the flag is set. Not in `ensureCriticalTables`. Append-only; the payout report scans it (at most `months` rows per referred user).
- **Rule:** commission = percent (default 20%, basis points) of each paid Zoma invoice ex-tax (`total_excluding_tax`), minus the net of the $1 trial-fee line (matched by price id, `ZOMA_STRIPE_TRIAL_FEE_PRICE_ID` plus retired ids in `ZOMA_STRIPE_TRIAL_FEE_PRICE_IDS_HISTORICAL`), for the referred user's first `months` commissionable invoices. The window is computed per Zoma Stripe customer from Stripe's paid-invoice list, ordered by paid time, so webhook order and cancel/resubscribe cannot change who is inside it.
- **Idempotency:** ledger key is `<invoiceId>#accrual` (conditional put). `invoice.paid` and `invoice.payment_succeeded` both fire; the second is a no-op.
- **Refunds:** `credit_note.created` on a Zoma invoice writes a negative row keyed `<invoiceId>#reversal#<creditNoteId>`, using the percent stored on the accrual, excluding the fee line, capped at the accrued base.
- **Failure handling:** store/Stripe errors throw so `handleWebhook` answers 5xx and Stripe retries. Shapes that cannot be computed safely (no fee price configured, truncated lines, missing totals) are logged at error level as `[ZOMA-REFERRAL] unsafe ...` and write nothing.
- **Unproven until a Stripe test-clock run:** which invoice carries overage lines; that the live endpoint subscribes to `invoice.paid` and `credit_note.created`; the credit-note-line to invoice-line mapping.
- **Rollback:** unused unless the flag is set. Revert the commits; the ledger table can stay empty.
