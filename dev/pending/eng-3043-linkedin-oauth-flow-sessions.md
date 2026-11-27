## ENG-3043: LinkedIn and LinkedIn Ads pending OAuth sessions on AW-OAuthSessions (2026-11-27)

- `routes/linkedinAuth.ts` and `services/linkedInAdsOAuthFinalize.ts` (behind `routes/linkedInAdsAuth.ts` and Zoma's LinkedIn Ads connect pages) no longer hold pending token sessions in a module-level `Map` with a `setInterval` sweeper. They call `storeOAuthFlowSession` / `consumeOAuthFlowSession`, as HubSpot, Fathom and the Google routes (ENG-3042) do, so `/finalize` and `/connect` may land on different instances.
- One step, no Map fallback. During the deploy that ships this, a user whose instance is replaced between `/finalize` and `/connect` gets the same 401 "Please reconnect" they get today.
- `PendingOAuthSession.provider` gains `linkedin` and `linkedin_ads` (type only). No table, key, index, TTL or access-policy change. The payloads are the old in-memory shape: tokens (with `scopes`, plus `personUrn` for Ads) and, for Ads, the account-id → organization-URN map; `consumeOAuthFlowSession` validates them per provider.
- Behaviour changes: a store outage at `/finalize` or `/connect` is now the route's 500, not a silent 401. A different user presenting a LinkedIn Ads session id no longer burns it (the conditional delete fails), matching LinkedIn and the other providers.
- linkedinAuth's `[TokenSession] Stored/Retrieved ...` log lines are gone with the Map.
