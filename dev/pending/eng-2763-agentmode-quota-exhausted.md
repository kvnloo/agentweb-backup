## ENG-2763: Agent Mode classifies OpenRouter quota exhaustion (2026-10-29)

- generateMarketingResponse maps OpenRouter 403 key-limit / 402 credits to QUOTA_EXHAUSTED_USER_MESSAGE; /generate and share routes answer 503 PROVIDER_QUOTA_EXHAUSTED and send one oncall alert per class (6h dedupe) instead of per-occurrence "Unknown Error" pages. Stacked on ENG-2758 classifier.
