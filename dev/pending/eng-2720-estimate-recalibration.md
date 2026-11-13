## ENG-2720: enrichment cost estimate recalibrated to what prod books (2026-11-12)

The pre-run estimate (the percent of the monthly allowance shown in the confirm dialog) was calibrated on one Opiner run of 2026-10-27, before the ENG-2720 savings, and ran high. Measured on prod (customer runs since the 11-04 changes, prod logs `runEnrichment DONE` joined to `AW-UsageRecords` by user and day, test accounts excluded): 118 contacts, 5 customers, $8.09 booked; the old constants quoted $14.4-14.8 for those runs (+78% to +83%, depending on the config's field count; about 60% of the excess was the Apollo line).

`services/enrichmentCostEstimate.ts`:
- `lookupPerLead` = Apollo match + org as booked ($4.80 / 118 = $0.0407; cache hits are free, 54 paid matches for 118 contacts), `webSearchPerLead` = You.com as booked ($1.113 / 118 = $0.0094). The unattributed `otherPerLead` remainder (gpt-5.5-era spend) is gone.
- The Apollo broker line is priced on the leads it can actually be sent for: `apolloEligibleRate` 60/146 for emailless leads with a first and last name plus a company/domain/website, `apolloOtherRate` 1/30 for other emailless leads (prod logs, tier 3.5a attempts). `brokerEligibleCount` is a new estimate input (defaults to every emailless lead).
- LLM line unchanged ($0.002 per field, consistent with the measured $0.0146 per contact on ~8-field lists).

`services/enrichmentQuote.ts`: `inspectLeads` also counts broker-eligible emailless leads (`canReachApolloBroker`), and a saved config that does not request an email (`configRequestsEmail`: an included `email` field, an alias of it, or a smart dependency on it) is quoted no Apollo line, because tier 3.5a only runs for a requested email and the resolver's broker step never runs in v3 (called without a lead hint).

Backtest: Nov 4+ runs quote $8.25 vs $8.09 booked (+2%); the 2026-11-03 list of 146 broker-eligible leads $36.9 vs $37.19 booked (-1%; the only list run by that user that day). The calibration rests on few lists; re-check against the ledger as more runs land. The admission reserve (`withinAllowance`) is unchanged and stays conservative.
