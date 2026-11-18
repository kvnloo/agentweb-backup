# Credential ciphertext derived from JWT_SECRET: inventory (ENG-3118, parent ENG-1757)

Source: `origin/main` at `913922e57` (2026-11-16). Built by `git grep` and reading each call site.
Tables and attributes come from the code only. No production rows were read and nothing under
`backend/src` changed. Test files (`__tests__`, `*.test.ts`) are excluded.

## The two schemes

| Scheme | Code | Key | JWT-sign layer | Dependence on JWT_SECRET |
|---|---|---|---|---|
| A. `encryptPassword` / `decryptPassword` | `backend/src/utils/crypto.ts:10-15,16-41,43-69` | `pbkdf2Sync(JWT_SECRET, 'salt', 100000, 32, 'sha256')`, AES-256-GCM, 16-byte IV | Yes: plaintext is `jwt.sign({password, userId}, JWT_SECRET)` before encryption and `jwt.verify` after decryption | **Both** layers |
| B. `encryptConnectToken` / `decryptConnectToken` | `backend/src/utils/stripeConnectCrypto.ts:19-31,33-58` | `pbkdf2Sync(CONNECT_TOKEN_ENCRYPTION_KEY \|\| JWT_SECRET, 'stripe-connect-salt', ...)`, AES-256-GCM, 12-byte IV | No | **PBKDF2 key only, and only if `CONNECT_TOKEN_ENCRYPTION_KEY` is unset in that environment** (fallback at line 20). Whether prod sets it was not checked (no prod config read). |

A third copy of scheme A's PBKDF2 key exists in a one-off script:
`backend/src/scripts/encrypt-passwords.ts:24-36,94` (local `encryptPassword(signedPassword)`, same
`'salt'` derivation). It writes the same shape as scheme A into AW-Configs (see row 1); it is a
migration script, not a runtime path.

Out of scope (JWT_SECRET used for signing/hashing, not reversible stored ciphertext): `config/jwt.ts`
(auth tokens), `mcp/zomaSetupLinks.ts`, `services/resultEndpointReview.ts`,
`services/voice/hotLeadCallLimits.ts`, `utils/emailLeadId.ts:50`, `utils/unsubscribeUrl.ts`,
`routes/internalUsage.ts`. Rotating JWT_SECRET invalidates those links/tokens/hashes but loses no data.

## Stores, writers and readers (scheme A unless marked)

