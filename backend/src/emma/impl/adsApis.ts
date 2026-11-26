/**
 * ENG-2103 (F2) — Meta/LinkedIn ads APIs tool cluster, extracted from
 * `AgentModeService`. The 18th domain cluster in this series, and the first
 * that is NOT contiguous or even loosely clustered in the original file: its
 * 9 methods are scattered individually across ~10,000 lines (roughly
 * line 13058 to 23348 pre-extraction), interspersed with ~190 other method
 * declarations belonging to different features entirely (some already
 * extracted by other clusters, some future clusters' territory, some
 * permanently-on-the-class code). Each of the 9 was gone to directly by line
 * number/name; the intervening code was never read or touched.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 *   - `callMetaAdsInsightsApiWrapper` (~13058-13420 pre-extraction)
 *   - `listMetaAdsCampaignsNew` (~13966-14021), plus its exclusive private
 *     helper `normalizeMetaAdsReadError` (~12767-12847 — physically ~1,200
 *     lines away, confirmed by whole-backend grep to have exactly one caller,
 *     this method, and to make zero `this.*` calls of its own)
 *   - `getMetaAdsMetrics` (~15501-15738), plus 6 exclusive private helpers it
 *     alone calls (verified by whole-backend grep: no other caller inside or
 *     outside `agentModeService.ts` for any of the six) —
 *     `processCampaignData`, `processAdSetsData`, `processAdsData`,
 *     `generateCampaignSummary`, `processBreakdownData` (all ~18799-19093,
 *     ~700 lines below `getMetaAdsMetrics` itself), `formatMetricsSummary`
 *     (~19096-19421)
 *   - `callMetaMarketingApi` (~16736-17023)
 *   - `launchAudienceCampaign` (private, ~18343-18468), plus its exclusive
 *     private helper `executeAudienceCampaignLaunch` (~18482-18735, the
 *     actual write-execution body — confirmed by whole-backend grep to have
 *     exactly one caller), and four more small exclusive helpers confirmed
 *     zero other callers: `resolveAudienceSourceArg` (~18323), one
 *     `computeAudienceCampaignArgsDigest` (~18296), `rethrowStepFailure`
 *     (~18476), `isDeepSubset` (~18266), `canonicalJSON` (~18238), and
 *     `buildAudienceCampaignConfirmationSummary` (~18189)
 *   - `launchTargetedAudienceCampaign` / `launchRetargetingCampaign`
 *     (~18742/~18751 — one-line dispatchers onto `launchAudienceCampaign`)
 *   - `callLinkedInMarketingApi` (~22991-23309), plus its exclusive private
 *     helper `getLinkedInAdsCredentials` (~22922-22986 — its ONLY two callers
 *     are this method and the next one, both in this cluster)
 *   - `callLinkedInAdsInsightsApi` (~23314-23345)
 *
 * Zero `this.callLLM`/`this.generateImage`/`this.describeImage`/
 * `this.callVisionLLMWithTimeout` coupling anywhere in any of the 9 methods or
 * their helpers — every body was read in full (not just boundary-grepped) and
 * individually grepped for the four names; none matched. No exclusions
 * needed for this cluster.
 *
 * ENG-2103 (F2) FOLLOW-UP: `resolveOrCreateSeedAudience` and
 * `getCampaignForAdSetReuseCheck` were originally kept UNMOVED on
 * `AgentModeService` (see the two bullets that used to live here) purely
 * because `agentModeService.audienceCampaignWorkflows.test.ts` independently
 * `jest.spyOn`s them (27 and 2 times respectively) while exercising
 * `launchAudienceCampaign`/`executeAudienceCampaignLaunch` — the classic
 * "sibling call bypasses the mocked seam" risk, just with the seam on the
 * class instance rather than the module namespace. This follow-up pass
 * closes that gap using the pattern proven on cluster 10: both are now
 * MOVED here as real exports, and `executeAudienceCampaignLaunch`/
 * `launchAudienceCampaign` reach them through a same-module self-import
 * (`import * as self from './adsApis'`, referenced only inside those two
 * function bodies) rather than through `deps` — a plain `deps.<fn>(...)`
 * reference would never route back through this module's exports object, so
 * an external `jest.spyOn(adsApisImpl, '<fn>')` would silently stop
 * intercepting the internal call, exactly the cluster-10 failure mode.
 *
 *   - `resolveOrCreateSeedAudience` needs two things that must stay on the
 *     class: `manageMetaCustomAudiences` (already injected, shared with
 *     out-of-scope code) and `resolveHubSpotService` (a private,
 *     cluster-19-owned wrapper around `emma/impl/adsCrmApis.ts` — kept there
 *     for its OWN cross-cluster reason: `agentModeService.
 *     audienceCampaignWorkflows.test.ts` also `jest.spyOn`s it 13 times
 *     directly). Both are now carried on `LaunchAudienceCampaignDeps` and
 *     threaded through to `resolveOrCreateSeedAudience`'s own `deps`
 *     parameter — a NEW, third parameter after `opts`, which is why every
 *     `jest.spyOn(adsApisImpl, 'resolveOrCreateSeedAudience')` call site's
 *     recorded arguments now include a trailing deps object (2 pre-existing
 *     exact-args assertions in the test file were updated to expect it via
 *     `expect.anything()`, not loosened in any other way).
 *     `audienceRowKey`/`fetchAndParseCsvRords` — exclusive helpers with zero
 *     other callers (confirmed by grep) — moved alongside it as plain
 *     non-exported module functions, no injection needed.
 *     `AgentModeService.AUDIENCE_SOURCE_SCHEMA` moved the same way, as a
 *     plain module constant. `hashAudienceRows` (shared with
 *     `manageMetaCustomAudiences`, which stays on the class) is genuinely
 *     stateless — verified by reading its body, zero `this.*` references —
 *     so it's promoted to a real export here (`hashAudienceRows`, see
 *     below) with the class's own method turned into a one-line delegating
 *     wrapper, the same "formatMetricsSummary" treatment this cluster
 *     already used once.
 *   - `getCampaignForAdSetReuseCheck` only needs `getMetaCredentials`
 *     (already injected, shared with out-of-scope code) — its own `deps`
 *     parameter is a strict subset of `LaunchAudienceCampaignDeps`.
 *
 * Both are DELETED outright from `AgentModeService` (confirmed zero
 * production callers remain once the class's 3 deps-construction sites
 * stopped needing `this.resolveOrCreateSeedAudience.bind(this)` /
 * `this.getCampaignForAdSetReuseCheck.bind(this)`) — not kept as delegating
 * wrappers, since nothing outside this module and its retargeted test spies
 * ever called them.
 *
 * The same reasoning applies to `formatMetricsSummary`: unlike its 5 sibling
 * helpers (which have zero spies and are called as plain local functions
 * inside the moved `getMetaAdsMetrics`), `formatMetricsSummary` IS spied
 * directly (`jest.spyOn(service, 'formatMetricsSummary')` in
 * `agentModeService.metaMetricsAccountResolution.test.ts`) while testing
 * `getMetaAdsMetrics`'s account-resolution behavior. Its own body has zero
 * other callers and no reason to stay on the class, so it DID move here (with
 * a delegating wrapper kept on the class, same as its siblings) — but the
 * moved `getMetaAdsMetrics` calls it via an injected parameter rather than a
 * local function reference, so a spy on the class-instance wrapper is still
 * observed exactly as it always was.
 *
 * Four more shared/out-of-scope methods the moved code depends on, all
 * confirmed by whole-backend grep to have real callers well beyond this
 * cluster (30+ call sites for `getMetaCredentials` alone) and therefore left
 * untouched on the class, supplied as injected function parameters:
 * `getMetaCredentials`, `manageMetaCustomAudiences`, `listMetaAdsAdSets`,
 * `createMetaAdsAdSet`. `makeMetaAuthError`/`ensureUsableMetaToken`/
 * `assertMetaAdsScope`/`resolveMetaCredentialScope` are all private helpers
 * of `getMetaCredentials` itself and are never called directly by any of the
 * 9 moved methods — nothing further to inject for them.
 *
 * `callMetaMarketingApi` additionally depends on 6 shared private/static
 * methods it does not own (`resolveCampaignObjectiveGate`,
 * `validateMetaActionParams`, `claimMetaWriteManifestGrant`,
 * `buildMetaWriteConfirmation`, `resolveMetaWriteManifestDigest`,
 * `dispatchAuthorizedMetaWrite`, plus the two static helpers
 * `isMetaWriteAction`/`remedyFromScopeRefusal`) — each confirmed by grep to
 * have 7-14 references, i.e. real callers/definitions well beyond this one
 * method (`dispatchAuthorizedMetaWrite` in particular is also reached
 * directly by an approved-deck workflow step, per its own doc comment). All
 * eight stay on the class untouched, supplied via `CallMetaMarketingApiDeps`.
 *
 * `AgentModeService.prototype.<name>` now delegates to these functions rather
 * than duplicating them. Kept as delegating wrappers (real callers beyond
 * `emma/tools.ts`, found by grepping the whole backend):
 *   - `callMetaAdsInsightsApiWrapper`: `routes/emmaApi.ts`'s
 *     `POST /call-meta-ads-insights-api` handler, plus several test files
 *     calling the real instance method directly.
 *   - `listMetaAdsCampaignsNew`: no production route caller found, but 6 test
 *     files call the real method directly on a real instance.
 *   - `getMetaAdsMetrics`: `routes/emmaApi.ts`'s `GET /meta-ads-metrics`
 *     handler, plus direct real-instance test calls.
 *   - `processCampaignData`: `eng1575.processorLeadMetrics.test.ts` calls
 *     `(agentModeService as any).processCampaignData(...)` directly (note:
 *     `routes/meta.ts` has its own SEPARATELY-DEFINED, unrelated
 *     `processCampaignData` module function of the same name — a coincidental
 *     naming collision, not a shared caller; confirmed by reading both.).
 *   - `processBreakdownData`: 2 test files call it directly.
 *   - `formatMetricsSummary`: 4 test files call/spy it directly.
 *   - `callMetaMarketingApi`: `routes/emmaApi.ts`'s `POST /call-meta-marketing-api`
 *     handler, plus 9 test files calling the real method directly.
 *   - `launchTargetedAudienceCampaign` / `launchRetargetingCampaign`:
 *     `jest.spyOn(agentModeService, '<name>')` in
 *     `emmaToolGateWiring.test.ts`, plus direct real-instance test calls in
 *     `agentModeService.audienceCampaignWorkflows.test.ts`.
 *   - `callLinkedInMarketingApi` / `callLinkedInAdsInsightsApi`: no
 *     production route caller found, but multiple test files call the real
 *     methods directly on a real instance.
 *
 * DELETED outright from the class (zero callers anywhere beyond the method
 * that moved with them, confirmed by whole-backend grep, no test calls
 * either): `normalizeMetaAdsReadError`, `processAdSetsData`, `processAdsData`,
 * `generateCampaignSummary`, `rethrowStepFailure`, `isDeepSubset`,
 * `canonicalJSON`, `resolveAudienceSourceArg`, `computeAudienceCampaignArgsDigest`,
 * `buildAudienceCampaignConfirmationSummary`, `executeAudienceCampaignLaunch`,
 * `launchAudienceCampaign` (was `private`, its only 2 callers are the two
 * thin wrappers, both moved here to call this module directly instead),
 * `getLinkedInAdsCredentials`.
 *
 * Transitive-import notes: `metaService`/`MetaService` (`../../services/metaService`),
 * `linkedInAdsService` (`../../services/linkedInAdsService`, namespace
 * import matching the original), `metaLaunchGate.ts`, `sandboxTrackingPreflight.ts`,
 * `metaTestAccountGuard.ts`, `metaAudienceCampaignTokenStore.ts`,
 * `metaCampaignIds.ts`, `metaConstants.ts`, `metaInsightsFiltering.ts`,
 * `metaListScope.ts`, `metaBreakdownStatus.ts`, `agentMode/sandboxPolling.ts`,
 * and `config/jwt.ts` are all STATIC imports here, matching exactly how
 * `agentModeService.ts` already statically imported every one of them.
 *
 * ONE real transitive fact found and confirmed (empirically, via a
 * `jest.doMock`-throws probe, not just reading import lists):
 * `metaLaunchGate.ts` statically imports `chatbotDb` from
 * `services/chatbotService.ts`, and `chatbotService.ts` itself statically
 * imports both `agentModeService.ts` and `services/db.ts` (the real
 * `AWS.DynamoDB.DocumentClient`-constructing module) at ITS OWN top level.
 * So requiring this module (`adsApis.ts`) does transitively load
 * `agentModeService.ts`'s and `services/db.ts`'s module bodies — this is
 * NOT a new circularity introduced by this extraction: `agentModeService.ts`
 * already statically imported `metaLaunchGate.ts` before F2 touched this
 * cluster, so the exact same chain (`agentModeService.ts` -> `metaLaunchGate.ts`
 * -> `chatbotService.ts` -> `agentModeService.ts`) already existed and
 * already worked (Node's CJS loader resolves it to a partially-initialized
 * module on the cycle, same as it does today in production). Not fixed here
 * — `metaLaunchGate.ts` is shared infrastructure with ~20 other callers
 * across the backend, well outside this cluster's 9 methods, and lazily
 * importing just the two functions this module uses
 * (`isMetaSpendStartingWrite`/`runMetaTrackingGate`) would not change the
 * practical outcome anyway, since `agentModeService.ts` itself still loads
 * unconditionally and immediately in every real process today. Flagged
 * here as a known limitation on this cluster's two directly-repointed
 * `emma/tools.ts` entries' (`call_linkedin_marketing_api`/
 * `call_linkedin_ads_insights_api`) "no need to construct the whole class"
 * claim — true in the sense that this module never touches `this`/an
 * `AgentModeService` instance, but not true in the stronger sense of the
 * file never being loaded into the process. `connectedAccountsDb.ts`
 * (`updateAccountConfig`, inside `normalizeMetaAdsReadError`) and
 * `utils/metaAdsScope.ts` were already lazily `await import(...)`-ed at their
 * call sites in the original code and are kept exactly as-is, with only the
 * relative path prefix adjusted from `./x`/`../utils/x` (relative to
 * `services/`) to `../../services/x`/`../../utils/x` (relative to
 * `emma/impl/`). Confirmed clean via `npm run typecheck`, not just by reading
 * the import list.
 *
 * `getMetaCredentials`, `manageMetaCustomAudiences`, `listMetaAdsAdSets`,
 * `createMetaAdsAdSet`, `resolveCampaignObjectiveGate`,
 * `validateMetaActionParams`, `claimMetaWriteManifestGrant`,
 * `buildMetaWriteConfirmation`, `resolveMetaWriteManifestDigest`,
 * `dispatchAuthorizedMetaWrite`, `isMetaWriteAction`, `remedyFromScopeRefusal`,
 * and `resolveHubSpotService` are untouched on `AgentModeService` — not read
 * past what was needed to confirm their signatures and caller counts.
 * `resolveOrCreateSeedAudience` and `getCampaignForAdSetReuseCheck` moved
 * here in the F2 follow-up pass described above and were deleted from the
 * class.
 */
import axios from 'axios';
import { createHash, createHmac } from 'crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import { applyLeadMetrics, finalizeLeadCosts } from '../../utils/metaActionFamilies';
import { metaService, MetaService } from '../../services/metaService';
import { HubSpotService } from '../../services/hubspotService';
import { getAudienceSnapshotRowKeys, saveAudienceSnapshotRowKeys, CorruptSnapshotError } from '../../services/metaAudienceSnapshotStore';
import { resolvePinnedPublicAddress } from '../../utils/ssrfGuard';
// Self-import: `executeAudienceCampaignLaunch`/`launchAudienceCampaign` reach
// `resolveOrCreateSeedAudience`/`getCampaignForAdSetReuseCheck` (both defined
// in this same module, below) through `self.<fn>` rather than a local
// function reference, so an external `jest.spyOn(adsApisImpl, '<fn>')`
// actually intercepts the internal call — the cluster-10 lesson.
import * as self from './adsApis';
import * as linkedInAdsService from '../../services/linkedInAdsService';
import { normalizeMetaInsightsFiltering, describeMetaGraphApiError } from '../../utils/metaInsightsFiltering';
import { sandboxAwarePollDelayMs } from '../../services/agentMode/sandboxPolling';
import { normalizeMetaCampaignIds } from '../../utils/metaCampaignIds';
import { summarizeBreakdownSections } from '../../services/agentMode/metaBreakdownStatus';
import {
  ALLOWED_NODE_TYPES,
  AllowedNodeType,
  ALLOWED_INSIGHTS_FIELDS,
  suggestInsightsFields,
  ALLOWED_INSIGHTS_BREAKDOWNS,
  ALLOWED_ACTION_BREAKDOWNS,
  ALLOWED_DATE_PRESETS,
  META_WEBSITE_OPTIMIZATION_GOALS,
} from '../../utils/metaConstants';
import { buildListMessage, buildListResult } from '../../services/agentMode/metaListScope';
import { classifyMetaReadFailure, META_RECONNECT_MESSAGE, META_PERMISSION_MESSAGE } from '../../utils/metaReadErrorClass';
import {
  isMetaSpendStartingWrite,
  runMetaTrackingGate,
  computeTrackingOverrideDigest,
  trackingOverrideTokenMatches,
} from '../../services/metaLaunchGate';
import { buildSandboxFetchHtml } from '../../services/sandboxTrackingPreflight';
import { assertMetaAccountAllowed } from '../../services/metaTestAccountGuard';
import { claimPreviewToken, releasePreviewToken, markPreviewTokenSucceeded } from '../../services/metaAudienceCampaignTokenStore';
import { getJwtSecret } from '../../config/jwt';
import { metaWriteRateShaper } from '../../services/agentMode/metaWriteRateShaper';
import { describeMetaWriteParamDrift, formatMetaWriteParamDriftMessage } from '../../services/agentMode/core/approvalDeck';

/** Local copy of `AgentModeService`'s private `MetaApiResult` type — never exported there. */
type MetaApiResult = {
  success: boolean;
  message: string;
  error?: string;
  details?: any;
  [key: string]: any;
};

/**
 * `AgentModeService.prototype.getMetaCredentials` resolves connected-account
 * credentials for 30+ call sites across the class — far beyond this cluster's
 * 9 methods — so it stays put, untouched, and is handed in as a bound
 * function from each class-level delegating wrapper.
 */
export type MetaCredentialsResolver = (
  userId: string,
  accountId?: string,
  clientScope?: { clientId?: string; callerIsAdmin?: boolean; toolName: string }
) => Promise<{ accountId: string; accessToken: string; connection?: any }>;

/** Dependencies `getMetaAdsMetrics` needs from the still-on-the-class surface. */
export type GetMetaAdsMetricsDeps = {
  getMetaCredentials: MetaCredentialsResolver;
  /**
   * Stays an injected parameter (not a local function call) specifically so
   * `jest.spyOn(agentModeService, 'formatMetricsSummary')` — used in
   * `agentModeService.metaMetricsAccountResolution.test.ts` to stub the
   * formatting step while testing account resolution — keeps working exactly
   * as it did before this method moved. See module header.
   */
  formatMetricsSummary: (data: any, userId: string) => Promise<string>;
};

/**
 * Dependencies `callMetaMarketingApi` needs from the still-on-the-class
 * surface — six private/static methods shared with the rest of the Meta
 * write-dispatch machinery (workflow-step replay, approval decks, etc.),
 * confirmed by grep to have real callers well beyond this one method.
 */
export type CallMetaMarketingApiDeps = {
  preparePausedMetaBundle?: (userId: string, sessionId: string | undefined, accountId: string, params: unknown) => Promise<MetaApiResult>;
  resolveCampaignObjectiveGate: (
    userId: string,
    sessionId: string | undefined,
    account_id: string,
    params: any,
  ) => Promise<{ allowed: true; objective: string } | { allowed: false; response: MetaApiResult }>;
  validateMetaActionParams: (
    entity_type: string,
    action: string,
    campaign_id: string | undefined,
    ad_set_id: string | undefined,
    ad_id: string | undefined,
    params: any,
  ) => void;
  claimMetaWriteManifestGrant: (
    userId: string,
    sessionId: string,
    entity_type: string,
    action: string,
    account_id: string,
    campaign_id: string | undefined,
    ad_set_id: string | undefined,
    ad_id: string | undefined,
    params: any,
  ) => Promise<{ granted: boolean; digest?: string }>;
  buildMetaWriteConfirmation: (
    userId: string,
    entity_type: string,
    action: string,
    account_id: string,
    campaign_id: string | undefined,
    ad_set_id: string | undefined,
    ad_id: string | undefined,
    params: any,
  ) => Promise<{ summary: string; target: Record<string, any>; tenancyRefused: boolean; tenancyRefusalMessage?: string }>;
  resolveMetaWriteManifestDigest: (
    userId: string,
    entity_type: string,
    action: string,
    account_id: string,
    campaign_id: string | undefined,
    ad_set_id: string | undefined,
    ad_id: string | undefined,
    params: any,
  ) => Promise<string>;
  dispatchAuthorizedMetaWrite: (
    userId: string,
    entity_type: string,
    action: string,
    account_id: string,
    campaign_id: string | undefined,
    ad_set_id: string | undefined,
    ad_id: string | undefined,
    params: any,
    overrideApproved: boolean,
    sessionId: string | undefined,
  ) => Promise<MetaApiResult>;
  isMetaWriteAction: (entity_type: string, action: string) => boolean;
  remedyFromScopeRefusal: (refusal: string | undefined) => string;
  getMetaCredentials: MetaCredentialsResolver;
  /**
   * ENG-2277/2278/2279/2280 (main-sync 2026-10-02): stays on the class —
   * reads credentials, the prior entity state via `metaService`, and
   * `getLastUserMessageText`, none of which this cluster extracted. Same
   * treatment as `dispatchAuthorizedMetaWrite` above: a sibling private
   * method injected whole rather than further decomposed.
   */
  checkMetaBudgetChange: (
    userId: string,
    entity_type: string,
    action: string,
    account_id: string,
    campaign_id: string | undefined,
    ad_set_id: string | undefined,
    ad_id: string | undefined,
    params: any,
    sessionId: string | undefined,
  ) => Promise<{
    // Matches the actual (TS-widened, no `as const`) literal checkMetaBudgetChange
    // returns on this branch — not the full MetaApiResult shape (no `message`
    // field). The call site returns this `as any`, same as every other
    // gate-blocked branch here.
    blocked?: { success: boolean; blocked: boolean; reason: string; error: string };
    changes?: Array<{ field: string; prior: number | undefined; proposed: number | undefined; ratio: number | null; severity: string }>;
    severity?: string;
    spendConcern?: boolean;
    token?: string;
    suggestedAction?: string;
    requiresConfirmation?: boolean;
  } | undefined>;
};

