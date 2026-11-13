# Product journey tracking (ENG-2906)

One shared AgentWeb account serves Zoma, Emma MCP and the Emma web app. Product is
**attribution metadata only** — it never restricts access, and `unknown` is always allowed.

## Products

`zoma` | `emma_mcp` | `emma_web` | `unknown`

| Signal | Product | Confidence |
|---|---|---|
| RFC 8707 `resource` = `<backend>/api/meta-toolkit/mcp` (authorize or token request) | zoma | explicit |
| RFC 8707 `resource` = `<backend>/mcp` | emma_mcp | explicit |
| OAuth client `zoma-device-setup` (Zoma device flow) with no resource | zoma | inferred |
| Meta Toolkit gateway (Meta, Google, `zoma_` tokens) | zoma | — |
| Emma `/mcp` server | emma_mcp | — |
| Portal password signup | emma_web | explicit |
| Portal Google signup | emma_web | inferred |
| anything else | unknown | unknown |

The confidence column is the internal derivation. On the AW-Users row and the PostHog person /
`signed_up` event, `attributionConfidence` uses the contract enum `tracked | inferred | verified`:
`explicit` is written as `tracked`, `inferred` as `inferred`, and `unknown` is omitted. Nothing
emits `verified` yet.

Every MCP usage event (`Dev-AW-LoopEvents` / prod `AW-LoopEvents`, loop `emma-mcp`) now carries
`dimensions.product`. Events written before ENG-2906 have no `product`; read a missing value as
"not tracked", not as `unknown`.

## OAuth propagation

`/oauth/authorize` reads `resource` and `ref`, and — because the portal consent page posts back
only the standard fields — stores them in `AW-MCPOAuthCodes` under `pending#<sha256(client_id,
code_challenge)>` (1 h TTL, no `used` attribute, so it can never be redeemed as a code). The
consent decision moves them onto the auth code (`product`, `attributionConfidence`, `ref`), the
token exchange copies `product` onto the `AW-MCPOAuthTokens` record, and refresh rotation copies
it onto every successor. A legacy code/token simply has no `product`.

## `ref`

`/^[a-z0-9_-]{1,64}$/`; anything else is silently dropped (never a 400). Accepted on:
`/mcp?ref=` and `/api/meta-toolkit/mcp?ref=` (recorded on usage events), `/oauth/authorize?ref=`
(or inside the `resource` URL's query), and `POST /api/zoma/setup` (`ref` in body or query —
stored on the device record and forwarded to the authorize URL). It becomes `signupRef` at signup.

MCP clients send the protected-resource metadata's `resource` (not their own server URL) to
`/oauth/authorize`, so the ref is carried there by the server: an unauthenticated `/mcp?ref=x`
(or `/api/meta-toolkit/mcp?ref=x`) gets a 401 whose `resource_metadata` is
`/.well-known/oauth-protected-resource/<path>?ref=x`, and that document answers
`resource: <backend>/<path>?ref=x`. The MCP SDK also keeps the server URL's query on path-aware
metadata discovery, so the ref arrives even without the challenge. `/oauth/authorize` then reads
it from `resource`. Product derivation ignores the query.

## AW-Users fields (key: email)

All writes are single conditional `UpdateItem`s guarded by `attribute_exists(email)` (never
upsert a ghost row, never read-modify-write).

- `signupProduct`, `signupPath` (`oauth_direct` | `zoma_device` | `api_key` | `webapp`),
  `signupClient`, `signupRef`, `attributionConfidence` — write-once as a set
  (`if_not_exists` under `attribute_not_exists(signupPath)`). OAuth/device signups are only
  attributed for an account created on the MCP consent page: register stamps such rows
  `signupSource = "mcp"` and the consent decision (or the `MCP_OAUTH_SKIP_CONSENT` fast path, or
  the Zoma device approval) requires that marker. Account age is never used, so an existing
  user approving a new client is never counted as a signup. A `zoma` signup also moves
  `zomaStage` to `signed_up`.
  `api_key` is reserved: no current surface creates accounts via an API key.
- `products.<product> = { firstAt, lastAt }` — `firstAt` write-once; `lastAt` bumped at most
  hourly per user/product.
- `zomaStage`, `zomaStageAt` — forward-only (`zomaStage IN (<strictly earlier stages>)`):
  `setup_started < signed_up < connected < platform_connected < card_saved < first_read <
  first_write < ad_live`. Meta and Google connections are the same stage
  (`platform_connected`). The stage is the furthest milestone reached; in the device flow the
  `zoma_` token (`connected`) is issued after Meta and payment, so the stage is already past it.
  Shared surfaces (Meta/Google connect, Stripe) only move the stage for users that already have
  `products.zoma`.
