# Stripe Connect OAuth

Customer-authorized **read-only** access to a user's own Stripe account so the AgentWeb CRM can enrich contacts with live billing data (paying vs free, MRR, subscription status).

Confirmed flow with Stripe support (Nell, 2026-04-15): our platform is on **Connect Platform + Accounts v2**, but Accounts v2 still uses the classic `connect.stripe.com/oauth/authorize` flow. No Stripe Apps, no OIDC — just the standard OAuth dance.

## Architecture

```
 User (browser)                Backend                         Stripe
 ─────────────                 ─────────                       ─────────
  GET /settings/accounts
          │
          ▼
   [Connect Stripe]  ──► GET /api/stripe/connect/initiate
                              │  (auth)
                              ├──► signState(userId) → JWT
                              ├──► buildAuthorizeUrl(state)
                              │
                              └── 302 ──► connect.stripe.com/oauth/authorize
                                                    │
                                                    │ user authorizes
                                                    ▼
                        GET /api/stripe/connect/callback?code=...&state=...
                              │
                              ├── verifyState (JWT + CSRF)
                              ├── exchangeCodeForTokens(code)
                              │   POST connect.stripe.com/oauth/token
                              │   (Authorization: Bearer STRIPE_SECRET_KEY)
                              │
                              ├── encrypt access_token + refresh_token (AES-256-GCM)
                              ├── userDb.updateUser(userId, { stripeConnectedAccountId, … })
                              │
                              └── 302 ──► /settings/accounts?stripe_connect=success
```

## Files

| Path | Purpose |
|---|---|
| `src/routes/stripeConnect.ts` | `/initiate`, `/callback`, `/disconnect`, `/status`, `/webhook` |
| `src/services/stripeConnectService.ts` | URL builder, token exchange, refresh, deauthorize, `getClientForUser` SDK wrapper |
| `src/utils/stripeConnectCrypto.ts` | AES-256-GCM encrypt/decrypt for tokens at rest |
| `src/services/db.ts` | New `User` fields + `getUserByStripeConnectedAccountId` |

## User schema additions

```ts
stripeConnectedAccountId?: string;   // acct_xxx
stripeConnectedAt?: string;          // ISO datetime
stripeConnectAccessToken?: string;   // AES-256-GCM encrypted
stripeConnectRefreshToken?: string;  // AES-256-GCM encrypted
stripeConnectScope?: string;         // "read_only"
stripeConnectMode?: 'live' | 'test';
```

**Never** return the encrypted tokens in an API response. `/status` returns only `accountId`, `connectedAt`, `scope`, `mode`.

## Environment variables

| Var | Purpose |
|---|---|
| `STRIPE_CONNECT_CLIENT_ID_LIVE` | Live-mode `ca_xxx` from the Stripe dashboard |
| `STRIPE_CONNECT_CLIENT_ID_TEST` | Test-mode `ca_xxx` |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Test-mode Connect webhook signing secret |
| `STRIPE_CONNECT_WEBHOOK_SECRET_LIVE` | Live-mode Connect webhook signing secret (optional; only needed when ingesting live events) |
| `STRIPE_CONNECT_MODE` | `live` or `test`. Default: `live` in prod, `test` elsewhere |
| `CONNECT_TOKEN_ENCRYPTION_KEY` | Key for encrypting tokens at rest. Falls back to `JWT_SECRET`. **Set explicitly in prod** |
| `STRIPE_SECRET_KEY` | Platform secret — used to authenticate the OAuth token exchange |
| `BACKEND_URL` | Base URL used to build the callback redirect URI |

Redirect URIs that must be registered in the Stripe dashboard (already done for the initial set):

- `https://api.agentweb.pro/api/stripe/connect/callback` (prod)
- `http://<test-env-ip>:3001/api/stripe/connect/callback` (test env)
- `http://localhost:3001/api/stripe/connect/callback` (local dev)

## Webhooks

Stripe Connect webhooks arrive on `POST /api/stripe/connect/webhook` with the `account` top-level field identifying the connected account. The raw body middleware is registered in `app.ts` **before** `express.json()` so signature verification works.

We fan each event out into `contactSyncService.syncContact` with `source='stripe'` and `sourceRecordId='stripe-connect-<eventId>'` — the existing CRM timeline (AW-ContactEvents) is the one source of truth.

Supported event types mapped to lifecycle:

| Stripe event | CRM event type |
|---|---|
| `customer.subscription.created` | `payment.subscribed` |
| `customer.subscription.updated` | `payment.updated` |
| `customer.subscription.deleted` | `payment.canceled` |
| `invoice.payment_succeeded` | `payment.updated` |
| `invoice.payment_failed` | `payment.updated` |
| `account.application.deauthorized` | clears the user's Connect fields |

## Token storage

Tokens are encrypted with AES-256-GCM, IV prefix, base64-encoded. Key is derived via `pbkdf2(CONNECT_TOKEN_ENCRYPTION_KEY, 'stripe-connect-salt', 100000)`. Ciphertext is tamper-evident — any bit-flip throws on decrypt. See `src/utils/__tests__/stripeConnectCrypto.test.ts` for the full contract.

Never log raw tokens. `redactToken()` shows `sk_t…7890` at most.

## Dogfood flow

1. Log into the customer portal test env as `founders@agentweb.pro`.
2. Navigate to **Settings → Connected Accounts**.
3. Scroll to the **Stripe (CRM enrichment)** card → click **Connect Stripe**.
4. Authorize on `connect.stripe.com`.
5. Redirect back lands on `/settings/accounts?stripe_connect=success`.
6. `/api/stripe/connect/status` now returns `{ connected: true, accountId: "acct_...", ... }`.

## Testing

- `src/utils/__tests__/stripeConnectCrypto.test.ts` — encryption round-trip, tamper resistance, key rotation, input validation, redaction (13 tests)
- `src/services/__tests__/stripeConnectService.test.ts` — config resolution, URL builder, token exchange, refresh, deauthorize, SDK wrapper (16 tests)

Frontend: `src/__tests__/settings/StripeConnectCard.test.tsx` covers connected / not-connected / error states.

## Known follow-ups (out of scope for v1)

- **D1 enrichment wiring**: `internalEnrichmentService` still queries the platform Stripe account only. Once a user has `stripeConnectedAccountId`, the enrichment lookup should route through `getClientForUser(user)` for that tenant's CRM contacts. One-liner swap via the existing DI surface.
- **Token refresh on 401**: current code returns null on decrypt failure. Add a retry path that exchanges `refreshAccessToken` when Stripe returns `invalid_token`.
- **Per-account webhook routing for multi-tenant**: when multiple AgentWeb users connect the *same* Stripe account (rare but possible), `getUserByStripeConnectedAccountId` returns only the first match. Add a multi-tenant fan-out or a GSI when that hits.
