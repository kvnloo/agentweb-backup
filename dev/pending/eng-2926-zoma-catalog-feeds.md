## ENG-2926: Zoma catalog create/update, product feeds, upload sessions, feed rules (2026-11-11)

- New `backend/src/mcp/metaToolkitCatalogFeeds.ts`: 10 Meta Toolkit tools; feed/rule deletes are preview -> confirm; every write is read back; feed URLs https-only with no embedded credentials, query strings redacted on echo.
- Feed listing stays `meta_list_product_feeds` (ENG-2918).