/**
 * Dependencies `launchAudienceCampaign`/`executeAudienceCampaignLaunch` need
 * from the still-on-the-class surface: `getMetaCredentials`,
 * `manageMetaCustomAudiences`, `listMetaAdsAdSets`, `createMetaAdsAdSet` are
 * shared with out-of-scope code. `resolveHubSpotService` is a private,
 * cluster-19-owned wrapper (`emma/impl/adsCrmApis.ts`) kept on the class for
 * its own cross-cluster reason — `agentModeService.
 * audienceCampaignWorkflows.test.ts` `jest.spyOn`s it 13 times directly —
 * and is threaded through to `resolveOrCreateSeedAudience`'s own `deps`
 * (see module header). `resolveOrCreateSeedAudience` and
 * `getCampaignForAdSetReuseCheck` themselves are NOT part of this deps bag
 * any more (ENG-2103 F2 follow-up) — both are real exports of this module
 * now, reached via a same-module self-import from inside
 * `executeAudienceCampaignLaunch`/`launchAudienceCampaign`.
 */
export type LaunchAudienceCampaignDeps = {
  getMetaCredentials: MetaCredentialsResolver;
  manageMetaCustomAudiences: (
    userId: string,
    action: 'LIST' | 'CREATE' | 'UPLOAD_USERS' | 'DELETE_USERS' | 'REPLACE_USERS',
    accountId: string,
    params: any,
  ) => Promise<any>;
  resolveHubSpotService: (userId: string, hubspotAccountId?: string) => Promise<HubSpotService>;
  listMetaAdsAdSets: (
    userId: string,
    campaignId?: string,
    accountId?: string,
    options?: { adSetId?: string; fields?: string | string[] },
  ) => Promise<any>;
  createMetaAdsAdSet: (userId: string, args: any) => Promise<any>;
  /**
   * ENG-2277 (silently dropped by an earlier main-sync, restored here):
   * the ad-set reuse-match comparison must normalize the REQUESTED budget
   * the same currency-aware way createMetaAdsAdSet itself does before
   * writing — a naive ×100 ("cents") assumption defeats reuse for every
   * zero-decimal currency (TWD, JPY, KRW, ...), where Meta's minor unit
   * equals its major unit.
   */
  normalizeMetaMoneyParams: (
    accountId: string,
    accessToken: string,
    params: any,
  ) => Promise<{ params: any; currency: string | undefined; confirmation: string }>;
};

/** `resolveOrCreateSeedAudience`'s own injected-dependency bag — a strict subset of `LaunchAudienceCampaignDeps`. */
export type SeedAudienceDeps = Pick<LaunchAudienceCampaignDeps, 'manageMetaCustomAudiences' | 'resolveHubSpotService'>;

/** `getCampaignForAdSetReuseCheck`'s own injected-dependency bag — a strict subset of `LaunchAudienceCampaignDeps`. */
export type CampaignForAdSetReuseCheckDeps = Pick<LaunchAudienceCampaignDeps, 'getMetaCredentials'>;

// ============================================================================
// 1. callMetaAdsInsightsApiWrapper
// ============================================================================

/**
 * Secure wrapper for Meta Ads Insights API calls (always async, with internal polling)
 */
export async function callMetaAdsInsightsApiWrapper(
  userId: string,
  args: {
    account_id: string;
    object_type: AllowedNodeType;
    object_id?: string;
    fields: string[];
    date_preset?: string;
    time_range?: { since: string; until: string };
    level?: AllowedNodeType;
    breakdowns?: string[];
    action_breakdowns?: string[];
    filtering?: any[];
    client_id?: string;
  },
  deps: { getMetaCredentials: MetaCredentialsResolver }
): Promise<any> {
  try {
    const {
      account_id,
      object_type,
      object_id,
      fields,
      date_preset,
      time_range,
      level,
      breakdowns,
      action_breakdowns,
      filtering,
      client_id,
    } = args;

    if (!ALLOWED_NODE_TYPES.includes(object_type)) {
      throw new Error(`Invalid object_type: ${object_type}`);
    }

    if (!fields?.length) {
      throw new Error("fields array is required");
    }

    // ENG-511: Do NOT hard-reject the whole call when some requested fields are
    // unknown. Meta Insights has a large, evolving field vocabulary and the model
    // occasionally requests a valid-but-unwhitelisted field (e.g.
    // cost_per_inline_link_click) or a plausible-but-unsupported one. Previously
    // any unknown field threw, the model re-issued the identical call, and the
    // anti-loop/retry guard hard-blocked the entire insights channel before any
    // metrics came back. Instead: drop the unknown fields, keep the valid subset,
    // and proceed. Only fail when NOTHING valid remains — and even then, name the
    // dropped fields so the model corrects rather than blindly retries.
    const droppedFields = fields.filter(
      (f) => !ALLOWED_INSIGHTS_FIELDS.includes(f)
    );
    let validFields = fields.filter((f) =>
      ALLOWED_INSIGHTS_FIELDS.includes(f)
    );

    if (!validFields.length) {
      // ENG-511: point the model at the closest valid field for each bad one so
      // it can correct a typo/loose phrasing rather than guess.
      const suggestions = suggestInsightsFields(droppedFields);
      const suggestionHint = Object.keys(suggestions).length
        ? ` Did you mean: ${Object.entries(suggestions)
            .map(([bad, good]) => `${bad} -> ${good}`)
            .join(", ")}?`
        : "";
      throw new Error(
        `Invalid insights fields requested: ${droppedFields.join(", ")}. None are supported, so no data could be fetched — do not retry with the same fields.${suggestionHint} Choose from allowed fields such as impressions, clicks, spend, cpc, ctr, reach, inline_link_clicks, cost_per_inline_link_click.`
      );
    }

    if (breakdowns?.length) {
      const invalidBreakdowns = breakdowns.filter(
        (b) => !ALLOWED_INSIGHTS_BREAKDOWNS.includes(b)
      );

      if (invalidBreakdowns.length) {
        throw new Error(
          `Invalid breakdowns requested: ${invalidBreakdowns.join(", ")}. Allowed: ${ALLOWED_INSIGHTS_BREAKDOWNS.join(", ")}`
        );
      }
    }

    // Validate action_breakdowns
    if (action_breakdowns?.length) {
      const invalidActionBreakdowns = action_breakdowns.filter(
        (ab) => !ALLOWED_ACTION_BREAKDOWNS.includes(ab)
      );
      if (invalidActionBreakdowns.length) {
        throw new Error(
          `Invalid action_breakdowns requested: ${invalidActionBreakdowns.join(", ")}. Allowed: ${ALLOWED_ACTION_BREAKDOWNS.join(", ")}`
        );
      }
    }

    // Validate level
    if (level && !ALLOWED_NODE_TYPES.includes(level)) {
      throw new Error(
        `Invalid level: ${level}. Allowed: ${ALLOWED_NODE_TYPES.join(", ")}`
      );
    }

    // Date validation (mutually exclusive)
    if (date_preset && time_range) {
      throw new Error("Provide either date_preset or time_range, not both.");
    }

    // Validate date_preset value
    if (date_preset && !ALLOWED_DATE_PRESETS.includes(date_preset)) {
      throw new Error(
        `Invalid date_preset: "${date_preset}". Allowed: ${ALLOWED_DATE_PRESETS.join(", ")}`
      );
    }

    // Validate time_range format and logic
    if (time_range) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!time_range.since || !dateRegex.test(time_range.since)) {
        throw new Error(`time_range.since must be in YYYY-MM-DD format (got "${time_range.since}").`);
      }
      if (!time_range.until || !dateRegex.test(time_range.until)) {
        throw new Error(`time_range.until must be in YYYY-MM-DD format (got "${time_range.until}").`);
      }
      if (time_range.since > time_range.until) {
        throw new Error(`time_range.since (${time_range.since}) must be on or before time_range.until (${time_range.until}).`);
      }
    }

    // Meta requires `filtering` to be a LIST. The model supplies it as a bare
    // object or as pre-serialized JSON often enough that both shapes reached
    // production: the string produced `(#100) param filtering must be an
    // array`, and the object was silently dropped by the old `?.length` guard,
    // widening the query to the whole account. Normalize both, and reject
    // anything unhonourable here — before we spend a credential or an API
    // call — rather than quietly answering a different question (ENG-630).
    const normalizedFiltering = normalizeMetaInsightsFiltering(filtering);

    const { accountId, accessToken } =
      await deps.getMetaCredentials(
        userId,
        account_id,
        client_id ? { clientId: client_id, toolName: 'call_meta_ads_insights_api' } : undefined
      );

    const actualNodeId =
      object_type === "account"
        ? `act_${accountId}`
        : object_id ??
        (() => {
          throw new Error(
            `object_id is required for object_type ${object_type}`
          );
        })();

    const version = process.env.META_API_VERSION || "v25.0";
    const baseUrl = `https://graph.facebook.com/${version}`;
    const submitUrl = `${baseUrl}/${actualNodeId}/insights`;

    const filteredParams = {
      fields: validFields.join(","),
      limit: 5000,

      ...(date_preset && { date_preset }),
      ...(time_range && { time_range }),
      ...(level && { level }),
      ...(breakdowns?.length && {
        breakdowns: breakdowns.join(","),
      }),
      ...(action_breakdowns?.length && {
        action_breakdowns: action_breakdowns.join(","),
      }),
      ...(normalizedFiltering && { filtering: normalizedFiltering }),
    };

    // ENG-511: Run the full report (submit → poll → fetch) as one unit. Meta
    // rejects some whitelisted fields at SUBMIT time (HTTP 400 on the POST) but
    // others only LAZILY at result-read time (e.g. onsite_conversion_lead_grouped
    // returns "(#100) Tried accessing nonexisting summary field ..." on the GET,
    // after a report_run_id was already issued). Wrapping the whole run lets us
    // self-heal a bad field regardless of which stage surfaces it.
    const runReport = async (
      fieldsToSend: string[]
    ): Promise<{ reportRunId: string; data: any[] }> => {
      const submitRes = await axios.post(submitUrl, {
        ...filteredParams,
        fields: fieldsToSend.join(","),
        access_token: accessToken,
      });
      const rid = (submitRes.data as any)?.report_run_id;
      if (!rid) {
        throw new Error("Failed to get report_run_id from Meta");
      }

      // Polling Engine
      let attempts = 0;
      const maxAttempts = 60;
      // ENG-1908: see sandboxAwarePollDelayMs — a sandbox account's report is
      // already complete the instant it's created, so it never waits the real delay.
      const pollDelayMs = sandboxAwarePollDelayMs(accessToken, 10000);
      while (attempts < maxAttempts) {
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
        const statusRes = await axios.get(`${baseUrl}/${rid}`, {
          params: { access_token: accessToken },
        });
        const status = (statusRes.data as any)?.async_status;
        if (status === "Job Completed") break;
        if (status === "Job Failed" || status === "Job Skipped") {
          throw new Error(`Meta Insights Job failed: ${status}`);
        }
        if (attempts === maxAttempts) {
          throw new Error("Meta Insights Job timed out.");
        }
      }

      // Fetch Paginated Results
      const resultsUrl = `${baseUrl}/${rid}/insights`;
      const collected: any[] = [];
      let nextUrl: string | null = resultsUrl;
      let isFirstRequest = true;
      while (nextUrl) {
        const res: any = isFirstRequest
          ? await axios.get(nextUrl, { params: { access_token: accessToken } })
          : await axios.get(nextUrl); // paging.next already includes token
        collected.push(...(res.data?.data || []));
        nextUrl = res.data?.paging?.next || null;
        isFirstRequest = false;
      }
      return { reportRunId: rid, data: collected };
    };

    // ENG-511: If Meta rejects a whitelisted field (400 at submit OR at read),
    // don't surface a bare error the model will blindly re-issue until the
    // anti-loop guard hard-blocks the whole insights channel. Parse the offending
    // field(s) out of Meta's error, drop them, and retry the whole report exactly
    // ONCE with the valid remainder. If we cannot isolate the offender (or nothing
    // valid would remain), return a structured no-retry error so the model
    // corrects rather than loops.
    let reportRunId: string;
    let allData: any[];
    // Meta names incompatible fields ONE AT A TIME, so a single retry only clears
    // one bad field. Loop: drop the field(s) Meta names, retry with the remainder,
    // and repeat until the report succeeds or nothing valid is left. Each pass
    // removes >=1 field, so validFields strictly shrinks — the loop is bounded by
    // the field count (maxHealAttempts is a belt-and-suspenders cap).
    const maxHealAttempts = validFields.length + 1;
    let healAttempts = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const run = await runReport(validFields);
        reportRunId = run.reportRunId;
        allData = run.data;
        break;
      } catch (reportErr: any) {
        const metaError = reportErr?.response?.data?.error;
        const status = reportErr?.response?.status;
        const haystack = `${metaError?.message || ""} ${metaError?.error_user_msg || ""} ${metaError?.error_user_title || ""}`;
        const isFieldError = status === 400 && /field/i.test(haystack);

        // Word-boundary match so a rejected field is not confused with a longer
        // sibling that contains it (e.g. `ctr` inside `inline_link_click_ctr`).
        const metaRejectedFields = isFieldError
          ? validFields.filter((f) => new RegExp(`\\b${f}\\b`).test(haystack))
          : [];
        const retryFields = validFields.filter(
          (f) => !metaRejectedFields.includes(f)
        );

        if (
          isFieldError &&
          metaRejectedFields.length &&
          retryFields.length &&
          healAttempts < maxHealAttempts
        ) {
          // Drop the Meta-rejected field(s) and retry with the valid subset.
          healAttempts++;
          droppedFields.push(...metaRejectedFields);
          validFields = retryFields;
          filteredParams.fields = validFields.join(",");
          continue;
        }

        if (!isFieldError) {
          throw reportErr;
        }

        // Field error we cannot recover from (offender unisolable, nothing valid
        // remains, or cap hit): return a structured no-retry error so the model
        // corrects rather than loops.
        const suggestions = suggestInsightsFields(metaRejectedFields);
        const suggestionHint = Object.keys(suggestions).length
          ? ` Did you mean: ${Object.entries(suggestions)
              .map(([bad, good]) => `${bad} -> ${good}`)
              .join(", ")}?`
          : "";
        return {
          success: false,
          error: `Meta rejected the requested insights field(s)${metaRejectedFields.length ? `: ${metaRejectedFields.join(", ")}` : ""}. Do not retry the same request — remove or replace the offending field(s).${suggestionHint} Choose from allowed fields such as impressions, clicks, spend, cpc, ctr, reach, inline_link_clicks, cost_per_inline_link_click.`,
          metadata: {
            tool: "call_meta_ads_insights_api",
            account_id,
            meta_error: metaError?.message || reportErr?.message,
            ...(Object.keys(suggestions).length && {
              field_suggestions: suggestions,
            }),
          },
        };
      }
    }

    const envelope = {
      metadata: {
        requested_at: new Date().toISOString(),
        tool: "call_meta_ads_insights_api",
        object_type,
        object_id: object_id || null,
        account_id,
        query: filteredParams,
        report_run_id: reportRunId,
        api_version: version,
        // ENG-511: surface any unsupported fields we dropped so the model knows
        // why they are absent and does not re-request them on the next turn, plus
        // a closest-valid-field suggestion for each so a typo/loose phrasing is
        // actionable (e.g. `impression` -> `impressions`) rather than silently gone.
        ...(droppedFields.length && { dropped_fields: droppedFields }),
        ...(droppedFields.length &&
          Object.keys(suggestInsightsFields(droppedFields)).length && {
            dropped_field_suggestions: suggestInsightsFields(droppedFields),
          }),
      },
      data: allData,
    };

    // Return the insights data inline rather than uploading to S3 ourselves.
    // The agent-mode tool pipeline already offloads any oversized tool response
    // to S3 under a readable `tool-responses/<sessionId>` key (retrievable via
    // read_tool_response / search_tool_response) and keeps small responses inline.
    // Doing our own upload produced an unreadable `s3_url` (no s3_key, wrong
    // content path), which broke every file-reading tool and the daily digest.
    return {
      success: true,
      totalRows: allData.length,
      metadata: envelope.metadata,
      data: allData,
    };

  } catch (error: any) {
    if (error.isMetaAuthError) throw error;
    console.error("Error in callMetaAdsInsightsApiWrapper:", error);
    // An axios rejection stringifies to "Request failed with status code 400",
    // which tells the model nothing it can act on and reads as an opaque
    // outage. Meta's actual explanation lives in response.data.error — surface
    // it, minus the credential material Meta echoes back (ENG-630).
    // ENG-1300: the real HTTP status is `error.response?.status` (axios shape) —
    // NEVER the Meta business `.code` nested in response.data.error, which
    // coincidentally overlaps the HTTP range (e.g. Meta code 404 is unrelated
    // to HTTP 404).
    return {
      success: false,
      error: describeMetaGraphApiError(error) || error.message,
      code: error?.status ?? error?.response?.status,
    };
  }
}

// ============================================================================
// 2. listMetaAdsCampaignsNew (+ exclusive helper normalizeMetaAdsReadError)
// ============================================================================

/**
 * Turn Meta's authoritative "you never granted ads permission" refusal into the
 * single actionable re-consent error, and record what we just learned.
 *
 * Two jobs, both required by ENG-629:
 *  - Throw (not return a soft `{ success:false }`). The soft shape is what let
 *    an unattended run render an empty report as though metrics came back.
 *  - Persist the now-known grant so the next read fails at the pre-flight gate
 *    instead of hitting Meta again with the same impossible request. The write
 *    is best-effort: a persistence failure must never mask the user-facing error.
 *
 * Returns normally when the error is NOT a scope problem, so callers keep their
 * existing handling for rate limits, validation errors (ENG-630), etc.
 */
async function normalizeMetaAdsReadError(
  error: any,
  userId: string,
  connection?: { platform?: string; account_id?: string; config?: any }
): Promise<void> {
  const {
    isMetaAdsScopeRefusal,
    buildMetaAdsScopeError,
    META_ADS_READ_SCOPES,
  } = await import('../../utils/metaAdsScope');

  // Strictly an Ads-scope refusal. A generic permission error must fall
  // through untouched — narrowing a grant on that evidence would brick a
  // connection that actually has ads access (Greptile P1-2).
  if (!isMetaAdsScopeRefusal(error)) return;

  if (connection?.account_id && connection?.platform) {
    try {
      // Which of the two independent grants is actually missing (ENG-1158
      // follow-up)? Without this, the re-consent message tells an owner who
      // already granted the app scope to reconnect and re-approve a
      // permission they already have — for a gap that lives on the ad
      // account, not the OAuth connection, which reconnecting cannot touch.
      const tier = await metaService.classifyAdsRefusalTier(connection.config?.access_token);
      const revokedAt = new Date().toISOString();

      // Function form (Greptile P1 on the sibling call in metaAdsCapabilitySync):
      // `retained` must come from the config a CAS retry actually just read, not
      // from `connection.config` captured before this call — otherwise a retry
      // after a concurrent recovery would re-narrow a grant that had just come
      // back. `tier` and `revokedAt` stay fixed: both are fresh judgments made
      // once (a live Meta call, this call's own timestamp), not derived from
      // local state that can go stale.
      // The probedAt guard (Greptile P1 follow-up, mirrors the sibling in
      // metaAdsCapabilitySync.ts): this single read failure is weaker
      // evidence than the sweep's two-strike confirmation, so if the sweep
      // already recorded a NEWER probe (e.g. a recovery landing moments
      // after this failure), that signal wins — do nothing rather than
      // revoke over a connection just confirmed healthy.
      const { updateAccountConfig } = await import('../../services/connectedAccountsDb');
      await updateAccountConfig(userId, connection.platform as any, connection.account_id, freshConfig => {
        const storedProbedAt = freshConfig.ads_capability_probed_at;
        if (typeof storedProbedAt === 'string' && storedProbedAt > revokedAt) {
          return { updates: {}, unset: [] };
        }

        const freshPrevious: unknown = freshConfig.granted_scopes;
        const freshRetained = (Array.isArray(freshPrevious) ? freshPrevious : [])
          .filter((s: unknown) => typeof s === 'string')
          .filter((s: string) => !(META_ADS_READ_SCOPES as readonly string[]).includes(s.trim()));
        return {
          // Meta just told us authoritatively that no ads scope is granted.
          // Recording it converts every subsequent attempt into a pre-flight refusal.
          updates: {
            granted_scopes: freshRetained,
            ads_scope_revoked_at: revokedAt,
            ads_capability_probed_at: revokedAt,
            ...(tier !== 'unknown' ? { ads_scope_tier: tier } : {}),
          },
          unset: tier === 'unknown' ? ['ads_scope_tier'] : undefined,
        };
      });
    } catch (persistError: any) {
      console.warn(
        `[AgentMode] ENG-629: could not persist missing Meta ads scope for user ${userId}: ${persistError?.message ?? persistError}`
      );
    }

    // Deliberately does NOT notify the owner. The 12-hourly capability sweep
    // is the single notifier (ENG-1158): it probes every Meta ad account and
    // alerts on exactly the accounts this path records, so notifying here too
    // would only buy latency — at the price of two processes racing to email
    // the same owner for one episode, which no in-process guard can dedupe.
    // One sender, one process, no cross-process coordination to get wrong.
  }

  throw buildMetaAdsScopeError({
    accountLabel: connection?.account_id ? `act_${String(connection.account_id).replace('act_', '')}` : undefined,
    cause: error,
  });
}

