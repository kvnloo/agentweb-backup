## GROW: Split paid Google/YouTube traffic channels (2026-10-14)

- Traffic classifier 2.1.0: paid `google_search` -> `Google Ads` (`google_ads`), paid `youtube` -> `YouTube Ads` (`youtube_ads`). Organic unchanged.
- Routing rules keyed on `google_search`/`youtube` still match the paid variants.
- `backend/scripts/backfill-paid-channel-split.ts`: dry-run by default, reversible (`--revert`), conditional writes. Needs Harsha approval before `--apply` in prod.
