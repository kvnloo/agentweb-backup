# Enrichment estimate calibration runbook (ENG-2987)

The dialog a customer sees before an enrichment run ("about X% of your monthly usage allowance") comes from
`estimateEnrichmentCost` in `backend/src/services/enrichmentCostEstimate.ts`. Its constants (`ENRICHMENT_COST_RATES_USD`)
were measured from what prod booked. This runbook is how to check, from real runs, that they still match.

## When to run it

- **At least every 14 days.** The run logs the script reads live in a CloudWatch log group that keeps 14 days, so older
  runs disappear. The script warns when `--since` reaches into the lost part, and also when `--since` is exactly 14 days
  ago (the early hours of that day are gone but the ledger counts the whole day).
- Retune only on enough data: at least **100 contacts, from at least 3 accounts that each supplied at least 10 contacts**.
  Below that the script says INSUFFICIENT DATA, and you must not retune; run it again later.
- **Do not move `--since` forward after an INSUFFICIENT result.** Keep the same `--since` (the day after the last change
  to pricing or the enrichment pipeline) until the data is enough, so the runs keep adding up. Because the logs only last
  14 days, before the oldest runs of that window fall off, write the partial numbers into the History table below.
- Also after a change to Apollo, LLM or web-search pricing, or to what the enrichment engine calls per lead.

## How to run it (read-only)

Needs read access to the prod CloudWatch log group and the `AW-*` DynamoDB tables (the vendor access role has it).

```bash
python3 scripts/enrichment-estimate-calibration.py --since <the day after the last change>
```

`--since` is required and must be a real, zero-padded date (`2026-11-05`, not `2026-11-5`: the ledger filter is a string
comparison, so the script rejects the unpadded form instead of silently dropping rows). It must be the day **after the last
change** to pricing or the enrichment pipeline, because the script cannot know that date and a window that reaches back
before a change gives a false DRIFT: on 2026-11-16 a 14-day window started on 2026-11-02 and included the 2026-11-03 run
from before the 2026-11-04 fixes (148 contacts at 3.6 times the quote), which turned a 245-contact sample into "DRIFT".
Always read the per-line table before acting on the verdict.

It makes four kinds of AWS calls, all reads: `logs describe-log-groups`, `logs filter-log-events`, `dynamodb scan` and
`dynamodb get-item`. It prints one line per account and day (6-character user id prefix, contacts, fields, booked dollars,
dollars per contact, the quote per contact, the ratio, the paid add-ons) and a verdict. It prints no email, lead or field
value, and AWS error text is scrubbed of ARNs and email addresses and capped at 300 characters.

Left out as non-customers: the test account `test@account.com` (`--exclude-emails`), every platform admin (`isAdmin`),
every account on the internal domains `agentweb.pro` and `argusoft.com` (`--exclude-domains`, exact suffix match, so a
look-alike such as `agentweb.pro.example.com` stays in) and any `--exclude-user-ids`. Real customer accounts are kept
whatever their email domain. The script reads the three rate constants and `referenceFieldCount` from
`enrichmentCostEstimate.ts`, so those cannot drift; the **formula itself is duplicated** in the script, so if
`estimateEnrichmentCost` or `effectiveFieldCount` changes shape, update the script.

## How to read it

- **booked/quote** compares what the ledger booked per processed contact (paid add-ons excluded, see below) with the
  quote for leads that already have an email: `fields * 0.002 + lookupPerLead + webSearchPerLead`, where `fields` applies the
  customer quote's formula (included fields plus smart-field dependencies, at least 1; 10 when the list has no saved
  config) to the list's *saved* config. The quote also counts columns added to the list since the config was saved; this
  check does not (about 3% of the ratio per column).
- Within +/-25% on enough data: leave the constants alone.
- Beyond that on enough data: retune `ENRICHMENT_COST_RATES_USD`, update the calibration paragraph in that file's header
  and the tests in `enrichmentCostEstimate.test.ts`, and ship it through the normal PR rules. Record the sample below.
- **Fresh lists cost more than the quote.** The quote is an average over lists whose lookups are partly cached. A list of
  people Apollo has not been asked about recently pays full price: the 2026-11-05 Nuerraa run's person and company lookups
  cost about $0.094 a contact against the quote's $0.041 lookup term. Expect single runs above the quote.