export async function listMetaAdsCampaignsNew(
  userId: string,
  account_id: string | undefined,
  options: { campaignId?: string; fields?: string | string[] } = {},
  clientScope: { clientId?: string; callerIsAdmin?: boolean; toolName: string } | undefined,
  deps: { getMetaCredentials: MetaCredentialsResolver; retryBackoffMs?: number }
): Promise<any> {
  let connection: any;
  try {
    const credentials = await deps.getMetaCredentials(userId, account_id, clientScope);
    const { accountId, accessToken } = credentials;
    connection = (credentials as any).connection;
    // Only forward the read-options bag when the caller supplied a campaign_id filter or
    // an explicit fields selection; otherwise call listCampaigns the same 2-arg way as
    // before. This preserves the CALL CONVENTION for a plain list-all — it does NOT keep
    // the response payload identical: listCampaigns now defaults to the richer
    // CAMPAIGN_READ_FIELDS (budget/bid config: daily_budget, lifetime_budget,
    // budget_remaining, bid_strategy), the intended ENG-398 change, for every plain LIST
    // caller regardless of this branch.
    const hasSelector = Boolean(options.campaignId || options.fields);
    // ENG-1890: a read is safe to retry — transient Graph failures get a bounded retry.
    const backoffMs = deps.retryBackoffMs ?? LIST_CAMPAIGNS_RETRY_BACKOFF_MS;
    let result: any;
    for (let attempt = 1; ; attempt++) {
      try {
        result = hasSelector
          ? await metaService.listCampaigns(accountId, accessToken, options)
          : await metaService.listCampaigns(accountId, accessToken);
        break;
      } catch (readError: any) {
        if (attempt >= LIST_CAMPAIGNS_MAX_ATTEMPTS || classifyMetaReadFailure(readError).kind !== 'transient') {
          throw readError;
        }
        if (backoffMs > 0) await new Promise(resolve => setTimeout(resolve, backoffMs * attempt));
      }
    }
    // ENG-1890: an unexpected response shape is a typed handler error, never a throw or
    // a silent "0 campaigns".
    if (!result || typeof result !== 'object' || !Array.isArray(result.campaigns)) {
      return {
        success: false,
        message: 'Meta returned an unexpected campaign-list response (no campaigns array). This is not an empty account; retry once, and report it if it persists.',
        error: 'unexpected_response_shape',
        errorClass: 'invalid_output',
        errorType: 'handler',
        details: { responseType: Array.isArray(result) ? 'array' : typeof result, keys: result && typeof result === 'object' ? Object.keys(result).slice(0, 10) : [] },
      };
    }
    const campaigns = result.campaigns;

    // ENG-1625 follow-up: this used to be `Found ${totalCount} campaign(s)` with no scope
    // or bound — the exact ENG-1476/ENG-1584 sentence shape. Assembled via buildListResult
    // so completeness metadata precedes the payload (S3 offload cut — see metaListScope.ts).
    return buildListResult({
      payloadKey: 'campaigns',
      payload: campaigns,
      message: buildListMessage({
        noun: 'campaign(s)',
        totalCount: campaigns.length,
        truncated: result?.truncated,
        // Campaign LIST has no parent scope to name (it either lists the whole account or
        // fetches one campaign by id, never "campaigns scoped to X").
        campaignScopable: false,
      }),
      truncated: result?.truncated,
    });
  } catch (error: any) {
    // ENG-1890: thrown auth errors carry their class so telemetry records `auth`, not `Error`.
    const stampAuth = (e: any) => {
      if (e && typeof e === 'object' && !e.toolErrorClass) e.toolErrorClass = 'auth';
      return e;
    };
    if (error?.isMetaAuthError) throw stampAuth(error);
    // A permission refusal from Meta is not a "no campaigns" result — throw the
    // actionable re-consent error and record the grant we just learned (ENG-629).
    try {
      await normalizeMetaAdsReadError(error, connection?.userId || userId, connection);
    } catch (scopeError: any) {
      throw stampAuth(scopeError);
    }
    console.error('AgentMode: Error fetching Meta ad campaigns:', error?.message);
    const failure = classifyMetaReadFailure(error);
    const base = error?.message || 'Failed to fetch Meta ad campaigns.';
    return {
      success: false,
      message: failure.kind === 'credential'
        ? `${base}. ${failure.tokenInvalid ? META_RECONNECT_MESSAGE : META_PERMISSION_MESSAGE}`
        : failure.kind === 'transient'
          ? `${base}. Meta is temporarily unavailable or throttling (retried ${LIST_CAMPAIGNS_MAX_ATTEMPTS}x); try again shortly.`
          : base,
      error: error?.message,
      errorClass: failure.errorClass,
      errorType: failure.kind === 'credential' ? 'configuration' : failure.kind,
      details: error?.structuredError,
      // ENG-1300: SDK-shaped error — never structuredError.code (Meta business code).
      code: error?.status ?? error?.response?.status
    };
  }
}

const LIST_CAMPAIGNS_MAX_ATTEMPTS = 3;
const LIST_CAMPAIGNS_RETRY_BACKOFF_MS = 1000;

// ============================================================================
// 3. getMetaAdsMetrics (+ exclusive helpers)
// ============================================================================

// Helper function to process campaign data from Meta API
function processCampaignData(campaigns: any[], insights: any[], adSets: any[]): any[] {
  const campaignMap = new Map();

  // Create ad set to campaign mapping
  const adSetToCampaignMap = new Map();
  for (const adSet of adSets) {
    adSetToCampaignMap.set(adSet.id, adSet.campaign_id);
  }

  // Initialize campaigns with zero metrics
  for (const campaign of campaigns) {
    campaignMap.set(campaign.id, {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      objective: campaign.objective,
      impressions: 0,
      clicks: 0,
      spend: 0,
      ctr: 0,
      cpc: 0,
      reach: 0,
      frequency: 0,
      websiteLeads: 0,
      costPerWebsiteLead: 0,
      formLeads: 0,
      costPerFormLead: 0,
      totalLeads: 0,
      costPerLead: 0,
      lastUpdated: new Date().toISOString(),
    });
  }

  // Process campaign-level insights directly
  for (const insight of insights) {
    const campaignId = insight.campaign_id;

    if (campaignMap.has(campaignId)) {
      const campaign = campaignMap.get(campaignId);

      // Use campaign-level metrics directly
      campaign.impressions = parseInt(insight.impressions) || 0;
      campaign.clicks = parseInt(insight.clicks) || 0;
      campaign.spend = parseFloat(insight.spend) || 0;
      campaign.reach = parseInt(insight.reach) || 0;

      // Process lead generation metrics from actions and cost_per_action_type
      applyLeadMetrics(campaign, insight);
    }
  }

  // Calculate derived metrics (CTR, CPC, Cost per Lead) after aggregation
  for (const campaign of campaignMap.values()) {
    if (campaign.impressions > 0) {
      campaign.ctr = (campaign.clicks / campaign.impressions) * 100; // Convert to percentage
    }
    if (campaign.clicks > 0) {
      campaign.cpc = campaign.spend / campaign.clicks;
    }
    if (campaign.reach > 0) {
      campaign.frequency = campaign.impressions / campaign.reach;
    }

    // ENG-1575: the buckets are disjoint now (see applyLeadMetrics), so website leads no
    // longer need to suppress form leads. That suppression is what reported every Instant
    // Form lead as a website lead on any account that also had website conversions.
    finalizeLeadCosts(campaign);
  }

  // Return all campaigns regardless of activity
  return Array.from(campaignMap.values());
}

// Helper function to process ad sets data
function processAdSetsData(adSets: any[], insights: any[], campaigns: any[]): any[] {
  const adSetMap = new Map();
  const campaignMap = new Map();

  // Create campaign mapping
  for (const campaign of campaigns) {
    campaignMap.set(campaign.id, campaign);
  }

  // Initialize ad sets with zero metrics
  for (const adSet of adSets) {
    const campaign = campaignMap.get(adSet.campaign_id);
    adSetMap.set(adSet.id, {
      id: adSet.id,
      name: adSet.name,
      status: adSet.status,
      campaignId: adSet.campaign_id,
      campaignName: campaign ? campaign.name : 'Unknown Campaign',
      impressions: 0,
      clicks: 0,
      spend: 0,
      ctr: 0,
      cpc: 0,
      reach: 0,
      frequency: 0,
      websiteLeads: 0,
      costPerWebsiteLead: 0,
      formLeads: 0,
      costPerFormLead: 0,
      totalLeads: 0,
      costPerLead: 0,
      lastUpdated: new Date().toISOString(),
    });
  }

  // Process adset-level insights directly
  for (const insight of insights) {
    const adSetId = insight.adset_id;
    if (adSetMap.has(adSetId)) {
      const adSet = adSetMap.get(adSetId);
      adSet.impressions = parseInt(insight.impressions) || 0;
      adSet.clicks = parseInt(insight.clicks) || 0;
      adSet.spend = parseFloat(insight.spend) || 0;
      adSet.reach = parseInt(insight.reach) || 0;

      // Process lead generation metrics from actions and cost_per_action_type
      applyLeadMetrics(adSet, insight);
    }
  }

  // Calculate derived metrics
  for (const adSet of adSetMap.values()) {
    if (adSet.impressions > 0) {
      adSet.ctr = (adSet.clicks / adSet.impressions) * 100;
    }
    if (adSet.clicks > 0) {
      adSet.cpc = adSet.spend / adSet.clicks;
    }
    if (adSet.reach > 0) {
      adSet.frequency = adSet.impressions / adSet.reach;
    }

    // ENG-1575: the buckets are disjoint now (see applyLeadMetrics), so website leads no
    // longer need to suppress form leads. That suppression is what reported every Instant
    // Form lead as a website lead on any account that also had website conversions.
    finalizeLeadCosts(adSet);
  }

  // Return all ad sets regardless of activity
  return Array.from(adSetMap.values());
}

// Helper function to process ads data
function processAdsData(ads: any[], insights: any[], adSets: any[], campaigns: any[]): any[] {
  const adMap = new Map();
  const adSetMap = new Map();
  const campaignMap = new Map();

  // Create mappings
  for (const adSet of adSets) {
    adSetMap.set(adSet.id, adSet);
  }
  for (const campaign of campaigns) {
    campaignMap.set(campaign.id, campaign);
  }

  // Initialize ads with zero metrics
  for (const ad of ads) {
    const adSet = adSetMap.get(ad.adset_id);
    const campaign = campaignMap.get(ad.campaign_id);

    adMap.set(ad.id, {
      id: ad.id,
      name: ad.name,
      status: ad.status,
      adSetId: ad.adset_id,
      adSetName: adSet ? adSet.name : 'Unknown Ad Set',
      campaignId: ad.campaign_id,
      campaignName: campaign ? campaign.name : 'Unknown Campaign',
      creative: ad.creative,
      impressions: 0,
      clicks: 0,
      spend: 0,
      ctr: 0,
      cpc: 0,
      reach: 0,
      frequency: 0,
      websiteLeads: 0,
      costPerWebsiteLead: 0,
      formLeads: 0,
      costPerFormLead: 0,
      totalLeads: 0,
      costPerLead: 0,
      lastUpdated: new Date().toISOString(),
    });
  }

  // Aggregate insights data by ad
  for (const insight of insights) {
    const adId = insight.ad_id;
    if (adMap.has(adId)) {
      const ad = adMap.get(adId);
      ad.impressions += parseInt(insight.impressions) || 0;
      ad.clicks += parseInt(insight.clicks) || 0;
      ad.spend += parseFloat(insight.spend) || 0;
      ad.reach += parseInt(insight.reach) || 0;

      // Process lead generation metrics from actions and cost_per_action_type
      applyLeadMetrics(ad, insight);
    }
  }

  // Calculate derived metrics
  for (const ad of adMap.values()) {
    if (ad.impressions > 0) {
      ad.ctr = (ad.clicks / ad.impressions) * 100;
    }
    if (ad.clicks > 0) {
      ad.cpc = ad.spend / ad.clicks;
    }
    if (ad.reach > 0) {
      ad.frequency = ad.impressions / ad.reach;
    }

    // ENG-1575: the buckets are disjoint now (see applyLeadMetrics), so website leads no
    // longer need to suppress form leads. That suppression is what reported every Instant
    // Form lead as a website lead on any account that also had website conversions.
    finalizeLeadCosts(ad);
  }

  // Return all ads regardless of activity
  return Array.from(adMap.values());
}

// Helper function to generate campaign summary
function generateCampaignSummary(adPerformance: any[]): any {
  const totalCampaigns = adPerformance.length;
  const activeCampaigns = adPerformance.filter(campaign => campaign.status === 'ACTIVE').length;

  const totalSpend = adPerformance.reduce((sum, campaign) => sum + campaign.spend, 0);
  const totalImpressions = adPerformance.reduce((sum, campaign) => sum + campaign.impressions, 0);
  const totalClicks = adPerformance.reduce((sum, campaign) => sum + campaign.clicks, 0);
  const totalWebsiteLeads = adPerformance.reduce((sum, campaign) => sum + (campaign.websiteLeads || 0), 0);
  const totalFormLeads = adPerformance.reduce((sum, campaign) => sum + (campaign.formLeads || 0), 0);
  const totalLeads = totalWebsiteLeads + totalFormLeads;

  const averageCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  const averageCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
  const averageCostPerWebsiteLead = totalWebsiteLeads > 0 ? totalSpend / totalWebsiteLeads : 0;
  const averageCostPerFormLead = totalFormLeads > 0 ? totalSpend / totalFormLeads : 0;
  const averageCostPerLead = totalLeads > 0 ? totalSpend / totalLeads : 0;

  return {
    totalCampaigns,
    activeCampaigns,
    totalSpend,
    totalImpressions,
    totalClicks,
    totalWebsiteLeads,
    totalFormLeads,
    totalLeads,
    averageCtr,
    averageCpc,
    averageCostPerWebsiteLead,
    averageCostPerFormLead,
    averageCostPerLead
  };
}

// Helper function to process breakdown data with lead generation metrics
function processBreakdownData(breakdownData: any[]): any[] {
  return breakdownData.map(item => {
    const processedItem = {
      ...item,
      websiteLeads: 0,
      costPerWebsiteLead: 0,
      formLeads: 0,
      costPerFormLead: 0,
      totalLeads: 0,
      costPerLead: 0
    };

    // Process lead generation metrics from actions and cost_per_action_type
    applyLeadMetrics(processedItem, item);

    // ENG-1575: buckets are disjoint (see applyLeadMetrics) — no suppression needed.

    // Calculate totals
    processedItem.totalLeads = (processedItem.websiteLeads || 0) + (processedItem.formLeads || 0);
    if (processedItem.totalLeads > 0) {
      processedItem.costPerLead = (processedItem.spend || 0) / processedItem.totalLeads;
    }

    // Calculate cost per lead if we have leads but no cost_per_action_type data
    if (processedItem.websiteLeads > 0 && processedItem.costPerWebsiteLead === 0 && item.spend) {
      processedItem.costPerWebsiteLead = parseFloat(item.spend) / processedItem.websiteLeads;
    }

    return processedItem;
  });
}

// Helper function to format metrics summary for AI analysis
export async function formatMetricsSummary(data: any, userId: string): Promise<string> {
  const { adPerformance, adSetsData, adsData, campaignSummary, demographicsBreakdown, placementBreakdown, deviceBreakdown, attributionWindow } = data;

  try {
    const { uploadFileToS3 } = await import('../../utils/s3Utils');
    const fileUrls: { url: string; name: string }[] = [];

    // Create date range string for filenames
    const startDate = attributionWindow?.start || 'unknown';
    const endDate = attributionWindow?.end || 'unknown';
    const dateRange = `${startDate}_${endDate}`;

    // Helper function to convert array to CSV
    const arrayToCSV = (headers: string[], rows: string[][]): string => {
      const csvRows = [headers.join(',')];
      rows.forEach(row => {
        csvRows.push(row.map(cell => {
          // Escape quotes and wrap in quotes if contains comma or quote
          const cellStr = String(cell);
          if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
            return `"${cellStr.replace(/"/g, '""')}"`;
          }
          return cellStr;
        }).join(','));
      });
      return csvRows.join('\n');
    };

    // 1. Ad-Level Data CSV
    if (adsData && adsData.length > 0) {
      const adRows = adsData.map((ad: any) => [
        ad.name,
        ad.adSetName,
        ad.campaignName,
        String(ad.impressions),
        String(ad.clicks),
        `$${ad.spend.toFixed(2)}`,
        `${ad.ctr.toFixed(2)}%`,
        `$${ad.cpc.toFixed(2)}`,
        String(ad.websiteLeads || 0),
        String(ad.formLeads || 0),
        String(ad.totalLeads || 0),
        `$${(ad.costPerLead || 0).toFixed(2)}`
      ]);

      const adCSV = arrayToCSV(
        ['Ad Name', 'Ad Set', 'Campaign', 'Impressions', 'Clicks', 'Spend', 'CTR', 'CPC', 'Website Leads', 'Form Leads', 'Total Leads', 'Cost/Lead'],
        adRows
      );
      const adResult = await uploadFileToS3(
        Buffer.from(adCSV, 'utf-8'),
        `meta-ads-ad-level-data-${dateRange}.csv`,
        userId,
        'text/csv'
      );
      if (adResult.success && adResult.url) {
        fileUrls.push({ url: adResult.url, name: 'Ad-Level Data (all individual ads)' });
      }
    }

    // 2. Demographics Breakdown CSV
    if (demographicsBreakdown && demographicsBreakdown.length > 0) {
      // Group by age and gender, then aggregate metrics
      const demographicsMap = new Map();
      demographicsBreakdown.forEach((item: any) => {
        const key = `${item.age || 'Unknown'}-${item.gender || 'Unknown'}`;
        if (!demographicsMap.has(key)) {
          demographicsMap.set(key, {
            age: item.age || 'Unknown',
            gender: item.gender || 'Unknown',
            impressions: 0,
            clicks: 0,
            spend: 0,
            websiteLeads: 0,
            formLeads: 0,
            totalLeads: 0
          });
        }
        const demo = demographicsMap.get(key);
        demo.impressions += parseInt(item.impressions) || 0;
        demo.clicks += parseInt(item.clicks) || 0;
        demo.spend += parseFloat(item.spend) || 0;
        demo.websiteLeads += parseInt(item.websiteLeads) || 0;
        demo.formLeads += parseInt(item.formLeads) || 0;
        demo.totalLeads = demo.websiteLeads + demo.formLeads;
      });

      // Sort by spend descending
      const sortedDemographics = Array.from(demographicsMap.values())
        .sort((a, b) => b.spend - a.spend);

      const demoRows = sortedDemographics.map((demo: any) => {
        const ctr = demo.impressions > 0 ? (demo.clicks / demo.impressions) * 100 : 0;
        const cpc = demo.clicks > 0 ? demo.spend / demo.clicks : 0;
        const costPerLead = demo.totalLeads > 0 ? demo.spend / demo.totalLeads : 0;
        return [
          demo.age,
          demo.gender,
          String(demo.impressions),
          String(demo.clicks),
          `$${demo.spend.toFixed(2)}`,
          `${ctr.toFixed(2)}%`,
          `$${cpc.toFixed(2)}`,
          String(demo.websiteLeads),
          String(demo.formLeads),
          String(demo.totalLeads),
          `$${costPerLead.toFixed(2)}`
        ];
      });

      const demoCSV = arrayToCSV(
        ['Age', 'Gender', 'Impressions', 'Clicks', 'Spend', 'CTR', 'CPC', 'Website Leads', 'Form Leads', 'Total Leads', 'Cost/Lead'],
        demoRows
      );
      const demoResult = await uploadFileToS3(
        Buffer.from(demoCSV, 'utf-8'),
        `meta-ads-demographics-breakdown-${dateRange}.csv`,
        userId,
        'text/csv'
      );
      if (demoResult.success && demoResult.url) {
        fileUrls.push({ url: demoResult.url, name: 'Demographics Breakdown' });
      }
    }

    // 3. Placement Breakdown CSV
    if (placementBreakdown && placementBreakdown.length > 0) {
      // Group by platform and position, then aggregate metrics
      const placementMap = new Map();
      placementBreakdown.forEach((item: any) => {
        const key = `${item.publisher_platform || 'Unknown'}-${item.platform_position || 'Unknown'}`;
        if (!placementMap.has(key)) {
          placementMap.set(key, {
            platform: item.publisher_platform || 'Unknown',
            position: item.platform_position || 'Unknown',
            impressions: 0,
            clicks: 0,
            spend: 0,
            websiteLeads: 0,
            formLeads: 0,
            totalLeads: 0
          });
        }
        const placement = placementMap.get(key);
        placement.impressions += parseInt(item.impressions) || 0;
        placement.clicks += parseInt(item.clicks) || 0;
        placement.spend += parseFloat(item.spend) || 0;
        placement.websiteLeads += parseInt(item.websiteLeads) || 0;
        placement.formLeads += parseInt(item.formLeads) || 0;
        placement.totalLeads = placement.websiteLeads + placement.formLeads;
      });

      // Sort by spend descending
      const sortedPlacements = Array.from(placementMap.values())
        .sort((a, b) => b.spend - a.spend);

      const placementRows = sortedPlacements.map((placement: any) => {
        const ctr = placement.impressions > 0 ? (placement.clicks / placement.impressions) * 100 : 0;
        const cpc = placement.clicks > 0 ? placement.spend / placement.clicks : 0;
        const costPerLead = placement.totalLeads > 0 ? placement.spend / placement.totalLeads : 0;
        return [
          placement.platform,
          placement.position,
          String(placement.impressions),
          String(placement.clicks),
          `$${placement.spend.toFixed(2)}`,
          `${ctr.toFixed(2)}%`,
          `$${cpc.toFixed(2)}`,
          String(placement.websiteLeads),
          String(placement.formLeads),
          String(placement.totalLeads),
          `$${costPerLead.toFixed(2)}`
        ];
      });

      const placementCSV = arrayToCSV(
        ['Platform', 'Position', 'Impressions', 'Clicks', 'Spend', 'CTR', 'CPC', 'Website Leads', 'Form Leads', 'Total Leads', 'Cost/Lead'],
        placementRows
      );
      const placementResult = await uploadFileToS3(
        Buffer.from(placementCSV, 'utf-8'),
        `meta-ads-placement-breakdown-${dateRange}.csv`,
        userId,
        'text/csv'
      );
      if (placementResult.success && placementResult.url) {
        fileUrls.push({ url: placementResult.url, name: 'Placement Breakdown' });
      }
    }

    // 4. Device Breakdown CSV
    if (deviceBreakdown && deviceBreakdown.length > 0) {
      // Group by device, then aggregate metrics
      const deviceMap = new Map();
      deviceBreakdown.forEach((item: any) => {
        const device = item.impression_device || 'Unknown';
        if (!deviceMap.has(device)) {
          deviceMap.set(device, {
            device,
            impressions: 0,
            clicks: 0,
            spend: 0,
            websiteLeads: 0,
            formLeads: 0,
            totalLeads: 0
          });
        }
        const deviceData = deviceMap.get(device);
        deviceData.impressions += parseInt(item.impressions) || 0;
        deviceData.clicks += parseInt(item.clicks) || 0;
        deviceData.spend += parseFloat(item.spend) || 0;
        deviceData.websiteLeads += parseInt(item.websiteLeads) || 0;
        deviceData.formLeads += parseInt(item.formLeads) || 0;
        deviceData.totalLeads = deviceData.websiteLeads + deviceData.formLeads;
      });

      // Sort by spend descending
      const sortedDevices = Array.from(deviceMap.values())
        .sort((a, b) => b.spend - a.spend);

      const deviceRows = sortedDevices.map((device: any) => {
        const ctr = device.impressions > 0 ? (device.clicks / device.impressions) * 100 : 0;
        const cpc = device.clicks > 0 ? device.spend / device.clicks : 0;
        const costPerLead = device.totalLeads > 0 ? device.spend / device.totalLeads : 0;
        return [
          device.device,
          String(device.impressions),
          String(device.clicks),
          `$${device.spend.toFixed(2)}`,
          `${ctr.toFixed(2)}%`,
          `$${cpc.toFixed(2)}`,
          String(device.websiteLeads),
          String(device.formLeads),
          String(device.totalLeads),
          `$${costPerLead.toFixed(2)}`
        ];
      });

      const deviceCSV = arrayToCSV(
        ['Device', 'Impressions', 'Clicks', 'Spend', 'CTR', 'CPC', 'Website Leads', 'Form Leads', 'Total Leads', 'Cost/Lead'],
        deviceRows
      );
      const deviceResult = await uploadFileToS3(
        Buffer.from(deviceCSV, 'utf-8'),
        `meta-ads-device-breakdown-${dateRange}.csv`,
        userId,
        'text/csv'
      );
      if (deviceResult.success && deviceResult.url) {
        fileUrls.push({ url: deviceResult.url, name: 'Device Breakdown' });
      }
    }

    // Build summary with campaign and ad set data, plus file URLs
    let summary = `📊 **Meta Ads Performance Data**\n\n`;

    // Attribution Window
    if (attributionWindow && attributionWindow.start && attributionWindow.end) {
      summary += `**Attribution Window:** ${attributionWindow.start} to ${attributionWindow.end} (${attributionWindow.days} days)\n\n`;
    }

    // Campaign Summary
    if (campaignSummary) {
      summary += `**📈 Campaign Summary**\n\n`;
      summary += `| Metric | Value |\n`;
      summary += `|--------|-------|\n`;
      summary += `| Total Campaigns | ${campaignSummary.totalCampaigns} |\n`;
      summary += `| Total Spend | $${campaignSummary.totalSpend.toFixed(2)} |\n`;
      summary += `| Impressions | ${campaignSummary.totalImpressions.toLocaleString()} |\n`;
      summary += `| Clicks | ${campaignSummary.totalClicks.toLocaleString()} |\n`;
      summary += `| CTR | ${campaignSummary.averageCtr.toFixed(2)}% |\n`;
      summary += `| CPC | $${campaignSummary.averageCpc.toFixed(2)} |\n`;
      summary += `| Website Leads | ${campaignSummary.totalWebsiteLeads.toLocaleString()} |\n`;
      summary += `| Form Submissions | ${campaignSummary.totalFormLeads.toLocaleString()} |\n`;
      summary += `| Total Leads | ${campaignSummary.totalLeads.toLocaleString()} |\n`;
      summary += `| Cost per Website Lead | $${campaignSummary.averageCostPerWebsiteLead.toFixed(2)} |\n`;
      summary += `| Cost per Form Lead | $${campaignSummary.averageCostPerFormLead.toFixed(2)} |\n`;
      summary += `| Cost per Lead | $${campaignSummary.averageCostPerLead.toFixed(2)} |\n\n`;
    }

    // Campaign Performance (top 10 by spend)
    if (adPerformance && adPerformance.length > 0) {
      const topCampaigns = adPerformance.slice(0, 10);
      summary += `**🎯 Campaign Performance** (Top ${topCampaigns.length} by Spend)\n\n`;
      summary += `| Campaign Name | Spend | Impressions | Clicks | CTR | CPC | Website Leads | Form Leads | Total Leads | Cost/Lead |\n`;
      summary += `|---------------|-------|-------------|--------|-----|-----|---------------|------------|-------------|----------|\n`;

      topCampaigns.forEach((campaign: any) => {
        summary += `| ${campaign.name} | $${campaign.spend.toFixed(2)} | ${campaign.impressions.toLocaleString()} | ${campaign.clicks.toLocaleString()} | ${campaign.ctr.toFixed(2)}% | $${campaign.cpc.toFixed(2)} | ${(campaign.websiteLeads || 0).toLocaleString()} | ${(campaign.formLeads || 0).toLocaleString()} | ${(campaign.totalLeads || 0).toLocaleString()} | $${(campaign.costPerLead || 0).toFixed(2)} |\n`;
      });
      summary += `\n`;
    }

    // Ad Sets Performance (top 10 by spend)
    if (adSetsData && adSetsData.length > 0) {
      const topAdSets = adSetsData.slice(0, 10);
      summary += `**📦 Ad Sets Performance** (Top ${topAdSets.length} by Spend)\n\n`;
      summary += `| Ad Set Name | Campaign | Spend | Impressions | Clicks | CTR | CPC | Website Leads | Form Leads | Total Leads | Cost/Lead |\n`;
      summary += `|-------------|----------|-------|-------------|--------|-----|-----|---------------|------------|-------------|----------|\n`;

      topAdSets.forEach((adSet: any) => {
        summary += `| ${adSet.name} | ${adSet.campaignName} | $${adSet.spend.toFixed(2)} | ${adSet.impressions.toLocaleString()} | ${adSet.clicks.toLocaleString()} | ${adSet.ctr.toFixed(2)}% | $${adSet.cpc.toFixed(2)} | ${(adSet.websiteLeads || 0).toLocaleString()} | ${(adSet.formLeads || 0).toLocaleString()} | ${(adSet.totalLeads || 0).toLocaleString()} | $${(adSet.costPerLead || 0).toFixed(2)} |\n`;
      });
      summary += `\n`;
    }

    // CSV Files Section
    if (fileUrls.length > 0) {
      summary += `**📥 Detailed Data Files**\n\n`;
      summary += `The following CSV files contain detailed ad-level and breakdown data:\n\n`;

      fileUrls.forEach((file, index) => {
        summary += `${index + 1}. **${file.name}**\n   📥 [Download CSV](${file.url})\n\n`;
      });
    }

    summary += `*Data includes ${adPerformance?.length || 0} campaigns, ${adSetsData?.length || 0} ad sets, and ${adsData?.length || 0} individual ads.*\n`;
    summary += `*Note: Breakdown data (demographics, placement, device) only includes spend from ads with sufficient data for those breakdowns. Breakdown totals may not match campaign totals due to this limitation.*\n`;

    return summary;
  } catch (error) {
    console.error('Error generating CSV files for Meta ads metrics:', error);
    // Fallback to text summary if CSV generation fails
    return `📊 **Meta Ads Performance Data**\n\nError generating CSV files: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`;
  }
}

