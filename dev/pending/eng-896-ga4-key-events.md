## ENG-896: Read GA4 key-event configuration + zero-data preflight (2026-10-27)

- New read-only Emma tool `get_ga4_key_events` (GA4 Admin API v1beta keyEvents.list, analytics.readonly via existing service account). Answers "is X a key event" in one call; permission errors return the manual GA4 Admin path.
- `get_website_analytics` flags zero-row properties (`noData`, `noDataNote` with property ID + date range) and routes key-event config questions to the new tool.
