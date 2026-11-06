## ENG-2833: merge-evidence ignores hung Opslane runs (2026-11-06)

`merge-evidence.sh` now drops an Opslane check-run still `queued`/`in_progress` more than `MERGE_EVIDENCE_OPSLANE_STALE_MINUTES` (default 30) after it started. Opslane is not required and its runs hang for hours; fresh runs still hold as PENDING and Opslane failures still block.