export async function getMetaAdsMetrics(
  timeframe: string,
  userId: string,
  campaign_ids: string[] | string,
  requestedAccountId: string | undefined,
  clientScope: { clientId?: string; callerIsAdmin?: boolean; toolName: string } | undefined,
  deps: GetMetaAdsMetricsDeps,
): Promise<any> {
  try {
    const campaignFilterIds = normalizeMetaCampaignIds(campaign_ids);
    console.log('AgentMode: Filtering metrics by campaign IDs:', campaignFilterIds);
    if (campaignFilterIds.length === 0) {
      return {
        success: false,
        message: 'campaign_ids is required and must contain at least one campaign ID.',
        error: 'Invalid campaign_ids'
      };
    }

    const { fetchWithRetryAndPaging } = await import('../../utils/metaApiFetch');

    // Use the same account resolver as the raw Insights tool. This keeps
    // connected-account, org-shared, and legacy account selection consistent.
    let accountId: string;
    let accessToken: string;
    try {
      ({ accountId, accessToken } = await deps.getMetaCredentials(userId, requestedAccountId, clientScope));
    } catch (error: any) {
      const credentialFailure =
        error?.isMetaAuthError ||
        /meta.*(?:access token|secret)|(?:access token|secret).*meta/i.test(error?.message || '');
      if (!credentialFailure) throw error;
      return {
        success: false,
        message: error.message,
        error: error.message,
        errorType: 'connection'
      };
    }

    const apiVersion = process.env.META_API_VERSION || 'v25.0';

    // Calculate date range based on timeframe
    // Exclude today since it's not fully complete - use yesterday as end date
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 1); // Set to yesterday
    const startDate = new Date(endDate); // Copy endDate
    if (timeframe === "7d") {
      startDate.setDate(endDate.getDate() - 6); // 7 days total (yesterday - 6 = 7 days)
    } else if (timeframe === "14d") {
      startDate.setDate(endDate.getDate() - 13); // 14 days total
    } else if (timeframe === "30d") {
      startDate.setDate(endDate.getDate() - 29); // 30 days total
    } else if (timeframe === "90d") {
      startDate.setDate(endDate.getDate() - 89); // 90 days total
    }
    const sinceStr = startDate.toISOString().split('T')[0];
    const untilStr = endDate.toISOString().split('T')[0];
    const attributionDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))) + 1; // +1 to include both start and end dates

    // Build filtering parameter for API calls
    const filteringParam = campaignFilterIds.length > 0
      ? `&filtering=${encodeURIComponent(JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campaignFilterIds }]))}`
      : '';


    // Get campaigns, ad sets, ads, and insights using Graph API - fetch at multiple levels
    // Using fetchWithRetryAndPaging to automatically handle pagination if there are multiple pages
    const [campaignsData, adSetsData, adsData, adInsightsData, adSetInsightsData, campaignInsightsData, insightsDemographicsData, insightsPlacementData, insightsDeviceData] = await Promise.all([
      fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${accountId}/campaigns?fields=id,name,status,objective${filteringParam}&access_token=${accessToken}`),
      fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${accountId}/adsets?fields=id,name,status,campaign_id,targeting${filteringParam}&access_token=${accessToken}`),
      // ENG-1742 follow-up: unencoded `{...}` in a nested field selector is silently
      // mangled by Graph — on this `ads` edge it doesn't hard-error, it just drops the
      // `creative` field from every result with no indication anything is missing.
      // Confirmed live 2026-09-04: this exact string returned every ad with `creative`
      // entirely absent; the encoded form returns real thumbnail_url/title/body/image_url.
      fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${accountId}/ads?fields=id,name,status,adset_id,campaign_id,${encodeURIComponent('creative{thumbnail_url,title,body,image_url}')}${filteringParam}&access_token=${accessToken}`),
      // Ad-level insights for ads processing
      fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${accountId}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,adset_id,ad_id,actions,cost_per_action_type&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=ad${filteringParam}&access_token=${accessToken}`),
      // Adset-level insights for ad sets processing
      fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${accountId}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,adset_id,actions,cost_per_action_type&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=adset${filteringParam}&access_token=${accessToken}`),
      // Campaign-level insights for campaigns processing
      fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${accountId}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,actions,cost_per_action_type&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=campaign${filteringParam}&access_token=${accessToken}`),
      // Demographics breakdown (age/gender)
      fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${accountId}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,actions,cost_per_action_type,campaign_id&breakdowns=age,gender&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=campaign${filteringParam}&access_token=${accessToken}`),
      // Placement breakdown (publisher platform and position)
      fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${accountId}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,actions,cost_per_action_type,campaign_id&breakdowns=publisher_platform,platform_position&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=campaign${filteringParam}&access_token=${accessToken}`),
      // Device breakdown (mobile/desktop, etc.)
      fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${accountId}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,actions,cost_per_action_type,campaign_id&breakdowns=impression_device&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=campaign${filteringParam}&access_token=${accessToken}`)
    ]);


    /*
     * ENG-1584 sibling: `fetchWithRetryAndPaging` is bounded (META_PAGING_MAX_PAGES) and
     * these URLs set no `limit`, so an account past the default page-size bound got a
     * dashboard silently missing rows with no signal at all — the helper already reports
     * `pagingTruncated` for exactly this (see the checked sibling in listMetaAdsCampaigns
     * above), it was just never read here across any of the 9 parallel fetches.
     */
    const truncatedSections = ([
      ['Campaigns', campaignsData],
      ['Ad Sets', adSetsData],
      ['Ads', adsData],
      ['Ad-level Insights', adInsightsData],
      ['Adset-level Insights', adSetInsightsData],
      ['Campaign-level Insights', campaignInsightsData],
      ['Demographics Breakdown', insightsDemographicsData],
      ['Placement Breakdown', insightsPlacementData],
      ['Device Breakdown', insightsDeviceData],
    ] as const)
      .filter(([, response]) => (response as any)?.pagingTruncated === true)
      .map(([section]) => section);

    // Keep connection lookup, permission, and query failures distinct so Emma
    // can prompt for the right remedy instead of always asking for reconnect.
    for (const [section, response] of [
      ['Campaigns', campaignsData],
      ['Ad Sets', adSetsData],
      ['Ads', adsData],
      ['Ad-level Insights', adInsightsData],
      ['Adset-level Insights', adSetInsightsData],
      ['Campaign-level Insights', campaignInsightsData],
    ] as const) {
      if (!response?.error) continue;
      console.error(`AgentMode: ${section} API Error:`, response.error);
      const message = response.error.message || 'Unknown Meta API error';
      const code = Number(response.error.code);
      const connectionFailure =
        code === 190 ||
        /access token|oauth|token.*(?:expired|invalid|revoked)/i.test(message);
      const permissionFailure =
        [10, 200].includes(code) ||
        /permission|not authorized/i.test(message);
      const typedError = new Error(`${section} API Error: ${message}`) as any;
      typedError.metaMetricsErrorType = connectionFailure
        ? 'connection'
        : (permissionFailure ? 'permission' : 'api');
      // ENG-1300: the real HTTP status, never `code` above (Meta's business code).
      typedError.status = (response as any)?.__httpStatus;
      throw typedError;
    }
    // ENG-104: breakdown endpoints are NON-fatal (we proceed without them), but
    // a missing/errored breakdown must be distinguishable from an empty-but-OK
    // one. Summarize the three raw responses into an explicit per-section status
    // and surface partial failures in ONE structured warning (telemetry-visible)
    // instead of three scattered console.errors.
    const breakdownStatus = summarizeBreakdownSections({
      demographics: insightsDemographicsData,
      placement: insightsPlacementData,
      device: insightsDeviceData,
    });
    if (breakdownStatus.partialFailure) {
      console.warn('AgentMode: get_meta_ads_metrics partial breakdown failure', {
        tool: 'get_meta_ads_metrics',
        unavailableSections: breakdownStatus.unavailableSections,
        sectionErrors: breakdownStatus.sectionErrors,
      });
    }

    // Process the data using simplified logic (filtering is now done at API level)
    const adPerformance = processCampaignData(campaignsData.data || [], campaignInsightsData.data || [], adSetsData.data || []);
    const processedAdSetsData = processAdSetsData(adSetsData.data || [], adSetInsightsData.data || [], campaignsData.data || []);
    const processedAdsData = processAdsData(adsData.data || [], adInsightsData.data || [], adSetsData.data || [], campaignsData.data || []);
    const campaignSummary = generateCampaignSummary(adPerformance);
    // Filter breakdown data by campaign if filtering is applied
    let demographicsBreakdown = insightsDemographicsData?.data || [];
    let placementBreakdown = insightsPlacementData?.data || [];
    let deviceBreakdown = insightsDeviceData?.data || [];

    if (campaignFilterIds.length > 0) {
      demographicsBreakdown = demographicsBreakdown.filter((item: any) =>
        item.campaign_id && campaignFilterIds.includes(item.campaign_id)
      );
      placementBreakdown = placementBreakdown.filter((item: any) =>
        item.campaign_id && campaignFilterIds.includes(item.campaign_id)
      );
      deviceBreakdown = deviceBreakdown.filter((item: any) =>
        item.campaign_id && campaignFilterIds.includes(item.campaign_id)
      );
    }

    const processedDemographicsBreakdown = processBreakdownData(demographicsBreakdown);
    const processedPlacementBreakdown = processBreakdownData(placementBreakdown);
    const processedDeviceBreakdown = processBreakdownData(deviceBreakdown);

    // Format the data for LLM consumption
    const formattedContent = await deps.formatMetricsSummary({
      adPerformance,
      adSetsData: processedAdSetsData,
      adsData: processedAdsData,
      campaignSummary,
      demographicsBreakdown: processedDemographicsBreakdown,
      placementBreakdown: processedPlacementBreakdown,
      deviceBreakdown: processedDeviceBreakdown,
      attributionWindow: { start: sinceStr, end: untilStr, days: attributionDays },
      timeframe
    }, userId);

    const truncationNote = truncatedSections.length > 0
      ? ` THIS DATA IS INCOMPLETE for: ${truncatedSections.join(', ')} — the read stopped before the end of the account. Do not conclude an ad/campaign is absent based on these sections.`
      : '';
    const result = {
      success: true,
      message: (breakdownStatus.partialFailure
        ? `Meta ads metrics loaded for ${timeframe} timeframe (some breakdown sections unavailable: ${breakdownStatus.unavailableSections.join(', ')})`
        : `Meta ads metrics loaded for ${timeframe} timeframe`) + truncationNote,
      timeframe,
      attributionWindow: { start: sinceStr, end: untilStr, days: attributionDays },
      campaignSummary,
      formattedContent,
      // ENG-104: which breakdown sections are complete vs unavailable, so a
      // partial result is explicit in the tool result (and flows into the tool
      // telemetry that captures the tool output) rather than looking fully ok.
      sections: breakdownStatus.sections,
      partialFailure: breakdownStatus.partialFailure,
      unavailableSections: breakdownStatus.unavailableSections,
      // ENG-1584 sibling: which sections hit the page-count bound, so a caller cannot mistake
      // a short list for the whole account (see truncatedSections above).
      ...(truncatedSections.length > 0 ? { truncatedSections, complete: false } : { complete: true }),
    };

    return result;
  } catch (error: any) {
    console.error('AgentMode: Error fetching Meta ads metrics:', error);
    console.error('AgentMode: Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    const errorType = error?.isMetaAuthError
      ? 'connection'
      : (error?.metaMetricsErrorType || 'api');
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      message,
      error: message,
      errorType,
      // ENG-1300: real HTTP status when the failure came from a coded fetch
      // (typedError.status above); getMetaCredentials failures don't carry one.
      code: error?.status ?? error?.response?.status
    };
  }
}

// Re-exported so a test file that mocked one of these away can be retargeted
// at this module's own exports rather than only at the top-level ones above.
export { processCampaignData, processAdSetsData, processAdsData, generateCampaignSummary, processBreakdownData };

// ============================================================================
// 4. callMetaMarketingApi
// ============================================================================

/**
 * Master method for calling Meta Marketing API.
 * Routes the request to the appropriate entity manager based on entity_type.
 */
export async function callMetaMarketingApi(
  userId: string,
  entity_type: 'CAMPAIGN' | 'AD_SET' | 'AD_CREATIVE' | 'AD' | 'CUSTOM_AUDIENCE' | 'TARGETING' | 'PAGE' | 'DATASET',
  action: string,
  account_id: string,
  campaign_id: string | undefined,
  ad_set_id: string | undefined,
  ad_id: string | undefined,
  params: any = {},
  sessionId: string | undefined,
  deps: CallMetaMarketingApiDeps,
): Promise<MetaApiResult> {
  console.log(`AgentMode: callMetaMarketingApi -> ${entity_type} / ${action}`);

  if (action === 'CREATE_PAUSED_BUNDLE') {
    if (entity_type !== 'CAMPAIGN' || campaign_id || ad_set_id || ad_id || !deps.preparePausedMetaBundle) {
      return { success: false, message: 'A paused bundle creates a new campaign, ad set and ads; existing target IDs are not allowed.' };
    }
    return deps.preparePausedMetaBundle(userId, sessionId, account_id, params);
  }

  // Ensure params is an object
  params = params || {};

  // ENG-400: a Meta campaign objective is IMMUTABLE — the one hard rule this
  // gate exists to enforce is that a CAMPAIGN CREATE never executes with an
  // objective no human chose. The gate itself MUST run BEFORE objective
  // validation: the safest thing a model can do when it doesn't know the
  // objective is omit it entirely, and validateMetaActionParams used to
  // require objective to be PRESENT for CAMPAIGN CREATE — if that ran first,
  // omitting it produced a generic PARAM_VALIDATION_ERROR instead of the real
  // blocking card, defeating the whole point of the gate for exactly the
  // callers who behave correctly.
  //
  // Greptile P1 ("Invalid requests now require session storage"): the gate
  // can touch the DB (auto-provisioning a session, reading pending
  // questions), so a request that's malformed independent of objective
  // (e.g. missing "name") must be rejected BEFORE the gate runs, not after —
  // otherwise a basic, previously DB-free validation failure now depends on
  // session storage being reachable at all. Validate those fields first.
  if (entity_type === 'CAMPAIGN' && action === 'CREATE') {
    try {
      MetaService.validateCampaignParamsExceptObjective(action, params);
    } catch (validationError: any) {
      return {
        success: false,
        message: validationError.message,
        // The code alone is useless to the model: a success:false result is rewritten at
        // the dispatch boundary into ONE reason string taken from `error` before `message`
        // (utils/toolResultError), so the explanation of WHICH param is wrong and where it
        // belongs — the entire value of rejecting instead of silently dropping — was being
        // dropped on the floor. Keep the code as the prefix so callers still match on it.
        error: `PARAM_VALIDATION_ERROR: ${validationError.message}`,
        hint: 'Fix the listed parameters and retry.'
      } as any;
    }
  }

  // Scope is deliberately narrow: only CAMPAIGN CREATE calls this — no other
  // Meta write is gated.
  if (entity_type === 'CAMPAIGN' && action === 'CREATE') {
    const gate = await deps.resolveCampaignObjectiveGate(userId, sessionId, account_id, params);
    if (!gate.allowed) {
      return gate.response;
    }
    // Apply the deterministically-resolved objective verbatim — never
    // re-derived from params after this point, so nothing downstream can
    // silently drift it (the idx=202→205 LEADS→TRAFFIC flip in the incident).
    params = { ...params, objective: gate.objective };

    // ENG-2232: deterministic Page-access preflight. Page access is a second,
    // independent Meta grant that the objective gate above says nothing
    // about, and the PAGE LIST tool's own warning text is only advisory — a
    // model can still choose to build anyway. This is what the reported
    // production incident actually needed: the account had 0 accessible
    // Pages, PAGE LIST said so, and the agent built 4 campaigns + 4 ad sets
    // before the failure finally surfaced at AD_CREATIVE CREATE. Blocking
    // here stops the whole build at step 1 instead of after the waste.
    //
    // Reuses the credential-resolution call the tracking gate below already
    // makes for its own account lookup (same `getMetaCredentials(userId,
    // account_id)` shape, deliberately no clientScope per ENG-1801) — a
    // second call is the established pattern for a preflight gate here, not
    // a new one. 'unknown' (never probed, or credentials came from the
    // legacy adAccount fallback which predates this field) is NOT treated as
    // 'missing' — only a confirmed-empty PAGE LIST blocks.
    const { connection: pageGateConnection } = await deps.getMetaCredentials(userId, account_id);
    const { getMetaPagesAccessState, getMetaAdsNoPagesMessage } = await import('../../utils/metaAdsScope');
    if (getMetaPagesAccessState(pageGateConnection?.config) === 'missing') {
      const pageMessage = getMetaAdsNoPagesMessage(pageGateConnection?.config);
      return {
        success: false,
        message: pageMessage,
        error: `META_PAGE_ACCESS_MISSING: ${pageMessage}`,
        hint: 'Reconnect Meta and select the Page on the "Choose Pages" step, or get "Create ads" (Advertiser) access on the Page, then retry.'
      } as any;
    }
  }

  // Pre-validate params before any API round-trip
  try {
    deps.validateMetaActionParams(entity_type, action, campaign_id, ad_set_id, ad_id, params);
  } catch (validationError: any) {
    return {
      success: false,
      message: validationError.message,
      // Same reason as the pre-gate site above: `error` is what the model actually reads.
      error: `PARAM_VALIDATION_ERROR: ${validationError.message}`,
      hint: 'Fix the listed parameters and retry.'
    } as any;
  }

  // ENG-2232: deterministic Page-access preflight for AD_CREATIVE CREATE
  // specifically — the CAMPAIGN CREATE gate above only catches a build that
  // starts with a NEW campaign; adding a creative to an EXISTING campaign
  // never goes through that gate at all. validateMetaActionParams above
  // already guarantees params.page_id is present (Meta requires it for
  // every creative), so this checks the ACTUAL target Page directly —
  // more precise than the CAMPAIGN CREATE gate's historical-existing-ads
  // heuristic, since a Meta CAMPAIGN object carries no page_id to compare
  // against in the first place.
  if (entity_type === 'AD_CREATIVE' && action === 'CREATE') {
    const { connection: creativeGateConnection } = await deps.getMetaCredentials(userId, account_id);
    const { getAccessiblePageIds, buildMetaAdsPageNotAccessibleMessage } = await import('../../utils/metaAdsScope');
    const accessiblePageIds = getAccessiblePageIds(creativeGateConnection?.config);
    const requestedPageId = typeof params.page_id === 'string' ? params.page_id : undefined;
    // Only a verdict when we've actually probed (accessiblePageIds defined) —
    // a legacy/never-probed connection must not be blocked on an unknown.
    if (accessiblePageIds !== undefined && requestedPageId && !accessiblePageIds.includes(requestedPageId)) {
      const pageMessage = buildMetaAdsPageNotAccessibleMessage(requestedPageId);
      return {
        success: false,
        message: pageMessage,
        error: `META_PAGE_ACCESS_MISSING: ${pageMessage}`,
        hint: 'Reconnect Meta and select that Page on the "Choose Pages" step, or get "Create ads" (Advertiser) access on it, then retry.'
      } as any;
    }
  }

  // ENG-2274: direct AD writes can bypass AD_CREATIVE CREATE entirely by
  // referencing an existing creative, copying an ad, or swapping a creative
  // onto an ad. A connection with confirmed zero accessible Pages cannot
  // safely create/copy/update ads either, so hard-stop before the write path.
  if (entity_type === 'AD' && ['CREATE', 'UPDATE', 'COPY_AD'].includes(action)) {
    const { connection: adGateConnection } = await deps.getMetaCredentials(userId, account_id);
    const { getMetaPagesAccessState, getMetaAdsNoPagesMessage } = await import('../../utils/metaAdsScope');
    if (getMetaPagesAccessState(adGateConnection?.config) === 'missing') {
      const pageMessage = getMetaAdsNoPagesMessage(adGateConnection?.config);
      return {
        success: false,
        message: pageMessage,
        error: `META_PAGE_ACCESS_MISSING: ${pageMessage}`,
        hint: 'Reconnect Meta and select the Page on the "Choose Pages" step, or get "Create ads" (Advertiser) access on the Page, then retry.'
      } as any;
    }
  }

  // Target-confirmation guardrail for mutating actions (publish/change/delete).
  // ENG-1635/1644 gap 5: `params.confirm` used to be read here into a
  // `confirmed` boolean that could independently satisfy the halt below —
  // that was the bypass (see the gate's own comment further down). The flag
  // is no longer read as a trust signal at all; it is still stripped before
  // dispatch below (`'confirm' in params`) purely so it never leaks to Meta
  // as a literal field, not because it still means anything to this gate.
  /*
   * ENG-941, Greptile security P1 ("Confirmed replay can add override"): the preview and
   * the confirmed execution are two separate calls with separately supplied params, so a
   * model could preview a plain activation, let the user approve THAT, and then add
   * `override_tracking_check` to the replay — waiving the measurement check on something
   * the user was never told would skip it. An override the model can introduce after
   * approval is not user-granted, whatever the tool description says.
   *
   * So the override is bound to the approval: a preview that carries one issues an HMAC
   * over that exact call, and the override only counts when the replay presents that token
   * back. No token, a forged token, or a token for different arguments all fall back into
   * a fresh preview — which discloses the override and issues the matching token, so the
   * path is a loop rather than a dead end. Nothing changes for a launch that waives
   * nothing: those never need a token.
   */
  const budgetAnomaly = await deps.checkMetaBudgetChange(
    userId, entity_type, action, account_id, campaign_id, ad_set_id, ad_id, params, sessionId,
  );
  if (budgetAnomaly?.blocked) return budgetAnomaly.blocked as any;
  const budgetReconfirmation = budgetAnomaly?.requiresConfirmation === true;
  if (budgetReconfirmation) {
    // Part of the NEW manifest digest: the old grant cannot approve this disclosure.
    params = { ...params, budget_confirmation_token: budgetAnomaly.token };
  }

  const overrideClaimed = (params as any)?.override_tracking_check === true;
  const overrideDigest = overrideClaimed
    ? computeTrackingOverrideDigest(getJwtSecret(), {
        entity_type, action, account_id, campaign_id, ad_set_id, ad_id, params,
      })
    : '';
  const overrideApproved =
    overrideClaimed && trackingOverrideTokenMatches((params as any)?.tracking_override_token, overrideDigest);

  // ENG-1635/1644 gap 5 (critical, code-verified fix — see the reviewed plan):
  // an approved deck authorizes its exact writes without re-confirmation, and
  // this is now the ONLY path a Meta write may proceed through. `confirmed`
  // (params.confirm, model-controlled) used to be OR'd alongside this grant
  // check — `!confirmed && !manifestGranted` meant confirmed=true ALONE, with
  // no grant at all, skipped the halt below. That is the exact failure mode
  // of the 2026-07-19 RankAI incident (see askUserQuestion.ts's header),
  // reproduced by this gate itself: a model could call this tool with
  // confirm:true on a first, never-previewed call and the write would
  // execute with no human ever asked. The grant check below now runs
  // unconditionally for every Meta write action (not gated on `!confirmed`),
  // and `confirmed` no longer appears in the halt condition at all — see
  // below. `params.confirm` is now fully inert as a trust signal; it is not
  // read anywhere in this function anymore (only stripped before dispatch,
  // see above, so it never leaks to Meta as a literal field).
  let manifestGranted = false;
  if (
    deps.isMetaWriteAction(entity_type, action) &&
    !budgetReconfirmation && sessionId
  ) {
    const grant = await deps.claimMetaWriteManifestGrant(
      userId, sessionId, entity_type, action, account_id, campaign_id, ad_set_id, ad_id, params
    );
    manifestGranted = grant.granted;
  }

  if (
    deps.isMetaWriteAction(entity_type, action) &&
    (budgetReconfirmation || !manifestGranted || (overrideClaimed && !overrideApproved))
  ) {
    /*
     * MERGE NOTE: main's manifest grant decides WHETHER this gate runs; the tenancy fields
     * decide what it says when it does. Independent, so both are kept — dropping
     * `tenancyRefused` here would silently restore the bug where a node the ownership guard
     * had already refused still reached a confirmation prompt.
     *
     * ⚠ A manifest grant SKIPS this block, and with it the tenancy refusal. Do not read that
     * as safe on the grounds that the write re-checks: it does not. `updateCampaign`,
     * `updateAdSet`, `updateAd` and the three deletes take an access token and a node id and
     * no ad-account id at all, so nothing below this point verifies ownership.
     *
     * Not a regression — before this PR there was no tenancy check on this path either, and
     * ENG-1642 changes who may skip the confirmation, not what the writes check. But the
     * manifest path is the one write route with no ownership check anywhere in it, and that
     * belongs on the write-scoping work rather than being assumed away here.
     */
    let { summary, target, tenancyRefused, tenancyRefusalMessage } = await deps.buildMetaWriteConfirmation(
      userId, entity_type, action, account_id, campaign_id, ad_set_id, ad_id, params
    );
    // ENG-1635: this call's manifest digest, computed once here (against the SAME
    // resolved account buildMetaWriteConfirmation just used) so the manifest producer
    // at the loop seam (collectConfirmationPrompt's caller) can batch every halted
    // write from this iteration into one approval without re-resolving credentials
    // or re-deriving the digest a second way.
    const metaWriteManifestDigest = await deps.resolveMetaWriteManifestDigest(
      userId, entity_type, action, account_id, campaign_id, ad_set_id, ad_id, params
    );
    /*
     * A node the ownership guard refused is out of scope for this write, full stop. Asking the
     * user to approve it — even under a degraded `ID <id>` label — would be the gate granting
     * exactly what the guard exists to deny, since an approval here is what unlocks the
     * confirmed replay. Refuse before the prompt is built.
     *
     * The refusal says nothing about the node beyond the selected account the caller already
     * supplied: no name, no owning account, no id. `assertOwnedByAccount` withholds those
     * because a block that answers "which account owns this?" is the oracle it is preventing,
     * and relaying it through the confirmation gate would hand back the same answer.
     *
     * ⚠ `target.account_id`, NOT the raw `account_id` argument. `buildMetaWriteConfirmation`
     * scopes against the account `getMetaCredentials` RESOLVED — which is the whole point of
     * that fix — but this message beside it still read the raw argument, so a caller that
     * omitted `account_id` (single-account users; the REST route validates nothing) was told
     * the target "is not available in the selected ad account (undefined)". The refusal was
     * correct and its explanation named an account that does not exist.
     */
    if (tenancyRefused) {
      const refusal =
        `Blocked: the target of this Meta Ads ${entity_type} ${action} is not available in the selected ` +
        `ad account (${target.account_id || 'none could be determined'}), so it was not prepared for confirmation ` +
        `and nothing was sent to Meta. ` +
        `Do not ask the user to approve this change. ` +
        // The guard's own remedy, which differs by branch — see tenancyRefusalMessage above.
        deps.remedyFromScopeRefusal(tenancyRefusalMessage);
      return {
        success: false,
        blocked: true,
        reason: 'account_scope',
        message: refusal,
        // Same reason as the validation branch above: `error` is what the model actually reads.
        error: `ACCOUNT_SCOPE_REFUSED: ${refusal}`,
      } as any;
    }
    // ENG-1748: if this exact target was approved with different params, name the
    // drifted fields so the user sees what changed. Explanatory only — the
    // grant decision above is unchanged and nothing executes here.
    if (!budgetReconfirmation && !manifestGranted && sessionId) {
      // aws-sdk (constructs a real AWS client at module scope) — established
      // precedent: round 2's createGTMPlan/chatbotDb.getChatSession finding.
      const { chatbotDb } = await import('../../services/chatbotService');
      const driftSession = await chatbotDb.getChatSession(sessionId);
      const drifted = describeMetaWriteParamDrift(driftSession?.pendingApprovalDeck, {
        entity_type, action, account_id, campaign_id, ad_set_id, ad_id, params,
      });
      if (drifted) {
        summary += formatMetaWriteParamDriftMessage(drifted);
      }
    }
    if (budgetAnomaly?.changes) {
      summary += ` Budget review (${budgetAnomaly.severity}): ` + budgetAnomaly.changes.map(change =>
        `${change.field}: ${change.prior} -> ${change.proposed} minor currency units` +
        (change.ratio === null ? ' (zero prior)' : ` (${change.ratio}x)`),
      ).join('; ') + '. PAUSE_AND_VERIFY: offer to pause delivery first, then verify amounts and currency units before approving the increase.';
    }
    // `awaitingUserConfirmation` + `confirmationPrompt` are consumed by the agent loop
    // (collectConfirmationPrompt) to HALT the turn and surface the prompt to the user.
    // The turn cannot continue until a NEW human message arrives — the model cannot
    // self-approve. `message` keeps the model-facing instructions for the resumed turn.
    return {
      success: true,
      requiresConfirmation: true,
      awaitingUserConfirmation: true,
      summary,
      // ENG-1635/1644 gap 5: never invite a typed "yes"/"confirm" reply — that flag is
      // fully inert now (see the `message` field below and callMetaMarketingApi's gate).
      // This exact field is only ever surfaced to the user when deck-routing itself
      // failed (a malformed deck, or a lost one-live-slot race — see
      // buildApprovalDeckForIteration's fallback contract) — the normal path never
      // reaches it, this write instead becomes a real approval-deck card.
      confirmationPrompt:
        `Based on your request, here's the exact Meta Ads change I'm about to make — ` +
        `please check it's the right target before I proceed:\n\n${summary}\n\n` +
        `This needs your explicit approval through a review card, not a typed reply — ` +
        `if no card appears here, refresh the page or ask again and I'll represent it as one.`,
      // Per-item body (no intro/footer) used when several writes are batched in one turn.
      confirmationDetail: summary,
      ...(budgetAnomaly?.changes ? { budgetAnomaly: {
        severity: budgetAnomaly.severity, changes: budgetAnomaly.changes,
        spendConcern: budgetAnomaly.spendConcern, suggestedAction: budgetAnomaly.suggestedAction,
      } } : {}),
      message: `This Meta Ads ${entity_type} ${action} needs review before it runs: ${summary} ` +
        `Show the user the exact target above (campaign / ad set / asset). ` +
        `If more than one campaign or asset could match the request, ask the user to disambiguate first. ` +
        `Do NOT re-call call_meta_marketing_api with params.confirm=true — that flag no longer grants ` +
        `anything on its own (ENG-1635/1644). This write is now included in the pending approval review ` +
        `presented to the user automatically; take no further action that depends on it until they submit ` +
        `their answer.` +
        (overrideClaimed
          ? ` This call also waives the tracking pre-flight check, so the user must be shown the ` +
            `WARNING above and approve it explicitly; the replay must additionally carry ` +
            `params.tracking_override_token exactly as returned here, or the override will not apply.`
          : ''),
      // Only issued when an override was actually described in this preview, so it can only
      // ever approve a waiver the user was shown.
      ...(overrideClaimed ? { tracking_override_token: overrideDigest } : {}),
      target,
      // ENG-1635: internal-only correlator for the manifest producer — never part of the
      // model-facing `message`, so nothing tells the model this exists or invites it to
      // forge one. Consumed exclusively by collectConfirmationPrompt's caller in the same
      // process, never serialized to the client.
      metaWriteManifestDigest,
      // ENG-1635/1644 Round 3 consequence #3: the dispatch parameters needed to
      // execute this exact write LATER, without the model ever re-calling this tool
      // — a workflow step (built from an approved deck item) reads this to call
      // dispatchAuthorizedMetaWrite directly. Deliberately the RAW account_id (the
      // same variable both claimMetaWriteManifestGrant's call above and
      // metaWriteManifestDigest's own computation used) rather than target.account_id
      // — resolveMetaWriteManifestDigest resolves credentials internally itself, so
      // re-deriving the digest from these exact fields at claim time (execute() calls
      // claimMetaWriteManifestGrant before dispatching) must start from the SAME input
      // that produced the digest being matched, not a value resolveMetaWriteManifestDigest
      // was never given and has no proven-idempotent relationship to. Internal-only,
      // same as the digest above — never part of the model-facing `message`.
      //
      // ENG-1644: `resolvedAccountId` is ADDITIVE, alongside the raw `account_id` above,
      // never replacing it — `account_id` must stay raw for the digest-matching reason
      // just explained. `target.account_id` is the account `getMetaCredentials` actually
      // resolved for THIS preview, frozen here as a plain value. A cross-session resume
      // (days later, outside this process) must dispatch against this frozen id, not
      // re-derive one from the user's live connected-accounts state at claim time — that
      // state can drift between preview and a delayed approval in a way it structurally
      // cannot within the same request. See ENG-1644 for the durable consumer; same-session
      // dispatch (buildMetaWriteWorkflowSteps/resumeStuckApprovalDeckWorkflowRun) also
      // prefers this value when present, closing the same latent gap there too.
      metaWriteDispatch: { entity_type, action, account_id, resolvedAccountId: target.account_id, campaign_id, ad_set_id, ad_id, params },
    } as any;
  }
  // ENG-1635/1644 Round 3 consequence #3: everything past this point (strip the
  // gate-only flags, run the ENG-941 tracking pre-flight, dispatch to the
  // entity-specific write method) is shared with a workflow step's execute()
  // dispatching an approved deck item directly — see dispatchAuthorizedMetaWrite's
  // own header for why that reuses this exact method rather than re-deriving it.
  const dispatchResult: MetaApiResult = await deps.dispatchAuthorizedMetaWrite(
    userId, entity_type, action, account_id, campaign_id, ad_set_id, ad_id, params, overrideApproved, sessionId,
  );

  // ENG-1635/1644 Migration note: the old per-write outcome recording +
  // reconciliation (recordMetaWriteManifestOutcome / reconcileMetaWriteManifestIfComplete)
  // that used to run here is RETIRED, not kept running alongside its
  // replacement — a manifest-granted write dispatched through THIS function
  // (the model-driven path; the normal path is now submitApprovalDeckAnswers's
  // step-per-write dispatch, which never re-enters this function at all) has
  // its outcome recorded as a workflow checkpoint instead, and
  // summarizeApprovalDeckRun reads run.checkpoints directly rather than a
  // separate outcome map — one source of truth, not two that could drift.
  return dispatchResult;
}

