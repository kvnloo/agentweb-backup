## ENG-2818: Zoma LinkedIn Ads toolkit lands dark behind ZOMA_LINKEDIN_ADS_ENABLED (2026-11-24)

LinkedIn Ads is built as the fourth Zoma ad platform (Meta, Google and X exist), reads and guarded writes. It is **off in production**: nothing is listed, routed or offered until the flag is set. No table, index, key or migration changes: tokens go through the same `connectedAccountsDb` helpers (`createAccount`, `updateAccountTokens`) and the same `linkedin_ads` row Emma already writes.

### The flag

`ZOMA_LINKEDIN_ADS_ENABLED` is strict and case-sensitive.

- unset or any other value: off. `zoma_status` has no `linkedin_ads` block, the tools are not listed, and the Zoma connect routes fall through. The served agent guide and the flag-off routes are byte-identical to main (tested).
- `read`: `linkedin_ads_read`, the Zoma connect pages, the `zoma_status` block and reporting. `linkedin_ads_write` is not listed and is refused before the scope check and the paywall. Consent asks only for read scopes (plus scopes the user already granted, on a reconnect).
- `true`: adds `linkedin_ads_write`.

One variable on purpose: the production environment has about 18 characters of room left under the 4,096-character Elastic Beanstalk cap, and `read` needs about 31. Turning it on therefore needs the `.ebextensions/99-enigma-eng2070.config` cleanup first.

### How writes are kept safe

- Same guard as the other toolkits: a preview token (15 minutes, single use), then confirm, applied once, then an independent read-back reported as CONFIRMED, MISMATCH or UNCONFIRMED.
- Every create is DRAFT with explicit values; a request carrying a `status` is refused. Zoma never relies on Emma's service defaults (ACTIVE groups and creatives, a 2.00 USD unit cost).
- ACTIVATE is the publish write (`isZomaPublishWrite`, so the billing paywall applies), checked against the budget it unlocks, in the account's own currency.
- Spend ceiling `LINKEDIN_ADS_TOOLKIT_SPEND_CEILING` (JSON by currency, micros). **Unset means a built-in default, unlike Google and X where unset means no limit:** USD only, 50.00 a day, 2x change ratio, total budget at most 30x the daily limit (1,500). Other currencies are refused. These numbers still need Harsha's confirmation.
- Previews echo every value that will be sent; the whole creative content is bound into the preview token.

### Connect flow

Zoma pages with no new redirect URI. The portal callback forwards a signed state carrying a `zoma` claim; the Zoma routes verify signature and expiry again and bind the user. The page shows the full email of the Zoma account and an explicit Connect button. A reconnect never replaces a stored row with a narrower grant, unless the stored token is dead.

### Changes to code Emma uses

`routes/linkedInAdsAuth.ts` finalize and connect moved into `services/linkedInAdsOAuthFinalize.ts`. Same behaviour for the portal. Two intended differences: the error handlers log only a message (the raw AxiosError carried `client_secret` and `code`), and the cleanup timer is unref'd. Token refresh for Zoma calls is single-flight (`services/linkedInAdsCredentials.ts`).

### What was not verified

Everything is mocked. There is no LinkedIn test ad account, so nothing here has run against a real LinkedIn ad account: read-back shapes, DRAFT acceptance for groups and creatives, `x-restli-id` shapes, default analytics fields. LinkedIn read-back in Emma (ENG-3064) was merged on mocked evidence as well. Only adAnalytics reads are confirmed by LinkedIn to work for ad accounts not listed in the app (Development tier: 5 listed accounts; writes need Standard).

Before the flag is set to `read` in production: file the Standard-tier case, update the Databricks marketplace docs (`linkedin_ads_read` joins the read-only view), then run a paused create, read-back and archive on a test ad account before `true`.

### Rollback

Unset the flag (an env change, no deploy of code needed to hide it), or revert the merge commit.
