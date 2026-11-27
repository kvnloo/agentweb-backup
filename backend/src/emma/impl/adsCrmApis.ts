/**
 * ENG-2103 (F2) — Google Ads + HubSpot/Attio CRM passthrough API tool
 * cluster, extracted from `AgentModeService`. Cluster 19 in this series,
 * combining two originally-separate planned clusters ("Google ads" and
 * "CRM APIs") since scoping found them contiguous and both clean of
 * `this.callLLM` coupling — one small module is simpler than two.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 *   - `handleCallGoogleAdsApi` (public, ~21793-22527 pre-extraction)
 *   - `handleCallGoogleAdsReportingApi` (public, ~22528-22581)
 *   - `resolveHubSpotService` (private, ~22585-22605)
 *   - `handleHubspotApi` (public, ~22607-23039)
 *
 * `handleAttioApi` is NOT moved here. Its actual body already lives in
 * `services/agentMode/attioTools.ts` — a pre-existing, self-contained
 * extraction ("no dependency on AgentModeService instance state", per its
 * own doc comment) that predates this F2 series entirely.
 * `AgentModeService.prototype.handleAttioApi` was already nothing more than
 * a one-line delegate to it (`return handleAttioApiImpl(userId, args)`)
 * before this cluster started. Re-exported from here unchanged so
 * `emma/tools.ts` gets one uniform `adsCrmApisImpl.*` import for the whole
 * cluster, matching this series' established shape — this is a re-export,
 * not a second copy of the implementation.
 *
 * Six private helpers, found by whole-backend grep to be exclusive to the
 * two Google Ads methods (no callers anywhere else in the backend, not even
 * in tests — confirmed with `grep -rn` for each name), moved alongside them
 * as plain module-scope functions rather than kept on the class:
 *   - `enforceGoogleAdsLaunchGate` (~21459-21471)
 *   - `resolveGoogleAdsCredentialScope` (~21505-21549)
 *   - `checkGoogleAdsPausedChildren` (~21551-21584)
 *   - `guardCreativeAddition` (~21620-21719)
 *   - `enforceGoogleAdsCreativeAdditionGate` (~21721-21734)
 *   - `runGoogleAdsTrackingGate` (~21741-21791)
 * Plus a seventh, `makeGoogleAdsAuthError` (~21483-21487), a tiny
 * `(message: string) => Error` helper used only by
 * `resolveGoogleAdsCredentialScope`, also confirmed exclusive (its
 * `isGoogleAdsAuthError` marker property is checked elsewhere, but the
 * *function itself* is called nowhere outside this cluster). All seven are
 * physically adjacent, immediately preceding `handleCallGoogleAdsApi` in the
 * original file — this was a genuinely contiguous cluster once you fold in
 * its private helpers, unlike cluster 18's scattered shape. Their internal
 * `this.foo(...)` cross-calls (enforceGoogleAdsLaunchGate ->
 * runGoogleAdsTrackingGate, enforceGoogleAdsCreativeAdditionGate ->
 * runGoogleAdsTrackingGate, guardCreativeAddition ->
 * enforceGoogleAdsCreativeAdditionGate, resolveGoogleAdsCredentialScope ->
 * makeGoogleAdsAuthError) are now plain same-module function calls — no
 * injected-parameter machinery needed, since every caller and callee in this
 * chain moved together as one unit.
 *
 * DELETED outright from the class (zero callers anywhere beyond this
 * cluster, confirmed by whole-backend grep including `__tests__/`): all
 * seven helpers above. None is a delegating-wrapper candidate — nothing
 * calls `service.enforceGoogleAdsLaunchGate(...)` etc. directly; every test
 * exercises them indirectly through `handleCallGoogleAdsApi`/
 * `handleCallGoogleAdsReportingApi`.
 *
 * Kept as delegating wrappers on `AgentModeService` (real callers beyond
 * `emma/tools.ts`, found by grepping the whole backend):
 *   - `handleCallGoogleAdsApi`: ~10 test files call the real instance method
 *     directly (`googleAdsLaunchGate.test.ts`, `googleAdsTools.test.ts`,
 *     `eng1526.googleOverrideBinding.test.ts`,
 *     `eng1944.googleAdsPausedChildren.test.ts`,
 *     `eng1944.googleAdsClientScope.test.ts`, `eng1527.droppedParams.test.ts`,
 *     `eng1322.removalLoop.test.ts`, `agentMode.offlineConversionHandler.test.ts`).
 *   - `handleCallGoogleAdsReportingApi`: `eng1944.googleAdsClientScope.test.ts`
 *     and `googleAdsTools.test.ts` call the real instance method directly.
 *   - `resolveHubSpotService`: a REAL cross-cluster dependency, not just a
 *     test spy — `resolveOrCreateSeedAudience` (already extracted to
 *     `emma/impl/adsApis.ts` in cluster 18, but kept UNMOVED on the class
 *     there for its own spy-conflict reason) calls
 *     `this.resolveHubSpotService(userId, source.hubspotAccountId)` for its
 *     `hubspot_list` audience-source branch (agentModeService.ts ~17058).
 *     `agentModeService.audienceCampaignWorkflows.test.ts` additionally
 *     `jest.spyOn`s this method directly (13 times) to stub that branch
 *     while testing the audience-campaign workflow, independent of anything
 *     in this cluster. Both requirements are satisfied by the SAME
 *     delegating wrapper: `resolveOrCreateSeedAudience`'s existing
 *     `this.resolveHubSpotService(...)` call keeps going through the
 *     class's own method (spy-observable), which now simply forwards to
 *     this module's implementation.
 *   - `handleHubspotApi`: `agentModeService.hubspotCampaigns.test.ts` and
 *     `agentModeService.hubspotMarketing.test.ts` call the real instance
 *     method directly, many times each.
 *   - `handleAttioApi`: unchanged (see above) — already a wrapper,
 *     `agentModeService.attioApi.test.ts` calls it directly.
 *
 * `emma/tools.ts` repointed to call this module directly for all 5 tools
 * (`call_google_ads_api`, `call_google_ads_reporting_api`, `call_hubspot_api`,
 * `call_attio_api`) — the class's own wrappers above exist only for the
 * real callers named next to each one, not for `emma/tools.ts` anymore.
 *
 * Transitive-import notes:
 *   - `googleAdsService` (`../../services/googleAdsService`), `HubSpotService`
 *     (`../../services/hubspotService`), `preflightTrackingGate`
 *     (`../../services/googleAdsTrackingPreflight`),
 *     `validateNegativeCampaignCriteria`/`NegativeCampaignCriteriaValidationError`
 *     (`../../services/googleAdsCampaignCriteria`), and `getJwtSecret`
 *     (`../../config/jwt`) are all STATIC imports here, exactly matching how
 *     `agentModeService.ts` already imported every one of them. None of
 *     these four service/util modules imports `chatbotService.ts`,
 *     `settingsService.ts`, `orgProfileResolver.ts`,
 *     `brandGuidelinesPopulation.ts`, or `agentModeService.ts` — confirmed by
 *     reading each one's own import list directly, not assumed.
 *   - `googleAdsService.ts`/`HubSpotService`/(Attio's own file, untouched
 *     here) DO transitively reach `services/db.ts` via
 *     `services/connectedAccountsDb.ts` (`import { userDb } from './db'`).
 *     This is a real, unavoidable production dependency — looking up a
 *     connected account's credentials inherently needs the accounts table —
 *     not the "avoid dragging in the monolith" trap the extraction brief
 *     warns about, and it is NOT new: `agentModeService.ts` already
 *     statically imports both `googleAdsService.ts` and `hubspotService.ts`
 *     today, so this DynamoDB-client construction already happens on every
 *     load of the current file. Disclosed, not fixed, same treatment
 *     cluster 18 gave its analogous `metaLaunchGate.ts` finding.
 *   - `chatbotDb.recordGoogleAdsMeasurementCheck` (used by
 *     `guardCreativeAddition` and `runGoogleAdsTrackingGate`) WAS a static
 *     top-level import in the original file
 *     (`import { chatbotDb, ... } from './chatbotService'`) —
 *     `chatbotService.ts` is one of the four named traps (it top-level
 *     imports `agentModeService.ts` back, circular, and constructs a real
 *     `AWS.DynamoDB.DocumentClient` at module load). Lazily `require`'d here
 *     instead, the same idiom `emma/impl/workPlans.ts`/`gtmPlans.ts`
 *     established for the identical dependency.
 *   - `computeTrackingOverrideDigest`/`trackingOverrideTokenMatches` (used by
 *     `handleCallGoogleAdsApi`) WERE static top-level imports from
 *     `./metaLaunchGate` in the original file. `metaLaunchGate.ts` itself
 *     statically imports `chatbotDb` from `services/chatbotService.ts`
 *     (confirmed by cluster 18's own probe), so it carries the exact same
 *     trap one hop further out. Cluster 18 kept it static there because
 *     `metaLaunchGate.ts` is infrastructure `adsApis.ts` already shares with
 *     ~20 other callers and `agentModeService.ts` was already loading it
 *     unconditionally regardless. This module has no such pre-existing
 *     reliance, so — unlike cluster 18 — these two functions are lazily
 *     `require`'d here too, keeping this module genuinely free of the
 *     `chatbotService.ts` -> `agentModeService.ts` chain at load time rather
 *     than merely matching precedent. Verified with a module-isolation test
 *     (see `adsCrmApis.moduleIsolation.test.ts`).
 *   - `crmDb`/`userDb` (from `services/db.ts`, inside `resolveHubSpotService`
 *     and `resolveGoogleAdsCredentialScope`) and `recordAdminAudit` (from
 *     `services/adminAuditLog.ts`, inside `resolveGoogleAdsCredentialScope`)
 *     were ALREADY lazily `await import(...)`-ed in the original code — kept
 *     exactly as-is, only the relative path adjusted from `./x` (relative to
 *     `services/`) to `../../services/x` (relative to `emma/impl/`).
 *     `decryptPassword` (`../utils/crypto` -> `../../utils/crypto`, inside
 *     `resolveHubSpotService`) likewise.
 *
 * Zero `this.callLLM`/`this.generateImage`/`this.describeImage`/
 * `this.callVisionLLMWithTimeout` coupling anywhere in this cluster — every
 * body (both public methods, all seven Google Ads helpers, and
 * `resolveHubSpotService`) was read in full and individually grepped for the
 * four names; none matched.
 */
import { googleAdsService } from '../../services/googleAdsService';
import { stampGoogleAssetUpload, stampGoogleAdCreated } from '../../services/creativeLineage';
import {
  NegativeCampaignCriteriaValidationError,
  validateDeviceBidAdjustments,
  validateNegativeCampaignCriteria,
} from '../../services/googleAdsCampaignCriteria';
import { preflightTrackingGate } from '../../services/googleAdsTrackingPreflight';
import { HubSpotService } from '../../services/hubspotService';
import { handleAttioApi } from '../../services/agentMode/attioTools';
import { getJwtSecret } from '../../config/jwt';

export { handleAttioApi };

/** Local copy of the tiny error shape `makeGoogleAdsAuthError` produces. */
function makeGoogleAdsAuthError(message: string): Error {
  const err = new Error(message) as any;
  err.isGoogleAdsAuthError = true;
  return err;
}

/**
 * ENG-1944: mirrors resolveMetaCredentialScope. Google Ads tools had no equivalent —
 * a delegated/admin session's call always resolved against the CALLER's own connected
 * Google identity, never the requested client's, so a staff member auditing a client's
 * account got "not found in your connected accounts" for an account that plainly exists
 * on the client's own record. Unscoped (clientId undefined/null) is a no-op — zero
 * behavior change for the ordinary customer-session path. Scoped calls fail loud, same
 * as Meta: never silently substitute the caller's own account.
 *
 * Deliberately read-only in effect: only wired into the two reporting/list surfaces
 * (handleCallGoogleAdsReportingApi, and LIST/SEARCH actions of handleCallGoogleAdsApi).
 * Writes are allowed too (admin-only, audited per call); see handleCallGoogleAdsApi.
 */
async function resolveGoogleAdsCredentialScope(
  callerUserId: string,
  clientId: unknown,
  callerIsAdminHint: boolean | undefined,
  toolName: string
): Promise<{ effectiveUserId: string; strict: boolean }> {
  if (clientId === undefined || clientId === null) {
    return { effectiveUserId: callerUserId, strict: false };
  }
  if (typeof clientId !== 'string' || !clientId.trim()) {
    throw makeGoogleAdsAuthError(
      `client_id must be a non-blank string (email or userId); received ${typeof clientId === 'string' ? 'a blank string' : typeof clientId}.`
    );
  }

  const { userDb } = await import('../../services/db');
  const caller = await userDb.getUserById(callerUserId);
  const isAdmin = callerIsAdminHint !== undefined ? callerIsAdminHint : caller?.isAdmin === true;
  if (!isAdmin) {
    throw makeGoogleAdsAuthError('client_id is admin-only — this account is not an admin.');
  }

  const trimmed = clientId.trim();
  const target = trimmed.includes('@')
    ? await userDb.getUserByEmail(trimmed)
    : await userDb.getUserById(trimmed);
  if (!target) {
    throw makeGoogleAdsAuthError(`No client account found for "${trimmed}".`);
  }
  if (!(target as any).roles?.includes('customer')) {
    throw makeGoogleAdsAuthError(`"${trimmed}" does not have customer portal access — cannot scope Google Ads tools to it.`);
  }

  const { recordAdminAudit } = await import('../../services/adminAuditLog');
  recordAdminAudit({
    actorUserId: callerUserId,
    actorEmail: caller?.email,
    action: 'google_ads_client_scope',
    tool: toolName,
    targetUserId: (target as any).userId,
    targetEmail: (target as any).email,
  });

  return { effectiveUserId: (target as any).userId, strict: true };
}

/**
 * Deterministic pre-flight tracking gate (ENG-335). Before a campaign is
 * enabled/launched, fetch its final URLs and confirm each serves a detectable
 * conversion-measurement mechanism (GA4 / GTM / Google Ads conversion snippet).
 * Blocks the launch by default when any URL is unmeasured or unverifiable;
 * an explicit `override_tracking_check` proceeds but is recorded. The per-URL
 * result and the decision are persisted to the run record so a later report
 * can state measurement status instead of a bare "0 conversions".
 *
 * Returns `{ proceed: false, blockResult }` when the launch must be blocked
 * (caller returns blockResult verbatim), or `{ proceed: true }` to continue.
 */
async function enforceGoogleAdsLaunchGate(
  userId: string,
  customerId: string,
  campaignResourceName: string,
  action: string,
  override: boolean,
  sessionId?: string,
): Promise<{ proceed: boolean; blockResult?: any; warning?: string }> {
  const finalUrls = await googleAdsService.getCampaignFinalUrls(userId, customerId, campaignResourceName);
  // No serving URLs (e.g. a campaign with no ads yet) ⇒ nothing to gate.
  if (finalUrls.length === 0) return { proceed: true };
  return runGoogleAdsTrackingGate(customerId, campaignResourceName, action, override, sessionId, finalUrls);
}

