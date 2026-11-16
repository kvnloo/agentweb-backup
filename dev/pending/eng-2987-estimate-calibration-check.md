## ENG-2987: enrichment estimate calibration check and paid-email-search measurement (2026-11-16)

Follow-up to the estimate recalibration (#4038, ENG-2720). Adds a read-only check, `scripts/enrichment-estimate-calibration.py`, and its runbook, `docs/enrichment-estimate-calibration-runbook.md`: join prod enrichment run logs to the usage ledger per customer and day and compare booked dollars per contact with the estimate's quote. First run (2026-11-13 to 2026-11-16): 7 contacts from 1 customer, so INSUFFICIENT DATA and no retune; the script refuses to call a drift below 100 contacts from 3 customers.

Measured on 2026-11-16: no customer run has fired the paid Apollo email search since 2026-11-04 (7 placeholder rows in the cache table, all ours). 0 of 8 real people given as name and company only fired it; the 5-person run booked $0.42 (about $0.08 a lead). Decision recorded in the runbook: no cache-aware quote (the cache keys need a domain only known at run time, and asking Apollo costs a paid lookup).

Still not observed: a real Apollo callback that carries a found email (only simulated ones and real empty ones).
