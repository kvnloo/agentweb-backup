## ENG-3042: Google Ads, Google Drive and YouTube pending OAuth sessions moved to AW-OAuthSessions (2026-11-15)

- The three routes no longer hold pending token sessions in a module-level `Map` with a `setInterval` sweeper. They call `storeOAuthFlowSession` / `consumeOAuthFlowSession`, as HubSpot and Fathom do, so `/finalize` and `/connect` may land on different instances.
- One step, no Map fallback: ENG-966 shows a fallback to another process's memory is unreachable. During the deploy that ships this, a user whose instance is replaced between `/finalize` and `/connect` gets the same 401 "Please reconnect" they get today.
- `PendingOAuthSession.provider` gains `google_ads`, `google_drive`, `youtube`. No table, key, index, TTL or access-policy change.
- Google Ads stores the flattened connectable-leaf list in the row. A manager account with thousands of client accounts could exceed DynamoDB's 400 KB item limit; that would surface as the `/finalize` 500. Not measured.
