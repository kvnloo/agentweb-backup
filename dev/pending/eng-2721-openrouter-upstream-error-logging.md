## ENG-2721: Log OpenRouter provider_name + raw upstream reason on provider errors (2026-10-28)

`normalizeOpenRouterErrorMetadata` now reads the top-level `metadata.provider_name`
and a bounded (500 char) `metadata.raw` as `upstream_error`. A "400 Provider returned
error" mid-run (schedule 04b34124, gemini-3.8-flash) previously logged
`provider: undefined` with no upstream reason, so the root cause was unrecoverable.