- The paid add-ons have no term in the per-contact quote, so they are excluded from the ratio and shown in their own
  columns: the Apollo email search (`apollo:waterfall_email`, $0.445 a request, hit or miss; the quote models it as a share
  of the emailless leads it can reach, `apolloEligibleRate` and `apolloOtherRate`) and Enigma (`enigma:*`, which the customer
  quote adds separately for card-revenue fields).

## Known limits

- The ledger is per user and day, so a day with an enrich run and a preview, or two lists, is compared as a whole.
- The field count is read from each list's *current* enrichment config, which may differ from the run's.
- Customer quotes use a model-aware per-field cost; this check uses the same per-field constant the recalibration used.
- A run that straddles midnight UTC is split across days. A run that started before `--since` is not counted (the script
  reports how many), and a run that started but never finished (still running or crashed) leaves its cost in the booked
  dollars with no contacts (also reported).
- The gate counts accounts that each supplied at least `--min-customer-contacts` (default 10) contacts, and the verdict
  prints the share of the largest account; read the per-line table anyway.
- The share of leads that fire the paid email search cannot be read from this join; see the next section.

## The paid email search (measured 2026-11-16)

- **Customers:** the usage ledger shows one `apollo:waterfall_email` request from a customer account since 2026-11-04
  (placeholder rows are only written when a search is still pending, so they undercount). It was a Nuerraa user's
  enrichment on 2026-11-05: the run started at 02:33:08 and finished at 02:34:17, processed 30 contacts and skipped 54
  leads that had no usable identity; the ledger shows 29 person lookups and the one $0.445 search. It is the single broker
  request in the 2026-11-13 recalibration sample.
- **A real found-email callback has very likely been observed.** For that search, the placeholder in `AW-EnrichmentRawCache`
  was created at 02:33:46.181 and stamped `completed` with a `verified` email status at 02:33:49.017, 2.8 seconds later,
  while that customer's run was in progress. Our own simulated callbacks were all sent on 2026-11-04 in the Argusoft admin
  test account, and nothing suggests a forged write on this row, but we cannot prove who called the webhook (anyone with the
  callback secret could). We have not seen the payload itself (Apollo publishes no callback example) and did not trace
  which code path wrote the lead's email.
- **The seven placeholder rows that existed on 2026-11-16:** that one customer row; five in the Argusoft admin test account
  on 2026-11-04 (four from the live test, each of which got a real empty callback 23 to 42 seconds after its request, and
  two of those were later overwritten by our own simulated callbacks at 16:20, one `completed` and one empty; plus one fresh
  real empty callback at 17:32 after the secret was rotated); one real empty callback in the test account on 2026-11-12.
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
cost, and the quote should not spend money to estimate spend. Customer exposure on emailless leads without a LinkedIn URL
is still unmeasured (the one customer search above sat in a sample that was almost all emailed leads). Revisit if this
check shows the quote is persistently off by more than the tolerance.

## History

| Date | Sample | Booked | Quote | Result |
|---|---|---|---|---|
| 2026-11-13 | 118 contacts, 4 accounts as recorded then, since 2026-11-04 (one of them fired the paid email search), plus one 146-lead list | $8.09 | old constants $14.4 to $14.8; new $7.80 | recalibrated in #4038 |
| 2026-11-16 | Replay of 2026-11-04 to 2026-11-13 with the final script (internal accounts excluded): 58 contacts, 2 customer accounts (one Nuerraa, one ThinkingAI) | $6.28 | $4.19 (ratio 1.50) | insufficient data (needs 3 accounts with 10 or more contacts each), so no retune. The ratio is above the quote: both runs were on fresh lists, and the Nuerraa run's person and company lookups cost $0.094 a contact against the quote's $0.041. An earlier replay that included an internal `agentweb.pro` account (97 contacts, ratio 1.13) looked inside the band only because that account's runs were cheap; the "4 customers" recorded at the 2026-11-13 recalibration probably included internal accounts too. Re-run with the same `--since` as customer runs accumulate. |
| 2026-11-16 | 7 contacts, 1 internal `agentweb.pro` account (excluded as non-customer by the current defaults), 2026-11-13 to 2026-11-16 | $0.48 | $0.49 (ratio 0.97) | no customer data in the window; nothing to retune |