// ============================================================================
// 5. launchAudienceCampaign (+ exclusive helpers) / launchTargetedAudienceCampaign
//    / launchRetargetingCampaign
// ============================================================================

// ENG-600: fixed EMAIL/PHONE schema for the HubSpot/CSV audience-sourcing
// workflows — ticket scope is email/phone seed data, not arbitrary schemas.
const AUDIENCE_SOURCE_SCHEMA = ['EMAIL', 'PHONE'];

/**
 * Hashes raw row data per Meta's Custom Audience field-normalization rules
 * (lowercased email, digits-only phone, etc.), passing through values that
 * are already a 64-hex-char SHA256 hash unchanged. Shared by UPLOAD_USERS
 * (`AgentModeService.prototype.manageMetaCustomAudiences`, still on the
 * class) and `resolveOrCreateSeedAudience`'s stale-member diff below, which
 * both need identical hashing so the same contact hashes to the same
 * row-key regardless of which path produced it. Genuinely stateless — zero
 * `this.*` references in the original — so promoted to a real export here
 * rather than duplicated, with `AgentModeService.prototype.hashAudienceRows`
 * turned into a one-line delegating wrapper (same treatment this cluster
 * already gave `formatMetricsSummary`).
 */
export function hashAudienceRows(schema: string[], rows: string[][]): string[][] {
  return rows.map((row: string[]) => {
    return row.map((cell: string, index: number) => {
      const fieldType = (schema && schema[index]) ? schema[index].toUpperCase() : '';
      let value = cell ? cell.trim() : '';

      if (!value) return '';

      // Pass through if already a SHA256 hash (64 hex chars)
      if (/^[a-fA-F0-9]{64}$/.test(value)) {
        return value;
      }

      // Normalization Rules per Meta requirements:
      if (['EMAIL'].includes(fieldType)) {
        value = value.toLowerCase();
      } else if (['PHONE'].includes(fieldType)) {
        // Standardize to digits only (strip spaces, dashes, parens)
        value = value.toLowerCase().replace(/[^a-z0-9]/g, '');
      } else if (['GEN'].includes(fieldType)) {
        // Gender: 'f' or 'm'
        value = value.toLowerCase() === 'female' ? 'f' : (value.toLowerCase() === 'male' ? 'm' : value.toLowerCase());
      } else if (['DOBY', 'DOBM', 'DOBD'].includes(fieldType)) {
        // Keep trimmed string
        value = value.trim();
      } else if (['COUNTRY'].includes(fieldType)) {
        // Country codes must be lowercase 2-letter ISO
        value = value.toLowerCase();
      } else {
        // Default: lowercase + trim
        value = value.toLowerCase();
      }

      // Compute SHA256
      return createHash('sha256').update(value).digest('hex');
    });
  });
}

/**
 * Deterministic row-key for a hashed row, used to diff audience snapshots.
 * Exclusive to `resolveOrCreateSeedAudience` (confirmed by whole-backend
 * grep) — moved alongside it as a plain, non-exported module function.
 */
function audienceRowKey(hashedRow: string[]): string {
  return hashedRow.join('|');
}

/**
 * Fetches and parses a CSV URL into raw rows for `resolveOrCreateSeedAudience`'s
 * CSV source path. Fetched exactly once and reused as both the upload
 * payload and the basis for the stale-member hash diff — fetching twice
 * (e.g. once to diff, once inside UPLOAD_USERS) would let the two see
 * different content if the URL's data changed in between, corrupting the
 * diff against what was actually uploaded. Exclusive to
 * `resolveOrCreateSeedAudience` (confirmed by whole-backend grep) — moved
 * alongside it as a plain, non-exported module function.
 */
async function fetchAndParseCsvRows(csvUrl: string): Promise<string[][]> {
  // Greptile finding: this is a server-side fetch of a caller-supplied URL
  // with no destination restriction — a classic SSRF vector (cloud metadata
  // endpoints, RFC1918/internal hosts, loopback). Reuses the repo's existing
  // guard rather than reinventing IP-range checks.
  //
  // Greptile follow-up finding (DNS rebinding): validating the hostname
  // alone isn't enough if axios then does its own SEPARATE DNS lookup to
  // actually connect — an attacker-controlled DNS server can answer a
  // public IP for the validation query and a private IP for the
  // connection query. Pinning the connection to the exact address that
  // was validated (via a custom `lookup`) eliminates the second,
  // unvalidated lookup entirely.
  const { address, family } = await resolvePinnedPublicAddress(csvUrl);
  // SSRF defence-in-depth: refuse to follow redirects. Validation only
  // covers the user-supplied URL itself; if axios followed a redirect to
  // e.g. http://169.254.169.254/, the guard would be bypassed entirely.
  // maxRedirects:0 makes axios surface a redirect as an error instead —
  // same defense already used by routes/crm.ts's load-from-url path.
  const response = await axios.get(csvUrl, {
    maxRedirects: 0,
    lookup: (_hostname: string, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      callback(null, address, family);
    },
  } as any);
  if (Array.isArray(response.data)) {
    return response.data;
  }
  const str: string = typeof response.data === 'object' ? JSON.stringify(response.data) : String(response.data ?? '');
  return parseCsv(str, { skip_empty_lines: true, trim: true, relax_column_count: true });
}

/**
 * Resolves the Meta Custom Audience that a targeted/retargeting campaign
 * workflow should target: reuse an existing audience whose name matches
 * (case-insensitive), or create a new one. Either way, the resolved
 * audience is (re)populated from the caller's HubSpot list or CSV source —
 * reuse does not skip the upload, so pointing an existing audience at a
 * fresh source keeps it current rather than silently reusing stale data.
 *
 * `dryRun: true` only resolves the reuse-vs-create decision (for building
 * a pre-execution confirmation preview) without creating/uploading anything.
 *
 * Any hard failure (LIST/CREATE/UPLOAD_USERS erroring) is thrown, not
 * swallowed — the caller (the two new launch* orchestration methods) must
 * fail the whole campaign-launch rather than attach an empty/broken audience.
 * Only non-fatal source-side issues (e.g. contacts with no email/phone) are
 * returned in `failures`.
 *
 * ENG-2103 (F2 follow-up): moved verbatim from
 * `AgentModeService.prototype.resolveOrCreateSeedAudience` (private). Deleted
 * from the class outright — see module header for why, and for the new
 * `deps` parameter this required.
 */
