## ENG-2947: Pure usage-alert outcome analyzer over exported telemetry lines (2026-11-12)

Added `backend/src/services/usageAlertOutcomeAnalysis.ts` + `backend/scripts/analyze-usage-alert-outcomes.ts`: read-only analysis of `[usageTelemetry]` log exports (per-subject off-track/alert/funnel outcome, CTA conversion, 7-day model switches). No persistence; no runtime call sites.
