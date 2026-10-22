## ENG-949: v0 429 backoff honours Retry-After (2026-10-20)

withRetry now waits Retry-After (or a 20s floor, 120s cap) on v0 HTTP 429 instead of the 2s/4s generic backoff, and tags exhausted rate limits as V0_RATE_LIMITED with a recoverable message.