/**
 * ENG-1944: enabling a CAMPAIGN never touches its ad groups, keywords, or ads — those
 * default to PAUSED on creation (RULE 11) and nothing else ever flips them. A campaign can
 * read back ENABLED while every ad group/keyword/ad beneath it is still PAUSED, delivering
 * zero traffic with no signal anything is wrong — this is exactly what happened to a live
 * $250/day launch for days before anyone noticed. Advisory only (like the tracking gate's
 * own warning path): a real staged rollout — enable the campaign, review ad groups before
 * turning them on — is legitimate, so this informs rather than blocks. A lookup failure
 * here must not fail an otherwise-successful launch, so it degrades to no warning.
 */
async function checkGoogleAdsPausedChildren(
  userId: string,
  customerId: string,
  campaignResourceName: string,
): Promise<string | undefined> {
  try {
    const adGroups = await googleAdsService.listAdGroups(userId, customerId, campaignResourceName);
    if (adGroups.length === 0) return undefined;
    const pausedAdGroups = adGroups.filter((g: any) => g.status === 'PAUSED');

    let totalKeywords = 0, pausedKeywords = 0, totalAds = 0, pausedAds = 0;
    await Promise.all(adGroups.map(async (group: any) => {
      const [keywords, ads] = await Promise.all([
        googleAdsService.listKeywords(userId, customerId, group.resourceName).catch(() => []),
        googleAdsService.listAds(userId, customerId, group.resourceName).catch(() => []),
      ]);
      totalKeywords += keywords.length;
      pausedKeywords += keywords.filter((k: any) => k.status === 'PAUSED').length;
      totalAds += ads.length;
      pausedAds += ads.filter((a: any) => a.status === 'PAUSED').length;
    }));

    const problems: string[] = [];
    if (pausedAdGroups.length > 0) problems.push(`${pausedAdGroups.length}/${adGroups.length} ad group(s)`);
    if (pausedKeywords > 0) problems.push(`${pausedKeywords}/${totalKeywords} keyword(s)`);
    if (pausedAds > 0) problems.push(`${pausedAds}/${totalAds} ad(s)`);
    if (problems.length === 0) return undefined;

    return `Campaign is ENABLED, but ${problems.join(', ')} underneath it are still PAUSED — this campaign will deliver ZERO traffic until those are also explicitly enabled (AD_GROUP/KEYWORD/AD UPDATE with status=ENABLED). Do not report this launch as live until they are.`;
  } catch (err) {
    console.error('[ENG-1944] paused-child-entity check failed (non-fatal, launch still proceeds):', err);
    return undefined;
  }
}

/**
 * ENG-335: adding a new ad or PMax asset group to an *already-ENABLED* campaign
 * serves paid traffic to its final URL instantly — the same exposure as a launch.
 * Gate the newly-added final URL(s) exactly like RESUME/UPDATE(ENABLED). Additions
 * to a PAUSED/DRAFT campaign are not gated here; they are re-checked when that
 * campaign is later enabled/resumed.
 *
 * ENG-1527. Resolve the parent campaign's status and run the creative-addition gate,
 * failing CLOSED when the answer cannot be established.
 *
 * Both call sites used to swallow every failure and proceed, on this rationale:
 *
 *   "defence-in-depth (the RESUME / UPDATE→ENABLED gate is the hard guarantee), so a
 *    transient parent-status lookup failure must NOT break an otherwise-valid create"
 *
 * That is exactly backwards for the case this gate exists to cover. The gate only ever
 * matters when the parent is ALREADY ENABLED — and an already-enabled campaign has no
 * future RESUME or UPDATE→ENABLED for the "hard guarantee" to fire on. The creative IS
 * the launch, it serves paid traffic the moment it is created, and this gate is the only
 * thing standing in front of it. Calling it defence-in-depth described a second layer
 * that, in this specific situation, does not exist.
 *
 * Three ways the old code proceeded without ever checking anything, all silent:
 *   - the parent lookup threw;
 *   - the parent lookup returned nothing, so the gate call was skipped entirely;
 *   - the gate itself threw while fetching the landing page.
 *
 * Now: a status we could not determine is treated as possibly-ENABLED and refused. A
 * status we DID determine to be anything other than ENABLED still proceeds untouched —
 * there is no launch to guard, so a flaky lookup must not block ordinary staging work.
 * An approved override still wins, because it is a user's disclosed decision to accept
 * exactly this risk, and it keeps the refusal from being a dead end.
 */
async function guardCreativeAddition(opts: {
  customerId: string;
  action: string;
  override: boolean;
  sessionId?: string;
  finalUrls: Array<string | undefined>;
  resolveParent: () => Promise<{ campaignResourceName: string; campaignStatus: string | null } | null>;
}): Promise<{ proceed: boolean; blockResult?: any; warning?: string }> {
  /**
   * `overridable` is FALSE for every parent-status failure, and that is deliberate.
   *
   * The approval the user actually saw says: "this launch will SKIP the tracking
   * pre-flight check. Paid delivery may start at a destination that cannot report
   * conversions." It discloses one risk — an unverified destination. It says nothing
   * about "we could not establish whether this campaign is even live", which is a
   * different and undisclosed risk. ENG-941 already settled this principle for Meta:
   * an override the user was not told about is not user-granted, whatever else it was
   * attached to. So the override only spends against the risk it named.
   *
   * That leaves no override path for an unresolved status, which is correct: a lookup
   * failure is either transient (retry) or a wrong resource name (fix it). Neither is
   * something to wave through.
   */
  const refuse = async (
    why: string,
    campaignResourceName: string,
    opts2: { overridable: boolean; advice: string },
    err?: unknown,
  ) => {
    const { chatbotDb } = require('../../services/chatbotService') as typeof import('../../services/chatbotService');
    const urls = opts.finalUrls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0);
    // Same per-URL detail in the response as in the run record. Recording richer data
    // than we return means the caller is told less than we know, and the run record was
    // the only place this detail survived.
    const urlResults = urls.map(url => ({ url, status: 'unknown', mechanisms: [] as string[], error: why }));

    if (opts2.overridable && opts.override) {
      // Recorded, not just logged. The non-override path writes a run record, so leaving
      // this one to a console line would put a hole in the audit trail at exactly the
      // point where a human made a deliberate decision.
      await chatbotDb.recordGoogleAdsMeasurementCheck(opts.sessionId || '', {
        customerId: opts.customerId, campaignResourceName, action: opts.action,
        outcome: 'overridden', urlResults, checkedAt: new Date().toISOString(),
      });
      console.error(`[ENG-1527] ${opts.action} creative-addition gate unresolved (${why}); proceeding on an approved override:`, err);
      return { proceed: true };
    }

    console.error(`[ENG-1527] ${opts.action} creative-addition gate unresolved (${why}); refusing:`, err);
    await chatbotDb.recordGoogleAdsMeasurementCheck(opts.sessionId || '', {
      customerId: opts.customerId, campaignResourceName, action: opts.action,
      outcome: 'blocked', urlResults, checkedAt: new Date().toISOString(),
    });
    return {
      proceed: false,
      blockResult: {
        success: false,
        blocked: true,
        reason: 'tracking_preflight_unresolved',
        error: `Cannot confirm this creative is safe to add: ${why}. If the parent campaign is already ENABLED the creative starts serving paid traffic immediately, so refusing is the safe answer rather than adding it unchecked. ${opts2.advice} Nothing was created.`,
        trackingCheck: { measured: false, urlResults },
      },
    };
  };

  let parent: { campaignResourceName: string; campaignStatus: string | null } | null;
  try {
    parent = await opts.resolveParent();
  } catch (err) {
    return refuse(
      'the parent campaign\'s status could not be read from Google Ads', '',
      { overridable: false, advice: 'Retry — a read failure here is usually transient.' }, err,
    );
  }
  if (!parent || !parent.campaignStatus) {
    // Deliberately NOT described as transient: the usual cause is a stale or wrong
    // ad_group_resource_name, and telling the agent to retry a permanent failure just
    // buys a retry loop.
    return refuse(
      'the parent campaign was not found, or returned no status',
      parent?.campaignResourceName || '',
      { overridable: false, advice: 'Check the resource name is current — a campaign that does not resolve will not resolve on a retry either.' },
    );
  }
  // Not a launch: nothing to guard, so a gate failure here cannot cost anything.
  if (parent.campaignStatus !== 'ENABLED') return { proceed: true };

  try {
    return await enforceGoogleAdsCreativeAdditionGate(
      opts.customerId, parent.campaignResourceName, parent.campaignStatus,
      opts.action, opts.override, opts.sessionId, opts.finalUrls,
    );
  } catch (err) {
    // The ONE overridable case: this is the tracking pre-flight failing to run, which is
    // exactly the risk the override's confirmation text discloses.
    return refuse(
      'the landing page tracking check could not be completed', parent.campaignResourceName,
      { overridable: true, advice: 'Retry — a landing-page fetch failure is usually transient.' }, err,
    );
  }
}

async function enforceGoogleAdsCreativeAdditionGate(
  customerId: string,
  campaignResourceName: string,
  campaignStatus: string | null,
  action: string,
  override: boolean,
  sessionId: string | undefined,
  newFinalUrls: Array<string | undefined>,
): Promise<{ proceed: boolean; blockResult?: any; warning?: string }> {
  if (campaignStatus !== 'ENABLED') return { proceed: true };
  const urls = newFinalUrls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0);
  if (urls.length === 0) return { proceed: true };
  return runGoogleAdsTrackingGate(customerId, campaignResourceName, action, override, sessionId, urls);
}

/**
 * Shared core of the tracking gate: run the deterministic pre-flight check over
 * `finalUrls`, record the outcome (passed / blocked / overridden) on the run
 * record, and return whether the caller may proceed.
 */
async function runGoogleAdsTrackingGate(
  customerId: string,
  campaignResourceName: string,
  action: string,
  override: boolean,
  sessionId: string | undefined,
  finalUrls: string[],
): Promise<{ proceed: boolean; blockResult?: any; warning?: string }> {
  const { chatbotDb } = require('../../services/chatbotService') as typeof import('../../services/chatbotService');
  const gate = await preflightTrackingGate(finalUrls);
  const urlResults = gate.results.map(r => ({ url: r.url, status: r.status, mechanisms: r.mechanisms, error: r.error }));

  if (gate.ok) {
    /*
     * ENG-1358: measurable, but nothing on the page proves an Ads conversion can be
     * recorded — only a GTM container or a GA4 property. Recorded under its own outcome
     * so the run history distinguishes "verified" from "we could not tell", and
     * returned so the caller surfaces it instead of the gate quietly swallowing it.
     *
     * A warning that is computed and discarded is the same as no warning at all, which
     * is exactly how the AC1 wiring gap survived 111 green tests.
     */
    const warned = (gate.warnings?.length ?? 0) > 0;
    await chatbotDb.recordGoogleAdsMeasurementCheck(sessionId || '', {
      customerId, campaignResourceName, action,
      outcome: warned ? 'passed_with_warning' : 'passed',
      urlResults, checkedAt: new Date().toISOString(),
    });
    return warned ? { proceed: true, warning: gate.message } : { proceed: true };
  }

  if (override) {
    await chatbotDb.recordGoogleAdsMeasurementCheck(sessionId || '', {
      customerId, campaignResourceName, action, outcome: 'overridden', urlResults, checkedAt: new Date().toISOString(),
    });
    return { proceed: true };
  }

  await chatbotDb.recordGoogleAdsMeasurementCheck(sessionId || '', {
    customerId, campaignResourceName, action, outcome: 'blocked', urlResults, checkedAt: new Date().toISOString(),
  });
  return {
    proceed: false,
    blockResult: {
      success: false,
      blocked: true,
      reason: 'tracking_preflight',
      error: gate.message,
      trackingCheck: { measured: false, urlResults },
    },
  };
}

/**
 * The policy topics Google attaches to a POLICY_FINDING / POLICY_VIOLATION error, and the
 * field that failed. Without them the caller sees only "PROHIBITED" and cannot tell which
 * headline or rule to fix.
 *
 * The advertiser's own text (evidences, violatingText, trigger) is deliberately NOT quoted:
 * this string is read by error classifiers (toolErrorClassifier, zomaErrorNextStep), and ad
 * copy such as "Save 500 today" or "Sign in for free" would be misread as a 5xx or a
 * setup failure. The field path already names the headline to rewrite.
 */
export function googleAdsPolicyReasons(e: any): string | undefined {
  const reasons: string[] = [];
  const entries: any[] = e?.details?.policyFindingDetails?.policyTopicEntries ?? [];
  for (const entry of entries) {
    if (/^[A-Z0-9_]+$/.test(String(entry?.topic ?? ''))) reasons.push(`${entry.topic}${/^[A-Z_]+$/.test(String(entry.type ?? '')) ? ` (${entry.type})` : ''}`);
  }
  const v = e?.details?.policyViolationDetails;
  if (v?.key?.policyName && /^[a-z0-9_]+$/i.test(String(v.key.policyName))) reasons.push(String(v.key.policyName));
  // Which field failed, e.g. headlines[2]: tells the caller which line to rewrite.
  const path = (e?.location?.fieldPathElements ?? [])
    .map((p: any) => (/^[a-z_]+$/.test(String(p?.fieldName ?? '')) ? `${p.fieldName}${Number.isInteger(p.index) ? `[${p.index}]` : ''}` : ''))
    .filter(Boolean).join('.');
  if (reasons.length && path) reasons.push(`at ${path}`);
  return reasons.length ? [...new Set(reasons)].join(', ') : undefined;
}

