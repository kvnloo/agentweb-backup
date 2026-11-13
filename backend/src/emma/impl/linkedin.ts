/**
 * ENG-2103 (F2) — LinkedIn posting & outreach tool cluster, extracted from
 * `AgentModeService`. The 16th domain cluster in this series, and the
 * biggest single method moved so far (`linkedinOutreach`, ~1,270 lines).
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`,
 * in file order: postOnConnectedAccount, linkedinRepost, commentOnLinkedInPost,
 * resolveAccessibleAccount, listLinkedInComments, reactToLinkedInPost,
 * linkedInDisconnectedResponse, linkedInSearchUnavailableResponse,
 * linkedinOutreach — plus two module-scope (non-class) helpers that lived near
 * the top of agentModeService.ts: the `LINKEDIN_SEARCH_UNAVAILABLE_GUIDANCE`
 * constant and `linkedInPublicIdFromUrl`.
 *
 * NOT moved, explicitly out of scope for this cluster (the next cluster,
 * Twitter, covers these): `twitterManagePost`, `_twitterManagePostImpl`,
 * `twitterOutreach`, `_twitterOutreachImpl` (begin immediately after
 * `linkedinOutreach` ends, ~line 24664 pre-extraction) and everything from
 * `getLinkedInAdsCredentials`/`callLinkedInMarketingApi` onward (a separate
 * ads-API cluster). Cluster 15's already-extracted `emma/impl/socialAccounts.ts`
 * and its 3 delegating wrappers on the class (`loadConnectedAccountPosts`,
 * `loadConnectedAccountMetrics`, `getPostAnalytics`) are untouched.
 *
 * ONE METHOD DELIBERATELY EXCLUDED FROM THE MOVE, kept exactly as-is
 * (private, unmoved) on `AgentModeService`, found by reading the actual
 * source rather than trusting a boundary grep. (A second method,
 * `linkedinManagePost`, was ALSO excluded in the original cluster-16 pass —
 * see the "ENG-2103 (F2) FOLLOW-UP" note right after this list for why that
 * exclusion was later closed instead. Item 1 below, `resolveEmployersForSizeFilter`,
 * was ALSO later closed — see the "ENG-2103 (F2 design-decision-list
 * follow-up, Pattern A)" note further down this header for why and how.):
 *
 * 1. `resolveEmployersForSizeFilter` — a REAL, one-hop-removed
 *    `this.callLLM` coupling, the same shape as the video cluster's
 *    `generateImage` → `describeImage` → `callVisionLLMWithTimeout` →
 *    `callLLM` chain. It does not call `this.callLLM` directly; it calls the
 *    module-scope `batchParseCompaniesFromTitlesWithLLM(titles, this, userId)`
 *    (still in agentModeService.ts, ~line 27698, itself not a class member),
 *    passing the AgentModeService instance itself as the LLM gateway
 *    parameter, which then calls `gateway.callLLM(...)`. Confirmed by whole-
 *    cluster grep: this is the ONLY `this.callLLM`-adjacent call anywhere in
 *    the ~2,035-line cluster range. `resolveEmployersForSizeFilter` has
 *    exactly one caller anywhere in the backend — `linkedinOutreach`'s
 *    `search-people` action, only when a `company_size_min`/`company_size_max`
 *    filter is requested — confirmed by whole-backend grep. Since
 *    `linkedinOutreach` still needs to call it, and it must stay off this
 *    (LLM-free) module, it is injected as an explicit function parameter
 *    (`EmployerSizeFilterResolver`, defined below) — the same shape as cluster
 *    15's `AccountResolver` for `resolveAccessibleAccount`, but for an LLM
 *    exclusion instead of a privacy one. Supplied ONLY by
 *    `AgentModeService.prototype.linkedinOutreach`'s delegating wrapper via
 *    `this.resolveEmployersForSizeFilter.bind(this)`.
 *
 * ENG-2103 (F2) FOLLOW-UP: `linkedinManagePost` was originally kept entirely
 * on the class (not even a wrapper) for the reason above — its whole body is
 * a 5-way switch dispatching to sibling methods (`linkedinRepost`,
 * `commentOnLinkedInPost`, `listLinkedInComments`, `reactToLinkedInPost`,
 * `getPostAnalytics`), all called as `this.<method>(...)`, and
 * `agentModeService.socialTools.test.ts` has 5 tests
 * (`describe('linkedinManagePost')`, lines ~1017-1089) that
 * `jest.spyOn(service, '<eachSibling>')` and assert `linkedinManagePost`
 * calls the spied CLASS INSTANCE method with the right args. Calling the
 * module's own plain sibling functions (or a same-module self-import) would
 * route around those spies entirely, since neither is the object they spy on.
 *
 * This follow-up pass closes that gap the same way clusters 15/16/18/20/22
 * close an "external capability must stay class-instance-observable" case:
 * the dispatch body MOVES here as a real export, `linkedinManagePost`, and
 * the 5 siblings are supplied as injected function parameters
 * (`LinkedinManagePostDeps`, below) rather than called directly. Only
 * `AgentModeService.prototype.linkedinManagePost`'s own delegating wrapper —
 * being inside the class body — can legally supply
 * `this.<sibling>.bind(this)` for each one, so the 5 test spies (installed
 * on the class instance BEFORE `linkedinManagePost` runs) are still exactly
 * what executes: `this.<sibling>.bind(this)` is evaluated fresh on every
 * call, picking up whatever the prototype method currently is. This needed
 * zero changes to `agentModeService.socialTools.test.ts` — none of its
 * assertions reference this module at all, since they spy on the class
 * instance, which is unchanged. `getPostAnalytics` lives in cluster 15's
 * `emma/impl/socialAccounts.ts`, not this module; that's irrelevant here
 * since only a whole callable reference is injected, not its own internal
 * `AccountResolver` wiring. `emma/tools.ts`'s `linkedin_manage_post` tool
 * deliberately keeps calling `agentModeService.linkedinManagePost` — not a
 * repoint oversight, it needs this wrapper's class-bound references.
 *
 * Zero other hidden `this.callLLM`/`this.generateImage`/`this.describeImage`/
 * `this.callVisionLLMWithTimeout` coupling anywhere else in the cluster —
 * grepped the full ~2,035-line range (`awk 'NR==22612,NR==24646'`) for
 * `callLLM|generateImage|describeImage|callVisionLLMWithTimeout|, this,|
 * (this)|this)` and manually read every one of `linkedinOutreach`'s ~1,270
 * lines in 4 sections rather than trusting the grep alone, per the standing
 * lesson from clusters 14/15 that a bare `async methodName(...)` declaration
 * (true for most methods in this cluster) is invisible to a narrow
 * boundary-detection grep.
 *
 * `AgentModeService.prototype.<name>` now delegates to these functions
 * rather than duplicating them. Every moved method keeps a one-line
 * delegating wrapper on the class (none deleted outright), each with a real
 * caller beyond `emma/tools.ts`, found by grepping the whole backend:
 *   - `postOnConnectedAccount`: `routes/emmaApi.ts`'s `POST /social-post`
 *     handler, and many direct real-instance calls in
 *     `agentModeService.socialTools.test.ts`.
 *   - `linkedinRepost`: `AgentModeService.prototype.linkedinManagePost`
 *     (its own delegating wrapper now — see the F2 follow-up note above —
 *     supplies `this.linkedinRepost.bind(this)` as an injected dependency),
 *     plus direct real-instance test calls in `agentModeService.socialTools.test.ts`.
 *   - `commentOnLinkedInPost`: `routes/emmaApi.ts`'s `POST /linkedin-comment`
 *     handler, `AgentModeService.prototype.linkedinManagePost`, and direct
 *     real-instance test calls (`agentModeService.duplicateComment.test.ts`,
 *     `agentModeService.socialTools.test.ts`).
 *   - `resolveAccessibleAccount`: MUST stay a working delegating wrapper —
 *     cluster 15's `loadConnectedAccountPosts`/`loadConnectedAccountMetrics`/
 *     `getPostAnalytics` (in `emma/impl/socialAccounts.ts`) receive
 *     `this.resolveAccessibleAccount.bind(this)` from the class's own
 *     wrapper methods (~agentModeService.ts:23186-23240). Not touched by
 *     this cluster; verified those 3 wrapper methods are unchanged.
 *   - `listLinkedInComments`: `AgentModeService.prototype.linkedinManagePost`,
 *     plus direct real-instance test calls
 *     (`agentModeService.socialOrgShared.test.ts`).
 *   - `reactToLinkedInPost`: `routes/emmaApi.ts`'s `POST /linkedin-react`
 *     handler, `AgentModeService.prototype.linkedinManagePost`, and direct
 *     real-instance test calls (`agentModeService.socialTools.test.ts`,
 *     `agentModeService.socialOrgShared.test.ts`).
 *   - `linkedInDisconnectedResponse` / `linkedInSearchUnavailableResponse`:
 *     DELETED from the class outright (not kept as wrappers) — confirmed by
 *     whole-backend grep to have zero callers anywhere except
 *     `linkedinOutreach` itself (both call sites, twice each), which moves
 *     into this same module. No test spies on either directly (two test
 *     files reference their OUTPUT SHAPE in comments only, never call them).
 *   - `linkedinOutreach`: heavily used beyond `emma/tools.ts` —
 *     `routes/emmaApi.ts`'s `POST /linkedin-outreach` handler,
 *     `services/crmEnrichmentService.ts` (3 call sites), and a very large
 *     number of direct real-instance test calls across
 *     `agentModeService.linkedInOutreach.test.ts`,
 *     `agentModeService.linkedInOutreach.sharedAccount.test.ts`,
 *     `agentModeService.getProfile.connectionOverlay.test.ts`,
 *     `agentModeService.getProfile.forceRefresh.test.ts`.
 *
 * `LINKEDIN_SEARCH_UNAVAILABLE_GUIDANCE` is exported (not just moved) because
 * it has ONE other real caller outside this cluster:
 * `AgentModeService.prototype.importLeadsFromSearch` (cluster 6, already
 * excluded from extraction for the identical `this.callLLM`-via-
 * `batchParseCompaniesFromTitlesWithLLM` reason as this cluster's
 * `resolveEmployersForSizeFilter`) — confirmed by whole-file grep (only 2
 * usages besides the definition: `linkedInSearchUnavailableResponse` here,
 * and `importLeadsFromSearch` at agentModeService.ts ~line 25728).
 * agentModeService.ts now imports it back from here (`linkedinImpl.
 * LINKEDIN_SEARCH_UNAVAILABLE_GUIDANCE`) — the same "module owns the
 * constant, class imports it back" shape cluster 14 used for
 * `DRIVE_LIST_WALK_MAX_MS`. `linkedInPublicIdFromUrl` had exactly one caller
 * (inside `linkedinOutreach`'s `send-invite` action) and is deleted from
 * agentModeService.ts outright, kept here as a plain (non-exported)
 * module-scope helper.
 *
 * Transitive-import notes: `linkedInOutreachService`, the
 * `linkedInAnonymizedProfile` utils, `linkedInWritePacer`,
 * `agentMode/linkedInDailyVolumeGate`, `agentMode/linkedInAccountRouting`,
 * and `scheduledPublishConsentGuard` are all statically imported here,
 * matching exactly how agentModeService.ts already imported them (verified
 * none of the six imports back into agentModeService.ts anywhere — grepped
 * each file). `linkedInOutreachService.ts` statically imports `services/db.ts`
 * directly, and `agentMode/linkedInDailyVolumeGate.ts` /
 * `agentMode/linkedInAccountRouting.ts` statically import
 * `connectedAccountsDb.ts`, which also statically imports `services/db.ts` —
 * this is NOT a new circularity: `agentModeService.ts` already statically
 * imported all of these same modules before this extraction (so this exact
 * `db.ts` construction was already happening on every load of
 * `AgentModeService`), and `emma/impl/socialAccounts.ts` (cluster 15) already
 * established the identical `linkedInOutreachService → db.ts` transitive
 * load as pre-existing, not introduced by extraction. Every OTHER dynamic
 * (`await import(...)`) reference in the moved methods —
 * `connectedAccountsDb`, `socialPlatformService`, `db` (crmDb/userDb),
 * `chatbotService` (lazy per the established idiom), `voiceProfileHooks`,
 * `unipileProfileServiceFactory`, `unipileCompanyServiceFactory`,
 * `unipileSearchParamServiceFactory`, `unipileConnectionsDb`,
 * `unipileSentInvitationsDb`, `linkedInConnectionHealth`,
 * `linkedInInviteCrmMirror`, `linkedInIdentityCheck`, `crmAccessControl`,
 * `emailEventsDb`, `agentMode/linkedInSentInvitationsView`,
 * `agentMode/linkedInStaleInvitationDrain` — were all ALREADY lazily
 * `await import(...)`-ed at their call sites in the original code, kept
 * exactly as-is (verbatim) with only the relative path prefix adjusted from
 * `./x` (relative to `services/`) to `../../services/x` (relative to
 * `emma/impl/`). `chatbotService.ts`, `settingsService.ts`,
 * `orgProfileResolver.ts`, and `brandGuidelinesPopulation.ts` (the four
 * originally-named traps) are not statically referenced anywhere in this
 * cluster; `chatbotService.ts`'s one reference (`postOnConnectedAccount`'s
 * H-VOICE capture) was already a lazy dynamic import and stays that way.
 *
 * No stale-mock regressions found in the original cluster-16 pass. Every
 * `jest.spyOn`/direct-call test for the moved methods calls them on the real
 * `AgentModeService` instance, which still works because each keeps its
 * delegating wrapper. The F2 follow-up pass that moved `linkedinManagePost`
 * in (see above) needed zero test-file changes for the same reason — the 5
 * dispatch tests spy on the class instance's sibling methods, which stayed
 * exactly where they were.
 *
 * ENG-2103 (F2 design-decision-list follow-up, Pattern A):
 * `resolveEmployersForSizeFilter` (item 1 of the exclusion list above) moved
 * in. Its real coupling was always to `this.callLLM` via module-scope
 * `batchParseCompaniesFromTitlesWithLLM`, never to its own identity — once
 * that's supplied as an injected `callLLM` parameter (the same
 * `this.callLLM.bind(this)` shape as `createHtmlFromTemplate`), the function
 * has no remaining reason to stay off this module. It is now a
 * non-exported, module-scope function (matching `linkedInPublicIdFromUrl`'s
 * treatment above) — confirmed by whole-backend grep that nothing outside
 * this module ever called `AgentModeService.prototype.resolveEmployersForSizeFilter`
 * directly and no test spied on it. Since its only caller, `linkedinOutreach`,
 * now lives in the SAME module, the `EmployerSizeFilterResolver`
 * injected-function-parameter indirection this file used while the two
 * lived apart is now unnecessary and has been removed — `linkedinOutreach`
 * calls `resolveEmployersForSizeFilter` as a plain internal function call,
 * and instead takes `callLLM` as its own injected parameter (forwarded
 * through to `resolveEmployersForSizeFilter`). `parseCompanyFromTitle` and
 * `batchParseCompaniesFromTitlesWithLLM` themselves are imported from the
 * new `emma/impl/shared/companyTitleParsing.ts` (promoted there, not just
 * moved here, because `emma/impl/leads.ts`'s `importLeadsFromSearch` — moved
 * in the same round — needs them too, and the two land in different
 * modules). `withTimeoutOrReject` and the two
 * `EMPLOYER_PROFILE_LOOKUP_*` constants moved with the function:
 * `withTimeoutOrReject` itself is imported from the new
 * `emma/impl/shared/withTimeoutOrReject.ts` (promoted rather than moved
 * outright, since `AgentModeService.prototype.generateImage`'s
 * data-fabrication check is a second real caller that stays on the class
 * forever); the two constants are local to this module, unused elsewhere.
 *
 * `AgentModeService.prototype.linkedinOutreach`'s delegating wrapper now
 * supplies `this.callLLM.bind(this)` instead of the collapsed
 * `this.resolveEmployersForSizeFilter.bind(this)` injection. `callLLM` is
 * `public` on `AgentModeService`, so `emma/tools.ts`'s `linkedin_outreach`
 * tool is now repointed to call `linkedinOutreach` on this module directly
 * (`agentModeService.callLLM.bind(agentModeService)`) instead of going
 * through the class wrapper — the same treatment `create_html_from_template`
 * already established. `linkedin_manage_post` is UNCHANGED by this note —
 * it still calls `agentModeService.linkedinManagePost` for the unrelated
 * sibling-method-spy reason documented in the FOLLOW-UP section above.
 */
