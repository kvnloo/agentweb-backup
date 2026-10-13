## ENG-1607: twitter_manage_post typed auth vs handler errors (2026-10-13)

twitter_manage_post failures now carry `error_type` (auth_required/rate_limited/validation/credits_exhausted/api) + `retryable`; 401/403/no-account are non-retryable auth_required with a reconnect step. Input validation errors are typed; JSON-string/single-string `tweets`/`tweet_ids` are coerced instead of failing. Tests: backend/src/__tests__/emma/twitterManagePostErrors.test.ts.