export async function handleCallGoogleAdsApi(userId: string, args: {
  customer_id: string;
  entity_type: 'BUDGET' | 'CAMPAIGN' | 'CAMPAIGN_CRITERION' | 'AD_GROUP' | 'KEYWORD' | 'AD' | 'ASSET' | 'CAMPAIGN_ASSET' | 'ASSET_GROUP' | 'LOCATION' | 'BIDDING_STRATEGY' | 'CONVERSION_ACTION' | 'OFFLINE_CONVERSION' | 'CAMPAIGN_CONVERSION_GOAL' | 'CUSTOMER_CONVERSION_GOAL';
  action: string;
  [key: string]: any;
}, opts?: { sessionId?: string; clientScope?: { clientId?: string; callerIsAdmin?: boolean; toolName: string } }): Promise<any> {
  try {
    const { customer_id, entity_type, action } = args;
    // ENG-1944 originally limited client_id here to LIST/SEARCH. That restriction was
    // removed by engineering-lead decision: managed-client operators (admins) need to
    // make audited changes in a client's account. The scope stays admin-only, requires a
    // real customer target, and every use is recorded via recordAdminAudit
    // (resolveGoogleAdsCredentialScope). All normal write gates (tracking pre-flight,
    // override tokens) still run against the client's credentials.
    if (opts?.clientScope?.clientId !== undefined && opts?.clientScope?.clientId !== null) {
      const scope = await resolveGoogleAdsCredentialScope(
        userId, opts.clientScope.clientId, opts.clientScope.callerIsAdmin, opts.clientScope.toolName ?? 'call_google_ads_api'
      );
      userId = scope.effectiveUserId;
    }
    /*
     * ENG-1526. The override is bound to a disclosed approval, exactly as Meta's is.
     *
     * This used to be `args.override_tracking_check === true` and nothing else: the model
     * could set it on its own, and the only thing standing against that was a sentence in
     * the tool description ("Never set it on your own"). ENG-941 already wrote the threat
     * model down for the Meta path and dismissed precisely that defence — "an override the
     * model can introduce after approval is not user-granted, whatever the tool description
     * says" — then hardened Meta and left Google on the sentence.
     *
     * Reusing ENG-941's helpers rather than writing a second mechanism: HMAC over the
     * exact call, keyed with a server-only secret so the caller cannot mint one, and
     * key-order-independent so a re-emitted argument object still matches.
     * `stableStringify` excludes the gate-only flags, so the replay carrying the token
     * digests identically to the preview that issued it.
     *
     * A claimed-but-unapproved override does not fail — it HALTS and discloses, then
     * issues the matching token. The path is a loop, not a dead end. A call that waives
     * nothing is untouched: no token is ever required.
     *
     * Deliberately narrower than Meta's gate: this halts only when an override is
     * claimed. Google Ads writes still have no general confirmation step — that is a
     * bigger change and its own ticket (ENG-1527), and conflating the two would put an
     * unrelated behaviour change inside a security fix.
     */
    const overrideClaimed = args.override_tracking_check === true;
    const { computeTrackingOverrideDigest, trackingOverrideTokenMatches } =
      require('../../services/metaLaunchGate') as typeof import('../../services/metaLaunchGate');
    const overrideDigest = overrideClaimed
      ? computeTrackingOverrideDigest(getJwtSecret(), { customer_id, entity_type, action, args })
      : '';
    const overrideApproved =
      overrideClaimed && trackingOverrideTokenMatches(args.tracking_override_token, overrideDigest);

    if (overrideClaimed && !overrideApproved) {
      const target = [entity_type, action, customer_id].filter(Boolean).join(' ');
      return {
        success: true,
        requiresConfirmation: true,
        awaitingUserConfirmation: true,
        summary: `Waive the tracking pre-flight check for ${target}`,
        confirmationPrompt:
          `This Google Ads call would WAIVE the pre-flight tracking check.\n\n` +
          `That check is what stops a campaign spending on pages that cannot report a ` +
          `conversion. Waiving it means accepting that this launch may be unmeasurable — ` +
          `you would be paying for traffic you cannot evaluate.\n\n` +
          `Target: ${target}\n\n` +
          `Reply "yes" / "confirm" to waive the check and proceed, or tell me to fix the ` +
          `tracking first.`,
        confirmationDetail: `Waive the tracking pre-flight check for ${target}`,
        message:
          `This call sets override_tracking_check, which waives the deterministic ` +
          `pre-flight measurement check for ${target}. Show the user the warning above and ` +
          `get explicit approval. Once approved, call call_google_ads_api again with the ` +
          `same arguments PLUS tracking_override_token exactly as returned here — without ` +
          `it the override will not apply and the gate will run normally.`,
        // Only issued when an override was actually described in this halt, so it can
        // only ever approve a waiver the user was shown.
        tracking_override_token: overrideDigest,
      } as any;
    }
    const overrideTrackingCheck = overrideApproved;

    if (entity_type === 'BIDDING_STRATEGY' && action === 'LIST') {
      const biddingStrategies = await googleAdsService.listBiddingStrategies(userId, customer_id);
      return { success: true, biddingStrategies };
    }

    if (entity_type === 'CAMPAIGN_CRITERION' && action === 'SET_DEVICE_BID_ADJUSTMENT') {
      // ENG-2036: validate fully before credentials/mutation; one atomic mutate.
      const normalized = validateDeviceBidAdjustments(
        customer_id,
        args.campaign_resource_name,
        args.ad_group_resource_name,
        args.device_bid_adjustments,
      );
      await googleAdsService.setDeviceBidAdjustments(userId, normalized);
      return {
        success: true,
        scope: normalized.scope,
        adjustments: normalized.adjustments,
        message: `Set ${normalized.adjustments.length} device bid adjustment(s) at ${normalized.scope.toLowerCase()} level`,
      };
    }

    if (entity_type === 'CAMPAIGN_CRITERION' && action === 'ADD') {
      const { placementUrls, mobileAppCategoryResourceNames } = validateNegativeCampaignCriteria(
        customer_id,
        args.campaign_resource_name,
        args.placement_urls,
        args.mobile_app_category_resource_names,
      );
      await googleAdsService.addNegativeCampaignCriteria(
        userId,
        customer_id,
        args.campaign_resource_name,
        { placementUrls, mobileAppCategoryResourceNames },
      );
      return {
        success: true,
        message: `Added ${placementUrls.length + mobileAppCategoryResourceNames.length} negative campaign criteria`,
      };
    }

    if (entity_type === 'CAMPAIGN') {
      if (action === 'LIST') {
        const campaigns = await googleAdsService.listCampaigns(userId, customer_id);
        return { success: true, campaigns };
      }
      if (action === 'PAUSE') {
        if (!args.campaign_resource_name) return { success: false, error: 'campaign_resource_name is required for PAUSE action' };
        await googleAdsService.pauseCampaign(userId, customer_id, args.campaign_resource_name);
        return { success: true, message: 'Campaign paused' };
      }
      if (action === 'RESUME') {
        if (!args.campaign_resource_name) return { success: false, error: 'campaign_resource_name is required for RESUME action' };
        const gate = await enforceGoogleAdsLaunchGate(userId, customer_id, args.campaign_resource_name, 'RESUME', overrideTrackingCheck, opts?.sessionId);
        if (!gate.proceed) return gate.blockResult;
        const resumeTrackingWarning = gate.warning;
        await googleAdsService.resumeCampaign(userId, customer_id, args.campaign_resource_name);
        // Relayed, not swallowed: the launch is permitted, but the operator has to be
        // told the page proves only that SOME Google tag is present (ENG-1358).
        const resumePausedChildrenWarning = await checkGoogleAdsPausedChildren(userId, customer_id, args.campaign_resource_name);
        return {
          success: true, message: 'Campaign resumed',
          ...(resumeTrackingWarning ? { trackingWarning: resumeTrackingWarning } : {}),
          ...(resumePausedChildrenWarning ? { pausedChildEntitiesWarning: resumePausedChildrenWarning } : {}),
        };
      }
      if (action === 'REMOVE') {
        if (!args.campaign_resource_name) return { success: false, error: 'campaign_resource_name is required for REMOVE action' };
        await googleAdsService.removeCampaign(userId, customer_id, args.campaign_resource_name);
        return { success: true, message: 'Campaign removed' };
      }
      if (action === 'CREATE') {
        if (!args.budget_resource_name || !args.name || !args.type || (!args.bidding_strategy && !args.bidding_strategy_resource_name)) {
          return { success: false, error: 'name, type, budget_resource_name, and a bidding strategy (bidding_strategy for a standard strategy, or bidding_strategy_resource_name for a portfolio/shared strategy) are required to create a campaign' };
        }
        if (args.bidding_strategy && args.bidding_strategy_resource_name) {
          return { success: false, error: 'Provide either bidding_strategy (standard) or bidding_strategy_resource_name (portfolio/shared), not both.' };
        }
        if (args.bidding_strategy === 'TARGET_CPA' && !args.bidding_strategy_target) {
          return { success: false, error: 'TARGET_CPA requires bidding_strategy_target (CPA value in account currency, e.g. 20 for $20). Ask the user for their target CPA before proceeding.' };
        }
        if (args.bidding_strategy === 'TARGET_ROAS' && !args.bidding_strategy_target) {
          return { success: false, error: 'TARGET_ROAS requires bidding_strategy_target (ROAS as a decimal, e.g. 3.0 for 300%). Ask the user for their target ROAS before proceeding.' };
        }
        const campaign = await googleAdsService.createCampaign(userId, customer_id, {
          name: args.name,
          type: args.type,
          budgetResourceName: args.budget_resource_name,
          biddingStrategy: args.bidding_strategy,
          biddingStrategyResourceName: args.bidding_strategy_resource_name,
          biddingStrategyTarget: args.bidding_strategy_target,
          cpcBidCeilingMicros: args.cpc_bid_ceiling_micros,
          locationTargetIds: args.location_target_ids || [],
          status: args.status || 'PAUSED',
          brandBusinessName: args.brand_business_name,
          brandLogoAssetResourceName: args.brand_logo_asset_resource_name,
          // Network settings exist on Search campaigns only (another type would be rejected by Google).
          ...(args.type === 'SEARCH' ? {
            targetGoogleSearch: args.target_google_search,
            targetSearchNetwork: args.target_search_network,
            targetContentNetwork: args.target_content_network,
          } : {}),
        });
        return { success: true, campaignResourceName: campaign.resourceName };
      }
      if (action === 'UPDATE') {
        if (!args.campaign_resource_name) return { success: false, error: 'campaign_resource_name is required for UPDATE action' };
        let trackingWarning: string | undefined;
        // Enabling a campaign via UPDATE(status=ENABLED) is a launch — gate it like RESUME.
        if (args.status === 'ENABLED') {
          const gate = await enforceGoogleAdsLaunchGate(userId, customer_id, args.campaign_resource_name, 'UPDATE', overrideTrackingCheck, opts?.sessionId);
          if (!gate.proceed) return gate.blockResult;
          trackingWarning = gate.warning;
        }
        const didUpdate = await googleAdsService.updateCampaign(userId, customer_id, args.campaign_resource_name, {
          name: args.name,
          status: args.status,
          biddingStrategy: args.bidding_strategy,
          biddingStrategyResourceName: args.bidding_strategy_resource_name,
          biddingStrategyTarget: args.bidding_strategy_target,
          cpcBidCeilingMicros: args.cpc_bid_ceiling_micros,
          budgetResourceName: args.budget_resource_name,
          finalUrlSuffix: args.final_url_suffix,
          targetGoogleSearch: args.target_google_search,
          targetSearchNetwork: args.target_search_network,
          targetContentNetwork: args.target_content_network,
          targetPartnerSearchNetwork: args.target_partner_search_network,
        });
        if (!didUpdate) return { success: false, error: 'This tool does not support updating the field(s) requested for CAMPAIGN — nothing was sent to Google Ads, no changes were made.' };
        // Same relay as RESUME: permitted, but the operator is told what could not be
        // verified rather than reading a bare success (ENG-1358).
        const updatePausedChildrenWarning = args.status === 'ENABLED'
          ? await checkGoogleAdsPausedChildren(userId, customer_id, args.campaign_resource_name)
          : undefined;
        return {
          success: true, message: 'Campaign updated',
          ...(trackingWarning ? { trackingWarning } : {}),
          ...(updatePausedChildrenWarning ? { pausedChildEntitiesWarning: updatePausedChildrenWarning } : {}),
        };
      }
      if (action === 'ADD_PROXIMITY') {
        const hasGeo = args.latitude !== undefined || args.longitude !== undefined;
        if (!args.campaign_resource_name || args.radius === undefined || (!args.address && !hasGeo)) {
          return { success: false, error: 'campaign_resource_name, radius, and address (or latitude+longitude) are required for ADD_PROXIMITY' };
        }
        if (hasGeo && (typeof args.latitude !== 'number' || typeof args.longitude !== 'number')) {
          return { success: false, error: 'ADD_PROXIMITY needs both latitude and longitude as numbers when centering on coordinates' };
        }
        const criterion = await googleAdsService.addProximityCriterion(userId, customer_id, args.campaign_resource_name, {
          radius: args.radius,
          radiusUnits: args.radius_units,
          ...(hasGeo ? { geoPoint: { latitude: args.latitude, longitude: args.longitude } } : {}),
          address: {
            streetAddress: args.address?.street_address,
            cityName: args.address?.city_name,
            postalCode: args.address?.postal_code,
            provinceCode: args.address?.province_code,
            provinceName: args.address?.province_name,
            countryCode: args.address?.country_code,
          },
        });
        return { success: true, criterionResourceName: criterion.resourceName };
      }
      if (action === 'REMOVE_PROXIMITY') {
        if (!args.criterion_resource_name) return { success: false, error: 'criterion_resource_name is required for REMOVE_PROXIMITY' };
        await googleAdsService.removeCampaignCriterion(userId, customer_id, args.criterion_resource_name, ['PROXIMITY']);
        return { success: true, message: 'Campaign criterion removed' };
      }
    }

    // CONVERSION_ACTION (ENG-1322). CREATE / LIST / UPDATE only — REMOVE is
    // deliberately absent (Harsha, ENG-1329): it severs historical attribution in
    // the customer's account and is the one operation we cannot undo from our
    // side. Pausing via UPDATE covers what an operator actually needs.
    if (entity_type === 'OFFLINE_CONVERSION') {
      if (action !== 'UPLOAD') {
        return { success: false, error: `OFFLINE_CONVERSION supports UPLOAD only, not ${action}.` };
      }
      if (!args.gclid || !args.conversion_action_resource_name || !args.conversion_at) {
        return {
          success: false,
          error: 'gclid, conversion_action_resource_name and conversion_at are all required. '
            + 'conversion_at is when the conversion HAPPENED (ISO 8601), not when you noticed it — '
            + 'Google attributes it to that moment.',
        };
      }
      const { buildClickConversion } = await import('../../utils/googleAdsOfflineConversions');
      /*
       * Validate BEFORE resolving the time zone. getAccountTimeZone is a live Google
       * call, so doing it first meant a future-dated timestamp or a value with no
       * currency — both refusable locally — still cost a network round trip before
       * being rejected. On a background sweep that is a request per bad row.
       *
       * The zone is only needed to FORMAT a conversion we have already accepted, so a
       * throwaway placeholder validates everything else first. UTC is safe here purely
       * because the result is discarded; the real formatting below uses the account's
       * own zone, and getting that wrong would shift every conversion by the real
       * offset with no symptom beyond conversions landing on the wrong day.
       */
      const validateOnlyArgs = {
        gclid: args.gclid,
        conversionActionResourceName: args.conversion_action_resource_name,
        conversionAt: new Date(args.conversion_at),
        value: args.conversion_value,
        currencyCode: args.currency_code,
        orderId: args.order_id,
      };
      try {
        buildClickConversion({ ...validateOnlyArgs, timeZone: 'UTC' });
      } catch (err: any) {
        return { success: false, error: err?.message || 'Invalid offline conversion.' };
      }

      const tz = args.time_zone || await googleAdsService.getAccountTimeZone(userId, customer_id);
      let conversion: Record<string, unknown>;
      try {
        conversion = buildClickConversion({
          gclid: args.gclid,
          conversionActionResourceName: args.conversion_action_resource_name,
          conversionAt: new Date(args.conversion_at),
          timeZone: tz,
          value: args.conversion_value,
          currencyCode: args.currency_code,
          orderId: args.order_id,
        });
      } catch (err: any) {
        // Refused locally, before the network. An upload runs from a background sweep
        // with nobody watching, so a rejected batch surfaces days later as "conversions
        // never appeared".
        return { success: false, error: err?.message || 'Invalid offline conversion.' };
      }
      const out = await googleAdsService.uploadClickConversions(
        userId, customer_id, [conversion], { validateOnly: args.validate_only === true },
      );
      return {
        success: out.failures.length === 0,
        validateOnly: args.validate_only === true,
        uploaded: out.uploaded,
        failures: out.failures,
        conversion,
        ...(out.failures.length > 0
          ? { error: out.failures.map((f) => `row ${f.index}: ${f.errorCode ?? ''} ${f.message}`.trim()).join('; ') }
          : {}),
      };
    }

    // ENG-2804: conversion GOAL biddability. Codeless / UA actions refuse
    // CONVERSION_ACTION UPDATE (MUTATE_NOT_ALLOWED); demoting their goal is the API path.
    if (entity_type === 'CAMPAIGN_CONVERSION_GOAL' || entity_type === 'CUSTOMER_CONVERSION_GOAL') {
      const level = entity_type === 'CAMPAIGN_CONVERSION_GOAL' ? 'CAMPAIGN' : 'CUSTOMER';
      if (action === 'LIST') {
        const goals = await googleAdsService.listConversionGoals(
          userId, customer_id, level, level === 'CAMPAIGN' && args.campaign_id != null ? String(args.campaign_id) : undefined,
        );
        return { success: true, conversionGoals: goals };
      }
      if (action === 'UPDATE') {
        if (typeof args.biddable !== 'boolean') {
          return { success: false, error: `biddable (true/false) is required for ${entity_type} UPDATE.` };
        }
        let resourceName = args.resource_name ? String(args.resource_name).trim() : '';
        if (!resourceName && args.category && args.origin) {
          const cat = String(args.category).trim().toUpperCase();
          const origin = String(args.origin).trim().toUpperCase();
          if (level === 'CAMPAIGN') {
            if (!args.campaign_id || !/^\d+$/.test(String(args.campaign_id))) {
              return { success: false, error: 'campaign_id (numeric) is required with category + origin for CAMPAIGN_CONVERSION_GOAL UPDATE.' };
            }
            resourceName = `customers/${customer_id}/campaignConversionGoals/${args.campaign_id}~${cat}~${origin}`;
          } else {
            resourceName = `customers/${customer_id}/customerConversionGoals/${cat}~${origin}`;
          }
        }
        if (!resourceName) {
          return {
            success: false,
            error: `resource_name (or category + origin${level === 'CAMPAIGN' ? ' + campaign_id' : ''}) is required for ${entity_type} UPDATE. Get it from ${entity_type} LIST.`,
          };
        }
        const expectedPath = level === 'CAMPAIGN' ? 'campaignConversionGoals' : 'customerConversionGoals';
        const m = /^customers\/(\d+)\/([A-Za-z]+)\//.exec(resourceName);
        if (!m || m[2] !== expectedPath) {
          return { success: false, error: `resource_name ${resourceName} is not a ${expectedPath} resource name.` };
        }
        if (m[1] !== String(customer_id)) {
          return { success: false, error: `resource_name ${resourceName} belongs to customer ${m[1]}, not customer_id ${customer_id}.` };
        }
        const updated = await googleAdsService.updateConversionGoalBiddable(userId, customer_id, level, resourceName, args.biddable);
        return {
          success: updated.drift.length === 0,
          resourceName: updated.resourceName,
          stored: updated.stored,
          drift: updated.drift,
          ...(updated.drift.length > 0
            ? { error: `Google did not store biddable=${args.biddable} for ${resourceName} — see drift/stored.` }
            : {}),
        };
      }
      return { success: false, error: `${entity_type} supports LIST and UPDATE (biddable) only, not ${action}.` };
    }

    if (entity_type === 'CONVERSION_ACTION') {
      if (action === 'LIST') {
        const conversionActions = await googleAdsService.listConversionActions(userId, customer_id);
        return { success: true, conversionActions };
      }
      if (action === 'CREATE') {
        // counting_type is NOT defaulted here — the service refuses an absent one
        // with a message naming both options and what choosing wrong costs.
        const created = await googleAdsService.createConversionAction(userId, customer_id, {
          name: args.name,
          category: args.category,
          countingType: args.counting_type,
          status: args.status,
          primaryForGoal: args.primary_for_goal,
          clickThroughLookbackWindowDays: args.click_through_lookback_window_days,
        });
        return {
          success: true,
          conversionActionResourceName: created.resourceName,
          // The pair the page actually needs — a resource name cannot be installed.
          tag: created.tag,
          tagUnavailable: created.tag
            ? undefined
            : 'Google has not generated tag snippets for this action yet. Re-run CONVERSION_ACTION LIST shortly to read the AW-<id>/<label> pair.',
          stored: created.stored,
          drift: created.drift,
          driftWarning: created.drift.length > 0
            ? `Google stored ${created.drift.length} field(s) differently from what was requested — see drift.`
            : undefined,
        };
      }
      if (action === 'UPDATE') {
        // ENG-2809: the model names the action the way LIST output and the Google UI
        // do — a bare id, or under resource_name / conversion_action_id. Normalise
        // those; a missing one is a model-facing error, not a thrown failure.
        const raw = args.conversion_action_resource_name ?? args.resource_name ?? args.conversion_action_id;
        const ident = raw === undefined || raw === null ? '' : String(raw).trim();
        if (!ident) {
          return {
            success: false,
            error: 'conversion_action_resource_name is required for CONVERSION_ACTION UPDATE '
              + `(e.g. customers/${customer_id}/conversionActions/<id>). Get it from CONVERSION_ACTION LIST.`,
          };
        }
        const resourceName = /^\d+$/.test(ident) ? `customers/${customer_id}/conversionActions/${ident}` : ident;
        const owner = /^customers\/(\d+)\//.exec(resourceName)?.[1];
        if (owner && owner !== String(customer_id)) {
          return {
            success: false,
            error: `conversion_action_resource_name ${resourceName} belongs to customer ${owner}, not customer_id ${customer_id}.`,
          };
        }
        const updated = await googleAdsService.updateConversionAction(
          userId, customer_id, resourceName, {
            name: args.name,
            status: args.status,
            category: args.category,
            countingType: args.counting_type,
            primaryForGoal: args.primary_for_goal,
            clickThroughLookbackWindowDays: args.click_through_lookback_window_days,
          });
        return {
          success: true,
          conversionActionResourceName: updated.resourceName,
          stored: updated.stored,
          drift: updated.drift,
          driftWarning: updated.drift.length > 0
            ? `Google stored ${updated.drift.length} field(s) differently from what was requested — see drift.`
            : undefined,
        };
      }
      if (action === 'REMOVE') {
        if (!args.conversion_action_resource_name) {
          return { success: false, error: 'conversion_action_resource_name is required for CONVERSION_ACTION REMOVE.' };
        }
        /*
         * Permanent and not re-enableable, so it goes through an explicit confirmation —
         * the follow-up shape ENG-1329 anticipated ("if REMOVE is needed later, it's a
         * small additive follow-up with its own explicit confirmation step").
         *
         * The message states what removal ACTUALLY does. The previous wording said it
         * "severs historical attribution", which is not true and would talk someone out
         * of a safe operation: Google models this as a soft state — the action stops
         * recording, and conversions already recorded stay in reporting, exactly as a
         * REMOVED campaign still returns its historical metrics.
         */
        /*
         * ENG-1322 follow-up. The removal flag is BOUND to a disclosed approval, exactly
         * as ENG-1526 bound override_tracking_check.
         *
         * `confirm_conversion_action_removal: true` used to be sufficient on its own, and
         * the model sets its own arguments — so the only thing standing between a model
         * that decided to "clean up" a conversion action and a permanent, unrecoverable
         * removal was a sentence in the tool description asking it not to. ENG-941 already
         * wrote down why that is not a control: "an override the model can introduce after
         * approval is not user-granted, whatever the tool description says." This is the
         * same shape guarding a strictly worse outcome — a removed conversion action cannot
         * be re-enabled, and every campaign bidding toward it stops counting it.
         *
         * So: a claimed removal with no matching token HALTS and discloses, and issues an
         * HMAC over this exact call. Only a replay presenting that token removes anything.
         * A forged token, or a token minted for a DIFFERENT conversion action, falls back
         * into a fresh disclosure rather than proceeding — which is the case that matters,
         * because the destructive argument here is the resource name.
         */
        const removalClaimed = args.confirm_conversion_action_removal === true;
        // Computed unconditionally, NOT only when the flag is claimed. The digest covers
        // the call being disclosed, not the caller's intent to confirm — and the halt
        // below has to hand back a usable token whether or not the flag was set. Gating
        // it on the flag made the FIRST (unflagged) call disclose an empty string, which
        // the model then replayed faithfully and was refused for, turning a two-step loop
        // into three and making the token look broken. Issuing it here is not a weakening:
        // the token is only ever returned alongside the disclosure of this exact resource
        // name, which is what binds it.
        const { computeTrackingOverrideDigest, trackingOverrideTokenMatches } =
          require('../../services/metaLaunchGate') as typeof import('../../services/metaLaunchGate');
        const removalDigest = computeTrackingOverrideDigest(getJwtSecret(), {
          customer_id, entity_type, action,
          conversion_action_resource_name: args.conversion_action_resource_name,
        });
        const removalApproved =
          removalClaimed && trackingOverrideTokenMatches(args.conversion_action_removal_token, removalDigest);

        if (!removalApproved) {
          const target = args.conversion_action_resource_name;
          return {
            success: true,
            requiresConfirmation: true,
            awaitingUserConfirmation: true,
            summary: `Permanently stop conversion action ${target} from recording`,
            confirmationPrompt:
              `This PERMANENTLY stops a Google Ads conversion action from recording.\n\n`
              + `It cannot be re-enabled afterwards, and any campaign bidding toward it as a `
              + `goal will stop counting it — which changes how those campaigns bid. `
              + `Conversions it already recorded stay in your reports, so this is not data `
              + `loss, but it is not reversible either.\n\n`
              + `Conversion action: ${target}\n\n`
              + `Reply "yes" / "confirm" to remove it, or tell me to leave it alone.`,
            confirmationDetail: `Permanently stop conversion action ${target} from recording`,
            message:
              `CONVERSION_ACTION REMOVE permanently stops ${target} recording and cannot be `
              + `undone. Show the user the warning above and get explicit approval — do not `
              + `decide this yourself. Once approved, call call_google_ads_api again with the `
              + `same arguments PLUS conversion_action_removal_token exactly as returned here; `
              + `without it nothing is removed.`,
            // Only issued alongside a disclosure of this exact resource name, so the token
            // can only ever approve the removal the user was actually shown.
            conversion_action_removal_token: removalDigest,
          };
        }
        await googleAdsService.removeConversionAction(userId, customer_id, args.conversion_action_resource_name);
        return {
          success: true,
          message: `Conversion action removed. It has stopped recording and cannot be re-enabled; `
            + `conversions it already recorded remain in reporting.`,
        };
      }
    }

    if (entity_type === 'BUDGET' && action === 'LIST') {
      const budgets = await googleAdsService.listBudgets(userId, customer_id);
      return { success: true, budgets };
    }
    if (entity_type === 'BUDGET' && action === 'CREATE') {
      if (!args.name || args.amount_micros === undefined) return { success: false, error: 'name and amount_micros are required to create a budget' };
      const budget = await googleAdsService.createBudget(userId, customer_id, { name: args.name, amountMicros: args.amount_micros, explicitlyShared: args.explicitly_shared });
      return { success: true, budgetResourceName: budget.resourceName };
    }
    if (entity_type === 'BUDGET' && action === 'UPDATE') {
      if (!args.budget_resource_name || args.amount_micros === undefined) return { success: false, error: 'budget_resource_name and amount_micros are required for BUDGET UPDATE' };
      await googleAdsService.updateBudget(userId, customer_id, args.budget_resource_name, args.amount_micros);
      return { success: true, message: 'Budget updated' };
    }
    if (entity_type === 'BUDGET' && action === 'REMOVE') {
      if (!args.budget_resource_name) return { success: false, error: 'budget_resource_name is required for BUDGET REMOVE. Note: budget must not be attached to any campaign (reference_count must be 0).' };
      await googleAdsService.removeBudget(userId, customer_id, args.budget_resource_name);
      return { success: true, message: 'Budget removed' };
    }

    if (entity_type === 'AD_GROUP') {
      if (action === 'LIST') {
        if (!args.campaign_resource_name) return { success: false, error: 'campaign_resource_name is required for AD_GROUP LIST' };
        const adGroups = await googleAdsService.listAdGroups(userId, customer_id, args.campaign_resource_name);
        return { success: true, adGroups };
      }
      if (action === 'CREATE') {
        if (!args.name || !args.campaign_resource_name || !args.type) return { success: false, error: 'name, campaign_resource_name, and type are required' };
        const adGroup = await googleAdsService.createAdGroup(userId, customer_id, {
          name: args.name,
          campaignResourceName: args.campaign_resource_name,
          type: args.type,
          cpcBidMicros: args.cpc_bid_micros,
          // ENG-1514. ENG-1293 taught createAdGroup to accept a status; this call
          // site never sent one, so `params.status ?? 'ENABLED'` fired and an
          // explicit PAUSED was dropped behind a success response. Defaulting to
          // PAUSED (not ENABLED) matches CAMPAIGN CREATE above and RULE 11.
          status: args.status || 'PAUSED',
        });
        return { success: true, adGroupResourceName: adGroup.resourceName };
      }
      if (action === 'UPDATE') {
        if (!args.ad_group_resource_name) return { success: false, error: 'ad_group_resource_name is required for UPDATE action' };
        const didUpdateAdGroup = await googleAdsService.updateAdGroup(userId, customer_id, args.ad_group_resource_name, {
          name: args.name,
          status: args.status,
          cpcBidMicros: args.cpc_bid_micros,
          adRotationMode: args.ad_rotation_mode,
          targetCpaMicros: args.target_cpa_micros,
          targetRoas: args.target_roas,
        });
        if (!didUpdateAdGroup) return { success: false, error: 'This tool does not support updating the field(s) requested for AD_GROUP — nothing was sent to Google Ads, no changes were made.' };
        return { success: true, message: 'Ad group updated' };
      }
      if (action === 'REMOVE') {
        if (!args.ad_group_resource_name) return { success: false, error: 'ad_group_resource_name is required for REMOVE action' };
        await googleAdsService.removeAdGroup(userId, customer_id, args.ad_group_resource_name);
        return { success: true, message: 'Ad group removed' };
      }
    }

    if (entity_type === 'KEYWORD') {
      if (action === 'LIST') {
        if (!args.ad_group_resource_name) return { success: false, error: 'ad_group_resource_name is required for KEYWORD LIST' };
        const keywords = await googleAdsService.listKeywords(userId, customer_id, args.ad_group_resource_name);
        return { success: true, keywords };
      }
      if (action === 'ADD') {
        if (!args.ad_group_resource_name || !args.keywords) return { success: false, error: 'ad_group_resource_name and keywords array are required' };
        // ENG-1527: forward the caller's status. Same shape as the CAMPAIGN/AD_GROUP/AD
        // creates — the argument the schema advertises has to reach the service.
        await googleAdsService.addKeywords(userId, customer_id, args.ad_group_resource_name, args.keywords, args.status || 'PAUSED');
        return { success: true, message: `Added ${args.keywords.length} keyword(s)` };
      }
      if (action === 'ADD_NEGATIVE') {
        if ((!args.campaign_resource_name && !args.ad_group_resource_name) || !args.keywords) {
          return { success: false, error: 'keywords and either campaign_resource_name or ad_group_resource_name are required' };
        }
        await googleAdsService.addNegativeKeywords(userId, customer_id, {
          campaignResourceName: args.campaign_resource_name,
          adGroupResourceName: args.ad_group_resource_name,
        }, args.keywords);
        return { success: true, message: `Added ${args.keywords.length} negative keyword(s)` };
      }
      if (action === 'UPDATE') {
        if (!args.criterion_resource_name) return { success: false, error: 'criterion_resource_name is required for KEYWORD UPDATE' };
        const didUpdateKeyword = await googleAdsService.updateKeyword(userId, customer_id, args.criterion_resource_name, {
          status: args.status,
          cpcBidMicros: args.cpc_bid_micros,
        });
        if (!didUpdateKeyword) return { success: false, error: 'This tool does not support updating the field(s) requested for KEYWORD — nothing was sent to Google Ads, no changes were made.' };
        return { success: true, message: 'Keyword updated' };
      }
      if (action === 'REMOVE') {
        if (!args.criterion_resource_name) return { success: false, error: 'criterion_resource_name is required for KEYWORD REMOVE' };
        await googleAdsService.removeKeyword(userId, customer_id, args.criterion_resource_name);
        return { success: true, message: 'Keyword removed' };
      }
    }

    if (entity_type === 'LOCATION' && action === 'SEARCH') {
      if (!args.query) return { success: false, error: 'query is required for LOCATION SEARCH' };
      const locations = await googleAdsService.searchLocations(userId, customer_id, args.query, args.locale || 'en');
      return { success: true, locations };
    }

    if (entity_type === 'AD') {
      if (action === 'LIST') {
        if (!args.ad_group_resource_name) return { success: false, error: 'ad_group_resource_name is required for AD LIST' };
        const ads = await googleAdsService.listAds(userId, customer_id, args.ad_group_resource_name);
        return { success: true, ads };
      }
      if (action === 'CREATE') {
        if (!args.ad_group_resource_name || !args.type || !args.headlines || !args.descriptions || !args.final_url) {
          return { success: false, error: 'ad_group_resource_name, type, headlines, descriptions, and final_url are required to create an ad' };
        }
        // ENG-335: an ad added to an already-live campaign serves paid traffic
        // instantly — gate its final_url like a launch when the parent is ENABLED.
        // ENG-1358: adding a creative to an already-ENABLED campaign is a launch too. The
        // gate already computes the warning; relaying it here is what stops it being
        // computed and discarded — the exact failure this ticket's own comment names.
        // ENG-1527: fails CLOSED when the parent's status cannot be established — see
        // guardCreativeAddition for why "the RESUME gate still guards it" was inverted.
        const adGate = await guardCreativeAddition({
          customerId: customer_id,
          action: 'AD_CREATE',
          override: overrideTrackingCheck,
          sessionId: opts?.sessionId,
          finalUrls: [args.final_url],
          resolveParent: () => googleAdsService.getAdGroupCampaign(userId, customer_id, args.ad_group_resource_name),
        });
        if (!adGate.proceed) return adGate.blockResult;
        const creativeTrackingWarning = adGate.warning;
        let adType = args.type as string;
        if (adType === 'SEARCH') adType = 'RESPONSIVE_SEARCH_AD';
        else if (adType === 'DISPLAY') adType = 'RESPONSIVE_DISPLAY_AD';
        const ad = await googleAdsService.createAd(userId, customer_id, {
          adGroupResourceName: args.ad_group_resource_name,
          type: adType as 'RESPONSIVE_SEARCH_AD' | 'RESPONSIVE_DISPLAY_AD',
          headlines: args.headlines,
          descriptions: args.descriptions,
          finalUrl: args.final_url,
          imageAssetResourceNames: args.image_asset_resource_names,
          // ENG-1514, same as the AD_GROUP CREATE above: the status the caller
          // asked for has to reach the service, or a staged ad goes live the
          // moment its campaign is enabled.
          status: args.status || 'PAUSED',
        });
        // ENG-2235: fire-and-forget lineage stamp (inert unless CREATIVE_LINEAGE_ENABLED).
        if (ad?.resourceName && Array.isArray(args.image_asset_resource_names)) {
          void stampGoogleAdCreated({ userId, customerId: String(customer_id), adResourceName: ad.resourceName, assetResourceNames: args.image_asset_resource_names });
        }
        return { success: true, adResourceName: ad.resourceName, ...(creativeTrackingWarning ? { trackingWarning: creativeTrackingWarning } : {}) };
      }
      if (action === 'UPDATE') {
        if (!args.ad_resource_name) return { success: false, error: 'ad_resource_name is required for AD UPDATE' };
        const didUpdateAd = await googleAdsService.updateAd(userId, customer_id, args.ad_resource_name, {
          status: args.status,
          // ENG-2979: RSA content edits (headlines/descriptions/final_url), read back by the service.
          ...(Array.isArray(args.headlines) ? { headlines: args.headlines } : {}),
          ...(Array.isArray(args.descriptions) ? { descriptions: args.descriptions } : {}),
          ...(typeof args.final_url === 'string' ? { finalUrl: args.final_url } : {}),
        });
        if (!didUpdateAd) return { success: false, error: 'This tool does not support updating the field(s) requested for AD — nothing was sent to Google Ads, no changes were made.' };
        return { success: true, message: 'Ad updated' };
      }
      if (action === 'REMOVE') {
        if (!args.ad_resource_name) return { success: false, error: 'ad_resource_name is required for AD REMOVE' };
        await googleAdsService.removeAd(userId, customer_id, args.ad_resource_name);
        return { success: true, message: 'Ad removed' };
      }
      if (action === 'RETAG_UTM') {
        // ENG-239 retrofit: retags ONE existing ad, never a list.
        if (!args.ad_resource_name) return { success: false, error: 'ad_resource_name is required for AD RETAG_UTM' };
        const result = await googleAdsService.retagAdUtm(userId, customer_id, args.ad_resource_name);
        if (!result.success) {
          return {
            success: false,
            error: result.reason === 'no_destination_url'
              ? 'This ad has no destination URL to tag.'
              : result.reason === 'invalid_resource_name'
              ? 'ad_resource_name is not a valid Google Ads resource name.'
              : 'No change was made — the ad already carries every UTM key, or the campaign-level read needed to avoid clobbering existing tracking failed.',
          };
        }
        return { success: true, message: 'Ad retagged with UTMs' };
      }
    }

    if (entity_type === 'CAMPAIGN_ASSET' && action === 'ATTACH') {
      if (!args.campaign_resource_name || !args.assets) return { success: false, error: 'campaign_resource_name and assets array are required for CAMPAIGN_ASSET ATTACH' };
      await googleAdsService.attachCampaignAssets(userId, customer_id, args.campaign_resource_name, args.assets);
      return { success: true, message: `Attached ${args.assets.length} asset(s) to campaign` };
    }

    if (entity_type === 'ASSET' && action === 'UPLOAD') {
      if (!args.asset_type || !args.name || !args.data) return { success: false, error: 'asset_type, name, and data are required for ASSET UPLOAD' };
      const resourceName = await googleAdsService.uploadAsset(userId, customer_id, {
        type: args.asset_type,
        name: args.name,
        data: args.data,
      });
      // ENG-2235: only a URL upload can resolve to a generated creative.
      if (resourceName && typeof args.data === 'string' && args.data.startsWith('https://')) {
        void stampGoogleAssetUpload({ userId, imageUrl: args.data, assetResourceName: resourceName });
      }
      return { success: true, assetResourceName: resourceName };
    }

    if (entity_type === 'ASSET_GROUP' && action === 'CREATE') {
      if (!args.name || !args.campaign_resource_name || !args.headlines || !args.long_headlines ||
          !args.descriptions || !args.square_image_assets || !args.landscape_image_assets ||
          !args.logo_assets || !args.final_url) {
        return { success: false, error: 'name, campaign_resource_name, headlines, long_headlines, descriptions, square_image_assets, landscape_image_assets, logo_assets, and final_url are required' };
      }
      // ENG-335: a PMax asset group added to an already-live campaign serves paid
      // traffic instantly — gate its final_url like a launch when the parent is ENABLED.
      // Same relay as AD CREATE — a PMax asset group on an ENABLED campaign is a launch —
      // and the same ENG-1527 fail-closed treatment, through the same helper so the two
      // call sites cannot drift apart.
      const assetGroupGate = await guardCreativeAddition({
        customerId: customer_id,
        action: 'ASSET_GROUP_CREATE',
        override: overrideTrackingCheck,
        sessionId: opts?.sessionId,
        finalUrls: [args.final_url],
        resolveParent: async () => ({
          campaignResourceName: args.campaign_resource_name,
          campaignStatus: await googleAdsService.getCampaignStatus(userId, customer_id, args.campaign_resource_name),
        }),
      });
      if (!assetGroupGate.proceed) return assetGroupGate.blockResult;
      const creativeTrackingWarning = assetGroupGate.warning;
      const assetGroup = await googleAdsService.createAssetGroup(userId, customer_id, {
        name: args.name,
        campaignResourceName: args.campaign_resource_name,
        headlines: args.headlines,
        longHeadlines: args.long_headlines,
        descriptions: args.descriptions,
        squareImageAssets: args.square_image_assets,
        landscapeImageAssets: args.landscape_image_assets,
        logoAssets: args.logo_assets,
        videoAssets: args.video_assets,
        finalUrl: args.final_url,
      });
      return { success: true, assetGroupResourceName: assetGroup.resourceName, ...(creativeTrackingWarning ? { trackingWarning: creativeTrackingWarning } : {}) };
    }

    if (entity_type === 'ASSET_GROUP' && action === 'UPDATE') {
      // ENG-2928: asset groups are created PAUSED, so a PMax launch needs this. Enabling one
      // under an ENABLED campaign serves paid traffic instantly — gated like ASSET_GROUP CREATE.
      if (!args.asset_group_resource_name) return { success: false, error: 'asset_group_resource_name is required for ASSET_GROUP UPDATE' };
      if (args.status !== 'ENABLED' && args.status !== 'PAUSED') return { success: false, error: 'This tool does not support updating the field(s) requested for ASSET_GROUP — nothing was sent to Google Ads, no changes were made.' };
      let creativeTrackingWarning: string | undefined;
      if (args.status === 'ENABLED') {
        const assetGroup = await googleAdsService.getAssetGroup(userId, customer_id, args.asset_group_resource_name);
        const gate = await guardCreativeAddition({
          customerId: customer_id,
          action: 'ASSET_GROUP_UPDATE',
          override: overrideTrackingCheck,
          sessionId: opts?.sessionId,
          finalUrls: assetGroup?.finalUrls ?? [],
          resolveParent: async () => (assetGroup
            ? { campaignResourceName: assetGroup.campaignResourceName, campaignStatus: await googleAdsService.getCampaignStatus(userId, customer_id, assetGroup.campaignResourceName) }
            : null),
        });
        if (!gate.proceed) return gate.blockResult;
        creativeTrackingWarning = gate.warning;
      }
      await googleAdsService.updateAssetGroup(userId, customer_id, args.asset_group_resource_name, { status: args.status });
      return { success: true, message: 'Asset group updated', ...(creativeTrackingWarning ? { trackingWarning: creativeTrackingWarning } : {}) };
    }

    if (entity_type === 'ASSET_GROUP' && action === 'RETAG_UTM') {
      // ENG-239 PMax retrofit: retags ONE existing asset group, never a list.
      if (!args.asset_group_resource_name) return { success: false, error: 'asset_group_resource_name is required for ASSET_GROUP RETAG_UTM' };
      const result = await googleAdsService.retagAssetGroupUtm(userId, customer_id, args.asset_group_resource_name);
      if (!result.success) {
        return {
          success: false,
          error: result.reason === 'no_destination_url'
            ? 'This asset group has no destination URL to tag.'
            : result.reason === 'invalid_resource_name'
            ? 'asset_group_resource_name is not a valid Google Ads resource name.'
            : 'No change was made — the destination already carries every UTM key (directly or via the campaign\'s final_url_suffix), or the URL could not be read.',
        };
      }
      return { success: true, message: 'Asset group retagged with UTMs' };
    }

    return { success: false, error: `Unsupported entity_type=${entity_type} action=${action}` };
  } catch (error: any) {
    // ENG-1300: `code` here is the real numeric HTTP status (googleAdsService.
    // callApi rethrows the SAME axios error, so error.response.status is
    // intact) — NOT `gadsErrorCodes` below, which are Google Ads' own string
    // enum names (e.g. "REQUEST_ERROR"), not HTTP statuses. Conflating the two
    // would misclassify: a business code that happens to fall in 100-599
    // would be read as if it were the transport status.
    const code = error?.response?.status;
    if (error instanceof NegativeCampaignCriteriaValidationError) {
      return {
        success: false,
        errorType: error.errorType,
        errorCode: error.errorCode,
        error: error.message,
        code,
      };
    }
    if (error?.name === 'GoogleAdsReadBackError' && error?.code === 'unsupported_field') {
      // ENG-592: mutate said success, read-back says unchanged. Never relay as success.
      return { success: false, errorType: error.code, errorCode: error.code, fields: error.fields, error: error.message };
    }
    if (error.isGoogleAdsAuthError) return { success: false, error: error.message, authError: true, code };
    console.error('[AgentMode] handleCallGoogleAdsApi error:', error);
    const gadsErrors: any[] = error?.response?.data?.error?.details?.[0]?.errors || [];
    const gadsErrorCodes = gadsErrors
      .map((e: any) => Object.values(e.errorCode || {})[0])
      .filter(Boolean);
    const gadsError = gadsErrors.length
      ? gadsErrors.map((e: any) => {
          const code = Object.values(e.errorCode || {})[0];
          const text = code ? `${code}: ${e.message}` : e.message;
          const reasons = googleAdsPolicyReasons(e);
          return reasons ? `${text} Policy: ${reasons}.` : text;
        }).join('; ')
      : undefined;
    if (args.entity_type === 'CAMPAIGN_CRITERION') {
      return {
        success: false,
        errorType: gadsError ? 'GOOGLE_ADS_API_ERROR' : 'INTERNAL_ERROR',
        errorCode: gadsErrorCodes[0] || 'UNKNOWN_GOOGLE_ADS_ERROR',
        error: gadsError || error.message || 'Unknown error',
        code,
      };
    }
    return { success: false, error: gadsError || error.message || 'Unknown error', code };
  }
}

