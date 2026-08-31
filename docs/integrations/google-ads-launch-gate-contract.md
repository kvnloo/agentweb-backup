# Google Ads Pre-Launch Gate & Conversion Tag Contract

Last derived from code: 2026-08-31

Owner area: `Anurag Seth`

Primary risk: Every failure in this area is silent. A launch that cannot measure
anything, a tag that reports to the wrong action, a parameter dropped on the way
to Google — none of them error. They return `success: true` and spend money.

## Agent Summary

This contract covers the write surface of Google Ads plus the tracking that
makes a launch measurable. It is a companion to
[meta-ads-contract.md](./meta-ads-contract.md); read that one for the Meta
equivalents, because several controls here deliberately reuse its primitives.

Three things a future agent must internalise:

1. **RULE 7.5** is a deterministic pre-flight gate. `ENABLE` / `RESUME`, and
   adding a creative to an already-ENABLED campaign, all fetch the served HTML of
   every final URL and refuse the launch if no `G-` / `GTM-` / `AW-` id is
   present. It fails toward BLOCK.
2. **Two detectors look for the same ids and must NOT be symmetric.** One reads
   served HTML, the other reads layout source. Making them agree breaks one of
   them. See [Two Detectors, Opposite Scopes](#two-detectors-opposite-scopes).
3. **A boolean the model sets is not an approval.** Both the tracking waiver and
   conversion-action removal are bound to an HMAC issued alongside a disclosure.
   A flag on its own does nothing.

The most expensive class of bug here is a value that is accepted, never sent, and
reported as success. Several sections below exist only because that happened.

## What AgentWeb Uses This For

| Capability | Supported? | Entry point | Notes |
| --- | --- | --- | --- |
| OAuth / account connect | Yes | `backend/src/routes/googleAdsAuth.ts` | Discovery captures `test_account` per leaf (ENG-1362). |
| Pre-flight tracking gate | Yes | `backend/src/services/googleAdsTrackingPreflight.ts` | Fetches served HTML; detection is case-SENSITIVE. |
| Launch gate on ENABLE/RESUME | Yes | `AgentModeService.runGoogleAdsTrackingGate` | Records `passed` / `passed_with_warning` / `blocked` / `overridden` on the run record. |
| Creative-addition gate | Yes | `AgentModeService.guardCreativeAddition` | AD CREATE and ASSET_GROUP CREATE. Fails CLOSED on unresolved parent status. |
| Campaign / budget / ad group / keyword / ad CRUD | Yes | `AgentModeService.handleCallGoogleAdsApi` | Bid targets validated against the strategy that must store them. |
| Conversion action CRUD | Yes | same | CREATE returns the `AW-<id>/<label>` tag. REMOVE is approval-bound. |
| Base tag injection into landers | Yes | `backend/src/utils/googleAdsInjection.ts` | Refuses to write when a foreign `AW-` id is present. |
| Conversion event on lead capture | Yes | `v0Service.fireLeadTracking` | Sends `transaction_id: eventId` for offline dedup. |
| Offline conversion import | **Code yes, blocked by Google** | `backend/src/utils/googleAdsOfflineConversions.ts` | See [Offline Import Is Closed](#offline-import-is-closed-by-google). |
| Reporting / GAQL | Yes | `AgentModeService.handleCallGoogleAdsReportingApi` | `mode="raw"` accepts arbitrary GAQL. |
| Spend-risk visibility | Yes | `backend/src/utils/googleAdsSpendRisk.ts` | Surfaced on the agent tool and the settings route. |

## Code Pointers

| Area | Path | Purpose |
| --- | --- | --- |
| API base / service | `backend/src/services/googleAdsService.ts` | `GOOGLE_ADS_API_BASE = .../v24`. Discovery, CRUD, `BID_TARGET_SUPPORT`, `isTestAccount`. |
| OAuth route | `backend/src/routes/googleAdsAuth.ts` | Account discovery; persists `test_account` at connect time. |
| Pre-flight detector | `backend/src/services/googleAdsTrackingPreflight.ts` | `detectTrackingSnippets`, `markupOnly`, `preflightTrackingGate`. |
| Tag injection | `backend/src/utils/googleAdsInjection.ts` | `injectGoogleAdsIntoLayout`, `verifyGoogleAdsInjection`, both foreign-id detectors, `handWrittenTagFires`. |
| Spend risk | `backend/src/utils/googleAdsSpendRisk.ts` | `describeGoogleAdsSpendRisk` — the single rule for `can_spend`. |
| Offline import | `backend/src/utils/googleAdsOfflineConversions.ts` | Click-conversion builder and dedup key. |
| Approval HMAC | `backend/src/services/metaLaunchGate.ts` | `computeTrackingOverrideDigest`, `trackingOverrideTokenMatches`. Shared with Meta by design. |
| Agent dispatcher | `backend/src/services/agentModeService.ts` | `handleCallGoogleAdsApi`, `guardCreativeAddition`, `runGoogleAdsTrackingGate`, `describeGoogleAdsAccount`, `extractMinimalToolResult`. |
| Agent tool schema | `backend/src/emma/tools.ts` | ACTION MATRIX and every parameter description. |
| Lander generation | `backend/src/services/v0Service.ts` | `fireLeadTracking`, sub-page tag inheritance, `googleAdsTrackingInstalled`. |
| Site endpoint | `backend/src/routes/landingPageGeneration.ts` | `GET /v0/site` returns the conversion tag fields. |
| Connected accounts route | `backend/src/routes/connectedAccounts.ts` | Emits `test_account` / `can_spend` for the settings UI. |
| Portal — tag status | `agentweb-customer-portal/src/components/landing-pages/SiteGoogleAdsSection.tsx` | Conversion-tag section and its two states. |
| Portal — spend risk | `agentweb-customer-portal/src/components/settings/ConnectedAccountsList.tsx` | The two Google Ads badges. |
| Portal — blocked tool calls | `agentweb-customer-portal/src/utils/resolveToolCallStatus.ts` | A blocked launch must not render as success. |

## Stored Internal Shape

Google Ads accounts are connected-account records:

```ts
{
  platform: "google_ads",
  account_id: "2883029950",      // customer id, digits only, no dashes
  account_name: "AgentWeb",
  config: {
    account_type: "google_ads",
    customer_id: "2883029950",
    currency: "INR",
    login_customer_id: "...",     // manager id when reached through an MCC
    test_account: false,          // ENG-1362 — see Spend Risk below
    access_token: "...",
    refresh_token: "...",
    token_expires_at: 1780000000000
  }
}
```

The lander's tag lives on the generated landing-page record:

```ts
{
  googleAdsConversionId: "AW-18192751758",
  googleAdsConversionLabel: "qAnwCOLmx-McEI65_eJD",
  googleAdsCustomerId: "2883029950",
  googleAdsTrackingInstalled: true   // false = no Ads conversion can be recorded
}
```

`googleAdsTrackingInstalled` carries more weight than its Meta sibling. A failed
Meta injection still degrades to server-side capture via CAPI. Google has no
server-side leg (see [Offline Import Is Closed](#offline-import-is-closed-by-google)),
so `false` means **no Google Ads conversion can be recorded from this lander**,
with no second path that picks it up.

It does not mean the page carries no Google tag at all. GA4 or a GTM container
can still be present, which is exactly why RULE 7.5 can pass a page whose Ads
conversion tag is missing. Read this field for the Ads conversion question only,
and the gate's own result for whether any Google tag was found.

## Two Detectors, Opposite Scopes

This is the single most counter-intuitive rule in the module, and the one an
agent is most likely to "fix" into a bug.

Two functions look for the same `AW-` ids. They read **different inputs**, so
their correct scopes run in **opposite directions**.

| | Reads | Correct scope | A false positive costs | A miss costs |
| --- | --- | --- | --- | --- |
| `detectTrackingSnippets` (RULE 7.5) | **served HTML** | **narrow** — markup only | a launch passes on a page that fires nothing | a blocked launch, recoverable |
| `foreignGoogleAdsIdsAnywhere` (injector guard) | **layout source** | **wide** — whole file | a visible 422 telling a human to clean the layout | two AW ids on one page (ENG-910) |

Concrete consequences, both real:

- An id in rendered body copy — *"ask your rep for conversion id AW-11112222333"* —
  is prose, not a tag. Scanning the whole document made that page read as tracked.
- An id in a module const, `const GA_ADS_ID = "AW-…"` interpolated into
  `<Script src={...}>`, is live code. Scanning only `<script>` elements made that
  tag invisible, so we injected ours on top of it.

Narrowing the **gate** to `<script>` elements is the obvious fix and is **wrong**.
Verified against live `www.agentweb.pro`: its GA4 id appears in
`<link rel="preload" href="…gtag/js?id=G-…">` and in the Next.js hydration
payload, never in a `<script src>`. That narrowing would have false-blocked our
own correctly tagged site.

A third function, `foreignGoogleAdsIdsInCode`, answers "does a conversion fire
here" for `verifyGoogleAdsInjection` and stays narrow. Widening it to match the
guard regressed the marketing-copy test: an `AW-` id inside a `<title>` read as
installed.

### Element detection is a JSX parse, not a regex

`scriptElements` parses the layout as TSX. Regex over the characters cannot tell
an element from a description of one, and all of these read as a working tag:

```jsx
{/* old approach, removed:
    <script src="…/gtag/js?id=AW-…"></script>
    <script>gtag('config', 'AW-…');</script>
*/}

// <script src="…/gtag/js?id=AW-…"></script>

<script type="application/json">{"eg":"gtag('config','AW-…')"}</script>
```

Comments cannot be stripped by regex here: the loader URL contains `//`, so the
obvious line-comment pattern eats the thing being matched. Parsing also picked up
Next's `<Script>` element, which no regex version ever matched.

`handWrittenTagFires` requires **both** a gtag.js loader (from a real `src`
attribute) and a parsed `gtag('config', '<id>')` **call**. The loader's id is
deliberately **not** required to be the Ads id — loading gtag.js once for GA4 and
then adding `gtag('config','AW-…')` is a normal working setup.

## Case Sensitivity Is Load-Bearing

`detectTrackingSnippets` matches **upper case only**. This is not tidiness.

Found live on our own marketing site: a nav link to `/ai-gtm-agent`. Matched
case-insensitively, the slug `gtm-agent` reads as container `GTM-AGENT`, and the
page was reported as carrying a GTM container it does not have. The same hole
swallows GA4: a hashed build class like `g-a1b2c3` scores as `G-A1B2C3`.

The consequence is the ENG-334 incident verbatim — a page with no tracking is
classified `measured`, skips the BLOCK, and spends on a funnel that cannot report
a conversion. **A word in a URL slug must never be able to authorise ad spend.**

The injector's detectors match case-sensitively for the same reason: so the two
cannot disagree about whether one page carries a tag.

## Approval Binding Contract

Two destructive capabilities are bound to a disclosed human approval. Both reuse
`computeTrackingOverrideDigest` / `trackingOverrideTokenMatches` from
`metaLaunchGate.ts` rather than inventing a second mechanism.

| Capability | Flag | Token | Digest covers |
| --- | --- | --- | --- |
| Waive RULE 7.5 | `override_tracking_check` | `tracking_override_token` | customer, entity, action, full args |
| Remove a conversion action | `confirm_conversion_action_removal` | `conversion_action_removal_token` | customer, entity, action, **conversion action resource name** |

The rule, from ENG-941 and applied to both:

> An override the model can introduce after approval is not user-granted,
> whatever the tool description says.

The loop: a claimed waiver with no valid token **halts**, discloses the
consequence, and issues an HMAC over that exact call. Only a replay presenting
that token applies it. A forged token, or a token minted for **different
arguments**, falls back into a fresh disclosure rather than proceeding.

For removal the digest deliberately covers the **resource name**, because that is
the destructive argument. A token for `conversionActions/222` is refused against
`conversionActions/111` — verified on production.

### The token must survive `extractMinimalToolResult`

`extractMinimalToolResult` discards every field it does not explicitly name. Its
confirmation branch named neither token, so both loops were **dead ends in
production**: the model was told to replay a token it never received.

It failed CLOSED — the gate simply kept blocking — which is exactly why it went
unnoticed for so long. Handler-level tests passed because they call the
dispatcher directly and never reach the minimizer: they proved the tokens were
*issued*, never *delivered*.

**If you add a third approval token, add it to that branch and test the
minimizer, not just the handler.**

## Bid Target Contract

Google stores a bid target as a **leaf of the bidding strategy**
(`target_cpa.target_cpa_micros` and friends). There is no strategy-agnostic
field, so a target supplied without a strategy that can hold it has nowhere to go
— and was silently dropped on a `success: true`.

`BID_TARGET_SUPPORT` in `googleAdsService.ts` is the authority:

| Strategy | `bidding_strategy_target` means | Accepts ceiling? |
| --- | --- | --- |
| `MAXIMIZE_CONVERSIONS` | target CPA, currency units | No |
| `MAXIMIZE_CONVERSION_VALUE` | target ROAS ratio | No |
| `TARGET_CPA` | target CPA, currency units | No |
| `TARGET_ROAS` | target ROAS ratio | No |
| `TARGET_IMPRESSION_SHARE` | impression-share fraction | **Yes** (required) |
| `TARGET_SPEND` | *no target* | **Yes** |
| `MANUAL_CPC` | *no target* | No |
| portfolio (`bidding_strategy_resource_name`) | *lives on the shared strategy* | No |

`cpc_bid_ceiling_micros` is documented by Google as *"mutable for portfolio
bidding strategies only"*, which is why it is rejected on standard strategies
rather than written. Rejecting loudly beats writing a cap that may be ignored.

**`createCampaign` and `updateCampaign` duplicate these branches.** A fix applied
to one and not the other is the exact defect that shipped: the maximize-target
fix landed in `updateCampaign` only, so identical arguments produced a real target
on update and an empty `{}` on create. A parity test now compares the two
directly — it is the only thing that catches that class.

## Fail-Closed Contract for Creative Addition

`guardCreativeAddition` covers AD CREATE and ASSET_GROUP CREATE. It previously
swallowed every failure and created the creative anyway, on this reasoning:

> defence-in-depth (the RESUME / UPDATE→ENABLED gate is the hard guarantee)

That is **inverted** for the only case this gate covers. It matters exclusively
when the parent is already `ENABLED` — and an already-enabled campaign has no
future RESUME for the "hard guarantee" to fire on. The creative *is* the launch.

Three ways it proceeded without checking anything, all silent:

- the parent lookup threw;
- the parent lookup returned nothing, so `if (parent)` skipped the gate entirely
  — no check ran and nothing was logged;
- the gate itself threw while fetching the landing page.

Now a status that cannot be determined is treated as possibly-ENABLED and
refused. Fail-closed deliberately does **not** become fail-always: a status
confirmed to be anything other than `ENABLED` still proceeds, because there is no
launch to guard and ordinary staging must not break on a flaky lookup.

The override is scoped to the risk it discloses. Its confirmation text names an
unverified *destination*; it says nothing about "we could not establish whether
this campaign is live", so it does not waive the parent-status failures.

## Spend Risk: `test_account` and `can_spend`

A connected Google Ads account named **"Test"** has `customer.test_account =
false`. It is real, billable and ENABLED. The name is the only thing suggesting
otherwise, and a name carries no authority.

`describeGoogleAdsSpendRisk` is the single rule, and it is deliberately
asymmetric:

```
test_account true      -> Google guarantees the account cannot serve ads or spend
test_account false     -> real money
null / never recorded  -> real money
```

`can_spend` clears **only** on an affirmative `true`. A fallback letting "we never
checked" read as "cannot spend" would rebuild the original bug somewhere new —
and with accounts predating the field, that path is live, not hypothetical.

Captured at discovery (`customer_client.test_account`, one extra field on a query
the connect flow already runs) and resolved lazily via
`googleAdsService.isTestAccount` for older records, process-cached because the
flag is immutable and never cached on failure.

**This is not a gate.** Every real customer account is `test_account: false`;
refusing writes on it would block all legitimate work. The fix is visibility.

## Conversion Tag On Generated Landers

- The base gtag ships in `app/layout.tsx` on the **first commit**, and a sub-page
  added later inherits it on the same commit.
- Injection is idempotent: running twice never yields two `AW-` blocks; an empty
  id removes the block cleanly.
- A layout already carrying a **different** `AW-` id causes the install to be
  abandoned and reported, never half-applied.
- `fireLeadTracking` fires exactly one conversion per successful submit, zero on
  validation failure, zero on a failed request, and carries
  `transaction_id: eventId`. It waits on Google's `event_callback` rather than a
  blind sleep, because a bridge-out redirect tears the page down.
- It **skips** the conversion when `eventId` is absent rather than firing one that
  cannot be deduplicated. One missing conversion is visible in reporting; a
  double-counted one silently inflates it.

### Reading a live lander correctly

A raw string count over a deployed Next.js lander reports **two loaders and two
config calls** and looks exactly like an ENG-910 double-install. Parsing shows
three gtag-related `<script>` elements: the real loader, the real inline config,
and the RSC hydration payload (`self.__next_f.push`) *describing* the other two as
serialized data. **One real install.** Do not "fix" this.

## Offline Import Is Closed By Google

`OFFLINE_CONVERSION UPLOAD` is implemented and correct, and **cannot run**.

Verified live 2026-08-31 with `validate_only: true`:

```
row 0: CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE
New integrations for uploading click conversions should use the Data Manager API.
Usage of ConversionUploadService.UploadClickConversions is limited to existing users.
```

Per Google's
[upload-clicks docs](https://developers.google.com/google-ads/api/docs/conversions/upload-clicks)
and the
[developer blog](https://ads-developers.googleblog.com/2026/05/changes-to-offline-click-conversion.html):

> Starting **June 15, 2026**, UploadClickConversion requests will fail if the
> **developer token** hasn't previously sent requests to upload offline
> conversions or enhanced conversions for leads.

The gate is on the **developer token**, not the customer account. Tokens that
sent no such request between January and June 2026 get no legacy access. Our
upload path shipped 2026-08-20, two months after that window closed.

What was actually verified: **one** account (`validate_only`, 2026-08-31)
returned the error above. The developer-token wording in Google's docs implies
the lockout applies to every account reached through our token, and no request
we know of was sent during the eligibility window, but neither the token's
request history nor a second account was checked. Treat the account-wide
conclusion as strongly indicated and not proven. See [Open Gaps](#open-gaps).

Consequences to hold in mind:

- Anything converting **off the website** (phone sale, later booking, CRM
  qualification) has no route back to Google today.
- `fireLeadTracking`'s `transaction_id` exists so a later upload carrying the same
  value as `order_id` cannot double-count. That second leg cannot run.
- The Launch Gate skill's T13 asks whether an offline import path exists; "the
  tool exists, Google will not accept it" is indistinguishable from "not
  configured".

Migration target is the
[Data Manager API](https://developers.google.com/data-manager/api/devguides/events/google-ads/offline)
(`IngestEvents`). Field mapping is close to one-to-one — `operatingAccount`,
`loginAccount`, `productDestinationId`, `adIdentifiers.gclid`, `eventTimestamp`,
**`transactionId`** — so the dedup design survives. It needs no developer token,
uses scope `https://www.googleapis.com/auth/datamanager`, requires SHA-256 hashing
of user identifiers, and its OAuth verification requirement differs between user
credentials and service accounts. See [Open Gaps](#open-gaps).

## Agent Tool Contract

`call_google_ads_api` — one tool, `entity_type` + `action`. The ACTION MATRIX in
`backend/src/emma/tools.ts` is the source of truth; a few rules that are easy to
get wrong:

- **`counting_type` is never inferred.** An absent value is refused with the
  choice and its consequence named. `ONE_PER_CLICK` for lead forms,
  `MANY_PER_CLICK` for purchases. Choosing wrong silently misdirects smart
  bidding and nothing errors.
- **A conversion action has no `PAUSED` status**, and `HIDDEN` cannot be set
  through the API at all. `UPDATE status=REMOVED` is rejected and redirected to
  the confirmed REMOVE path.
- **CREATE returns the tag**, `{conversionId, conversionLabel, sendTo}`, read back
  from `tagSnippets`. A resource name cannot be installed on a page.
- **CREATE and UPDATE both read back and return `drift`.** Relay it; do not assume
  the write took.
- **Keywords and ads default to `PAUSED`.** `addKeywords` previously hardcoded
  `ENABLED`, so a keyword added to a live ad group served immediately.
- **`RETAG_UTM` writes to the CAMPAIGN, not the ad**, so it affects every ad in
  that campaign. Say so before calling.

`call_google_ads_reporting_api` — `mode="dashboard"` or `mode="raw"` with
arbitrary GAQL. Never fabricate metrics.

## Known Failure Modes

| Failure | Evidence | Current guard | Do not do this |
| --- | --- | --- | --- |
| Slug `ai-gtm-agent` read as a GTM container | ENG-1358 | Case-sensitive detection | Do not add the `i` flag back. |
| Conversion id in body copy read as a tag | ENG-1527 | `markupOnly` on served HTML | Do not scan the whole document. |
| Narrowing the gate to `<script>` false-blocks tagged pages | ENG-1527 | Markup-only keeps `<link rel=preload>` and hydration payload | Do not "simplify" to script tags. |
| `AW-` id in a module const invisible to the guard | ENG-1527 | `foreignGoogleAdsIdsAnywhere` scans whole source | Do not re-scope to `<script>`. |
| Commented-out tag read as installed | ENG-1527 | TSX parse of script elements | Do not strip comments with regex; the URL contains `//`. |
| Loader-only tag read as installed | ENG-1527 | `handWrittenTagFires` needs loader **and** parsed config call | Do not accept the id's mere presence. |
| Bid target accepted and never sent | ENG-1527 | `BID_TARGET_SUPPORT` + `assertBidTargetIsAddressable` | Do not accept a target the strategy cannot store. |
| Maximize-target fix applied to update only | ENG-1527 | create/update parity test | Do not edit one branch of a duplicated pair. |
| Creative added to a live campaign unchecked | ENG-1527 | `guardCreativeAddition` fails closed | Do not treat RESUME as a backstop for an already-ENABLED parent. |
| Blocked launch rendered as a green tick | ENG-1523 | `resolveToolCallStatus` checks `blocked` before `error` | Do not order the ternary on `error` first. |
| Warning computed then discarded by the minimizer | ENG-1523 / ENG-1358 | Explicit branches in `extractMinimalToolResult` | Do not assume a returned field reaches the model. |
| Approval token stripped by the minimizer | ENG-1526 / ENG-1322 | Tokens relayed in the confirmation branch | Do not test the handler and call the loop verified. |
| Override applied to an undisclosed risk | ENG-1322 | Override scoped to the tracking check only | Do not reuse one approval for a different risk. |
| Removal token reusable across actions | ENG-1322 | Digest covers the resource name | Do not digest only customer + action. |
| Re-applying a tag deleted the conversion label | ENG-1525 | Label preserved on re-injection | Do not treat the id as the whole tag. |
| Billable account named "Test" | ENG-1362 | `test_account` / `can_spend` surfaced | Do not infer safety from `account_name`. |
| `AD_GROUP` / `AD` CREATE dropped `status` | ENG-1514 | Status forwarded to the service | Do not let a staged object default live. |

## Tests To Check

Focused:

- `backend/src/__tests__/eng1527.detectorScopes.test.ts` — the two scopes, both directions
- `backend/src/__tests__/eng1527.bidTarget.test.ts` — strategy/target matrix + create/update parity
- `backend/src/__tests__/eng1527.droppedParams.test.ts` — keyword status propagation
- `backend/src/__tests__/googleAdsLaunchGate.test.ts` — RULE 7.5 and the creative gate
- `backend/src/__tests__/googleAdsInjection.test.ts` — injection, idempotence, foreign ids
- `backend/src/__tests__/googleAdsTrackingPreflight.test.ts` — detection and case sensitivity
- `backend/src/__tests__/eng1322.removalBinding.test.ts` — HMAC binding
- `backend/src/__tests__/eng1322.removalLoop.test.ts` — the loop through the real dispatcher
- `backend/src/__tests__/eng1526.tokenRelay.test.ts` — tokens survive the minimizer
- `backend/src/__tests__/eng1526.googleOverrideBinding.test.ts` — waiver binding
- `backend/src/__tests__/eng1362.testAccountVisibility.test.ts` — spend-risk rule
- `backend/src/__tests__/eng1525.googleAdsLabelPreservation.test.ts` — label preserved
- `backend/src/__tests__/eng1523.blockReasonPreserved.test.ts` — block survives minimization
- `backend/src/__tests__/googleAdsConversionIntegrity.test.ts` — a conversion call must exist
- `backend/src/__tests__/googleAdsTrackingHelper.test.ts` — `fireLeadTracking` semantics
- `backend/src/__tests__/emmaTools.conversionActionSchema.test.ts` — tool schema rules
- `backend/src/__tests__/routes.landingPages.site.test.ts` — `/v0/site` tag fields

Live contract (skipped unless env vars set, and it makes **no successful
writes** — the rejections are the assertions):

- `backend/src/__tests__/googleAdsContract.live.test.ts`

Portal:

- `src/components/settings/__tests__/ConnectedAccountsList.testAccount.test.tsx`
- `src/components/landing-pages/__tests__/SiteGoogleAdsSection.test.tsx`
- `src/utils/__tests__/resolveToolCallStatus.test.ts`

## Recent PR/Commit Evidence

| PR | What it encodes |
| --- | --- |
| agentweb#2604 | Bid targets rejected when the strategy cannot store them; keyword status forwarded |
| agentweb#2606 | Detector scopes split; element detection moved to a TSX parse |
| agentweb#2608 | Creative-addition gate fails closed; override scoped to its disclosed risk |
| agentweb#2610 | `/v0/site` returns the conversion tag fields |
| agentweb#2617 | `test_account` captured at discovery and surfaced |
| agentweb#2628 | Settings route resolves the flag too, so both surfaces agree |
| agentweb#2675 | `CONVERSION_ACTION REMOVE` bound to a disclosed approval |
| agentweb#2678 | Approval tokens relayed through the minimizer |
| customer-portal#1101 / #1104 | A blocked launch no longer renders as success |
| customer-portal#1111 | Conversion-tag section; GTM badge stops implying verified tracking |
| customer-portal#1112 | Spend-risk badges |

## Production Verification Record

Verified against the live account `2883029950` on 2026-08-31, backend
`backend-20260831-pr2678`. **Zero spend throughout** — 14 campaigns, 0 ENABLED,
0 impressions, 0 clicks, 0.00.

| Check | Result |
| --- | --- |
| `MANUAL_CPC` + bid target | refused, *"Nothing was sent to Google Ads"* |
| `TARGET_CPA` + ceiling | refused, scoped to the strategy |
| `KEYWORD ADD` with no status | stored `PAUSED` |
| AD CREATE, unresolvable parent | blocked, *"Nothing was created"* |
| ASSET_GROUP CREATE, unresolvable parent | blocked, identical |
| AD CREATE on a confirmed-PAUSED parent | proceeds — fail-closed is not fail-always |
| RULE 7.5 on a mixed campaign | blocks `example.com`, does **not** flag `www.agentweb.pro` |
| Tracking override loop | halt → token → replay → resumed → paused |
| REMOVE loop | halt → token → replay → removed; wrong-action and forged tokens refused |
| Conversion action CREATE | returns `AW-…/…`, `drift: []` |
| Live lander HTML | one `AW-18192751758`, loader + config |
| `/v0/site` | returns id, label, customer id, `installed` |
| Settings UI | `Test` account shows **Billable despite the name** |

The gate's PASS path was proven from the **per-URL results of a blocked RESUME**
rather than by enabling anything — that pattern is worth reusing.

## Agent Anti-Hallucination Rules

- Do not make the two detectors symmetric. Their asymmetry is the design.
- Do not add the `i` flag to id detection. A slug must not authorise spend.
- Do not treat a boolean the model can set as an approval.
- Do not assume a field returned by a handler reaches the model —
  `extractMinimalToolResult` drops what it does not name.
- Do not edit one of `createCampaign` / `updateCampaign` without the other.
- Do not infer account safety from `account_name`.
- Do not guess `counting_type`, or any bid target's unit. Currency units, not
  micros, for `bidding_strategy_target`.
- Do not report a Next.js hydration payload as a duplicate tag install.
- Do not claim the offline import works. Verify against the account first.
- Do not verify an approval loop with handler tests alone. Drive the agent.

## Open Gaps

- **Data Manager API migration is unscoped.** The blocking unknown is how a
  service account gains access to a customer's Google Ads account. There is a
  `datamanager.partnerlink` scope suggesting a linking model, but it was not
  confirmed whether that replaces per-customer OAuth or sits alongside it. That
  single answer decides between "new client module" and "every customer
  reconnects".
- Whether the offline-import lockout is truly global for our developer token was
  inferred from Google's wording plus one account. A second account was not
  tested.
- Consent Mode v2 is asserted by the Launch Gate skill (T5b) but has no
  deterministic backend check.
- The live `googleAdsContract.live.test.ts` requires Secrets Manager read access
  and therefore does not run on a normal workstation. Its assertions are the only
  thing proving our beliefs about the real API still hold.
- `verifyGoogleAdsInjection` returning false for a const-held id is deliberate
  (it routes to the wide guard's 422), but it means a correctly tagged App Router
  page can require a human to resolve.

## Update Checklist

- [ ] Vendor docs checked if the external API shape changed. Google Ads API
      version lives in `GOOGLE_ADS_API_BASE`.
- [ ] Both detectors reviewed if either was touched — they are a pair.
- [ ] If an approval token was added, it is relayed in
      `extractMinimalToolResult` **and** covered by a minimizer test.
- [ ] `createCampaign` and `updateCampaign` changed together, with a parity test.
- [ ] Tool descriptions in `backend/src/emma/tools.ts` updated for any new
      parameter, enum, or refusal.
- [ ] New failure mode added to this contract with PR evidence.
- [ ] Verified against the live account, not only in tests — several defects here
      were invisible to green suites.
