## ENG-668: customers see pay-as-you-go as "Extra usage" in backend copy too (2026-10-22)

The portal renamed the feature to "Extra usage" (portal PR #1278, `src/components/billing/paygCopy.ts`) because ENG-2571 already shows "Pay as you go" for a card on file with no subscription. The backend still said "pay-as-you-go" in every sentence it hands the customer, and the portal renders the 429 headline and body verbatim (ENG-1344 AC6), so the two names appeared side by side in the usage-limit modal.

**Changed (customer-facing text only):** the four settlement emails and the Stripe invoice description and line item (`utils/paygSettlementCopy.ts`); the usage-block headline, body and message for cap reached, on hold and inactive (`utils/usageBlockCopy.ts`), which also feed the 429, MCP refusals, the scheduled-chat run result and the scheduled-chat email; the `message` text of `PUT /api/subscription/payg` errors (`paygOverageService.ts`) and the two 500 `error` strings in `routes/subscription.ts`. The portal maps those API errors by code, not text, so nothing matches on them. Sentence case: "Extra usage" at the start of a sentence, "extra usage" mid-sentence.

**Unchanged on purpose:** identifiers, the settings keys (`payg_overage_enabled`, `payg_settlement_enabled`), DB attributes (`paygOverage`, `paygSettlements`), the Stripe invoice metadata (`purchaseType: payg_overage`, which is what the invoice search matches on; nothing matches on the description), idempotency keys, payment-history types, the error codes (`payg_unavailable`, `payg_conflict`), log lines and on-call alert text.

**Guard:** `paygSettlementEmail.test.ts` asserts that no email, invoice text, usage-block copy or scheduled-chat message matches `pay-as-you-go|payg`.

**Limit:** Stripe rejects a replayed idempotency key whose parameters changed. If an invoice was created under the old copy and its line item had not been added yet when this deploys, the retry within 24 hours would be refused. Settlement is still dark (`payg_settlement_enabled`), so no invoice can be in that state today.
