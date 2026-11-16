## ENG-3056: six pixel rule write rows in the Zoma parity matrix are not applicable (2026-11-16)

`backend/src/mcp/zomaMetaParityMatrix.ts` no longer lists `ads_pixel_event_create/update/delete` and
`ads_pixel_parameter_create/update/delete` as gaps. They are `not_applicable`: Meta's public Marketing API
reference documents no write for pixel event rules or parameter extractors.

Checked 2026-11-16 (v25.0 reference):

- `ads-pixel/event_rules`: read only. Creating, updating and deleting each say "You can't perform this operation on this endpoint."
- `ads-pixel/extractors`: read only, same three statements.
- `ads-pixel` (Ad Pixel): no other rule or parameter edge. Its own update takes pixel settings only, and it has no delete.
- No reference page exists for the rule nodes `CalibratorExistingRule` or `SignalsIWLExtractor`.

Meta's own Ads MCP server lists these six tools. How it performs them is not in the public reference.
No tool, handler or Meta call was added. `ads_pixel_parameter_read` stays a gap (ENG-3055); the public
`extractors` read exists for it.
