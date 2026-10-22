## ENG-2610: Gateway repairs client_id -> client_name_or_email (2026-10-21)

Scheduled Meta perf reports called monitor_lead_volume with `client_id`; the gateway now maps client_id/client_email/client to client_name_or_email when that is the schema field, and never remaps a key that is itself a schema property.