export async function resolveOrCreateSeedAudience(
  userId: string,
  accountId: string,
  audienceName: string,
  source: { type: 'hubspot_list'; listId: string; hubspotAccountId?: string } | { type: 'csv'; csvUrl: string },
  opts: { dryRun: boolean },
  deps: SeedAudienceDeps,
): Promise<{
  plannedAction: 'reuse' | 'create';
  audience?: { id: string; name: string };
  created: boolean;
  sourceSummary: string;
  failures: string[];
  recordsFound?: number;
  recordsUsable?: number;
}> {
  const listResult = await deps.manageMetaCustomAudiences(userId, 'LIST', accountId, {});
  if (!listResult.success) {
    throw new Error(listResult.message || 'Failed to list existing Meta custom audiences.');
  }
  const existing = (listResult.audiences || []).find(
    (a: any) => String(a?.name ?? '').toLowerCase() === audienceName.toLowerCase()
  );
  const plannedAction: 'reuse' | 'create' = existing ? 'reuse' : 'create';
  const sourceSummary = source.type === 'hubspot_list'
    ? `HubSpot list ${source.listId}`
    : `CSV upload (${source.csvUrl})`;

  if (opts.dryRun) {
    return {
      plannedAction,
      audience: existing ? { id: existing.id, name: existing.name } : undefined,
      created: false,
      sourceSummary,
      failures: [],
    };
  }

  const failures: string[] = [];
  let schema: string[] = AUDIENCE_SOURCE_SCHEMA;
  let payload: string[][];
  let recordsFound: number | undefined;
  let recordsUsable: number | undefined;

  if (source.type === 'hubspot_list') {
    const hubspotSvc = await deps.resolveHubSpotService(userId, source.hubspotAccountId);
    const { contacts, failedChunkContactCount } = await hubspotSvc.getContactsForList(source.listId);
    const rows: string[][] = [];
    let skipped = 0;
    for (const c of contacts) {
      if (c.email || c.phone) {
        rows.push([c.email || '', c.phone || '']);
      } else {
        skipped++;
      }
    }
    const totalFound = contacts.length + failedChunkContactCount;
    if (skipped > 0) {
      failures.push(`${skipped} of ${contacts.length} HubSpot contacts had neither email nor phone, skipped.`);
    }
    // Greptile P1 finding: a failed batch/read chunk was previously silently
    // dropped, then (after an earlier fix) merely reported as a non-fatal
    // ledger entry while the campaign still launched against a known-
    // incomplete audience. A HubSpot read failure means we cannot say what
    // the correct audience actually is, so this now blocks the whole launch
    // rather than proceeding on a partial/wrong segment — the caller must
    // retry once HubSpot is reachable again.
    if (failedChunkContactCount > 0) {
      throw new Error(`${failedChunkContactCount} of ${totalFound} HubSpot contacts could not be read (batch/read failure) — refusing to launch against a known-incomplete audience. Retry once HubSpot is reachable again.`);
    }
    payload = rows;
    recordsFound = totalFound;
    recordsUsable = rows.length;
  } else {
    // Fetched/parsed once here (not left as a URL for UPLOAD_USERS to fetch
    // separately) — a second independent fetch would let the stale-member
    // diff and the actual upload see two different snapshots of the same
    // URL if its content changed in between, corrupting the diff. One fetch
    // is also the source of truth for both the hash diff and the upload.
    payload = await fetchAndParseCsvRows(source.csvUrl);
  }

  let audienceId: string;
  let audienceLabel: string;
  if (plannedAction === 'create') {
    const createResult = await deps.manageMetaCustomAudiences(userId, 'CREATE', accountId, {
      name: audienceName,
      subtype: 'CUSTOM',
      customer_file_source: 'USER_PROVIDED_ONLY',
      confirm: true,
    });
    if (!createResult.success) {
      throw new Error(createResult.message || 'Failed to create Meta custom audience.');
    }
    audienceId = createResult.audience.id;
    audienceLabel = createResult.audience.name;
  } else {
    audienceId = existing.id;
    audienceLabel = existing.name;
  }

  // Greptile P1 finding: reusing an existing audience for a fresh source
  // upload never removed members no longer present in the new source — a
  // contact removed from the HubSpot list (or dropped from a refreshed CSV)
  // stayed in the Meta audience forever. Diff the current source's hashed
  // rows against the last-synced snapshot and remove anything stale before
  // uploading the new set. Only meaningful on reuse — a brand-new audience
  // has no prior snapshot to diff against.
  const hashedRows = hashAudienceRows(schema, payload);
  const newRowKeys = hashedRows.map((row) => audienceRowKey(row));

  // Greptile P1 finding: a failed DELETE_USERS must not be forgotten. If the
  // snapshot saved below only reflected the current source (newRowKeys), a
  // stale member whose removal failed would simply disappear from tracking
  // — the next sync would see no prior record of it and never retry the
  // removal, leaving it targetable in Meta permanently. Un-removed keys are
  // folded back into what gets saved so the next sync sees them as stale
  // again and retries. Greptile follow-up: a failed removal must not just
  // be tracked for next time — it means this launch would proceed against
  // an audience known to still contain removed contacts, so it now blocks
  // the whole launch (thrown), consistent with every other hard-failure
  // step here (LIST/CREATE/UPLOAD_USERS/snapshot save).
  // Greptile finding: reusing an audience with NO prior snapshot (first
  // sync since stale-member sync shipped, or an audience created outside
  // this flow) had no baseline to diff against, so add-only uploads could
  // never remove any pre-existing members not in the current source — they
  // stayed forever. Tracked here so the write below uses Meta's atomic
  // usersreplace instead of an add-only upload in exactly this case; once a
  // snapshot exists, reuse goes back to the normal diff-and-delete-then-add
  // path (cheaper, and avoids replacing the whole set every sync).
  let noBaselineReuse = false;
  if (plannedAction === 'reuse') {
    // Greptile finding: a snapshot READ failure was previously swallowed
    // as non-fatal, leaving noBaselineReuse false — which fell through to
    // an add-only upload against unknown state (we can't tell "no prior
    // snapshot" from "couldn't read it"), the same "launch against
    // unreconciled data" problem as the other blocking fixes here. A
    // genuine infra failure still propagates and blocks below, same as
    // ever.
    //
    // Greptile follow-up finding: a CORRUPTED snapshot (malformed index or
    // chunk) threw the exact same generic error, permanently blocking
    // every future launch for that audience — unlike a transient outage,
    // corruption never resolves itself on retry. Treated the same as "no
    // baseline exists": falls through to the self-healing REPLACE_USERS
    // path below (never proceeds with the untrustworthy incomplete
    // baseline) and a fresh, uncorrupted snapshot gets saved right after,
    // fixing the corruption for good.
    let previousRowKeys: string[] | null;
    try {
      previousRowKeys = await getAudienceSnapshotRowKeys(userId, audienceId);
    } catch (e) {
      if (e instanceof CorruptSnapshotError) {
        console.error(`AgentMode: Corrupt audience snapshot for ${audienceId}, treating as no baseline:`, e);
        previousRowKeys = null;
      } else {
        throw e;
      }
    }
    if (previousRowKeys) {
      const currentKeySet = new Set(newRowKeys);
      const staleRowKeys = previousRowKeys.filter((k) => !currentKeySet.has(k));
      if (staleRowKeys.length > 0) {
        const staleRows = staleRowKeys.map((k) => k.split('|'));
        const deleteResult = await deps.manageMetaCustomAudiences(userId, 'DELETE_USERS', accountId, {
          id: audienceId,
          schema,
          payload: staleRows,
          confirm: true,
        });
        if (!deleteResult.success) {
          throw new Error(`Failed to remove ${staleRowKeys.length} stale member(s) from audience ${audienceId}: ${deleteResult.message}`);
        }
      }
    } else {
      noBaselineReuse = true;
    }
  }

  // Greptile finding: saving the snapshot AFTER the Meta upload meant a
  // save failure left a successfully-uploaded member with NO record in
  // any snapshot, ever — future diffs can only flag a member as stale by
  // comparing against a PRIOR snapshot that recorded it, so an untracked-
  // from-birth member could never be detected as no-longer-needed and
  // would stay targetable in Meta forever. Additive UPLOAD_USERS is
  // idempotent (a future sync just re-sends whatever's in the current
  // source, self-healing a "snapshot updated, upload not yet retried"
  // mismatch) but deletes are NOT (they depend entirely on snapshot
  // history) — so for that path, the snapshot is saved BEFORE uploading.
  //
  // Greptile follow-up finding: REPLACE_USERS (the no-baseline reuse path)
  // is the OPPOSITE case — saving before it has the mirror problem: if
  // REPLACE_USERS then fails, the snapshot now falsely looks like an
  // established baseline exists, so a retry switches to additive
  // UPLOAD_USERS instead of retrying REPLACE_USERS, and pre-existing
  // members that should have been wiped by the replace are never removed.
  // REPLACE_USERS doesn't need the save-before reorder at all — it's
  // fully idempotent regardless of tracking history (always sets Meta's
  // membership to exactly the payload), so retrying it after ANY failure
  // — including one where the snapshot save is what actually failed — is
  // always correct. Save stays AFTER for this path, as originally.
  if (!noBaselineReuse) {
    await saveAudienceSnapshotRowKeys(userId, audienceId, newRowKeys);
  }

  const uploadResult = await deps.manageMetaCustomAudiences(userId, noBaselineReuse ? 'REPLACE_USERS' : 'UPLOAD_USERS', accountId, {
    id: audienceId,
    schema,
    payload,
    confirm: true,
  });
  if (!uploadResult.success) {
    throw new Error(uploadResult.message || (noBaselineReuse ? 'Failed to replace users in Meta custom audience.' : 'Failed to upload users to Meta custom audience.'));
  }

  if (noBaselineReuse) {
    await saveAudienceSnapshotRowKeys(userId, audienceId, newRowKeys);
  }

  return {
    plannedAction,
    audience: { id: audienceId, name: audienceLabel },
    created: plannedAction === 'create',
    sourceSummary,
    failures,
    recordsFound,
    recordsUsable,
  };
}

/**
 * Thin wrapper used by `executeAudienceCampaignLaunch`'s ad-set reuse-match
 * check to determine whether the campaign has Advantage Campaign Budget
 * (CBO) — needed to normalize the requested budget the same way
 * `createMetaAdsAdSet` does (strips it entirely for CBO campaigns) before
 * comparing against an existing ad set. Kept as its own function (mirroring
 * `listMetaAdsAdSets`) so it can be mocked directly in tests.
 *
 * ENG-2103 (F2 follow-up): moved verbatim from
 * `AgentModeService.prototype.getCampaignForAdSetReuseCheck` (public).
 * Deleted from the class outright — see module header for why.
 */
export async function getCampaignForAdSetReuseCheck(
  userId: string,
  accountId: string,
  campaignId: string,
  deps: CampaignForAdSetReuseCheckDeps,
): Promise<any> {
  const { accountId: resolvedAccountId, accessToken } = await deps.getMetaCredentials(userId, accountId);
  return metaService.getCampaign(resolvedAccountId, accessToken, campaignId);
}

/**
 * ENG-1300: executeAudienceCampaignLaunch rethrows a plain Error whenever a
 * step it calls (manageMetaCustomAudiences, listMetaAdsAdSets,
 * createMetaAdsAdSet — all already fixed to return a numeric `code` on
 * failure) reports success:false, so the caller's classification is lost one
 * rethrow before it ever reaches launchAudienceCampaign's outer catch. Carry
 * it forward instead of discarding it.
 */
function rethrowStepFailure(result: { message?: string; code?: number }, fallbackMessage: string): never {
  const err: any = new Error(result.message || fallbackMessage);
  err.status = result.code;
  throw err;
}

/**
 * Deterministic JSON serialization with object keys sorted recursively, so
 * two structurally-equal objects compare equal regardless of key order —
 * unlike plain JSON.stringify, which is order-sensitive. Used by
 * executeAudienceCampaignLaunch's ad-set reuse-by-match check to compare
 * a requested targeting object against Meta's returned representation.
 */
function canonicalJSON(value: any): string {
  const sortKeys = (v: any): any => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((acc: any, k: string) => {
        acc[k] = sortKeys(v[k]);
        return acc;
      }, {});
    }
    return v;
  };
  return JSON.stringify(sortKeys(value ?? {}));
}

/**
 * Live-test finding (real Meta, ENG-600): a full canonicalJSON deep-equal
 * of a requested `targeting` object against Meta's returned representation
 * never matches, even for a byte-identical retry — Meta injects its own
 * defaults on read that we never sent (e.g. age_min/age_max/
 * user_age_unknown/targeting_relaxation_types at the top level, and
 * location_types nested inside geo_locations), and echoes back extra
 * fields on objects we DID send (e.g. custom_audiences[].name). Strict
 * equality treated every one of those as a real difference and reuse never
 * triggered. This instead checks that every key/value WE explicitly
 * requested is present in Meta's stored value, ignoring any extra keys
 * Meta added — Meta-injected defaults no longer block a legitimate reuse
 * match, while any actual difference in a field we requested still does.
 */
function isDeepSubset(requested: any, actual: any): boolean {
  if (requested === null || typeof requested !== 'object') return requested === actual;
  if (Array.isArray(requested)) {
    if (!Array.isArray(actual) || requested.length !== actual.length) return false;
    return requested.every((item, i) => isDeepSubset(item, actual[i]));
  }
  if (actual === null || typeof actual !== 'object') return false;
  return Object.keys(requested).every((key) => isDeepSubset(requested[key], actual[key]));
}

/**
 * Resolves args.audience_source into the discriminated union
 * resolveOrCreateSeedAudience expects. Throws if neither or both of
 * hubspot_list_id/csv_url are provided.
 */
function resolveAudienceSourceArg(audience_source: any): { type: 'hubspot_list'; listId: string; hubspotAccountId?: string } | { type: 'csv'; csvUrl: string } {
  const hasHubSpot = !!audience_source?.hubspot_list_id;
  const hasCsv = !!audience_source?.csv_url;
  if (hasHubSpot === hasCsv) {
    throw new Error('audience_source must include exactly one of hubspot_list_id or csv_url.');
  }
  return hasHubSpot
    ? { type: 'hubspot_list', listId: audience_source.hubspot_list_id, hubspotAccountId: audience_source.hubspot_account_id }
    : { type: 'csv', csvUrl: audience_source.csv_url };
}

/**
 * Greptile finding (PR #2234): confirm=true wasn't bound to what was
 * actually previewed — a model could set confirm=true on the very first
 * call (skipping the preview entirely) or change arguments between the
 * preview and confirm calls, and the tool would execute on the unverified/
 * changed arguments with no way to detect it. This computes a digest over
 * every argument that defines WHAT gets created/changed; launchAudienceCampaign
 * only treats a call as genuinely confirmed when args.preview_token matches
 * the digest recomputed from the CURRENT args — so a first-call confirm=true
 * (no token yet) or a changed argument after preview both fail the check
 * and fall back into a fresh preview instead of executing.
 *
 * Greptile follow-up finding: a plain hash of the args is NOT sufficient —
 * it's a pure function of caller-supplied data with no server secret, so
 * any caller (including the model itself) can independently compute the
 * exact same value and pass confirm=true on the very first call, without
 * ever having gone through an actual preview. HMAC-signing with the
 * server-only JWT secret (never exposed to the model/caller) makes the
 * token non-forgeable: only a value this method itself produced can match.
 */
