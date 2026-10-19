# Meta Toolkit — product boundary and tool inventory (ENG-2281)

Parent: ENG-2268, "Productize the Meta toolkit as standalone agent-callable tools".
The inventory originated as a docs-only slice (ENG-2281). Sections 4/5 now record
Harsha’s approved 2026-10-06 decisions, enforced by ENG-2268 at the external boundary.

Line numbers refer to `origin/main` at 720f74de9.

## 1. Inventory: every Meta tool Emma exposes today

Method: searched the `emmaToolRegistry.register` sites in `backend/src/emma/tools.ts`
for Meta-facing tools. The results were cross-checked against the agentModeService
handlers they call. Six tools exist. No other registry entry calls Meta's
Marketing/Graph API for ads. (Instagram organic publishing is outside this toolkit.)

| # | Tool | Definition | Handler | Read/Write |
|---|------|-----------|---------|------------|
| 1 | `list_meta_ads_campaigns` | `backend/src/emma/tools.ts:1250` | `agentModeService.listMetaAdsCampaignsNew` (`services/agentModeService.ts:19403`) | Read |
| 2 | `get_meta_ads_metrics` | `backend/src/emma/tools.ts:1863` | `agentModeService.getMetaAdsMetrics` (`services/agentModeService.ts:20986`) | Read |
| 3 | `call_meta_ads_insights_api` | `backend/src/emma/tools.ts:1744` | `agentModeService.callMetaAdsInsightsApiWrapper` (`services/agentModeService.ts:18479`) | Read |
| 4 | `call_meta_marketing_api` | `backend/src/emma/tools.ts:1283` | `agentModeService.callMetaMarketingApi` (`services/agentModeService.ts:22396`) | Mixed (per action, see 1.1) |
| 5 | `launch_targeted_audience_campaign` | `backend/src/emma/tools.ts:1690` | `agentModeService.launchTargetedAudienceCampaign` (`services/agentModeService.ts:24902`) | Write (spend-starting) |
| 6 | `launch_retargeting_campaign` | `backend/src/emma/tools.ts:1717` | `agentModeService.launchRetargetingCampaign` (`services/agentModeService.ts:24911`) | Write (spend-starting) |

Related tool that does not call Meta: `get_ads_thresholds` (`emma/tools.ts:1929`) reads
AgentWeb's own fatigue/health thresholds for a Meta account. It is a candidate
companion read.

### 1.1 `call_meta_marketing_api` action matrix

The action matrix is in the tool description (`emma/tools.ts:1349-1357`). The
entity/action enums are at `emma/tools.ts:1531-1537`. Write classification at runtime
comes from `AgentModeService.isMetaWriteAction` (call site `services/agentModeService.ts:22895`).

| Entity | Read actions | Write actions |
|--------|--------------|---------------|
| CAMPAIGN | LIST | CREATE, UPDATE, DELETE |
| AD_SET | LIST | CREATE, UPDATE, DELETE |
| AD_CREATIVE | LIST, GET, PREVIEW | CREATE, UPLOAD_IMAGE, UPLOAD_VIDEO (asset upload, not spend) |
| AD | LIST, PREVIEW | CREATE, UPDATE, DELETE, COPY_AD, RETAG_UTM |
| CUSTOM_AUDIENCE | LIST | CREATE, UPLOAD_USERS (customer PII upload, hashed) |
| TARGETING | SEARCH | — |
| PAGE | LIST | — |
| DATASET | LIST, GET_MATCH_QUALITY | — |

### 1.2 Input schemas (summary)

- `list_meta_ads_campaigns`: `account_id?`, `client_id?` (admin-only; when set,
  `account_id` is required) — `emma/tools.ts:1255-1265`.
- `get_meta_ads_metrics`: `timeframe` (7d|14d|30d|90d), `campaign_ids` (array or
  string), legacy `campaign_id`, `account_id?`, `client_id?` — `emma/tools.ts:1868-1897`.
  The gateway requires at least one campaign id (`services/agentToolGatewayService.ts:1563-1577`).
- `call_meta_ads_insights_api`: required `account_id`, `object_type`, `fields`.
  Optional `object_id`, `date_preset` | `time_range`, `level`, `breakdowns`,
  `action_breakdowns`, `filtering`, `client_id` — `emma/tools.ts:1750-1853`.
- `call_meta_marketing_api`: `entity_type`, `action`, `account_id`, `campaign_id`,
  plus a free-form `params` object (budget, status, targeting, creative,
  `objective_quote`, `override_tracking_check`, etc.) — `emma/tools.ts:1526-1640`.
