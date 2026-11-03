## ENG-1281: Retire Google Custom Search provider ahead of Jan 2027 sunset (2026-11-02)

- Deleted `backend/src/search/googleSearchProvider.ts`; no code path calls `google.customsearch` anymore.
- `google_search_web` stays registered as a legacy alias and is served by You.com web search (same result shape, `provider: 'you'`, `toolName` unchanged).
- `google_cse` removed from `METERED_VENDOR_PROVIDERS` (no live adapter); rate-card entry kept so historical ledger rows still price.
- Decommission after merge: `GOOGLE_SEARCH_API_KEY` / `GOOGLE_SEARCH_ENGINE_ID` secrets and the Google Cloud project's Custom Search API key.
