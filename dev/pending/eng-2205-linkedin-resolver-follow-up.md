## ENG-2205: LinkedIn account resolution after the Unipile outage fix (2026-10-07)

- **Root cause (#3275):** a 4-day Unipile outage (502 for every account) made the binary `isAccountConnected` probe
  fail for the whole pool, so `resolveAccountId*` returned null and users were told to connect an account they
  already had. Fix: the resolvers use the tri-state `probeAccountSession`; only a PROVEN `disconnected` is skipped,
  an `unknown` account is returned as a last resort (own before pool).
- **Side effects handled in #3341:** a caller that then makes a real call can throw an infrastructure error.
  `isLinkedInInfraError` (utils/linkedInInfraError.ts: credential fetch, gateway html, transport errors, timeouts,
  and SERVER_ERROR only for gateway statuses 502/503/504 and Cloudflare-style 520-524 - a plain 500 can be
  request-specific) maps these to a handled 503 on
  send-linkedin-message, send-linkedin-invite, sync-linkedin-connections and the prospect preview.
  `import_leads_from_search` hands the agent the generic text and, on a PROVEN dead session only
  (`isProvenDisconnectError`, which excludes a bare 403), clears the probe cache and records account health with
  `ownerUserId` omitted for a shared-pool account.
- **Enrichment is deliberately unchanged from before #3275:** CRM enrichment uses
  `resolveAccountId(userId, { verifiedOnly: true })` (null unless an account is proven live => LinkedIn skipped);
  `resolveAccountIdForEnrichment` is restored byte-for-byte. The skip warning now says "temporarily unreachable"
  when an account exists but could not be verified, and keeps "No LinkedIn (Unipile) account connected" otherwise.
- **Authorization (pre-existing hole):** a client-supplied `accountId` on send-linkedin-message / send-linkedin-invite
  and a sequence step's pinned `linkedInAccountId` were never checked. They now require
  `resolveLinkedInAccountForWrite` (caller's own or org-shared) => 403 with `code: linkedin_account_not_connected`.
  Only LinkedIn-channel steps are checked (a pin left on an email step is inert), and on PUT pins already stored on the
  caller's own LinkedIn steps are exempt so an unrelated edit still saves after an account is disconnected. The drip
  worker re-checks the pin at send time and snoozes that enrollment 30 minutes (typed
  `PinnedLinkedInAccountNotConnectedError`); a failed ownership lookup keeps the normal retry.
- **send-linkedin-message:** the engagement write after a successful send is retried twice (keyed put with a fixed
  event id, so a retry overwrites rather than duplicates); if it still fails the route returns success with
  `engagementRecorded: false` instead of a failure that invites a duplicate message.
- **Ownership gate** (`resolveLinkedInAccountFromList`) accepts either of a row's two ids (`account_id` or Unipile's
  `config.unipile_account_id`; they differ on legacy rows, as `scheduledRunAccountGate` already assumes). Both ids belong
  to a row already scoped to the caller's own/org-shared accounts, so this widens naming, not access.
- **import_leads_from_search** records an account as disconnected immediately only for Unipile's explicit
  `errors/disconnected_account`; a bare 401 needs a fresh probe to confirm first (recording pauses scheduled runs and
  emails the owner).
- **Still true, by design (tracked in ENG-2347):** read/search tools, send-linkedin-message auto-resolve, the full
  resync route and the drip worker's auto-resolved account may use the site-wide pool.
