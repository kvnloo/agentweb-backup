## ENG-2663: LinkedIn rejects a just-refreshed token with 401 "revoked" (2026-10-26)

**Symptom:** a scheduled post failed with "Account token expired. Please reconnect"; the customer got a false disconnect alarm. The account was never disconnected: the same stored token posted fine 71s later (session 60f683ab, 2026-10-25). Same signature on 2026-10-13. Only 2 such 401s in 14 days of prod logs, both recovered with no reconnect.

**Theory (n=2, unproven):** LinkedIn briefly rejects an access token used right after a refresh grant minted it. LinkedIn's docs say nothing; one 2021 Stack Overflow report says 5-10s second-hand, 3-5 min first-hand.

**Fix:** a 401 on a token minted under 5 minutes ago (age derived from `token_expires_at` and the 60-day lifetime, so it holds across calls and hosts) is retried once after 10s for post, image upload, comment, repost and reaction. If it still fails, the adapter throws `FreshTokenRejectedError` (declared class `upstream_5xx`, so the model sees `Retryable: yes` and is told not to ask for a reconnect); the engagement executor reschedules it 30 minutes later. A 401 on an older token still says reconnect.

**Not done:** the delay is a guess; nothing was run against live LinkedIn. After deploy, grep prod logs for `ENG-2663: 401 on a just-refreshed token`. Refreshing tokens ahead of expiry was judged over-engineering for two incidents.

**Do not re-introduce** token introspection in `verifyToken`: it checks a just-minted token and can mark healthy accounts inactive.
