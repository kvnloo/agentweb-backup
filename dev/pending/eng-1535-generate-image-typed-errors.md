## ENG-1535: typed generate_image provider failures (2026-10-11)

- `classifyImageProviderError` maps image-provider failures to transient/rate_limited/quota_exceeded/policy/config/invalid_args; `generateImage` returns `errorClass` + an actionable message, and agent-mode `generate_image` forwards it.