export async function handleCallGoogleAdsReportingApi(userId: string, args: {
  customer_id: string;
  mode: 'raw' | 'dashboard' | 'serving_chain';
  query?: string;
  campaign_ids?: string[];
  date_preset?: string;
}, opts?: { clientScope?: { clientId?: string; callerIsAdmin?: boolean; toolName: string } }): Promise<any> {
  try {
    // ENG-1944: fully read-only tool, so client_id is always safe to honor here —
    // no write-scope restriction needed (see handleCallGoogleAdsApi for why that
    // restriction exists on the mixed read/write tool).
    if (opts?.clientScope?.clientId !== undefined && opts?.clientScope?.clientId !== null) {
      const scope = await resolveGoogleAdsCredentialScope(
        userId, opts.clientScope.clientId, opts.clientScope.callerIsAdmin, opts.clientScope.toolName ?? 'call_google_ads_reporting_api'
      );
      userId = scope.effectiveUserId;
    }
    if (args.mode === 'serving_chain') {
      const report = await googleAdsService.getServingChainStatus(userId, args.customer_id, args.campaign_ids);
      const success = report.state === 'READY' || report.state === 'DELIVERING';
      return { success, report, ...(success ? {} : { error: JSON.stringify(report) }) };
    }

    if (args.mode === 'dashboard') {
      const summary = await googleAdsService.getQuickMetrics(userId, args.customer_id, {
        campaignIds: args.campaign_ids,
        datePreset: args.date_preset || 'LAST_30_DAYS',
      });
      const { campaigns, totals, currency } = summary;
      const rows = campaigns.map((c: any) =>
        `| ${c.name} | ${c.status} | ${c.impressions.toLocaleString()} | ${c.clicks.toLocaleString()} | ${c.ctr.toFixed(2)}% | ${currency} ${c.spendFormatted} | ${c.conversions} | ${c.avgCpc} |`
      ).join('\n');
      const formattedMarkdown = `## Google Ads Performance\n\n| Campaign | Status | Impressions | Clicks | CTR | Spend | Conversions | Avg CPC |\n|---|---|---|---|---|---|---|---|\n${rows}\n\n**Totals:** ${totals.impressions.toLocaleString()} impressions · ${totals.clicks.toLocaleString()} clicks · ${currency} ${totals.spend.toFixed(2)} spend · ${totals.conversions} conversions`;
      return { success: true, formattedMarkdown, summary };
    }

    if (args.mode === 'raw') {
      if (!args.query) return { success: false, error: 'query is required for raw mode' };
      const results = await googleAdsService.queryReporting(userId, args.customer_id, args.query);
      return { success: true, results, totalRows: results.length };
    }

    return { success: false, error: 'mode must be "raw", "dashboard", or "serving_chain"' };
  } catch (error: any) {
    // ENG-1300: see handleCallGoogleAdsApi's catch above for why `code` is
    // error.response.status specifically, never a Google Ads business code.
    const code = error?.response?.status;
    if (error.isGoogleAdsAuthError) return { success: false, error: error.message, authError: true, code };
    console.error('[AgentMode] handleCallGoogleAdsReportingApi error:', error);
    const gadsErrors: any[] = error?.response?.data?.error?.details?.[0]?.errors || [];
    const gadsError = gadsErrors.length ? gadsErrors.map((e: any) => e.message).join('; ') : undefined;
    return { success: false, error: gadsError || error.message || 'Unknown error', code };
  }
}