- `launch_targeted_audience_campaign`: required `account_id`, `campaign_id`,
  `audience_name`, `audience_source`, `ad_set_params`. Also `confirm` and
  `preview_token` — `emma/tools.ts:1690-1715`.
- `launch_retargeting_campaign`: same as above, plus required `exclude_audience_id` —
  `emma/tools.ts:1717-1742`.

## 2. Required Meta scope

The OAuth marketing flow requests `ads_management`, `ads_read`, `pages_show_list`
and `pages_read_engagement` (`backend/src/config/integrations.ts:45-53`). The
capability check reads ONLY Meta's `debug_token` `granted_scopes`
(`backend/src/utils/metaAdsScope.ts:16-27, 254-269`). It never reads the requested scopes.

| Tool / action class | Minimum Meta scope | Notes |
|---------------------|--------------------|-------|
| Reads (tools 1-3, read actions of tool 4) | `ads_read` OR `ads_management` (`META_ADS_READ_SCOPES`, `utils/metaAdsScope.ts:27`) | Ad-account asset access is a separate grant (`ads_scope_tier`, `utils/metaAdsScope.ts:74-90`) |
| PAGE LIST, ad CREATE with a Page identity | `pages_show_list` + `pages_read_engagement` | Page access is independent of the ads scope (ENG-2232, `utils/metaAdsScope.ts:113-135, 347-351`) |
| All writes (tool 4 writes, tools 5-6) | `ads_management` | `ads_read` alone cannot write |
| CUSTOM_AUDIENCE UPLOAD_USERS, tools 5-6 audience build | `ads_management` + the ad account's accepted Custom Audience terms | Moves customer PII to Meta |