| # | Store (table . attribute) | Writers (file:line) | Readers (file:line) | Layers |
|---|---|---|---|---|
| 1 | `AW-Configs` . `encryptedPassword` (website login configs) | `routes/config.ts:108`, `routes/config.ts:144` (put at `:113-116`); `scripts/encrypt-passwords.ts:94` | `emma/tools.ts:9279` (decrypts `match.encryptedPassword \|\| match.password` from an `AW-Configs` query, `:9247-9273`); `routes/config.ts:251` returns the ciphertext unchanged to its caller | both |
| 2 | `AW-Users` . `secrets.<name>` (admin-set user secrets map, incl. `GITHUB_PERSONAL_ACCESS_TOKEN` / `github_access_token`) | `routes/admin.ts:1632` (saved at `:1640` via `userDb.updateUser`) | `routes/landingPages.ts:63` (GitHub token, `:55-62`) | both |
| 3 | `AW-Users` . `secrets.clickup_access_token` (personal) | `routes/clickupAuth.ts:243`, `:307` | `routes/clickupAuth.ts:368`, `services/clickupService.ts:82` | both |
| 4 | `AW-Organizations` . `secrets.clickup_access_token` | `routes/clickupAuth.ts:234`, `:299`, `:383` (`orgDb.setOrgSecret` / `setOrgSecretIfAbsent`, `services/db.ts:12726,12774`, table `ORGS_TABLE` `services/db.ts:12254`) | `routes/sourceAccess.ts:59`, `services/clickupService.ts:70` | both |
| 5 | `AW-Users` . `secrets.foreplay_api_token` | `routes/foreplayAuth.ts:57` | `services/foreplayService.ts:116` | both |
| 6 | `AW-Organizations` . `secrets.foreplay_api_token` | `routes/foreplayAuth.ts:49` | `services/foreplayService.ts:104` | both |
| 7 | `AW-Users` . `connected_accounts[platform=luma].config.access_token` | `routes/lumaAuth.ts:52` (via `connectedAccountsDb.createAccount`, `services/connectedAccountsDb.ts:496`, which writes `user.connected_accounts` through `userDb`) | `emma/lumaTools.ts:167` | both |
| 8 | `AW-Users` . `connected_accounts[platform=smartlead].config.access_token` | `routes/smartleadAuth.ts:69` (same path as 7) | `services/smartleadConnection.ts:88` | both |
| 9 | `AW-LeadLists` . `externalCrmSyncConfigs.<hubspot\|attio\|...>.apiKeyEncrypted` | `services/externalCrmSyncService.ts:397` (`saveConfig`, `:267`) | `services/externalCrmSyncService.ts:498`, `emma/impl/adsCrmApis.ts:1465` (hubspot), `services/agentMode/attioTools.ts:83` (attio) | both |
| 10 | `AW-BrowserCookies` . `encryptedCookies` | `services/db.ts:11414` (table `services/db.ts:11341`) | `services/db.ts:11533` | both |
| 11 | `AW-Settings` row `mcp_servers` (JSON value) . `servers[].accessToken` | `routes/mcpServers.ts:194`, `:284` (`settingsService.setSetting("mcp_servers")` `:204`; table `services/settingsService.ts:74`) | `routes/mcpServers.ts:279`, `:409`; `mcp/client/mcpClientService.ts:117`, `:860`, `:879`, `:1276`, `:1448` | both |
| 12 | `AW-Settings` row `mcp_servers` . `servers[].oauthClientInfo` and `servers[].oauthTokens` | `mcp/client/mcpOAuthClientProvider.ts:241`, `:265` (setting `SERVERS_SETTING`, `:23`, written `:71`) | `mcp/client/mcpOAuthClientProvider.ts:231`, `:251` | both |
| 13 | `AW-Settings` row `mcp_oauth_sessions` . `<state>.codeVerifierEnc` (pending PKCE, short-lived) | `mcp/client/mcpOAuthClientProvider.ts:144` (setting `PENDING_SETTING`, `:24`, written `:128`) | `mcp/client/mcpOAuthClientProvider.ts:159` | both |
| 14 (B) | `AW-Users` . `stripeConnectAccessToken`, `stripeConnectRefreshToken` | `services/stripeConnectService.ts:204-205` (saved `:209` via `userDb.updateUser`) | `services/stripeConnectService.ts:236`, `:246` | PBKDF2 only, via fallback |

## Counts

- Distinct tables: **6** — AW-Configs, AW-Users, AW-Organizations, AW-LeadLists, AW-BrowserCookies, AW-Settings.
- Distinct table.attribute stores: **14** (13 under scheme A, 1 under scheme B).
- Production writer call sites: 22 (scheme A 20 incl. the script, scheme B 2). Reader call sites: 26 (scheme A 24, scheme B 2).

## If JWT_SECRET rotated today

- Rows 1-13 (every scheme-A store) become unreadable: the PBKDF2 key changes, so GCM auth fails, and
  even with the old key the inner `jwt.verify` would fail under the new secret. Every saved website
  login, admin/user secret, ClickUp/Foreplay token (user and org), Luma and Smartlead API key, CRM
  sync API key, saved browser cookie set, and MCP server token / OAuth client / OAuth token would
  need to be re-entered or re-encrypted. Row 13 is transient (pending OAuth handshakes) and only
  in-flight connects would fail.
- Row 14 is unreadable **only** in an environment where `CONNECT_TOKEN_ENCRYPTION_KEY` is unset.
  Prod env was not inspected; the migration plan should confirm it before assuming either way.
- Implication for ENG-1757: a rotation needs a dual-key read (old secret then new) for both layers of
  scheme A, a re-encrypt pass over the 13 stores above (a data-plane change, Harsha approval), and
  a separate key for scheme A so auth-token rotation and data encryption are decoupled.