// ─── HubSpot Campaigns ──────────────────────────────────────────────────────

export async function resolveHubSpotService(userId: string, accountId?: string): Promise<HubSpotService> {
  // Order matters (ENG-2605): the caller's OWN OAuth account, then a private-app token pasted on one
  // of their own lead lists, and only then an account an org admin shared. A shared account must never
  // pre-empt something the caller connected themselves, or a call lands in a teammate's portal.
  let ownErr: any;
  try {
    return await HubSpotService.create(userId, accountId, 'own');
  } catch (err: any) {
    ownErr = err;
    // An explicit account_id or a multi-account ambiguity is actionable by the
    // caller — surface it instead of silently falling back to token-paste.
    if (/multiple hubspot accounts/i.test(err?.message ?? '')) throw err;
    // Fall back to token-paste: scan lead lists for HubSpot apiKeyEncrypted
  }
  if (!accountId) {
    const { crmDb } = await import('../../services/db');
    const lists = await crmDb.getLeadListsByUserId(userId);
    for (const list of lists as any[]) {
      const hubspotConfig = list?.externalCrmSyncConfigs?.hubspot;
      if (hubspotConfig?.apiKeyEncrypted) {
        const { decryptPassword } = await import('../../utils/crypto');
        const { password } = decryptPassword(hubspotConfig.apiKeyEncrypted);
        return HubSpotService.fromToken(password);
      }
    }
  }
  // A shared account only stands in when the caller has NONE of their own. An own account that exists
  // but fails (a revoked grant, a refresh error) keeps its old outcome: quietly switching to a teammate's
  // portal would send the call somewhere the caller never chose.
  if (/not connected|not found/i.test(ownErr?.message ?? '')) {
    try {
      return await HubSpotService.create(userId, accountId, 'shared');
    } catch (err: any) {
      // Anything but "there is none" is actionable and surfaces (several shared accounts, or one whose
      // owner's grant needs reconnecting); "there is none" falls through to the original messages.
      if (!/not connected|not found/i.test(err?.message ?? '')) throw err;
    }
  }
  if (accountId) throw ownErr;
  throw new Error('No HubSpot account connected. Please connect HubSpot in Settings → External CRM Sync or via OAuth in Connected Accounts.');
}

