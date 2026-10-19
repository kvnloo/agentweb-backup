## ENG-503: Retry and classify truncated provider JSON (deserialization) errors (2026-10-16)

Truncated provider bodies ("Unterminated string in JSON ... Deserialization error") are now transient: callLLM retries once in-call, and the generate-response oncall alert carries errorClass provider_deserialization with a per-user dedupe key.
