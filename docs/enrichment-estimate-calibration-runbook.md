# Enrichment estimate calibration runbook (ENG-2987)

The dialog a customer sees before an enrichment run ("about X% of your monthly usage allowance") comes from
`estimateEnrichmentCost` in `backend/src/services/enrichmentCostEstimate.ts`. Its constants (`ENRICHMENT_COST_RATES_USD`)
were measured from what prod booked. This runbook is how to check, from real runs, that they still match.

## When to run it

- Once a month, or as soon as real customer runs have piled up: at least **100 contacts from at least 3 customers**
  since the last check (the script says INSUFFICIENT DATA below that, and then you must not retune).
- After a change to Apollo, LLM or web-search pricing, or to what the enrichment engine calls per lead.

## How to run it (read-only)

Needs read access to the prod CloudWatch log group and the `AW-*` DynamoDB tables (the vendor access role has it).

```bash
python3 scripts/enrichment-estimate-calibration.py --since <first day after the last check>
```

It prints one line per customer and day (6-character user id prefix, contacts, included fields, booked dollars, dollars per
contact, the quote per contact, and the ratio) and a verdict. It writes nothing to AWS and prints no email, lead or field
value. It reads the constants from `enrichmentCostEstimate.ts`, so it cannot drift from the code. Test accounts are left out
by email (`--exclude-emails`, default `test@account.com`); add any other internal account you used.

## How to read it

- **booked/quote** compares what the ledger booked per processed contact (email search excluded, see below) with the
  quote for leads that already have an email: `fields * 0.002 + lookupPerLead + webSearchPerLead`.
- Within +/-25% on enough data: leave the constants alone.
- Beyond that on enough data: retune `ENRICHMENT_COST_RATES_USD`, update the calibration paragraph in that file's header
  and the tests in `enrichmentCostEstimate.test.ts`, and ship it through the normal PR rules. Record the sample below.
- The paid Apollo email search (`apollo:waterfall_email`, $0.445 a request, hit or miss) is not part of the per-contact
  quote, so it is excluded from the ratio and shown in its own column. The quote models it as a share of the emailless leads
  the search can reach (`apolloEligibleRate`, `apolloOtherRate`).

## Known limits

- The ledger is per user and day, so a day with an enrich run and a preview, or two lists, is compared as a whole.
- The included-field count is read from each list's *current* enrichment config, which may differ from the run's.
- Customer quotes use a model-aware per-field cost; this check uses the same per-field constant the recalibration used.
- The share of leads that fire the paid email search cannot be read from this join; see the next section.

## The paid email search on leads without a LinkedIn URL (measured 2026-11-16)

- **Customers:** no customer run has fired the email search since 2026-11-04. The prod enrichment cache table holds 7
  email-search placeholder rows in total (`apollo:async_request#v1`), all from our own tests.
- **Real people, name and company only, no LinkedIn:** 0 of 8 fired the search (3 founders on 2026-11-05, 5 people on
  2026-11-16). Apollo's immediate match supplied every email. The 5-person run booked $0.42 in total, about $0.08 a lead.
- **Worst case is unchanged:** a lead Apollo cannot match immediately costs $0.445 for the search. The admission reserve
  still bounds real spend; this only affects the number shown to customers.
- **A found-email callback from the real Apollo has still never been observed**; only simulated callbacks and real empty
  ones. It needs people Apollo's immediate match cannot resolve.

### Decision: no cache-aware quote (2026-11-16)

Not worth building now. Name-based cache keys depend on a domain that is only known at run time, so the quote cannot look
them up. Asking Apollo whether it knows a lead is a paid person lookup ($0.0495), about a quarter of the expected search
cost, and the quote should not spend money to estimate spend. No customer exposure has been measured. Revisit if this check
shows the quote is persistently off by more than the tolerance.

## History

| Date | Sample | Booked | Quote | Result |
|---|---|---|---|---|
| 2026-11-13 | 118 contacts, 5 customers, since 2026-11-04 (every lead had an email), plus one 146-lead list | $8.09 | old constants $14.4 to $14.8; new $7.80 | recalibrated in #4038 |
| 2026-11-16 | 7 contacts, 1 customer, 2026-11-13 to 2026-11-16 | $0.48 | $0.39 | insufficient data, no change |