/**
 * HubSpot's free-text 403 message, made safe to log.
 *
 * A review flagged that the previous version wrote `response.data.message` verbatim on
 * the strength of a comment asserting it "carries no credentials" — asserted, never
 * measured. HubSpot's MISSING_SCOPES message is widely reported in the form
 * "This oauth-token (<token>) does not have proper permissions!", which would put a
 * live access token in the application log on exactly the branch this diagnostic is
 * for: the same class of leak redactAxiosCredentials exists to prevent.
 *
 * `category` and `correlationId` already satisfy the diagnostic goal, so the message is
 * kept only for the scope hint it carries — with anything token-shaped removed and a
 * hard length cap, the way describeRefreshFailure caps its body.
 */
function redactHubSpotMessage(msg: unknown): string | null {
  if (typeof msg !== 'string') return msg == null ? null : '<non-string>';
  let out = msg
    // HubSpot's own "(oauth-token)" parenthetical, and any bare long token-ish run.
    // No dot inside: `(marketing.campaigns.revenue.read)` is a SCOPE NAME and is the
    // very hint this field is kept for. Rules 1 and 2 use different character classes
    // on purpose — do not tidy them into agreement.
    .replace(/\(\s*[A-Za-z0-9_-]{20,}\s*\)/g, '(<redacted>)')
    .replace(/\b(?:pat-[a-z0-9-]+|na1-[A-Za-z0-9-]{8,}|[A-Za-z0-9_-]{40,})\b/g, '<redacted>');
  if (out.length > 300) out = `${out.slice(0, 300)}…<truncated>`;
  return out;
}

/** The same redaction applied to a whole HubSpot error body before it leaves us. */
function redactHubSpotBody(body: unknown, depth = 0): unknown {
  // Walk EVERY string, not just a top-level `message`. HubSpot returns at least four
  // shapes and only one was covered: `{errors:[{message}]}` (which this codebase
  // already depends on — throwIfBatchPartialFailure reads data.errors[0].message), a
  // bare string body from a proxy or WAF, `{context:{detail}}`, and a top-level array.
  // Having accepted that a token can ride in free text, the coverage has to match the
  // threat model rather than the one sentence that was reported.
  // Fail CLOSED. Returning the raw sub-tree here would hand back tokens intact — a
  // theoretical leak in a control whose whole premise is that free text can carry a
  // credential. Losing a deeply nested diagnostic is the cheaper failure. Real HubSpot
  // bodies are depth <= 3, so this is unreachable either way.
  if (depth > 6) return '<depth-capped>';
  if (typeof body === 'string') return redactHubSpotMessage(body);
  if (Array.isArray(body)) return body.map((v) => redactHubSpotBody(v, depth + 1));
  if (!body || typeof body !== 'object') return body ?? null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = redactHubSpotBody(v, depth + 1);
  }
  return out;
}

/** Marketing Hub objects served by call_hubspot_api. CONTACT_LIST is CRM, not here. */
const HUBSPOT_MARKETING_ENTITIES = new Set([
  'CAMPAIGN', 'EMAIL', 'FORM', 'LANDING_PAGE', 'BLOG_POST', 'WORKFLOW', 'SOCIAL',
]);

/**
 * Returns an actionable error when the resolved OAuth grant holds no marketing scopes
 * at all and the caller asked for a marketing object. Returns null to proceed.
 *
 * Best-effort by design: any problem resolving the account returns null so the call
 * goes ahead and HubSpot decides. This guard exists to improve a message, and must
 * never become a new way for a working call to fail.
 */
async function hubspotMarketingPreflight(
  userId: string,
  svc: HubSpotService,
  entityType: string,
  action: string,
): Promise<{ success: false; error: string } | null> {
  if (!HUBSPOT_MARKETING_ENTITIES.has(entityType)) return null;
  // FORM SUBMIT is the one guarded action that needs no OAuth scope at all: submitForm
  // posts to api.hsforms.com keyed by portalId + formGuid and sends NO bearer token
  // (hubspotService.submitForm). Every other method behind these seven entities goes
  // through authHeaders() against api.hubapi.com. Refusing it would break a call that
  // works on a CRM-only grant today — and tell the customer to reconnect to fix a
  // request that carries no token.
  if (entityType === 'FORM' && action === 'SUBMIT') return null;
  try {
    // The account that ACTUALLY served this call, read off the instance. undefined means
    // the pasted private-app-token path ran, whose scopes we cannot see and must not
    // guess at.
    //
    // Deliberately not re-derived, and deliberately not carried on `this`. An earlier
    // version recorded it in a field on this service — which is a process-wide
    // singleton with a second writer — and the pasted-token fallback does real I/O
    // (getLeadListsByUserId) between the reset and the read, so a concurrent call
    // finishing the OAuth path left its id in the slot. A review reproduced that
    // crossing 300/300.
    const accountId = svc.accountId;
    if (!accountId) return null;
    const { getAccountsByUserId } = await import('../../services/connectedAccountsDb');
    const accounts = await getAccountsByUserId(userId);
    const hs = accounts.filter((a: any) => a.platform === 'hubspot');
    const acct = hs.find((a: any) => a.account_id === accountId);
    if (!acct) return null;
    const granted: string[] = ((acct.config as any)?.granted_scopes ?? []) as string[];
    if (!Array.isArray(granted) || granted.length === 0) return null;
    const { INTEGRATION_CONFIG } = await import('../../config/integrations');
    const marketingOnly: readonly string[] = (INTEGRATION_CONFIG as any)?.hubspot?.marketingOnlyScopes ?? [];
    if (marketingOnly.length === 0) return null;
    if (granted.some((g) => marketingOnly.includes(g))) return null;
    // hubspotAuth persists whether the user CHOSE marketing at connect time. If they
    // did and HubSpot still granted no marketing scope, HubSpot declined the
    // optional_scope — the portal has no Marketing Hub. Telling them to reconnect and
    // pick marketing sends them through the exact round trip that changes nothing,
    // which is the behaviour this whole change exists to stop.
    const askedForMarketing = (acct.config as any)?.hubspot_account_type === 'marketing';
    return {
      success: false,
      error: askedForMarketing
        ? `This HubSpot portal does not have Marketing Hub, so it cannot read or write `
          + `${entityType} (a Marketing Hub object). Marketing access was requested when the `
          + `account was connected and HubSpot did not grant it. Reconnecting will not change `
          + `this — the portal's HubSpot plan has to include Marketing Hub.`
        : `This HubSpot connection was authorised for CRM access only, so it cannot read or write `
          + `${entityType} (a Marketing Hub object). Reconnect HubSpot in Settings → Connected Accounts `
          + `and choose the marketing option to grant marketing access. Reconnecting with CRM access `
          + `again will not change this.`,
    };
  } catch {
    return null;
  }
}

import { normalizeHubSpotArgs } from '../../services/agentMode/crmToolArgs';

/** Deal fields returned by DEALS SEARCH (callers may add more via `properties`). */
const HUBSPOT_DEAL_PROPS = [
  'dealname', 'amount', 'dealstage', 'pipeline', 'createdate', 'closedate',
  'hs_lastmodifieddate', 'hubspot_owner_id', 'hs_analytics_source', 'hs_analytics_source_data_1', 'hs_analytics_source_data_2',
];

/** Contact source/UTM fields used for campaign-to-pipeline attribution. */
const HUBSPOT_CONTACT_ATTRIBUTION_PROPS = [
  'email', 'firstname', 'lastname', 'company', 'jobtitle', 'createdate', 'lifecyclestage',
  'hs_analytics_source', 'hs_analytics_source_data_1', 'hs_analytics_source_data_2',
  'hs_latest_source', 'hs_latest_source_data_1', 'hs_latest_source_data_2',
  'hs_analytics_first_url', 'hs_analytics_first_referrer', 'recent_conversion_event_name', 'first_conversion_event_name',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
];

function mergeProps(base: string[], extra: unknown): string[] {
  const add = Array.isArray(extra) ? extra.map(String) : typeof extra === 'string' ? extra.split(',') : [];
  return [...new Set([...base, ...add.map((s) => s.trim()).filter(Boolean)])];
}

