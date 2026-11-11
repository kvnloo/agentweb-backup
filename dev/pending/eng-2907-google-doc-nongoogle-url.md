## ENG-2907: read_google_doc refuses non-Google URLs (2026-11-10)

`read_google_doc` now rejects http(s) URLs not on docs/sheets/drive.google.com before calling Drive (previously a luma.com URL was sent as a fileId, 404d, and clustered as a config failure). The refusal classifies as `by_design`.
