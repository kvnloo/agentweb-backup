## ENG-3060: Zoma meta_send_test_event, a Conversions API test event (2026-11-16)

- New Meta toolkit tool `meta_send_test_event` in `backend/src/mcp/metaToolkitEventSources.ts`: sends one Conversions API event to a dataset of the selected ad account, always with `test_event_code`.
- Meta does not drop test events (they count toward targeting and measurement), so the send uses the `zomaWriteGuard` preview and single-use token, and the preview says so.
- `email`, `phone` and `external_id` are SHA-256 hashed before sending; `client_ip_address`, `client_user_agent`, `fbc`, `fbp` are sent as given, per Meta's rules. Other user data keys are refused.
- A dataset outside the account returns 403 (`MetaToolkitForbidden`), before any POST.
- `writeToolkitMetaCatalogGraph` now allows `<id>/events` and refuses it without `test_event_code`.
- No storage. Tests: `backend/src/__tests__/eng3060.metaCapiTestEvent.test.ts` (mocked Graph only; no live send has been made).
