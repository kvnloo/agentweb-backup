## ENG-1094: marketing-action producer slice 1 (2026-10-07)

Added `marketingActionProducer.ts`, which maps pending ENG-502 outcome-ledger recommendations to `MarketingActionCandidate[]` for the ENG-445 selector. It does no prose parsing and no I/O. Persisting via `attachMarketingActions` before `addRunResult` is slice 2 (data-plane gated).
