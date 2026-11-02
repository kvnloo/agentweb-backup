## ENG-2769: Usage-alert modal outcome events (2026-10-30)

- `POST /api/subscription/usage-runway/alert-event` records `runway_alert_{shown,dismissed,see_options,book_call,upgrade,contact}` via `recordUsageTelemetry` (log sink), keyed on the billing subject. Durable store is ENG-2770.