- `zomaFirstReadAt`, `zomaFirstWriteAt` — write-once milestone timestamps
  (`attribute_not_exists`), independent of the stage, so a first write before the first read
  still records (and emits) `first_read` once.

**Backfill (PR2, not yet applied).** `scripts/eng2906-backfill-products.ts` infers the fields
for users that predate tracking, from `Dev-AW-LoopEvents` `mcp_*` rows and `AW-ZomaDeviceAuth`
(planning + write safety in `services/journeyProductBackfill.ts`). It is a dry run by default
(CSV); `--apply` is a data-plane action that needs Harsha's approval. Everything it writes is
`attributionConfidence: inferred`, every write is conditional, and it never overwrites an
existing value (so a tracked/verified attribution is never touched). `signupPath` is not
guessed. Pre-ENG-2906 OAuth authorize/token rows carry no resource (the OAuth server is shared
by `/mcp` and the Meta Toolkit), so they take the product of the same client's tool use and
are otherwise ignored. Tool names Emma `/mcp` also registers (`call_meta_marketing_api`,
`call_google_ads_api`, …) are not Zoma evidence; toolkit-only names, `zoma_` tools, the
`zoma_token` auth method, Zoma clients and the gateway-only `platform` dimension are.

## Admin roster

`GET /api/admin/users` returns `signupProduct`, `products`, `zomaStage`, `zomaStageAt`,
`signupClient`, `signupRef`, `attributionConfidence`, and accepts `?product=zoma|emma_mcp|emma_web`
(400 otherwise): a user matches when it is the signup product or a key of `products`. Users with
no attribution match no product. The partner-portal Users page shows a purple Zoma pill and a
subtle Emma MCP pill beside the email (tooltip `Signed up via <product> · <client> · ref <ref>`,
`(inferred)` when inferred) and a Product filter (All / Zoma / Emma MCP / Web).

## Journey events (PostHog)

`setup_started` (anonymous, Zoma device start) · `signed_up` · `connected` (OAuth token or
`zoma_` token issued) · `meta_connected` / `google_connected` · `card_saved` (Stripe-verified
setup Checkout, or payment readiness at token issue) · `first_read` (first successful toolkit
read) · `first_write` (first executed toolkit write, `recordMcpWriteExecuted`). `first_*` are
each emitted once, when their milestone field is first set.

- `ad_live` — first provider-verified delivering Zoma ad (ENG-2902). Emitted once, only by
  `verifyZomaFirstAds` (`services/zomaScoreboard.ts`, admin `POST
  /api/admin/zoma/scoreboard/verify-first-ads`): a Zoma-created campaign (CONFIRMED CAMPAIGN CREATE)
  whose go-live was approved through Zoma (CONFIRMED UPDATE status=ACTIVE, `writeKind: approve`)
  reads back `effective_status=ACTIVE` with lifetime impressions >= 1. It writes the write-once
  `zomaFirstAdLive` map on AW-Users and moves `zomaStage` to `ad_live`.
- `abandoned` — not emitted.

Distinct id = AgentWeb `userId`; before signup, `zoma_setup_<hash>` (a hash of the device id),
aliased onto the user at device approval. Person properties: `signupProduct`, `signupPath`,
`signupClient`, `signupRef` (set-once), `products`, `zomaStage` (set).

### Privacy

Only allowlisted keys with short scalar values are sent (`services/journeyTracking.ts`). Never
email, tokens/credentials, ad-account ids, or ad data (names, budgets, spend, creatives); values
that look like an email or a token are dropped even under an allowlisted key.

### Env

- `POSTHOG_PROJECT_TOKEN` — defaults to the public project token `phc_miHN…sHwL`.
- `POSTHOG_HOST` — default `https://us.i.posthog.com`.
- `JOURNEY_TRACKING_DISABLED=true` — kill switch for PostHog (DynamoDB attribution still runs).
- Disabled automatically under `NODE_ENV=test`.

Capture is fail-open: every call resolves, errors are logged as `[journey] … failed (ignored)`.
The shutdown drain flushes queued events.

## Rollback

Revert the PR. Added attributes (`product`/`ref` on codes and tokens, `pending#` rows, AW-Users
signup*/products/zomaStage, the device `ref`) are inert to the previous code: nothing reads them
for authorization, and `pending#` rows expire by TTL. For PostHog only, set
`JOURNEY_TRACKING_DISABLED=true`.
