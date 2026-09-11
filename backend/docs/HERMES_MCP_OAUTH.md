# Hermes native OAuth with Emma (ENG-1869)

## Diagnosis, 2026-09-11

Inspected Hermes commit `7d13442bd0987c3936158fc9855114c0cef6e896`
read-only, including its installed Python MCP SDK. Production discovery, public
DCR using Hermes metadata, and authorization URL generation already succeed;
`/oauth/authorize` returns 302 to `https://app.agentweb.pro/oauth/authorize`.
No production token was issued during this investigation.

The reproduced initial headless refusal is client-side, not a server protocol
incompatibility: `tools/mcp_oauth.py` and `mcp_oauth_manager.py` reject background
OAuth without cached tokens. `hermes_cli/mcp_config.py::_reauth_oauth_server`
explicitly enables interactive OAuth for `hermes mcp login`, including non-TTY
stdin. The paste reader consumes stdin; it does not subscribe to Slack messages.
A server change cannot connect Slack messages to that running process.

## Native flow from a Slack-operated terminal

1. Keep a persistent terminal/PTY session open on the Hermes host and run:
   `hermes mcp add emma --url https://api.agentweb.pro/mcp --auth oauth --connect-timeout 315`.
   If already configured for OAuth, use `hermes mcp login emma` instead.
2. Relay its authorization URL to the user. Keep the same process and stdin
   alive while the user signs in and approves in their browser.
3. A browser failure at `http://127.0.0.1:<port>/callback?...` is expected when
   the browser is on a different machine. Copy the **entire address-bar URL**.
4. Forward the pasted URL plus Enter to that waiting process's stdin. Posting
   it in Slack alone does not deliver it to Hermes's callback reader. Do not
   start another login: it would generate a different state and PKCE verifier.
5. Hermes checks state, exchanges the one-time code using its retained verifier,
   caches tokens, and discovers tools. Complete any CLI tool-selection prompt.
   Reload/restart gateway MCP discovery if it was already running.

The add command otherwise has a 30-second connection timeout; the explicit
315-second timeout above covers the native 300-second callback wait. Login
already applies that timeout floor. If expired, start a fresh
login. Never paste an access token, refresh token, or password into chat. Treat
callback URLs as short-lived credentials; do not put them into logs or issues.

## Security and persistence behavior

Credentials are validated before an authorization code is consumed: registered
client authentication first, then exact supplied client/redirect binding and PKCE
S256. The conditional write rechecks unused state, expiry, challenge, method and
supplied bindings. Wrong verifiers or secrets leave the valid code usable;
concurrent valid exchanges issue one pair. OAuth 2.1 permits omission of the
redundant token-request `redirect_uri`; supplied values must match exactly.

Refresh requires the issuing `client_id` (or Basic identity) and authenticates
confidential clients using their registered Basic or POST method. The existing `RefreshTokenHashIndex` only locates a record;
strongly consistent primary-key reads establish current state. One DynamoDB
transaction consumes the old refresh token, creates its successor, and checks
that the root family is active. Recognized transaction conflicts receive bounded
retries; other storage failures propagate and do not issue tokens.

Authenticated, correctly bound replay sets the root's `familyRevoked` flag.
Every descendant refresh and access validation checks that root. Concurrent use
therefore yields one token response, but the losing replay disables the winning
family too: the server cannot determine which caller is legitimate. Clients must
serialize refresh and reauthenticate after replay or a lost successful response.
This follows [RFC 9700 §4.14.2](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2).

No table, key, index, TTL configuration, migration, or backfill is required.
Existing token items gain `familyId`, root-only `familyRevoked`, and
`accessExpiresAt`. `expiresAt` remains DynamoDB's TTL attribute but now retains
all family records through the fixed 30-day refresh expiry; access remains valid
for at most one hour. Refresh does not extend the family deadline. DynamoDB
transactions and consistent reads increase per-request storage work, and replay
records remain longer than the former one-hour TTL.

**Legacy compatibility:** existing access tokens keep their original expiry.
Existing refresh tokens without family lineage require a new authorization/login;
there is no reliable way to tell whether an old record has already-rotated
ancestors. Previously consumed legacy tokens cannot identify their successors.
Missing/TTL-deleted records also require login. No production data is changed by
this PR before deployment, and no backfill is proposed.

**Rollback:** do not blindly revert the access-token reader after new records
have been issued: old code would mistake the retention TTL for access expiry and
would ignore family revocation. Retain the new access-expiry/family checks during
a partial rollback, or explicitly revoke affected families before reverting them
(a separate approved data-plane action). Reverting the refresh writer alone also
reopens the original refresh vulnerabilities. Prefer a forward fix.

## Verification

All checks run in this worktree on Atem. Strict TDD evidence for this review:

- Initial RED: **17 failed, 6 passed** (credential preservation and refresh protection).
- Boundary/legacy RED: **11 failed, 33 passed** (malformed data, untraceable legacy refresh, actual access lifetime).
- Transaction-conflict RED: **2 failed, 44 passed**.
- Registration-review RED: **5 failed, 46 passed**.
- Credential-transport RED: **4 failed, 51 passed**.
- Final GREEN: **164 tests passed across six suites**, including native Hermes and
  the neighboring MCP auth/security suites. Their existing timer-teardown warning
  remains; the native fixture exits cleanly.

The original native replay assertion now retries with the **original valid PKCE
verifier**, so rejection proves one-time use. The concurrency tests assert the
exact conditional write and evaluate each condition against mutable storage,
including changes between read and write. The shared storage fixture evaluates
supported DynamoDB expressions and transaction atomicity; it fails on unsupported
syntax. It is not a live DynamoDB service or an IAM/deployment test.

Run from repository root:

```sh
node backend/node_modules/jest/bin/jest.js --config backend/jest.config.js --runInBand --runTestsByPath backend/src/mcp/oauth/__tests__/oauthRoutes.test.ts backend/src/mcp/oauth/__tests__/oauthService.test.ts backend/src/mcp/oauth/__tests__/oauthSecurity.test.ts
HERMES_REPO=/path/to/hermes-agent node backend/node_modules/jest/bin/jest.js --config backend/jest.config.js --runInBand --testPathIgnorePatterns=/node_modules/ --runTestsByPath backend/src/__tests__/e2e/hermes-oauth.e2e.test.ts
cd backend
npm run typecheck
npm run build
```

The explicit native test requires Hermes's installed `venv/bin/python`; it fails
rather than silently skips when unavailable. It exercises real Emma routes,
OAuth service, MCP authentication/transport, Hermes provider and native callback
waiter/paste reader. DynamoDB, portal login/consent UI, telemetry, and business tool
inventory are fixtures. It verifies state rejection, incorrect PKCE rejection,
valid-verifier code replay rejection, token hashing, and an MCP tool seeing the
authenticated user as external. It does **not** prove a live Slack adapter or real
portal login. This PR implements no Slack callback bridge: Hermes orchestration
must forward a later Slack callback message into the **original persistent
process's stdin**; a fresh process or another Slack message alone cannot finish it.

Post-deploy smoke (not run; **do not merge this PR**): complete the native flow
with an authorized test account, verify tools connect, reject a wrong verifier
without consuming the code, verify valid-verifier replay rejection, refresh once,
then replay the ancestor and verify the successor is unusable. Avoid logging
callback URLs or tokens. Production discovery/DCR/authorization redirects were
probed in the original investigation; no production token/tool round-trip or
production refresh transaction has been exercised.
