## ENG-2593: Open CORS for browser posts to /api/webhooks/forward-lead (2026-10-20)

Added forward-lead to the public-CORS bypass in app.ts; the global allowlist was 403ing customer-site preflights. Per-list publicAccessEnabled still gates access.