import { linkedInOutreachService, isProvenDisconnectError } from '../../services/linkedInOutreachService';
import {
  isAnonymizedIdentifier,
  usablePublicIdentifier,
  usableProfileUrl,
  withoutFabricatedProfileFields,
} from '../../utils/linkedInAnonymizedProfile';
import { PACED_WRITE_ACTIONS } from '../../services/linkedInWritePacer';
import {
  paceLinkedInWrite,
  resolveLinkedInAccountForWrite,
  resolveLinkedInAccountFromList,
  setDailyInviteCap,
  DailyInviteCapNotOwnerError,
  type ResolvedLinkedInAccount,
} from '../../services/agentMode/linkedInDailyVolumeGate';
import {
  routeLinkedInWriteToAccountWithHeadroom,
  withAccountRoutingDisclosure,
  type AccountRoutingDisclosure,
} from '../../services/agentMode/linkedInAccountRouting';
import { publishWithdrawnMidFlight } from '../../utils/scheduledPublishConsentGuard';
import { withTimeoutOrReject } from './shared/withTimeoutOrReject';
import { parseCompanyFromTitle, batchParseCompaniesFromTitlesWithLLM } from './shared/companyTitleParsing';
import type { AgentModeService } from '../../services/agentModeService';
// F2 fresh-eyes review round 1: `resolveAccessibleAccount` is called from two
// sibling functions in this same module (`listLinkedInComments`,
// `reactToLinkedInPost`). Per the cluster-10 lesson, a direct call to a
// sibling export doesn't route through the exports-namespace object, so an
// external `jest.spyOn(linkedinImpl, 'resolveAccessibleAccount')` would
// silently fail to intercept those two call sites. No test does this today,
// but every other module in this series (`misc.ts`/`adsApis.ts`/
// `mediaVideo.ts`/`htmlUpdate.ts`) uses this same-module self-import for
// exactly this reason — matching that convention here pre-empts the same
// stale-mock regression class this series has hit at least 5 times.
import * as self from './linkedin';

// Mirrors LinkedInOutreachService.PROFILE_LOOKUP_TIMEOUT_MS /
// COMPANY_SIZE_LOOKUP_CONCURRENCY (kept as separate local constants rather
// than importing that class here — this file already reaches the singleton
// via the top-level `linkedInOutreachService` import, and the class itself
// is only ever pulled in via dynamic import for a handful of static helpers).
const EMPLOYER_PROFILE_LOOKUP_TIMEOUT_MS = 30_000;
const EMPLOYER_PROFILE_LOOKUP_CONCURRENCY = 5;

/**
 * ENG-1558 follow-up: classic search-people results almost never carry
 * `work_experience` (confirmed live — every item across two production
 * test searches omitted it; see outreachProspectPreviewService's own
 * "search results often omit it" comment), so calling
 * filterByCompanySize directly on raw search items resolves an employer
 * for ~0% of candidates and excludes everyone as unverifiable regardless
 * of the requested bounds. importLeadsFromSearch already avoids this with
 * a 4-tier resolution chain (work_experience → title-regex → batched LLM
 * → Unipile getProfile) before its own company-size filter; this mirrors
 * that same chain for the single search-people call so the two paths
 * agree, and reshapes the result as `work_experience` since that's what
 * filterByCompanySize's employerOf() reads.
 *
 * Non-exported — its only caller, `linkedinOutreach`, lives in this same
 * module (see this module's own header comment for why the two are no
 * longer bridged by an injected-function-parameter indirection).
 */
async function resolveEmployersForSizeFilter(
  items: any[],
  accountId: string,
  userId: string,
  callLLM: Pick<AgentModeService, 'callLLM'>['callLLM'],
): Promise<Array<{ work_experience: Array<{ company: string; current: true }> }>> {
  const names: Array<string | null> = items.map((item: any) => {
    if (item?.work_experience?.length) {
      const current = item.work_experience.find((w: any) => w?.current) || item.work_experience[0];
      if (current?.company) return current.company;
    }
    return null;
  });

  items.forEach((item: any, i: number) => {
    if (!names[i] && typeof item?.headline === 'string') {
      const parsed = parseCompanyFromTitle(item.headline);
      if (parsed) names[i] = parsed;
    }
  });

  const llmIndices: number[] = [];
  const llmTitles: string[] = [];
  items.forEach((item: any, i: number) => {
    if (!names[i] && typeof item?.headline === 'string' && item.headline) {
      llmIndices.push(i);
      llmTitles.push(item.headline);
    }
  });
  if (llmTitles.length > 0) {
    try {
      const results = await batchParseCompaniesFromTitlesWithLLM(llmTitles, { callLLM }, userId);
      for (let k = 0; k < llmIndices.length; k++) {
        const v = results[k];
        if (v && v !== 'NONE') names[llmIndices[k]] = v;
      }
    } catch (e: any) {
      console.warn('[resolveEmployersForSizeFilter] LLM batch company-parse failed:', e?.message ?? String(e));
    }
  }

  // CodeRabbit: an unbounded Promise.all here would let one hung Unipile
  // request stall the whole interactive search-people turn — the same
  // failure mode filterByCompanySize already guards against with a timeout
  // + chunked concurrency. Mirror that here rather than reintroducing it.
  const lookupTargets = items
    .map((item: any, i: number) => ({ item, i }))
    .filter(({ item, i }) => !names[i] && item?.public_identifier && accountId);
  for (let start = 0; start < lookupTargets.length; start += EMPLOYER_PROFILE_LOOKUP_CONCURRENCY) {
    const batch = lookupTargets.slice(start, start + EMPLOYER_PROFILE_LOOKUP_CONCURRENCY);
    await Promise.all(batch.map(async ({ item, i }) => {
      try {
        const { getUnipileProfileService } = await import('../../services/unipileProfileServiceFactory');
        const profile = await withTimeoutOrReject(
          getUnipileProfileService().getProfile(item.public_identifier, accountId),
          EMPLOYER_PROFILE_LOOKUP_TIMEOUT_MS,
          `LinkedIn profile lookup for ${item.public_identifier}`,
        );
        const raw = (profile as any)?.rawData ?? profile;
        const exp = raw?.work_experience;
        if (Array.isArray(exp) && exp.length) {
          const cur = exp.find((w: any) => w?.current) || exp[0];
          if (cur?.company) names[i] = cur.company;
        }
      } catch (e: any) {
        console.warn('[resolveEmployersForSizeFilter] getProfile fallback failed:', e?.message ?? String(e));
      }
    }));
  }

  return names.map((name) => ({
    work_experience: name ? [{ company: name, current: true as const }] : [],
  }));
}

/**
 * ENG-975. Shared by every agent-facing surface that can hit a LinkedIn
 * people-search outage: the `search-people` and `search-parameters` actions and
 * the find-leads top-up loop. Wording matters as much as the detection — the
 * failure it describes is one an agent has already been observed to misread as
 * "no one matches", so it names the outage, rules out the two signals that
 * wrongly suggest health (a working get-profile, an HTTP 200), and forbids the
 * retry-with-another-variant loop that burned ten calls in the reported session.
 *
 * Exported (not just moved here) because `AgentModeService.prototype.
 * importLeadsFromSearch` (cluster 6, already excluded from extraction for the
 * identical this.callLLM-via-batchParseCompaniesFromTitlesWithLLM reason as
 * this cluster's resolveEmployersForSizeFilter) also reads it — see module
 * header comment.
 */
export const LINKEDIN_SEARCH_UNAVAILABLE_GUIDANCE = [
  'LinkedIn returned zero results for a maximally broad control query on this account, so the people-search endpoint is NOT working for it right now. This is not "no one matches your filters" — the search itself is unavailable.',
  '',
  'This is account-scoped and specific to search: profile lookups, connection lists and invitation lists on the same account keep working, so a successful get-profile does NOT mean search is healthy. As of 2026-08-10 the known cause is an open Unipile incident — LinkedIn is rolling out changes to Classic Search account by account, and an affected account returns zero results for every query until Unipile ships its adapted integration. The same symptom also appears when an account hits its commercial-use search limit or is temporarily restricted.',
  '',
  'DO NOT retry with different keywords, filters, or a search URL — every variant returns the same empty result and burns attempts. Stop searching now.',
  '',
  'Report to the user that LinkedIn search is currently unavailable for their account and that no prospects could be sourced this run — never report this as "no matching people were found". Their account is not broken and reconnecting it will not help, so do not tell them to reconnect. Do not promise a specific recovery time: say the outage is upstream at LinkedIn/Unipile and the run will resume sourcing once search returns for their account.',
].join('\n');

/**
 * ENG-182: extract a LinkedIn public identifier from a profile URL, e.g.
 * "https://www.linkedin.com/in/chang-liu?miniProfileUrn=..." -> "chang-liu".
 * Strips query string, fragment, trailing slash and casing so it matches the
 * public id the sent-invitation cache is keyed on. Returns null for anything
 * that isn't a /in/{id} profile URL (e.g. a raw provider_id).
 */
