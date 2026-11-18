# Enrichment estimate calibration runbook (ENG-2987)

The dialog a customer sees before an enrichment run ("about X% of your monthly usage allowance") comes from
`estimateEnrichmentCost` in `backend/src/services/enrichmentCostEstimate.ts`. Its constants (`ENRICHMENT_COST_RATES_USD`)
were measured from what prod booked. This runbook is how to check, from real runs, that they still match.

## When to run it

- **At least every 14 days.** The run logs the script reads live in a CloudWatch log group that keeps 14 days, so older
  runs disappear. The script warns whenever `--since` is at or before the oldest retained day: that day is only partly
  covered by the logs while the ledger counts the whole day, which inflates the ratio, so start at the day after.
- Retune only on enough data: at least **100 contacts, from at least 3 accounts that each supplied at least 10 contacts,
  with no account supplying more than half of them**. Otherwise the script says INSUFFICIENT DATA and names what is short,
  and you must not retune; run it again later.
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
before a change can mislead: on 2026-11-16 a 14-day window started on 2026-11-02 and printed DRIFT because it included the
2026-11-03 run, whose 148 contacts looked 3.6 times the quote. Most of that was the day's 60 paid email searches ($26.70), booked under the
old model name `apollo:full_enrichment`, which the first version of the script did not exclude; the script now treats both
names as the email search, and that run reads 1.01. It is also the 148-contact list the 2026-11-13 recalibration was fitted
to, so it confirms the fit, not the quote. A window that includes it is dominated by it (72% of the contacts from
2026-11-03), so the script refuses to give a verdict when one account supplies more than half of the contacts
(`--max-account-share`). Other things changed on 2026-11-04 (the ENG-2720 fixes), so still start after the last change.
Always read the per-line table before acting on the verdict.

Expect it to take a while: the log search is the slow part, one combined search for both the START and DONE lines at
roughly 30 seconds per log day (a 13-day `--since` took 6 to 9 minutes on four runs on 2026-11-16 and 48 minutes on a fifth, when AWS was slow; each AWS call has a 30-minute limit).
It makes four kinds of AWS calls, all reads: `logs describe-log-groups`, `logs filter-log-events`, `dynamodb scan` and
`dynamodb get-item`. It prints one line per account and day (6-character user id prefix, contacts, fields, booked dollars,
dollars per contact, the quote per contact, the ratio, the paid add-ons) and a verdict. The mode and the user id come from
log text, so only the modes `enrich` and `preview` and plain ids are accepted; other lines are ignored and counted. It prints no email, lead or field
value. A genuine run line starts with the syslog prefix (`Nov 13 11:42:30 ip-... web[4828]: [Worker] [v3] runEnrichment ...`);
any other line that mentions a run, a mode other than `enrich` or `preview`, an id that is not 1 to 64 plain characters or a
number that is not 1 to 9 digits is ignored and counted (`ignored N log lines that were not genuine run lines`), so a
changed log format shows up as ignored lines and a run count of zero, not as silently wrong numbers. A customer list that
no longer exists is counted with the reference field count, reported, and its row is marked `?` in the table (the field
count there is an assumption, not a measurement); a list that exists but has no saved config also uses the reference count,
as the customer quote does, and is not marked. AWS error text is reduced to the error code and the operation (the full text can carry account names); run the same
`aws` command by hand to read it.

Left out as non-customers: the test account `test@account.com` (`--exclude-emails`, case-insensitive), every platform admin
(`isAdmin`), every account whose email domain is, or is a subdomain of, `agentweb.pro` or `argusoft.com`
(`--exclude-domains`; a look-alike such as `agentweb.pro.example.com` stays in) and any `--exclude-user-ids` (a prefix of
6 or more characters, as printed in the table, is enough; it is matched against the user table and against the user ids in
the run logs, so an account that has been deleted from the user table can still be excluded). It prints how many accounts
each rule excluded and warns when an `--exclude-user-ids` entry matches nothing. The user table is read whole and matched inside the script, so no email is put
into a DynamoDB expression or printed. Real customer
accounts are kept whatever their email domain. The script only issues read calls, but the guarantee that nothing can be
written is the IAM role: run it with a read-only one. The script reads the three rate constants and `referenceFieldCount` from
`enrichmentCostEstimate.ts`, so those cannot drift; the **formula itself is duplicated** in the script, so if
`estimateEnrichmentCost` or `effectiveFieldCount` changes shape, update the script.

## How to read it

