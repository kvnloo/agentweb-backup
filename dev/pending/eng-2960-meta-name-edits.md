## ENG-2960: Meta toolkit CAMPAIGN/AD_SET/AD name-only edits via guarded write gateway (2026-11-12)

- `call_meta_marketing_api` guarded UPDATE now accepts `name` on CAMPAIGN and AD_SET (AD already did), through the existing ownership check, preview/confirm token and read-back verification. Unknown fields stay refused; budget, creative swap and activation must still be their own UPDATE.