function linkedInPublicIdFromUrl(url: string | undefined | null): string | null {
  if (!url || typeof url !== 'string') return null;
  const match = url.trim().toLowerCase().match(/\/in\/([^/?#]+)/);
  return match ? match[1] : null;
}

// ENG-2663: an error that declares its own tool-error class (FreshTokenRejectedError) keeps it
// across the catch-and-return, so the dispatcher gives retry guidance instead of "auth".
function declaredErrorClass(error: any): { errorClass?: string } {
  return typeof error?.toolErrorClass === 'string' ? { errorClass: error.toolErrorClass } : {};
}

// Post on connected account helper
export async function postOnConnectedAccount(userId: string, accountId: string | undefined, content: string, mediaUrls: string[] = [], platform?: string, toolContext?: any, options?: { saveAsDraft?: boolean; inReplyToPostId?: string }): Promise<any> {
  console.log('[AgentMode] postOnConnectedAccount called:', {
    userId,
    accountId,
    platform,
    contentLength: content?.length || 0,
    mediaUrlCount: mediaUrls?.length || 0
  });

  try {
    const { getAccountsWithOwnerIncludingOrgShared, getAccountByIdConsistent, SOCIAL_POSTING_PLATFORMS } = await import('../../services/connectedAccountsDb');
    const { socialPlatformService } = await import('../../services/socialPlatformService');

    // Fetch all accessible accounts (own + org-shared) once, so org-shared accounts
    // are visible for both the auto-resolve path and explicit accountId lookups.
    // getAccountById(accountId, userId) only searches the caller's own DynamoDB record,
    // which returns null for accounts owned by an org member — use this instead.
    const allAccounts = await getAccountsWithOwnerIncludingOrgShared(userId);
    const socialAccounts = allAccounts.filter((a: any) =>
      (SOCIAL_POSTING_PLATFORMS as readonly string[]).includes(a.platform)
    );

    let account: any;

    if (!accountId) {
      // Narrow by platform hint when provided
      const candidates = platform
        ? socialAccounts.filter((a: any) => a.platform === platform)
        : socialAccounts;
      if (candidates.length === 0) {
        const msg = platform
          ? `No ${platform} account connected. Connect one in Settings → Connected Accounts.`
          : 'No social media accounts connected. Connect an account in Settings → Connected Accounts.';
        return { success: false, message: msg };
      }
      if (candidates.length > 1) {
        const names = candidates.map((a: any) => a.account_id).join(', ');
        const platformHint = platform ? `platform="${platform}"` : '';
        return { success: false, message: `Multiple ${platform ?? 'social'} accounts connected. Call list_connected_accounts(${platformHint}) to see account names, ask the user which one to use, then re-call with account_id. Connected IDs: ${names}` };
      }
      account = candidates[0];
      accountId = account.account_id;
      console.log('[AgentMode] Auto-resolved account_id:', accountId);
    } else {
      account = socialAccounts.find((a: any) => a.account_id === accountId);
    }

    console.log('[AgentMode] Account lookup result:', account ? {
      found: true,
      platform: account.platform,
      accountType: account.config?.account_type,
      accountName: account.account_name
    } : { found: false });

    if (!account) {
      console.log('[AgentMode] Account not found, returning error');
      return { success: false, message: 'Account not found or access denied' };
    }

    // account.userId is the token owner (equals userId for own accounts,
    // the org member's userId for org-shared accounts).
    const ownerUserId: string = (account as any).userId || userId;

    // A listing is not an authorization grant for an irreversible LinkedIn
    // write. Re-read the owner record immediately before posting so a
    // concurrent disconnect cannot leave this request with a usable token.
    if (account.platform === 'linkedin') {
      const currentAccount = await getAccountByIdConsistent(account.account_id, ownerUserId, 'linkedin');
      if (!currentAccount) {
        return { success: false, message: 'LinkedIn account is no longer connected' };
      }
      if (ownerUserId !== userId && currentAccount.sharedWithOrg !== true) {
        return { success: false, message: 'Account not found or access denied' };
      }
      account = currentAccount;
    }

    // The adapter handles token refresh internally before making API calls.
    console.log('[AgentMode] Getting adapter for platform:', account.platform);
    const adapter = socialPlatformService.getAdapter(account.platform);

    // ENG-827: LAST MOMENT before the post becomes real and un-makeable. Everything
    // above — resolving accounts across the org, and inside createPost the media
    // download and (for YouTube) the video upload — can take minutes, all of it on a
    // decision taken before that work began. Re-read the owner's consent here, so a
    // revocation that lands while this call is in flight still stops the post rather
    // than being noticed only after it is public. Absent hook (interactive session,
    // direct service call) → nothing changes.
    const withdrawnMidFlight = await toolContext?.assertPublishStillAuthorized?.();
    if (withdrawnMidFlight) {
      console.warn(`[AgentMode] ENG-827: abandoning post on ${account.platform} — publish consent was withdrawn while this call was in flight.`);
      return { success: false, message: withdrawnMidFlight.error };
    }

    console.log('[AgentMode] Calling adapter.createPost (adapter will handle token refresh if needed)...');
    // ENG-827 (Greptile): the check above is the last moment before ENTERING the
    // adapter, not before the post becomes real. LinkedIn uploads images and YouTube
    // downloads then uploads an entire video INSIDE createPost — minutes, on a
    // decision taken before that work began. Hand the same re-check down so those
    // adapters can run it immediately before their irreversible request; adapters
    // that commit straight away (X) need nothing and ignore it.
    // ENG-428: save-as-draft is a LinkedIn-only capability; refuse it elsewhere
    // rather than silently publishing what the caller asked to keep private.
    const saveAsDraft = options?.saveAsDraft === true;
    if (saveAsDraft && account.platform !== 'linkedin') {
      return { success: false, message: `save_as_draft is only supported for LinkedIn accounts, not ${account.platform}. Nothing was posted.` };
    }
    // ENG-976: replying to an existing post is an X-only capability here; refuse
    // elsewhere rather than publishing a standalone post the caller did not ask for.
    const inReplyToPostId = typeof options?.inReplyToPostId === 'string' && options.inReplyToPostId.trim()
      ? options.inReplyToPostId.trim() : undefined;
    if (inReplyToPostId && account.platform !== 'twitter') {
      return { success: false, message: `in_reply_to_post_id is only supported for X (Twitter) accounts, not ${account.platform}. Nothing was posted.` };
    }
    const result = inReplyToPostId
      ? await (adapter as any).createPost(
        account, content, mediaUrls, ownerUserId,
        toolContext?.assertPublishStillAuthorized, { inReplyToPostId }
      )
      : saveAsDraft
      ? await (adapter as any).createPost(
        account, content, mediaUrls, ownerUserId,
        toolContext?.assertPublishStillAuthorized, { draft: true }
      )
      : await adapter.createPost(
        account, content, mediaUrls, ownerUserId,
        toolContext?.assertPublishStillAuthorized
      );

    // An adapter that abandoned the post on a withdrawn consent reports it as a
    // refusal, not a platform failure — the run was stopped deliberately.
    if (result.success === false) {
      return { success: false, message: result.message };
    }

    // H-VOICE: when the UI passes the Emma draft alongside the approved text,
    // persist a session Voice Card observation (fail-open).
    try {
      const sessionId = toolContext?.sessionId as string | undefined;
      const draftContent = toolContext?.voiceCapture?.draft as string | undefined;
      if (sessionId && draftContent) {
        const { captureVoiceEditOnPublish } = await import('../../services/voiceProfileHooks');
        const { chatbotDb } = await import('../../services/chatbotService');
        const session = await chatbotDb.getChatSession(sessionId);
        await captureVoiceEditOnPublish({
          sessionId,
          platform: account.platform,
          draftContent,
          approvedContent: content,
          existingProfile: session?.sessionVoiceProfile,
        });
      }
    } catch (voiceCaptureErr) {
      console.warn('[AgentMode] H-VOICE capture skipped (non-fatal):', voiceCaptureErr);
    }

    return {
      success: true,
      message: result.message,
      post_id: result.postId,
      post_url: result.postUrl,
      ...(saveAsDraft ? { draft: true } : {})
    };
  } catch (error: any) {
    const message = error?.message?.includes('access token expired')
      ? 'Account token expired. Please reconnect the account in Settings.'
      : (error?.message ?? 'Unknown error');
    console.error('AgentMode: Error posting on account:', error);
    // ENG-1300: the LinkedIn adapter (and X's mapListScopeError) attach the
    // real HTTP status as .code on the thrown error — carry it through so a
    // 401/403 classifies as auth/config instead of the generic bug fallback.
    return { success: false, message: `Failed to post: ${message}`, code: error?.code, ...declaredErrorClass(error) };
  }
}

export async function linkedinRepost(userId: string, accountId: string, postUrn: string, commentary?: string, toolContext?: any): Promise<any> {
  console.log('[AgentMode] linkedinRepost called:', { userId, accountId, postUrn, hasCommentary: !!commentary });

  try {
    const { getAccountByIdConsistent } = await import('../../services/connectedAccountsDb');
    const { socialPlatformService } = await import('../../services/socialPlatformService');

    const account = await getAccountByIdConsistent(accountId, userId, 'linkedin');
    if (!account) {
      return { success: false, message: 'Account not found or access denied' };
    }

    if (account.platform !== 'linkedin') {
      return { success: false, message: 'Repost is currently only supported for LinkedIn accounts' };
    }

    const adapter = socialPlatformService.getAdapter(account.platform) as any;
    if (!adapter.createRepost) {
      return { success: false, message: 'Repost is not supported for this platform' };
    }

    // A prior lookup is only an eligibility check. Re-read immediately before
    // the provider write so a concurrent disconnect cannot leave a usable token
    // in memory for the remainder of this request.
    const currentAccount = await getAccountByIdConsistent(accountId, userId, 'linkedin');
    if (!currentAccount) {
      return { success: false, message: 'LinkedIn account is no longer connected' };
    }

    // ENG-827: last point before the repost is public — after the account re-read
    // above and with the adapter's token refresh still to come inside the call.
    // Consent is checked LAST so nothing but the write itself follows it.
    const withdrawnNow = await publishWithdrawnMidFlight(toolContext);
    if (withdrawnNow) return withdrawnNow;

    const result = await adapter.createRepost(
      currentAccount, postUrn, commentary, userId,
      toolContext?.assertPublishStillAuthorized
    );

    if (result.success === false) return { success: false, message: result.message };

    return {
      success: true,
      message: result.message,
      post_id: result.postId,
      post_url: result.postUrl
    };
  } catch (error: any) {
    let message = error.message;
    if (message.includes('access token expired')) {
      message = 'Account token expired. Please reconnect the account in Settings.';
    }
    return { success: false, message: `Failed to repost: ${message}`, code: error?.code, ...declaredErrorClass(error) };
  }
}

export async function commentOnLinkedInPost(userId: string, accountId: string, postUrn: string, commentText: string, parentCommentUrn?: string, toolContext?: any): Promise<any> {
  console.log('[AgentMode] commentOnLinkedInPost called:', {
    userId,
    accountId,
    postUrn,
    commentLength: commentText?.length || 0
  });

  try {
    const { getAccountByIdConsistent } = await import('../../services/connectedAccountsDb');
    const { socialPlatformService } = await import('../../services/socialPlatformService');

    try {
      console.log('[AgentMode] Looking up account:', accountId);
      const account = await getAccountByIdConsistent(accountId, userId, 'linkedin');
      console.log('[AgentMode] Account lookup result:', account ? {
        found: true,
        platform: account.platform,
        accountType: account.config?.account_type,
        accountName: account.account_name
      } : { found: false });

      if (!account) {
        console.log('[AgentMode] Account not found, returning error');
        return {
          success: false,
          message: 'Account not found or access denied'
        };
      }

      // Only LinkedIn is supported for commenting
      if (account.platform !== 'linkedin') {
        return {
          success: false,
          message: 'Commenting is currently only supported for LinkedIn accounts'
        };
      }

      // Guard: comment_text must not be empty — return a clear error so Emma retries with actual text
      if (!commentText || !commentText.trim()) {
        console.warn('[AgentMode] commentOnLinkedInPost rejected: comment_text is empty or missing');
        return {
          success: false,
          message: 'comment_text is required and must not be empty. Please provide the actual comment text you want to post, then call this tool again.'
        };
      }

      console.log('[AgentMode] Getting LinkedIn adapter');
      const adapter = socialPlatformService.getAdapter(account.platform);

      // Check if the adapter supports commenting
      if (!adapter.createComment) {
        return {
          success: false,
          message: 'Commenting is not supported for this platform'
        };
      }

      // Check for existing comment by this actor to prevent duplicates
      try {
        const existingComments = await (adapter as any).getComments(account, postUrn, userId);
        const alreadyCommented = existingComments.some((c: any) => c.actorUrn === account.account_id);
        if (alreadyCommented) {
          console.warn('[AgentMode] commentOnLinkedInPost: actor already has a comment on this post, skipping to prevent duplicate');
          return {
            success: true,
            message: 'Already commented on this post — skipping to avoid duplicate.',
            already_commented: true
          };
        }
      } catch (checkError: any) {
        // If the check fails, log and proceed — better to risk a duplicate than silently fail
        console.warn('[AgentMode] commentOnLinkedInPost: could not check existing comments, proceeding anyway:', checkError.message);
      }

      // The duplicate check above can be slow. Re-read the account immediately
      // before the irreversible write so disconnect wins over an in-flight run.
      const currentAccount = await getAccountByIdConsistent(accountId, userId, 'linkedin');
      if (!currentAccount) {
        return { success: false, message: 'LinkedIn account is no longer connected' };
      }

      // ENG-827 (Greptile): the duplicate-comment lookup and the account re-read above
      // are both network calls, and the adapter refreshes the token inside
      // createComment. Re-check consent here, the last point before the comment is
      // public under the owner's name.
      const withdrawnNow = await publishWithdrawnMidFlight(toolContext);
      if (withdrawnNow) return withdrawnNow;

      console.log('[AgentMode] Calling adapter.createComment (adapter will handle token refresh if needed)...');
      const result = await adapter.createComment(
        currentAccount, postUrn, commentText, userId, parentCommentUrn,
        toolContext?.assertPublishStillAuthorized
      );

      if (result.success === false) return { success: false, message: result.message };

      return {
        success: true,
        message: result.message,
        comment_id: result.postId,
        post_url: result.postUrl
      };
    } catch (error: any) {
      // Handle specific error messages — pass through detailed permission errors as-is
      let message = error.message;
      if (message.includes('access token expired') && !message.includes('Permission denied')) {
        message = 'Account token expired. Please reconnect the account in Settings → Connected Accounts.';
      }

      return {
        success: false,
        message: `Failed to comment: ${message}`,
        code: error?.code,
        ...declaredErrorClass(error)
      };
    }

  } catch (error) {
    console.error('AgentMode: Error commenting on post:', error);
    return {
      success: false,
      message: 'Failed to create comment',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Resolve a connected account the caller can actually reach — their own, or one a
 * teammate explicitly shared with the org — together with the id of the member who
 * OWNS it.
 *
 * list_connected_accounts reports that own+org-shared set, so resolving against the
 * caller's own record alone made a listed account come back "not found or access
 * denied" from the very tools the list points at (ENG-943, first found on the mail
 * tools). The owner id is load-bearing downstream too: adapters persist a refreshed
 * token with updateAccountTokens(userId, …), so passing the caller would write a
 * teammate's rotated token onto the caller's record and leave the owner's stale.
 *
 * Read paths only. An irreversible write additionally re-reads the owner record at
 * the last moment to catch a mid-flight disconnect — see postOnConnectedAccount.
 */
export async function resolveAccessibleAccount(
  callerUserId: string,
  accountId: string,
  preferPlatform?: string
): Promise<{ account: any; ownerUserId: string } | null> {
  const { getAccountsWithOwnerIncludingOrgShared } = await import('../../services/connectedAccountsDb');
  const accounts = (await getAccountsWithOwnerIncludingOrgShared(callerUserId)) || [];
  const sameId = accounts.filter((a: any) => a.account_id === accountId);
  // account_id alone does not identify an account — the same id can sit on two
  // platforms (one Google account connected for Gmail and Drive is the common
  // case). A platform-specific caller must not be handed some other platform's
  // row just because it matched the id first; the mail resolver disambiguates
  // the same way.
  const account = (preferPlatform && sameId.find((a: any) => a.platform === preferPlatform)) || sameId[0];
  if (!account) return null;
  return { account, ownerUserId: (account as any).userId || callerUserId };
}

export async function listLinkedInComments(userId: string, accountId: string, postUrn: string): Promise<any> {
  console.log('[AgentMode] listLinkedInComments called:', { userId, accountId, postUrn });

  try {
    const { socialPlatformService } = await import('../../services/socialPlatformService');

    const resolved = await self.resolveAccessibleAccount(userId, accountId, 'linkedin');
    if (!resolved) {
      return { success: false, message: 'Account not found or access denied' };
    }
    const { account, ownerUserId } = resolved;

    if (account.platform !== 'linkedin') {
      return { success: false, message: 'Listing comments is currently only supported for LinkedIn accounts' };
    }

    const adapter = socialPlatformService.getAdapter(account.platform) as any;
    if (!adapter.getComments) {
      return { success: false, message: 'Listing comments is not supported for this platform' };
    }

    const comments = await adapter.getComments(account, postUrn, ownerUserId);

    return {
      success: true,
      message: `Found ${comments.length} comment(s) on this post`,
      comments: comments.map((c: any) => ({
        comment_urn: c.commentUrn,
        actor_urn: c.actorUrn,
        text: c.text,
        created_at: c.createdAt ? new Date(c.createdAt).toISOString() : null
      }))
    };
  } catch (error: any) {
    // Coerce before matching: the account lookup can now throw (the old
    // getAccountById swallowed its DynamoDB errors and returned null), and a
    // thrown non-Error would make .includes blow up inside this catch.
    let message = error?.message || String(error);
    if (message.includes('access token expired')) {
      message = 'Account token expired. Please reconnect the account in Settings.';
    }
    return {
      success: false,
      message: `Failed to list comments: ${message}`,
      code: error?.code
    };
  }
}

export async function reactToLinkedInPost(userId: string, accountId: string, postUrn: string, reactionType: string = 'LIKE'): Promise<any> {
  console.log('[AgentMode] reactToLinkedInPost called:', {
    userId,
    accountId,
    postUrn,
    reactionType
  });

  try {
    const { getAccountByIdConsistent } = await import('../../services/connectedAccountsDb');
    const { socialPlatformService } = await import('../../services/socialPlatformService');

    try {
      console.log('[AgentMode] Looking up account:', accountId);
      const resolved = await self.resolveAccessibleAccount(userId, accountId, 'linkedin');
      console.log('[AgentMode] Account lookup result:', resolved ? {
        found: true,
        platform: resolved.account.platform,
        accountType: resolved.account.config?.account_type,
        accountName: resolved.account.account_name
      } : { found: false });

      if (!resolved) {
        console.log('[AgentMode] Account not found, returning error');
        return {
          success: false,
          message: 'Account not found or access denied'
        };
      }
      const { account, ownerUserId } = resolved;

      // Only LinkedIn is supported for reactions
      if (account.platform !== 'linkedin') {
        return {
          success: false,
          message: 'Reactions are currently only supported for LinkedIn accounts'
        };
      }

      console.log('[AgentMode] Getting LinkedIn adapter');
      const adapter = socialPlatformService.getAdapter(account.platform);

      // Check if the adapter supports reactions
      if (!adapter.createReaction) {
        return {
          success: false,
          message: 'Reactions are not supported for this platform'
        };
      }

      // A listing is not a standing grant for a write: re-read the OWNER's record
      // immediately before reacting so a disconnect — or an un-share — that lands
      // while this call is in flight still stops it (mirrors postOnConnectedAccount).
      const currentAccount = await getAccountByIdConsistent(accountId, ownerUserId, 'linkedin');
      if (!currentAccount) {
        return { success: false, message: 'LinkedIn account is no longer connected' };
      }
      if (ownerUserId !== userId && currentAccount.sharedWithOrg !== true) {
        return { success: false, message: 'Account not found or access denied' };
      }

      console.log('[AgentMode] Calling adapter.createReaction (adapter will handle token refresh if needed)...');
      const result = await adapter.createReaction(currentAccount, postUrn, reactionType, ownerUserId);

      return {
        success: true,
        message: result.message,
        reaction_id: result.postId,
        post_url: result.postUrl
      };
    } catch (error: any) {
      // Handle specific error messages — pass through detailed permission errors as-is
      let message = error.message;
      if (message.includes('access token expired') && !message.includes('Permission denied')) {
        message = 'Account token expired. Please reconnect the account in Settings → Connected Accounts.';
      }

      return {
        success: false,
        message: `Failed to react: ${message}`,
        code: error?.code,
        ...declaredErrorClass(error)
      };
    }

  } catch (error) {
    console.error('AgentMode: Error reacting to post:', error);
    return {
      success: false,
      message: 'Failed to create reaction',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Sibling methods `linkedinManagePost` dispatches to, injected so the class's
 * own delegating wrapper can supply `this.<sibling>.bind(this)` for each one
 * — see the "ENG-2103 (F2) FOLLOW-UP" note in this module's header for why
 * this must stay class-instance-observable rather than calling these
 * directly (4 live in this module, `getPostAnalytics` lives in cluster 15's
 * `emma/impl/socialAccounts.ts`).
 */
export type LinkedinManagePostDeps = {
  linkedinRepost: (userId: string, accountId: string, postUrn: string, commentary?: string, toolContext?: any) => Promise<any>;
  commentOnLinkedInPost: (userId: string, accountId: string, postUrn: string, commentText: string, parentCommentUrn?: string, toolContext?: any) => Promise<any>;
  listLinkedInComments: (userId: string, accountId: string, postUrn: string) => Promise<any>;
  reactToLinkedInPost: (userId: string, accountId: string, postUrn: string, reactionType?: string) => Promise<any>;
  getPostAnalytics: (userId: string, accountId: string, postIds: string[]) => Promise<any>;
};

/**
 * Unified LinkedIn post management handler.
 * Dispatches to the appropriate operation based on `action`.
 *
 * ENG-2103 (F2 follow-up): moved verbatim from
 * `AgentModeService.prototype.linkedinManagePost` — see this module's header
 * for why it was originally excluded and how the `deps` parameter closes
 * that gap.
 */
export async function linkedinManagePost(
  userId: string,
  args: {
    action: 'repost' | 'comment' | 'list_comments' | 'react' | 'get_analytics';
    account_id: string;
    post_urn?: string;
    commentary?: string;
    comment_text?: string;
    parent_comment_urn?: string;
    reaction_type?: string;
    post_ids?: string[];
  },
  toolContext: any,
  deps: LinkedinManagePostDeps,
): Promise<any> {
  const { action, account_id } = args;
  console.log('[AgentMode] linkedinManagePost called:', { userId, action, account_id });

  // ENG-827: last-moment publish-consent re-check. A repost or comment is a public
  // write under the owner's name, so a consent withdrawn after dispatch admitted
  // this call must still stop it. Self-scoping: the dispatcher attaches the hook
  // only for a call it classified as publishing, so an analytics or comment-list
  // read reaches this line with nothing to run.
  const withdrawn = await publishWithdrawnMidFlight(toolContext);
  if (withdrawn) return withdrawn;

  const requirePostUrn = (a: string) =>
    !args.post_urn ? { success: false, message: `post_urn is required for action=${a}` } : null;
  const requirePostIds = () =>
    !args.post_ids?.length ? { success: false, message: 'post_ids is required for action=get_analytics' } : null;
  const requireCommentText = () =>
    !args.comment_text ? { success: false, message: 'comment_text is required for action=comment' } : null;

  switch (action) {
    // ENG-827 (Greptile): the check above still leaves an account lookup and a token
    // refresh in front of the write, so the hook is handed down and re-run
    // immediately before the irreversible call. Reads below get nothing to run.
    case 'repost':
      return requirePostUrn('repost') ?? deps.linkedinRepost(userId, account_id, args.post_urn!, args.commentary, toolContext);
    case 'comment':
      return requirePostUrn('comment') ?? requireCommentText() ?? deps.commentOnLinkedInPost(userId, account_id, args.post_urn!, args.comment_text!, args.parent_comment_urn, toolContext);
    case 'list_comments':
      return requirePostUrn('list_comments') ?? deps.listLinkedInComments(userId, account_id, args.post_urn!);
    case 'react':
      return requirePostUrn('react') ?? deps.reactToLinkedInPost(userId, account_id, args.post_urn!, args.reaction_type || 'LIKE');
    case 'get_analytics':
      return requirePostIds() ?? deps.getPostAnalytics(userId, account_id, args.post_ids!);
    default:
      return { success: false, message: `Unknown action: ${action}` };
  }
}

/**
 * Perform LinkedIn outreach actions using Unipile API.
 * URL-vs-provider_id resolution is handled inside LinkedInOutreachService.
 */
/**
 * The single definition of "this LinkedIn account is dead, here is how to fix it".
 * Returned both by the preflight below and by the reactive 401 handler, so the two
 * paths can never drift into telling the user two different stories (ENG-281).
 */
function linkedInDisconnectedResponse() {
  return {
    success: false,
    message: 'LinkedIn account disconnected',
    error: [
      'The LinkedIn account is disconnected from Unipile and cannot be used for outreach.',
      '',
      'Common reasons a connected account becomes disconnected:',
      '1. LinkedIn detected automation activity and revoked the session',
      '2. You logged into LinkedIn from another browser or device, invalidating the session held by Unipile',
      '3. The LinkedIn session cookie expired (typically every 30–90 days)',
      '4. Unipile lost the session internally and requires a manual reconnect',
      '',
      'Next steps:',
      '1. Go to Settings > Connected Accounts and click Reconnect on your LinkedIn account.',
      '2. If reconnect does not work, remove the connection entirely and add it again as a new connection.',
    ].join('\n')
  };
}

/**
 * ENG-975. A LinkedIn people search that returns zero because the ACCOUNT has
 * lost its search capability is indistinguishable from one that returns zero
 * because nobody matches — Unipile relays both as HTTP 200 with `items: []`
 * and `paging.total_count: 0`. Once `probeSearchCapability` has proven it is
 * the former, say so in the terms the agent needs: this is an outage, more
 * query variants will not help, and reporting "no matches" would be a lie.
 */
function linkedInSearchUnavailableResponse() {
  return {
    success: false,
    message: 'LinkedIn people search is unavailable',
    error: LINKEDIN_SEARCH_UNAVAILABLE_GUIDANCE,
    searchUnavailable: true,
  };
}

/**
 * ENG-2984: shadow-only duplicate check for send-message WITHOUT list_id/lead_id (the CRM-linked
 * path already blocks identical re-sends). Reads the chat the send just went to — no new storage,
 * no extra profile lookup — and logs a would-block warning if an identical outbound message was
 * already in that history. Never throws and never changes the send's outcome.
 * Returns whether a would-block was logged (for tests).
 */
export async function shadowCheckUnlinkedLinkedInDuplicate(params: {
  chatId: string | undefined;
  sentMessageId: string | undefined;
  message: string;
  accountId: string;
  target: string;
}): Promise<boolean> {
  try {
    if (!params.chatId) return false;
    const normalized = params.message.trim().toLowerCase();
    const outbound = await linkedInOutreachService.getOutboundMessagesInChat(params.chatId);
    const identical = outbound.filter((m) => (m.text ?? '').trim().toLowerCase() === normalized);
    // Exclude the message we just sent; without its id, require it plus one earlier copy.
    const prior = params.sentMessageId
      ? identical.filter((m) => m.id !== params.sentMessageId && m.provider_id !== params.sentMessageId)
      : identical.slice(1);
    if (prior.length === 0) return false;
    console.warn(
      `[AgentMode] send-message SHADOW would-block (ENG-2984): identical message already sent to ${params.target} ` +
      `from account ${params.accountId} (chat ${params.chatId}, ${prior.length} prior copy/copies, first at ${prior[0].timestamp ?? 'unknown'}) — not blocked, shadow mode`,
    );
    return true;
  } catch (err) {
    console.warn('[AgentMode] send-message shadow duplicate check failed (ENG-2984, ignored):', err instanceof Error ? err.message : err);
    return false;
  }
}

export async function linkedinOutreach(
  callLLM: Pick<AgentModeService, 'callLLM'>['callLLM'],
  userId: string,
  args: any,
): Promise<any> {
  let { account_id } = args;
  const action = (args.action as string)?.replace(/_/g, '-');
  const { profile_url, provider_id, message, on_note_quota } = args;
  console.log(`[AgentMode] linkedinOutreach called: action=${action}, account_id=${account_id}`);

  // Write actions must use an account that is either owned by the calling user or
  // explicitly shared with the org (sharedWithOrg: true). This prevents an LLM from
  // reusing a shared enrichment account_id from a prior get-profile call.
  // Same set the pacer uses, deliberately not a second hand-maintained copy: a
  // sixth write action added to one list and not the other would be either
  // silently unpaced or silently unauthorized.
  //
  // Also resolves the account's owner + daily-cap config here (via
  // resolveLinkedInAccountForWrite — services/agentMode/linkedInDailyVolumeGate.ts),
  // from the same lookup this authorization check already needs, avoiding a
  // second DB read. The daily cap is self-reported (set directly by the user
  // in Settings, or by Emma via the set-daily-invite-cap action after asking
  // about Premium status), never auto-detected — see linkedInWritePacer.ts's
  // module doc comment for why. Unset defaults to the conservative free-tier
  // number, never to the Premium max. The resolved owner may differ from the
  // calling user for an org-shared account — writes below go through the
  // owner's record, not the caller's.
  // set-daily-invite-cap shares this same ownership check (a config write on
  // the account still needs to be the caller's own/shared account) but is
  // deliberately NOT in PACED_WRITE_ACTIONS — it doesn't touch LinkedIn at
  // all, so none of the burst/hourly/daily send-pacing below applies to it.
  // ENG-1719: withdraw-stale-invitations shares the ownership check for the same
  // reason set-daily-invite-cap does — it writes to the account, so it must be the
  // caller's own or org-shared one. It is deliberately NOT in PACED_WRITE_ACTIONS:
  // the umbrella call itself performs no LinkedIn write, and pacing it here would
  // consume a slot on top of the one each individual withdrawal already reserves
  // inside the drain.
  let resolvedLinkedInAccount: ResolvedLinkedInAccount | null = null;
  // Fetched once here (only for the PACED_WRITE_ACTIONS branch, which is the
  // only one that can also route below) and reused for the routing scan
  // instead of making it repeat the same org-member fetch a second time.
  let linkedInAccountsForRouting: any[] | undefined;
  if (
    PACED_WRITE_ACTIONS.has(action)
    || action === 'set-daily-invite-cap'
    || action === 'withdraw-stale-invitations'
  ) {
    if (PACED_WRITE_ACTIONS.has(action)) {
      const { getAccountsWithOwnerIncludingOrgShared } = await import('../../services/connectedAccountsDb');
      linkedInAccountsForRouting = await getAccountsWithOwnerIncludingOrgShared(userId);
      resolvedLinkedInAccount = resolveLinkedInAccountFromList(linkedInAccountsForRouting, account_id);
    } else {
      resolvedLinkedInAccount = await resolveLinkedInAccountForWrite(userId, account_id);
    }
    if (!resolvedLinkedInAccount) {
      return { success: false, error: `Account ${account_id} is not connected to your profile. Connect a LinkedIn Outreach account in Settings to use this action.` };
    }
  }

  // ENG-1132/ENG-1614: the requested account may be at its own daily
  // invite/message cap while another account the org has connected and
  // explicitly shared has headroom to spare. Route the WHOLE write there
  // instead of failing — this only decides which account gets checked
  // against the existing pacer/cap below; it never loosens either.
  // No-op for accept/cancel-invitation (not volume-classed) and for a
  // single-account customer (no alternate exists): today's behavior is
  // unchanged in both cases.
  let accountRouting: AccountRoutingDisclosure | null = null;
  if (PACED_WRITE_ACTIONS.has(action) && resolvedLinkedInAccount) {
    const routed = await routeLinkedInWriteToAccountWithHeadroom(
      userId, action, account_id, resolvedLinkedInAccount, linkedInAccountsForRouting,
    );
    if (routed) {
      console.log(`[AgentMode] linkedinOutreach: ${routed.reason}`);
      accountRouting = { fromAccountId: account_id, toAccountId: routed.accountId, reason: routed.reason };
      account_id = routed.accountId;
      resolvedLinkedInAccount = routed.account;
    }
  }
  const withRouting = (data: any) => withAccountRoutingDisclosure(accountRouting, data);

  // For read-only actions (get-profile, search-people, get-company), fall back to
  // site-wide Unipile accounts when the user has no personally-connected account.
  // Write actions (send-invite, send-message, etc.) are excluded from this fallback —
  // they already block non-owned accounts above.
  //
  // ENG-1198: a shared/site-wide account's network is NOT the user's — its
  // network_distance and "already connected/pending" signals are computed
  // relative to a stranger's account. `usedSharedAccount` (+ `sharedAccountId`)
  // is threaded into every read-action response below so callers can caveat
  // or refuse degree-based logic instead of silently trusting it.
  const READ_ACTIONS_WITH_FALLBACK = ['get-profile', 'search-people', 'get-company', 'search-parameters', 'list-post-engagers'];
  // ENG-2739: validate post_id before account resolution/session preflight so a
  // missing post id is reported as such, not as a disconnected account, and no
  // Unipile call is spent on it.
  if (action === 'list-post-engagers' && !(typeof args.post_id === 'string' && args.post_id.trim())) {
    return {
      success: false,
      error: 'post_id is required for list-post-engagers (a LinkedIn post URL, urn:li:activity:… URN, or Unipile social id)',
    };
  }
  let usedSharedAccount = false;
  if (READ_ACTIONS_WITH_FALLBACK.includes(action)) {
    if (!account_id) {
      const resolved = await linkedInOutreachService.resolveAccountIdWithSource(userId);
      account_id = resolved.accountId;
      usedSharedAccount = resolved.usedSharedAccount;
    } else {
      // ENG-1198: an explicit account_id isn't necessarily the user's own —
      // it may be a `sharedAccountId` this same endpoint disclosed on a prior
      // call and the caller echoed back. Check ownership instead of assuming
      // false whenever the caller supplied an id, so the flag stays accurate.
      const ownAccountIds = await linkedInOutreachService.listUserOwnedUnipileAccountIds(userId);
      usedSharedAccount = !ownAccountIds.includes(account_id);
    }
    if (account_id) {
      console.log(`[AgentMode] linkedinOutreach: using ${usedSharedAccount ? 'site-wide' : 'own'} account for ${action}`);
    }
  }
  const withAccountMeta = (data: any) => (
    data && typeof data === 'object'
      ? { ...data, usedSharedAccount, ...(usedSharedAccount ? { sharedAccountId: account_id } : {}) }
      : data
  );

  // Guard: if no account_id is available at this point, return a clear error
  // instead of forwarding a null account_id to Unipile (which returns a
  // misleading "Profile not found" instead of an auth/config error).
  if (!account_id) {
    return {
      success: false,
      error: 'No LinkedIn account is connected. To use LinkedIn Outreach, please connect your LinkedIn account in Settings → Connected Accounts.',
    };
  }

  // Preflight the session before spending a call on it (ENG-281). A Unipile
  // LinkedIn session can die while the connection record still exists, and every
  // action on that account then fails with the same 401 — but only AFTER a full
  // round-trip. A scheduled run repeats that per recipient, burning attempts and
  // reporting a late, opaque failure instead of a reconnect prompt.
  //
  // resolveAccountId already filters on this exact probe, so the fallback path was
  // covered; an explicitly-passed account_id — the normal path after
  // list_connected_accounts, which itself reports is_active from the same source —
  // was not. isAccountConnected is 10-minute cached and timeout-bounded, so a live
  // account pays at most one probe per account per 10 minutes, and a dead account
  // now costs nothing at all.
  // Block ONLY on a proven-dead session. An indeterminate probe (timeout, 5xx,
  // network) says nothing about session validity, and blocking on it would
  // suppress a healthy account behind a false reconnect prompt for the probe's
  // full 10-minute cache window — a worse failure than the late 401 this
  // preflight exists to avoid. On 'unknown' we fall through to the real call and
  // let the reactive 401 handler below stay the backstop, i.e. exactly today's
  // behaviour.
  const sessionState = await linkedInOutreachService.probeAccountSession(account_id);
  if (sessionState === 'disconnected') {
    console.log(`[AgentMode] linkedinOutreach: account ${account_id} failed preflight — disconnected Unipile session`);
    // Persist alongside the reactive handler below, so the owner alert doesn't
    // depend on which of the two paths happened to observe the dead session first
    // (ENG-1197).
    const { recordUnipileAccountHealth } = await import('../../services/linkedInConnectionHealth');
    // ENG-2205: ownerUserId must be omitted for a site-wide pool account — its
    // owner lookup can never resolve the global fallback pool under an
    // unrelated caller's userId, so a truthy-but-wrong value here silently
    // no-ops instead of reaching the dedicated ownerless/oncall alert branch.
    await recordUnipileAccountHealth({
      accountId: account_id,
      ownerUserId: usedSharedAccount ? undefined : userId,
      state: 'disconnected',
    });
    return withRouting(linkedInDisconnectedResponse());
  }
  if (sessionState === 'unknown') {
    console.log(`[AgentMode] linkedinOutreach: account ${account_id} preflight indeterminate — proceeding, reactive handler remains the backstop`);
  }

  // ENG-1197: pace write actions so a drain cannot burst the session to death.
  //
  // Twice this schedule fired ten cancel-invitation calls in one parallel batch
  // and LinkedIn revoked the account's session ~17 seconds later, locking the
  // customer out for days. The model emits parallel tool calls because that is the
  // efficient shape of the work, and an unattended run has nobody to notice it
  // ignoring an instruction not to — so the spacing has to be structural, not
  // prompted. Reads are untouched; only actions that mutate LinkedIn state queue.
  // Deliberately NOT taken here, up front, for the whole action. Several paced
  // actions return before they ever reach Unipile — send-invite skips a profile
  // whose invite is already pending or whose identity fails the ENG-1026 check,
  // send-message skips a stale-sync or duplicate-text send. Reserving at the top
  // would spend a slot (and sleep the caller a full gap) on those no-ops, so a
  // batch of already-invited leads would both crawl and eat the hourly ceiling
  // that the genuinely-new invites later in the same run need. Each case below
  // therefore calls this immediately before its own Unipile write.
  // Daily-volume + hourly/burst pacing lives in
  // services/agentMode/linkedInDailyVolumeGate.ts — see that module's doc
  // comment for the ownership and check-ordering fixes it encodes.
  const paceWrite = async (): Promise<{ refusal: any } | null> => {
    if (!PACED_WRITE_ACTIONS.has(action)) return null;
    const result = await paceLinkedInWrite(action, resolvedLinkedInAccount!, account_id);
    return result.refusal ? { refusal: withRouting(result.refusal) } : null;
  };

  // The service accepts either a LinkedIn URL or a raw provider_id.
  // We know which one it is based on which arg was provided.
  const isUrl = !!profile_url;
  const target = profile_url || provider_id;

  try {
    switch (action) {
      case 'search-people': {
        const {
          keywords, search_url, title, company, cursor,
          company_id, location, location_id,
          industry, industry_id, school, school_id,
          company_size_min, company_size_max,
        } = args;
        // Unipile classic search needs at least one of keywords/search_url/cursor.
        // The downstream linkedInOutreachService.searchPeople synthesizes keywords
        // from any of these structured filters when keywords is omitted, so we
        // accept the call as long as the caller gave us SOMETHING to search by.
        const hasFilter = !!(title || company || company_id
          || location || location_id || industry || industry_id || school || school_id);
        if (!keywords && !search_url && !cursor && !hasFilter) {
          throw new Error('Provide at least one of: keywords, search_url, cursor, or a structured filter (title, company, location, industry, school)');
        }
        const searchResult = await linkedInOutreachService.searchPeople(account_id, {
          keywords, url: search_url, title, company, cursor,
          company_id, location, location_id,
          industry, industry_id, school, school_id,
        });
        // ENG-975: an empty FIRST page is ambiguous — it means either "nobody
        // matches" or "this account can no longer search". Only a broad control
        // query can tell those apart, so run one before reporting an empty
        // result the agent would otherwise pass on to the user as fact. A
        // cursor'd continuation is skipped: running out of pages is exhaustion,
        // not an outage.
        if (Array.isArray(searchResult?.items) && searchResult.items.length === 0 && !cursor) {
          if (await linkedInOutreachService.probeSearchCapability(account_id) === 'degraded') {
            console.log(`[AgentMode] linkedinOutreach: search-people returned 0 and the control query also returned 0 — account ${account_id} cannot search`);
            return linkedInSearchUnavailableResponse();
          }
        }
        // Trim to essential fields only — full profiles (skills, education, photos, etc.)
        // inflate context by 10x and degrade LLM output quality in long sessions.
        if (Array.isArray(searchResult?.items)) {
          // ENG-1198: LinkedIn anonymizes out-of-network/restricted results with
          // public_identifier literally the string 'undefined' — passing those
          // through yields unusable fake profile URLs like /in/undefined.
          const usableItems = searchResult.items.filter((item: any) => !isAnonymizedIdentifier(item.public_identifier));
          // How many the filter removed. ENG-1198 dropped them silently, which
          // turned "every match was out-of-network" into an empty list
          // indistinguishable from "nobody matches" — and from the ENG-975
          // account-cannot-search outage. The ENG-975 canary deliberately does not
          // cover this case: it only fires when the RAW page was empty, and here
          // the account searched fine and returned rows we then discarded. So the
          // count has to be reported, or the agent is left guessing which of three
          // very different situations it is in.
          const anonymizedFiltered = searchResult.items.length - usableItems.length;
          // ENG-1558: Unipile has no native headcount filter for people search
          // (only for its Companies category), so a company-size ask is applied
          // as a post-filter here — resolve each candidate's current employer
          // and drop those outside the requested range (or unverifiable). No-op
          // (zero extra Unipile/LLM calls) when the caller didn't ask for it.
          //
          // Classic search-people items almost never carry `work_experience`
          // (confirmed live, ENG-1558 follow-up), so the employer has to be
          // resolved first via the same tiered chain importLeadsFromSearch
          // uses — otherwise every candidate reads as unverifiable and the
          // filter excludes 100% of results regardless of the bounds asked for.
          const wantsSizeFilter = company_size_min != null || company_size_max != null;
          let sizeFilterInput = usableItems;
          if (wantsSizeFilter) {
            const resolved = await resolveEmployersForSizeFilter(usableItems, account_id, userId, callLLM);
            // CodeRabbit: only fill in the synthetic work_experience when the
            // item didn't already carry a usable one — otherwise this
            // overwrites a real Tier-1 work_experience (with `position`, etc.)
            // with the resolver's bare { company, current } shape, silently
            // dropping fields for the rare item that already had them. The
            // "usable" check has to match the current/first-entry semantics
            // resolveEmployersForSizeFilter's Tier 1 and filterByCompanySize's
            // employerOf() both use — a bare .some() across every entry can
            // keep an item whose CURRENT entry has no company, discarding a
            // real resolved value and later reading as unverifiable anyway.
            const hasCurrentCompany = (item: any): boolean => {
              const exp = Array.isArray(item?.work_experience) ? item.work_experience : [];
              const current = exp.find((w: any) => w?.current) || exp[0];
              return !!current?.company;
            };
            sizeFilterInput = usableItems.map((item: any, i: number) => (
              hasCurrentCompany(item) ? item : { ...item, ...resolved[i] }
            ));
          }
          const { items: sizedItems, excludedUnverifiable: companySizeFiltered } =
            await linkedInOutreachService.filterByCompanySize(
              sizeFilterInput,
              { min: company_size_min, max: company_size_max },
              account_id,
            );
          const trimmedItems = sizedItems.map((item: any) => {
            const trimmed: any = {
              provider_id: item.provider_id,
              public_identifier: item.public_identifier,
              first_name: item.first_name,
              last_name: item.last_name,
              headline: item.headline,
              location: item.location,
              // network_distance is relative to whichever account ran the search —
              // omit it when that account is a shared one, not the user's own
              // (ENG-1198), so degree-based targeting logic isn't silently corrupted.
              ...(usedSharedAccount ? {} : { network_distance: item.network_distance }),
              public_profile_url: item.public_profile_url,
              is_open_profile: item.is_open_profile,
            };
            if (item.work_experience?.length) {
              const current = item.work_experience.find((w: any) => w.current) || item.work_experience[0];
              if (current) trimmed.current_role = { position: current.position, company: current.company };
            }
            if (item.summary) trimmed.summary = item.summary.slice(0, 200);
            return trimmed;
          });
          const searchData = withAccountMeta({
            ...searchResult,
            items: trimmedItems,
            ...(anonymizedFiltered > 0 ? { anonymizedFiltered } : {}),
            ...(companySizeFiltered > 0 ? { companySizeFiltered } : {}),
          });
          if (trimmedItems.length === 0 && anonymizedFiltered > 0) {
            // Say plainly what happened, so this does not get reported to the
            // user as "no prospects match" or escalated as a broken search.
            return {
              success: true,
              message:
                `All ${anonymizedFiltered} result(s) were anonymized by LinkedIn (out-of-network), so none are usable. ` +
                `The search itself worked — this is a reach limit, not an outage and not an empty niche. ` +
                `Broaden the query, or search from an account whose network covers these people.`,
              data: searchData,
            };
          }
          if (trimmedItems.length === 0 && companySizeFiltered > 0) {
            // Same transparency principle as the anonymized case above: a
            // company-size ask that excluded every real candidate is a
            // narrow-niche result, not an empty search and not an outage.
            return {
              success: true,
              message:
                `Found candidates, but excluded all ${companySizeFiltered} of them because their employer's size ` +
                `either fell outside the requested range or couldn't be verified. The search itself worked — ` +
                `try widening the company_size range, or drop it to see the unfiltered results.`,
              data: searchData,
            };
          }
          return { success: true, data: searchData };
        }
        return { success: true, data: withAccountMeta(searchResult) };
      }

      case 'get-profile': {
        if (!target) throw new Error('Either profile_url or provider_id is required for get-profile');
        // Route through the cache-first wrapper so repeated lookups for the
        // same person across sessions don't re-hit Unipile. The wrapper asks
        // Unipile for linkedin_sections=* (full profile incl. experience /
        // education / skills) and strips viewer-relative fields before
        // persisting — see unipileProfileService.ts.
        // force_refresh bypasses the 30-day profile cache and reads live from the
        // authenticated Unipile account (ENG-508). The Founder LinkedIn audit and any
        // "what is my headline right now?" read must pass it so a months-stale cached
        // headline is never presented as current; high-volume outreach loops keep the
        // cache-first default for their dedup/rate-limit benefit. This is a pass-through
        // boolean — it never introduces a non-authenticated fallback.
        const forceRefresh = !!args.force_refresh;
        const { getUnipileProfileService } = await import('../../services/unipileProfileServiceFactory');
        const profileResult = await getUnipileProfileService().getProfile(target, account_id, { forceRefresh });
        const raw = profileResult.rawData;

        // The global profile cache strips is_relationship / connected_at because
        // they are viewer-relative (ENG-440) — so on a cache hit a freshly-written
        // blob carries no connection state at all (and a pre-change legacy row may
        // carry another viewer's, which we discard below). Re-derive it for THIS
        // account from our per-account AW-UnipileConnections cache (the authoritative
        // ENG-377 path) so the agent's invite-vs-DM decision has a correct signal.
        //
        // IMPORTANT: overlay onto a SHALLOW COPY. `raw` is the object held in the
        // profile cache (LRU/DDB row) — mutating it in place would persist this
        // viewer's connection state back into the shared cache and re-introduce the
        // very cross-viewer leak this fix closes.
        if (raw && typeof raw === 'object') {
          // Both halves must reject the sentinel, because this URL is used as a
          // DynamoDB GSI lookup key below. Unfiltered, EVERY anonymized profile
          // queries the same `/in/undefined` key — and the connection-sync cron
          // writes rows under exactly that key — so the lookup returns an
          // unrelated person's connection row and their is_relationship /
          // connected_at get presented as this user's, driving the agent's
          // invite-vs-message decision off a stranger's state.
          const profileUrl =
            usableProfileUrl(raw.public_profile_url) ||
            (usablePublicIdentifier(raw.public_identifier)
              ? `https://www.linkedin.com/in/${usablePublicIdentifier(raw.public_identifier)}`
              : (isUrl ? usableProfileUrl(target) : null));
          // ENG-1198: LinkedIn anonymizes out-of-network/restricted profiles
          // with public_identifier literally the string 'undefined' — mirrors
          // the search-people filtering above. get-profile can't drop the row
          // (the caller asked for this specific person), so flag it and drop
          // the fabricated /in/undefined URL instead.
          const isAnonymized = isAnonymizedIdentifier(raw.public_identifier);
          let conn: { connectedAt?: number } | null = null;
          // A shared/site-wide account's connection state belongs to a
          // STRANGER, not the user — reconciling is_relationship/connected_at
          // from it would present that stranger's "already connected/pending"
          // status as the user's own (ENG-1198). Skip the lookup entirely so
          // both fields are omitted below, same as network_distance.
          if (profileUrl && !usedSharedAccount) {
            const { getConnectionByProfileUrlAndAccount } = await import('../../services/unipileConnectionsDb');
            conn = await getConnectionByProfileUrlAndAccount(profileUrl, account_id).catch(() => null);
          }
          // Drop any is_relationship / connected_at that came off `raw` before
          // re-deriving. New cache writes already strip these, but rows persisted
          // BEFORE this change (30-day TTL) can still carry another viewer's stale
          // values — a spread of `raw` would leak them until the row expires. Only a
          // LIVE response (`!fromCache`) legitimately carries this viewer's own state.
          // ENG-1198: on a cold (non-cached) response network_distance survives
          // onto `raw` (see unipileProfileService.ts) — but it's relative to
          // whichever account was used. Drop it when that account is a shared
          // one, not the user's own, so a stranger's connection degree isn't
          // presented as the user's.
          const {
            is_relationship: rawRelationship,
            connected_at: rawConnectedAt,
            network_distance: rawNetworkDistance,
            public_profile_url: rawPublicProfileUrl,
            ...viewerIndependentRaw
          } = raw;
          // Reconcile as a union: connected if our per-account cache has a row OR a
          // LIVE blob said so. A `true` from either source wins — directly countering
          // the false-negative in reporter-ticket #135 (is_relationship false while
          // LinkedIn's send-time check said FIRST_DEGREE). On a cache hit we trust only
          // `conn`, never the (possibly cross-viewer) cached is_relationship.
          const isConnected =
            !!conn || (!profileResult.fromCache && rawRelationship === true);
          const data = {
            // Dropping the fabricated URL alone was not enough: `public_identifier`
            // stayed on the object as the literal string 'undefined', so the agent
            // was handed the exact slug needed to rebuild the dead link itself.
            ...withoutFabricatedProfileFields(viewerIndependentRaw),
            // Never surface the fabricated /in/undefined URL for an anonymized profile.
            ...(isAnonymized || !usableProfileUrl(rawPublicProfileUrl)
              ? {}
              : { public_profile_url: rawPublicProfileUrl }),
            // See ENG-1198 note above: is_relationship/connected_at are the
            // user's "already connected/pending" signal — only meaningful
            // relative to the user's own account, not a borrowed shared one.
            ...(usedSharedAccount ? {} : {
              is_relationship: isConnected,
              // conn.connectedAt is already epoch-ms (Unipile created_at) — do NOT
              // multiply by 1000 (ENG-379). Prefer the authoritative cache timestamp;
              // otherwise keep the raw timestamp ONLY from a live response.
              ...(conn && typeof conn.connectedAt === 'number'
                ? { connected_at: conn.connectedAt }
                : !profileResult.fromCache && typeof rawConnectedAt === 'number'
                  ? { connected_at: rawConnectedAt }
                  : {}),
            }),
            // See ENG-1198 note above: only keep network_distance when it's
            // relative to the user's own account, not a borrowed shared one.
            ...(!usedSharedAccount && rawNetworkDistance !== undefined
              ? { network_distance: rawNetworkDistance }
              : {}),
            ...(isAnonymized ? { anonymized: true } : {}),
          };
          return { success: true, data: withAccountMeta(data) };
        }
        return { success: true, data: withAccountMeta(raw) };
      }

      case 'list-connections': {
        const connectionsResult = await linkedInOutreachService.listConnections(account_id, args.cursor);
        return { success: true, data: connectionsResult };
      }

      case 'list-sent-invitations': {
        // ENG-1718: this used to ask one question — is `items` an array? — and on
        // `false` return `{ success: true, data: <whatever came back> }`. The SDK
        // is constructed at its default `validateRequestPayloadLevel: 'warn'`, so a
        // 2xx body failing its own response schema is logged and passed through
        // unchanged; any such body therefore became a SUCCESSFUL EMPTY RESULT.
        // That is the `{}` iTrials saw while a cooldown was actively firing, with
        // 126 pending invitations sitting in our own ledger unread — this action
        // never consulted it. See linkedInSentInvitationsView.ts for the full
        // chain; every outcome is now named, and none of them is a bare empty.
        const { getSentInvitationsView } = await import('../../services/agentMode/linkedInSentInvitationsView');
        const { getAllSentInvitationsByAccount } = await import('../../services/unipileSentInvitationsDb');
        const view = await getSentInvitationsView(account_id, args.cursor, {
          fetchLive: (id, cur) => linkedInOutreachService.listSentInvitations(id, cur),
          fetchCached: (id) => getAllSentInvitationsByAccount(id),
        });
        return { success: true, data: view };
      }

      case 'list-received-invitations': {
        const receivedResult = await linkedInOutreachService.listReceivedInvitations(account_id, args.cursor);
        // Trim to essential fields. Sender profile is enriched from the inviter object.
        if (Array.isArray(receivedResult?.items)) {
          const trimmedItems = receivedResult.items.map((item: any) => ({
            id: item.id,
            invitation_text: item.invitation_text,
            date: item.date,
            sender_profile: item.sender_profile || null,
            // shared_secret is required for accept-invitation (LinkedIn token from Unipile)
            shared_secret: item.specifics?.shared_secret || null,
          }));
          return { success: true, data: { ...receivedResult, items: trimmedItems } };
        }
        return { success: true, data: receivedResult };
      }

      case 'accept-invitation': {
        const invitationId = args.invitation_id;
        const sharedSecret = args.shared_secret;
        if (!invitationId) throw new Error('invitation_id is required for accept-invitation');
        if (!sharedSecret) throw new Error('shared_secret is required for accept-invitation (use the value from list-received-invitations)');

        // ENG-1595 identity binding: resolve the invitee's identity from Unipile's
        // OWN received-invitations record for THIS invitationId, before accepting —
        // never from caller-supplied profile_url/provider_id/name args. Those are
        // LLM-supplied and unverified against invitation_id; unlike send-invite
        // (where the supplied identity IS the send target by construction), a
        // mismatched pair here would accept invitation A but mirror the CRM write
        // onto an unrelated person B. Bounded scan: received invitations are a
        // live feed, not something to page through unboundedly on a request path.
        let acceptedSenderProfile: { public_id?: string; provider_id?: string; full_name?: string } | null = null;
        try {
          const MAX_PAGES = 5;
          let cursor: string | undefined;
          for (let page = 0; page < MAX_PAGES && !acceptedSenderProfile; page++) {
            const received = await linkedInOutreachService.listReceivedInvitations(account_id, cursor);
            const items = Array.isArray(received?.items) ? received.items : [];
            const match = items.find((it: any) => String(it?.id) === String(invitationId));
            if (match) {
              acceptedSenderProfile = match.sender_profile || null;
              break;
            }
            cursor = received?.cursor;
            if (!cursor) break;
          }
        } catch (lookupErr) {
          console.warn(`[AgentMode] accept-invitation: could not verify sender identity for invitation ${invitationId} (CRM mirror will be skipped):`, lookupErr);
        }

        const acceptPaced = await paceWrite();
        if (acceptPaced) return acceptPaced.refusal;
        const acceptResult = await linkedInOutreachService.acceptInvitation(invitationId, account_id, sharedSecret);

        // ENG-1595: mirror the now-accepted INBOUND connection into the CRM, same
        // best-effort pattern send-invite uses below — an accepted connection must
        // be as findable/engageable as one this account invited, or name-based CRM
        // search silently misses a real, legitimate contact (the reported symptom).
        // No-ops cleanly when identity couldn't be verified or list can't be
        // resolved — mirrors nothing rather than guessing or trusting the caller.
        //
        // Deliberately NOT falling back to resolveListIdForAccount here (unlike
        // send-invite). Sending an invite is always a deliberate targeting action —
        // the account-bound list is a safe default. Accepting an inbound request is
        // not: it could be a genuine prospect or an unrelated personal connection,
        // and the account owner never decided "every accept is a lead." Only mirror
        // when the caller explicitly names a list_id — i.e. when the task driving
        // this run has actually judged this specific person relevant.
        try {
          const publicId = acceptedSenderProfile?.public_id;
          const mirrorProfileUrl = publicId ? `https://www.linkedin.com/in/${publicId}/` : null;
          if (mirrorProfileUrl) {
            const { mirrorLinkedInInviteToCrm, splitInvitedUserName, INVITE_ACCEPTED_EVENT } = await import('../../services/linkedInInviteCrmMirror');
            const mirrorListId = args.list_id;
            if (mirrorListId) {
              const { crmDb } = await import('../../services/db');
              const mirrorList = await crmDb.getLeadListById(mirrorListId);
              const { canDestructiveCrmList } = await import('../../services/crmAccessControl');
              if (mirrorList && (await canDestructiveCrmList(userId, mirrorList))) {
                const { firstName, lastName } = splitInvitedUserName(acceptedSenderProfile?.full_name);
                await mirrorLinkedInInviteToCrm({
                  userId,
                  listId: mirrorListId,
                  linkedinUrl: mirrorProfileUrl,
                  leadId: args.lead_id,
                  firstName,
                  lastName,
                  accountId: account_id,
                  invitationId,
                  eventType: INVITE_ACCEPTED_EVENT,
                });
              } else {
                console.warn(`[AgentMode] accept-invitation: skipping CRM mirror — list ${mirrorListId} not accessible to user ${userId}`);
              }
            }
          }
        } catch (mirrorErr) {
          console.warn('[AgentMode] accept-invitation: failed to mirror accepted connection to CRM (non-fatal):', mirrorErr);
        }

        return { success: true, data: acceptResult };
      }

      case 'send-invite': {
        if (!target) throw new Error('Either profile_url or provider_id is required for send-invite');

        // ENG-1026: when the model passes CRM lead context, cross-check the live
        // profile's identity against the lead before spending an invite on the
        // wrong person. Positive mismatch → structured refusal; no lead context
        // or unverifiable → unchanged behavior.
        if (args.list_id && args.lead_id && isUrl && profile_url) {
          const { crmDb: identityCrmDb } = await import('../../services/db');
          // ENG-1026 Greptile P1 ("agent-tool authorization gap"): list_id/lead_id
          // are LLM-supplied tool arguments. Require the same list-access check
          // every other CRM write in this file uses before reading OR stamping
          // a lead's identity data — a foreign list_id must never expose or
          // mutate another tenant's lead. Best-effort skip on denial (mirrors
          // the CRM-mirror access guard below): this is a side-channel guard,
          // not the primary user-requested action, so it never blocks the send.
          const identityList = await identityCrmDb.getLeadListById(args.list_id).catch(() => null);
          const { canDestructiveCrmList } = await import('../../services/crmAccessControl');
          const hasIdentityAccess = identityList ? await canDestructiveCrmList(userId, identityList) : false;
          if (!hasIdentityAccess) {
            console.warn(`[AgentMode] send-invite: skipping identity check — list ${args.list_id} not accessible to user ${userId}`);
          }
          const identityLead = hasIdentityAccess
            ? await identityCrmDb.getLeadById(args.list_id, args.lead_id).catch(() => null)
            : null;
          if (identityLead) {
            const { verifyLinkedInIdentityForSend } = await import('../../services/linkedInIdentityCheck');
            const identity = await verifyLinkedInIdentityForSend({
              lead: identityLead as any,
              listId: args.list_id,
              leadId: args.lead_id,
              profileUrl: profile_url,
              accountId: account_id,
            });
            if (!identity.allowed) {
              return withRouting({
                success: false,
                error: identity.refusal.message,
                code: identity.refusal.code,
                details: identity.refusal.details,
              });
            }
          }
        }

        // ENG-182: cross-check the account's PENDING sent-invitation cache before
        // spending a run's invite quota. A profile with an OUTSTANDING (sent but
        // not-yet-accepted) invite is NOT a 1st-degree connection, so it slips past
        // the already-connected guard inside sendInvitation and Unipile then rejects
        // the resend with "Cannot resend yet" — which both wastes the run's quota and
        // surfaces as a per-recipient tool failure. The cache (AW-UnipileSentInvitations)
        // is refreshed every ~10 min by the connection-sync cron straight from Unipile's
        // live sent feed, so it also reflects invites made outside this system.
        //
        // Look up via the publicProfileUrl GSI, matching the CRM path (crm.ts): both
        // this URL and the cron's stored key are lowercased by normalizeLinkedInUrl, so
        // the match is case-insensitive. We rebuild a CANONICAL /in/{publicId}/ URL from
        // the parsed public id first, because normalizeLinkedInUrl does NOT strip query
        // params (e.g. LinkedIn's ?miniProfileUrn tracking) — passing the raw URL through
        // would miss. The cache is keyed by public id, so only a /in/{publicId} URL can be
        // deduped; a raw provider_id invite falls through to the live send unchanged.
        const invitePublicId = isUrl && profile_url ? linkedInPublicIdFromUrl(profile_url) : null;
        const inviteCanonicalUrl = invitePublicId ? `https://www.linkedin.com/in/${invitePublicId}/` : null;

        // ENG-787: mirror this invite into the CRM lead list so the invitee is attributed
        // (created if absent, marked 'contacted', logged with a linkedin.invite.sent
        // engagement). Shared by the "already pending" skip branch and the live-send branch
        // so a person the dedup guard skips STILL gets a CRM record. Requires a target
        // list_id (the outreach caller passes the list it is working from) and a profile
        // URL to key on. Best-effort: a CRM write must never fail/branch an invite Unipile
        // already accepted, and the list_id is LLM-controlled so access is verified first.
        const mirrorInviteToCrm = async (opts?: { note?: string; sentAt?: string; invitationId?: string }): Promise<void> => {
          // EVERYTHING here is inside the try: this is best-effort attribution and must
          // never fail, or branch, an invite Unipile has already accepted.
          try {
            // Resolve the invitee's profile URL. A provider_id-only invite has no /in/
            // URL to key a lead on, so ask Unipile for the profile rather than dropping
            // the attribution — that path was previously invisible to the CRM entirely.
            let mirrorProfileUrl: string | null = isUrl && profile_url ? profile_url : null;
            if (!mirrorProfileUrl && provider_id) {
              try {
                const profile = await linkedInOutreachService.getProfile(provider_id, account_id);
                const publicId = profile?.public_id || profile?.public_identifier || profile?.rawData?.public_identifier;
                if (publicId) mirrorProfileUrl = `https://www.linkedin.com/in/${publicId}/`;
              } catch (profileErr) {
                console.warn('[AgentMode] send-invite: could not resolve provider_id to a profile URL for CRM mirror:', profileErr);
              }
            }
            if (!mirrorProfileUrl) return;

            // The list the invite belongs to. The model should pass list_id, but when it
            // does not, fall back to the list bound to this sending account so
            // attribution does not hinge on the model remembering an argument.
            const { resolveListIdForAccount } = await import('../../services/linkedInInviteCrmMirror');
            const mirrorListId = args.list_id || (await resolveListIdForAccount(userId, account_id));
            if (!mirrorListId) return;

            const { crmDb } = await import('../../services/db');
            const mirrorList = await crmDb.getLeadListById(mirrorListId);
            const { canDestructiveCrmList } = await import('../../services/crmAccessControl');
            if (!mirrorList || !(await canDestructiveCrmList(userId, mirrorList))) {
              console.warn(`[AgentMode] send-invite: skipping CRM mirror — list ${mirrorListId} not accessible to user ${userId}`);
              return;
            }
            const { mirrorLinkedInInviteToCrm } = await import('../../services/linkedInInviteCrmMirror');
            await mirrorLinkedInInviteToCrm({
              userId,
              listId: mirrorListId,
              linkedinUrl: mirrorProfileUrl,
              leadId: args.lead_id,
              firstName: args.first_name,
              lastName: args.last_name,
              company: args.company,
              title: args.title,
              note: opts?.note ?? message ?? undefined,
              accountId: account_id,
              invitationId: opts?.invitationId,
              sentAt: opts?.sentAt,
            });
          } catch (mirrorErr) {
            console.warn('[AgentMode] send-invite: failed to mirror invite to CRM (non-fatal):', mirrorErr);
          }
        };

        if (inviteCanonicalUrl) {
          const { getSentInvitationByProfileUrlAndAccount } = await import('../../services/unipileSentInvitationsDb');
          const pending = await getSentInvitationByProfileUrlAndAccount(inviteCanonicalUrl, account_id).catch(() => null);
          if (pending) {
            console.log(`[AgentMode] send-invite: skipping ${profile_url} — invitation already pending (sent ${pending.sentAt ?? 'previously'})`);
            // ENG-787: still mirror the already-pending invite so the CRM records the
            // touch even though we skip the (quota-wasting) resend.
            await mirrorInviteToCrm({
              note: pending.invitationText,
              sentAt: pending.sentAt,
              invitationId: pending.invitationId,
            });
            return withRouting({
              success: true,
              alreadyInvited: true,
              message: `A LinkedIn connection invitation is already pending for this profile (sent ${pending.sentAt ?? 'previously'}). Skipped to avoid a duplicate — no invite quota was used. Move on to the next lead.`,
              data: { alreadyInvited: true, sentAt: pending.sentAt ?? null },
            });
          }
        }

        // Premium accounts allow 300-char invites; free accounts 200.
        const inviteCharLimit = await linkedInOutreachService.getInviteCharLimitForAccount(userId, account_id);
        // Note-quota policy (ENG-213). Default to 'skip' — HOLD rather than silently
        // drop a note the customer wrote. Only send note-less when the customer has
        // explicitly authorized it via on_note_quota='send_without_note'.
        const onNoteQuota: 'send_without_note' | 'skip' =
          on_note_quota === 'send_without_note' ? 'send_without_note' : 'skip';
        // ENG-126's account-level cooldown short-circuits the network call inside
        // sendInvitation, so a paced caller would sleep a full gap and burn one of
        // the account's hourly writes for a request that never leaves the process —
        // for the whole hour the breaker is armed, on every queued invite. Check it
        // here, before the slot is taken.
        if (linkedInOutreachService.isUnderInvitationCooldown(account_id)) {
          return withRouting({
            success: false,
            error:
              'Cannot resend yet — this LinkedIn Outreach account is under an active account-level '
              + 'invitation cooldown (its invitation cap was hit on an earlier send this run). '
              + 'Skip the remaining invites and report what was completed.',
          });
        }
        // Past every skip path (already-pending, identity mismatch, cooldown): this
        // call is going to reach LinkedIn, so now is when it should cost a slot.
        const invitePaced = await paceWrite();
        if (invitePaced) return invitePaced.refusal;
        try {
          const inviteResult = await linkedInOutreachService.sendInvitation(
            account_id, target, isUrl, message, inviteCharLimit, { onNoteQuota },
          );

          // ENG-182: write the pending invite through to the cache immediately (mirrors
          // the CRM route) so a subsequent run — before the next ~10-min sync cron — sees
          // it and dedups via the check above. Best-effort: a cache write must never fail
          // an invite that Unipile already accepted. (Written with the same lowercased
          // publicProfileUrl the GSI reads, so the next lookup matches case-insensitively.)
          // One timestamp for both the pending-invite cache and the CRM mirror, so the
          // lead's linkedInInviteSentAt agrees with the cache row this send creates.
          const nowIso = new Date().toISOString();
          if (invitePublicId) {
            try {
              const { upsertSentInvitation } = await import('../../services/unipileSentInvitationsDb');
              const { normalizeLinkedInUrl } = await import('../../services/unipileConnectionsDb');
              await upsertSentInvitation({
                accountId: account_id,
                invitedUserPublicId: invitePublicId,
                publicProfileUrl: normalizeLinkedInUrl(`https://www.linkedin.com/in/${invitePublicId}/`),
                invitationId: (inviteResult && (inviteResult.invitation_id || inviteResult.id)) || '',
                invitedUserName: '',
                invitationText: message ?? '',
                sentAt: nowIso,
                syncedAt: nowIso,
              });
            } catch (cacheErr) {
              console.warn('[AgentMode] send-invite: failed to cache sent invitation (non-fatal):', cacheErr);
            }
          }

          // ENG-787: mirror the freshly-sent invite into the CRM lead list (see the
          // shared mirrorInviteToCrm helper above), stamped with the same instant the
          // pending-invite cache row carries.
          await mirrorInviteToCrm({
            sentAt: nowIso,
            invitationId: (inviteResult && (inviteResult.invitation_id || inviteResult.id)) || undefined,
          });

          return { success: true, data: withRouting(inviteResult) };
        } catch (inviteErr: any) {
          if (inviteErr?.noteQuotaExceeded) {
            // Decision gate — do NOT decide for the customer. Ask them, then re-call
            // send-invite with on_note_quota. In a scheduled run there is no one to
            // answer, so the agent stops here and the invite is simply left un-sent
            // (the lead stays eligible); the customer resolves it by reopening the chat.
            return withRouting({
              success: false,
              requiresDecision: true,
              noteQuotaExceeded: true,
              error:
                `This LinkedIn account's monthly quota for personalized invitation notes is spent, so the note "${message}" cannot be attached. ` +
                `Do NOT decide on your own — ask the user whether to send the connection request WITHOUT the note or skip this person. ` +
                `Then re-call send-invite with the same target plus on_note_quota="send_without_note" to send note-less, or leave it un-sent if they choose to skip.`,
            });
          }
          throw inviteErr;
        }
      }

      case 'send-message': {
        if (!target) throw new Error('Either profile_url or provider_id is required for send-message');
        if (!message) throw new Error('message is required for send-message action');

        // Gate: if list_id + lead_id provided, enforce that conversation history was synced within 24h
        // and check for duplicate sends to prevent spam.
        const { list_id: sendListId, lead_id: sendLeadId } = args;
        let sendLead: any = null;
        if (sendListId && sendLeadId) {
          const { crmDb } = await import('../../services/db');
          // ENG-1026 Greptile P1 ("agent-tool authorization gap"): list_id/lead_id
          // are LLM-supplied tool arguments — require list access before this
          // fetch, same as every other CRM write in this file, or a foreign
          // list_id exposes/mutates another tenant's lead identity data via
          // both the sync-gate/duplicate check below and the identity guard
          // further down. Best-effort skip on denial: the send itself is not
          // blocked, only the CRM-linked checks that need this lead's data.
          const sendList = await crmDb.getLeadListById(sendListId).catch(() => null);
          const { canDestructiveCrmList } = await import('../../services/crmAccessControl');
          const hasSendAccess = sendList ? await canDestructiveCrmList(userId, sendList) : false;
          if (!hasSendAccess) {
            console.warn(`[AgentMode] send-message: skipping CRM-linked checks — list ${sendListId} not accessible to user ${userId}`);
          }
          sendLead = hasSendAccess ? await crmDb.getLeadById(sendListId, sendLeadId) : null;
          if (sendLead) {
            const syncAt = (sendLead as any).linkedinMessageSyncAt as string | undefined;
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            if (!syncAt || syncAt < oneDayAgo) {
              return withRouting({
                success: false,
                error: `LinkedIn conversation history is stale (last synced: ${syncAt ?? 'never'}). Call update-conversation-history with list_id="${sendListId}" and lead_id="${sendLeadId}" before sending to ensure you have up-to-date context.`,
                requiresSync: true,
              });
            }

            // Anti-spam: check if this exact message was already sent to this lead.
            // Compares the final rendered message (variables already substituted by the agent).
            // Blocks on check failure — a delayed send is safer than a duplicate spam.
            const leadLinkedInForCheck = (sendLead.linkedin as string | undefined)?.toLowerCase();
            if (leadLinkedInForCheck) {
              const { emailEventsDb: checkEventsDb } = await import('../../services/emailEventsDb');
              const priorEvents = await checkEventsDb.getEventsByEmailDomainAndLeadEmail(
                `linkedin-${sendListId}`,
                leadLinkedInForCheck
              );
              const priorSentMessages = priorEvents.filter(
                (e: any) => e.eventType === 'linkedin.message.sent'
              );
              const normalizedMessage = message.trim().toLowerCase();
              const duplicateEvent = priorSentMessages.find(
                (e: any) => (e.data?.text ?? '').trim().toLowerCase() === normalizedMessage
              );
              if (duplicateEvent) {
                console.warn(`[AgentMode] send-message: duplicate message blocked for lead ${sendLeadId} — identical text was already sent`);
                return withRouting({
                  success: false,
                  error: `This exact message was already sent to this lead (duplicate detected). Choose a different follow-up message or skip this lead.`,
                  duplicate: true,
                  alreadySentAt: duplicateEvent.createdAt,
                });
              }
            }
          }
        }

        // ENG-1026: with CRM lead context, cross-check the live profile's identity
        // against the lead before sending. Positive mismatch → structured refusal.
        if (sendLead && sendListId && sendLeadId) {
          const identityUrl = (isUrl && profile_url) || (sendLead.linkedin as string | undefined)?.trim();
          if (identityUrl) {
            const { verifyLinkedInIdentityForSend } = await import('../../services/linkedInIdentityCheck');
            const identity = await verifyLinkedInIdentityForSend({
              lead: sendLead as any,
              listId: sendListId,
              leadId: sendLeadId,
              profileUrl: identityUrl,
              accountId: account_id,
            });
            if (!identity.allowed) {
              return withRouting({
                success: false,
                error: identity.refusal.message,
                code: identity.refusal.code,
                details: identity.refusal.details,
              });
            }
          }
        }

        const messagePaced = await paceWrite();
        if (messagePaced) return messagePaced.refusal;
        const messageResponse = await linkedInOutreachService.sendMessage(account_id, target, isUrl, message);

        // ENG-2984: shadow duplicate check for unlinked sends — logs only, fire-and-forget.
        if (!(sendListId && sendLeadId)) {
          void shadowCheckUnlinkedLinkedInDuplicate({
            chatId: messageResponse?.chat_id,
            sentMessageId: messageResponse?.message_id ?? messageResponse?.id,
            message,
            accountId: account_id,
            target,
          });
        }

        // Persist the sent message to the CRM so it shows up in engagement history.
        // The Unipile response may contain the message ID; fall back to a timestamp-based ID.
        if (sendListId && sendLeadId && sendLead) {
          const leadLinkedIn = (sendLead.linkedin as string | undefined)?.toLowerCase();
          if (leadLinkedIn) {
            const { emailEventsDb } = await import('../../services/emailEventsDb');
            const { crmDb: sendCrmDb } = await import('../../services/db');
            const msgId = messageResponse?.id ?? messageResponse?.message_id ?? `sent_${Date.now()}`;
            const sentAt = new Date().toISOString();
            await Promise.all([
              emailEventsDb.addLinkedInMessageEvent({
                eventId: `linkedin_msg_${msgId}`,
                emailDomain: `linkedin-${sendListId}`,
                leadEmail: leadLinkedIn,
                eventType: 'linkedin.message.sent',
                text: message,
                timestamp: sentAt,
                senderId: account_id,
                messageProviderId: msgId,
              }),
              // Refresh the sync timestamp so the 24h gate stays valid
              sendCrmDb.updateLeadLinkedInSyncAt(sendListId, sendLeadId, sentAt),
            ]);
            console.log(`[AgentMode] send-message: persisted sent message for lead ${sendLeadId} in list ${sendListId}`);
          }
        }

        return { success: true, data: withRouting(messageResponse) };
      }

      case 'send-inmail': {
        if (!target) throw new Error('Either profile_url or provider_id is required for send-inmail');
        if (!message) throw new Error('message is required for send-inmail action');
        const { subject } = args;
        if (!subject) throw new Error('subject is required for send-inmail action');

        const inmailPaced = await paceWrite();
        if (inmailPaced) return inmailPaced.refusal;
        const inmailResponse = await linkedInOutreachService.sendInMail(account_id, target, isUrl, subject, message);

        // Persist the sent InMail to the CRM so it shows up in engagement history.
        const { list_id: inmailListId, lead_id: inmailLeadId } = args;
        if (inmailListId && inmailLeadId) {
          const { crmDb } = await import('../../services/db');
          const inmailLead = await crmDb.getLeadById(inmailListId, inmailLeadId);
          if (inmailLead) {
            const leadLinkedIn = ((inmailLead as any).linkedin as string | undefined)?.toLowerCase();
            if (leadLinkedIn) {
              const { emailEventsDb } = await import('../../services/emailEventsDb');
              const msgId = inmailResponse?.id ?? inmailResponse?.message_id ?? `sent_${Date.now()}`;
              const sentAt = new Date().toISOString();
              await Promise.all([
                emailEventsDb.addLinkedInMessageEvent({
                  eventId: `linkedin_inmail_${msgId}`,
                  emailDomain: `linkedin-${inmailListId}`,
                  leadEmail: leadLinkedIn,
                  eventType: 'linkedin.inmail.sent',
                  text: message,
                  timestamp: sentAt,
                  senderId: account_id,
                  messageProviderId: msgId,
                }),
                crmDb.updateLeadLinkedInSyncAt(inmailListId, inmailLeadId, sentAt),
              ]);
              console.log(`[AgentMode] send-inmail: persisted sent InMail for lead ${inmailLeadId} in list ${inmailListId}`);
            }
          }
        }

        return { success: true, data: withRouting(inmailResponse) };
      }

      case 'update-conversation-history': {
        if (!target) throw new Error('Either profile_url or provider_id is required for update-conversation-history');
        const { list_id, lead_id } = args;
        if (!list_id || !lead_id) throw new Error('list_id and lead_id are required for update-conversation-history');

        // Resolve the Unipile attendee/provider ID for this contact. When a raw
        // provider_id is supplied directly (not a profile_url), it has not been
        // validated against Unipile yet — resolveProviderId only validates the
        // profile_url path. getMessagesWithContact treats a 404 from Unipile's
        // chat_attendee lookup as "never messaged" (ENG-1623), which is
        // indistinguishable from a 404 caused by an invalid/nonexistent
        // provider_id. Without this check, a bad provider_id would silently
        // "succeed" with 0 messages instead of surfacing a clear error.
        const providerId = isUrl
          ? await linkedInOutreachService.resolveProviderId(target, true, account_id)
          : await linkedInOutreachService.getProfile(target, account_id).then(() => target);

        // Load the lead to get the normalized LinkedIn URL used as the storage key
        const { crmDb } = await import('../../services/db');
        const lead = await crmDb.getLeadById(list_id, lead_id);
        if (!lead) throw new Error(`Lead ${lead_id} not found in list ${list_id}`);
        const leadLinkedIn = ((lead as any).linkedin as string | undefined)?.toLowerCase();
        if (!leadLinkedIn) throw new Error('Lead has no LinkedIn URL — add a LinkedIn profile URL to this lead first');

        // Fetch all messages with this contact from Unipile.
        // account_id is required so Unipile can identify which side is is_sender=1.
        const messages = await linkedInOutreachService.getMessagesWithContact(providerId, account_id);

        // Upsert all messages into AW-EmailEvents in parallel, then stamp sync timestamp.
        // Key on provider_id (stable) not msg.id (ephemeral internal Unipile UUID that
        // changes each call), so repeated syncs don't create duplicate rows.
        const { emailEventsDb } = await import('../../services/emailEventsDb');
        const emailDomain = `linkedin-${list_id}`;

        const syncAt = new Date().toISOString();
        await Promise.all([
          ...messages.map(msg => emailEventsDb.addLinkedInMessageEvent({
            eventId: `linkedin_msg_${msg.provider_id}`,
            emailDomain,
            leadEmail: leadLinkedIn,
            eventType: msg.is_sender === 1 ? 'linkedin.message.sent' : 'linkedin.message.received',
            text: msg.text ?? null,
            timestamp: msg.timestamp,
            senderId: msg.sender_id,
            messageProviderId: msg.provider_id,
          })),
          crmDb.updateLeadLinkedInSyncAt(list_id, lead_id, syncAt),
        ]);
        const totalSynced = messages.length;

        console.log(`[AgentMode] update-conversation-history: synced ${totalSynced} messages for lead ${lead_id}`);
        return {
          success: true,
          data: {
            synced: totalSynced,
            syncedAt: syncAt,
            message: `Synced ${totalSynced} messages for this LinkedIn contact. Conversation history is now up to date in the CRM.`,
          },
        };
      }

      case 'get-company': {
        const companyId = args.company_id;
        if (!companyId) throw new Error('company_id is required for get-company');
        // Route through the cache-first wrapper so repeated lookups for the
        // same company across sessions don't re-hit Unipile. 30-day TTL.
        // Viewer-relative fields (is_following, etc.) are stripped before
        // persisting — see unipileCompanyService.ts.
        const { getUnipileCompanyService } = await import('../../services/unipileCompanyServiceFactory');
        const companyResult = await getUnipileCompanyService().getCompany(companyId, account_id);
        return { success: true, data: withAccountMeta(companyResult.rawData) };
      }

      case 'list-post-engagers': {
        // ENG-2739: one row per distinct commenter on a post — a warm-lead source.
        // Reactors are not covered: the Unipile SDK exposes no reactions listing.
        const postId = typeof args.post_id === 'string' ? args.post_id.trim() : '';
        if (!postId) throw new Error('post_id is required for list-post-engagers (a LinkedIn post URL, urn:li:activity:… URN, or Unipile social id)');
        const rawLimit = Number(args.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.max(Math.floor(rawLimit), 1), 100) : undefined;
        const comments = await linkedInOutreachService.listPostComments(postId, account_id, { cursor: args.cursor, limit });
        const seen = new Set<string>();
        const engagers: any[] = [];
        let anonymizedSkipped = 0;
        for (const comment of comments.items) {
          const details = comment?.author_details ?? {};
          const providerId = typeof details.id === 'string' ? details.id : null;
          const profileUrl = usableProfileUrl(details.profile_url);
          // ENG-1198 pattern: an out-of-network author has no profile we can reach
          // or dedup on — drop it and report the count instead of a fake lead.
          if (!providerId || !profileUrl || details.network_distance === 'OUT_OF_NETWORK') {
            anonymizedSkipped++;
            continue;
          }
          if (seen.has(providerId)) continue;
          seen.add(providerId);
          const text = typeof comment.text === 'string' ? comment.text : '';
          engagers.push({
            // `comment.author` can be a URN, not a display name — only surface a real name.
            name: typeof details.name === 'string' && details.name.trim()
              ? details.name.trim()
              : typeof comment.author === 'string' && comment.author.trim() && !comment.author.startsWith('urn:')
                ? comment.author.trim()
                : null,
            headline: details.headline ?? null,
            profile_url: profileUrl,
            provider_id: providerId,
            comment_snippet: text.length > 200 ? `${text.slice(0, 197)}...` : text,
          });
        }
        return {
          success: true,
          data: withAccountMeta({ post_id: comments.socialId, items: engagers, anonymizedSkipped, cursor: comments.cursor }),
        };
      }

      case 'cancel-invitation': {
        const invitationId = args.invitation_id;
        if (!invitationId) throw new Error('invitation_id is required for cancel-invitation');
        const cancelPaced = await paceWrite();
        if (cancelPaced) return cancelPaced.refusal;
        const cancelResult = await linkedInOutreachService.cancelInvitation(invitationId, account_id);
        // We just ended this invitation, so we know it is no longer pending —
        // don't make the cache wait for the next full-feed prune to find out
        // (ENG-1197). Best-effort: a failed cleanup must not turn a successful
        // withdrawal into a reported failure.
        const { deleteSentInvitationByInvitationId } = await import('../../services/unipileSentInvitationsDb');
        await deleteSentInvitationByInvitationId(account_id, invitationId).catch((err) =>
          console.error(`[AgentMode] Failed to drop withdrawn invitation ${invitationId}:`, err),
        );
        return { success: true, data: cancelResult };
      }

      // ENG-1719 / ENG-1609 AC #8: bulk-withdraw the oldest pending invitations.
      //
      // Routed through paceLinkedInWrite per withdrawal, exactly like the
      // single-shot cancel-invitation above, so the drain inherits the spacing
      // gap and the hourly ceiling instead of working around them — and,
      // because dailyVolumeClassFor returns null for cancel, does not consume
      // the account's daily invite budget.
      case 'withdraw-stale-invitations': {
        const {
          withdrawStaleInvitations,
          DEFAULT_MAX_WITHDRAWALS_PER_RUN,
        } = await import('../../services/agentMode/linkedInStaleInvitationDrain');
        const {
          getAllSentInvitationsByAccount,
          deleteSentInvitationByInvitationId,
        } = await import('../../services/unipileSentInvitationsDb');

        const rawDays = Number(args.older_than_days);
        if (!Number.isFinite(rawDays) || rawDays < 1) {
          throw new Error('older_than_days is required for withdraw-stale-invitations and must be at least 1');
        }
        const rawMax = Number(args.max_withdrawals);

        const result = await withdrawStaleInvitations({
          accountId: account_id,
          olderThanDays: rawDays,
          maxWithdrawals: Number.isFinite(rawMax) && rawMax > 0 ? rawMax : DEFAULT_MAX_WITHDRAWALS_PER_RUN,
          deps: {
            fetchPending: (acc) => getAllSentInvitationsByAccount(acc),
            // The pacer's own refusal text, or null to proceed. Reusing
            // paceLinkedInWrite rather than reserveWriteSlot directly keeps the
            // drain on the identical path every other LinkedIn write takes.
            pace: async (acc) => {
              const paced = await paceLinkedInWrite('cancel-invitation', resolvedLinkedInAccount!, acc);
              // resolvedLinkedInAccount is non-null here: this action is in the
              // ownership gate above, which returns early when it cannot resolve.
              if (!paced.refusal) return null;
              // ENG-1873: hand back WHICH gate refused, not just its prose, so the
              // drain result and its notice can say so truthfully.
              console.log(
                `[AgentMode] withdraw-stale-invitations stopped on ${acc}: gate=${paced.refusal.gate} — `
                + `${paced.refusal.message}`,
              );
              return { gate: paced.refusal.gate, reason: paced.refusal.error };
            },
            cancel: async (invitationId, acc) => {
              await linkedInOutreachService.cancelInvitation(invitationId, acc);
            },
            forget: (acc, invitationId) => deleteSentInvitationByInvitationId(acc, invitationId),
            recordWithdrawal: async (candidate) => {
              const { recordInviteWithdrawnInCrm } = await import('../../services/linkedInInviteCrmMirror');
              return recordInviteWithdrawnInCrm({
                userId,
                accountId: account_id,
                linkedinUrl: candidate.publicProfileUrl,
                invitationId: candidate.invitationId,
                sentAt: candidate.sentAt,
                ...(args.list_id ? { listId: args.list_id } : {}),
              });
            },
          },
        });
        return { success: true, data: result };
      }

      case 'search-parameters': {
        // Resolve a free-text query (company / location / industry / school / service)
        // to LinkedIn entity IDs via the cache-first wrapper around Unipile's
        // /linkedin/search/parameters endpoint. See unipileSearchParamService.ts.
        const { type, keywords, limit } = args;
        if (!type) throw new Error('type is required for search-parameters (one of COMPANY, LOCATION, INDUSTRY, SCHOOL, SERVICE)');
        if (!keywords) throw new Error('keywords is required for search-parameters');
        const { getUnipileSearchParamService } = await import('../../services/unipileSearchParamServiceFactory');
        const resolveResult = await getUnipileSearchParamService().resolve(account_id, {
          type,
          keywords,
          limit,
        });
        // ENG-975: the same account-scoped search outage empties entity
        // resolution too — the reported session got `candidates: []` for
        // INDUSTRY 'hospital health care'. An empty list here silently drops
        // the filter downstream, so confirm the account can search before
        // handing back "no such entity".
        if ((resolveResult.candidates || []).length === 0
          && await linkedInOutreachService.probeSearchCapability(account_id) === 'degraded') {
          console.log(`[AgentMode] linkedinOutreach: search-parameters returned 0 candidates and account ${account_id} cannot search`);
          return linkedInSearchUnavailableResponse();
        }
        // Trim each candidate to id/title/subtitle so the LLM doesn't see internal
        // resolver fields (mirrors the trimming pattern used by search-people above).
        const trimmedCandidates = (resolveResult.candidates || []).map((c: any) => ({
          id: c.id,
          title: c.title,
          ...(c.subtitle !== undefined ? { subtitle: c.subtitle } : {}),
        }));
        return {
          success: true,
          data: withAccountMeta({
            candidates: trimmedCandidates,
            fromCache: resolveResult.fromCache,
            source: resolveResult.source,
          }),
        };
      }

      case 'set-daily-invite-cap': {
        // Self-reported, not detected — see linkedInWritePacer.ts's module doc
        // comment for why this is a direct question to the user rather than an
        // API probe. Use this ONLY after the user has told you, in THIS
        // conversation, whether their connected LinkedIn account has Premium —
        // never guess, never infer it from anything else, and never call this
        // for an unattended/scheduled run (there's no one to ask).
        // Writes through the account OWNER's record, not necessarily the
        // caller's — see linkedInDailyVolumeGate.ts's module doc comment.
        let clampedCap: number;
        try {
          clampedCap = await setDailyInviteCap(
            resolvedLinkedInAccount!,
            account_id,
            args.daily_invite_cap,
            userId,
          );
        } catch (err) {
          if (err instanceof DailyInviteCapNotOwnerError) {
            return { success: false, error: err.message };
          }
          throw err;
        }
        return {
          success: true,
          data: {
            account_id,
            daily_invite_cap: clampedCap,
            ...(clampedCap !== Number(args.daily_invite_cap) ? { note: `Requested ${args.daily_invite_cap} was clamped to the system-wide maximum of ${clampedCap}.` } : {}),
          },
        };
      }

      default: {
        const validActions = ['search-people','get-profile','list-connections','list-sent-invitations','list-received-invitations','send-invite','send-message','send-inmail','get-company','cancel-invitation','accept-invitation','update-conversation-history','search-parameters','set-daily-invite-cap','withdraw-stale-invitations','list-post-engagers'];
        throw new Error(`Unsupported LinkedIn outreach action: "${action}". Valid actions are: ${validActions.join(', ')}`);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    // Errors that went through handleError are already logged by the service; don't double-log.
    // Also suppress user-facing errors like "Cannot send message: not a 1st-degree connection".
    const alreadyLogged = error instanceof Error && !!(error as any).structuredError;
    const isExpectedUserError = errorMessage.startsWith('Cannot send message:') || errorMessage.startsWith('Cannot send invite:');
    if (!alreadyLogged && !isExpectedUserError) {
      console.error('AgentMode: LinkedIn outreach failed:', error);
    }

    const structuredError = (error as any).structuredError;
    // ENG-2205: uses the shared isProvenDisconnectError predicate rather than
    // this inline check — the inline version (kept here as `structuredError`
    // for the fallback below) treats any AUTH_ERROR as proof of death, but
    // handleError classifies a bare 403 as AUTH_ERROR too, and a 403 is a
    // permission/plan restriction, not a dead session.
    if (isProvenDisconnectError(error)) {
      // A session can die between the preflight above and this call (or inside the
      // probe's 10-minute cache window), so the reactive path stays as the backstop.
      // Both return the identical response via one helper.
      linkedInOutreachService.clearStatusCache(account_id);
      // Persist it as well (ENG-1197). This used to end here — the one place that
      // learned a session was dead told the model and nobody else, so an unattended
      // scheduled run discovered the outage, no-opped, and left no trace anything
      // was wrong. Recording it is what gives the owner an alert and lets the next
      // run skip instead of repeating the discovery. ownerUserId is omitted for a
      // shared account — see the identical comment on the preflight call above.
      const { recordUnipileAccountHealth } = await import('../../services/linkedInConnectionHealth');
      await recordUnipileAccountHealth({
        accountId: account_id,
        ownerUserId: usedSharedAccount ? undefined : userId,
        state: 'disconnected',
      });
      return withRouting(linkedInDisconnectedResponse());
    }

    // Account-level invitation throttle (ENG-126). Once a LinkedIn account hits
    // its invitation cap — a weekly limit that is far lower on non-Premium
    // accounts and shrinks as the pending-invitation backlog grows — Unipile
    // returns "Cannot resend yet" for send-invite on EVERY recipient, including
    // brand-new ones. Surfaced verbatim, that phrase reads like a per-recipient
    // cooldown, so the agent moves on to the next recipient and repeats, burning
    // attempt after attempt (10+ in the reported session) and reporting nothing
    // useful. Re-label it as the account-wide throttle it is so the agent stops
    // and reports proactively. The raw phrase is preserved in the body so the
    // error classifier still buckets this as an upstream_rejected business rule.
    if (action === 'send-invite' && /cannot resend yet/i.test(errorMessage)) {
      return withRouting({
        success: false,
        message: 'LinkedIn invitation limit reached',
        error: [
          "LinkedIn rejected this invitation with 'Cannot resend yet'. This is an ACCOUNT-LEVEL invitation cooldown/throttle, NOT a per-recipient one — LinkedIn caps how many pending invitations an account may have (the cap is much lower on non-Premium accounts), so it applies to every recipient equally.",
          '',
          'DO NOT keep trying other recipients — every send-invite will fail the same way until the cooldown lifts. Stop sending invitations now and report to the user that their LinkedIn account has hit its invitation limit and has a large pending-invitation backlog.',
          '',
          'To free up capacity the user can withdraw old unanswered invitations (use list-sent-invitations to see the backlog, then cancel-invitation on the stale ones) or wait a few days before the next outreach run. Prefer queueing these invites for a later run over retrying now.',
        ].join('\n'),
        accountThrottled: true,
      });
    }

    // ENG-1300: LinkedInOutreachService.handleError already classifies the
    // status into structuredError.status/.classification for its own
    // reconnect-detection logic above — read the same field here so the
    // generic fallback path also reaches the tool-error classifier as
    // auth/rate_limit/etc. instead of a bare Error/bug.
    return withRouting({
      success: false,
      message: 'LinkedIn outreach action failed',
      error: errorMessage,
      code: (error as any)?.code ?? structuredError?.status
    });
  }
}
