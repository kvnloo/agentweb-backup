## ENG-2817: Delete dead FEATUREBASE_INTAKE flag-off Notion fallback (2026-11-05)

`fileUserIssue` always files to Linear/Featurebase; the `FEATUREBASE_INTAKE` env read and the
unreachable `createOncallItem` Notion fallback (and its export in `notionService.ts`) are gone.
Test mocks that stubbed `createOncallItem` were removed; suites that asserted the filing payload
via the Notion stub now stub `fileUserIssue` directly. Notion board/webhook/tokens untouched (ENG-23/ENG-8).
