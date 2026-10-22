## ENG-2537: pure drip-sequence definition validator (2026-10-19)

- Added `backend/src/services/dripSequenceValidator.ts` `validateSequenceDefinition()`: collects all errors (empty sequence, missing/duplicate step ids, invalid/over-max delays, unsupported channel, missing subject/body, merge fields outside ENG-2535 `DEFAULT_DRIP_MERGE_FIELDS`). Not wired into storage/enrollment yet (ENG-2167).
