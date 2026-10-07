## ENG-2205: LinkedIn account resolution after the Unipile outage fix (2026-10-07)

- **Root cause (#3275):** a 4-day Unipile outage (502 for every account) made the binary `isAccountConnected` probe
  fail for the whole pool, so `resolveAccountId*` returned null and users were told to connect an account they
  already had. Fix: resolvers use the tri-state `probeAccountSession`; only a PROVEN `disconnected` is skipped, an
  `unknown` account is returned as a last resort (own before pool).
- **Side effects handled in #3341:** any caller that then makes a real call can throw an infrastructure error.
  `isLinkedInInfraError` (utils/linkedInInfraError.ts) maps credential-fetch/gateway/transport failures to a handled
  503 on send-linkedin-message, sync-linkedin-connections and the prospect preview. CRM enrichment keeps the
  pre-fix behavior via `resolveAccountId(userId, { verifiedOnly: true })`; `resolveAccountIdForEnrichment` is
  unchanged. `{ ownOnly: true }` = never the shared pool.
- **Authorization:** a client-supplied `accountId` was passed straight to Unipile by send-linkedin-message and
  send-linkedin-invite, and a sequence step's `linkedInAccountId` was stored unvalidated and used by the drip
  worker to send. All three now require the account to be the caller's own or org-shared
  (`resolveLinkedInAccountForWrite`); the worker re-checks at send time for sequences saved before the check existed.
- **Still true, by design:** read/search tools and the drip worker's AUTO-resolved account may still fall back to the
  site-wide pool. send-linkedin-message no longer does.
- **Tooling lesson:** Opslane (black-box PR verifier) found two real bugs here that unit tests and four reviews
  missed. Read its report on the final head before merging.
