# Enrichment estimate calibration runbook (ENG-2987)

The dialog a customer sees before an enrichment run ("about X% of your monthly usage allowance") comes from
`estimateEnrichmentCost` in `backend/src/services/enrichmentCostEstimate.ts`. Its constants (`ENRICHMENT_COST_RATES_USD`)
were measured from what prod booked. This runbook is how to check, from real runs, that they still match.

## When to run it

- **At least every 14 days.** The run logs the script reads live in a CloudWatch log group that keeps 14 days, so older
  runs disappear (the script warns when `--since` reaches past that).
- Retune only on enough data: at least **100 contacts from at least 3 customers** since the last check. Below that the
  script says INSUFFICIENT DATA, and you must not retune; just run it again later.
- Also after a change to Apollo, LLM or web-search pricing, or to what the enrichment engine calls per lead.

## How to run it (read-only)

Needs read access to the prod CloudWatch log group and the `AW-*` DynamoDB tables (the vendor access role has it).

```bash
python3 scripts/enrichment-estimate-calibration.py --since <first day after the last check>
```

It makes four kinds of AWS calls, all reads: `logs describe-log-groups`, `logs filter-log-events`, `dynamodb scan` and
`dynamodb get-item`. It prints one line per customer and day (6-character user id prefix, contacts, fields, booked dollars,
dollars per contact, the quote per contact, the ratio) and a verdict. It prints no email, lead or field value. It reads
the constants from `enrichmentCostEstimate.ts`, so it cannot drift from the code. Left out as non-customers: the test
account `test@account.com` (`--exclude-emails`), every platform admin (`isAdmin`) and any `--exclude-user-ids`. Real
customer accounts are kept whatever their email domain.

## How to read it

- **booked/quote** compares what the ledger booked per processed contact (paid email search excluded, see below) with the
  quote for leads that already have an email: `fields * 0.002 + lookupPerLead + webSearchPerLead`, where `fields` is the
  same count the customer quote uses (included fields plus smart-field dependencies, at least 1; 10 when the list has no
  saved config).
- Within +/-25% on enough data: leave the constants alone.
- Beyond that on enough data: retune `ENRICHMENT_COST_RATES_USD`, update the calibration paragraph in that file's header
  and the tests in `enrichmentCostEstimate.test.ts`, and ship it through the normal PR rules. Record the sample below.
- The paid Apollo email search (`apollo:waterfall_email`, $0.445 a request, hit or miss) is not part of the per-contact
  quote, so it is excluded from the ratio and shown in its own column. The quote models it as a share of the emailless leads
  the search can reach (`apolloEligibleRate`, `apolloOtherRate`).

## Known limits

- The ledger is per user and day, so a day with an enrich run and a preview, or two lists, is compared as a whole.
- The field count is read from each list's *current* enrichment config, which may differ from the run's.
- Customer quotes use a model-aware per-field cost; this check uses the same per-field constant the recalibration used.
- A run that straddles `--since` or midnight UTC is dropped or split across days.
- The share of leads that fire the paid email search cannot be read from this join; see the next section.

## The paid email search (measured 2026-11-16)

- **Customers:** one customer-fired email search since 2026-11-04. A Nuerraa user's enrichment on 2026-11-05 (02:30 to
  02:34 UTC) matched 29 contacts and fired one search ($0.445). That is the single broker request in the 118-contact
  sample of the 2026-11-13 recalibration (under 1% of contacts).
- **A real found-email callback has been observed.** For that search, the placeholder in `AW-EnrichmentRawCache` was created
  at 02:33:46 and stamped `completed` with a `verified` email status at 02:33:49. Only Apollo calls the callback URL (it
  carries the rotated secret), so the webhook parsed a real found-email callback. We have not seen the payload itself
  (Apollo publishes no callback example) and did not trace which code path wrote the lead's email.
- **The seven placeholder rows that exist (as of 2026-11-16):** that one customer row; five in the Argusoft admin test
  account on 2026-11-04 (real empty callbacks from synthetic people, plus one forged late write); one empty real callback
  in the test account on 2026-11-12.
- **Real people, name and company only, no LinkedIn:** 0 of 8 fired the search (3 founders on 2026-11-05, 5 people on
  2026-11-16). Apollo's immediate match supplied every email. The 5-person run booked $0.42 in total, about $0.08 a lead.
- **Worst case is unchanged:** a lead Apollo cannot match immediately costs $0.445 for the search. The admission reserve
  still bounds real spend; this only affects the number shown to customers.
- **Tripwire:** compare the email-search requests booked in the ledger (`apollo:waterfall_email`) with the placeholder
  statuses (`completed` vs `no_email`). Five or more requests and none `completed` means the callback layout may have
  changed: look at the webhook, do not retune.

### Decision: no cache-aware quote (2026-11-16)

Not worth building now. Name-based cache keys depend on a domain that is only known at run time, so the quote cannot look
them up. Asking Apollo whether it knows a lead is a paid person lookup ($0.0495), about a quarter of the expected search
cost, and the quote should not spend money to estimate spend. Customer exposure is under 1% of contacts. Revisit if this
check shows the quote is persistently off by more than the tolerance.

## History

| Date | Sample | Booked | Quote | Result |
|---|---|---|---|---|
| 2026-11-13 | 118 contacts, 4 customers, since 2026-11-04 (every lead had an email), plus one 146-lead list | $8.09 | old constants $14.4 to $14.8; new $7.80 | recalibrated in #4038 |
| 2026-11-16 | 7 contacts, 1 customer, 2026-11-13 to 2026-11-16 | $0.48 | $0.49 (ratio 0.97) | insufficient data, no change |
