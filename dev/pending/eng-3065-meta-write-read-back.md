## ENG-3065: Meta ad updates and deletes are read back before success (2026-11-16)

- `backend/src/services/agentMode/metaWriteReadBack.ts`: `checkMetaUpdate` / `checkMetaDelete`, called from the
  `AgentModeService` Meta handlers after `updateCampaign`, `updateAdSet`, `updateAd` and the three deletes.
- A requested `name` / `status` (ad sets also `bid_strategy`, `bid_amount`) that does not read back returns
  `success: false`, `errorType: 'unsupported_field'`, `fields: [...]`. A read that keeps failing returns
  `errorType: 'read_back_failed'`. Same retry policy as the spend-cap check (4 reads, 3 s apart; the write is never re-sent).
- Not verified: targeting, schedule and every other update field; custom-audience user uploads.
- Guard: `backend/src/__tests__/eng3065.metaWriteReadBack.test.ts` fails when a new mutation-shaped `MetaService`
  method is neither verified nor exempt.
