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

## Server hardening and verification

The investigation reproduced gaps in the requested security invariants:
non-atomic code consumption, unvalidated denial redirects, missing PKCE on a
direct consent submission, optional client identity at token exchange, and malformed
parameter coercion. The patch closes these without changing successful Hermes
requests, token formats, scopes, persistence schema, or adding an auth path.

TDD on the two OAuth suites: **RED 15 failed / 54 passed**, then **GREEN 69 passed**.
Review caught one overrestriction in that first iteration: OAuth 2.1 token
requests need not repeat `redirect_uri`. Its mandatory-field assertion was
withdrawn; the replacement compatibility test captured **RED 1 failed / 72
passed**, then passed after preserving omission support. Supplied redirect
URIs still require exact matching; registered consent redirects and PKCE remain
mandatory. See [OAuth 2.1 §10.2](https://www.ietf.org/ietf-ftp/internet-drafts/draft-ietf-oauth-v2-1-16.html#section-10.2).
Four additional exact-binding regressions bring the final OAuth/MCP run to
**119 passed across 4 suites**. Native fixture: **1 passed**. Production build and
full typecheck passed on Atem. The native fixture also passes unchanged base
`745c4549b`: this is security hardening and a headless usage diagnosis, not evidence
of a newly repaired server interoperability failure. The existing neighboring
MCP suites emit a timer-teardown warning; the native fixture exits cleanly.
Run from repository root:

```sh
node backend/node_modules/jest/bin/jest.js --config backend/jest.config.js --runInBand --runTestsByPath backend/src/mcp/oauth/__tests__/oauthRoutes.test.ts backend/src/mcp/oauth/__tests__/oauthService.test.ts
HERMES_REPO=/path/to/hermes-agent node backend/node_modules/jest/bin/jest.js --config backend/jest.config.js --runInBand --testPathIgnorePatterns=/node_modules/ --runTestsByPath backend/src/__tests__/e2e/hermes-oauth.e2e.test.ts
```

The explicit native test requires Hermes's installed `venv/bin/python`; it fails
rather than silently skips when unavailable. It exercises real Emma routes,
OAuth service, MCP authentication/transport, Hermes provider and native callback
waiter/paste reader. DynamoDB, portal login/consent UI, telemetry, and business tool
inventory are fixtures. It verifies state rejection, incorrect PKCE rejection,
code replay rejection, token hashing, and an MCP tool seeing the authenticated
user as external. It does **not** prove a live Slack adapter or real portal login.

Rollback: revert this PR; no migration or backfill. Post-deploy smoke (not run;
this PR must not merge): complete the native flow above with an authorized test
account, verify tools connect, and verify a replay fails without exposing tokens.
