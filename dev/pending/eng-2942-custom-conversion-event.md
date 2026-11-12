## ENG-2942: Meta toolkit accepts configured custom conversion events for new ad sets (2026-11-11)

- `backend/src/mcp/metaToolkitConversionGate.ts`: AD_SET CREATE with `custom_conversion_id` or `OTHER`+`custom_event_str` is checked against the account's custom conversions / pixel event stats; unknown, archived, wrong-pixel, or unverifiable events are refused. Standard events (LEAD etc.) unchanged.