Inferred, not verified by a live call: `ads_management` as the write minimum is Meta's
documented model. The code does not separately gate writes on `ads_management` vs
`ads_read`. A token that has only `ads_read` passes the capability check and then
fails at Meta with (#200) internally. External toolkit v1 refuses every write
locally under D2/D4 (sections 4/5), before reaching that path.

## 3. Write-safety guards (ENG-2046 family) by tool

| Guard | Where | Applies to |
|-------|-------|-----------|
| Approval deck / target confirmation (halt before any write) | `services/agentModeService.ts:5247-5330`, `22673` | Tool 4 CAMPAIGN/AD_SET/AD CREATE, UPDATE, DELETE, COPY_AD |
| Preview-token two-phase confirm | tool descriptions `emma/tools.ts:1693, 1720` | Tools 5, 6 |
| Objective-immutability gate (`objective_quote`) | `services/agentModeService.ts:22133` | Tool 4 CAMPAIGN CREATE |
| Tracking pre-flight launch gate (`reason: 'tracking_preflight'`) | `services/agentModeService.ts:42284` | Any status→ACTIVE through tool 4 |
| Currency normalization, major units in and minor units to Meta (ENG-2277) | `services/metaService.ts:13-25` (`normalizeMetaMoney`) | Every budget/bid/spend-cap input on tools 4-6 |
| Budget anomaly gate >2x reconfirm / >10x block (ENG-2279) | `services/agentMode/metaBudgetAnomaly.ts:2`, `services/agentModeService.ts:22343, 22549-22556, 22787-22791` | Tool 4 budget-changing CAMPAIGN/AD_SET UPDATE, on both the model path and the approved-deck dispatch |
| Write rate shaping: 4 budget edits/hr/object, coalescing, burst score (ENG-2280) | `services/agentMode/metaWriteRateShaper.ts:17-32`, `services/agentModeService.ts:22891-22948` | All tool 4 writes on the shared authorized-write path |
| Budget write read-back (ENG-2278, in review: PR #3194) | not on main yet | Tool 4 budget writes |

Reads go through no write guard. They are only rate-scored
(`metaWriteRateShaper.recordRead`, `services/agentModeService.ts:22905`).

Known gap: tools 5 and 6 build their ad sets outside `callMetaMarketingApi`. This
needs verification in a follow-up slice. If the gap is real, the ENG-2279 anomaly gate
and the ENG-2280 shaper do NOT cover them. See D3.

## 4. DECIDED v1 external surface

> **Superseded in part (ENG-2303, Harsha 2026-10-12):** guarded writes are in scope.
> `call_meta_marketing_api` now also accepts CAMPAIGN / AD_SET / AD **CREATE** and
> **UPDATE of status (ACTIVE|PAUSED) or budget**, via `mcp/metaToolkitWrites.ts`:
> preview first (nothing sent), then `confirm=true` + a single-use HMAC `preview_token`
> bound to the user, the exact arguments and what the preview showed (15 min TTL). New
> entities are always created PAUSED; activation is its own preview + confirm. Writes
> require a payment method + usable Meta connection (`zoma_status`), a **granted**
> `ads_management` scope (D4), the optional `META_TOOLKIT_SPEND_CEILING` policy, the
> currency echo, and dispatch through `dispatchAuthorizedMetaWrite` (budget-anomaly
> re-check, tracking pre-flight, rate shaper); the read-back decides CONFIRMED / MISMATCH /
> UNCONFIRMED. Everything else listed as excluded below stays excluded.

Harsha approved D1–D5 on 2026-10-06. External v1 is **reads-only**.
The manifest narrows the advertised action enum and `assertMetaToolkitV1Call`
refuses every write with `MetaToolkitRefusal` before shared handler dispatch.
REST and MCP use this same toolkit path; internal Emma behavior is unchanged.

Included:
- `list_meta_ads_campaigns`, `get_meta_ads_metrics`, `call_meta_ads_insights_api`
- `call_meta_marketing_api` read actions: LIST/GET/PREVIEW/SEARCH/GET_MATCH_QUALITY

Excluded from v1:
- All CREATE/UPDATE/DELETE actions, even with an approval deck or `ads_management`.
- `launch_targeted_audience_campaign`, `launch_retargeting_campaign`: stay internal.
- CUSTOM_AUDIENCE CREATE / UPLOAD_USERS: excluded; no third-party PII upload.
- AD_CREATIVE UPLOAD_IMAGE / UPLOAD_VIDEO / CREATE and AD COPY_AD / RETAG_UTM.
- `params.override_tracking_check` and admin-only cross-client `client_id`.

## 5. DECIDED product choices (ENG-2268)

- **D1 — DECIDED:** Reads on all paid tiers; writes Pro+ in a future write-capable
  version. Pricing TBD. Documented only; no new billing/tier enforcement here.
- **D2 — SUPERSEDED (ENG-2303, 2026-10-12):** was reads-only external v1. Now guarded
  CREATE + status/budget UPDATE for CAMPAIGN/AD_SET/AD behind a bound preview→confirm
  (section 4 note). DELETE and the other exclusions stand.
- **D3 — DECIDED:** `launch_*` tools stay internal, not in the external manifest.
- **D4 — DECIDED:** Fail closed locally on writes when `granted_scopes` lacks
  `ads_management`. Enforced by ENG-2303's write path from `granted_scopes` on the
  connected account; a missing record (`unknown`) also fails closed and asks for a
  reconnect.
- **D5 — DECIDED:** CUSTOM_AUDIENCE CREATE / UPLOAD_USERS remain excluded.

## 6. Agent-driven onboarding — device flow (ENG-2496)

An agent can set a user up end to end without the user editing any config ("get set up with
Zoma"). The flow follows RFC 8628:

| Step | Endpoint | Notes |
|---|---|---|
| Start | `POST /api/zoma/setup` (unauthenticated, 10/min/IP) | `device_code`, `user_code` (`XXXX-XXXX`), `verification_uri(_complete)`, `interval` 5s, `expires_in` 900s |
| Approve | `GET /api/zoma/activate?user_code=` | Redirects into the existing MCP OAuth sign-in + consent page as first-party client `zoma-device-setup` (PKCE held server-side); the callback binds the device code to the signed-in user. Sign-up works through the same portal page. |
| Poll | `POST /api/zoma/setup/poll {device_code}` | `authorization_pending` (+`next_step: sign_in`) / `slow_down` / `expired_token` / `access_denied` / `invalid_grant`; once bound, `next_step` `connect_meta` → `add_payment` → `complete`, derived from `getZomaReadiness` (links minted once per step and cached on the device record). Once bound, the device code stays valid for 60 min of onboarding. |
| Token | returned once on `complete` | `zoma_…` bearer; only `sha256` is stored. Accepted by `/api/meta-toolkit/mcp` and the REST toolkit via `authenticateMetaToolkitCaller` (`authMethod: zoma_token`, 60/min per token). |
| Revoke | `POST /api/zoma/token/revoke` with the token as Bearer | Idempotent; unknown tokens also return 200 (RFC 7009). |

Storage is isolated in `backend/src/mcp/zomaDeviceStore.ts` (table `AW-ZomaDeviceAuth`).
