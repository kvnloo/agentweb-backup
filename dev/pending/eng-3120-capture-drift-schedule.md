## ENG-3120: Daily capture-drift sweep for generated landing pages (2026-11-16)

metaTrackingMonitorCron now runs detectCaptureDrift over every non-archived generated page with a repo and a Meta pixel (GitHub contents GET on main only) and files one lp-capture-drift oncall alert per drifted site, deduped 24h in memory. Read-only; no re-injection.
