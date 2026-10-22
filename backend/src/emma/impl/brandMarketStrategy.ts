/**
 * ENG-2103 (F2) — brand guidelines / market strategy tool cluster, extracted
 * from `AgentModeService`. The seventh domain cluster in this series.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 * readBrandGuidelines, readMarketStrategy, updateMarketStrategy,
 * updateBrandGuidelines, regenerateMarketStrategy — plus the private helper
 * `getExistingMarketStrategy` (shared internally by updateBrandGuidelines's
 * refreshMarketStrategy branch and regenerateMarketStrategy) and 10 pure
 * formatting helpers (formatBrandGuidelines, formatBrandGuidelinesUpdate,
 * formatIcpSection, competitorCharBudgets, truncateWithNotice,
 * lookupCompetitors, formatCompetitorDetailLine, resolveCompetitorDetailWindow,
 * formatMarketStrategy, formatMarketStrategyUpdate) plus the 14
 * `private static readonly` numeric budget constants those helpers use
 * (COMPETITOR_DETAIL_CHAR_BUDGET, RESPONSE_HARD_CAP, etc.) — all 10 helpers
 * and all 14 constants are used ONLY within this cluster (verified by a
 * whole-file grep: zero references anywhere else in agentModeService.ts, zero
 * test spies), so they are moved as plain module-scope functions/consts
 * rather than promoted to a shared module.
 *
 * `getExistingMarketStrategy`'s own doc comment says it is "shared by the
 * brand re-setup offer and the regenerate flow", but a whole-backend grep
 * found only the one caller (regenerateMarketStrategy) — the "re-setup offer"
 * reference is stale/aspirational, not a real second caller.
 *
 * `AgentModeService.prototype.<name>` now delegates to these functions rather
 * than duplicating them, for the 5 public methods only, because real callers
 * beyond emma/tools.ts call them directly on the class singleton (confirmed
 * by a whole-backend grep, not just tools.ts):
 *   - readBrandGuidelines: cron/linkedInConnectionSyncCron.ts, routes/crm.ts
 *   - readMarketStrategy: cron/linkedInConnectionSyncCron.ts
 *   - updateBrandGuidelines: services/agentMode/brandLogo.ts's
 *     defaultPersistBrandLogo (itself reached via a lazy `await import`,
 *     specifically BECAUSE agentModeService.ts imports brandLogo.ts at the
 *     top level — an existing, already-documented circular-import guard in
 *     that file, unrelated to and unaffected by this extraction)
 *   - updateMarketStrategy / regenerateMarketStrategy: emma/tools.ts only,
 *     but kept delegating anyway (not deleted) because
 *     __tests__/agentModeService.readMarketStrategy.test.ts,
 *     __tests__/agentModeService.regenerateMarketStrategy.test.ts, and
 *     __tests__/agentModeService.brandGuidelinesUpdate.test.ts all call these
 *     class methods directly on a real AgentModeService instance.
 * The 10 formatting helpers, getExistingMarketStrategy, and the 14 constants
 * have zero other callers/spies and are deleted from the class outright.
 *
 * Transitive-import notes (no AWS-SDK-construction risk found, but one real
 * dead-end avoided):
 *   - `resolveOrgProfileField` was a TOP-LEVEL import in agentModeService.ts
 *     (`./orgProfileResolver`), but orgProfileResolver.ts itself top-level
 *     imports `services/db.ts` (the module that constructs a real DynamoDB
 *     client at module scope — the transitive-import trap this whole series
 *     watches for). A top-level import here would have silently reintroduced
 *     exactly the coupling this extraction exists to remove, so it is lazily
 *     `await import()`'d inside each of the 5 functions that use it instead.
 *   - `downloadBrandLogoToS3` / `getPersistedBrandLogoAssetUrl` come from
 *     services/agentMode/brandLogo.ts, which — per its OWN doc comment —
 *     lazy-loads every external boundary (axios, S3, Dynamo, cssExtractor,
 *     the brand-guidelines write path) by design, and only reaches back to
 *     agentModeService.ts via one specific lazily-`await import()`'d internal
 *     function (`defaultPersistBrandLogo`, not exported, not used by this
 *     cluster). Safe to import at the top level here.
 *   - `buildReadyPatch` / `logCompletionMetric` come from
 *     services/brandBuildStatusService.ts, which has zero imports of its own.
 *     Safe to import at the top level here.
 *   - `canEditItem` (services/orgShareService.ts), `isS3Url`
 *     (utils/s3Utils.ts), `userDb`/`orgDb` (services/db.ts), and the
 *     onboarding ICP/competitor generators were already lazily
 *     `await import()`'d inline in the original source — kept exactly as-is.
 *
 * Metering/RunFunding audit (F1's `currentRunFunding()`/billingUserId-
 * forwarding bug class): zero matches for llmService, generateJSONContent,
 * callLLM, meterUserUsage, currentRunFunding, or any LLM-provider name across
 * the whole cluster. regenerateMarketStrategy forwards `{ userId, feature:
 * 'onboarding_competitors' }` to generateCompetitorStrategyForUser — `userId`
 * only, no `billingUserId` key — so there is nothing here for that bug class
 * to reach; this call site is unmodified from its original AgentModeService
 * source, not something this extraction introduces or changes.
 */

import {
  downloadBrandLogoToS3,
  getPersistedBrandLogoAssetUrl,
} from '../../services/agentMode/brandLogo';
import { buildReadyPatch, logCompletionMetric } from '../../services/brandBuildStatusService';
import {
  brandBuildOwnershipCondition,
  countHumanMessages,
  isClaimSuperseded,
  parseBrandBuildSessionClaim,
  shouldRefuseBrandBuildSessionWrite,
} from '../../services/brandBuildSessionMarker';

  // Read current user's brand guidelines
