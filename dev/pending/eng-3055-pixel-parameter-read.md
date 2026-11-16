## ENG-3055: Zoma read tool ads_pixel_parameter_read (2026-11-16)

New read-only Meta toolkit tool `ads_pixel_parameter_read` in `backend/src/mcp/metaToolkitSignals.ts`. It reads
`GET /{pixel_id}/extractors`, the edge Meta documents as "Extractors used for grabbing parameters in codeless
events" (Ads Pixel Extractors reference, checked 2026-11-16).

- Same path as `ads_pixel_event_read`: read scope only, pixel must be in the selected ad account before the
  pixel is read, one page per call with `limit` and `after`, paging URLs dropped and cursors kept.
- No `fields` are requested, because Meta publishes no reference page for the returned node (`SignalsIWLExtractor`).
  The tool returns whatever Meta returns by default.
- Meta's `current_domain` filter is not exposed.
- Parity matrix row is now `covered`. Signals has no open gap.

Not proven: no live Meta request has been made through this tool. Tests mock Graph. The edge page states no
required permission, so whether the standard ads read permission is enough on a real account is unknown.