- **booked/quote** compares what the ledger booked per processed contact (paid add-ons excluded, see below) with the
  quote for leads that already have an email: `fields * 0.002 + lookupPerLead + webSearchPerLead`, where `fields` applies the
  customer quote's formula (included fields plus smart-field dependencies, at least 1; 10 when the list has no saved
  config) to the list's *saved* config. The quote also counts columns added to the list since the config was saved; this
  check does not (about 3% of the ratio per column: a reviewer estimated that the Nuerraa list, 12 saved fields and about 3
  columns not in its saved config, would read about 1.56 instead of 1.68 on the quote's count; the quote also drops saved
  fields that are excluded or reserved, a smaller effect in the other direction).
- Within +/-25% on enough data (all three conditions above): leave the constants alone.
- Beyond that on enough data: retune `ENRICHMENT_COST_RATES_USD`, update the calibration paragraph in that file's header
  and the tests in `enrichmentCostEstimate.test.ts`, and ship it through the normal PR rules. Record the sample below.
- **Lists with nothing cached cost more than the quote.** The quote is an average over lists whose lookups are partly
  cached. The 2026-11-05 Nuerraa run looks like a list with nothing cached (29 of its 30 contacts needed a paid person
  lookup): its person and company lookups cost about $0.094 a contact against the quote's $0.041 lookup term. Expect single
  runs above the quote.
- The paid add-ons have no term in the per-contact quote, so they are excluded from the ratio and shown in their own
  columns: the Apollo email search (`apollo:waterfall_email`, booked as `apollo:full_enrichment` until the ENG-2720 change reached prod and last seen in the
  ledger on 2026-11-03, $0.445 a
  request, hit or miss; the quote models it as a share of the emailless leads it can reach, `apolloEligibleRate` and
  `apolloOtherRate`) and Enigma (`enigma:*`, which the customer
  quote adds separately for card-revenue fields).

## Known limits

- The ledger is per user and day, so a day with an enrich run and a preview, or two lists, is compared as a whole. The
  ledger features `crm_enrichment` and `enrichment` are also written by other code (for example the ICP-filter LLM
  extractor, `icpFilterLlmExtractor.ts`, and Apollo person lookups made outside a v3 run), so that spend counts as booked
  on any day the same account also runs v3, even though it is not part of the run.
- The field count is read from each list's *current* enrichment config, which may differ from the run's.
- Customer quotes use a model-aware per-field cost; this check uses the same per-field constant the recalibration used.
- A run that straddles midnight UTC is split across days. A run that started before `--since` is not counted (the script
  reports how many, account unknown), and a customer run that started but never finished (still running or crashed) leaves
  its cost in the booked dollars with no contacts (also reported).
- Contacts include preview-mode contacts (the 2026-11-03 "148 contacts" is 146 enrich plus 2 preview), and a lead that failed
  still cost money but is not a contact (every customer run checked had `failed=0`).
- If the user-table scan came back truncated, internal accounts would count as customers: the script refuses an empty scan
  and prints how many accounts it read, so compare that with the table's size.
- The gate counts accounts that each supplied at least `--min-customer-contacts` (default 10) contacts, and refuses a
  verdict when one account supplies more than `--max-account-share` (default 0.5) of the contacts; the verdict prints that
  share. Read the per-line table anyway.
- The share of leads that fire the paid email search cannot be read from this join; see the next section.

## The paid email search (measured 2026-11-16)

- **Customers:** the usage ledger shows one `apollo:waterfall_email` request from a customer account since 2026-11-04
  (placeholder rows are only written when a search is still pending, so they undercount). It was a Nuerraa user's
  enrichment on 2026-11-05: the run started at 02:33:08 and finished at 02:34:17, processed 30 contacts and skipped 54
  leads that had no usable identity; the ledger shows 29 person lookups and the one $0.445 search. It is the single broker
  request in the 2026-11-13 recalibration sample.
- **A real found-email callback was possibly observed, but this is not proof.** For that search, the placeholder in
  `AW-EnrichmentRawCache` was created at 02:33:46.181 and stamped `completed` with a `verified` email status at 02:33:49.017,
  2.8 seconds later, while that customer's run was in progress. That is much faster than every other callback stamp we have
  (23 to 52 seconds), anyone holding the callback secret could have posted it, we have not seen the payload (Apollo
  publishes no callback example). The lead carries no callback-written email provenance (`enrichmentMetadata.email`), and a
  reviewer's count-only check found none on any emailed lead of that list; the webhook does not write to a lead that
  already has an email, so the callback most likely wrote nothing and the lead probably already had an email (an inference,
  not a trace of the write). Our own simulated callbacks were sent on 2026-11-04 in the Argusoft admin test account; none is
  known on this row. Treat the found-email path as unproven until a callback whose payload has been seen.