export async function readBrandGuidelines(userId: string): Promise<any> {
    try {
      const { userDb, orgDb } = await import('../../services/db');
      // ENG-2103 (F2): lazily required — orgProfileResolver.ts top-level
      // imports services/db.ts (the transitive-import-trap module), so this
      // cannot be a top-level import here even though it was one in
      // agentModeService.ts (which already constructs everything eagerly).
      const { resolveOrgProfileField } = await import('../../services/orgProfileResolver');
      const user = await userDb.getUserById(userId);
      if (!user) {
        return {
          success: false,
          message: 'User not found',
          exists: false,
          error: 'User not found'
        };
      }

      // If user belongs to an org, read from org data instead — falling back to
      // the org owner's record when the org was created without copying the
      // profile over, so Emma sees the same brand the settings page shows a
      // member of an un-copied org (ENG-927).
      let brand = user.brandGuidelines;
      if (user.orgId) {
        const org = await orgDb.getOrgById(user.orgId);
        if (org) {
          brand = await resolveOrgProfileField(user, org, 'brandGuidelines');
        }
      }
      if (!brand) {
        return {
          success: true,
          exists: false,
          message: 'No brand guidelines found',
          brandData: {},
          attachments: []
        };
      }

      // Format the brand guidelines for LLM consumption
      const formattedContent = formatBrandGuidelines({
        exists: true,
        brandData: brand.brandData || {},
        attachments: brand.attachments || []
      });

      // Return structured response similar to web_search
      return {
        success: true,
        message: `Brand guidelines retrieved successfully`,
        exists: true,
        brandData: brand.brandData || {},
        attachments: brand.attachments || [],
        createdAt: brand.createdAt,
        updatedAt: brand.updatedAt,
        formattedContent
      };
    } catch (error) {
      console.error('AgentMode: Error reading brand guidelines:', error);
      return {
        success: false,
        message: 'Failed to read brand guidelines',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Read current user's market strategy
export async function readMarketStrategy(
    userId: string,
    options: {
      competitorOffset?: number;
      minCompetitorsInFull?: number;
      pagingHints?: boolean;
      competitorNames?: string[];
    } = {}
  ): Promise<any> {
    try {
      const { userDb, orgDb } = await import('../../services/db');
      const { resolveOrgProfileField } = await import('../../services/orgProfileResolver');
      const user = await userDb.getUserById(userId);
      if (!user) {
        return {
          success: false,
          message: 'User not found',
          exists: false,
          error: 'User not found'
        };
      }

      // Same owner-record fallback as the brand read: an un-copied org must not
      // hide the owner's strategy from a member (ENG-927).
      let marketStrategy = user.marketStrategy;
      if (user.orgId) {
        const org = await orgDb.getOrgById(user.orgId);
        if (org) {
          marketStrategy = await resolveOrgProfileField(user, org, 'marketStrategy');
        }
      }
      if (!marketStrategy) {
        return {
          success: true,
          exists: false,
          message: 'No market strategy found',
          formattedContent: 'No market strategy found'
        };
      }

      // Bound the size of the tool result WITHOUT hiding entries (ENG-945).
      // This used to slice the competitor list down to 40 and drop the rest
      // silently, so a caller that wrote 49 competitors read back 40 and
      // concluded the write had discarded records. Now the first
      // COMPETITOR_DETAIL_LIMIT competitors are rendered in full and the
      // remainder are listed by name only — every stored competitor is still
      // visible, and the true count is reported alongside.
      const competitors: any[] = Array.isArray(marketStrategy.competitors) ? marketStrategy.competitors : [];
      const competitorCount = competitors.length;

      // `competitorOffset` slides the detail window over the stored list, so a
      // caller that needs the description of a name-only entry can fetch it
      // instead of being stuck with a partial record. Clamped into range: an
      // out-of-range offset lands on the last entry rather than rendering an
      // empty window, because a silently empty result is the failure mode this
      // whole ticket was about.
      const requestedOffset = Number(options?.competitorOffset);
      const competitorDetailOffset = Number.isFinite(requestedOffset)
        ? Math.min(Math.max(Math.floor(requestedOffset), 0), Math.max(0, competitorCount - 1))
        : 0;
      // The character budget protects the TOOL result's context window. Callers
      // that embed formattedContent in their own prompt instead (the CRM email
      // drafter) pass minCompetitorsInFull to keep the coverage they had before
      // ENG-945, so paging can't silently shrink an unrelated prompt.
      const requestedMin = Number(options?.minCompetitorsInFull);
      const minInFull = Number.isFinite(requestedMin) && requestedMin > 0 ? Math.floor(requestedMin) : 1;
      // Competitor sections get the room the overview and ICP leave, not a fixed
      // slice on top of them (ENG-945 / Greptile: per-section budgets do not
      // compose into a bound on the whole response).
      // Membership check (ENG-945): the name index is bounded, so on a large
      // roster it cannot show every name. A caller deciding whether to ADD a
      // competitor must still be able to find out if it already exists — that
      // is the contract this whole ticket is about. Answer it directly instead
      // of making them page the list.
      const competitorLookup = lookupCompetitors(competitors, options?.competitorNames);
      // Dropping part of the REQUEST silently is the same failure as dropping
      // part of the data: unanswered names would read as "not stored" and get
      // re-added. Report the shortfall instead (ENG-945).
      const competitorNamesNotChecked = Array.isArray(options?.competitorNames)
        ? Math.max(0, options!.competitorNames!.length - COMPETITOR_LOOKUP_MAX)
        : 0;
      const budgets = competitorCharBudgets(marketStrategy);
      const window = resolveCompetitorDetailWindow(competitors, competitorDetailOffset, minInFull, budgets.detail);

      // Format the market strategy for LLM consumption
      const formattedContent = formatMarketStrategy({
        exists: true,
        marketData: marketStrategy,
        competitorDetailStart: window.start,
        competitorDetailEnd: window.end,
        nameIndexCharBudget: budgets.nameIndex,
        competitorLookup,
        competitorNamesNotChecked,
        // Paging instructions only make sense in a tool result. A caller that
        // embeds this in its own prompt has no read_market_strategy to call, so
        // the offsets are noise there — and noise that can leak into generated
        // customer copy.
        pagingHints: options?.pagingHints !== false
      });

      // Return structured response — no raw marketData to keep tool result size manageable
      return {
        success: true,
        message: `Market strategy retrieved successfully`,
        exists: true,
        totalCompetitors: competitorCount,
        ...(competitorLookup ? { competitorLookup, competitorNamesNotChecked } : {}),
        competitorDetailOffset: window.start,
        competitorsWithFullDetail: window.end - window.start,
        // Explicit next page, so paging never depends on the model doing arithmetic.
        nextCompetitorOffset: window.end < competitorCount ? window.end : null,
        createdAt: marketStrategy.createdAt,
        updatedAt: marketStrategy.updatedAt,
        formattedContent
      };
    } catch (error) {
      console.error('AgentMode: Error reading market strategy:', error);
      return {
        success: false,
        message: 'Failed to read market strategy',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Update user's market strategy
export async function updateMarketStrategy(updateData: any, userId: string, opts: { replace?: boolean; sessionId?: string } = {}): Promise<any> {
    try {
      const { userDb, orgDb } = await import('../../services/db');
      const { canEditItem } = await import('../../services/orgShareService');
      const { resolveOrgProfileField } = await import('../../services/orgProfileResolver');
      const user = await userDb.getUserById(userId);
      if (!user) {
        return {
          success: false,
          message: 'User not found',
          error: 'User not found'
        };
      }

      // ENG-2308: refuse / condition writes from a superseded brand-build session.
      const guard = await guardBrandBuildSession(user, userDb, userId, opts.sessionId);
      if (guard.refuse) return supersededResult();

      // Org members: only the org owner or a listed marketingStrategy editor
      // may update. Solo users are unaffected.
      let existingMarketStrategy: any;
      if (user.orgId) {
        const org = await orgDb.getOrgById(user.orgId);
        const allowed = canEditItem(
          { userId: org?.ownerUserId } as any,
          { userId, orgId: user.orgId, orgRole: user.orgRole as 'owner' | 'member' | undefined },
          org ?? null,
          user.orgId,
          'marketingStrategy',
        );
        if (!allowed) {
          return {
            success: false,
            message: 'Market strategy is managed by your org admin',
            error: 'Permission denied'
          };
        }
        // Same owner-record fallback as the brand path — merging onto an
        // unpopulated org record would drop the owner's competitors/ICPs.
        existingMarketStrategy = await resolveOrgProfileField(user, org, 'marketStrategy', { forWrite: true });
      } else {
        existingMarketStrategy = user.marketStrategy;
      }

      // Extract market strategy fields from updateData
      const { businessOverview, competitors, icp, ...otherFields } = updateData;

      // Merge competitors by name - preserve existing entries, update or add new ones.
      // When opts.replace is set and a competitors array is provided, the provided
      // list REPLACES the existing one wholesale (used by regenerate_market_strategy
      // after the user has explicitly confirmed the regeneration). ENG-44.
      const replaceCompetitors = opts.replace === true && competitors !== undefined && Array.isArray(competitors);
      let mergedCompetitors = replaceCompetitors ? [] : [...(existingMarketStrategy?.competitors || [])];
      if (competitors !== undefined && Array.isArray(competitors)) {
        competitors.forEach(newCompetitor => {
          const existingIndex = mergedCompetitors.findIndex(existing =>
            existing.name === newCompetitor.name
          );
          if (existingIndex >= 0) {
            // Update existing competitor
            mergedCompetitors[existingIndex] = {
              ...mergedCompetitors[existingIndex],
              ...newCompetitor
            };
          } else {
            // Add new competitor
            mergedCompetitors.push(newCompetitor);
          }
        });
      }

      // Merge ICPs by title - preserve existing entries, update or add new ones.
      // When opts.replace is set and an icp array is provided, REPLACE wholesale. ENG-44.
      const replaceIcp = opts.replace === true && icp !== undefined && Array.isArray(icp);
      let mergedICP = replaceIcp ? [] : [...(existingMarketStrategy?.icp || [])];
      if (icp !== undefined && Array.isArray(icp)) {
        icp.forEach(newICP => {
          const existingIndex = mergedICP.findIndex(existing =>
            existing.title === newICP.title
          );
          if (existingIndex >= 0) {
            // Update existing ICP
            mergedICP[existingIndex] = {
              ...mergedICP[existingIndex],
              ...newICP
            };
          } else {
            // Add new ICP
            mergedICP.push(newICP);
          }
        });
      }

      // Prepare market strategy data - merge with existing if available
      const updateTimestamp = new Date().toISOString();
      const marketStrategyData = {
        ...existingMarketStrategy,
        ...otherFields,
        businessOverview: businessOverview !== undefined ? businessOverview : (existingMarketStrategy?.businessOverview || ''),
        competitors: mergedCompetitors,
        icp: mergedICP,
        createdAt: existingMarketStrategy?.createdAt || updateTimestamp,
        updatedAt: updateTimestamp,
        // Tracked separately from updatedAt (ENG-1955 follow-up): Emma is
        // explicitly told to send only the fields that changed, so a
        // competitors-only tool call must not look like an ICP correction to
        // routes/crm.ts's staleness check.
        icpUpdatedAt: icp !== undefined ? updateTimestamp : existingMarketStrategy?.icpUpdatedAt,
      };

      // Update org-level or personal market strategy
      if (user.orgId) {
        await guard.assertStillCurrent();
        await orgDb.updateOrg(user.orgId, { marketStrategy: marketStrategyData });
      } else {
        await guard.userWrite({ marketStrategy: marketStrategyData });
      }

      // ENG-2103 (F2): lazily required — brandGuidelinesPopulation.ts
      // top-level imports services/db.ts (the transitive-import-trap module),
      // so this cannot be a top-level import here even though it was one in
      // agentModeService.ts.
      const { populateEmptyBrandGuidelines } = await import('../../services/brandGuidelinesPopulation');
      await populateEmptyBrandGuidelines(userId);

      // Track what was updated vs added
      const updatedEntries: string[] = [];
      const addedEntries: string[] = [];

      if (competitors !== undefined && Array.isArray(competitors)) {
        competitors.forEach(competitor => {
          const wasExisting = existingMarketStrategy?.competitors?.some((existing: any) =>
            existing.name === competitor.name
          );
          if (wasExisting) {
            updatedEntries.push(`Competitor: ${competitor.name}`);
          } else {
            addedEntries.push(`Competitor: ${competitor.name}`);
          }
        });
      }

      if (icp !== undefined && Array.isArray(icp)) {
        icp.forEach(profile => {
          const wasExisting = existingMarketStrategy?.icp?.some((existing: any) =>
            existing.title === profile.title
          );
          if (wasExisting) {
            updatedEntries.push(`ICP: ${profile.title}`);
          } else {
            addedEntries.push(`ICP: ${profile.title}`);
          }
        });
      }

      // Format the update result for LLM consumption
      const formattedContent = formatMarketStrategyUpdate({
        success: true,
        message: 'Market strategy updated successfully',
        marketData: marketStrategyData,
        updatedFields: Object.keys(updateData).filter(key => updateData[key] !== undefined),
        updatedEntries,
        addedEntries,
        totalCompetitors: mergedCompetitors.length,
        totalICPs: mergedICP.length
      });

      return {
        success: true,
        message: 'Market strategy updated successfully',
        marketData: marketStrategyData,
        updatedFields: Object.keys(updateData).filter(key => updateData[key] !== undefined),
        updatedEntries,
        addedEntries,
        totalCompetitors: mergedCompetitors.length,
        totalICPs: mergedICP.length,
        formattedContent
      };
    } catch (error) {
      if (error instanceof SupersededBrandBuildWrite) {
        console.warn('[brandBuild] dropping market-strategy update from a superseded brand-build session: a newer claim took over mid-call');
        return supersededResult();
      }
      console.error('AgentMode: Error updating market strategy:', error);
      return {
        success: false,
        message: 'Failed to update market strategy',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Update user's brand guidelines (supports both brandData and attachments)
/** A write made for a brand-build session lost the race to a reclaim (ENG-2308). */
class SupersededBrandBuildWrite extends Error {
  constructor() {
    super('brand build superseded');
    this.name = 'SupersededBrandBuildWrite';
  }
}

const SUPERSEDED_MESSAGE =
  'This brand build was superseded by a newer run, so this update was not applied. Stop now: do not retry, do not change the arguments, and end your turn.';

/**
 * Result for a refused write. Shaped as a deliberate policy refusal
 * (`blocked` + `reason`, ENG-1636) so the dispatcher does not count it as a tool
 * malfunction. The stop instruction is in `error`, not only `message`, because
 * extractToolResultMessage prefers `error` and that is all the model is shown.
 */
function supersededResult() {
  return {
    success: false,
    blocked: true,
    reason: 'superseded_brand_build',
    superseded: true,
    error: SUPERSEDED_MESSAGE,
    message: SUPERSEDED_MESSAGE,
  };
}

interface BrandBuildSessionGuard {
  /** The session's writes must be refused outright. */
  refuse: boolean;
  /** Set when the session belongs to the CURRENT build: its writes carry this claim as a condition. */
  claim?: string;
  /** Writes made for the guarded session; throws SupersededBrandBuildWrite if a reclaim lands first. */
  userWrite: (patch: Record<string, unknown>) => Promise<any>;
  /** Org-level writes cannot be conditioned on the user's claim, so re-check it consistently just before. */
  assertStillCurrent: () => Promise<void>;
}

/**
 * ENG-2308: decide how a brand-guidelines / market-strategy write from `sessionId`
 * must behave, BEFORE anything is written. A brand build's Emma session is not
 * aborted when the build times out, so a superseded ("zombie") session can still
 * call these tools after a retry reclaimed the build; it must not overwrite the
 * newer run's data. Only sessions marked as brand-build sessions are affected
 * (see brandBuildSessionMarker); ordinary chat, REST saves, no session id, and
 * old brand-build sessions reopened long after keep the original behavior.
 */
async function guardBrandBuildSession(
  user: any,
  userDb: any,
  userId: string,
  sessionId: string | undefined,
): Promise<BrandBuildSessionGuard> {
  const currentStartedAt: string | undefined = user?.brandBuildStartedAt;
  let sessionClaim: string | undefined;
  if (sessionId && currentStartedAt) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { chatbotDb } = require('../../services/chatbotService');
      const session = await chatbotDb.getChatSessionRecord(sessionId, true);
      sessionClaim = parseBrandBuildSessionClaim(session?.pageIdentifier);
    } catch (lookupErr: any) {
      // Cannot tell: treat as an ordinary session (original behavior).
      console.warn('[brandBuild] session lookup failed; treating as a non-brand-build session', {
        userId,
        error: lookupErr?.message ?? String(lookupErr),
      });
    }
  }

  // Whether a human has written in this session is only needed to tell a
  // zombie from a reopened chat, i.e. when its claim is superseded and no newer
  // build is in flight. Rare, so reading the history here costs nothing in the
  // normal case.
  let humanMessages: number | undefined;
  if (
    sessionId &&
    isClaimSuperseded(sessionClaim, currentStartedAt) &&
    user?.brandBuildStatus !== 'building'
  ) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { chatbotDb } = require('../../services/chatbotService');
      humanMessages = countHumanMessages(await chatbotDb.getMessagesFromMessagesTable(sessionId, true));
    } catch (historyErr: any) {
      console.warn('[brandBuild] session history read failed; cannot tell a zombie from a reopened chat', {
        userId,
        error: historyErr?.message ?? String(historyErr),
      });
    }
  }

  const refuse = shouldRefuseBrandBuildSessionWrite(
    sessionClaim,
    { startedAt: currentStartedAt, status: user?.brandBuildStatus },
    humanMessages,
  );
  if (refuse) {
    console.warn('[brandBuild] dropping update from a superseded brand-build session', {
      userId,
      sessionId,
      sessionClaim,
      currentStartedAt,
    });
  }
  // A marked session whose claim is no longer current but is not refused is an
  // old session reopened later: ordinary chat, so no claim condition either.
  const claim = !refuse && sessionClaim && sessionClaim === currentStartedAt ? sessionClaim : undefined;

  return {
    refuse,
    claim,
    userWrite: async (patch) => {
      if (!claim) return userDb.updateUser(userId, patch as any);
      try {
        return await userDb.updateUser(userId, patch as any, {
          condition: brandBuildOwnershipCondition(claim),
        });
      } catch (condErr: any) {
        if (condErr?.code === 'ConditionalCheckFailedException') throw new SupersededBrandBuildWrite();
        throw condErr;
      }
    },
    assertStillCurrent: async () => {
      if (!claim) return;
      const fresh = user?.email ? await userDb.getUserByEmailConsistent(user.email) : null;
      if (fresh && fresh.brandBuildStartedAt !== claim) throw new SupersededBrandBuildWrite();
    },
  };
}

export async function updateBrandGuidelines(
  updateData: any,
  userId: string,
  opts: { sessionId?: string } = {},
): Promise<any> {
    try {
      const { userDb, orgDb } = await import('../../services/db');
      const { canEditItem } = await import('../../services/orgShareService');
      const { resolveOrgProfileField } = await import('../../services/orgProfileResolver');
      const user = await userDb.getUserById(userId);
      if (!user) {
        return {
          success: false,
          message: 'User not found',
          error: 'User not found'
        };
      }

      // ENG-2308: refuse / condition writes from a superseded brand-build session.
      const guard = await guardBrandBuildSession(user, userDb, userId, opts.sessionId);
      if (guard.refuse) return supersededResult();
      const userWrite = guard.userWrite;
      const sessionClaim = guard.claim;

      // Org members: only the org owner or a listed brandGuidelines editor
      // may update. Solo users are unaffected.
      let existingBrand: any;
      if (user.orgId) {
        const org = await orgDb.getOrgById(user.orgId);
        const allowed = canEditItem(
          { userId: org?.ownerUserId } as any,
          { userId, orgId: user.orgId, orgRole: user.orgRole as 'owner' | 'member' | undefined },
          org ?? null,
          user.orgId,
          'brandGuidelines',
        );
        if (!allowed) {
          return {
            success: false,
            message: 'Brand guidelines are managed by your org admin',
            error: 'Permission denied'
          };
        }
        // Fall back to the org owner's record when the org record was never
        // populated, so a tweak merges onto the existing brand instead of
        // building a fresh empty structure over it (ENG-927).
        existingBrand = await resolveOrgProfileField(user, org, 'brandGuidelines', { forWrite: true });
      } else {
        existingBrand = user.brandGuidelines;
      }

      // If no existing brand guidelines, create a new structure
      if (!existingBrand) {
        // Create initial brand guidelines structure
        const initialBrandGuidelines = {
          brandData: {
            brandName: "",
            tagline: "",
            primaryColor: "",
            primaryColorEnd: "",
            secondaryColor: "",
            fontFamily: "",
            toneOfVoice: "",
            keyMessages: [],
            brandValues: [],
            targetAudience: "",
            brandPersonality: "",
            isGradient: false,
            founders: [],
          },
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        // Update org or user with initial brand guidelines
        if (user.orgId) {
          await guard.assertStillCurrent();
          await orgDb.updateOrg(user.orgId, { brandGuidelines: initialBrandGuidelines });
        } else {
          await userWrite({ brandGuidelines: initialBrandGuidelines });
        }

        // Use the initial structure as the base for updates
        existingBrand = initialBrandGuidelines;
      }

      // Extract brandData, brandAssets, and optional market-strategy refresh from updateData
      const { brandData, brandAssets, refreshMarketStrategy, ...otherFields } = updateData;

      // Merge with existing brandData - only update provided fields
      const updatedBrandData = {
        ...existingBrand.brandData,
        ...brandData
      } as any;

      // Special merge logic for founder profiles (merge by normalized founder name)
      if (brandData && Array.isArray((brandData as any).founders)) {
        const normalize = (name: any) =>
          typeof name === 'string' ? name.trim().toLowerCase() : '';

        const existingFounders: any[] = Array.isArray((existingBrand.brandData as any)?.founders)
          ? (existingBrand.brandData as any).founders
          : [];
        const incomingFounders: any[] = (brandData as any).founders || [];

        const mergedFounders: any[] = [...existingFounders];
        for (const newFounder of incomingFounders) {
          if (!newFounder || !newFounder.name) continue;
          const key = normalize(newFounder.name);
          if (!key) continue;

          const idx = mergedFounders.findIndex(
            f => f && normalize(f.name) === key
          );
          if (idx >= 0) {
            // Merge fields so a partial update (e.g. only voiceExamples) preserves other fields
            mergedFounders[idx] = { ...mergedFounders[idx], ...newFounder };
          } else {
            // Append as new founder
            mergedFounders.push(newFounder);
          }
        }

        // Assign the merged array back
        updatedBrandData.founders = mergedFounders;
      }

      // Reject SVG files for logo/secondaryLogo assets
      if (brandAssets !== undefined) {
        const assetsToCheck = Array.isArray(brandAssets) ? brandAssets : [brandAssets];
        for (const asset of assetsToCheck) {
          if (asset && (asset.type === 'logo' || asset.type === 'secondaryLogo')) {
            const url = (asset.url || '').toLowerCase();
            const filename = (asset.filename || '').toLowerCase();
            if (url.endsWith('.svg') || filename.endsWith('.svg') || url.includes('.svg?')) {
              return {
                success: false,
                message: `SVG files are not supported for ${asset.type === 'logo' ? 'primary' : 'secondary'} logo. Please convert your SVG to PNG or another raster format before uploading.`,
                error: 'SVG format not allowed for logo uploads'
              };
            }
          }
        }
      }

      // Normalize a brand guide asset: if the URL is not an S3-hosted file,
      // mark it as a URL entry (filename: "url") so the frontend can display it correctly.
      const normalizeBrandGuideAsset = (asset: any): any => {
        if (asset?.type !== 'brandGuide') return asset;
        const isS3Url = typeof asset.url === 'string' && asset.url.includes('.s3.') && asset.url.includes('amazonaws.com');
        const isUrlEntry = !isS3Url;
        if (isUrlEntry) {
          return {
            ...asset,
            filename: 'url',
            key: asset.key || `url-brandguide-${Date.now()}`,
          };
        }
        return asset;
      };

      // ENG-933 follow-up: this method is the ONE place every brand write
      // funnels through — Emma's `update_brand_guidelines` chat tool included,
      // not just the onboarding backstop (ensureBrandLogoPersisted) that only
      // guards the one-time onboarding flow. Emma has a documented history
      // (ENG-792, ENG-933) of calling this tool with only brandData.logoUrl
      // and no brandAssets entry, which leaves `attachments` empty — the
      // Brand Guidelines "Logo & Assets" card renders `attachments`, so the
      // account shows "No logos uploaded" even though Emma "found" a logo.
      // Auto-pin it here so that gap can't reopen through this call
      // regardless of when or how it's invoked. Best-effort: any failure
      // here must never break the underlying write (matches the onboarding
      // backstop's own never-throws contract).
      let autoLogoAsset: { type: string; url: string; filename: string; key: string } | null = null;
      // Replaces the CALLER's own logo asset entry with a pinned/rasterised
      // one when its URL isn't safe to trust as-is (see the third branch
      // below). Distinct from autoLogoAsset, which is appended fresh when no
      // asset was supplied at all.
      let callerLogoAssetOverride: { type: string; url: string; filename: string; key: string } | null = null;
      // Surfaced (not swallowed) when the fetch/rasterise attempt didn't land
      // an asset — see the failure branch below for why this must not read
      // as silent success.
      let logoAutoPinIssue: string | null = null;
      const incomingLogoUrl =
        typeof (brandData as any)?.logoUrl === 'string' ? (brandData as any).logoUrl.trim() : '';
      const normalizedBrandAssets: any[] = Array.isArray(brandAssets)
        ? brandAssets
        : brandAssets !== undefined && typeof brandAssets === 'object' && brandAssets !== null
          ? [brandAssets]
          : [];
      const callerLogoAsset = normalizedBrandAssets.find((a: any) => a?.type === 'logo');
      const callerSuppliedLogoAsset = !!callerLogoAsset;
      const existingLogoAssetUrl = getPersistedBrandLogoAssetUrl({
        attachments: existingBrand.attachments,
      });
      const alreadyHasLogoAsset = !!existingLogoAssetUrl;
      if (incomingLogoUrl && !callerSuppliedLogoAsset && !alreadyHasLogoAsset) {
        try {
          const outcome = await downloadBrandLogoToS3(incomingLogoUrl, userId);
          if (outcome.status === 'svg') {
            // brandData.logoUrl keeps the raw incoming URL, exactly like this
            // call behaved before this change — never worse than today. But
            // the write must not silently report full success while no asset
            // actually landed; the caller (Emma) needs to know so she can
            // tell the user or retry, instead of believing the Logo & Assets
            // card is populated when it isn't.
            logoAutoPinIssue =
              'The logo URL is an SVG that could not be rasterised — it was not stored as a Logo & Assets attachment. Ask the user to upload a PNG/JPEG/GIF/WEBP version instead.';
          } else if (outcome.status !== 'uploaded') {
            const detailSuffix = outcome.detail ? `: ${outcome.detail}` : '';
            logoAutoPinIssue =
              `Could not fetch/store the logo from that URL (${outcome.status}${detailSuffix}) — brandData.logoUrl was saved, but no Logo & Assets attachment was created. Retrying later (or asking the user to upload the logo directly) may be needed.`;
          } else if (outcome.url) {
            const filename = outcome.url.split('/').filter(Boolean).pop() || 'logo.png';
            autoLogoAsset = {
              type: 'logo',
              url: outcome.url,
              filename,
              key: `auto-logo-${Date.now()}`,
            };
            // Point brandData.logoUrl at the pinned S3 copy too — never
            // something an external host can take down or an image model
            // invents later (ENG-326/ENG-933).
            updatedBrandData.logoUrl = outcome.url;
          }
        } catch (e: any) {
          console.warn('[brandLogo] auto-pin on update_brand_guidelines failed', {
            userId,
            error: e?.message ?? String(e),
          });
          logoAutoPinIssue =
            'Could not fetch/store the logo from that URL (unexpected error) — brandData.logoUrl was saved, but no Logo & Assets attachment was created.';
        }
      } else if (incomingLogoUrl && !callerSuppliedLogoAsset && alreadyHasLogoAsset) {
        // A real asset already exists and this call isn't replacing it (no
        // fresh brandAssets entry) — keep brandData.logoUrl in sync with what
        // is ACTUALLY displayed rather than letting it drift to whatever raw
        // URL this call happens to carry (e.g. Emma re-sending the original
        // scraped URL after the asset was already pinned on an earlier call).
        // Without this, the Logo & Assets card would keep showing the correct
        // pinned logo while brandData.logoUrl silently pointed somewhere else.
        updatedBrandData.logoUrl = existingLogoAssetUrl;
      } else if (
        callerSuppliedLogoAsset &&
        typeof callerLogoAsset?.url === 'string' &&
        callerLogoAsset.url.trim()
      ) {
        // ENG-933 live-verification finding: Emma's `update_brand_guidelines`
        // tool lets her supply brandAssets directly, and when explicitly
        // asked to save a logo she constructs her OWN asset object from
        // whatever URL she has — bypassing the auto-pin above entirely
        // (which only fires when brandAssets is absent) and storing the raw
        // site URL (e.g. a .ico) unrasterised and unpinned. Never trust a
        // caller-supplied logo URL blindly: run it through the same
        // rasterise/pin pipeline unless it's already one of our own S3
        // assets (the onboarding backstop's own call already looks like
        // this, and re-fetching it would be pure waste).
        const rawCallerLogoUrl = callerLogoAsset.url.trim();
        try {
          const { isS3Url } = await import('../../utils/s3Utils');
          if (!isS3Url(rawCallerLogoUrl)) {
            const outcome = await downloadBrandLogoToS3(rawCallerLogoUrl, userId);
            if (outcome.status === 'svg') {
              logoAutoPinIssue =
                'The provided logo asset URL is an SVG that could not be rasterised — it was stored as provided, which brand guidelines normally rejects. Ask the user to upload a PNG/JPEG/GIF/WEBP version instead.';
            } else if (outcome.status !== 'uploaded') {
              const detailSuffix = outcome.detail ? `: ${outcome.detail}` : '';
              logoAutoPinIssue =
                `Could not pin the provided logo asset URL (${outcome.status}${detailSuffix}) — it was stored as provided, which may not render reliably in every browser and isn't hosted on our own storage.`;
            } else if (outcome.url) {
              const filename = outcome.url.split('/').filter(Boolean).pop() || 'logo.png';
              callerLogoAssetOverride = {
                type: 'logo',
                url: outcome.url,
                filename,
                // Preserve the caller's own key if it supplied one (keeps a
                // stable React list key / delete-asset target), else mint a
                // fresh one matching the auto-pin's own convention.
                key:
                  typeof callerLogoAsset.key === 'string' && callerLogoAsset.key
                    ? callerLogoAsset.key
                    : `auto-logo-${Date.now()}`,
              };
              updatedBrandData.logoUrl = outcome.url;
            }
          }
        } catch (e: any) {
          console.warn('[brandLogo] pinning a caller-supplied logo asset failed', {
            userId,
            error: e?.message ?? String(e),
          });
          logoAutoPinIssue =
            'Could not pin the provided logo asset URL (unexpected error) — it was stored as provided.';
        }
      }

      // Handle brandAssets update - merge by type to preserve existing assets
      let updatedAttachments = [...(existingBrand.attachments || [])];
      const updatedAssets: any[] = []; // Track which assets were actually updated

      const assetsToMerge: any[] = normalizedBrandAssets.map((a: any) =>
        callerLogoAssetOverride && a?.type === 'logo' ? callerLogoAssetOverride : a
      );
      if (autoLogoAsset) {
        assetsToMerge.push(autoLogoAsset);
      }

      assetsToMerge.forEach(rawAsset => {
        const newAsset = normalizeBrandGuideAsset(rawAsset);
        const existingIndex = updatedAttachments.findIndex(existing => existing.type === newAsset.type);
        if (existingIndex >= 0) {
          // Replace existing asset of the same type
          updatedAttachments[existingIndex] = newAsset;
          updatedAssets.push(newAsset); // Track as updated
        } else {
          // Add new asset type
          updatedAttachments.push(newAsset);
          updatedAssets.push(newAsset); // Track as added
        }
      });

      // Update org-level or personal brand guidelines
      const updatedGuidelines = {
        ...existingBrand,
        brandData: updatedBrandData,
        attachments: updatedAttachments,
        updatedAt: new Date().toISOString()
      };

      if (user.orgId) {
        await guard.assertStillCurrent();
        await orgDb.updateOrg(user.orgId, { brandGuidelines: updatedGuidelines });
      } else {
        await userWrite({ brandGuidelines: updatedGuidelines });
      }

      const marketStrategyRefresh = refreshMarketStrategy === true
        ? await regenerateMarketStrategy(userId, {}, { sessionId: opts.sessionId })
        : undefined;

      // Onboarding v2 Phase 1: flip brand-build status to ready if we were
      // building. Best-effort; wrapped in try/catch so metrics failures don't
      // break the tool-call response path.
      try {
        const readyPatch = buildReadyPatch(user as any);
        if (readyPatch) {
          // A brand-build session completes only its own claim (the superseded
          // case returned above); the condition covers a reclaim landing since.
          let landed = false;
          if (sessionClaim) {
            try {
              await userDb.updateUser(userId, readyPatch, {
                condition: brandBuildOwnershipCondition(sessionClaim),
              });
              landed = true;
            } catch (condErr: any) {
              if (condErr?.code !== 'ConditionalCheckFailedException') throw condErr;
              console.warn('[brandBuild] dropping stale ready flip: a newer claim owns the build', { userId });
            }
          } else {
            await userDb.updateUser(userId, readyPatch);
            landed = true;
          }
          if (landed) {
            logCompletionMetric(userId, "ready", readyPatch.brandBuildDurationMs ?? 0);
          }
        }
      } catch (e) {
        console.warn("[brandBuild] ready-patch failed (agentMode path)", e);
      }

      const updatedFields = [];
      if (brandData) updatedFields.push(...Object.keys(brandData));
      if (assetsToMerge.length > 0) updatedFields.push('brandAssets');
      updatedFields.push(...Object.keys(otherFields));

      // Format the update result for LLM consumption
      const formattedContent = formatBrandGuidelinesUpdate({
        success: true,
        message: 'Brand guidelines updated successfully',
        updatedFields,
        brandData: updatedBrandData,
        attachments: updatedAttachments,
        updatedAssets: updatedAssets,
        ...(logoAutoPinIssue ? { logoAutoPinIssue } : {}),
      });

      return {
        success: true,
        message: marketStrategyRefresh?.success
          ? 'Brand guidelines and market strategy updated successfully'
          : 'Brand guidelines updated successfully',
        updatedFields,
        brandData: updatedBrandData,
        attachments: updatedAttachments,
        updatedAssets: updatedAssets, // Only the assets that were actually updated
        ...(marketStrategyRefresh
          ? {
            marketStrategyRefresh: {
              success: marketStrategyRefresh.success,
              replaced: marketStrategyRefresh.replaced,
              generated: marketStrategyRefresh.generated,
              ...(marketStrategyRefresh.error ? { error: marketStrategyRefresh.error } : {}),
            }
          }
          : {}),
        // ENG-933 follow-up: the write always succeeds even when the logo
        // fetch/rasterise attempt didn't land an asset — this field is how
        // that partial outcome reaches Emma instead of reading as full
        // success while the Logo & Assets card stays empty.
        ...(logoAutoPinIssue ? { logoAutoPinIssue } : {}),
        formattedContent
      };
    } catch (error) {
      if (error instanceof SupersededBrandBuildWrite) {
        console.warn('[brandBuild] dropping update from a superseded brand-build session: a newer claim took over mid-call');
        return supersededResult();
      }
      console.error('AgentMode: Error updating brand guidelines:', error);
      return {
        success: false,
        message: 'Failed to update brand guidelines',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Read the user's effective market strategy (org-level if the user belongs to
   * an org, otherwise personal). Shared by the brand re-setup offer and the
   * regenerate flow so both report the same "what exists today" counts. (ENG-44)
   */
async function getExistingMarketStrategy(user: any): Promise<any> {
    if (user?.orgId) {
      const { orgDb } = await import('../../services/db');
      const { resolveOrgProfileField } = await import('../../services/orgProfileResolver');
      const org = await orgDb.getOrgById(user.orgId);
      // Owner-record fallback for an org that was never populated (ENG-927), so
      // the re-setup offer and the regenerate flow count what the user actually
      // has rather than offering to build a strategy that already exists.
      if (org) return resolveOrgProfileField(user, org, 'marketStrategy');
    }
    return user?.marketStrategy;
  }

  /**
   * Regenerate the user's market strategy (ICPs + competitors) from their CURRENT
   * brand guidelines, then REPLACE the existing ICPs/competitors (business overview
   * is preserved). Composes the same generators the onboarding pipeline uses, so
   * there is no new generation logic here. Destructive by design — the caller
   * (Emma) must have explicit user confirmation before invoking. Returns the
   * before/after counts. (ENG-44)
   */
export async function regenerateMarketStrategy(
    userId: string,
    deps: {
      llm?: any;
      webSearchFn?: any;
    } = {},
    opts: { sessionId?: string } = {},
  ): Promise<any> {
    try {
      const { userDb } = await import('../../services/db');
      const {
        extractIcpBrandContext,
        generateIcpsForUser,
        mapIcpResultToMarketStrategy,
      } = await import('../../services/onboardingIcpService');
      const {
        generateCompetitorStrategyForUser,
        mapCompetitorResultToMarketStrategy,
      } = await import('../../services/onboardingCompetitorService');

      const user: any = await userDb.getUserById(userId);
      if (!user) {
        return { success: false, message: 'User not found', error: 'User not found' };
      }

      const brand = extractIcpBrandContext(user);
      if (!brand.companyName && !brand.companyUrl) {
        return {
          success: false,
          message:
            'There are no brand guidelines to base a market strategy on yet. Set up the brand first, then regenerate the market strategy.',
          error: 'Missing brand context',
        };
      }

      // Count what we are about to replace (org-aware) BEFORE regenerating.
      const existing = await getExistingMarketStrategy(user);
      const replaced = {
        competitors: Array.isArray(existing?.competitors) ? existing.competitors.length : 0,
        icps: Array.isArray(existing?.icp) ? existing.icp.length : 0,
      };

      // Generate ICPs first, then competitors (competitors need the ICPs as input).
      const personas = await generateIcpsForUser(brand, { llm: deps.llm }, userId);
      let competitorResult: any = { per_icp: [] };
      if (Array.isArray(personas) && personas.length > 0) {
        // ENG-1858: attribute and charge the regeneration to the requesting user.
        competitorResult = await generateCompetitorStrategyForUser(
          brand,
          personas,
          deps,
          { userId, feature: 'onboarding_competitors' },
        );
      }

      const icp = mapIcpResultToMarketStrategy(personas);
      const competitors = mapCompetitorResultToMarketStrategy(competitorResult);

      // Persist via updateMarketStrategy with replace:true so org-vs-user routing,
      // permission checks, and businessOverview preservation are all reused.
      const writeResult = await updateMarketStrategy({ icp, competitors }, userId, { replace: true, sessionId: opts.sessionId });
      if (!writeResult.success) return writeResult;

      return {
        success: true,
        message: `Market strategy regenerated to match the current brand. Replaced ${replaced.competitors} competitor(s) and ${replaced.icps} ICP(s) with ${competitors.length} new competitor(s) and ${icp.length} new ICP(s).`,
        replaced,
        generated: { competitors: competitors.length, icps: icp.length },
      };
    } catch (error) {
      console.error('AgentMode: Error regenerating market strategy:', error);
      return {
        success: false,
        message: 'Failed to regenerate market strategy',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // Helper function to format brand guidelines for AI analysis
function formatBrandGuidelines(brandResult: any): string {
    if (!brandResult.exists) {
      return `<strong>🎨 Brand Guidelines</strong><br>No brand guidelines are currently configured. You can help the user set up their brand identity by asking about their brand name, colors, tone of voice, and other brand elements.`;
    }

    const { brandData, attachments } = brandResult;
    let formattedSummary = `<strong>🎨 Brand Guidelines Retrieved</strong><br>`;
    formattedSummary += `I've successfully retrieved your brand guidelines. Here's what I found:<br><br>`;

    // Brand Identity Section (matches UI structure)
    formattedSummary += `<strong>💖 Brand Identity</strong><br>`;
    formattedSummary += `• <strong>Brand Name:</strong> ${brandData.brandName || 'Not set'}<br>`;
    formattedSummary += `• <strong>Tagline:</strong> ${brandData.tagline || 'Not set'}<br>`;
    formattedSummary += `• <strong>Target Audience:</strong> ${brandData.targetAudience || 'Not set'}<br><br>`;

    // Brand Colors Section (matches UI structure)
    formattedSummary += `<strong>🎨 Brand Colors</strong><br>`;
    if (brandData.primaryColor) {
      if (brandData.isGradient && brandData.primaryColorEnd) {
        formattedSummary += `• <strong>Primary Color (Gradient):</strong> ${brandData.primaryColor} → ${brandData.primaryColorEnd}<br>`;
      } else {
        formattedSummary += `• <strong>Primary Color:</strong> ${brandData.primaryColor}<br>`;
      }
    }
    formattedSummary += `• <strong>Secondary Color:</strong> ${brandData.secondaryColor || 'Not set'}<br><br>`;

    // Typography Section (matches UI structure)
    formattedSummary += `<strong>🔤 Typography</strong><br>`;
    formattedSummary += `• <strong>Font Family:</strong> ${brandData.fontFamily || 'Not set'}<br><br>`;

    // Brand Voice & Messaging Section (matches UI structure)
    formattedSummary += `<strong>💬 Brand Voice & Messaging</strong><br>`;
    formattedSummary += `• <strong>Tone of Voice:</strong> ${brandData.toneOfVoice || 'Not set'}<br>`;
    formattedSummary += `• <strong>Brand Personality:</strong> ${brandData.brandPersonality || 'Not set'}<br><br>`;

    // Key Messages Section (matches UI structure)
    formattedSummary += `<strong>📝 Key Messages</strong><br>`;
    if (brandData.keyMessages && brandData.keyMessages.length > 0) {
      brandData.keyMessages.forEach((message: string, index: number) => {
        formattedSummary += `• ${index + 1}. ${message}<br>`;
      });
    } else {
      formattedSummary += `• No key messages set<br>`;
    }
    formattedSummary += `<br>`;

    // Brand Values Section (matches UI structure)
    formattedSummary += `<strong>💖 Brand Values</strong><br>`;
    if (brandData.brandValues && brandData.brandValues.length > 0) {
      brandData.brandValues.forEach((value: string) => {
        formattedSummary += `• ${value}<br>`;
      });
    } else {
      formattedSummary += `• No brand values set<br>`;
    }
    formattedSummary += `<br>`;

    // Founder Profile Section (matches UI structure)
    formattedSummary += `<strong>👥 Founder Profile</strong><br>`;
    if (brandData.founders && brandData.founders.length > 0) {
      brandData.founders.forEach((founder: any, index: number) => {
        formattedSummary += `• <strong>Founder ${index + 1}:</strong> ${founder.name}<br>`;
        if (founder.jobTitle) {
          formattedSummary += `  📋 <strong>Job Title:</strong> ${founder.jobTitle}<br>`;
        }
        if (founder.styleTone) {
          formattedSummary += `  🎭 <strong>Style & Tone:</strong> ${founder.styleTone}<br>`;
        }
        if (founder.signaturePosts) {
          formattedSummary += `  ✍️ <strong>Signature Posts:</strong> ${founder.signaturePosts}<br>`;
        }
        if (founder.voiceExamples) {
          formattedSummary += `  📝 <strong>Voice Examples (CRITICAL — use these as your style template):</strong><br>`;
          formattedSummary += `  <em>When generating posts for this founder, study the sentence length, vocabulary, punctuation, line breaks, hooks, and overall rhythm of these examples. Do NOT default to generic LinkedIn templates or AI-industry clichés. Mirror this exact voice:</em><br>`;
          formattedSummary += `  <blockquote>${founder.voiceExamples.replace(/\n/g, '<br>')}</blockquote>`;
        }
        formattedSummary += `<br>`;
      });
    } else {
      formattedSummary += `• No founder profiles added<br>`;
    }
    formattedSummary += `<br>`;

    // Logo & Assets Section (matches UI structure)
    formattedSummary += `<strong>🖼️ Logo & Assets</strong><br>`;
    if (attachments && attachments.length > 0) {
      const logoAssets = attachments.filter((asset: any) => asset.type === 'logo' || asset.type === 'secondaryLogo');
      const brandGuideAssets = attachments.filter((asset: any) => asset.type === 'brandGuide');

      if (logoAssets.length > 0) {
        logoAssets.forEach((asset: any) => {
          const logoType = asset.type === 'logo' ? 'Primary Logo' : 'Secondary Logo';
          formattedSummary += `• <strong>${logoType}:</strong> ${asset.filename}<br>`;
          formattedSummary += `  🔗 <a href="${asset.url}" target="_blank">View ${logoType}</a><br>`;
        });
      } else {
        formattedSummary += `• No logos uploaded<br>`;
      }

      if (brandGuideAssets.length > 0) {
        brandGuideAssets.forEach((asset: any) => {
          formattedSummary += `• <strong>Brand Guide:</strong> ${asset.filename}<br>`;
          formattedSummary += `  🔗 <a href="${asset.url}" target="_blank">View Brand Guide</a><br>`;
        });
      } else {
        formattedSummary += `• No brand guide uploaded<br>`;
      }
    } else {
      formattedSummary += `• No assets uploaded<br>`;
    }

    formattedSummary += `<br><em>💡 I'll use this brand information to ensure all generated content aligns with your brand identity and guidelines.</em>`;
    formattedSummary += `<br><br><strong>⚠️ Note:</strong> This brand guidelines data is current and complete. Please do not call read_brand_guidelines again in this conversation as it will return the same information.`;

    return formattedSummary;
  }

  // Helper function to format brand guidelines update feedback for AI analysis
function formatBrandGuidelinesUpdate(updateResult: any): string {
    if (!updateResult.success) {
      return `<strong>❌ Brand Guidelines Update Failed</strong><br>${updateResult.message || 'Unknown error occurred while updating brand guidelines.'}`;
    }

    const { updatedFields, brandData, updatedAssets } = updateResult;
    let formattedSummary = `<strong>✅ Brand Guidelines Updated Successfully</strong><br>`;
    formattedSummary += `Here's what was changed:<br><br>`;

    // Show only the updated fields
    if (updatedFields && updatedFields.length > 0) {
      formattedSummary += `<strong>📝 Updated Fields:</strong><br>`;
      updatedFields.forEach((field: string) => {
        let value;
        if (field === 'brandAssets') {
          // Handle brand assets separately - use only the updated assets
          value = updatedAssets;
        } else {
          // Handle brand data fields
          value = brandData[field];
        }

        if (value !== undefined && value !== null) {
          if (field === 'brandAssets' && Array.isArray(value) && value.length > 0) {
            formattedSummary += `• <strong>Brand Assets:</strong> Updated ${value.length} asset(s)<br>`;
            value.forEach((asset: any) => {
              const assetType = asset.type === 'logo' ? 'Primary Logo' :
                asset.type === 'secondaryLogo' ? 'Secondary Logo' :
                  asset.type === 'brandGuide' ? 'Brand Guide' :
                    asset.type === 'additionalAsset' ? 'Additional Asset' : asset.type;
              formattedSummary += `  - ${assetType}: ${asset.filename}<br>`;
            });
          } else if (field === 'founders' && Array.isArray(value)) {
            formattedSummary += `• <strong>Founder Profiles:</strong> Updated ${value.length} founder(s)<br>`;
            value.forEach((founder: any, index: number) => {
              formattedSummary += `  - <strong>Founder ${index + 1}:</strong> ${founder.name}<br>`;
              if (founder.jobTitle) {
                formattedSummary += `    📋 Job Title: ${founder.jobTitle}<br>`;
              }
              if (founder.styleTone) {
                formattedSummary += `    🎭 Style & Tone: ${founder.styleTone}<br>`;
              }
              if (founder.signaturePosts) {
                formattedSummary += `    ✍️ Signature Posts: ${founder.signaturePosts}<br>`;
              }
              if (founder.voiceExamples) {
                formattedSummary += `    📝 Voice Examples: ${founder.voiceExamples.substring(0, 200)}${founder.voiceExamples.length > 200 ? '…' : ''}<br>`;
              }
            });
          } else if (Array.isArray(value)) {
            formattedSummary += `• <strong>${field}:</strong> ${value.join(', ')}<br>`;
          } else {
            formattedSummary += `• <strong>${field}:</strong> ${value}<br>`;
          }
        }
      });
    }

    if (updateResult.logoAutoPinIssue) {
      formattedSummary += `<br><strong>⚠️ Logo not stored as an asset:</strong> ${updateResult.logoAutoPinIssue}<br>`;
    }

    formattedSummary += `<br><em>💡 You can view the latest brand guidelines at the <a href="/brand-guidelines">Brand Guidelines page</a>.</em>`;

    return formattedSummary;
  }

  // How many characters of competitor descriptions one read_market_strategy page
  // may render. This is a CHARACTER budget rather than a fixed entry count on
  // purpose (ENG-945): competitor descriptions on real accounts run from ~60 to
  // ~2,100 chars, so any fixed count either wastes the page or overflows it.
  // A tool result over 20,000 chars is offloaded to S3 and only its first 20,000
  // chars stay in the model's context, so an oversized page pushes its own
  // competitor list out of context — the failure this ticket is about. 8,000
  // leaves room for the business overview, the ICP section (8,000+ on some
  // accounts), the name index and the closing notes, and still keeps the whole
  // response inline.
const COMPETITOR_DETAIL_CHAR_BUDGET = 8000;

  // Coverage guaranteed to callers that embed formattedContent directly in their
  // own prompt rather than returning it as a tool result. 40 is exactly what
  // readMarketStrategy rendered in full before ENG-945, so those prompts are
  // unchanged by the introduction of paging.
  //
  // Exported (unlike the other budget constants here) because
  // AgentModeService.updateEmailDraftForLead — which stays on the class,
  // this.callLLM-coupled, not part of this extraction — passes this to
  // readMarketStrategy as minCompetitorsInFull for its own embedded prompt.
export const PROMPT_EMBEDDED_COMPETITOR_DETAIL = 40;

  // Ceiling on the name-only index. Without one it grows with the roster and can
  // push the very tail it exists to expose past the 20,000-char in-context cap
  // (and it is embedded verbatim in the CRM email prompt). Anything beyond this
  // is still counted, still in the stated total, and still reachable by offset —
  // bounded, never silent.
const COMPETITOR_NAME_INDEX_CHAR_BUDGET = 3000;

  // Aggregate target for the whole formatted response, sized under the
  // 20,000-char in-context cap with headroom for the notice and closing note.
const RESPONSE_CHAR_TARGET = 18500;
const RESPONSE_FIXED_CHROME = 900;
const MIN_COMPETITOR_DETAIL_CHARS = 1200;
const MIN_COMPETITOR_NAME_INDEX_CHARS = 400;
  // Per-field ceiling. Names and descriptions are unbounded on write, so one
  // record could otherwise dominate the whole response.
const COMPETITOR_FIELD_MAX_CHARS = 3000;
  // Hard ceiling for a TOOL response, under the 20,000-char in-context cap.
  // Callers that embed the text in their own prompt are not clamped — they have
  // no transport cap, and clamping them would undo the ENG-945 non-regression.
const RESPONSE_HARD_CAP = 19000;
const BUSINESS_OVERVIEW_MAX_CHARS = 2500;
const ICP_SECTION_MAX_CHARS = 6000;
const COMPETITOR_LOOKUP_MAX = 50;
const LOOKUP_NAME_MAX_CHARS = 120;
const LOOKUP_BLOCK_MAX_CHARS = 3000;

  // Rendered separately from formatMarketStrategy so its true cost can be
  // measured BEFORE the competitor budgets are allocated (ENG-945 / Greptile):
  // the overview and ICP share the same response, so competitor sections must
  // fit the room those leave rather than spending a fixed budget on top.
function formatIcpSection(icp: any): string {
    let out = `<strong>🎯 Ideal Customer Profile (ICP)</strong><br>`;
    if (Array.isArray(icp) && icp.length > 0) {
      icp.forEach((entry: any) => {
        if (typeof entry === 'object' && entry && entry.title) {
          out += `• <strong>${entry.title}:</strong> ${entry.description || 'No description provided'}<br>`;
          if (entry.valueProposition) out += `  <em>Value Proposition:</em> ${entry.valueProposition}<br>`;
          if (Array.isArray(entry.buyerPersonas) && entry.buyerPersonas.length > 0) {
            out += `  <em>Buyer Personas:</em> ${entry.buyerPersonas.join(', ')}<br>`;
          }
        } else {
          out += `• ${entry}<br>`;
        }
      });
    } else {
      out += `• No ideal customer profiles defined yet<br>`;
    }
    return out;
  }

  /**
   * Room left for competitor detail + the name index once the parts of the
   * response we do NOT control (business overview, ICP, headers, closing note)
   * have taken their share of the in-context cap. Never returns less than
   * MIN, so a pathological ICP degrades the competitor sections instead of
   * emptying them.
   */
function competitorCharBudgets(marketData: any): { detail: number; nameIndex: number } {
    const fixed =
      String(marketData?.businessOverview || '').length +
      formatIcpSection(marketData?.icp).length +
      RESPONSE_FIXED_CHROME;
    const room = RESPONSE_CHAR_TARGET - fixed;
    const detail = Math.max(
      MIN_COMPETITOR_DETAIL_CHARS,
      Math.min(COMPETITOR_DETAIL_CHAR_BUDGET, Math.floor(room * 0.7)),
    );
    const nameIndex = Math.max(
      MIN_COMPETITOR_NAME_INDEX_CHARS,
      Math.min(COMPETITOR_NAME_INDEX_CHAR_BUDGET, room - detail),
    );
    return { detail, nameIndex };
  }

  /**
   * Cut `text` to `allowed` characters, ALWAYS saying how much was removed.
   * ENG-945's rule is "never hide silently", not "never bound" — an explicit
   * marker is what separates this from the bug this ticket fixed.
   */
function truncateWithNotice(text: string, allowed: number): string {
    if (text.length <= allowed) return text;
    if (allowed <= 0) return '';
    const marker = (n: number) => ` …<em>[truncated — ${n} characters omitted; open the Market Strategy page to read the full text]</em>`;
    const full = marker(text.length);
    // The marker itself must fit inside the allowance, or the "hard" bound
    // would be breached by the very notice that announces the cut.
    if (full.length >= allowed) {
      const short = '…[truncated]';
      return short.length <= allowed ? short : text.slice(0, allowed);
    }
    // marker(text.length) is an upper bound on marker(text.length - keep) — the
    // omitted count can only have fewer digits — so the result never exceeds
    // `allowed`.
    const keep = allowed - full.length;
    return text.slice(0, keep) + marker(text.length - keep);
  }

  /**
   * "Is this competitor already stored?" — answered directly, so a bounded name
   * index can never leave a caller guessing (ENG-945). Matching mirrors
   * updateMarketStrategy's merge-by-name, loosened to ignore case and padding so
   * a near-miss does not read as "not stored" and cause a duplicate.
   */
function lookupCompetitors(
    competitors: any[],
    names?: string[],
  ): Array<{ name: string; stored: boolean; offset: number | null }> | undefined {
    if (!Array.isArray(names) || names.length === 0) return undefined;
    const norm = (v: any) => String(v ?? '').trim().toLowerCase();
    const byName = new Map<string, number>();
    competitors.forEach((competitor: any, index: number) => {
      const key = norm(typeof competitor === 'object' && competitor ? competitor.name : competitor);
      if (key && !byName.has(key)) byName.set(key, index);
    });
    return names
      .slice(0, COMPETITOR_LOOKUP_MAX)
      .map((requested) => {
        const offset = byName.get(norm(requested));
        return {
          name: String(requested),
          stored: offset !== undefined,
          offset: offset === undefined ? null : offset,
        };
      });
  }

function formatCompetitorDetailLine(competitor: any): string {
    if (typeof competitor === 'object' && competitor && competitor.name) {
      const name = truncateWithNotice(String(competitor.name), COMPETITOR_FIELD_MAX_CHARS);
      const description = truncateWithNotice(
        String(competitor.description || 'No description provided'),
        COMPETITOR_FIELD_MAX_CHARS,
      );
      return `• <strong>${name}:</strong> ${description}<br>`;
    }
    return `• ${truncateWithNotice(String(competitor), COMPETITOR_FIELD_MAX_CHARS)}<br>`;
  }

  /**
   * Fill a page of full-detail competitors starting at `offset`, stopping when
   * the character budget is spent.
   *
   * `minEntries` is a floor the budget cannot undercut: the first `minEntries`
   * are always rendered in full, however long they are. It defaults to 1 so a
   * single oversized description can still be read — an empty page would be the
   * same silent-nothing failure mode the budget exists to prevent — and
   * non-tool callers raise it to preserve their pre-ENG-945 coverage.
   */
function resolveCompetitorDetailWindow(
    competitors: any[],
    offset: number,
    minEntries: number = 1,
    charBudget: number = COMPETITOR_DETAIL_CHAR_BUDGET,
  ): { start: number; end: number } {
    const start = Math.min(Math.max(Math.floor(offset) || 0, 0), Math.max(0, competitors.length - 1));
    const floor = Math.max(1, Math.floor(minEntries) || 1);
    let used = 0;
    let end = start;
    while (end < competitors.length) {
      const cost = formatCompetitorDetailLine(competitors[end]).length;
      const withinFloor = end - start < floor;
      if (!withinFloor && used + cost > charBudget) break;
      used += cost;
      end++;
    }
    return { start, end };
  }

  // Helper function to format market strategy for AI analysis
function formatMarketStrategy(marketResult: any): string {
    if (!marketResult.exists) {
      return `<strong>📊 Market Strategy</strong><br>No market strategy is currently configured. You can help the user set up their market strategy by asking about their business overview, competitors, and ideal customer profiles.`;
    }

    const { marketData } = marketResult;
    let formattedSummary = `<strong>📊 Market Strategy Retrieved</strong><br>`;
    formattedSummary += `I've successfully retrieved your market strategy. Here's what I found:<br><br>`;

    // Rendered FIRST, deliberately: this is the answer to "should I add this
    // competitor?", so it must sit ahead of everything the response clamp can
    // trim (ENG-945).
    const lookup: Array<{ name: string; stored: boolean; offset: number | null }> | undefined =
      marketResult.competitorLookup;
    if (lookup && lookup.length > 0) {
      formattedSummary += `<strong>🔎 Competitor check — already stored?</strong><br>`;
      // Names are unbounded on write AND in the request, so the block is bounded
      // by characters as well as by entry count — otherwise the answer could
      // swallow the response it is rendered in front of.
      let lookupChars = 0;
      let rendered = 0;
      for (const entry of lookup) {
        const name = truncateWithNotice(String(entry.name), LOOKUP_NAME_MAX_CHARS);
        const line = entry.stored
          ? `• <strong>${name}</strong>: ALREADY STORED at offset ${entry.offset} — do NOT add it again.<br>`
          : `• <strong>${name}</strong>: not stored — safe to add.<br>`;
        if (rendered > 0 && lookupChars + line.length > LOOKUP_BLOCK_MAX_CHARS) break;
        formattedSummary += line;
        lookupChars += line.length;
        rendered++;
      }
      if (rendered < lookup.length) {
        formattedSummary += `<strong>⚠️ ${lookup.length - rendered} further answer(s) omitted here</strong> — re-ask about those names in a smaller batch; do NOT assume they are absent.<br>`;
      }
      const notChecked: number = marketResult.competitorNamesNotChecked || 0;
      if (notChecked > 0) {
        formattedSummary += `<strong>⚠️ ${notChecked} further requested name(s) were NOT checked</strong> (only ${COMPETITOR_LOOKUP_MAX} names are checked per call). Do NOT assume those are absent — call read_market_strategy again with the remaining names before adding any of them.<br>`;
      }
      formattedSummary += `<br>`;
    }

    // Business Overview Section (matches UI structure). Bounded on the tool path
    // only — see RESPONSE_HARD_CAP.
    const clamp = marketResult.pagingHints !== false;
    formattedSummary += `<strong>🏢 Business Overview</strong><br>`;
    if (marketData.businessOverview) {
      const overview = clamp
        ? truncateWithNotice(String(marketData.businessOverview), BUSINESS_OVERVIEW_MAX_CHARS)
        : String(marketData.businessOverview);
      formattedSummary += `${overview}<br><br>`;
    } else {
      formattedSummary += `No business overview provided yet.<br><br>`;
    }

    // Competitors Section (matches UI structure)
    // ENG-945: entries outside the [competitorDetailStart, competitorDetailEnd)
    // window are rendered by name only rather than dropped, so the reader always
    // sees the complete roster. With no window supplied the whole list is
    // rendered in full, which is what non-tool callers get.
    const competitors: any[] = Array.isArray(marketData.competitors) ? marketData.competitors : [];
    const detailStart = typeof marketResult.competitorDetailStart === 'number' ? marketResult.competitorDetailStart : 0;
    const detailEnd = typeof marketResult.competitorDetailEnd === 'number' ? marketResult.competitorDetailEnd : competitors.length;
    const nameOf = (competitor: any) =>
      (typeof competitor === 'object' && competitor && competitor.name) ? competitor.name : String(competitor);
    const inWindow = (index: number) => index >= detailStart && index < detailEnd;
    const nameOnlyCount = competitors.filter((_, index) => !inWindow(index)).length;
    // How many stored competitors this response could not even name. Tracked so
    // the closing note cannot claim completeness the body does not deliver.
    let unnamedCount = 0;
    const pagingHints = marketResult.pagingHints !== false;
    const nameIndexBudget = typeof marketResult.nameIndexCharBudget === 'number'
      ? marketResult.nameIndexCharBudget
      : COMPETITOR_NAME_INDEX_CHAR_BUDGET;

    formattedSummary += `<strong>🏆 Competitors (${competitors.length} total)</strong><br>`;
    if (competitors.length > 0) {
      competitors.forEach((competitor: any, index: number) => {
        if (!inWindow(index)) return;
        formattedSummary += formatCompetitorDetailLine(competitor);
      });
      if (nameOnlyCount > 0) {
        // The name index is bounded too, or a large enough roster would push the
        // tail out of the response it is meant to make visible. Bounded is fine;
        // SILENT is not — anything not listed is still counted, still included in
        // the stated total, and still reachable by offset.
        const nameOnly: Array<{ index: number; name: string }> = [];
        competitors.forEach((competitor: any, index: number) => {
          if (!inWindow(index)) nameOnly.push({ index, name: nameOf(competitor) });
        });
        let indexChars = 0;
        let listed = 0;
        for (const entry of nameOnly) {
          const cost = (pagingHints ? `• [offset ${entry.index}] ${entry.name}<br>` : `• ${entry.name}<br>`).length;
          // Strict: a single pathological name must not blow the index. Competitor
          // names are unbounded on write, so admitting the first entry regardless
          // of size would let one record overflow the whole response. The index
          // may end up empty — the remainder line below then accounts for
          // everyone, so nobody is hidden either way.
          if (indexChars + cost > nameIndexBudget) break;
          indexChars += cost;
          listed++;
        }
        const unlisted = nameOnly.slice(listed);
        unnamedCount = unlisted.length;

        if (pagingHints) {
          // Lead with the random-access affordance, not the next page: every entry
          // below carries its own offset, so any single competitor is one call
          // away. Teaching "next page" first would have the model walk the list in
          // order to reach entry 48 (ENG-945).
          // With a strict cap the index can be empty, so the worked example must
          // fall back to the first unlisted entry rather than indexing off the end.
          const exampleOffset = listed > 0 ? nameOnly[listed - 1].index : nameOnly[0].index;
          // Only advertise a next page when one actually exists — otherwise the
          // prose contradicts nextCompetitorOffset: null and restarts the reader.
          const walkHint = detailEnd < competitors.length
            ? ` To walk the entire list in order instead, use the nextCompetitorOffset value returned with each page (currently ${detailEnd}).`
            : '';
          formattedSummary += `<br><strong>ℹ️ ${nameOnlyCount} further competitor(s) are stored and shown by name only</strong> (full details omitted to keep this response small). These ARE part of the market strategy — do not treat them as missing and do not add them again. To read any one of them in full, call read_market_strategy again with competitorOffset set to the number in brackets beside that name — you can jump straight to the entry you want, there is no need to page through in order (e.g. <code>competitorOffset: ${exampleOffset}</code> reads the entry marked [offset ${exampleOffset}]).${walkHint}<br>`;
          nameOnly.slice(0, listed).forEach(e => {
            formattedSummary += `• [offset ${e.index}] ${e.name}<br>`;
          });
          if (unlisted.length > 0) {
            formattedSummary += `<strong>…and ${unlisted.length} more stored competitor(s) not named in this response</strong> (the account holds ${competitors.length} in total — none have been deleted). Read them with <code>competitorOffset: ${unlisted[0].index}</code> and onwards. To check whether a specific competitor is among them BEFORE adding it, call read_market_strategy with <code>competitorNames: ["Name A", "Name B"]</code> — it answers stored/not-stored for each.<br>`;
          }
        } else {
          // Prompt-embedding caller: name the rest, no tool directives, no offsets.
          formattedSummary += `<br><strong>ℹ️ ${nameOnlyCount} further competitor(s) are stored (names only):</strong><br>`;
          nameOnly.slice(0, listed).forEach(e => {
            formattedSummary += `• ${e.name}<br>`;
          });
          if (unlisted.length > 0) {
            formattedSummary += `<strong>…and ${unlisted.length} more stored competitor(s) not named here</strong> (the account holds ${competitors.length} in total — none have been deleted).<br>`;
          }
        }
      }
    } else {
      formattedSummary += `• No competitors identified yet<br>`;
    }
    formattedSummary += `<br>`;

    // Ideal Customer Profile (ICP) Section (matches UI structure)
    const icpSection = formatIcpSection(marketData.icp);
    formattedSummary += clamp
      ? truncateWithNotice(icpSection, ICP_SECTION_MAX_CHARS)
      : icpSection;

    formattedSummary += `<br><em>💡 I'll use this market strategy information to inform marketing campaigns, content strategy, and business development decisions.</em>`;
    // Only tell the model the read is exhaustive when it actually is. With a
    // name-only tail, a second call is the supported way to read the rest —
    // unless the caller has no tools to call, in which case say nothing about
    // tools at all.
    // The note must describe what the body actually delivered. Claiming "every
    // competitor is listed above" while the index omitted some is the same
    // false-completeness signal ENG-945 was filed for.
    const closingNote = unnamedCount > 0
      ? (pagingHints
        ? `<br><br><strong>⚠️ Note:</strong> This account stores ${competitors.length} competitors. ${unnamedCount} of them are NOT named anywhere in this response — nothing has been deleted, this response is simply size-bounded. Do NOT conclude a competitor is absent because it does not appear here: call read_market_strategy with competitorNames: ["Name"] to check a specific one, or competitorOffset to page through the rest.`
        // Prompt-embedded caller: state the shortfall, but never name a tool it
        // cannot call — the same rule the rest of this path follows.
        : `<br><br><strong>⚠️ Note:</strong> This account stores ${competitors.length} competitors. ${unnamedCount} of them are NOT named anywhere in this response — nothing has been deleted, this response is simply size-bounded. Do not conclude a competitor is absent because it does not appear here.`)
      : !pagingHints
        ? (nameOnlyCount > 0
          ? `<br><br><strong>⚠️ Note:</strong> Every competitor stored on this account is listed above; ${nameOnlyCount} of them by name only. Nothing is missing.`
          : `<br><br><strong>⚠️ Note:</strong> This market strategy data is current and complete.`)
        : (nameOnlyCount > 0
          ? `<br><br><strong>⚠️ Note:</strong> Every competitor stored on this account is listed above, but ${nameOnlyCount} of them are shown by name only. Nothing is missing. To read any of those in full, call read_market_strategy again with competitorOffset set to the offset shown beside the name.`
          : `<br><br><strong>⚠️ Note:</strong> This market strategy data is current and complete. Please do not call read_market_strategy again in this conversation as it will return the same information.`);

    if (!clamp) return formattedSummary + closingNote;

    // Final guarantee. Every section above is individually bounded, but the only
    // way to PROVE the tool result fits the transport's in-context cap is to
    // clamp the assembled string — while reserving the closing note, because the
    // "nothing is missing" guidance is exactly what must never be the thing that
    // gets cut (that would be ENG-945 all over again).
    const room = RESPONSE_HARD_CAP - closingNote.length;
    return truncateWithNotice(formattedSummary, room) + closingNote;
  }

  // Helper function to format market strategy update feedback for AI analysis
function formatMarketStrategyUpdate(updateResult: any): string {
    if (!updateResult.success) {
      return `<strong>❌ Market Strategy Update Failed</strong><br>${updateResult.message || 'Unknown error occurred while updating market strategy.'}`;
    }

    const { updatedFields, marketData, updatedEntries, addedEntries, totalCompetitors, totalICPs } = updateResult;
    let formattedSummary = `<strong>✅ Market Strategy Updated Successfully</strong><br>`;
    formattedSummary += `Here's what was changed:<br><br>`;

    // Show updated fields
    if (updatedFields && updatedFields.length > 0) {
      formattedSummary += `<strong>📝 Updated Fields:</strong><br>`;
      updatedFields.forEach((field: string) => {
        if (field === 'businessOverview') {
          formattedSummary += `• <strong>Business Overview:</strong> Updated<br>`;
        } else if (field === 'competitors') {
          const updatedCount = updatedEntries.filter((entry: string) => entry.startsWith('Competitor:')).length;
          const addedCount = addedEntries.filter((entry: string) => entry.startsWith('Competitor:')).length;
          formattedSummary += `• <strong>Competitors:</strong> ${updatedCount} updated, ${addedCount} added (${totalCompetitors} total)<br>`;
        } else if (field === 'icp') {
          const updatedCount = updatedEntries.filter((entry: string) => entry.startsWith('ICP:')).length;
          const addedCount = addedEntries.filter((entry: string) => entry.startsWith('ICP:')).length;
          formattedSummary += `• <strong>Ideal Customer Profiles:</strong> ${updatedCount} updated, ${addedCount} added (${totalICPs} total)<br>`;
        }
      });
    }

    // Show specific entries that were updated vs added
    if (updatedEntries && updatedEntries.length > 0) {
      formattedSummary += `<br><strong>🔄 Updated Entries:</strong><br>`;
      updatedEntries.forEach((entry: string) => {
        formattedSummary += `• ${entry}<br>`;
      });
    }

    if (addedEntries && addedEntries.length > 0) {
      formattedSummary += `<br><strong>➕ Added Entries:</strong><br>`;
      addedEntries.forEach((entry: string) => {
        formattedSummary += `• ${entry}<br>`;
      });
    }

    formattedSummary += `<br><em>💡 You can view the latest market strategy at the <a href="/market-strategy">Market Strategy page</a>.</em>`;

    return formattedSummary;
  }