/** created_after / created_before (ISO date or epoch ms) → HubSpot createdate filters. */
export function hubspotDateFilters(args: any):
  { filters: Array<{ propertyName: string; operator: string; value?: string; values?: string[] }> } | { error: string } {
  const filters: Array<{ propertyName: string; operator: string; value?: string }> = [];
  for (const [key, op] of [['created_after', 'GTE'], ['created_before', 'LT']] as const) {
    const raw = args?.[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const s = String(raw).trim();
    // Pure digits: 13+ digits is epoch ms; 9-12 digits is epoch seconds (an epoch-ms value
    // that short would be a 1970 date, which no caller means). Shorter digit runs are rejected.
    let ms: number;
    if (/^\d+$/.test(s)) {
      if (s.length < 9) return { error: `${key} must be an ISO date (e.g. 2026-11-01), epoch seconds, or epoch milliseconds.` };
      ms = s.length >= 13 ? Number(s) : Number(s) * 1000;
    } else {
      ms = Date.parse(s);
    }
    if (!Number.isFinite(ms)) return { error: `${key} must be an ISO date (e.g. 2026-11-01), epoch seconds, or epoch milliseconds.` };
    filters.push({ propertyName: 'createdate', operator: op, value: String(ms) });
  }
  return { filters };
}

/**
 * ENG-2840 (W2-9): options for the MCP read route (`POST /api/emma/hubspot-read`). Emma's own tool passes none, and every option left
 * out keeps the old behaviour exactly.
 */
export interface HubspotApiOptions {
  /** Told which connection will serve the call, once it is resolved (the route says in its answer whose account answered). */
  onResolved?: (svc: HubSpotService) => void;
  /** DEALS GET_CONTACTS: read at most this many of the deal's contacts, and stop paging associations once more than this many ids are
   * held (the answer then has `contacts_cut: true`). Default: every page and every contact, as before. */
  maxDealContacts?: number;
}

export async function handleHubspotApi(userId: string, args: any, options: HubspotApiOptions = {}): Promise<any> {
  args = normalizeHubSpotArgs(args);
  const entityType: string = (args?.entity_type ?? '').toUpperCase();
  const action: string = (args?.action ?? '').toUpperCase();
  try {
    const svc = await resolveHubSpotService(userId, args?.account_id);
    options.onResolved?.(svc);

    // Refuse a call the connection provably cannot serve, BEFORE spending a round trip
    // on a guaranteed 403 whose message does not name the real problem.
    //
    // Every entity below CONTACT_LIST is a Marketing Hub object; CONTACT_LIST is CRM
    // (crm.lists.*). In production 6 of 10 HubSpot grants hold NONE of
    // integrations.hubspot.marketingOnlyScopes, so every marketing call they make 403s
    // and the customer is told to "check your subscription tier and OAuth scopes" —
    // true but unactionable, and it does not tell them which.
    //
    // Deliberately coarse: it fires only when the grant holds ZERO marketing scopes,
    // where a 403 is certain. A grant holding `content` but not `forms` still reaches
    // HubSpot and fails there. A precise per-entity scope map is the obvious next step,
    // but it would be guesswork today — the 403 diagnostic added below is what will
    // supply the real requirements.
    //
    // OAuth only. resolveHubSpotService falls back to a pasted private-app token whose
    // scopes we cannot see, and blocking on scopes we do not know would break working
    // setups.
    const preflight = await hubspotMarketingPreflight(userId, svc, entityType, action);
    if (preflight) return preflight;

    if (entityType === 'CONTACTS') {
      if (action === 'LIST') return { success: true, ...await svc.listContacts(args?.cursor) };
      if (action === 'SEARCH') {
        const filters = hubspotDateFilters(args);
        if ('error' in filters) return { success: false, error: filters.error };
        const properties = mergeProps(HUBSPOT_CONTACT_ATTRIBUTION_PROPS, args?.properties);
        const page = await svc.searchCrmObjects('contacts', {
          filters: filters.filters, properties, cursor: args?.cursor, limit: args?.limit,
          sortBy: 'createdate', sortDirection: 'DESCENDING',
        });
        return { success: true, entity_type: 'CONTACTS', total: page.total, contacts: page.results, nextCursor: page.nextCursor };
      }
      return { success: false, error: 'Valid CONTACTS actions: LIST (cursor?), SEARCH (created_after?, created_before?, properties?, limit?, cursor?).' };
    }

    // ─── DEALS (read-only) ─────────────────────────────────────────────────
    if (entityType === 'DEALS') {
      switch (action) {
        case 'LIST_PIPELINES':
          return { success: true, pipelines: await svc.listDealPipelines() };
        case 'SEARCH': {
          const filters = hubspotDateFilters(args);
          if ('error' in filters) return { success: false, error: filters.error };
          const f = [...filters.filters];
          if (args?.pipeline) f.push({ propertyName: 'pipeline', operator: 'EQ', value: String(args.pipeline) });
          let stageIds: string[] = [];
          const stageArg = args?.deal_stage ?? args?.dealstage;
          if (stageArg) {
            // Accept either an internal stage id or a human label ("New Business Meetings").
            const wanted = String(stageArg).trim().toLowerCase();
            const pipelines = await svc.listDealPipelines();
            const scoped = pipelines.filter((p) => !args?.pipeline || p.id === String(args.pipeline));
            // An exact stage id wins over a stage whose label happens to equal it.
            for (const p of scoped) for (const s of p.stages) if (s.id.toLowerCase() === wanted) stageIds.push(s.id);
            if (!stageIds.length) {
              for (const p of scoped) for (const s of p.stages) if (s.label.trim().toLowerCase() === wanted) stageIds.push(s.id);
            }
            if (!stageIds.length) {
              return {
                success: false,
                error: `No deal stage matches "${stageArg}". Use DEALS LIST_PIPELINES to see stage ids and labels.`,
              };
            }
            stageIds = [...new Set(stageIds)];
            f.push(stageIds.length === 1
              ? { propertyName: 'dealstage', operator: 'EQ', value: stageIds[0] }
              : { propertyName: 'dealstage', operator: 'IN', values: stageIds });
          }
          const properties = mergeProps(HUBSPOT_DEAL_PROPS, args?.properties);
          const page = await svc.searchCrmObjects('deals', {
            filters: f, properties, cursor: args?.cursor, limit: args?.limit,
            sortBy: 'createdate', sortDirection: 'DESCENDING',
          });
          return { success: true, entity_type: 'DEALS', matched_stage_ids: stageIds, total: page.total, deals: page.results, nextCursor: page.nextCursor };
        }
        case 'GET_CONTACTS': {
          const dealId = args?.deal_id ?? args?.id;
          if (!dealId) return { success: false, error: 'deal_id is required for DEALS GET_CONTACTS.' };
          // Emma's call (no maxDealContacts) reads every association page, exactly as before. The MCP route's bound stops paging once
          // more than `max` ids are held, so how many the deal has in all is not known then: the answer only says the list was cut.
          const max = options.maxDealContacts;
          const allIds = max !== undefined
            ? await svc.getDealContactAssociations(String(dealId), { stopAfter: Math.max(0, max) })
            : await svc.getDealContactAssociations(String(dealId));
          const ids = max !== undefined && allIds.length > max ? allIds.slice(0, Math.max(0, max)) : allIds;
          const contacts = ids.length
            ? await svc.batchReadContacts(ids, mergeProps(HUBSPOT_CONTACT_ATTRIBUTION_PROPS, args?.properties))
            : [];
          if (ids.length < allIds.length) return { success: true, deal_id: String(dealId), contacts, contacts_cut: true };
          return { success: true, deal_id: String(dealId), contacts };
        }
        default:
          return { success: false, error: `Unknown action "${action}" for DEALS. Valid (read-only): LIST_PIPELINES, SEARCH, GET_CONTACTS.` };
      }
    }

    // ─── CONTACT_LIST ──────────────────────────────────────────────────────
    if (entityType === 'CONTACT_LIST') {
      switch (action) {
        case 'LIST': {
          const data = await svc.listContactLists({ query: args?.query, cursor: args?.cursor, count: args?.count });
          return { success: true, ...data };
        }
        case 'GET': {
          if (!args?.list_id) return { success: false, error: 'list_id is required for CONTACT_LIST GET.' };
          const data = await svc.getContactList(args.list_id);
          return { success: true, ...data };
        }
        case 'CREATE': {
          const name: string = args?.name ?? '';
          if (!name.trim()) return { success: false, error: 'name is required for CONTACT_LIST CREATE.' };
          const processingType: string = args?.processing_type ?? '';
          if (!processingType.trim()) return { success: false, error: 'processing_type (MANUAL|SNAPSHOT|DYNAMIC) is required for CONTACT_LIST CREATE.' };
          const data = await svc.createContactList(name, processingType, { objectTypeId: args?.object_type_id, filterBranch: args?.filter_branch });
          return { success: true, ...data };
        }
        case 'ADD_CONTACTS': {
          if (!args?.list_id) return { success: false, error: 'list_id is required for CONTACT_LIST ADD_CONTACTS.' };
          const recordIds: string[] = args?.record_ids ?? [];
          if (!recordIds.length) return { success: false, error: 'record_ids array is required for CONTACT_LIST ADD_CONTACTS.' };
          const data = await svc.addContactsToList(args.list_id, recordIds);
          return { success: true, ...data };
        }
        case 'REMOVE_CONTACTS': {
          if (!args?.list_id) return { success: false, error: 'list_id is required for CONTACT_LIST REMOVE_CONTACTS.' };
          const recordIds: string[] = args?.record_ids ?? [];
          if (!recordIds.length) return { success: false, error: 'record_ids array is required for CONTACT_LIST REMOVE_CONTACTS.' };
          const data = await svc.removeContactsFromList(args.list_id, recordIds);
          return { success: true, ...data };
        }
        case 'DELETE': {
          if (!args?.list_id) return { success: false, error: 'list_id is required for CONTACT_LIST DELETE.' };
          await svc.deleteContactList(args.list_id);
          return { success: true, deleted: args.list_id };
        }
        default:
          return { success: false, error: `Unknown action "${action}" for CONTACT_LIST. Valid: LIST, GET, CREATE, ADD_CONTACTS, REMOVE_CONTACTS, DELETE.` };
      }
    }

    // ─── CAMPAIGN ──────────────────────────────────────────────────────────
    if (entityType === 'CAMPAIGN') {
      const guid: string | undefined = args?.guid;
      switch (action) {
        case 'LIST': {
          const data = await svc.listCampaigns(args?.cursor);
          return { success: true, ...data };
        }
        case 'GET': {
          if (!guid) return { success: false, error: 'guid is required for CAMPAIGN GET.' };
          const [campaign, metrics] = await Promise.allSettled([
            svc.getCampaign(guid),
            svc.getCampaignMetrics(guid),
          ]);
          if (campaign.status === 'rejected') {
            return { success: false, error: (campaign as PromiseRejectedResult).reason?.message ?? 'Failed to fetch campaign.' };
          }
          return {
            success: true,
            campaign: campaign.value,
            metrics: metrics.status === 'fulfilled' ? metrics.value : { error: (metrics as PromiseRejectedResult).reason?.message },
          };
        }
        case 'CREATE': {
          const name: string = args?.name ?? '';
          if (!name.trim()) return { success: false, error: 'name is required for CAMPAIGN CREATE.' };
          const data = await svc.createCampaign(name, { startDate: args?.start_date, notes: args?.notes, utm: args?.utm });
          return { success: true, ...data };
        }
        case 'UPDATE': {
          if (!guid) return { success: false, error: 'guid is required for CAMPAIGN UPDATE.' };
          const data = await svc.updateCampaign(guid, { name: args?.name, startDate: args?.start_date, notes: args?.notes, utm: args?.utm });
          return { success: true, ...data };
        }
        case 'DELETE': {
          if (!guid) return { success: false, error: 'guid is required for CAMPAIGN DELETE.' };
          await svc.deleteCampaign(guid);
          return { success: true, deleted: guid };
        }
        case 'GET_METRICS': {
          if (!guid) return { success: false, error: 'guid is required for CAMPAIGN GET_METRICS.' };
          const data = await svc.getCampaignMetrics(guid);
          return { success: true, ...data };
        }
        case 'LIST_ASSETS': {
          if (!guid) return { success: false, error: 'guid is required for CAMPAIGN LIST_ASSETS.' };
          const data = await svc.listCampaignAssets(guid, args?.asset_type, { startDate: args?.start_date, endDate: args?.end_date, cursor: args?.cursor });
          return { success: true, ...data };
        }
        case 'ADD_ASSET': {
          if (!guid) return { success: false, error: 'guid is required for CAMPAIGN ADD_ASSET.' };
          if (!args?.asset_type) return { success: false, error: 'asset_type is required for CAMPAIGN ADD_ASSET.' };
          if (!args?.asset_id) return { success: false, error: 'asset_id is required for CAMPAIGN ADD_ASSET.' };
          await svc.addCampaignAsset(guid, args.asset_type, args.asset_id);
          return { success: true, added: { guid, assetType: args.asset_type, assetId: args.asset_id } };
        }
        case 'REMOVE_ASSET': {
          if (!guid) return { success: false, error: 'guid is required for CAMPAIGN REMOVE_ASSET.' };
          if (!args?.asset_type) return { success: false, error: 'asset_type is required for CAMPAIGN REMOVE_ASSET.' };
          if (!args?.asset_id) return { success: false, error: 'asset_id is required for CAMPAIGN REMOVE_ASSET.' };
          await svc.removeCampaignAsset(guid, args.asset_type, args.asset_id);
          return { success: true, removed: { guid, assetType: args.asset_type, assetId: args.asset_id } };
        }
        default:
          return { success: false, error: `Unknown action "${action}" for CAMPAIGN. Valid: LIST, GET, CREATE, UPDATE, DELETE, GET_METRICS, LIST_ASSETS, ADD_ASSET, REMOVE_ASSET.` };
      }
    }

    // ─── EMAIL ─────────────────────────────────────────────────────────────
    if (entityType === 'EMAIL') {
      switch (action) {
        case 'LIST': {
          const data = await svc.listEmails(args?.cursor);
          return { success: true, ...data };
        }
        case 'GET': {
          if (!args?.email_id) return { success: false, error: 'email_id is required for EMAIL GET.' };
          const data = await svc.getEmail(args.email_id);
          return { success: true, ...data };
        }
        case 'GET_STATS': {
          const emailIds: string[] = args?.email_ids ?? [];
          if (!emailIds.length) return { success: false, error: 'email_ids array is required for EMAIL GET_STATS.' };
          const data = await svc.getEmailStatistics(emailIds, { startTimestamp: args?.start_timestamp, endTimestamp: args?.end_timestamp });
          return { success: true, ...data };
        }
        case 'CREATE': {
          const name: string = args?.name ?? '';
          if (!name.trim()) return { success: false, error: 'name is required for EMAIL CREATE.' };
          const data = await svc.createEmail(name, {
            subject: args?.subject, fromName: args?.from_name, fromEmail: args?.from_email,
            subscriptionId: args?.subscription_id,
            contactListsInclude: args?.contact_lists_include,
            contactListsExclude: args?.contact_lists_exclude,
            sendOnPublish: args?.send_on_publish,
            publishDate: args?.publish_date,
          });
          return { success: true, ...data };
        }
        case 'UPDATE': {
          if (!args?.email_id) return { success: false, error: 'email_id is required for EMAIL UPDATE.' };
          const data = await svc.updateEmail(args.email_id, {
            name: args?.name, subject: args?.subject, fromName: args?.from_name, fromEmail: args?.from_email,
            subscriptionId: args?.subscription_id,
            contactListsInclude: args?.contact_lists_include,
            contactListsExclude: args?.contact_lists_exclude,
            sendOnPublish: args?.send_on_publish,
            publishDate: args?.publish_date,
          });
          return { success: true, ...data };
        }
        case 'PUBLISH': {
          if (!args?.email_id) return { success: false, error: 'email_id is required for EMAIL PUBLISH.' };
          await svc.publishEmail(args.email_id);
          return { success: true, published: args.email_id };
        }
        case 'UNPUBLISH': {
          if (!args?.email_id) return { success: false, error: 'email_id is required for EMAIL UNPUBLISH.' };
          await svc.unpublishEmail(args.email_id);
          return { success: true, unpublished: args.email_id };
        }
        case 'LIST_SUBSCRIPTION_TYPES': {
          const data = await svc.listSubscriptionTypes();
          return { success: true, ...data };
        }
        case 'CLONE': {
          if (!args?.email_id) return { success: false, error: 'email_id is required for EMAIL CLONE.' };
          const name: string = args?.name ?? '';
          if (!name.trim()) return { success: false, error: 'name is required for EMAIL CLONE.' };
          const data = await svc.cloneEmail(args.email_id, name);
          return { success: true, ...data };
        }
        case 'DELETE': {
          if (!args?.email_id) return { success: false, error: 'email_id is required for EMAIL DELETE.' };
          await svc.deleteEmail(args.email_id);
          return { success: true, deleted: args.email_id };
        }
        default:
          return { success: false, error: `Unknown action "${action}" for EMAIL. Valid: LIST, GET, GET_STATS, CREATE, UPDATE, PUBLISH, UNPUBLISH, LIST_SUBSCRIPTION_TYPES, CLONE, DELETE.` };
      }
    }

    // ─── FORM ──────────────────────────────────────────────────────────────
    if (entityType === 'FORM') {
      switch (action) {
        case 'LIST': {
          const data = await svc.listForms(args?.cursor);
          return { success: true, ...data };
        }
        case 'GET': {
          if (!args?.form_id) return { success: false, error: 'form_id is required for FORM GET.' };
          const data = await svc.getForm(args.form_id);
          return { success: true, ...data };
        }
        case 'GET_SUBMISSIONS': {
          if (!args?.form_id) return { success: false, error: 'form_id is required for FORM GET_SUBMISSIONS.' };
          const data = await svc.getFormSubmissions(args.form_id, args?.cursor);
          return { success: true, ...data };
        }
        case 'CREATE': {
          if (!args?.name?.trim()) return { success: false, error: 'name is required for FORM CREATE.' };
          const formCreateProps: Record<string, any> = {};
          for (const f of ['name', 'formType', 'fieldGroups', 'configuration', 'displayOptions', 'legalConsentOptions'] as const) {
            if (args[f] !== undefined) formCreateProps[f] = args[f];
          }
          const data = await svc.createForm(formCreateProps);
          return { success: true, ...data };
        }
        case 'UPDATE': {
          if (!args?.form_id) return { success: false, error: 'form_id is required for FORM UPDATE.' };
          const formUpdateProps: Record<string, any> = {};
          for (const f of ['name', 'fieldGroups', 'configuration', 'displayOptions', 'legalConsentOptions'] as const) {
            if (args[f] !== undefined) formUpdateProps[f] = args[f];
          }
          const data = await svc.updateForm(args.form_id, formUpdateProps);
          return { success: true, ...data };
        }
        case 'DELETE': {
          if (!args?.form_id) return { success: false, error: 'form_id is required for FORM DELETE.' };
          await svc.deleteForm(args.form_id);
          return { success: true, deleted: args.form_id };
        }
        case 'GET_FORM_FIELDS': {
          if (!args?.form_id) return { success: false, error: 'form_id is required for FORM GET_FORM_FIELDS.' };
          const data = await svc.getFormFields(args.form_id);
          return { success: true, ...data };
        }
        case 'SUBMIT': {
          if (!args?.form_id) return { success: false, error: 'form_id is required for FORM SUBMIT (the form GUID).' };
          const fields = args?.fields;
          if (!Array.isArray(fields) || fields.length === 0) {
            return { success: false, error: 'fields (array of { name, value }) is required for FORM SUBMIT.' };
          }
          const portalId = svc.portalId;
          if (!portalId) return { success: false, error: 'Cannot submit form: HubSpot portal ID unavailable for this connection. Reconnect the account via OAuth.' };
          const data = await svc.submitForm(portalId, args.form_id, fields, {
            context: args?.submission_context,
            legalConsentOptions: args?.legal_consent_options,
          });
          return { success: true, ...data };
        }
        default:
          return { success: false, error: `Unknown action "${action}" for FORM. Valid: LIST, GET, GET_SUBMISSIONS, GET_FORM_FIELDS, CREATE, UPDATE, DELETE, SUBMIT.` };
      }
    }

    // ─── LANDING_PAGE ──────────────────────────────────────────────────────
    if (entityType === 'LANDING_PAGE') {
      switch (action) {
        case 'LIST': {
          const data = await svc.listLandingPages(args?.cursor);
          return { success: true, ...data };
        }
        case 'GET': {
          if (!args?.page_id) return { success: false, error: 'page_id is required for LANDING_PAGE GET.' };
          const data = await svc.getLandingPage(args.page_id);
          return { success: true, ...data };
        }
        case 'CREATE': {
          const name: string = args?.name ?? '';
          if (!name.trim()) return { success: false, error: 'name is required for LANDING_PAGE CREATE.' };
          const data = await svc.createLandingPage(name, { templatePath: args?.template_path, slug: args?.slug, metaDescription: args?.meta_description });
          return { success: true, ...data };
        }
        case 'PUBLISH': {
          if (!args?.page_id) return { success: false, error: 'page_id is required for LANDING_PAGE PUBLISH.' };
          const data = await svc.publishLandingPage(args.page_id);
          return { success: true, ...data };
        }
        case 'UPDATE': {
          if (!args?.page_id) return { success: false, error: 'page_id is required for LANDING_PAGE UPDATE.' };
          const { page_id, entity_type: _et1, action: _a1, ...rawProps } = args;
          const FRAMEWORK_FIELDS = new Set(['form_id', 'email_id', 'guid', 'cursor', 'asset_type', 'start_date', 'end_date', 'count', 'query', 'broadcast_id', 'list_id', 'record_ids', 'content_group_id', 'template_path', 'post_id']);
          const props: Record<string, any> = {};
          for (const [k, v] of Object.entries(rawProps)) {
            if (!FRAMEWORK_FIELDS.has(k)) props[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
          }
          const data = await svc.updateLandingPage(page_id, props);
          return { success: true, ...data };
        }
        case 'DELETE': {
          if (!args?.page_id) return { success: false, error: 'page_id is required for LANDING_PAGE DELETE.' };
          await svc.deleteLandingPage(args.page_id);
          return { success: true, deleted: args.page_id };
        }
        default:
          return { success: false, error: `Unknown action "${action}" for LANDING_PAGE. Valid: LIST, GET, CREATE, PUBLISH, UPDATE, DELETE.` };
      }
    }

    // ─── BLOG_POST ─────────────────────────────────────────────────────────
    if (entityType === 'BLOG_POST') {
      switch (action) {
        case 'LIST': {
          const data = await svc.listBlogPosts(args?.cursor);
          return { success: true, ...data };
        }
        case 'GET': {
          if (!args?.post_id) return { success: false, error: 'post_id is required for BLOG_POST GET.' };
          const data = await svc.getBlogPost(args.post_id);
          return { success: true, ...data };
        }
        case 'CREATE': {
          const name: string = args?.name ?? '';
          if (!name.trim()) return { success: false, error: 'name is required for BLOG_POST CREATE.' };
          const contentGroupId: string = args?.content_group_id ?? '';
          if (!contentGroupId.trim()) return { success: false, error: 'content_group_id (blog ID) is required for BLOG_POST CREATE.' };
          const data = await svc.createBlogPost(name, contentGroupId, { slug: args?.slug, metaDescription: args?.meta_description, postBody: args?.post_body });
          return { success: true, ...data };
        }
        case 'PUBLISH': {
          if (!args?.post_id) return { success: false, error: 'post_id is required for BLOG_POST PUBLISH.' };
          await svc.publishBlogPost(args.post_id);
          return { success: true, published: args.post_id };
        }
        case 'UPDATE': {
          if (!args?.post_id) return { success: false, error: 'post_id is required for BLOG_POST UPDATE.' };
          const { post_id, entity_type: _et2, action: _a2, ...rawProps } = args;
          const FRAMEWORK_FIELDS = new Set(['form_id', 'email_id', 'guid', 'cursor', 'asset_type', 'start_date', 'end_date', 'count', 'query', 'broadcast_id', 'list_id', 'record_ids', 'content_group_id', 'template_path', 'page_id']);
          const props: Record<string, any> = {};
          for (const [k, v] of Object.entries(rawProps)) {
            if (!FRAMEWORK_FIELDS.has(k)) props[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
          }
          const data = await svc.updateBlogPost(post_id, props);
          return { success: true, ...data };
        }
        case 'DELETE': {
          if (!args?.post_id) return { success: false, error: 'post_id is required for BLOG_POST DELETE.' };
          await svc.deleteBlogPost(args.post_id);
          return { success: true, deleted: args.post_id };
        }
        default:
          return { success: false, error: `Unknown action "${action}" for BLOG_POST. Valid: LIST, GET, CREATE, PUBLISH, UPDATE, DELETE.` };
      }
    }

    // ─── WORKFLOW ──────────────────────────────────────────────────────────
    if (entityType === 'WORKFLOW') {
      switch (action) {
        case 'LIST': {
          const data = await svc.listWorkflows();
          return { success: true, ...data };
        }
        case 'GET': {
          if (!args?.workflow_id) return { success: false, error: 'workflow_id is required for WORKFLOW GET.' };
          const data = await svc.getWorkflow(args.workflow_id);
          return { success: true, ...data };
        }
        case 'DELETE': {
          if (!args?.workflow_id) return { success: false, error: 'workflow_id is required for WORKFLOW DELETE.' };
          await svc.deleteWorkflow(args.workflow_id);
          return { success: true, deleted: args.workflow_id };
        }
        case 'GET_PERFORMANCE': {
          if (!args?.workflow_id) return { success: false, error: 'workflow_id is required for WORKFLOW GET_PERFORMANCE.' };
          if (!args?.start) return { success: false, error: 'start (epoch ms) is required for WORKFLOW GET_PERFORMANCE.' };
          if (!args?.end) return { success: false, error: 'end (epoch ms) is required for WORKFLOW GET_PERFORMANCE.' };
          if (!args?.bucket) return { success: false, error: 'bucket (DAY|WEEK|MONTH) is required for WORKFLOW GET_PERFORMANCE.' };
          const data = await svc.getWorkflowPerformance(args.workflow_id, args.start, args.end, args.bucket);
          return { success: true, performance: data };
        }
        case 'ENABLE': {
          if (!args?.workflow_id) return { success: false, error: 'workflow_id is required for WORKFLOW ENABLE.' };
          const data = await svc.setWorkflowEnabled(args.workflow_id, true);
          return { success: true, ...data };
        }
        case 'DISABLE': {
          if (!args?.workflow_id) return { success: false, error: 'workflow_id is required for WORKFLOW DISABLE.' };
          const data = await svc.setWorkflowEnabled(args.workflow_id, false);
          return { success: true, ...data };
        }
        default:
          return { success: false, error: `Unknown action "${action}" for WORKFLOW. Valid: LIST, GET, DELETE, GET_PERFORMANCE, ENABLE, DISABLE.` };
      }
    }

    // ─── SOCIAL ────────────────────────────────────────────────────────────
    if (entityType === 'SOCIAL') {
      switch (action) {
        case 'LIST_CHANNELS': {
          const data = await svc.listSocialChannels();
          return { success: true, ...data };
        }
        case 'LIST_BROADCASTS': {
          const data = await svc.listSocialBroadcasts();
          return { success: true, ...data };
        }
        case 'CREATE_BROADCAST': {
          const channelKey: string = args?.channel_key ?? '';
          if (!channelKey.trim()) return { success: false, error: 'channel_key is required for SOCIAL CREATE_BROADCAST.' };
          const body: string = args?.body ?? '';
          if (!body.trim()) return { success: false, error: 'body is required for SOCIAL CREATE_BROADCAST.' };
          const data = await svc.createSocialBroadcast(channelKey, body, { triggerAt: args?.trigger_at });
          return { success: true, ...data };
        }
        case 'DELETE_BROADCAST': {
          if (!args?.broadcast_guid) return { success: false, error: 'broadcast_guid is required for SOCIAL DELETE_BROADCAST.' };
          await svc.deleteSocialBroadcast(args.broadcast_guid);
          return { success: true, deleted: args.broadcast_guid };
        }
        default:
          return { success: false, error: `Unknown action "${action}" for SOCIAL. Valid: LIST_CHANNELS, LIST_BROADCASTS, CREATE_BROADCAST, DELETE_BROADCAST.` };
      }
    }

    return { success: false, error: `Unknown entity_type "${entityType}". Valid: CONTACTS, DEALS, CONTACT_LIST, CAMPAIGN, EMAIL, FORM, LANDING_PAGE, BLOG_POST, WORKFLOW, SOCIAL.` };
  } catch (err: any) {
    if (err?.response?.status === 403) {
      // HubSpot returns 403 both for tier/scope limits and for tokens granted
      // before newer scopes were added to the app — distinguish them.
      const missingScopes = err?.response?.data?.category === 'MISSING_SCOPES';

      // Log what HubSpot actually said. We hold the payload here and, until now, threw
      // it away: `hubspotError` goes back to the model but the only thing written to
      // the log is our own paraphrase, so a recurring production 403 (seen 09-23 and
      // 09-26, same scheduled slot) could not be diagnosed at all.
      //
      // The distinction matters because the two causes have OPPOSITE remedies. A
      // missing scope is fixed by reconnecting. A subscription-tier limit is not —
      // telling that customer to reconnect sends them through an OAuth round trip that
      // changes nothing. Right now we cannot tell them apart from the outside.
      //
      // `response.data` is HubSpot's error body: category, message, correlationId. It
      // carries no credentials — unlike the axios error object, whose `config.data`
      // holds client_secret (see redactAxiosCredentials in hubspotService).
      const hsBody = err?.response?.data;
      console.error(
        `[AgentMode] call_hubspot_api 403 entity=${entityType} action=${action} `
        + `category=${hsBody?.category ?? 'none'} missingScopes=${missingScopes} `
        + `message=${JSON.stringify(redactHubSpotMessage(hsBody?.message))} `
        + `correlationId=${hsBody?.correlationId ?? 'none'}`
      );
      return {
        success: false,
        error: missingScopes
          ? 'Your HubSpot connection is missing the required permissions. Please reconnect your HubSpot account in Settings → Connected Accounts to grant them.'
          : 'HubSpot API access denied. Check your HubSpot subscription tier and OAuth scopes (content, automation required for some entity types).',
        // Redacted on the way OUT as well as into the log: this body reaches the LLM
        // context and anything that persists or shares tool results, which is a wider
        // surface than our own logs, not a narrower one.
        hubspotError: redactHubSpotBody(err?.response?.data),
        status: 403,
      };
    }
    return { success: false, error: err?.message ?? 'HubSpot API call failed.', hubspotError: redactHubSpotBody(err?.response?.data), status: err?.response?.status ?? null };
  }
}
