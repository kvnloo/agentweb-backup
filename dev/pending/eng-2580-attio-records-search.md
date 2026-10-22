## ENG-2580: call_attio_api RECORDS SEARCH/LIST + entity_type inference (2026-10-19)

- call_attio_api gains read-only RECORDS SEARCH (people by name/email, companies by name) and RECORDS LIST (paged).
- Normalizes prod failure shapes: `search_records` with `params.query` and no entity_type, and entity_type PERSON/COMPANY aliases. entity_type is no longer schema-required; the handler returns a clear error when it cannot infer one.
