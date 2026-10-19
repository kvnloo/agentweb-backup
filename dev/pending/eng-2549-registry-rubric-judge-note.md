## ENG-2549: eval registry, creative rubric judge prod state (2026-10-19)

The `creative-rubric-judge` registry note said the judge was unset in prod. It is on: `CREATIVE_RUBRIC_JUDGE_ENABLED=true` and `CREATIVE_RUBRIC_JUDGE_SAMPLE_RATE=0.25` on `Agentweb-backend-env-prod-3` (read on 2026-10-19). The note now says so. Its verdicts are stored and nothing acts on them, and it is still not validated against human labels. No behaviour change.
