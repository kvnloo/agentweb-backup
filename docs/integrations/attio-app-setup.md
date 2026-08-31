# Attio OAuth App Setup

Last derived from code: 2026-08-31

Owner area: whoever holds AgentWeb's Attio developer account (Harsha as of
this writing)

This is an **operational runbook**, not a code contract — it documents how to
register/manage the Attio OAuth app itself on Attio's side, so the backend's
already-built Attio integration (`ENG-1380`) can actually complete the OAuth
handshake in each environment. It does not duplicate
[`external-integrations-map.md`](./external-integrations-map.md) or the
contract template's data-shape/failure-mode format — those are about what the
code believes; this is about the one-time external setup step that has to
happen outside the repo before any of that code can run end-to-end.

## Why this exists

The backend OAuth integration (`attioAuth.ts`, `attioService.ts`,
`attioAdapter.ts`, `config/integrations.ts`) was built at parity with the
existing HubSpot integration, but it depends on an app being registered in
Attio's own developer portal — client ID, client secret, redirect URI, and
scopes all have to match what the code sends. There was no written record in
this repo of how that registration was done the first time, which made it
tribal knowledge. This doc exists so the next time this needs to happen
(a new environment, a credential rotation, a new person taking over the
account) it doesn't have to be reverse-engineered from code again.

## Prerequisites

- Access to (or ownership of) the Attio workspace/account used to register
  AgentWeb's developer app — check whether one already exists before creating
  a second one (see "Existing app vs. new app" below).
- Access to update AWS Secrets Manager for the target environment (`dev` or
  `prod`), or someone who does.

## Existing app vs. new app

Check first whether an Attio developer app already exists for AgentWeb before
registering a new one — there's no record in this repo of who created the
original one or its current review status. Registering a second app when one
already exists just creates a second set of credentials to track and a
confusing choice about which one is live.

## Steps

### 1. Register (or open) the OAuth app

In the Attio workspace: **Settings → Developers → Apps** (or
`developers.attio.com`, per Attio's own docs — the exact path may have moved;
follow Attio's current developer-portal navigation). Create a new app, or open
the existing AgentWeb app if one is already registered.

### 2. Set the redirect/callback URI

Must match exactly what the backend sends in the `/authorize` request
(`config/integrations.ts` → `attio.redirectUri`, built as
`` `${BACKEND_URL}/api/oauth/attio/callback` ``):

| Environment | Redirect URI |
| --- | --- |
| Production | `https://api.agentweb.pro/api/oauth/attio/callback` |
| Staging | `https://api-stage.agentweb.pro/api/oauth/attio/callback` |

### 3. Enable scopes on the app

Attio scopes are configured in the app's dashboard settings, **not** negotiated
per-request — the `scopes` array in `config/integrations.ts` is sent along
with the `/authorize` call but is inert unless the app itself has the
corresponding scope enabled. Based on every Attio API endpoint the integration
actually calls (`attioService.ts`), the app needs:

- **Records** — read/write (create, update, delete person/company records)
- **Lists & list entries** — read/write (list membership, deal-analog entries)
- **Objects & attributes** — read/write (the integration auto-creates custom
  attributes on connect)
- **Webhooks** — read/write (`webhook:read-write` — the one scope pinned
  explicitly in code, `config/integrations.ts` line ~176)

If Attio's dashboard groups these differently or under different labels by
the time this is read, cross-check against `attioService.ts`'s actual API
calls rather than guessing — a missing scope fails silently as a 403 at
runtime, not at app-creation time.

### 4. Get the client ID and secret, store them in Secrets Manager

Once the app is created/confirmed, copy its Client ID and Client Secret into
AWS Secrets Manager as a single JSON secret (read by
`getAttioCredentials()` in `utils/secretsManager.ts`):

| Environment | Secret name |
| --- | --- |
| Development | `dev/AgentWeb/Attio` |
| Production | `prod/AgentWeb/Attio` |

Secret value shape:

```json
{ "clientId": "...", "clientSecret": "..." }
```

```bash
aws secretsmanager create-secret \
  --name prod/AgentWeb/Attio \
  --secret-string '{"clientId": "...", "clientSecret": "..."}'
# repeat with dev/AgentWeb/Attio for development, and different real values
```

There are no `ATTIO_*` entries in `.env.example` — this integration is
Secrets-Manager-only, unlike some others that have an env-var fallback path.

### 5. Confirm the app is actually published/approved on Attio's side

Registering the app is not the same as it being usable — per this feature's
original scoping notes, Attio's own review/publication of the app was
pending at the time the integration was built. An unpublished/unapproved app
can still redirect through `/authorize` and fail at the token-exchange step,
which looks like a backend bug but isn't one. Confirm the app's status
directly in Attio's developer portal before treating this as done.

## Verifying it works end-to-end

1. In AgentWeb, go to Settings → Connected Accounts → connect Attio.
2. Confirm the OAuth redirect lands back on the customer portal with a
   success state (not an error param) — `attioAuth.ts`'s `/callback` route
   relays `code`/`state`/`error` straight through to
   `${CUSTOMER_FRONTEND_URL}/oauth/attio/callback`, so a misconfigured
   redirect URI or unapproved app shows up here first.
3. Confirm `/finalize` succeeded — this is where the actual token exchange
   against `https://app.attio.com/oauth/token` happens and workspace info is
   fetched from `https://api.attio.com/v2/self`. A wrong client secret or an
   unapproved app fails here specifically.
4. Configure a lead list's CRM sync to Attio and push a test lead — confirms
   the record/list scopes are actually granted, not just the connection
   itself.
5. Confirm a webhook gets registered (`ensureAttioWebhook`,
   `utils/attioWebhookSubscription.ts`) — this is the step that needs
   `webhook:read-write` specifically; a missing scope here sets
   `needs_reconnect: true` on the connected account rather than failing loudly,
   so check for that flag if webhook-driven auto-pull doesn't seem to be
   working after connecting.

## Related code

| Area | Path |
| --- | --- |
| OAuth config (redirect URI, scopes, endpoints) | `backend/src/config/integrations.ts` |
| OAuth routes (`/init`, `/callback`, `/finalize`) | `backend/src/routes/attioAuth.ts` |
| Credential storage | `backend/src/utils/secretsManager.ts` (`getAttioCredentials`) |
| Webhook registration | `backend/src/utils/attioWebhookSubscription.ts` |
| Route mount point | `backend/src/app.ts` (`/api/oauth/attio`) |
