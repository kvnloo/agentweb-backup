## ENG-2876: Lead notification LLM fit gate, dark (2026-11-09)

- New per-org `leadNotifications.fitGate = { enabled, criteria? }` (default off). When on, each Slack lead notification is judged once at delivery by gemini-3.1-flash-lite (200 tokens, 6s request / 8s total deadline, owner-attributed usage feature `lead_notification_fit`). `bad` suppresses the post and labels the lead `leadFit: bad` in the CRM; good/maybe/any failure posts (fail open).
- Files: backend/src/services/leadFitGate.ts, orgLeadNotificationService.ts, leadNotificationConfig.ts.
