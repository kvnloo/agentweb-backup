## ENG-3179: capture-drift monitor acknowledges a deliberately customized capture route (2026-11-26)

- `captureDriftMonitor.ts` gains `CUSTOMIZED_CAPTURE_ROUTES` (repo -> reason). For a listed repo, a *drifted* `app/api/capture/route.ts` is acknowledged instead of filing the daily `lp-capture-drift` oncall item. A missing route and any `middleware.ts` drift still alert.
- Seeded with the Smart Trade Team site (`lp-create-a-high-converting-mobil-f80e1869`): its route carries a `/become-a-pro` recruitment list, `NO_PIXEL_PATHS` and `SOURCE_BY_PATH` that `buildCaptureRoute` cannot emit, so regenerating would break recruitment routing.
- Rollback: remove the map entry (or revert); the alert resumes on the next daily run.
