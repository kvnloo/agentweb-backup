## ENG-3021: No-inference readback routes for get_leads and get_lead_details (2026-11-15)

- `POST /api/emma/leads` `{ list_id, limit?, cursor?, status?, search?, include_all_fields? }` and `POST /api/emma/lead-details` `{ list_id, lead_id }` call the same handlers as Emma's `get_leads` and `get_lead_details` tools (`backend/src/emma/impl/leads.ts`). No model run.
- Read-only. The caller is always the authenticated user; identity fields in the body are ignored and the handlers enforce list access.
- Both are `metered` in `EMMA_ROUTE_BUDGET`, like `POST /search-leads`.
- Purpose: a post-merge verifier can read stored `contactStatus` and unsubscribe evidence through all three lead projections with a fixture token.
