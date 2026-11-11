## ENG-2917: Zoma signals read tools (2026-11-10)

- Add read-only toolkit/MCP tools `ads_get_datasets`, `ads_get_dataset_details`, `ads_get_dataset_stats`, `ads_pixel_event_read`, and `ads_get_customconversions`.
- Use Graph GET with account-scoped server credentials. Pixel reads first establish membership through the selected account's adspixels edge; ownership pagination follows cursors, never arbitrary next URLs. Reads require only tools:read and emit no write metering.
- Event rules use Meta's documented `/<pixel_id>/event_rules` edge: https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ads-pixel/event_rules . Availability remains subject to upstream permissions/API version.
- Deferred `ads_pixel_parameter_read`: no existing implementation or clearly documented parameter-rules read endpoint was found; do not invent an endpoint. Remaining slices: signals CRUD writes, CAPI test events, preflight.
- Validation: targeted Jest suites and scoped TypeScript check; full project typecheck attempted at 4096 MB heap and exhausted memory. No live Meta calls or production smoke.
- Rollback: revert this change; no persistence changes or Graph mutations.