- **The seven placeholder rows that existed on 2026-11-16:** that one customer row; five in the Argusoft admin test account
  on 2026-11-04: four created by the live test at 16:14, of which two still show their callback stamps (23 and 28 seconds
  after creation, both empty) and two were overwritten at 16:20 by our own simulated callbacks (one `completed`, one
  empty), and a fifth created at 17:32 after the secret was rotated and stamped empty 35 seconds later; and one empty
  callback in the test account on 2026-11-12, stamped 52 seconds after creation.
- **Real people, name and company only, no LinkedIn:** 0 of 8 fired the search (3 founders on 2026-11-05, 5 people on
  2026-11-16): the ledger shows no email search for either test, and the tests' own results show Apollo's immediate match
  supplying the emails (the lead contents were not re-read for this runbook). The 5-person run booked $0.42 in total, about
  $0.08 a lead.
- **Worst case is unchanged:** a lead Apollo cannot match immediately costs $0.445 for the search. The admission reserve
  still bounds real spend; this only affects the number shown to customers.
- **Tripwire:** compare the email-search requests booked in the ledger (`apollo:waterfall_email`) with the placeholder
  statuses (`completed` vs `no_email`). Five or more requests and none `completed` means the callback layout may have
  changed: look at the webhook, do not retune.

### Decision: no cache-aware quote for now (2026-11-16)

Not building it yet, for these reasons, and to be revisited once this check has enough customer data (100 contacts from 3
accounts):

- There is no measured need. Since 2026-11-04 the only customer evidence on the paid email search is one search in the
  recalibration sample (before that, the 2026-11-03 list fired it for 60 of its 146 eligible leads, $26.70), and 0 of 8 real
  name-and-company-only people fired it, so the case for adding quote-time cache lookups rests on little.
- The Apollo cache key for a match lookup is the strongest identifier the lead has, in this order: `apollo:linkedin:<url>`,
  `apollo:email:<email>`, and only then `apollo:name:<first>|<last>|<domain or normalised company>`; a find lookup uses
  `apollo:find:<first>|<last>|<domain or company>` (`apolloCacheKeys.ts`). Most customer leads carry a LinkedIn URL, so the
  usual key is the LinkedIn one. A quote-time lookup would have to rebuild the same key the run will use, and the domain a run
  uses can come from an earlier step, so a quote could miss entries the run would hit. We have not measured how often.
- Which way it would move the number is unclear: cached lists would quote lower, lists with nothing cached higher, and the
  customer sample (58 contacts at 1.50 of quote) suggests it is the uncached side that is low. That is a calibration
  question for this check to answer with more data, not something quote-time lookups settle first.
- Customer exposure on emailless leads without a LinkedIn URL is still unmeasured (the one customer search above sat in a
  sample that was almost all emailed leads).

## History

| Date | Sample | Booked | Quote | Result |
|---|---|---|---|---|
| 2026-11-13 | 118 contacts, 4 accounts as recorded then, since 2026-11-04 (one of them fired the paid email search), plus one 146-lead list | $8.09 | old constants $14.4 to $14.8; new $7.80 | recalibrated in #4038 |
| 2026-11-16 | 2026-11-03: one 148-contact customer list (the list the recalibration was fitted to); its 60 paid email searches ($26.70, booked under the old name `apollo:full_enrichment`) excluded | $10.49 | $10.38 (ratio 1.01) | confirms the fit, not the quote; a window that includes it is INSUFFICIENT because this list is 72% of the contacts |
| 2026-11-16 | Replay of 2026-11-04 to 2026-11-13 with the final script (internal accounts excluded): 58 contacts, 2 customer accounts (one Nuerraa, one ThinkingAI) | $6.28 | $4.19 (ratio 1.50) | insufficient data (needs 3 accounts with 10 or more contacts each), so no retune. The ratio is above the quote: the Nuerraa run (1.68) looks like a list with nothing cached (29 of its 30 contacts needed a paid person lookup; inferred, not measured), its person and company lookups costing $0.094 a contact against the quote's $0.041; the ThinkingAI run (1.29) paid $0.055 a contact for lookups, but its list no longer exists, so its field count is the assumed reference count of 10 (marked `?` by the script) and its ratio is less certain than the other two. An earlier replay that included an internal `agentweb.pro` account (97 contacts, ratio 1.13) looked inside the band only because that account's runs were cheap; the "4 customers" recorded at the 2026-11-13 recalibration probably included internal accounts too. Re-run with the same `--since` as customer runs accumulate. |
| 2026-11-16 | 2026-11-13 to 2026-11-16: 12 runs in the logs, all from excluded accounts (an internal `agentweb.pro` user booked $0.48 for 7 contacts against a $0.49 quote, ratio 0.97; the rest is the test account) | | | no customer data in the window; nothing to retune |