export function computeAudienceCampaignArgsDigest(args: any): string {
  const canonical = {
    account_id: args.account_id,
    campaign_id: args.campaign_id,
    audience_name: args.audience_name,
    audience_source: args.audience_source,
    use_lookalike: !!args.use_lookalike,
    lookalike_ratio: args.lookalike_ratio,
    lookalike_country: args.lookalike_country,
    exclude_audience_id: args.exclude_audience_id,
    ad_set_params: args.ad_set_params,
    /*
     * ENG-941 (Greptile security P1): the override was NOT part of what the preview token
     * signed, so it could be added to the confirmed replay without changing the digest —
     * waiving the tracking check on a launch the user approved without one. Including it
     * means adding it invalidates the approval and forces a fresh, disclosing preview.
     */
    override_tracking_check: args.override_tracking_check === true,
  };
  return createHmac('sha256', getJwtSecret()).update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Builds the human-readable preview shown before launching a targeted-audience
 * or retargeting campaign, so the user always sees and confirms the resolved
 * audience reuse/create decision before anything is created/uploaded — per
 * ENG-600 product decision, name-collision reuse is never silent.
 */
export function buildAudienceCampaignConfirmationSummary(
  workflow: 'targeted_audience' | 'retargeting',
  args: any,
  plan: { plannedAction: 'reuse' | 'create'; audience?: { id: string; name: string }; sourceSummary: string }
): string {
  const lines: string[] = [];
  lines.push(
    `${plan.plannedAction === 'reuse' ? 'Reuse existing' : 'Create a NEW'} Custom Audience "${args.audience_name}"` +
    `${plan.audience ? ` (${plan.audience.id})` : ''}, sourced from ${plan.sourceSummary}.`
  );
  if (args.use_lookalike) {
    lines.push(`Create a Lookalike Audience (ratio ${args.lookalike_ratio}, country ${args.lookalike_country}) from that seed.`);
  }
  lines.push(`Attach it to a NEW ad set under campaign ${args.campaign_id} (ad account ${args.account_id}).`);
  if (workflow === 'retargeting') {
    lines.push(`Exclude custom audience ${args.exclude_audience_id} so retargeting spend does not overlap the broad/prospecting audience.`);
  }
  // Greptile P1 finding: createMetaAdsAdSet silently strips daily_budget/
  // lifetime_budget when the target campaign has Advantage Campaign Budget
  // (CBO) enabled — a caller-supplied budget is only preview_token-bound by
  // this confirm gate, not guaranteed to actually apply. Disclose the risk
  // up front rather than let the user believe a specific budget is locked
  // in by confirming.
  if (args.ad_set_params?.daily_budget != null || args.ad_set_params?.lifetime_budget != null) {
    lines.push(`Note: if campaign ${args.campaign_id} has Advantage Campaign Budget (CBO) enabled, Meta requires budget to be set at the campaign level — the daily/lifetime budget above will be silently dropped from the ad set in that case.`);
  }
  /*
   * ENG-941: the preview_token now covers `override_tracking_check`, so the override
   * cannot be added after approval — but binding it to an approval that never mentioned
   * it just moves the hole. The user has to be told what they are waiving, in the text
   * they actually read, or "user-granted" means nothing. Same wording as the shared write
   * path's confirmation, deliberately: one sentence for one decision.
   */
  if (args?.override_tracking_check === true) {
    lines.push(
      `WARNING: this launch will SKIP the tracking pre-flight check. Paid delivery may start ` +
      `at a destination that cannot report conversions. Only confirm if that is intended.`,
    );
  }
  return lines.join(' ');
}

export async function executeAudienceCampaignLaunch(
  userId: string,
  args: any,
  workflow: 'targeted_audience' | 'retargeting',
  source: { type: 'hubspot_list'; listId: string; hubspotAccountId?: string } | { type: 'csv'; csvUrl: string },
  deps: LaunchAudienceCampaignDeps,
): Promise<any> {
    /*
     * ENG-941: the named ENG-600 launch flows create their ad set directly rather than
     * going through callMetaMarketingApi, so the gate there does not cover them. Without
     * this, these two tools are the bypass.
     *
     * Ad sets default to PAUSED (metaService: `status: params.status || 'PAUSED'`), so a
     * launch only starts paid delivery when the caller explicitly asks for ACTIVE — which
     * is exactly what isMetaSpendStartingWrite tests. Reusing that predicate keeps one
     * definition of "this spends money" instead of a second, drifting copy.
     *
     * Runs after the confirmation step above and before anything is created, so a blocked
     * launch leaves no audience, lookalike or ad set behind.
     */
    if (isMetaSpendStartingWrite('AD_SET', 'CREATE', args?.ad_set_params)) {
      const gateCreds = await deps.getMetaCredentials(userId, args.account_id);
      // ENG-1909: see the comment at the callMetaMarketingApi call site above — undefined
      // (real fetch, unchanged) for any real account, dataset-backed for a sandbox one.
      const sandboxFetchHtml = await buildSandboxFetchHtml(userId);
      const gate = await runMetaTrackingGate(
        gateCreds,
        args.campaign_id,
        `${workflow.toUpperCase()}_LAUNCH`,
        args?.override_tracking_check === true,
        args?.session_id,
        { fetchHtml: sandboxFetchHtml },
      );
      if (!gate.proceed) return gate.blockResult;
    }

    const seed = await self.resolveOrCreateSeedAudience(userId, args.account_id, args.audience_name, source, { dryRun: false }, {
      manageMetaCustomAudiences: deps.manageMetaCustomAudiences,
      resolveHubSpotService: deps.resolveHubSpotService,
    });

    let attachAudienceId = seed.audience!.id;
    let lookalike: { id: string; name: string; ratio: number; country: string } | null = null;
    if (args.use_lookalike) {
      // Greptile finding: releasing the confirm token on a downstream
      // failure (e.g. ad-set creation) lets a legitimate retry reuse the
      // same approved args — but CREATE isn't idempotent by name, so an
      // unconditional retry after a lookalike had already been created
      // would create ANOTHER same-named lookalike, leaving a duplicate
      // Meta resource from a single confirmation. Reuse-by-exact-name-match
      // first, same pattern the seed audience already uses.
      const lookalikeName = `${args.audience_name} - Lookalike`;
      const lookalikeListResult = await deps.manageMetaCustomAudiences(userId, 'LIST', args.account_id, {});
      if (!lookalikeListResult.success) {
        rethrowStepFailure(lookalikeListResult, 'Failed to list existing Meta custom audiences.');
      }
      // Greptile follow-up findings: name-only matching isn't enough — a
      // same-named lookalike from an earlier launch with a DIFFERENT
      // ratio/country/seed audience (a deliberate new request, not a
      // retry — the confirm-token digest already includes ratio/country
      // and the source, so reaching here with a genuinely different
      // digest means a fresh, separately confirmed launch) must not be
      // silently reused. The campaign would target the old population
      // while the ledger reports the newly requested spec. Requires the
      // existing audience's actual spec — including its origin seed
      // audience, not just ratio/country — to also match, not just its
      // name.
      const existingLookalike = (lookalikeListResult.audiences || []).find((a: any) => {
        const origin = a?.lookalike_spec?.origin;
        const originId = Array.isArray(origin) ? origin[0]?.id : origin?.id;
        return (
          String(a?.name ?? '').toLowerCase() === lookalikeName.toLowerCase() &&
          a?.lookalike_spec?.ratio === args.lookalike_ratio &&
          a?.lookalike_spec?.country === args.lookalike_country &&
          originId === seed.audience!.id
        );
      });
      let lookalikeAudience: { id: string; name: string };
      if (existingLookalike) {
        lookalikeAudience = { id: existingLookalike.id, name: existingLookalike.name };
      } else {
        const lookalikeResult = await deps.manageMetaCustomAudiences(userId, 'CREATE', args.account_id, {
          name: lookalikeName,
          subtype: 'LOOKALIKE',
          lookalike_spec: {
            origin: [{ id: seed.audience!.id, type: 'custom_audience' }],
            ratio: args.lookalike_ratio,
            country: args.lookalike_country,
          },
          confirm: true,
        });
        if (!lookalikeResult.success) {
          rethrowStepFailure(lookalikeResult, 'Failed to create Lookalike Audience.');
        }
        lookalikeAudience = lookalikeResult.audience;
      }
      attachAudienceId = lookalikeAudience.id;
      lookalike = {
        id: lookalikeAudience.id,
        name: lookalikeAudience.name,
        ratio: args.lookalike_ratio,
        country: args.lookalike_country,
      };
    }

    const targeting: any = {
      ...(args.ad_set_params?.targeting || {}),
      custom_audiences: [{ id: attachAudienceId }],
    };
    if (workflow === 'retargeting') {
      targeting.excluded_custom_audiences = [{ id: args.exclude_audience_id }];
    }
    // Greptile finding: createMetaAdsAdSet defaults targeting_automation.
    // advantage_audience to 0 when the caller didn't set it (Meta requires
    // this field explicitly). It does this on its OWN local copy of
    // targeting, not the object passed in — so without applying the same
    // default here, comparing this `targeting` object against what Meta
    // actually stored (and returns via LIST) would always see a spurious
    // difference and never reuse, even for an identical retry.
    if (!targeting.targeting_automation || targeting.targeting_automation.advantage_audience === undefined) {
      targeting.targeting_automation = {
        ...(targeting.targeting_automation || {}),
        advantage_audience: 0,
      };
    }

    // Greptile finding: releasing the confirm token on a downstream
    // failure (e.g. Meta's ad-set-creation response lost/timed out even
    // though the write actually completed) lets a legitimate retry reuse
    // the same approved args — but createMetaAdsAdSet has no idempotency
    // of its own, so an unconditional retry would create a SECOND ad set,
    // duplicating delivery and spend from a single confirmation. Reuse an
    // existing same-named ad set targeting the same audience under this
    // campaign first, same reuse-by-match pattern as the lookalike fix.
    const adSetName = args.ad_set_params?.name;
    const existingAdSetsResult = await deps.listMetaAdsAdSets(userId, args.campaign_id, args.account_id);
    if (!existingAdSetsResult.success) {
      rethrowStepFailure(existingAdSetsResult, 'Failed to list existing Meta ad sets.');
    }
    // Greptile follow-up findings: name + targeted-audience alone isn't
    // enough — a same-named ad set targeting the same audience but with
    // ANY different delivery knob (budget, schedule, optimization goal,
    // billing event, bid strategy, destination type, promoted object, or
    // — for retargeting — excluded audience, which lives inside
    // `targeting`) must not be silently reused. The launch would report
    // success while actually applying the OLD delivery configuration
    // instead of the one the user just confirmed. Rather than keep
    // special-casing individual fields one Greptile pass at a time,
    // compares every field this method can even set on an ad set
    // (mirroring metaService's own AD_SET_READ_FIELDS list) generically —
    // any explicitly-requested field that differs from the existing ad
    // set's actual value blocks reuse.
    //
    // Greptile follow-up finding: comparing RAW requested values against
    // Meta's read-back values defeated reuse for the exact retry case this
    // exists to handle — createMetaAdsAdSet normalizes daily_budget/
    // lifetime_budget/bid_amount to cents (×100) and defaults bid_strategy/
    // destination_type when unset before calling Meta, so an identical
    // retry's RAW args never matched the normalized values Meta actually
    // stored. Applies the same normalization here before comparing.
    //
    // Greptile follow-up finding: two more createMetaAdsAdSet transforms
    // weren't mirrored — (1) daily_budget/lifetime_budget are stripped
    // entirely (not just left unconverted) when the campaign has
    // Advantage Campaign Budget (CBO), so a CBO retry's requested budget
    // must also normalize to "no budget" for comparison; (2) start_time is
    // auto-set to "now" at creation time for an ACTIVE ad set with no
    // explicit start_time — a value that can never be reproduced on a
    // later retry, so start_time is excluded from the comparison
    // entirely in exactly that case (any existing ACTIVE match on every
    // other field is accepted regardless of its actual start_time).
    const campaign = await self.getCampaignForAdSetReuseCheck(userId, args.account_id, args.campaign_id, {
      getMetaCredentials: deps.getMetaCredentials,
    });
    const campaignHasBudget = !!(campaign?.daily_budget || campaign?.lifetime_budget);

    const credentials = await deps.getMetaCredentials(userId, args.account_id);
    const money = await deps.normalizeMetaMoneyParams(credentials.accountId, credentials.accessToken, {
      ...args.ad_set_params,
      daily_budget: campaignHasBudget ? undefined : args.ad_set_params?.daily_budget,
      lifetime_budget: campaignHasBudget ? undefined : args.ad_set_params?.lifetime_budget,
    });
    const resolvedBidStrategy = args.ad_set_params?.bid_strategy || 'LOWEST_COST_WITHOUT_CAP';
    const resolvedDestinationType = args.ad_set_params?.destination_type === undefined &&
      META_WEBSITE_OPTIMIZATION_GOALS.includes(args.ad_set_params?.optimization_goal)
      ? 'WEBSITE'
      : args.ad_set_params?.destination_type;
    const normalizedRequestedAdSetParams: Record<string, any> = {
      ...args.ad_set_params,
      daily_budget: money.params.daily_budget,
      lifetime_budget: money.params.lifetime_budget,
      bid_amount: money.params.bid_amount,
      bid_strategy: resolvedBidStrategy,
      destination_type: resolvedDestinationType,
    };
    const startTimeIsUnreproducibleAutoFill = args.ad_set_params?.status === 'ACTIVE' && args.ad_set_params?.start_time === undefined;
    const AD_SET_REUSE_MATCH_FIELDS = (
      [
        'daily_budget', 'lifetime_budget', 'start_time', 'end_time',
        'optimization_goal', 'billing_event', 'bid_strategy', 'bid_amount',
        'destination_type', 'promoted_object', 'status',
      ] as const
    ).filter((field) => field !== 'start_time' || !startTimeIsUnreproducibleAutoFill);
    // Live-test finding against real Meta: the Graph API returns budget/bid
    // fields as STRINGS ("500"), while our normalized requested values are
    // numbers (500) — a strict canonicalJSON compare treated every
    // legitimate retry as a mismatch purely from JSON type, never numeric
    // value. Coerce these specific numeric-typed fields before comparing.
    const NUMERIC_AD_SET_FIELDS = new Set(['daily_budget', 'lifetime_budget', 'bid_amount']);
    const existingAdSet = (existingAdSetsResult.adSets || []).find((as: any) => {
      if (String(as?.name ?? '').toLowerCase() !== String(adSetName ?? '').toLowerCase()) return false;
      if (!isDeepSubset(targeting, as?.targeting)) return false;
      for (const field of AD_SET_REUSE_MATCH_FIELDS) {
        const requested = normalizedRequestedAdSetParams[field];
        if (requested === undefined) continue; // not explicitly requested — don't require a match on it
        let actual = as?.[field] ?? null;
        if (NUMERIC_AD_SET_FIELDS.has(field) && actual !== null) actual = Number(actual);
        if (canonicalJSON(actual) !== canonicalJSON(requested)) return false;
      }
      return true;
    });

    let adSet: { id: string; name: string };
    if (existingAdSet) {
      adSet = { id: existingAdSet.id, name: existingAdSet.name };
    } else {
      // ENG-2268 (D3 follow-up from ENG-2281): the launch_* tools build their ad set
      // outside callMetaMarketingApi, so they never passed the ENG-2280 burst shaper.
      // Score this write on the same shared per-account shaper; a burst refusal sends
      // nothing to Meta and surfaces as a step failure (preview token is released).
      const shape = metaWriteRateShaper.shapeWrite(String(args.account_id || 'unknown'), 'AD_SET', 'CREATE', undefined, args.ad_set_params);
      if (shape.kind === 'throttled') {
        rethrowStepFailure({ message: shape.message, code: 429 }, 'Meta write rate-shaped.');
      }
      const adSetResult = await deps.createMetaAdsAdSet(userId, {
        ...args.ad_set_params,
        account_id: args.account_id,
        campaign_id: args.campaign_id,
        targeting,
      });
      if (!adSetResult.success) {
        rethrowStepFailure(adSetResult, 'Failed to create ad set.');
      }
      adSet = adSetResult.adSet;
    }

    const ledger = {
      source: {
        type: source.type,
        identifier: source.type === 'hubspot_list' ? source.listId : source.csvUrl,
        recordsFound: seed.recordsFound,
        recordsUsable: seed.recordsUsable,
      },
      audience: { id: seed.audience!.id, name: seed.audience!.name, created: seed.created, subtype: 'CUSTOM' as const },
      lookalike,
      campaign: { id: args.campaign_id },
      adSet: {
        id: adSet.id,
        name: adSet.name,
        targetedAudienceId: attachAudienceId,
        excludedAudienceId: workflow === 'retargeting' ? args.exclude_audience_id : undefined,
      },
      failures: seed.failures.map((message: string) => ({ step: 'seed_audience_source', message })),
    };

    return {
      success: true,
      workflow,
      ledger,
      message: `Launched ${workflow} campaign: audience "${ledger.audience.name}" (${seed.created ? 'created' : 'reused'})` +
        `${lookalike ? `, lookalike "${lookalike.name}"` : ''} attached to ad set "${ledger.adSet.name}".`,
    };
}

/**
 * Shared implementation for launchTargetedAudienceCampaign / launchRetargetingCampaign
 * (ENG-600). Sources or reuses a Meta Custom Audience from a HubSpot list or CSV,
 * optionally creates a Lookalike from it, attaches it to a new ad set under an
 * existing campaign, and returns a completion ledger. Uses the same 2-phase
 * preview/confirm gate as call_meta_marketing_api's write actions
 * (buildMetaWriteConfirmation) — collectConfirmationPrompt halts the turn on any
 * result with awaitingUserConfirmation===true, regardless of which method produced it.
 */
export async function launchAudienceCampaign(
  userId: string,
  args: any,
  workflow: 'targeted_audience' | 'retargeting',
  deps: LaunchAudienceCampaignDeps,
): Promise<any> {
  try {
    assertMetaAccountAllowed(args.account_id);

    if (workflow === 'retargeting' && !args.exclude_audience_id) {
      throw new Error('exclude_audience_id is required for the retargeting workflow.');
    }
    if (args.use_lookalike) {
      if (args.lookalike_ratio === undefined || args.lookalike_ratio === null) {
        throw new Error('lookalike_ratio is required when use_lookalike is true (0.01-0.20). No default is applied.');
      }
      if (!args.lookalike_country) {
        throw new Error('lookalike_country is required when use_lookalike is true (2-letter ISO country code). No default is applied.');
      }
    }

    const source = resolveAudienceSourceArg(args.audience_source);
    const expectedPreviewToken = computeAudienceCampaignArgsDigest(args);
    const confirmAttempted = args.confirm === true;
    const tokenValid = args.preview_token === expectedPreviewToken;
    const tokenMatches = confirmAttempted && tokenValid;
    // Greptile P1 findings: (1) an HMAC-valid token was never consumed/
    // invalidated after use — replaying the exact same confirmed call would
    // silently re-execute (e.g. create a second ad set under the same
    // campaign) with no new user confirmation; (2) a separate check-then-mark
    // is non-atomic — two concurrent requests with the same valid token
    // could both read "not yet consumed" before either write became
    // visible. claimPreviewToken closes both: a single conditional DynamoDB
    // put lets only one caller ever win the claim, so "confirmed" here means
    // this exact call atomically claimed the token, not merely that the
    // token matches.
    const claimed = tokenMatches ? await claimPreviewToken(userId, args.preview_token) : false;
    const alreadyConsumed = tokenMatches && !claimed;
    const confirmed = claimed;

    if (!confirmed) {
      const plan = await self.resolveOrCreateSeedAudience(userId, args.account_id, args.audience_name, source, { dryRun: true }, {
        manageMetaCustomAudiences: deps.manageMetaCustomAudiences,
        resolveHubSpotService: deps.resolveHubSpotService,
      });
      const summary = buildAudienceCampaignConfirmationSummary(workflow, args, plan);
      // Distinguish "first preview, nothing attempted yet" from "confirm was
      // attempted but the token was missing/stale" from "confirm was
      // attempted with a token that was already used once" — each needs a
      // different explanation for why this falls back to a fresh preview.
      const staleNotice = alreadyConsumed
        ? 'This confirmation token was already used for a previous launch and cannot be reused — here is a fresh plan to confirm again. '
        : confirmAttempted
        ? 'The confirmation token was missing or no longer matches these arguments (they may have changed since the last preview), so this cannot execute yet — here is the CURRENT plan to confirm instead. '
        : '';
      return {
        success: true,
        requiresConfirmation: true,
        awaitingUserConfirmation: true,
        summary,
        previewToken: expectedPreviewToken,
        confirmationPrompt:
          `${staleNotice}Based on your request, here's the ${workflow === 'retargeting' ? 'retargeting' : 'targeted-audience'} campaign ` +
          `I'm about to launch — please check it's correct before I proceed:\n\n${summary}\n\n` +
          `Reply "yes" / "confirm" if this is correct, or tell me what to change.`,
        confirmationDetail: summary,
        message: `${staleNotice}Confirm this ${workflow} campaign launch before it runs: ${summary} Show the user the plan above ` +
          `and get explicit approval. Once approved, call this tool again with the EXACT SAME arguments plus confirm=true ` +
          `and preview_token="${expectedPreviewToken}" (copy it verbatim from this response — it will not match if you retype it or change any argument).`,
      };
    }

    // Greptile finding: once claimed, a failure anywhere below (reconciliation,
    // lookalike, ad-set creation) left the token permanently consumed — since
    // the digest is deterministic given the same args, re-previewing
    // unchanged arguments produces the SAME token, already claimed forever,
    // so the user could never retry the exact approved arguments. Releasing
    // the claim on failure lets a legitimate retry work, while the atomic
    // claim above still fully prevents concurrent double-execution.
    try {
      const result = await executeAudienceCampaignLaunch(userId, args, workflow, source, deps);
      // Greptile follow-up finding: without marking a successful launch's
      // token permanently consumed, the staleness override added for
      // failed-release retries also let a genuinely completed launch's
      // token be reclaimed and replayed after the staleness window.
      //
      // Greptile finding: a failure from THIS write must not be treated as
      // a launch failure — the external Meta mutations already completed
      // by this point. Letting it propagate into the catch below via
      // `throw` would report the completed launch as failed to the
      // caller, which is wrong regardless of what happens to the token.
      //
      // Greptile follow-up finding: after markPreviewTokenSucceeded
      // exhausts its own retries, silently leaving the claim dangling
      // "in_progress" made it reclaimable — and therefore replayable —
      // after the staleness window, with no bound on when that happens.
      // Explicitly releasing the claim here (same best-effort delete
      // releasePreviewToken already uses on a real failure) closes that
      // limbo state immediately instead of leaving it to staleness. This
      // is safe specifically because a resulting retry re-enters
      // executeAudienceCampaignLaunch's reuse-by-match logic (audience
      // name-match, lookalike spec-match, ad-set full-config-match — all
      // live-verified against real Meta) rather than a bare unconditional
      // re-execution: it finds and reuses the campaign/lookalike/ad set
      // this call already created instead of duplicating them, so the
      // worst case is a wasted extra LIST-and-compare pass, not duplicate
      // spend.
      try {
        await markPreviewTokenSucceeded(userId, args.preview_token);
      } catch (markError) {
        console.error('AgentMode: Failed to mark audience-campaign preview token as succeeded (launch itself succeeded) — releasing the claim so a retry can safely reuse the already-created resources:', markError);
        await releasePreviewToken(userId, args.preview_token);
      }
      return result;
    } catch (e) {
      await releasePreviewToken(userId, args.preview_token);
      throw e;
    }
  } catch (error: any) {
    return {
      success: false,
      workflow,
      ledger: { failures: [{ step: 'launch', message: error.message }] },
      message: error.message || `Failed to launch ${workflow} campaign.`,
      // ENG-1300: SDK-shaped error (metaService.handleError preserves .status) —
      // never a Meta business code.
      code: error?.status ?? error?.response?.status
    };
  }
}

/**
 * ENG-600: sources/reuses a Meta Custom Audience from a HubSpot list or CSV,
 * optionally builds a Lookalike from it, and attaches it to a new ad set under
 * an existing "targeted" campaign kept separate from any broad/control campaign.
 */
export async function launchTargetedAudienceCampaign(userId: string, args: any, deps: LaunchAudienceCampaignDeps): Promise<any> {
  return launchAudienceCampaign(userId, args, 'targeted_audience', deps);
}

/**
 * ENG-600: same audience-sourcing path as launchTargetedAudienceCampaign, but
 * requires exclude_audience_id (typically the broad/prospecting audience) so
 * retargeting spend structurally never overlaps prospecting spend.
 */
export async function launchRetargetingCampaign(userId: string, args: any, deps: LaunchAudienceCampaignDeps): Promise<any> {
  return launchAudienceCampaign(userId, args, 'retargeting', deps);
}

// ============================================================================
// 6. callLinkedInMarketingApi (+ exclusive helper getLinkedInAdsCredentials)
//    / callLinkedInAdsInsightsApi
// ============================================================================

async function getLinkedInAdsCredentials(userId: string, accountId?: string): Promise<{ accountId: string; accessToken: string; organizationUrn?: string; personUrn?: string }> {
  const { getAccountsWithOwnerIncludingOrgShared } = await import('../../services/connectedAccountsDb');
  // Include org-shared accounts so a teammate's LinkedIn Ads account that was
  // shared with the org (sharedWithOrg=true) is usable, not just visible. Each
  // account carries its owner userId so token refreshes hit the owner's record.
  const allAccounts = await getAccountsWithOwnerIncludingOrgShared(userId);
  const adsAccounts = allAccounts.filter(
    (acc) =>
      acc.platform === 'linkedin_ads' &&
      (acc.config as any)?.account_type === 'ad_account' &&
      (acc.config as any)?.access_token
  );

  if (adsAccounts.length === 0) {
    throw new Error('LinkedIn Ads account not connected. Please connect your LinkedIn Ads account in settings.');
  }

  let selected: typeof adsAccounts[number];
  if (accountId) {
    const match = adsAccounts.find((acc) => acc.account_id === accountId);
    if (!match) {
      throw new Error(`LinkedIn Ads account "${accountId}" not found. Check your connected accounts.`);
    }
    selected = match;
  } else if (adsAccounts.length > 1) {
    const list = adsAccounts.map((a) => `${a.account_name} (ID: ${a.account_id})`).join(', ');
    throw new Error(`Multiple LinkedIn Ads accounts found: [${list}]. Specify account_id.`);
  } else {
    selected = adsAccounts[0];
  }

  const cfg = selected.config as any;
  const now = Date.now();
  const bufferMs = 5 * 60 * 1000;

  if (cfg.token_expires_at && cfg.token_expires_at > now + bufferMs) {
    return { accountId: selected.account_id, accessToken: cfg.access_token, organizationUrn: cfg.organization_urn, personUrn: cfg.person_urn };
  }

  // Token expired or expiring soon — refresh it
  if (!cfg.refresh_token) {
    throw new Error('LinkedIn Ads access token expired and no refresh token available. Please reconnect your account.');
  }

  const { getLinkedInAdsConfig } = await import('../../config/integrations');
  const oauthConfig = await getLinkedInAdsConfig();

  const newTokens = await linkedInAdsService.refreshAccessToken(
    cfg.refresh_token,
    oauthConfig.clientId,
    oauthConfig.clientSecret
  );

  // Write refreshed tokens back to the OWNER's record (selected.userId), not the
  // caller's — for org-shared accounts these differ. Scope the update to the
  // specific account_id so we don't clobber a different linkedin_ads account.
  const { updateAccountTokens } = await import('../../services/connectedAccountsDb');
  await updateAccountTokens(selected.userId, 'linkedin_ads' as any, {
    access_token: newTokens.access_token,
    refresh_token: newTokens.refresh_token,
    token_expires_at: Date.now() + newTokens.expires_in * 1000,
  }, selected.account_id);

  return { accountId: selected.account_id, accessToken: newTokens.access_token, organizationUrn: cfg.organization_urn, personUrn: cfg.person_urn };
}

/**
 * Master method for LinkedIn Ads entity management (campaigns, creatives, targeting, etc.)
 */
/**
 * ENG-3064: a LinkedIn update that was accepted but did not read back is returned to the tool
 * as a typed failure (same shape as the Google path), never thrown into a generic error and
 * never relayed as success.
 */
function linkedInReadBackFailure(result: linkedInAdsService.LinkedInAdsApiResult) {
  if (result.success || !result.errorType) return null;
  return { success: false, errorType: result.errorType, errorCode: result.errorType, fields: result.fields, error: result.error };
}

/** The largest file call_linkedin_marketing_api downloads to upload to LinkedIn (LinkedIn's own limits are at or above these). */
export const LINKEDIN_UPLOAD_MAX_BYTES = { image: 20 * 1024 * 1024, document: 100 * 1024 * 1024, video: 200 * 1024 * 1024 } as const;

export async function callLinkedInMarketingApi(
  userId: string,
  entity_type: 'AD_ACCOUNT' | 'CAMPAIGN_GROUP' | 'CAMPAIGN' | 'CREATIVE' | 'POST' | 'TARGETING' | 'MEDIA' | 'INMAIL' | 'CONVERSATION_AD',
  action: string,
  account_id: string,
  params: any = {}
): Promise<any> {
  console.log(`AgentMode: callLinkedInMarketingApi -> ${entity_type} / ${action}`);

  const { accountId, accessToken, organizationUrn, personUrn } = await getLinkedInAdsCredentials(userId, account_id);

  switch (entity_type) {
    case 'AD_ACCOUNT': {
      if (action === 'LIST') {
        const result = await linkedInAdsService.listAdAccounts(accessToken);
        if (!result.success) throw new Error(result.error || 'Failed to list ad accounts');
        return { success: true, adAccounts: result.data?.elements || [] };
      }
      throw new Error(`Unknown action "${action}" for AD_ACCOUNT`);
    }

    case 'CAMPAIGN_GROUP': {
      if (action === 'LIST') {
        const result = await linkedInAdsService.listCampaignGroups(accessToken, accountId, params);
        if (!result.success) throw new Error(result.error || 'Failed to list campaign groups');
        return { success: true, campaignGroups: result.data?.elements || [] };
      }
      if (action === 'CREATE') {
        const result = await linkedInAdsService.createCampaignGroup(accessToken, accountId, params);
        if (!result.success) throw new Error(result.error || 'Failed to create campaign group');
        return { success: true, message: 'Campaign group created', campaignGroup: result.data };
      }
      if (action === 'UPDATE') {
        if (!params.campaign_group_id) throw new Error('UPDATE requires campaign_group_id');
        const result = await linkedInAdsService.updateCampaignGroup(accessToken, accountId, params.campaign_group_id, params);
        const readBackFailure = linkedInReadBackFailure(result);
        if (readBackFailure) return readBackFailure;
        if (!result.success) throw new Error(result.error || 'Failed to update campaign group');
        return { success: true, message: 'Campaign group updated', result: result.data };
      }
      throw new Error(`Unknown action "${action}" for CAMPAIGN_GROUP`);
    }

    case 'CAMPAIGN': {
      if (action === 'LIST') {
        const result = await linkedInAdsService.listCampaigns(accessToken, accountId, params);
        if (!result.success) throw new Error(result.error || 'Failed to list campaigns');
        return { success: true, campaigns: result.data?.elements || [] };
      }
      if (action === 'CREATE') {
        const result = await linkedInAdsService.createCampaign(accessToken, accountId, params);
        if (!result.success) throw new Error(result.error || 'Failed to create campaign');
        return { success: true, message: 'Campaign created', campaign: result.data };
      }
      if (action === 'UPDATE') {
        if (!params.campaign_id) throw new Error('UPDATE requires campaign_id');
        const result = await linkedInAdsService.updateCampaign(accessToken, accountId, params.campaign_id, params);
        const readBackFailure = linkedInReadBackFailure(result);
        if (readBackFailure) return readBackFailure;
        if (!result.success) throw new Error(result.error || 'Failed to update campaign');
        return { success: true, message: 'Campaign updated', result: result.data };
      }
      throw new Error(`Unknown action "${action}" for CAMPAIGN`);
    }

    case 'CREATIVE': {
      if (action === 'LIST') {
        if (!params.campaign_id) throw new Error('LIST creatives requires params.campaign_id');
        const result = await linkedInAdsService.listCreatives(accessToken, accountId, params.campaign_id);
        if (!result.success) throw new Error(result.error || 'Failed to list creatives');
        const rawCreatives: any[] = result.data?.elements || [];
        // ENG-239: a content.reference creative only carries a bare post URN
        // pointer -- expand it with the referenced post's own fields
        // (contentLandingPage etc) so a caller can see the actual destination
        // without a manual follow-up POST/GET per creative. A failed read
        // (e.g. deleted post) degrades to the bare creative rather than
        // failing the whole LIST.
        const creatives = await Promise.all(rawCreatives.map(async (creative) => {
          const postUrn = creative?.content?.reference;
          if (!postUrn) return creative;
          const postResult = await linkedInAdsService.getPost(accessToken, postUrn);
          return postResult.success ? { ...creative, referencedPost: postResult.data } : creative;
        }));
        return { success: true, creatives };
      }
      if (action === 'CREATE') {
        if (!params.campaign_id) throw new Error('CREATE creative requires params.campaign_id');
        const result = await linkedInAdsService.createCreative(accessToken, { ...params, ad_account_id: accountId });
        if (!result.success) throw new Error(result.error || 'Failed to create creative');
        return { success: true, message: 'Creative created', creative: result.data };
      }
      if (action === 'CREATE_INLINE') {
        if (!params.campaign_id) throw new Error('CREATE_INLINE requires campaign_id');
        if (!organizationUrn) throw new Error('Could not determine organization URN. Please reconnect your LinkedIn Ads account.');
        const result = await linkedInAdsService.createCreativeInline(accessToken, {
          ...params,
          ad_account_id: accountId,
          author_urn: organizationUrn,
        });
        if (!result.success) throw new Error(result.error || 'Failed to create inline creative');
        return { success: true, message: 'Creative and post created in one step', creative: result.data };
      }
      if (action === 'CREATE_DYNAMIC') {
        // Dynamic Ads: Jobs, Spotlight, Follower — campaign type must be DYNAMIC
        if (!params.campaign_id) throw new Error('CREATE_DYNAMIC requires campaign_id');
        if (!params.format) throw new Error('CREATE_DYNAMIC requires format (JOBS|SPOTLIGHT|FOLLOW_COMPANY)');
        const result = await linkedInAdsService.createDynamicCreative(accessToken, accountId, params);
        if (!result.success) throw new Error(result.error || 'Failed to create dynamic creative');
        return { success: true, message: 'Dynamic creative created', creative: result.data };
      }
      if (action === 'RETAG_UTM') {
        // ENG-239 retrofit: retags ONE existing creative, never a list.
        // LIVE-VERIFIED 2026-07-16 for textAd creatives — see retagCreativeUtm's docstring
        // for the $set-is-not-a-deep-merge caveat and the content.reference delegation.
        if (!params.creative_id) throw new Error('RETAG_UTM requires creative_id');
        if (!params.campaign_id) throw new Error('RETAG_UTM requires campaign_id');
        const result = await linkedInAdsService.retagCreativeUtm(accessToken, accountId, params.creative_id, params.campaign_id);
        const readBackFailure = linkedInReadBackFailure(result);
        if (readBackFailure) return readBackFailure;
        if (!result.success) throw new Error(result.error || 'Failed to retag creative UTMs');
        if (result.alreadyTagged) return { success: true, message: 'Creative already carries every UTM key — no change made.' };
        return { success: true, message: 'Creative retagged with UTMs' };
      }
      if (action === 'UPDATE') {
        // ENG-2575: status change only (pause / resume / archive).
        if (!params.creative_id) throw new Error('CREATIVE UPDATE requires params.creative_id');
        const allowed = linkedInAdsService.CREATIVE_INTENDED_STATUSES as readonly string[];
        const status = typeof params.status === 'string' ? params.status.trim().toUpperCase() : '';
        if (!allowed.includes(status)) {
          throw new Error(`CREATIVE UPDATE requires params.status, one of: ${allowed.join(', ')}`);
        }
        const result = await linkedInAdsService.updateCreativeStatus(accessToken, accountId, String(params.creative_id), status);
        const readBackFailure = linkedInReadBackFailure(result);
        if (readBackFailure) return readBackFailure;
        if (!result.success) throw new Error(result.error || 'Failed to update creative');
        return { success: true, message: `Ad status set to ${status}`, result: result.data };
      }
      throw new Error(`Unknown action "${action}" for CREATIVE`);
    }

    case 'POST': {
      if (action === 'CREATE') {
        const feedDistribution = params.feed_distribution || 'NONE';
        if (!organizationUrn) throw new Error('Could not determine author_urn. Please reconnect your LinkedIn Ads account.');
        const postParams = { ...params, author_urn: organizationUrn, ad_account_id: accountId };
        // MAIN_FEED requires w_organization_social scope — reconnect LinkedIn Ads account if 403
        const result = await linkedInAdsService.createPost(accessToken, postParams);
        if (!result.success) throw new Error(result.error || 'Failed to create post');
        const postUrn = result.data?.id;
        const postType = feedDistribution === 'MAIN_FEED' ? 'Company page post' : 'Dark post';
        const postUrl = postUrn ? `https://www.linkedin.com/feed/update/${encodeURIComponent(postUrn)}/` : undefined;
        return { success: true, message: `${postType} created. Use post_urn as reference in CREATIVE/CREATE.`, post_urn: postUrn, post_url: postUrl, post: result.data };
      }
      if (action === 'GET') {
        if (!params.post_urn) throw new Error('POST GET requires params.post_urn');
        const result = await linkedInAdsService.getPost(accessToken, params.post_urn);
        if (!result.success) throw new Error(result.error || 'Failed to get post');
        return { success: true, post: result.data };
      }
      throw new Error(`Unknown action "${action}" for POST`);
    }

    case 'TARGETING': {
      if (action === 'LIST_FACETS') {
        const result = await linkedInAdsService.listTargetingFacets(accessToken);
        if (!result.success) throw new Error(result.error || 'Failed to list targeting facets');
        return { success: true, facets: result.data?.elements || [] };
      }
      if (action === 'SEARCH') {
        if (!params.facet) throw new Error('SEARCH requires facet');
        const result = await linkedInAdsService.searchTargetingEntities(accessToken, { facet_urn: params.facet, query: params.query });
        if (!result.success) throw new Error(result.error || 'Failed to search targeting entities');
        return { success: true, entities: result.data?.elements || [] };
      }
      if (action === 'ESTIMATE_REACH') {
        // Accept the same targeting shapes as CAMPAIGN CREATE: the flat
        // targeting_include/targeting_exclude arrays (preferred) or a raw targeting_criteria object.
        const targetingCriteria = linkedInAdsService.resolveTargetingCriteria(params);
        if (!targetingCriteria) {
          throw new Error('ESTIMATE_REACH requires targeting: pass targeting_include (array of { facet_urn, values }) or targeting_criteria.');
        }
        const result = await linkedInAdsService.getAudienceCount(accessToken, targetingCriteria);
        if (!result.success) throw new Error(result.error || 'Failed to estimate audience reach');
        return { success: true, audienceCount: result.data };
      }
      throw new Error(`Unknown action "${action}" for TARGETING`);
    }

    case 'MEDIA': {
      // The file to upload, read safely (ENG-2840): a file of OUR bucket (a chat upload) only when the storage rule lets this caller read
      // that key, read through the SDK with a byte ceiling; any other URL only through the SSRF-guarded fetch, with a byte ceiling and a
      // time limit. Before, any key of our bucket was presigned for any caller and any URL was fetched with no guard, size cap or timeout.
      const downloadForUpload = async (url: unknown, field: string, maxBytes: number, timeoutMs: number): Promise<{ buffer: Buffer; contentType: string }> => {
        if (typeof url !== 'string' || !url.trim()) throw new Error(`${field} must be a URL`);
        const tooLarge = () => new Error(`${field}: the file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, the most that can be uploaded here`);
        const { isS3Url, extractS3KeyFromUrl, getS3ObjectAsBuffer } = await import('../../utils/s3Utils');
        if (isS3Url(url)) {
          const key = extractS3KeyFromUrl(url);
          const { checkOurBucketKeyRead, TOOL_FILE_REFUSAL_MESSAGE, TOOL_FILE_UNAVAILABLE_MESSAGE } = await import('./toolStorageAccess');
          const decision = key ? await checkOurBucketKeyRead('call_linkedin_marketing_api', userId, key) : 'refuse';
          if (decision !== 'allow') throw new Error(decision === 'unavailable' ? TOOL_FILE_UNAVAILABLE_MESSAGE : TOOL_FILE_REFUSAL_MESSAGE);
          try {
            const { buffer, contentType } = await getS3ObjectAsBuffer(key as string, undefined, maxBytes);
            return { buffer, contentType: contentType || '' };
          } catch (err: any) {
            if (/exceeds the .* limit/.test(String(err?.message || ''))) throw tooLarge();
            throw err;
          }
        }
        const { fetchCallerUrlBuffer, CallerUrlTooLargeError } = await import('../../utils/callerUrlFetch');
        try {
          const fetched = await fetchCallerUrlBuffer(url, { tool: 'call_linkedin_marketing_api', userId, maxBytes, timeoutMs });
          return { buffer: fetched.buffer, contentType: fetched.contentType || '' };
        } catch (err: any) {
          if (err instanceof CallerUrlTooLargeError) throw tooLarge();
          throw err;
        }
      };

      if (action === 'UPLOAD_IMAGE') {
        if (!params.image_url) throw new Error('UPLOAD_IMAGE requires image_url (a public URL to the image)');
        const ownerUrn = organizationUrn || `urn:li:sponsoredAccount:${accountId}`;
        // Step 1: initialize upload to get signed URL + image URN
        const initResult = await linkedInAdsService.initializeImageUpload(accessToken, ownerUrn);
        if (!initResult.success) throw new Error(initResult.error || 'Failed to initialize image upload');
        const uploadUrl: string = initResult.data?.value?.uploadUrl || initResult.data?.uploadUrl;
        const imageUrn: string = initResult.data?.value?.image || initResult.data?.image;
        if (!uploadUrl || !imageUrn) throw new Error('LinkedIn did not return uploadUrl or image URN');
        // Step 2: download the image (presign if S3 URL) and PUT to LinkedIn's signed URL
        const image = await downloadForUpload(params.image_url, 'image_url', LINKEDIN_UPLOAD_MAX_BYTES.image, 60_000);
        const contentType = image.contentType || 'image/jpeg';
        await linkedInAdsService.uploadImageBinary(uploadUrl, image.buffer, contentType);
        return { success: true, image_urn: imageUrn, message: 'Image uploaded to LinkedIn. Use image_urn in CREATIVE/CREATE_INLINE.' };
      }
      if (action === 'UPLOAD_VIDEO') {
        // Convenience action: download video from URL, auto-detect size, handle full upload flow.
        // Emma never asks the user for file_size — it's derived from the downloaded buffer.
        if (!params.video_url) throw new Error('UPLOAD_VIDEO requires video_url (a public URL to the video file)');
        const ownerUrn = organizationUrn || `urn:li:sponsoredAccount:${accountId}`;
        // Step 1: download the video (a chat upload of the caller's own, or a public URL), bounded
        const videoBuffer = (await downloadForUpload(params.video_url, 'video_url', LINKEDIN_UPLOAD_MAX_BYTES.video, 180_000)).buffer;
        const fileSizeBytes = videoBuffer.length;
        // Step 2: initialize upload — fileSizeBytes auto-calculated from buffer
        const initResult = await linkedInAdsService.initializeVideoUpload(accessToken, ownerUrn, fileSizeBytes);
        if (!initResult.success) throw new Error(initResult.error || 'Failed to initialize video upload');
        const uploadInstructions: any[] = initResult.data?.value?.uploadInstructions || [];
        const videoUrn: string = initResult.data?.value?.video || initResult.data?.video;
        const uploadToken: string = initResult.data?.value?.uploadToken || '';
        if (!videoUrn) throw new Error('LinkedIn did not return video URN');
        // Step 3: upload each part, collect ETag from each response (required for finalize)
        const uploadedPartIds: string[] = [];
        for (const instruction of uploadInstructions) {
          const partStart: number = instruction.firstByte ?? 0;
          const partEnd: number = instruction.lastByte ?? fileSizeBytes - 1;
          const partBuffer = videoBuffer.slice(partStart, partEnd + 1);
          const etag = await linkedInAdsService.uploadVideoPart(instruction.uploadUrl, partBuffer);
          uploadedPartIds.push(etag);
        }
        // Step 4: finalize — pass uploadToken and ETags from part uploads
        const finalizeResult = await linkedInAdsService.finalizeVideoUpload(accessToken, videoUrn, uploadToken, uploadedPartIds);
        if (!finalizeResult.success) throw new Error(finalizeResult.error || 'Failed to finalize video upload');
        return { success: true, video_urn: videoUrn, message: 'Video uploaded to LinkedIn. Use video_urn in CREATIVE/CREATE_INLINE.' };
      }
      if (action === 'UPLOAD_DOCUMENT') {
        // Convenience action: download document from URL and upload to LinkedIn.
        if (!params.document_url) throw new Error('UPLOAD_DOCUMENT requires document_url (a public URL to the document, e.g. PDF)');
        const ownerUrn = organizationUrn || `urn:li:sponsoredAccount:${accountId}`;
        // Step 1: download the document (a chat upload of the caller's own, or a public URL), bounded
        const doc = await downloadForUpload(params.document_url, 'document_url', LINKEDIN_UPLOAD_MAX_BYTES.document, 120_000);
        const docBuffer = doc.buffer;
        const contentType = doc.contentType || 'application/pdf';
        // Step 2: initialize upload
        const initResult = await linkedInAdsService.initializeDocumentUpload(accessToken, ownerUrn);
        if (!initResult.success) throw new Error(initResult.error || 'Failed to initialize document upload');
        const docUploadUrl: string = initResult.data?.value?.uploadUrl || initResult.data?.uploadUrl;
        const documentUrn: string = initResult.data?.value?.document || initResult.data?.document;
        if (!docUploadUrl || !documentUrn) throw new Error('LinkedIn did not return uploadUrl or document URN');
        // Step 3: upload binary
        await linkedInAdsService.uploadDocumentBinary(docUploadUrl, docBuffer, contentType);
        return { success: true, document_urn: documentUrn, message: 'Document uploaded to LinkedIn. Use document_urn in POST/CREATE.' };
      }
      if (action === 'INIT_IMAGE_UPLOAD') {
        const ownerUrn = organizationUrn || `urn:li:sponsoredAccount:${accountId}`;
        const result = await linkedInAdsService.initializeImageUpload(accessToken, ownerUrn);
        if (!result.success) throw new Error(result.error || 'Failed to initialize image upload');
        return { success: true, uploadInstructions: result.data };
      }
      if (action === 'INIT_VIDEO_UPLOAD') {
        if (!params.file_size) throw new Error('INIT_VIDEO_UPLOAD requires file_size');
        const ownerUrn = organizationUrn || `urn:li:sponsoredAccount:${accountId}`;
        const result = await linkedInAdsService.initializeVideoUpload(accessToken, ownerUrn, params.file_size);
        if (!result.success) throw new Error(result.error || 'Failed to initialize video upload');
        return { success: true, uploadInstructions: result.data };
      }
      if (action === 'FINALIZE_VIDEO') {
        if (!params.video_urn) throw new Error('FINALIZE_VIDEO requires video_urn');
        const result = await linkedInAdsService.finalizeVideoUpload(accessToken, params.video_urn);
        if (!result.success) throw new Error(result.error || 'Failed to finalize video upload');
        return { success: true, result: result.data };
      }
      throw new Error(`Unknown action "${action}" for MEDIA`);
    }

    case 'INMAIL': {
      if (action === 'CREATE_CONTENT') {
        // Use person URN from connected account (captured at OAuth time). If missing, user needs to reconnect.
        const sender = params.sender || personUrn;
        if (!sender) throw new Error('Could not determine sender person URN. Please reconnect your LinkedIn Ads account to capture your person URN.');
        const result = await linkedInAdsService.createInMailContent(accessToken, { ...params, sender, ad_account_id: accountId });
        if (!result.success) throw new Error(result.error || 'Failed to create InMail content');
        const inmailUrn = result.data?.id;
        return { success: true, message: 'InMail content created. Use inmail_content_urn in CREATIVE/CREATE.', inmail_content_urn: inmailUrn, data: result.data };
      }
      if (action === 'SEND_TEST') {
        if (!params.inmail_content_urn) throw new Error('SEND_TEST requires inmail_content_urn');
        if (!params.recipient_email) throw new Error('SEND_TEST requires recipient_email');
        const result = await linkedInAdsService.sendTestInMail(accessToken, params.inmail_content_urn, params.recipient_email);
        if (!result.success) throw new Error(result.error || 'Failed to send test InMail');
        return { success: true, message: 'Test InMail sent successfully', data: result.data };
      }
      throw new Error(`Unknown action "${action}" for INMAIL`);
    }

    case 'CONVERSATION_AD': {
      if (action === 'CREATE') {
        const result = await linkedInAdsService.createConversationAd(accessToken, accountId, params);
        if (!result.success) throw new Error(result.error || 'Failed to create conversation ad');
        const conversationAdUrn = result.data?.id;
        return { success: true, message: 'Conversation ad created. Add message nodes with CONVERSATION_AD/CREATE_CONTENT, then set the first node with CONVERSATION_AD/SET_FIRST_CONTENT.', conversation_ad_urn: conversationAdUrn, data: result.data };
      }
      if (action === 'CREATE_CONTENT') {
        if (!params.conversation_ad_urn) throw new Error('CONVERSATION_AD CREATE_CONTENT requires conversation_ad_urn');
        if (!params.body) throw new Error('CONVERSATION_AD CREATE_CONTENT requires body (message text)');
        if (!params.buttons || !Array.isArray(params.buttons) || params.buttons.length === 0) throw new Error('CONVERSATION_AD CREATE_CONTENT requires buttons array');
        const result = await linkedInAdsService.createConversationAdContent(accessToken, params.conversation_ad_urn, params);
        if (!result.success) throw new Error(result.error || 'Failed to create conversation ad content');
        const contentUrn = result.data?.id;
        return { success: true, message: 'Message node added to conversation ad', content_urn: contentUrn, data: result.data };
      }
      if (action === 'SET_FIRST_CONTENT') {
        if (!params.conversation_ad_urn) throw new Error('SET_FIRST_CONTENT requires conversation_ad_urn');
        if (!params.first_content_urn) throw new Error('SET_FIRST_CONTENT requires first_content_urn');
        const result = await linkedInAdsService.setConversationAdFirstContent(accessToken, params.conversation_ad_urn, params.first_content_urn);
        if (!result.success) throw new Error(result.error || 'Failed to set first content');
        return { success: true, message: 'First message node set. Conversation ad is ready. Create a CREATIVE with inmail_content_urn = conversation_ad_urn.' };
      }
      throw new Error(`Unknown action "${action}" for CONVERSATION_AD`);
    }

    default:
      throw new Error(`Invalid entity_type: ${entity_type}`);
  }
}

/**
 * LinkedIn Ads analytics — synchronous (no polling needed unlike Meta).
 */
export async function callLinkedInAdsInsightsApi(
  userId: string,
  account_id: string,
  params: {
    pivot: string;
    dateRange: { start: { year: number; month: number; day: number }; end: { year: number; month: number; day: number } };
    timeGranularity?: string;
    fields?: string[];
    campaign_groups?: string[];
    campaigns?: string[];
    adGroups?: string[];
    creatives?: string[];
  }
): Promise<any> {
  console.log(`AgentMode: callLinkedInAdsInsightsApi -> pivot=${params.pivot}`);

  const { accountId: resolvedAccountId, accessToken } = await getLinkedInAdsCredentials(userId, account_id);

  const result = await linkedInAdsService.getAdAnalytics(
    accessToken,
    resolvedAccountId,
    params.pivot,
    params.timeGranularity || 'ALL',
    params.dateRange,
    params.fields || ['impressions', 'clicks', 'costInLocalCurrency'],
    { campaign_group_ids: params.campaign_groups, campaign_ids: params.campaigns, creative_ids: params.creatives }
  );
  if (!result.success) {
    throw new Error(result.error || 'LinkedIn Ads API request failed');
  }
  return { success: true, analytics: result.data?.elements || result.data };
}
