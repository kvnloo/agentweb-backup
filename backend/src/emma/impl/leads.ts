/**
 * ENG-2103 (F2) — leads/CRM tool cluster, extracted from `AgentModeService`.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 * getLeadLists, createLeadList, addLeadsToList, getLeads, searchLeads,
 * getLeadDetails, getLeadsNeedingFollowup, updateLead, setLeadContactStatus,
 * deleteLeads, deleteLeadsByFilter, updateLeadList, updateLeadStatus,
 * getLeadListStatuses, configureLeadStatuses, deleteLeadList,
 * getLeadEngagements, addLeadEngagement, sendEmailToLead. Sixth domain
 * cluster — 19 of the 134 `agentModeService.<method>()` names `emma/tools.ts`
 * calls into.
 *
 * Explicitly NOT included, despite being adjacent/lead-related — flagged back
 * per this round's own instruction rather than worked around:
 *  - `updateEmailDraftForLead` (originally the 20th method in this same
 *    contiguous source range) calls `this.callLLM` directly (twice) to draft
 *    the email body/subject. Same shape of coupling as `createHtmlFromTemplate`
 *    (Google Docs/Sheets round) — needs its own "how does an extracted module
 *    reach the LLM gateway" design decision, not a mechanical move.
 *
 * No metering/LLM calls exist anywhere in the 19 methods actually moved here
 * (grepped for llmService, generateJSONContent, callLLM, meterUserUsage,
 * currentRunFunding, usageContext, openai/bedrock/gemini/anthropic — zero
 * matches), so there is nothing for the RunFunding/billingUserId audit (F1
 * rounds 3-5's bug class) to find in this round.
 *
 * `AgentModeService.prototype.<name>` now delegates to these 19 functions.
 * `__tests__/agentModeService.crmTools.test.ts` (3287 lines) calls
 * `(service as any).<method>(...)` directly on a real instance for all of
 * them — a real caller beyond `emma/tools.ts` — so none of the 19 class
 * methods could be deleted.
 *
 * Four private helpers were shared within/beyond this cluster, each handled
 * per the same discipline every prior round has used:
 *  - `foldEngagementSignal`, `getEmailContentPreview`,
 *    `leadMatchesSearchAndFilters`: used ONLY within this cluster (verified by
 *    grepping the whole class and the whole backend) — moved here directly and
 *    deleted from the class (zero remaining callers, zero test references).
 *  - `getCrmSenders`: used by this cluster's `sendEmailToLead`, by
 *    `AgentModeService.prototype.getSenderForLead` (part of the deferred
 *    `updateEmailDraftForLead`'s dependency chain), AND by `routes/webhooks.ts`
 *    directly (a real production caller found by grepping the whole backend,
 *    not just this cluster) — promoted to `emma/impl/shared/crmSenders.ts`,
 *    with `AgentModeService`'s own copy turned into a thin delegating method.
 *
 * ENG-2103 (F2 design-decision-list follow-up, Pattern A) — `importLeadsFromSearch`
 * added. Originally excluded from this cluster (far from it in the source
 * file, near line 36752 pre-extraction) because it does an "LLM batch
 * company-parse" via module-scope `batchParseCompaniesFromTitlesWithLLM(titles,
 * this, userId)` — the same `this.callLLM`-shaped coupling as
 * `updateEmailDraftForLead` above. Unlike `updateEmailDraftForLead`,
 * `batchParseCompaniesFromTitlesWithLLM` was ALREADY shaped for injection
 * (`gateway: Pick<AgentModeService, 'callLLM'> | null`, never read `this`
 * directly) — its only real change here is where it lives, not its logic —
 * so this method's own coupling is a plain injected-`callLLM`-parameter
 * (Pattern A) move, not a design decision of its own.
 *
 * `batchParseCompaniesFromTitlesWithLLM` and its Tier-2 regex sibling
 * `parseCompanyFromTitle` are ALSO needed by `emma/impl/linkedin.ts`'s
 * `resolveEmployersForSizeFilter` (moved in the same round) — since the two
 * target methods land in different modules, both helpers were promoted
 * verbatim to `emma/impl/shared/companyTitleParsing.ts` rather than
 * duplicated or living in just one of the two. `buildFindReason` and
 * `computeFindLeadsCriteriaHash` (module-scope in `agentModeService.ts`,
 * confirmed by whole-file grep to have exactly one caller each —
 * `importLeadsFromSearch` itself) moved here verbatim as non-exported local
 * helpers. `isAnonymizedSearchLead` (already a standalone `utils/` export,
 * shared with `outreachOnboardingSaveService.ts`) is now a static import
 * here instead of in `agentModeService.ts`. `mergeCustomFields` was already
 * imported by this module (`updateLead`'s own use) and is reused as-is.
 * `LINKEDIN_SEARCH_UNAVAILABLE_GUIDANCE` is imported LAZILY from `./linkedin`
 * inside the function body (`await import('./linkedin')`), NOT as a static
 * top-level import — a static import was tried first and failed
 * `leads.moduleIsolation.test.ts`'s "does not construct a DynamoDB client at
 * module scope" assertion, because `emma/impl/linkedin.ts` itself statically
 * imports `services/linkedInOutreachService.ts`, which statically imports
 * `services/db.ts` (a pre-existing, already-documented transitive load in
 * `linkedin.ts`'s own header — not new — but one `leads.ts` had never
 * inherited before this round, since it had no prior static dependency on
 * `linkedin.ts`). The constant already lived at `linkedin.ts` (cluster 16),
 * exported specifically because this method reads it (see that module's own
 * header comment); this is the first round it's actually consumed from its
 * new home rather than the old `agentModeService.ts` re-export.
 * `linkedInOutreachService` is imported lazily inside the function body,
 * matching this module's own established idiom (see `getLeadDetails`'s
 * LinkedIn-connection-status lookup above) rather than a new static
 * top-level import. `enqueueFindEmailJobForNewLeads` (the post-import
 * auto-enrich glue, a standalone export of `agentModeService.autoEnrich.ts`
 * — never actually defined in `agentModeService.ts` itself) was previously
 * called there ONLY via that file's own `__testHooks` re-export,
 * specifically so `agentModeService.importLeadsFromSearch.consolidated.test.ts`
 * could `jest.spyOn` it; here it's imported LAZILY as a namespace
 * (`const autoEnrichModule = await import('../../services/agentModeService.autoEnrich')`)
 * — also required to be lazy, not static, for the identical reason:
 * `agentModeService.autoEnrich.ts` statically imports
 * `services/crmFindEmailRunner.ts` → `services/enrichmentIdentityResolver.ts`
 * → `services/crmEnrichmentService.ts`, which statically imports
 * `services/agentModeService.ts` itself — a REAL (value-level, not just
 * type-level) circular import if taken statically. Node/Jest resolve a lazy
 * `await import(...)` to the exact same cached module instance a test's own
 * static `import * as autoEnrichModule from '...'` already loaded, so
 * `jest.spyOn(autoEnrichModule, 'enqueueFindEmailJobForNewLeads')` in the
 * test still intercepts this call correctly — confirmed by running that
 * test. `__testHooks` in `agentModeService.ts` no longer re-exports
 * `enqueueFindEmailJobForNewLeads` (orphan cleanup: it had no other caller).
 *
 * Kept as a delegating wrapper on `AgentModeService` — real caller beyond
 * `emma/tools.ts`: `routes/crm.ts`'s `POST /lists/:listId/leads/find` route
 * (confirmed by whole-backend grep), plus direct real-instance test calls in
 * `agentModeService.importLeadsFromSearch.consolidated.test.ts`. The class
 * wrapper now supplies `this.callLLM.bind(this)` as the injected `callLLM`
 * parameter; `emma/tools.ts`'s `import_leads_from_search` tool is repointed
 * to call this module directly (`callLLM` is `public` on `AgentModeService`,
 * same treatment as `create_html_from_template`).
 *
 * ENG-2103 (F2 design-decision-list follow-up, Pattern A) — `updateEmailDraftForLead`
 * added: the last leads/CRM-domain item on the design-decision list. Moved
 * verbatim from `AgentModeService.prototype.updateEmailDraftForLead`
 * (originally right after `sendEmailToLead` in the pre-extraction source —
 * placed the same way here). Confirmed by reading the full ~484-line method:
 * exactly two `this.callLLM` call sites — one drafts the email subject/body
 * JSON, the other (only when the lead has a LinkedIn URL) drafts a LinkedIn
 * connection-request note. Both injected via one narrow structural type,
 * `UpdateEmailDraftForLeadLlmCall` (the two call shapes this method actually
 * sends — not the full private `LLMCallOptions` interface this module must
 * not import anyway), same discipline as `emma/impl/htmlCreation.ts`'s
 * `CreateHtmlFromTemplateLlmCall`.
 *
 * `this.getReportGenerationDefaultModel()` picks the model for the email-body
 * call. It is a bare (no access-modifier keyword, hence `public`) instance
 * method whose own body reads `this.resolveConfiguredModel`/a private
 * settings-name field and falls back to `this.getDefaultModel()` — genuine
 * LLM-gateway/routing infrastructure, the same "never a candidate for
 * extraction, same category as `callLLM` itself" reasoning `createHtmlFromTemplate`
 * already applied to `getDefaultModel`/`resolveGenerationModel`. Injected as
 * `GetReportGenerationDefaultModelFn`, matching its real signature exactly.
 *
 * Three more cross-dependencies, each resolved on its own merits rather than
 * uniformly injected:
 *  - `this.readBrandGuidelines(userId)` / `this.readMarketStrategy(userId, opts)`
 *    are ALREADY fully decoupled — both are plain exported functions in
 *    `emma/impl/brandMarketStrategy.ts` with zero `this` dependency (confirmed
 *    by reading that module directly) — imported here by name instead of
 *    injected. `PROMPT_EMBEDDED_COMPETITOR_DETAIL` (the `minCompetitorsInFull`
 *    argument to `readMarketStrategy` — this prompt embeds the market-strategy
 *    doc's `formattedContent` wholesale, so it is NOT bounded by the normal
 *    tool-result page budget) is imported the same way.
 *  - `this.getSenderForLead(...)`, by contrast, is NOT decoupled — its real
 *    body still lives directly on `AgentModeService` (confirmed by reading the
 *    class directly: it is not a delegating wrapper into any module), and it
 *    reads `this.getCrmSenders(...)`. Its only real caller anywhere in the
 *    backend besides this method is a test spy — not enough of a second
 *    caller to justify promoting it to a shared module this round (unlike
 *    `getCrmSenders` itself, which had three real callers). Injected as
 *    `GetSenderForLeadFn` instead, matching the class method's real signature
 *    exactly — the same "moved method needs a still-unextracted sibling's
 *    capability" pattern as `AccountResolver`/`EmployerSizeFilterResolver`.
 *
 * ENG-1388 (card-revenue leak): `stripCardRevenueKeys(lead.customFields)` is
 * applied UNCONDITIONALLY before `customFields` reach the email-drafting
 * prompt — moved verbatim, unchanged. This is a real security control: card
 * revenue is internal-only (Enigma) data and must never inform content meant
 * for an external lead, regardless of whether the requesting user is
 * themselves Enigma-allowlisted (that allowlist governs internal visibility,
 * not what may go into outward-facing content). Re-landed here during the
 * 2026-09-29 main-sync merge (see this repo's own F2 progress notes) and
 * independently re-verified present, unconditional, and unchanged after this
 * move.
 *
 * ENG-2082 (phone-only-lead guard): the top-of-function guard
 * (`!lead.email && !lead.linkedin` → `skipped: true, reason: 'no_contact_channel'`)
 * and its extensive inline comments — explaining why the guard is
 * email-OR-linkedin rather than email-alone, why the email draft is
 * additionally gated on `lead.email` specifically, why the LinkedIn note is
 * gated on `lead.linkedin` specifically, and the several since-fixed bugs
 * where those two gates disagreed — are moved verbatim, unchanged.
 *
 * `shortenInviteNoteToLimit` (services/inviteNoteShortener.ts) wants the full
 * `Pick<AgentModeService, 'callLLM'>` shape (it is shared with the inline
 * LinkedIn-invite send path, outside this method's scope), not this method's
 * own narrower injected type — the injected `callLLM` is cast to that broader
 * type at the one call site that needs it. The underlying runtime value is
 * always the real `agentModeService.callLLM` either way; only the declared
 * type differs.
 *
 * Kept as a delegating wrapper on `AgentModeService` (not deleted): the
 * forward-lead webhook auto-draft path (`routes/webhooks.ts`, fire-and-forget
 * after lead capture, confirmed by whole-backend grep) calls
 * `agentModeService.updateEmailDraftForLead` directly and is the reason for
 * both the ENG-2082 and ENG-1388 guards in the first place, plus
 * `agentModeService.updateEmailDraftForLead.test.ts` calls this class method
 * directly on a real instance. `emma/tools.ts`'s `update_email_draft_for_lead`
 * tool is repointed to call this module directly (`callLLM` and
 * `getReportGenerationDefaultModel` are both `public` on `AgentModeService`,
 * same treatment as `create_html_from_template`/`import_leads_from_search`);
 * `getSenderForLead` is bound off the singleton the same way.
 */
import { suppressLeadSideEffects } from '../../utils/sessionList';
import { LEAD_STANDARD_FILTER_FIELDS, projectLeadAttribution, defaultStatusConfigFor, isLeadListType, missingReviewDraftError } from '../../utils/leadSchema';
import type { LeadImportRowOutcome, LeadListType } from '../../utils/leadSchema';
import { providerLabel } from '../../services/crmSenderTypes';
import { mergeCustomFields } from '../../utils/customFieldsGuard';
import { recoverLeadFromWrongList } from '../../services/agentMode/leadRecovery';
import { getCrmSenders } from './shared/crmSenders';
import { isAnonymizedSearchLead } from '../../utils/anonymizedLinkedInLead';
import { parseCompanyFromTitle, batchParseCompaniesFromTitlesWithLLM } from './shared/companyTitleParsing';
import { readBrandGuidelines, readMarketStrategy, PROMPT_EMBEDDED_COMPETITOR_DETAIL } from './brandMarketStrategy';
import { brandMessagingContextFromGuidelines } from '../../services/brandMessagingContext';
import { logOutreachClaimCheckShadow } from '../../services/outreachClaimCheck';
import type { AgentModeService } from '../../services/agentModeService';
import type { GatewayTaskClass } from '../../utils/openRouterGatewayContract';
import type { LLMUsageContext } from '../../utils/llmService';
import { matchLifecyclePresenceFilter } from '../../utils/lifecycleFilterSemantics';
import { isLinkedInInfraError, LINKEDIN_UNAVAILABLE_MESSAGE } from '../../utils/linkedInInfraError';

export async function getLeadLists(userId: string): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');
      const { listLandingPages, resolveLandingPageLiveUrl } = await import('../../services/v0Service');

      const [lists, landingPages] = await Promise.all([
        crmDb.getLeadListsForUser(userId),
        listLandingPages(userId).catch(() => [] as any[])
      ]);

      // Build map: leadListId → landing page info. Resolve each URL against the
      // domain actually attached to the Vercel project so a stale stored
      // subdomain isn't surfaced (AW-CustomDomains is the source of truth).
      const pageByListId = new Map<string, { pageId: string; name: string; url: string }>();
      const pagesWithLists = landingPages.filter((page: any) => page.leadListId);
      const resolvedUrls = await Promise.all(
        pagesWithLists.map((page: any) => resolveLandingPageLiveUrl(page))
      );
      pagesWithLists.forEach((page: any, idx: number) => {
        pageByListId.set(page.leadListId, {
          pageId: page.id,
          name: page.name || '',
          url: resolvedUrls[idx]
        });
      });

      return {
        success: true,
        message: `Found ${lists.length} lead list(s)`,
        lists: lists.map((list: any) => {
          const page = pageByListId.get(list.listId);
          return {
            listId: list.listId,
            name: list.name,
            description: list.description || '',
            leadCount: list.leadCount || 0,
            createdAt: list.createdAt,
            ...(page ? { associatedLandingPage: page } : {})
          };
        }),
        totalLists: lists.length
      };
    } catch (error) {
      console.error('AgentMode: Error listing lead lists:', error);
      return {
        success: false,
        message: 'Failed to list lead lists',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

export async function createLeadList(name: string, description: string, userId: string, listType?: LeadListType): Promise<any> {
    try {
      // listType is set-once, so a typo persisted here could never be corrected. The tool
      // schema's enum is advisory to the model, not enforced on direct callers.
      if (listType !== undefined && !isLeadListType(listType)) {
        return { success: false, message: 'Invalid list type', error: 'listType must be "sales", "customers" or "session"' };
      }
      const { crmDb } = await import('../../services/db');
      const list = await crmDb.createLeadList(userId, name, description, undefined, undefined, undefined, undefined, undefined, undefined, listType);

      return {
        success: true,
        message: `Lead list "${name}" created successfully`,
        list: {
          listId: list.listId,
          name: list.name,
          description: list.description || '',
          leadCount: list.leadCount || 0,
          createdAt: list.createdAt
        }
      };
    } catch (error) {
      console.error('AgentMode: Error creating lead list:', error);
      return {
        success: false,
        message: 'Failed to create lead list',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

export async function addLeadsToList(
    listId: string,
    leads: any[],
    userId: string,
    // The turn's real wall-clock cap (epoch ms), threaded in by the dispatcher.
    // The import budget is clamped to it so the write loop cannot outlive the
    // turn and lose the ledger (ENG-1133). Undefined when the caller imposes no
    // cap at all, in which case the flat budget stands.
    options: { turnDeadlineMs?: number } = {},
  ): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');

      // Verify list access
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return {
          success: false,
          message: 'Lead list not found',
          error: 'The specified lead list does not exist'
        };
      }

      const { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../../services/crmAccessControl');
      const hasAccessAddLeads = await canDestructiveCrmList(userId, list);
      if (!hasAccessAddLeads) {
        return {
          success: false,
          message: 'Access denied',
          error: CRM_EDITOR_REQUIRED_MESSAGE
        };
      }

      // Convert leads array to the format expected by batchCreateLeads
      // Extract standard fields and put everything else in customFields
      const standardFields = ['email', 'firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin', 'status', 'dealValue', 'dealCurrency'];
      const formattedLeads = leads.map((lead: any) => {
        const formatted: any = {};
        const customFields: Record<string, any> = {};

        // Extract standard fields if they exist
        standardFields.forEach(field => {
          if (lead[field] !== undefined) {
            formatted[field] = lead[field];
          }
        });

        // Put all other fields into customFields
        Object.keys(lead).forEach(key => {
          if (!standardFields.includes(key)) {
            customFields[key] = lead[key];
          }
        });

        if (Object.keys(customFields).length > 0) {
          formatted.customFields = customFields;
        }

        return formatted;
      });

      const { leadImportWriteBudgetMs } = await import('../../utils/leadImportLedger');
      const result = await crmDb.batchCreateLeads(listId, formattedLeads, {
        origin: 'enrichment_import',
        // A file the user may re-send after a truncated run: dedupe the rows
        // that carry no identity of their own, or every retry duplicates them.
        dedupeByNameCompany: true,
        // Come back with a resumable partial rather than being guillotined by
        // the whole-turn cap with nothing to report (ENG-1133). Clamped to the
        // run's remaining budget: a full-length budget started late in a turn
        // would outlive the turn and lose the ledger it exists to produce.
        deadlineMs: leadImportWriteBudgetMs(Date.now(), options.turnDeadlineMs),
      });

      // ENG-2996: new rows inherit the owner's do-not-contact flags and get
      // their emails validated, same as the portal's CSV/bulk import.
      const { applyLeadImportFollowups } = await import('../../services/leadImportFollowups');
      const followups = await applyLeadImportFollowups(listId, list.userId, result.created ?? [], {
        actingUserId: userId, validate: !suppressLeadSideEffects(list),
      });

      // ENG-1133: report the import row by row, not just in aggregate. A large
      // import can be cut off mid-way (the whole-turn cap fires between calls),
      // and "25 new lead(s) created" tells the next turn nothing about WHICH
      // rows landed — so the only offer left was "retry the whole request".
      const { buildLeadImportRowOutcomes, describeLeadRow, capLeadRowList, capLeadResumeRows, summarizeLeadRowNumbers } = await import('../../utils/leadImportLedger');
      const attempted = leads.length;
      const { outcomes, rowAligned } = buildLeadImportRowOutcomes(result, attempted);
      const tally = (outcome: LeadImportRowOutcome) => outcomes.filter(o => o === outcome).length;
      const reconciliation = {
        created: tally('created'),
        merged: tally('merged'),
        alreadyPresent: tally('already_present'),
        duplicateInRequest: tally('duplicate_in_request'),
        anonymizedSkipped: tally('anonymized_skipped'),
        failed: tally('failed'),
        unprocessed: tally('unprocessed'),
      };

      // Rows can only be NAMED when the ledger is in input order. Without it the
      // counts still reconcile, but pointing at a specific row would be a guess.
      const importedIdentifiers: string[] = [];
      const unimportedRows: Array<{ row: number; identifier: string; reason: LeadImportRowOutcome }> = [];
      if (rowAligned) {
        outcomes.forEach((outcome, index) => {
          const identifier = describeLeadRow(leads[index], index);
          if (outcome === 'created' || outcome === 'merged' || outcome === 'already_present') {
            importedIdentifiers.push(identifier);
          } else if (outcome === 'failed' || outcome === 'unprocessed') {
            unimportedRows.push({ row: index + 1, identifier, reason: outcome });
          }
        });
      }

      const landed = reconciliation.created + reconciliation.merged + reconciliation.alreadyPresent;
      const missing = reconciliation.failed + reconciliation.unprocessed;
      const complete = attempted > 0 && missing === 0;

      const messageParts: string[] = [];
      if (reconciliation.created > 0) {
        messageParts.push(`${reconciliation.created} new lead(s) created`);
      }
      if (reconciliation.merged > 0) {
        messageParts.push(`${reconciliation.merged} lead(s) merged`);
      }
      // A row already in the list, unchanged, is a completed row — saying so is
      // what makes re-sending a partially-imported file readable as progress
      // instead of as a failed import.
      if (reconciliation.alreadyPresent > 0) {
        messageParts.push(`${reconciliation.alreadyPresent} lead(s) already present and up to date`);
      }
      if (reconciliation.duplicateInRequest > 0) {
        messageParts.push(`${reconciliation.duplicateInRequest} duplicate row(s) in the request skipped`);
      }
      // ENG-1002 (follow-up): say so when rows were refused as anonymized
      // placeholders, so the agent cannot report a clean import that silently
      // wrote fewer records than the caller handed over.
      if (reconciliation.anonymizedSkipped > 0) {
        messageParts.push(`${reconciliation.anonymizedSkipped} out-of-network LinkedIn placeholder(s) skipped`);
      }
      if (reconciliation.failed > 0) {
        messageParts.push(`${reconciliation.failed} lead(s) failed`);
      }
      if (reconciliation.unprocessed > 0) {
        messageParts.push(`${reconciliation.unprocessed} lead(s) never processed`);
      }

      const summary = messageParts.length > 0
        ? `Successfully processed: ${messageParts.join(', ')}.`
        : 'No leads were processed.';
      // The resume list is budgeted by size, so every realistic partial names
      // every missing row. If a pathological one is still trimmed, saying so is
      // not optional: naming a slice is not a resume — the agent imports it,
      // gets a clean `complete: true` for that call and reports the import
      // finished, stranding the rest. `unimportedRowRanges` is the backstop that
      // is never trimmed: every missing position in the rows just sent, run
      // length encoded.
      const unimportedRowRanges = summarizeLeadRowNumbers(unimportedRows.map(r => r.row));
      const resume = unimportedRows.length > 0
        ? capLeadResumeRows('unimportedRows', unimportedRows)
        : {};
      const resumeShown = (resume.unimportedRows || []).length;
      const resumeTruncated = resumeShown > 0 && resumeShown < unimportedRows.length
        ? `unimportedRows details only the FIRST ${resumeShown} of ${unimportedRows.length} missing rows, `
          + `but unimportedRowRanges (${unimportedRowRanges}) lists EVERY missing position in the rows you just sent — resend all of them. `
          + `The import is not done until a result comes back with complete: true. `
        : '';
      // The list itself could not be read inside the budget, so nothing was
      // attempted. Resending the same rows would hit the same wall, so this is
      // a blocker to report — not the resume path every other partial takes.
      const dedupeIncomplete = (result as any).dedupeIncomplete === true;
      // A partial is worth resuming only while rows remain that were never
      // attempted: re-sending those makes progress. If nothing landed and every
      // row was attempted, they all failed on write — resending the same rows
      // would fail the same way, so that is a plain failure with no resume
      // offer, not a resume the agent will loop on.
      const resumable = !complete && attempted > 0 && !dedupeIncomplete
        && (landed > 0 || reconciliation.unprocessed > 0);
      const message = dedupeIncomplete
        ? `Import not attempted: this list has more existing leads than can be read within the import budget, `
          + `and importing without reading them first would duplicate rows already in the list. `
          + `No rows were written. Do NOT retry the same call — tell the user the list is too large to import into and needs splitting or a smaller list.`
        : attempted === 0
        ? 'No leads were processed.'
        : complete
          ? summary
          : !resumable
          ? `Import failed: none of the ${attempted} row(s) could be written. ${summary} `
            + `Every row was attempted, so re-sending them would fail the same way — `
            + `report the errors to the user instead of retrying.`
          : `Partial import: ${landed} of ${attempted} row(s) are in the list. ${summary} `
            + `RESUME by calling add_leads_to_list again with ONLY the ${unimportedRows.length > 0 ? 'rows listed in unimportedRows' : 'rows that did not import'} — `
            + `do not ask the user to retry the request. ${resumeTruncated}`
            + `Re-sending an already-imported row is safe (it merges instead of duplicating).`;

      return {
        // An incomplete import is NOT a tool failure, and must not be reported
        // as one. `success: false` is read at the dispatch boundary
        // (toolResultError → executePreparedTools) and downgrades the whole call
        // to a structured tool error: the model is then handed the message
        // string ALONE — `unimportedRows` and `reconciliation` never reach it —
        // the call is billed to failedFunctions, the CRM refresh is skipped, and
        // the appended retryability verdict tells the agent "do NOT retry […]
        // report the blocker to the user". That is precisely the whole-request
        // hand-off this ticket exists to remove. So failure is reserved for a
        // call that landed NOTHING AND has nothing left to resume; an import
        // that wrote rows, or still owes rows it never reached, succeeds while
        // carrying `complete: false` and its resume list. Success has to follow
        // the resume offer exactly — `success: false` beside `resumable: true`
        // would strip the resume list and tell the agent to stop, which is the
        // contradiction this ticket removes.
        success: complete || landed > 0 || resumable,
        complete,
        ...(resumable ? { resumable: true } : {}),
        message,
        attempted,
        // `reconciliation` is the ONLY set of counts on the wire. The legacy
        // scalars used to sit beside it and disagree with it: the DB layer's
        // `errorCount` tallies in-request duplicates together with genuine
        // write failures, so a clean import of a file containing one repeated
        // row reported `errorCount: 1` next to `failed: 0`, and a model reading
        // the payload could truthfully say a lead had failed when none had.
        // Two counts of the same thing is exactly the "numbers don't add up"
        // the ticket is about, so there is now one (ENG-1133).
        reconciliation,
        ...(followups.inheritedDoNotContact.length > 0 ? { inheritedDoNotContact: followups.inheritedDoNotContact.length } : {}),
        ...(followups.doNotContactCheckFailed > 0 ? { doNotContactCheckFailed: followups.doNotContactCheckFailed } : {}),
        ...(importedIdentifiers.length > 0 ? capLeadRowList('importedIdentifiers', importedIdentifiers) : {}),
        ...(unimportedRows.length > 0
          ? { ...resume, unimportedRowRanges }
          : {}),
        errors: result.errors.length > 0 ? result.errors : undefined
      };
    } catch (error) {
      console.error('AgentMode: Error adding leads to list:', error);
      return {
        success: false,
        message: 'Failed to add leads to list',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

// Preserve stored evidence only: missing suppression values must not imply active.
function projectLeadSuppression(lead: Record<string, any>): Record<string, any> {
  const fields = ['contactStatus', 'contactStatusReason', 'contactStatusNote',
    'contactStatusUpdatedAt', 'contactStatusUpdatedBy',
    'unsubscribedFromGroupEmail', 'unsubscribedFromGroupEmailAt'];
  return Object.fromEntries(fields.filter(field => lead[field] !== undefined)
    .map(field => [field, lead[field]]));
}

export async function getLeads(listId: string, userId: string, options: {
    search?: string;
    icpOnly?: boolean;
    engagedOnly?: boolean;
    status?: string;
    limit?: number;
    cursor?: string;
    // ENG-425: export callers (CSV) need the full row; without this they fan
    // out one get_lead_details call per lead. Off by default so the model's
    // compact browse rows (and token budget) are unchanged.
    includeAllFields?: boolean;
  } = {}): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');
      const limit = Math.min(Math.max(options.limit || 20, 1), 100);

      // Verify list ownership (org members can access lists owned by other org members)
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      const hasAccessGetLeads = await crmDb.canOrgMemberAccessList(userId, list);
      if (!hasAccessGetLeads) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to access this list' };
      }

      // Decode cursor from base64 JSON
      let decodedCursor: any = undefined;
      if (options.cursor) {
        try {
          decodedCursor = JSON.parse(Buffer.from(options.cursor, 'base64').toString('utf8'));
        } catch {
          // Invalid cursor — start from beginning
        }
      }

      const searchQuery = (options.search || '').trim().toLowerCase();
      const matchingLeads: any[] = [];
      let cursor: any = decodedCursor;

      // Use flag indexes for efficiency when filtering by ICP or engaged
      const useIcpIndex = options.icpOnly && !options.engagedOnly;
      const useEngagedIndex = options.engagedOnly && !options.icpOnly;

      // For unfiltered queries, fetch exactly `limit` items so cursor is exact
      const isFiltered = !!(searchQuery || options.status || options.icpOnly || options.engagedOnly);
      const pageSize = isFiltered ? 200 : limit;

      while (matchingLeads.length < limit) {
        let pageResult: any;

        if (useIcpIndex) {
          pageResult = await crmDb.getLeadsByICPFlag(listId, 1, pageSize, cursor);
        } else if (useEngagedIndex) {
          pageResult = await crmDb.getLeadsByEngagedFlag(listId, 1, pageSize, cursor);
        } else {
          pageResult = await crmDb.getLeadsByListId(listId, pageSize, cursor);
        }

        const leads = pageResult.items || [];

        for (const lead of leads) {
          if (matchingLeads.length >= limit) break;

          // Apply ICP filter (if using general index)
          if (options.icpOnly && !useIcpIndex && !lead.icpMatch?.isMatch) continue;
          // Apply engaged filter (if using general index)
          if (options.engagedOnly && !useEngagedIndex && !lead.isEngaged) continue;
          // Apply both filters when using ICP index but also need engaged
          if (options.icpOnly && options.engagedOnly && useIcpIndex && !lead.isEngaged) continue;
          if (options.icpOnly && options.engagedOnly && useEngagedIndex && !lead.icpMatch?.isMatch) continue;
          // Apply status filter
          if (options.status && (lead.status || null) !== options.status) continue;

          // Apply text search
          if (searchQuery) {
            const fields = [
              lead.email, lead.firstName, lead.lastName,
              `${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
              lead.company, lead.phone, lead.title, lead.notes, lead.linkedin
            ];
            const standardMatch = fields.some((v: any) => String(v || '').toLowerCase().includes(searchQuery));
            if (!standardMatch) {
              const customFields = lead.customFields && typeof lead.customFields === 'object' ? lead.customFields : {};
              const customMatch = Object.values(customFields).some((v: any) => String(v || '').toLowerCase().includes(searchQuery))
                || Object.keys(customFields).some((k: string) => k.toLowerCase().includes(searchQuery));
              if (!customMatch) continue;
            }
          }

          matchingLeads.push(lead);
        }

        cursor = pageResult.lastEvaluatedKey;
        if (!cursor) break;
        if (!isFiltered) break; // exact fetch: one page is enough
      }

      const nextCursor = cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64') : undefined;

      // ENG-425: full export fields. Same card-revenue boundary as
      // getLeadDetails (ENG-1388) — org-shared lists must not leak Enigma
      // card revenue to a non-allowlisted caller through the bulk path.
      let fullFieldProjector: ((lead: any) => Record<string, any>) | null = null;
      if (options.includeAllFields) {
        const { sanitizeEnrichmentMetadataForResponse, stripCardRevenueKeys, shouldHideCardRevenueForViewer } = await import('../../utils/enrichmentMetadataPresentation');
        const hide = shouldHideCardRevenueForViewer(userId);
        fullFieldProjector = (lead: any) => {
          const meta = sanitizeEnrichmentMetadataForResponse(lead.enrichmentMetadata as Record<string, any> | undefined);
          return {
            listId: lead.listId || listId,
            notes: lead.notes || '',
            linkedin: lead.linkedin || '',
            customFields: hide ? (stripCardRevenueKeys(lead.customFields) ?? {}) : (lead.customFields || {}),
            ...(meta ? { enrichmentMetadata: hide ? stripCardRevenueKeys(meta) : meta } : {}),
            createdAt: lead.createdAt || null,
            updatedAt: lead.updatedAt || null,
          };
        };
      }

      return {
        success: true,
        // ENG-1207: same contract as searchLeads — a truncated page must not be
        // phrased as a total.
        message: cursor
          ? `Showing the first ${matchingLeads.length} lead(s); more remain — pass next_cursor to continue.`
          : `Found ${matchingLeads.length} lead(s)`,
        leads: matchingLeads.map((lead: any) => ({
          leadId: lead.leadId,
          email: lead.email || '',
          // ENG-2082: a phone-only lead is contactable. Omitting the number here showed the
          // model a row with NO contact channel at all, which reads as junk — and
          // `email is_empty` in delete_leads_by_filter matches exactly these rows.
          phone: lead.phone || '',
          firstName: lead.firstName || '',
          lastName: lead.lastName || '',
          company: lead.company || '',
          title: lead.title || '',
          status: lead.status || null,
          dealValue: lead.dealValue ?? null,
          dealCurrency: lead.dealCurrency || 'USD',
          icpMatch: lead.icpMatch?.isMatch || false,
          icpScore: lead.icpMatch?.score || null,
          engagementCount: lead.engagementCount || 0,
          isEngaged: lead.isEngaged || false,
          // ENG-1175 AC2 — the list path returns the same attribution shape as
          // the detail path. Spread last so it can only add keys, never shadow
          // an existing one; absent attribution adds nothing at all.
          ...projectLeadAttribution(lead),
          ...projectLeadSuppression(lead),
          ...(fullFieldProjector ? fullFieldProjector(lead) : {}),
        })),
        matchCount: matchingLeads.length,
        listName: list.name,
        has_more: !!cursor,
        ...(nextCursor && { next_cursor: nextCursor }),
      };
    } catch (error) {
      console.error('AgentMode: Error getting leads:', error);
      return { success: false, message: 'Failed to get leads', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

function leadMatchesSearchAndFilters(
    lead: any,
    filters: Array<{ field: string; operator: string; value?: any }>,
    searchQuery: string,
    // readonly: callers pass the shared LEAD_STANDARD_FILTER_FIELDS constant
    // (ENG-1218), which must not be mutable through this parameter — a callee
    // reordering or trimming it would silently change how the OTHER resolver
    // behaves, which is the class of bug this constant exists to end.
    standardFields: readonly string[],
  ): boolean {
    if (searchQuery) {
      const fields = [
        lead.email, lead.firstName, lead.lastName,
        `${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
        lead.company, lead.phone, lead.title, lead.notes, lead.linkedin
      ];
      const standardMatch = fields.some((v: any) => String(v || '').toLowerCase().includes(searchQuery));
      if (!standardMatch) {
        const customFields = lead.customFields && typeof lead.customFields === 'object' ? lead.customFields : {};
        const customMatch = Object.values(customFields).some((v: any) => String(v || '').toLowerCase().includes(searchQuery))
          || Object.keys(customFields).some((k: string) => k.toLowerCase().includes(searchQuery));
        if (!customMatch) return false;
      }
    }

    return filters.every((filter: any) => {
      const { field, operator, value } = filter;
      const lifecyclePresenceMatch = matchLifecyclePresenceFilter(field, operator);
      if (lifecyclePresenceMatch !== undefined) return lifecyclePresenceMatch;

      let fieldValue: any;
      if (field === 'icpScore') {
        fieldValue = lead.icpMatch?.score;
      } else if (field === 'icpMatch') {
        fieldValue = lead.icpMatch?.isMatch;
      } else if (field === 'engagementCount') {
        fieldValue = lead.engagementCount;
      } else if (standardFields.includes(field)) {
        fieldValue = lead[field];
      } else if (field.includes('.')) {
        const parts = field.split('.');
        fieldValue = parts.reduce((obj: any, part: string) => obj?.[part], lead);
      } else {
        fieldValue = lead.customFields?.[field];
      }

      switch (operator) {
        case 'is_empty':
          return fieldValue === null || fieldValue === undefined || fieldValue === '';
        case 'is_not_empty':
          return fieldValue !== null && fieldValue !== undefined && fieldValue !== '';
        case 'equals':
          if (typeof fieldValue === 'boolean') return fieldValue === value;
          return String(fieldValue || '').toLowerCase() === String(value || '').toLowerCase();
        case 'not_equals':
          return String(fieldValue || '').toLowerCase() !== String(value || '').toLowerCase();
        case 'contains':
          return String(fieldValue || '').toLowerCase().includes(String(value || '').toLowerCase());
        case 'starts_with':
          return String(fieldValue || '').toLowerCase().startsWith(String(value || '').toLowerCase());
        case 'ilike': {
          const pattern = String(value ?? '');
          const regexStr = pattern.split('').map((c: string) => {
            if (c === '%') return '.*';
            if (c === '_') return '.';
            return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          }).join('');
          return new RegExp(`^${regexStr}$`, 'i').test(String(fieldValue ?? ''));
        }
        case 'greater_than': {
          const numFv = Number(fieldValue);
          const numV = Number(value);
          if (!isNaN(numFv) && !isNaN(numV)) return numFv > numV;
          return String(fieldValue || '') > String(value || '');
        }
        case 'less_than': {
          const numFv = Number(fieldValue);
          const numV = Number(value);
          if (!isNaN(numFv) && !isNaN(numV)) return numFv < numV;
          return String(fieldValue || '') < String(value || '');
        }
        case 'in': {
          // Membership test against a value array. Used by v3.1 enrichment-
          // config lead filters (`industry in [SaaS, Fintech, ...]`).
          // Case-insensitive string compare matches existing `equals` convention.
          // Malformed value (non-array) → fail-safe to no-match.
          if (!Array.isArray(value)) return false;
          const fv = String(fieldValue ?? '').toLowerCase();
          return value.some((v: any) => String(v ?? '').toLowerCase() === fv);
        }
        case 'not_in': {
          if (!Array.isArray(value)) return false;
          const fv = String(fieldValue ?? '').toLowerCase();
          // Empty exclude list → matches everything (vacuously not in nothing).
          return !value.some((v: any) => String(v ?? '').toLowerCase() === fv);
        }
        default:
          return false;
      }
    });
  }

export async function searchLeads(
    listId: string | undefined,
    filters: Array<{ field: string; operator: string; value?: any }>,
    userId: string,
    limit?: number,
    options?: { search?: string; cursor?: string; listIds?: string[] },
  ): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');
      const { sanitizeEnrichmentMetadataForResponse, stripCardRevenueKeys, shouldHideCardRevenueForViewer } = await import('../../utils/enrichmentMetadataPresentation');
      const hideCardRevenueForCaller = shouldHideCardRevenueForViewer(userId);
      const effectiveLimit = Math.min(Math.max(limit || 20, 1), 100);

      // ENG-2360: a list-scoped read (non-empty list_id or list_ids) with no
      // filters/search is a valid "page through these lists" intent. Only a
      // call with no filters, no search AND no list scope is rejected.
      const hasListScope = Boolean(listId) || Boolean(options?.listIds && options.listIds.length > 0);
      if ((!filters || filters.length === 0) && !options?.search?.trim() && !hasListScope) {
        return {
          success: false,
          message: 'At least one filter, a search query, or a list_id/list_ids is required',
          error: 'Provide at least one filter criterion, a search query, or list_id/list_ids to scope the read',
        };
      }
      filters = Array.isArray(filters) ? filters : [];

      // Resolve target list set. list_ids takes precedence over single list_id.
      let targetListIds: string[];
      let isMultiList: boolean;
      if (options?.listIds && options.listIds.length > 0) {
        if (options.listIds.length > 5) {
          return {
            success: false,
            message: 'Too many lists. Pass at most 5 list_ids per call (use ask_crm for cross-CRM questions).',
            error: 'list_ids exceeds the 5-list cap',
          };
        }
        isMultiList = true;
        targetListIds = options.listIds;
      } else if (listId) {
        isMultiList = false;
        targetListIds = [listId];
      } else {
        return { success: false, message: 'list_id or list_ids is required', error: 'Provide either list_id or list_ids' };
      }

      // Decode cursor (supports new multi-list shape and legacy single-list {listId, leadId}).
      let decodedCursor: any = undefined;
      if (options?.cursor) {
        try {
          decodedCursor = JSON.parse(Buffer.from(options.cursor, 'base64').toString('utf8'));
        } catch {
          // Invalid cursor — treat as start.
        }
      }

      let cursorListIds: string[] = targetListIds;
      let cursorStartIdx = 0;
      let cursorInnerLeadId: string | null = null;
      if (decodedCursor) {
        if (Array.isArray(decodedCursor.listIds)) {
          // New multi-list cursor: trust the frozen list set so the page sequence
          // is stable even if the caller's list_ids changed between calls.
          cursorListIds = decodedCursor.listIds;
          cursorStartIdx = Math.max(0, Number(decodedCursor.currentIdx) || 0);
          cursorInnerLeadId = decodedCursor.leadId || null;
        } else if (decodedCursor.leadId) {
          // Legacy single-list cursor.
          cursorInnerLeadId = decodedCursor.leadId;
        }
      }

      // Resolve and access-check each list. In single-list mode an inaccessible
      // list_id is a hard error; in multi-list mode we skip and record the list ID
      // in skipped_list_ids so callers can distinguish a permission skip from an
      // empty result.
      type ListEntry = { listId: string; list: any } | null;
      const lists: ListEntry[] = [];
      const skippedListIds: string[] = [];
      for (let i = 0; i < cursorListIds.length; i++) {
        const id = cursorListIds[i];
        const list = await crmDb.getLeadListById(id);
        if (!list) {
          if (!isMultiList) return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
          skippedListIds.push(id);
          lists.push(null);
          continue;
        }
        const access = await crmDb.canOrgMemberAccessList(userId, list);
        if (!access) {
          if (!isMultiList) return { success: false, message: 'Access denied', error: 'You do not have permission to access this list' };
          skippedListIds.push(id);
          lists.push(null);
          continue;
        }
        lists.push({ listId: id, list });
      }

      const searchQuery = (options?.search || '').trim().toLowerCase();
      // `clickIds` is the denormalized top-level attribution field (ENG-1176).
      // It has to be listed here or the resolver falls through to
      // `lead.customFields.clickIds` and answers "0% of your leads carry a click
      // ID" — indistinguishable from a broken tag, and wrong. The dot form
      // (`clickIds.gclid`) resolves on its own and never had this problem.
      //
      // NOTE: `utmSource` / `utmMedium` have the same latent bug and are
      // deliberately NOT fixed here — promoting them changes how an existing
      // filter behaves for anyone with a same-named custom field, which is a
      // separate seam. Tracked on ENG-1175.
      // ENG-1218: shared with the other filter resolver. A field missing here
      // does not error — it resolves to customFields[field], so `is_empty`
      // matches EVERY lead. On the destructive path that is data loss behind a
      // confirm gate whose preview looks correct.
      const standardFields = LEAD_STANDARD_FILTER_FIELDS as readonly string[];
      const matchingLeads: Array<{ lead: any; listId: string; listName: string }> = [];

      let stopIdx = -1;
      let stopLeadId: string | null = null;

      outer:
      for (let listIdx = cursorStartIdx; listIdx < lists.length; listIdx++) {
        const entry = lists[listIdx];
        if (!entry) continue;
        const { listId: curListId, list } = entry;

        // Inner cursor only applies to the very first list scanned; subsequent
        // lists in the same call always start from the top.
        let inputCursor: any = undefined;
        if (listIdx === cursorStartIdx && cursorInnerLeadId) {
          inputCursor = { listId: curListId, leadId: cursorInnerLeadId };
        }

        let lastScannedLeadId: string | null = null;
        let hitLimit = false;

        while (true) {
          const pageResult = await crmDb.getLeadsByListId(curListId, 200, inputCursor);
          const leads = pageResult.items || [];

          for (const lead of leads) {
            lastScannedLeadId = lead.leadId;
            if (leadMatchesSearchAndFilters(lead, filters, searchQuery, standardFields)) {
              matchingLeads.push({ lead, listId: curListId, listName: list.name });
              if (matchingLeads.length >= effectiveLimit) {
                hitLimit = true;
                break;
              }
            }
          }

          if (hitLimit) break;
          inputCursor = pageResult.lastEvaluatedKey;
          if (!inputCursor) break;
        }

        if (hitLimit) {
          stopIdx = listIdx;
          stopLeadId = lastScannedLeadId;
          break outer;
        }
      }

      // Build next cursor. Use the multi-list shape when in multi-list mode so
      // callers can resume; legacy mode keeps the {listId, leadId} shape.
      let cursorOut: any = null;
      if (stopIdx >= 0 && stopLeadId) {
        if (isMultiList) {
          cursorOut = { listIds: cursorListIds, currentIdx: stopIdx, leadId: stopLeadId };
        } else {
          cursorOut = { listId: cursorListIds[stopIdx], leadId: stopLeadId };
        }
      }
      const nextCursor = cursorOut ? Buffer.from(JSON.stringify(cursorOut)).toString('base64') : undefined;

      const firstResolved = lists.find((e: ListEntry) => !!e);

      return {
        success: true,
        // ENG-1207: only an exhausted scan may be phrased as a total. When the
        // scan stopped at the caller's limit, say so — a bare "Found 20" reads
        // as "there are 20", which is how a weak model concluded a 98-match
        // filter had 20 hits, wrote 17 of them and reported the job complete
        // (prod session d5898ffd). The true total is deliberately NOT stated:
        // the scan breaks at the limit, so it was never counted and any "of N"
        // here would be invented.
        message: cursorOut
          ? `Showing the first ${matchingLeads.length} matching lead(s); more remain — pass next_cursor to continue.`
          : `Found ${matchingLeads.length} matching lead(s)`,
        leads: matchingLeads.map((entry) => {
          // Per-field provenance sidecar — lets the agent cite source, provider,
          // URL and confidence per field for list-wide queries (e.g. "funding
          // stage for each lead"), instead of reporting bare values. Sanitized so
          // cross-tenant CRM-history lineage (sibling IDs) never reaches the
          // customer — mirrors get_lead_details and the customer-portal REST path.
          const sanitizedEnrichmentMetadata = sanitizeEnrichmentMetadataForResponse(
            entry.lead.enrichmentMetadata as Record<string, any> | undefined,
          );
          return {
            leadId: entry.lead.leadId,
            ...(isMultiList ? { listId: entry.listId, listName: entry.listName } : {}),
            email: entry.lead.email || '',
            // ENG-2082: see get_leads — a phone-only lead has a contact channel; show it.
            phone: entry.lead.phone || '',
            firstName: entry.lead.firstName || '',
            lastName: entry.lead.lastName || '',
            company: entry.lead.company || '',
            title: entry.lead.title || '',
            icpMatch: entry.lead.icpMatch?.isMatch || false,
            icpScore: entry.lead.icpMatch?.score || null,
            engagementCount: entry.lead.engagementCount || 0,
            isEngaged: entry.lead.isEngaged || false,
            customFields: hideCardRevenueForCaller
              ? (stripCardRevenueKeys(entry.lead.customFields) ?? {})
              : (entry.lead.customFields || {}),
            ...(sanitizedEnrichmentMetadata
              ? { enrichmentMetadata: hideCardRevenueForCaller ? stripCardRevenueKeys(sanitizedEnrichmentMetadata) : sanitizedEnrichmentMetadata }
              : {}),
            // ENG-1175. This is the call both launch gates make to answer "did
            // the gclid survive to the stored row?" — Google Pre-Launch Gate
            // step 6.6 and the Meta gate's T11. Without these fields the gate
            // reads a lead with no attribution in it and reports a BLOCK on a
            // correctly-attributed lead.
            ...projectLeadAttribution(entry.lead),
            ...projectLeadSuppression(entry.lead),
          };
        }),
        matchCount: matchingLeads.length,
        ...(!isMultiList && firstResolved ? { listName: firstResolved.list.name } : {}),
        ...(isMultiList ? {
          listsScanned: lists.filter((e: ListEntry): e is { listId: string; list: any } => !!e)
            .map((e) => ({ listId: e.listId, listName: e.list.name })),
          skipped_list_ids: skippedListIds,
        } : {}),
        has_more: !!cursorOut,
        ...(nextCursor && { next_cursor: nextCursor }),
      };
    } catch (error) {
      console.error('AgentMode: Error searching leads:', error);
      return { success: false, message: 'Failed to search leads', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Helper function to extract text preview from emailContent field.
   * The emailContent can be either a string (legacy) or an object with html/text properties.
   */
function getEmailContentPreview(emailContent: any, maxLength: number): string | undefined {
    if (!emailContent) {
      return undefined;
    }

    let textContent: string;

    // Handle object format (new format with html/text properties)
    if (typeof emailContent === 'object' && !Array.isArray(emailContent)) {
      // Prefer html over text, but use whichever is available
      textContent = emailContent.html || emailContent.text || '';
    }
    // Handle string format (legacy format)
    else if (typeof emailContent === 'string') {
      textContent = emailContent;
    }
    else {
      return undefined;
    }

    // Strip HTML tags and truncate
    const plainText = textContent.replace(/<[^>]*>/g, '').trim();
    if (plainText.length === 0) {
      return undefined;
    }

    return plainText.length > maxLength
      ? plainText.substring(0, maxLength) + '...'
      : plainText;
  }

/**
 * `options` (ENG-2840 W2-5a, set only by the MCP lead tools): `maxContentFetches` bounds the email bodies one read fetches from the mail provider
 * (see crmDb.getLeadEngagements); `recoverStaleList: false` skips the search of the caller's other lists for a lead that is not in `listId`.
 * That search costs one AW-LeadLists query per organization member plus batched lead reads, and AW-LeadLists is provisioned at 5 read units, so
 * it is not offered to an API key that can repeat it 60 times a minute. Without options (Emma, the portal, the readback verifier) nothing changes.
 */
export async function getLeadDetails(listId: string, leadId: string, userId: string, options?: { maxContentFetches?: number; recoverStaleList?: boolean }): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');
      const { sanitizeEnrichmentMetadataForResponse, stripCardRevenueKeys, shouldHideCardRevenueForViewer } = await import('../../utils/enrichmentMetadataPresentation');
      // ENG-1388: this list may be org-shared, and canOrgMemberAccessList above
      // has no Enigma-allowlist awareness — strip card revenue for a caller
      // who isn't allowlisted, same boundary as the customer-portal REST path.
      const hideCardRevenueForCaller = shouldHideCardRevenueForViewer(userId);

      // Verify list ownership (org members can access lists owned by other org members)
      let list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      const hasAccessGetLeadDetails = await crmDb.canOrgMemberAccessList(userId, list);
      if (!hasAccessGetLeadDetails) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to access this list' };
      }

      const requestedListId = listId;
      let lead = await crmDb.getLeadById(listId, leadId);
      let correctedListId: string | null = null;
      if (!lead && options?.recoverStaleList !== false) {
        // ENG-969 follow-up: the requested list_id may just be stale/wrong
        // rather than the lead not existing at all. See leadRecovery.ts for
        // the full rationale (tiering, retry, and why it always fails safe).
        const found = await recoverLeadFromWrongList(crmDb, userId, requestedListId, leadId);
        if (found) {
          lead = found;
          listId = found.listId;
          correctedListId = found.listId;
        }
      }
      if (!lead) {
        return { success: false, message: 'Lead not found', error: 'The specified lead does not exist in this list' };
      }
      if (correctedListId) {
        // Point `list` at the list the lead actually belongs to (never mutate the
        // fetched record in place) — downstream code reads list.linkedInAccountId,
        // which is per-list.
        const correctedList = await crmDb.getLeadListById(correctedListId);
        if (correctedList) list = correctedList;
      }

      // Per-field provenance sidecar — lets the agent answer "where does this
      // value come from?" (e.g. funding_stage / ARR) with a real source,
      // provider, URL, confidence and freshness instead of guessing. Sanitized
      // so cross-tenant CRM-history lineage (sibling IDs) never reaches the
      // customer — mirrors what the customer-portal REST routes already expose.
      const sanitizedEnrichmentMetadata = sanitizeEnrichmentMetadataForResponse(
        lead.enrichmentMetadata as Record<string, any> | undefined,
      );

      // Check LinkedIn connection status from cache (non-blocking, swallows errors)
      let linkedInConnectionStatus: {
        isConnected: boolean;
        connectedAt?: string;
        connectedAtTimestamp?: number;
      } | null = null;
      if (lead.linkedin) {
        // Prefer the account explicitly assigned to the list; fall back to the
        // user's own connected LinkedIn (Unipile) account. Most lists never get an
        // account assigned (list.linkedInAccountId is null), so without this
        // fallback every lead reports "not connected" even when the user is a
        // genuine 1st-degree connection — the misinformation reported in ENG-376.
        let accountId: string | null = (list as any).linkedInAccountId ?? null;
        if (!accountId) {
          const { linkedInOutreachService } = await import('../../services/linkedInOutreachService');
          accountId = await linkedInOutreachService.resolveUserOwnedAccountId(userId).catch(() => null);
        }
        if (accountId) {
          const { getConnectionByProfileUrlAndAccount } = await import('../../services/unipileConnectionsDb');
          const conn = await getConnectionByProfileUrlAndAccount(lead.linkedin as string, accountId).catch(() => null);
          linkedInConnectionStatus = conn
            ? {
                // conn.connectedAt is already an epoch-millisecond timestamp
                // (Unipile created_at), so it must NOT be multiplied by 1000 —
                // doing so pushed the date ~56,000 years into the future (ENG-379).
                isConnected: true,
                connectedAt: new Date(conn.connectedAt).toISOString(),
                connectedAtTimestamp: conn.connectedAt,
              }
            : { isConnected: false };
        } else {
          linkedInConnectionStatus = { isConnected: false };
        }
      }

      // Get engagement count and recent engagements
      const [engagementCount, engagementsResult] = await Promise.all([
        crmDb.getLeadEngagementCount(listId, leadId, userId),
        options ? crmDb.getLeadEngagements(listId, leadId, userId, options) : crmDb.getLeadEngagements(listId, leadId, userId)
      ]);
      const engagements = engagementsResult.engagements || [];
      const customFields = lead.customFields || {};

      // Truncate HTML email drafts to text preview
      let emailDraftPreview = null;
      if (lead.emailDraft) {
        const draft = lead.emailDraft;
        emailDraftPreview = {
          subject: draft.subject || '',
          format: draft.format || 'text',
          contentPreview: draft.htmlContent
            ? draft.htmlContent.replace(/<[^>]*>/g, '').substring(0, 200) + (draft.htmlContent.length > 200 ? '...' : '')
            : (draft.textContent || '').substring(0, 200) + ((draft.textContent || '').length > 200 ? '...' : ''),
          hasFullContent: true
        };
      }

      return {
        success: true,
        message: `Lead details for ${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
        // Tell the caller the list_id it passed was wrong so it corrects its own
        // working state for later calls, instead of repeating the same mismatch.
        ...(correctedListId
          ? { note: `list_id "${requestedListId}" does not contain this lead. Corrected to its actual list_id "${correctedListId}" — use that for future calls with lead_id "${leadId}".` }
          : {}),
        lead: {
          leadId: lead.leadId,
          listId: lead.listId,
          email: lead.email || '',
          firstName: lead.firstName || '',
          lastName: lead.lastName || '',
          company: lead.company || '',
          title: lead.title || '',
          phone: lead.phone || '',
          notes: lead.notes || '',
          linkedin: lead.linkedin || '',
          linkedInConnectionStatus,
          customFields: hideCardRevenueForCaller
            ? (stripCardRevenueKeys(lead.customFields) ?? {})
            : (lead.customFields || {}),
          ...(sanitizedEnrichmentMetadata
            ? { enrichmentMetadata: hideCardRevenueForCaller ? stripCardRevenueKeys(sanitizedEnrichmentMetadata) : sanitizedEnrichmentMetadata }
            : {}),
          icpMatch: lead.icpMatch || null,
          isEngaged: lead.isEngaged || false,
          emailDraft: emailDraftPreview,
          messageDraft: lead.messageDraft || null,
          selectedSenderId: lead.selectedSenderId || null,
          createdAt: lead.createdAt,
          updatedAt: lead.updatedAt,
          // ENG-1175 AC1 — firstTouch when one exists, the field omitted
          // entirely when it does not. Never an empty object: that would report
          // "capture ran and found nothing" for a lead capture never touched.
          ...projectLeadAttribution(lead),
          ...projectLeadSuppression(lead),
        },
        engagementSummary: {
          total: engagementCount.total,
          last7Days: engagementCount.last7Days,
          totalAllMessages: engagementCount.totalAllMessages
        },
        recentEngagements: engagements.slice(0, 10).map((eng: any) => ({
          eventType: eng.eventType,
          createdAt: eng.createdAt,
          eventData: eng.eventData || {},
          // Truncate email content for preview
          emailContentPreview: getEmailContentPreview(eng.emailContent, 150)
        })),
        listName: list.name
      };
    } catch (error) {
      console.error('AgentMode: Error getting lead details:', error);
      return { success: false, message: 'Failed to get lead details', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * List-level "accepted-but-not-followed-up" query for LinkedIn outreach lists.
   *
   * Answers "which leads accepted my invite but still need a follow-up?" WITHOUT
   * the N+1 get_lead_details fan-out the old path required. All the cross-lead
   * signal is loaded in a constant number of queries:
   *   - one getAllConnectionsByAccount(accountId) -> who is connected + connectedAt
   *   - one getEventsByEmailDomain(`linkedin-{listId}`) -> LinkedIn message direction/timestamps
   *   - one getEventsByEmailDomain(userEmailDomain) -> email message direction/timestamps
   *   - a bounded scan of getLeadsByListId pages for the leads themselves
   *
   * A lead is "needs follow-up" when it is a 1st-degree connection (the invite
   * was accepted) and there is no OUTBOUND touch after connectedAt — i.e. either
   * we never messaged them post-accept, or they replied and we owe a response
   * (awaitingReply=true).
   */
export async function getLeadsNeedingFollowup(listId: string, userId: string, options: {
    limit?: number;
    scanLimit?: number;
  } = {}): Promise<any> {
    try {
      const { crmDb, userDb } = await import('../../services/db');
      const limit = Math.min(Math.max(options.limit || 25, 1), 100);
      const scanLimit = Math.min(Math.max(options.scanLimit || 2000, 1), 5000);

      // Verify list access (org-aware).
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      const hasAccess = await crmDb.canOrgMemberAccessList(userId, list);
      if (!hasAccess) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to access this list' };
      }

      // ENG-2937: most lists never get an explicit linkedInAccountId, which made
      // this tool fail 100% of the time. Fall back to the caller's own connected
      // LinkedIn account — the same resolution the CRM routes use (crm.ts).
      let accountId: string | null = (list as any).linkedInAccountId ?? null;
      if (!accountId) {
        const { linkedInOutreachService } = await import('../../services/linkedInOutreachService');
        accountId = await linkedInOutreachService.resolveUserOwnedAccountId(userId).catch(() => null);
      }
      if (!accountId) {
        return {
          success: false,
          message: 'No LinkedIn account connected',
          error: 'Follow-up detection needs a connected LinkedIn account to resolve connection status. Ask the user to connect LinkedIn (or assign an account to this list in its settings), then retry. Do not retry before that.',
        };
      }

      // --- Constant-query signal loading (NO per-lead fan-out) ---
      const { emailEventsDb } = await import('../../services/emailEventsDb');
      const { getAllConnectionsByAccount, normalizeLinkedInUrl } = await import('../../services/unipileConnectionsDb');
      const user = await userDb.getUserById(userId);
      const emailDomain = user?.emailDomain?.trim();

      const [connections, linkedInEvents, emailEvents] = await Promise.all([
        getAllConnectionsByAccount(accountId).catch(() => []),
        emailEventsDb.getEventsByEmailDomain(`linkedin-${listId}`).catch(() => []),
        emailDomain ? emailEventsDb.getEventsByEmailDomain(emailDomain).catch(() => []) : Promise.resolve([]),
      ]);

      // connectedAt (epoch milliseconds) keyed by normalized profile URL.
      const connectedAtByUrl = new Map<string, number>();
      for (const c of connections as any[]) {
        const url = String(c?.publicProfileUrl || '').trim().toLowerCase();
        if (!url) continue;
        const ts = typeof c?.connectedAt === 'number' ? c.connectedAt : 0;
        const existing = connectedAtByUrl.get(url);
        if (existing === undefined || ts < existing) connectedAtByUrl.set(url, ts); // earliest connect wins
      }

      // Build last-engagement signal keyed by lead identity. LinkedIn events are
      // keyed by normalized profile URL; email events by lead email.
      type Signal = { at: number; type: string; direction: 'inbound' | 'outbound' };
      const directionOf = (eventType: string): 'inbound' | 'outbound' =>
        /received|replied/i.test(eventType) ? 'inbound' : 'outbound';

      const linkedInSignalByUrl = new Map<string, Signal>();
      for (const e of linkedInEvents as any[]) {
        const url = String(e?.leadEmail || '').trim().toLowerCase();
        if (!url) continue;
        foldEngagementSignal(linkedInSignalByUrl, url, e, directionOf);
      }
      const emailSignalByEmail = new Map<string, Signal>();
      for (const e of emailEvents as any[]) {
        const email = String(e?.leadEmail || '').trim().toLowerCase();
        if (!email) continue;
        foldEngagementSignal(emailSignalByEmail, email, e, directionOf);
      }

      // --- Scan leads (bounded) and segment in memory ---
      const matches: any[] = [];
      let scanned = 0;
      let cursor: any = undefined;
      let scannedAll = true;
      while (scanned < scanLimit) {
        const page = await crmDb.getLeadsByListId(listId, 200, cursor);
        const items: any[] = page.items || [];
        for (const lead of items) {
          scanned++;
          if (!lead.linkedin) continue;
          const url = normalizeLinkedInUrl(String(lead.linkedin)).toLowerCase();
          const connectedAt = connectedAtByUrl.get(url);
          if (connectedAt === undefined) continue; // not connected -> invite not accepted yet

          // Merge LinkedIn + email signals for this lead; the most recent wins.
          const leadEmail = String(lead.email || '').trim().toLowerCase();
          const candidates: Signal[] = [];
          const liSig = linkedInSignalByUrl.get(url);
          if (liSig) candidates.push(liSig);
          const emSig = leadEmail ? emailSignalByEmail.get(leadEmail) : undefined;
          if (emSig) candidates.push(emSig);

          const last = candidates.sort((a, b) => b.at - a.at)[0];

          // The ball is in THEIR court (already followed up, waiting on them)
          // when the most-recent engagement is an outbound touch sent after the
          // connection was accepted. A later inbound reply flips it back to
          // "needs follow-up" (awaitingReply) since we now owe the response.
          // connectedAt is already epoch ms, matching last.at (getTime()); do NOT
          // scale it — the old `* 1000` made the comparison always false (ENG-379).
          const connectedAtMs = connectedAt;
          if (last && last.direction === 'outbound' && last.at > connectedAtMs) continue;

          const awaitingReply = !!last && last.direction === 'inbound';
          matches.push({
            leadId: lead.leadId,
            email: lead.email || '',
            // ENG-2082: see get_leads — a phone-only lead has a contact channel; show it.
            phone: lead.phone || '',
            firstName: lead.firstName || '',
            lastName: lead.lastName || '',
            company: lead.company || '',
            title: lead.title || '',
            linkedin: lead.linkedin || '',
            linkedInConnectionStatus: {
              isConnected: true,
              connectedAt: new Date(connectedAtMs).toISOString(),
              connectedAtTimestamp: connectedAt,
            },
            lastEngagementType: last?.type ?? null,
            lastEngagementDirection: last?.direction ?? null,
            lastEngagementAt: last ? new Date(last.at).toISOString() : null,
            awaitingReply,
          });
          if (matches.length >= limit) break;
        }
        cursor = page.lastEvaluatedKey;
        if (matches.length >= limit) { scannedAll = !cursor; break; }
        if (!cursor) break;
        if (scanned >= scanLimit) { scannedAll = false; break; }
      }

      return {
        success: true,
        message: `Found ${matches.length} lead(s) that accepted your invite and need a follow-up`,
        leads: matches,
        matchCount: matches.length,
        listName: list.name,
        scannedLeads: scanned,
        scannedAllLeads: scannedAll,
      };
    } catch (error) {
      console.error('AgentMode: Error getting leads needing follow-up:', error);
      return { success: false, message: 'Failed to get leads needing follow-up', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * ENG-2811: batched, read-only conversation-status audit for a lead list.
   *
   * Audit-style asks ("what's the LinkedIn status of these 64 leads?") used to
   * fan out one get_lead_details / linkedin_outreach call per lead; every turn
   * resent the whole history, so one Opiner audit ran 549 turns. This returns a
   * compact status row per lead in ONE call, loading the cross-lead signal with
   * the same constant query set as getLeadsNeedingFollowup (connections table,
   * LinkedIn events, email events) — no per-lead Unipile calls, no writes.
   *
   * Scoping: access is checked on the requested list exactly like
   * getLeadDetails. Explicit lead_ids are looked up ONLY inside that list, so an
   * id from another list/tenant comes back as {status:'not_found'} and never
   * leaks data. Per-lead lookup failures are reported per item.
   */
export async function getLeadConversationStatuses(listId: string, userId: string, options: {
    leadIds?: string[];
    limit?: number;
    cursor?: string;
  } = {}): Promise<any> {
    try {
      const { crmDb, userDb } = await import('../../services/db');
      const limit = Math.min(Math.max(Math.floor(options.limit || 100), 1), 200);
      const MAX_LEAD_IDS = 200;

      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      const hasAccess = await crmDb.canOrgMemberAccessList(userId, list);
      if (!hasAccess) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to access this list' };
      }

      const selectionMode = Array.isArray(options.leadIds);
      const rawIds = selectionMode ? (options.leadIds as string[]) : [];
      const leadIds = Array.from(new Set(rawIds.map((id) => String(id || '').trim()).filter(Boolean)));
      if (leadIds.length > MAX_LEAD_IDS) {
        return {
          success: false,
          message: `Too many lead_ids (${leadIds.length}); max ${MAX_LEAD_IDS} per call`,
          error: `Split lead_ids into batches of at most ${MAX_LEAD_IDS}, or omit lead_ids and page the whole list with cursor.`,
        };
      }

      // --- Constant-query signal loading (NO per-lead fan-out) ---
      const accountId: string | null = (list as any).linkedInAccountId ?? null;
      const { emailEventsDb } = await import('../../services/emailEventsDb');
      const { getAllConnectionsByAccount, normalizeLinkedInUrl } = await import('../../services/unipileConnectionsDb');
      const user = await userDb.getUserById(userId);
      const emailDomain = user?.emailDomain?.trim();
      // A failed signal read must never masquerade as a confirmed negative
      // (not_connected / no_messages): record it and report those fields as unknown.
      const unavailableSignals: string[] = [];
      const guard = <T,>(name: string, p: Promise<T[]>): Promise<T[]> =>
        p.catch((err) => {
          console.warn(`AgentMode: lead status signal '${name}' unavailable:`, err);
          unavailableSignals.push(name);
          return [] as T[];
        });
      const [connections, linkedInEvents, emailEvents] = await Promise.all([
        accountId ? guard('linkedin_connections', getAllConnectionsByAccount(accountId) as Promise<any[]>) : Promise.resolve([]),
        guard('linkedin_messages', emailEventsDb.getEventsByEmailDomain(`linkedin-${listId}`) as Promise<any[]>),
        emailDomain ? guard('email_messages', emailEventsDb.getEventsByEmailDomain(emailDomain) as Promise<any[]>) : Promise.resolve([]),
      ]);
      const connectionsUnavailable = unavailableSignals.includes('linkedin_connections');
      const messagesUnavailable = unavailableSignals.some((n) => n !== 'linkedin_connections');

      const connectedAtByUrl = new Map<string, number>();
      for (const c of connections as any[]) {
        const url = String(c?.publicProfileUrl || '').trim().toLowerCase();
        if (!url) continue;
        const ts = typeof c?.connectedAt === 'number' ? c.connectedAt : 0;
        const existing = connectedAtByUrl.get(url);
        if (existing === undefined || ts < existing) connectedAtByUrl.set(url, ts);
      }
      type Signal = { at: number; type: string; direction: 'inbound' | 'outbound' };
      const directionOf = (eventType: string): 'inbound' | 'outbound' =>
        /received|replied/i.test(eventType) ? 'inbound' : 'outbound';
      const linkedInSignalByUrl = new Map<string, Signal>();
      for (const e of linkedInEvents as any[]) {
        const url = String(e?.leadEmail || '').trim().toLowerCase();
        if (url) foldEngagementSignal(linkedInSignalByUrl, url, e, directionOf);
      }
      const emailSignalByEmail = new Map<string, Signal>();
      for (const e of emailEvents as any[]) {
        const email = String(e?.leadEmail || '').trim().toLowerCase();
        if (email) foldEngagementSignal(emailSignalByEmail, email, e, directionOf);
      }

      const toRow = (lead: any) => {
        const url = lead.linkedin ? normalizeLinkedInUrl(String(lead.linkedin)).toLowerCase() : '';
        const connectedAt = url ? connectedAtByUrl.get(url) : undefined;
        const leadEmail = String(lead.email || '').trim().toLowerCase();
        const liSig = url ? linkedInSignalByUrl.get(url) : undefined;
        const emSig = leadEmail ? emailSignalByEmail.get(leadEmail) : undefined;
        const last = [liSig, emSig].filter((x): x is Signal => !!x).sort((a, b) => b.at - a.at)[0];
        const connectionState = !accountId || !url || connectionsUnavailable ? 'unknown' : connectedAt !== undefined ? 'connected' : 'not_connected';
        return {
          leadId: lead.leadId,
          status: 'ok',
          name: [lead.firstName, lead.lastName].filter(Boolean).join(' '),
          company: lead.company || '',
          leadStatus: lead.status || null,
          linkedin: lead.linkedin || '',
          connectionState,
          connectedAt: connectedAt !== undefined ? new Date(connectedAt).toISOString() : null,
          lastMessageChannel: last ? (last === liSig ? 'linkedin' : 'email') : null,
          lastMessageType: last?.type ?? null,
          lastMessageDirection: last?.direction ?? null,
          lastMessageAt: last ? new Date(last.at).toISOString() : null,
          replyState: messagesUnavailable ? 'unknown' : !last ? 'no_messages' : last.direction === 'inbound' ? 'replied_awaiting_us' : 'awaiting_their_reply',
        };
      };

      const base = {
        listName: list.name,
        linkedInAccountAssigned: !!accountId,
        ...(accountId ? {} : { note: 'No LinkedIn account on this list, so connectionState is "unknown"; message history is still reported.' }),
        ...(unavailableSignals.length ? { unavailableSignals, warning: `Signal read failed (${unavailableSignals.join(', ')}); affected fields are reported as "unknown", not as confirmed negatives.` } : {}),
      };

      if (selectionMode) {
        const rows: any[] = [];
        const CONCURRENCY = 10;
        for (let i = 0; i < leadIds.length; i += CONCURRENCY) {
          const chunk = leadIds.slice(i, i + CONCURRENCY);
          const settled = await Promise.allSettled(chunk.map((id) => crmDb.getLeadById(listId, id)));
          settled.forEach((r, j) => {
            const id = chunk[j];
            if (r.status === 'rejected') {
              rows.push({ leadId: id, status: 'error', error: r.reason instanceof Error ? r.reason.message : 'Lookup failed' });
            } else if (!r.value || (r.value as any).listId && (r.value as any).listId !== listId) {
              rows.push({ leadId: id, status: 'not_found' });
            } else {
              rows.push(toRow(r.value));
            }
          });
        }
        const ok = rows.filter((r) => r.status === 'ok').length;
        return {
          success: true,
          message: `Status for ${ok}/${rows.length} requested lead(s)`,
          ...base,
          leads: rows,
          count: rows.length,
          notFound: rows.filter((r) => r.status === 'not_found').length,
          errors: rows.filter((r) => r.status === 'error').length,
          hasMore: false,
          nextCursor: null,
        };
      }

      // Whole-list mode: one page of up to `limit` leads, resumable via cursor.
      let startKey: any = undefined;
      if (options.cursor) {
        try {
          startKey = JSON.parse(Buffer.from(String(options.cursor), 'base64').toString('utf8'));
        } catch {
          return { success: false, message: 'Invalid cursor', error: 'Pass back nextCursor exactly as returned by the previous call.' };
        }
      }
      const page = await crmDb.getLeadsByListId(listId, limit, startKey);
      const items: any[] = page.items || [];
      const rows = items.map(toRow);
      const nextKey = page.lastEvaluatedKey;
      return {
        success: true,
        message: `Status for ${rows.length} lead(s)${nextKey ? ' (more available — call again with nextCursor)' : ''}`,
        ...base,
        leads: rows,
        count: rows.length,
        hasMore: !!nextKey,
        nextCursor: nextKey ? Buffer.from(JSON.stringify(nextKey), 'utf8').toString('base64') : null,
      };
    } catch (error) {
      console.error('AgentMode: Error getting lead conversation statuses:', error);
      return { success: false, message: 'Failed to get lead conversation statuses', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Fold a single engagement event into a per-key "last engagement" signal map,
   * keeping only the most-recent engagement per key. Shared by the
   * LinkedIn-URL-keyed and email-keyed signal builders.
   */
function foldEngagementSignal(
    map: Map<string, { at: number; type: string; direction: 'inbound' | 'outbound' }>,
    key: string,
    event: any,
    directionOf: (eventType: string) => 'inbound' | 'outbound',
  ): void {
    const at = new Date(event?.createdAt || 0).getTime();
    if (!at || isNaN(at)) return;
    const existing = map.get(key);
    if (!existing || at > existing.at) {
      map.set(key, { at, type: String(event?.eventType || ''), direction: directionOf(String(event?.eventType || '')) });
    }
  }

/**
 * ENG-2996: Emma suppresses a lead by moving its pipeline `status` to
 * "do-not-contact" (any case/spacing). Send paths only read `contactStatus`, so
 * the same write must set it too. A lead already unsubscribed/DNC keeps its
 * existing contact status and reason.
 */
export function suppressionContactStatusUpdates(status: unknown, existingLead: any, userId: string): Record<string, any> {
  if (typeof status !== 'string') return {};
  const normalized = status.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (normalized !== 'do-not-contact' && normalized !== 'dnc') return {};
  if (existingLead?.contactStatus === 'do-not-contact' || existingLead?.contactStatus === 'unsubscribed') return {};
  const now = new Date().toISOString();
  return {
    contactStatus: 'do-not-contact',
    contactStatusReason: 'admin-flagged',
    contactStatusNote: 'Set from pipeline status "do-not-contact"',
    contactStatusUpdatedAt: now,
    contactStatusUpdatedBy: userId,
    unsubscribedFromGroupEmail: true,
    unsubscribedFromGroupEmailAt: now,
  };
}

export async function updateLead(listId: string, leadId: string, updates: Record<string, any>, userId: string): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');

      // Verify list access (org-aware: org members can update leads in their org's lists)
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      const { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../../services/crmAccessControl');
      const hasAccess = await canDestructiveCrmList(userId, list);
      if (!hasAccess) {
        return { success: false, message: 'Access denied', error: CRM_EDITOR_REQUIRED_MESSAGE };
      }

      const lead = await crmDb.getLeadById(listId, leadId);
      if (!lead) {
        return { success: false, message: 'Lead not found', error: 'The specified lead does not exist in this list' };
      }

      if (!updates || Object.keys(updates).length === 0) {
        return { success: false, message: 'No updates provided', error: 'Provide at least one field to update' };
      }

      // Separate standard fields from custom fields
      const standardFields = ['email', 'firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin', 'status', 'dealValue', 'dealCurrency'];
      const dbUpdates: any = {};
      const customFieldUpdates: Record<string, any> = {};

      Object.entries(updates).forEach(([key, value]) => {
        if (standardFields.includes(key)) {
          dbUpdates[key] = value;
        } else {
          customFieldUpdates[key] = value;
        }
      });

      // Merge custom fields with existing ones
      if (Object.keys(customFieldUpdates).length > 0) {
        dbUpdates.customFields = mergeCustomFields(
          lead.customFields,
          customFieldUpdates,
          { source: 'agentMode.updateLead', listId, leadId },
        );
      }

      // ENG-2996: a do-not-contact pipeline status is a suppression, not a label.
      Object.assign(dbUpdates, suppressionContactStatusUpdates(dbUpdates.status, lead, userId));

      // Auto-create status change engagement if status changed
      if (dbUpdates.status !== undefined && (lead.status || null) !== dbUpdates.status) {
        await crmDb.addLeadEngagement(listId, leadId, {
          eventType: 'status.changed',
          eventData: {
            from: lead.status || null,
            to: dbUpdates.status,
            dealValue: dbUpdates.dealValue ?? lead.dealValue ?? null,
            dealCurrency: dbUpdates.dealCurrency ?? lead.dealCurrency ?? 'USD',
          },
          createdAt: new Date().toISOString(),
        });
      }

      await crmDb.updateLead(listId, leadId, dbUpdates);

      // ENG-2311: no CRM push for a session-list row (list already loaded above).
      if (!suppressLeadSideEffects(list)) void (async () => {
        try {
          const { externalCrmSyncService } = await import('../../services/externalCrmSyncService');
          await Promise.allSettled([
            externalCrmSyncService.autoSyncLead(userId, listId, { ...lead, ...dbUpdates }, 'hubspot', 'updated'),
            externalCrmSyncService.autoSyncLead(userId, listId, { ...lead, ...dbUpdates }, 'attio', 'updated'),
          ]);
        } catch (syncError) {
          console.error('AgentMode: Error triggering external CRM auto-sync:', syncError);
        }
      })();

      return {
        success: true,
        message: `Lead updated successfully (${Object.keys(updates).join(', ')})`,
        updatedFields: Object.keys(updates)
      };
    } catch (error) {
      console.error('AgentMode: Error updating lead:', error);
      return { success: false, message: 'Failed to update lead', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

export async function setLeadContactStatus(
    listId: string,
    leadIds: string[],
    contactStatus: string,
    contactStatusReason: string | undefined,
    contactStatusNote: string | undefined,
    userId: string
  ): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');
      const { isDoNotContact } = await import('../../utils/leadContactStatus');

      const validStatuses = ['active', 'do-not-contact', 'unsubscribed'];
      if (!validStatuses.includes(contactStatus)) {
        return { success: false, message: `contactStatus must be one of: ${validStatuses.join(', ')}` };
      }

      const validReasons = ['opted-out', 'bounced', 'requested-removal', 'admin-flagged', 'compliance', 'other'];
      if (contactStatusReason && !validReasons.includes(contactStatusReason)) {
        return { success: false, message: `contactStatusReason must be one of: ${validReasons.join(', ')}` };
      }

      if (!leadIds || leadIds.length === 0) {
        return { success: false, message: 'No lead IDs provided' };
      }
      if (leadIds.length > 200) {
        return { success: false, message: 'Maximum 200 leads per call' };
      }

      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found' };
      }
      const { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../../services/crmAccessControl');
      const hasAccess = await canDestructiveCrmList(userId, list);
      if (!hasAccess) {
        return { success: false, message: 'Access denied', error: CRM_EDITOR_REQUIRED_MESSAGE };
      }

      const now = new Date().toISOString();
      let updated = 0;
      let failed = 0;
      const errors: string[] = [];

      for (const leadId of leadIds) {
        try {
          // `updateLead` is an upsert: for an id that is not in this list (deleted, or mistyped) it would CREATE an empty stub lead that
          // then shows up in the list. A missing lead is a failure to report, never a lead to create.
          const existing = await crmDb.getLeadById(listId, leadId, { consistentRead: true });
          if (!existing) {
            failed++;
            errors.push(`${leadId}: lead not found in this list`);
            continue;
          }
          const updates: any = {
            contactStatus,
            contactStatusUpdatedAt: now,
            contactStatusUpdatedBy: userId,
          };
          if (contactStatusReason) {
            updates.contactStatusReason = contactStatusReason;
          }
          if (contactStatusNote) {
            updates.contactStatusNote = contactStatusNote;
          }
          if (contactStatus === 'active') {
            updates.unsubscribedFromGroupEmail = false;
            updates.contactStatusReason = null;
            updates.contactStatusNote = null;
          }
          if (contactStatus === 'do-not-contact' || contactStatus === 'unsubscribed') {
            updates.unsubscribedFromGroupEmail = true;
            updates.unsubscribedFromGroupEmailAt = now;
          }
          await crmDb.updateLead(listId, leadId, updates);
          updated++;
        } catch (err) {
          failed++;
          errors.push(`${leadId}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }

      return {
        success: true,
        message: `Contact status updated: ${updated} succeeded, ${failed} failed out of ${leadIds.length}`,
        updated,
        failed,
        total: leadIds.length,
        ...(errors.length > 0 ? { errors } : {}),
      };
    } catch (error) {
      console.error('AgentMode: Error setting lead contact status:', error);
      return { success: false, message: 'Failed to set contact status', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

export async function deleteLeads(listId: string, leadIds: string[], userId: string): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      const { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../../services/crmAccessControl');
      const hasAccess = await canDestructiveCrmList(userId, list);
      if (!hasAccess) {
        return { success: false, message: 'Access denied', error: CRM_EDITOR_REQUIRED_MESSAGE };
      }

      if (!leadIds || leadIds.length === 0) {
        return { success: false, message: 'No lead IDs provided', error: 'Provide at least one lead ID to delete' };
      }

      if (leadIds.length > 100) {
        return { success: false, message: 'Too many leads', error: 'Maximum 100 leads can be deleted per call' };
      }

      let successCount = 0;
      let failCount = 0;
      const errors: string[] = [];

      // Delete sequentially to avoid lead count race conditions
      for (const id of leadIds) {
        try {
          await crmDb.deleteLead(listId, id);
          successCount++;
        } catch (err) {
          failCount++;
          errors.push(`Failed to delete lead ${id}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }

      return {
        success: successCount > 0,
        message: `Deleted ${successCount} lead(s)${failCount > 0 ? `, ${failCount} failed` : ''}`,
        successCount,
        failCount,
        errors: errors.length > 0 ? errors : undefined
      };
    } catch (error) {
      console.error('AgentMode: Error deleting leads:', error);
      return { success: false, message: 'Failed to delete leads', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

export async function deleteLeadsByFilter(listId: string, filters: Array<{ field: string; operator: string; value?: any }>, userId: string, confirm?: boolean): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      const { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../../services/crmAccessControl');
      const hasAccess = await canDestructiveCrmList(userId, list);
      if (!hasAccess) {
        return { success: false, message: 'Access denied', error: CRM_EDITOR_REQUIRED_MESSAGE };
      }

      if (!filters || filters.length === 0) {
        return { success: false, message: 'At least one filter is required', error: 'Provide at least one filter criterion to identify leads to delete' };
      }

      // Must stay in step with the searchLeads resolver — this path is the
      // destructive one, so a field it fails to resolve does not merely return a
      // wrong answer, it selects the wrong rows for deletion. `clickIds` falling
      // through to `customFields.clickIds` (undefined on essentially every lead)
      // made `is_empty` match EVERYTHING, so "delete the leads with no click ID"
      // selected the attributed leads too. The two-phase confirm gate was the
      // only thing between that and data loss, and its preview looked correct.
      // ENG-1218: shared with the other filter resolver. A field missing here
      // does not error — it resolves to customFields[field], so `is_empty`
      // matches EVERY lead. On the destructive path that is data loss behind a
      // confirm gate whose preview looks correct.
      const standardFields = LEAD_STANDARD_FILTER_FIELDS as readonly string[];

      // Helper function to check if a lead matches all filters
      const leadMatchesFilters = (lead: any): boolean => {
        return filters.every((filter: any) => {
          const { field, operator, value } = filter;
          const lifecyclePresenceMatch = matchLifecyclePresenceFilter(field, operator);
          if (lifecyclePresenceMatch !== undefined) return lifecyclePresenceMatch;

          let fieldValue: any;
          if (field === 'icpScore') {
            fieldValue = lead.icpMatch?.score;
          } else if (field === 'icpMatch') {
            fieldValue = lead.icpMatch?.isMatch;
          } else if (field === 'engagementCount') {
            fieldValue = lead.engagementCount;
          } else if (standardFields.includes(field)) {
            fieldValue = lead[field];
          } else if (field.includes('.')) {
            // Dot-notation path (e.g. "customFields.createdAt" → lead.customFields?.createdAt)
            const parts = field.split('.');
            fieldValue = parts.reduce((obj: any, part: string) => obj?.[part], lead);
          } else {
            fieldValue = lead.customFields?.[field];
          }

          switch (operator) {
            case 'is_empty':
              return fieldValue === null || fieldValue === undefined || fieldValue === '';
            case 'is_not_empty':
              return fieldValue !== null && fieldValue !== undefined && fieldValue !== '';
            case 'equals':
              if (typeof fieldValue === 'boolean') return fieldValue === value;
              return String(fieldValue || '').toLowerCase() === String(value || '').toLowerCase();
            case 'not_equals':
              return String(fieldValue || '').toLowerCase() !== String(value || '').toLowerCase();
            case 'contains':
              return String(fieldValue || '').toLowerCase().includes(String(value || '').toLowerCase());
            case 'starts_with':
              return String(fieldValue || '').toLowerCase().startsWith(String(value || '').toLowerCase());
            case 'greater_than': {
              const numFv = Number(fieldValue);
              const numV = Number(value);
              if (!isNaN(numFv) && !isNaN(numV)) return numFv > numV;
              return String(fieldValue || '') > String(value || '');
            }
            case 'less_than': {
              const numFv = Number(fieldValue);
              const numV = Number(value);
              if (!isNaN(numFv) && !isNaN(numV)) return numFv < numV;
              return String(fieldValue || '') < String(value || '');
            }
            default:
              return false;
          }
        });
      };

      // Phase 1: Count matching leads and return preview (if confirm not explicitly true)
      if (confirm !== true) {
        let matchCount = 0;
        let scannedCount = 0;
        let cursor: any = undefined;
        const sampleLeads: any[] = [];
        const sampleLimit = 5;

        do {
          const pageResult = await crmDb.getLeadsByListId(listId, 200, cursor);
          const leads = pageResult.items || [];

          for (const lead of leads) {
            scannedCount++;
            if (leadMatchesFilters(lead)) {
              matchCount++;
              if (sampleLeads.length < sampleLimit) {
                sampleLeads.push({
                  // ENG-2082: this is the preview for a DESTRUCTIVE op, and `email is_empty`
                  // matches phone-only leads exactly. Without the number every sample row
                  // rendered blank, so the operator confirmed a delete against rows that
                  // looked like empty junk and were in fact contactable leads.
                  leadId: lead.leadId,
                  email: lead.email || '',
                  phone: lead.phone || '',
                  firstName: lead.firstName || '',
                  lastName: lead.lastName || '',
                  company: lead.company || ''
                });
              }
            }
          }

          cursor = pageResult.lastEvaluatedKey;
        } while (cursor);

        if (matchCount === 0) {
          return {
            success: true,
            message: `No leads matched the filter criteria (scanned ${scannedCount} leads)`,
            matchCount: 0,
            scannedCount,
            requiresConfirmation: false
          };
        }

        return {
          success: true,
          message: `Found ${matchCount} lead(s) matching the filter criteria. Call again with confirm=true to delete them.`,
          matchCount,
          scannedCount,
          sampleLeads,
          requiresConfirmation: true
        };
      }

      // Phase 2: Actually delete matching leads (confirm=true)
      let successCount = 0;
      let failCount = 0;
      let scannedCount = 0;
      let cursor: any = undefined;

      do {
        const pageResult = await crmDb.getLeadsByListId(listId, 200, cursor);
        const leads = pageResult.items || [];

        for (const lead of leads) {
          scannedCount++;
          if (leadMatchesFilters(lead)) {
            try {
              await crmDb.deleteLead(listId, lead.leadId);
              successCount++;
            } catch (err) {
              failCount++;
            }
          }
        }

        cursor = pageResult.lastEvaluatedKey;
      } while (cursor);

      return {
        success: successCount > 0 || (successCount === 0 && failCount === 0),
        message: successCount === 0 && failCount === 0
          ? `No leads matched the filter criteria (scanned ${scannedCount} leads)`
          : `Deleted ${successCount} lead(s)${failCount > 0 ? `, ${failCount} failed` : ''} (scanned ${scannedCount} leads)`,
        successCount,
        failCount,
        scannedCount
      };
    } catch (error) {
      console.error('AgentMode: Error deleting leads by filter:', error);
      return { success: false, message: 'Failed to delete leads by filter', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

export async function updateLeadList(listId: string, updates: {
    name?: string;
    description?: string;
    icpsOnly?: boolean;
    engagedOnly?: boolean;
    autoDraftEnabled?: boolean;
    autoDraftInstruction?: string;
    statusConfig?: Array<{ value: string; label: string; color: string; type: 'active' | 'won' | 'lost' | 'churned' }>;
    listType?: LeadListType;
  }, userId: string): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      const { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../../services/crmAccessControl');
      const hasAccess = await canDestructiveCrmList(userId, list);
      if (!hasAccess) {
        return { success: false, message: 'Access denied', error: CRM_EDITOR_REQUIRED_MESSAGE };
      }

      // Filter out undefined values
      const filteredUpdates: any = {};
      if (updates.name !== undefined) {
        if (!updates.name.trim()) {
          return { success: false, message: 'Invalid name', error: 'List name cannot be empty' };
        }
        filteredUpdates.name = updates.name;
      }
      if (updates.description !== undefined) filteredUpdates.description = updates.description;
      if (updates.icpsOnly !== undefined) filteredUpdates.icpsOnly = updates.icpsOnly;
      if (updates.engagedOnly !== undefined) filteredUpdates.engagedOnly = updates.engagedOnly;
      if (updates.autoDraftEnabled !== undefined) filteredUpdates.autoDraftEnabled = updates.autoDraftEnabled;
      if (updates.autoDraftInstruction !== undefined) filteredUpdates.autoDraftInstruction = updates.autoDraftInstruction;
      if (updates.statusConfig !== undefined) filteredUpdates.statusConfig = updates.statusConfig;
      if (updates.listType !== undefined) {
        if (!isLeadListType(updates.listType)) {
          return { success: false, message: 'Invalid list type', error: 'listType must be "sales", "customers" or "session"' };
        }
        if (list.listType) {
          return { success: false, message: 'List type already set', error: 'listType is already set and cannot be changed' };
        }
        filteredUpdates.listType = updates.listType;
      }

      if (Object.keys(filteredUpdates).length === 0) {
        return { success: false, message: 'No updates provided', error: 'Provide at least one field to update' };
      }

      await crmDb.updateLeadList(listId, filteredUpdates);

      return {
        success: true,
        message: `Lead list "${updates.name || list.name}" updated successfully`,
        updatedFields: Object.keys(filteredUpdates)
      };
    } catch (error) {
      console.error('AgentMode: Error updating lead list:', error);
      return { success: false, message: 'Failed to update lead list', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

export async function updateLeadStatus(
    listId: string,
    leadId: string,
    status: string,
    userId: string,
    dealValue?: number | null,
    dealCurrency?: string,
    notes?: string,
    drafts?: { messageDraft?: string; emailSubject?: string; emailBody?: string; sessionId?: string }
  ): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');

      // Verify list ownership (org members can access lists owned by other org members)
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      const { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../../services/crmAccessControl');
      const hasAccessUpdateStatus = await canDestructiveCrmList(userId, list);
      if (!hasAccessUpdateStatus) {
        return { success: false, message: 'Access denied', error: CRM_EDITOR_REQUIRED_MESSAGE };
      }

      // Fetch current lead
      const existingLead = await crmDb.getLeadById(listId, leadId);
      if (!existingLead) {
        return { success: false, message: 'Lead not found', error: 'The specified lead does not exist' };
      }

      const previousStatus = existingLead.status || null;
      // ENG-2996: a do-not-contact pipeline status also sets contactStatus, which
      // is what every send path (isDoNotContact / contactGuard) actually reads.
      const updates: any = { status, ...suppressionContactStatusUpdates(status, existingLead, userId) };
      if (dealValue !== undefined) updates.dealValue = dealValue;
      if (dealCurrency !== undefined) updates.dealCurrency = dealCurrency;

      // ENG-2361: a drafting agent that moves a lead to review must be able to put the
      // exact text it wrote on the lead in the same write — otherwise the Pending Review
      // queue lists the lead with nothing to approve. Stored in the same shapes the
      // portal's lead panel and queue already read. Empty strings are ignored, never
      // used to clear an existing draft.
      const now = new Date().toISOString();
      const savedDrafts: string[] = [];
      const dm = typeof drafts?.messageDraft === 'string' ? drafts.messageDraft.trim() : '';
      if (dm) {
        updates.messageDraft = {
          content: dm,
          createdAt: existingLead.messageDraft?.createdAt || now,
          updatedAt: now,
          ...(drafts?.sessionId ? { sessionId: drafts.sessionId } : {}),
        };
        savedDrafts.push('messageDraft');
      }
      const subj = typeof drafts?.emailSubject === 'string' ? drafts.emailSubject.trim() : '';
      const body = typeof drafts?.emailBody === 'string' ? drafts.emailBody.trim() : '';
      if (subj || body) {
        if (!subj || !body) {
          return { success: false, message: 'Email draft needs both email_subject and email_body', error: 'Provide both email_subject and email_body, or neither' };
        }
        updates.emailDraft = {
          subject: subj,
          textContent: body,
          createdAt: existingLead.emailDraft?.createdAt || now,
          updatedAt: now,
          ...(drafts?.sessionId ? { sessionId: drafts.sessionId } : {}),
        };
        updates.emailDraftFormat = 'text';
        savedDrafts.push('emailDraft');
      }

      // ENG-2966: never put a lead in the review queue without a draft to review.
      const draftError = missingReviewDraftError(status, { ...existingLead, ...updates });
      if (draftError) {
        return { success: false, message: 'No draft saved on this lead', error: draftError };
      }

      await crmDb.updateLead(listId, leadId, updates);

      // Auto-create status change engagement
      if (previousStatus !== status) {
        await crmDb.addLeadEngagement(listId, leadId, {
          eventType: 'status.changed',
          eventData: {
            from: previousStatus,
            to: status,
            dealValue: dealValue ?? existingLead.dealValue ?? null,
            dealCurrency: dealCurrency ?? existingLead.dealCurrency ?? 'USD',
            ...(notes ? { notes } : {}),
          },
          createdAt: new Date().toISOString(),
        });
      }

      const leadName = [existingLead.firstName, existingLead.lastName].filter(Boolean).join(' ') || existingLead.email || leadId;
      return {
        success: true,
        message: `Status for "${leadName}" updated from "${previousStatus || 'unset'}" to "${status}"`,
        previousStatus,
        newStatus: status,
        leadName,
        ...(savedDrafts.length ? { savedDrafts } : {}),
      };
    } catch (error) {
      console.error('AgentMode: Error updating lead status:', error);
      return { success: false, message: 'Failed to update lead status', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

export async function getLeadListStatuses(listId: string, userId: string): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');

      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      const hasAccess = await crmDb.canOrgMemberAccessList(userId, list);
      if (!hasAccess) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to view this list' };
      }

      return {
        success: true,
        // Was a second copy of createLeadList's literal. Shared now, so a list created
        // before statusConfig was persisted reads back the same vocabulary a list created
        // today stores — and it honours listType, which the local copy did not.
        statuses: list.statusConfig || defaultStatusConfigFor((list as any)?.listType),
        listName: list.name,
      };
    } catch (error) {
      console.error('AgentMode: Error getting lead list statuses:', error);
      return { success: false, message: 'Failed to get lead list statuses', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

export async function configureLeadStatuses(
    listId: string,
    statusConfig: Array<{ value: string; label: string; color: string; type: 'active' | 'won' | 'lost' | 'churned' }>,
    userId: string
  ): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      const { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../../services/crmAccessControl');
      const hasAccess = await canDestructiveCrmList(userId, list);
      if (!hasAccess) {
        return { success: false, message: 'Access denied', error: CRM_EDITOR_REQUIRED_MESSAGE };
      }

      // Validate statusConfig entries
      for (const entry of statusConfig) {
        if (!entry.value || !entry.label || !entry.color || !entry.type) {
          return { success: false, message: 'Invalid status config', error: 'Each status entry must have value, label, color, and type' };
        }
        if (!['active', 'won', 'lost', 'churned'].includes(entry.type)) {
          return { success: false, message: 'Invalid status type', error: `Status type must be one of: active, won, lost, churned. Got: "${entry.type}"` };
        }
      }

      // Check for duplicate values
      const values = statusConfig.map(s => s.value);
      const uniqueValues = new Set(values);
      if (values.length !== uniqueValues.size) {
        return { success: false, message: 'Duplicate status values', error: 'Each status value must be unique' };
      }

      await crmDb.updateLeadList(listId, { statusConfig });

      return {
        success: true,
        message: `Status configuration updated for list "${list.name}" with ${statusConfig.length} statuses`,
        statuses: statusConfig,
      };
    } catch (error) {
      console.error('AgentMode: Error configuring lead statuses:', error);
      return { success: false, message: 'Failed to configure lead statuses', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

export async function deleteLeadList(listId: string, userId: string): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      const { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../../services/crmAccessControl');
      const hasAccess = await canDestructiveCrmList(userId, list);
      if (!hasAccess) {
        return { success: false, message: 'Access denied', error: CRM_EDITOR_REQUIRED_MESSAGE };
      }

      const listName = list.name;
      const leadCount = list.leadCount || 0;

      await crmDb.deleteLeadList(listId);

      return {
        success: true,
        message: `Lead list "${listName}" and its ${leadCount} lead(s) have been permanently deleted`,
        deletedListName: listName,
        deletedLeadCount: leadCount
      };
    } catch (error) {
      console.error('AgentMode: Error deleting lead list:', error);
      return { success: false, message: 'Failed to delete lead list', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

export async function getLeadEngagements(listId: string, leadId: string, userId: string, limit?: number, options?: { maxContentFetches?: number }): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');
      const effectiveLimit = Math.min(Math.max(limit || 20, 1), 100);

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      const hasAccess = await crmDb.canOrgMemberAccessList(userId, list);
      if (!hasAccess) {
        return { success: false, message: 'Access denied', error: 'You do not have permission to access this list' };
      }

      const lead = await crmDb.getLeadById(listId, leadId);
      if (!lead) {
        return { success: false, message: 'Lead not found', error: 'The specified lead does not exist in this list' };
      }

      // ENG-1207: the count is fetched alongside the engagements, so a rejection
      // there rejected BOTH -- taking down a tool whose actual payload was sitting
      // in the other promise. It is a summary field, not the answer, and since the
      // message no longer derives its total from it (see below), nothing the caller
      // asked for depends on it. Degrade the summary, not the tool.
      const [engagementCountResult, engagementsResult] = await Promise.all([
        crmDb.getLeadEngagementCount(listId, leadId, userId).catch((countError) => {
          // Loud, not silent (CodeRabbit). The bare swallow kept the tool alive but
          // left no trace, so a count query failing repeatedly would be invisible.
          console.error('AgentMode getLeadEngagements: engagement count unavailable', countError);
          return null;
        }),
        options ? crmDb.getLeadEngagements(listId, leadId, userId, options) : crmDb.getLeadEngagements(listId, leadId, userId)
      ]);
      const engagementCountAvailable = engagementCountResult !== null;
      const engagementCount: any = engagementCountResult || {};
      const engagements = engagementsResult.engagements || [];

      const limitedEngagements = engagements.slice(0, effectiveLimit);

      // ENG-1207: never report a truncated page as a total. `searchLeads` and
      // `getLeads` were corrected in #2407; this tool kept saying "Found 20
      // engagement(s)" for a lead with 143, and a model reads that as "there are
      // 20" and stops -- the same misread that wrote 17 of 107 records and called
      // the job done.
      //
      // The total is `engagements.length`, NOT `engagementCount.total`, and the
      // distinction matters. `engagements` is the exact population being sliced,
      // and it is complete: both of its sources paginate fully (the email-events
      // query loops on LastEvaluatedKey and returns everything; the rest is a lead
      // attribute). `engagementCount` is a SEPARATE query that may count a
      // different population, which would make "20 of 143" inconsistent with the
      // 20 rows actually returned beside it -- and it can fail independently,
      // leaving a total that has to be omitted or invented.
      //
      // Counting the array we truncated keeps the two numbers describing the same
      // thing by construction, and removes the failure mode entirely.
      const leadLabel = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
      // A lead with neither name collapses the label to '', leaving
      // "... engagement(s) for  — raise limit": a double space and a dangling
      // preposition in a sentence a model parses. Trimming the whole message does
      // not help, because the gap is in the middle. Drop the clause instead.
      const forLead = leadLabel ? ` for ${leadLabel}` : '';
      const truncated = engagements.length > limitedEngagements.length;
      const engagementMessage = truncated
        ? `Showing the first ${limitedEngagements.length} of ${engagements.length} engagement(s)${forLead} — raise limit to see more.`
        : `Found ${limitedEngagements.length} engagement(s)${forLead}`;

      return {
        success: true,
        message: engagementMessage,
        // ENG-1207 (CodeRabbit): explicit null, never undefined, plus a flag when
        // the count is unavailable. An undefined field vanishes from the serialised
        // payload, so the model cannot tell "this lead has no engagements" from "we
        // could not count them" -- a milder form of the very ambiguity this change
        // exists to remove. `?? null` also normalises a partial count object.
        engagementSummary: {
          total: engagementCount.total ?? null,
          last7Days: engagementCount.last7Days ?? null,
          totalAllMessages: engagementCount.totalAllMessages ?? null
        },
        // Only when it actually failed. Stamping it unconditionally would train the
        // model to ignore it, which is how `has_more` came to be ignored.
        ...(engagementCountAvailable ? {} : { engagementCountUnavailable: true }),
        engagements: limitedEngagements.map((eng: any) => ({
          eventId: eng.eventId,
          eventType: eng.eventType,
          createdAt: eng.createdAt,
          eventData: eng.eventData || {},
          // Truncate HTML email content to text preview
          emailContentPreview: getEmailContentPreview(eng.emailContent, 200)
        })),
        leadName: `${lead.firstName || ''} ${lead.lastName || ''}`.trim()
      };
    } catch (error) {
      console.error('AgentMode: Error getting lead engagements:', error);
      return { success: false, message: 'Failed to get lead engagements', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

/**
 * ENG-2840 (W2-7): limits for an event written by an outside agent (the MCP tool `add_lead_engagement`). Emma's own tool passes none.
 * `channel` is stamped into the event's data and is what `maxChannelEvents` counts; a lead whose stored record is `maxLeadBytes` or more
 * takes no event; an `idempotencyKey` already on one of the lead's events records nothing (the answer says so). The append is made only if
 * the lead did not change since it was read, so two calls with the same key at once cannot both record.
 */
export interface AgentEngagementLimits {
  channel: string;
  maxChannelEvents: number;
  maxLeadBytes: number;
  idempotencyKey?: string;
}

const AGENT_ENGAGEMENT_ATTEMPTS = 3;

export async function addLeadEngagement(
    listId: string, leadId: string, eventType: string,
    userId: string, eventData?: any, eventDate?: string,
    agentLimits?: AgentEngagementLimits,
  ): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');

      // Validate event type
      if (!eventType.startsWith('custom.')) {
        return { success: false, message: 'Invalid event type', error: 'Event type must start with "custom." prefix (e.g., "custom.phone_call", "custom.meeting")' };
      }

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      const { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../../services/crmAccessControl');
      const hasAccess = await canDestructiveCrmList(userId, list);
      if (!hasAccess) {
        return { success: false, message: 'Access denied', error: CRM_EDITOR_REQUIRED_MESSAGE };
      }

      const lead = await crmDb.getLeadById(listId, leadId, agentLimits ? { consistentRead: true } : undefined);
      if (!lead) {
        // ENG-2808: tell the model how to recover instead of retrying the same pair.
        return {
          success: false,
          message: 'Lead not found',
          error: 'The specified lead does not exist in this list',
          hint: 'Do not retry with the same lead_id/list_id. Look the lead up with search_leads (by name or email) to get its current lead_id and list_id, then call add_lead_engagement again.',
        };
      }

      if (agentLimits) {
        return await addAgentLeadEngagement(crmDb, listId, leadId, lead, eventType, eventData, eventDate, agentLimits);
      }

      await crmDb.addLeadEngagement(listId, leadId, {
        eventType,
        eventData: eventData || {},
        createdAt: eventDate || new Date().toISOString()
      });

      return {
        success: true,
        message: `Engagement "${eventType}" recorded for ${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
        eventType,
        leadName: `${lead.firstName || ''} ${lead.lastName || ''}`.trim()
      };
    } catch (error) {
      console.error('AgentMode: Error adding lead engagement:', error);
      return { success: false, message: 'Failed to add lead engagement', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

/** The outside-agent path of addLeadEngagement (see AgentEngagementLimits). `lead` is the consistent read made by the caller. */
async function addAgentLeadEngagement(
  crmDb: any, listId: string, leadId: string, firstRead: any, eventType: string, eventData: any, eventDate: string | undefined,
  limits: AgentEngagementLimits,
): Promise<any> {
  const leadName = `${firstRead.firstName || ''} ${firstRead.lastName || ''}`.trim();
  // `channel` and `idempotencyKey` are the server's: a caller's own values for them are dropped, then ours are set.
  const { channel: _channel, idempotencyKey: _key, ...callerData } = (eventData && typeof eventData === 'object' ? eventData : {}) as Record<string, unknown>;
  const data = { ...callerData, channel: limits.channel, ...(limits.idempotencyKey ? { idempotencyKey: limits.idempotencyKey } : {}) };
  let lead = firstRead;
  for (let attempt = 1; attempt <= AGENT_ENGAGEMENT_ATTEMPTS; attempt++) {
    const events: any[] = Array.isArray(lead.engagements) ? lead.engagements : [];
    if (limits.idempotencyKey && events.some((e) => e?.eventData?.idempotencyKey === limits.idempotencyKey)) {
      return { success: true, recorded: false, duplicate: true, message: 'An event with this idempotency_key is already on the lead; nothing was recorded again.', eventType, leadName };
    }
    if (events.filter((e) => e?.eventData?.channel === limits.channel).length >= limits.maxChannelEvents) {
      return { success: false, message: `This lead already holds ${limits.maxChannelEvents} events recorded by outside agents, the most it takes. Nothing was recorded.` };
    }
    if (Buffer.byteLength(JSON.stringify(lead), 'utf8') >= limits.maxLeadBytes) {
      return { success: false, message: 'This lead\'s stored record is nearly full, so it takes no more events from outside agents. Nothing was recorded.' };
    }
    try {
      await crmDb.addLeadEngagement(listId, leadId, {
        eventType,
        eventData: data,
        createdAt: eventDate || new Date().toISOString(),
      }, typeof lead.updatedAt === 'string' ? { expectedUpdatedAt: lead.updatedAt } : {});
      return { success: true, recorded: true, message: `Engagement "${eventType}" recorded for ${leadName}`.trim(), eventType, leadName };
    } catch (err: any) {
      if (!err?.preconditionFailed) throw err;
      // The lead changed between the read and the append: read it again and decide again (the key may now be on it).
      lead = await crmDb.getLeadById(listId, leadId, { consistentRead: true });
      if (!lead) return { success: false, message: 'Lead not found' };
    }
  }
  return { success: false, message: 'The lead kept changing while the event was being recorded. Nothing was recorded; try again.' };
}

export async function sendEmailToLead(listId: string, leadId: string, userId: string): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return { success: false, message: 'Lead list not found', error: 'The specified lead list does not exist' };
      }
      const { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../../services/crmAccessControl');
      const hasAccessSend = await canDestructiveCrmList(userId, list);
      if (!hasAccessSend) {
        return { success: false, message: 'Access denied', error: CRM_EDITOR_REQUIRED_MESSAGE };
      }

      const lead = await crmDb.getLeadById(listId, leadId);
      if (!lead) {
        return { success: false, message: 'Lead not found', error: 'The specified lead does not exist in this list' };
      }

      if (!lead.email) {
        return { success: false, message: 'No email address', error: 'This lead does not have an email address' };
      }

      // Check do-not-contact status
      const { isDoNotContact, getDoNotContactReason } = await import('../../utils/leadContactStatus');
      if (isDoNotContact(lead)) {
        const reason = getDoNotContactReason(lead);
        return { success: false, message: 'Do not contact', error: `Cannot send email to this lead: ${reason}. Remove the do-not-contact flag first if you want to contact them.` };
      }

      // ENG-673: a lead pushed to the customer's Smartlead campaign is emailed from there; AgentWeb does not also email it on the agent's say-so.
      const { isPushedToSmartlead } = await import('../../services/smartleadMarkers');
      if (isPushedToSmartlead(lead)) {
        return { success: false, message: 'Lead is in a Smartlead campaign', error: "This lead is being emailed through the customer's Smartlead campaign, so AgentWeb does not also email it. Do not try to reach this person another way: tell the user, and let them decide." };
      }

      if (!lead.emailDraft) {
        return { success: false, message: 'No email draft', error: 'This lead does not have an email draft. Use update_email_draft_for_lead to create one first.' };
      }

      const draft = lead.emailDraft;
      if (!draft.subject) {
        return { success: false, message: 'Incomplete draft', error: 'The email draft is missing a subject line' };
      }

      if (!draft.htmlContent && !draft.textContent) {
        return { success: false, message: 'Incomplete draft', error: 'The email draft has no content' };
      }

      // Resolve sender: lead → list → account default → first available
      // Use the list owner's sender config so org members can send using the owner's senders.
      //
      // The owner's id is load-bearing beyond just reading the config: a mailbox sender's
      // connected account lives on the OWNER's record, so the provider must be called with
      // the owner's userId — otherwise getAccountById(accountId, actorUserId) finds nothing
      // and the send fails with "account not connected" for a sender the UI happily offered.
      // It also matters on the write side: a refreshed (and for Outlook, rotated) token must
      // be persisted back onto the owner's account. See ENG-299.
      const senderOwnerUserId = list.userId || userId;
      const sendersResult = await getCrmSenders(senderOwnerUserId);
      if (!sendersResult.success || sendersResult.senders.length === 0) {
        return { success: false, message: 'No senders configured', error: 'No sender email is configured for this lead list. To set one up, select the lead list and click "Senders".' };
      }

      let sender = null;
      if (lead.selectedSenderId) {
        sender = sendersResult.senders.find((s: any) => s.id === lead.selectedSenderId);
      }
      if (!sender && list.listSenderId) {
        sender = sendersResult.senders.find((s: any) => s.id === list.listSenderId);
      }
      if (!sender) {
        const defaultSenderId = sendersResult.defaultSenderId;
        sender = defaultSenderId
          ? sendersResult.senders.find((s: any) => s.id === defaultSenderId)
          : sendersResult.senders[0];
      }

      if (!sender) {
        return { success: false, message: 'No valid sender', error: 'Could not resolve a valid sender email' };
      }

      let emailId: string;

      // Accept both shapes — see note in sendEmailFromConfiguredSender.
      const leadSenderProvider: string = (sender as any).senderProvider || (sender as any).senderType || 'resend';
      const connectedAccountId = (sender as any).connectedAccountId || (sender as any).gmailAccountId;
      if (leadSenderProvider !== 'resend' && !connectedAccountId) {
        return {
          success: false,
          message: `${providerLabel(leadSenderProvider)} sender misconfigured`,
          error: `The ${providerLabel(leadSenderProvider)} sender is missing its connected account id`,
        };
      }

      // ENG-265: route through sendAsSender (not the provider APIs directly) so this
      // chat-driven send is subject to the same daily-cap/warmup enforcement as every
      // other send path. resolveSenderForSend gives the authoritative CrmSender
      // (dailyLimit/warmupStartedAt included) — the same lookup crm.ts's send routes use.
      const { resolveSenderForSend } = await import('../../services/crmSenderService');
      const { sendAsSender, SenderDailyLimitExceededError } = await import('../../services/sendAsSender');
      // Fail closed rather than falling back to a synthesized sender: resolveSenderForSend
      // re-reads the persisted config, so a null here means the sender that existed a moment
      // ago (from getCrmSenders) is now gone — a real (if narrow) race, not a legitimate
      // ad-hoc-sender case. A synthesized fallback would carry no dailyLimit/warmupStartedAt
      // and sendAsSender would treat it as uncapped, silently skipping enforcement.
      const crmSender = await resolveSenderForSend(senderOwnerUserId, sender.id, sender.email);
      if (!crmSender) {
        return {
          success: false,
          message: 'Sender no longer available',
          error: 'This sender was removed or changed just now. Please pick a sender again and retry.',
        };
      }

      // ENG-2984: claim the draft atomically before the provider call. Two concurrent
      // invocations both read the same draft above; only the one whose conditional claim
      // succeeds may send, so the lead gets at most one email. The draft stays stored until
      // the send succeeds, so a crash/deploy mid-send never loses it (stale claims expire).
      const claimToken = await crmDb.claimLeadEmailDraft(listId, leadId, draft);
      if (!claimToken) {
        return {
          success: false,
          message: 'Email draft already sent or changed',
          // ENG-2984 / Opslane run 2213: a refused claim means either a send is in flight or
          // the draft changed. Say so truthfully and give the recovery path: an orphaned claim
          // (crashed send) expires after the 5-minute lease, after which a retry succeeds.
          error: 'Another request is sending this draft right now (or the draft was just changed), so it was not sent twice. Check the lead in a minute: if the draft is gone, it was sent. If the draft is still there after about 5 minutes, retry the send once.',
        };
      }

      try {
        // senderOwnerUserId, not userId: the connected account belongs to whoever owns the
        // sender config, and a refreshed/rotated token must be written back to them (ENG-299).
        const sendResult = await sendAsSender(senderOwnerUserId, crmSender, {
          to: lead.email,
          subject: draft.subject,
          html: draft.htmlContent,
          text: draft.textContent,
        });
        emailId = sendResult.messageId;
      } catch (error) {
        // The send did not go out: release the claim so the user can retry now (best effort;
        // an unreleased claim also expires on its own).
        try {
          await crmDb.releaseLeadEmailDraftClaim(listId, leadId, claimToken);
        } catch (releaseError) {
          console.error('AgentMode: failed to release email draft claim after send failure (ENG-2984):', releaseError);
        }
        if (error instanceof SenderDailyLimitExceededError) {
          return { success: false, message: 'Daily sending limit reached', error: error.message };
        }
        throw error;
      }

      // Clear the sent draft and our claim in one conditional write: only while we still own
      // the claim AND the stored draft is the one we sent, so a draft replaced mid-send (or a
      // replacement sender after our lease expired) is never deleted.
      try {
        const cleared = await crmDb.completeLeadEmailDraftSend(listId, leadId, claimToken, draft);
        if (!cleared) {
          console.warn('AgentMode: sent email but draft changed or claim lost mid-send; left stored draft intact (ENG-2984)');
          // Our send finished: drop our claim so a replacement draft is sendable now. Token-
          // conditional, so a no-op if another sender owns the claim.
          try {
            await crmDb.releaseLeadEmailDraftClaim(listId, leadId, claimToken);
          } catch (releaseError) {
            console.error('AgentMode: failed to release email draft claim after replaced draft (ENG-2984):', releaseError);
          }
        }
      } catch (clearError) {
        console.error('AgentMode: failed to clear sent email draft (ENG-2984):', clearError);
      }

      return {
        success: true,
        message: `Email sent successfully to ${lead.email}`,
        emailId,
        to: lead.email,
        from: sender.email,
        subject: draft.subject
      };
    } catch (error) {
      console.error('AgentMode: Error sending email to lead:', error);
      const { emailProviderErrorStatus } = await import('../../services/emailProviderService');
      return {
        success: false,
        message: 'Failed to send email',
        error: error instanceof Error ? error.message : 'Unknown error',
        // ENG-1300: Gmail/Outlook throw fully-typed EmailProviderError
        // subclasses with no HTTP status of their own — mapped by name.
        code: emailProviderErrorStatus(error)
      };
    }
  }

/**
 * Narrow structural type for `updateEmailDraftForLead`'s two `this.callLLM`
 * call sites — covers only the 5 option fields and JSON-shaped response this
 * method actually sends/reads, not the full private `LLMCallOptions`
 * interface (which this module must not import from agentModeService.ts
 * anyway). Same narrowing discipline as `emma/impl/htmlCreation.ts`'s
 * `CreateHtmlFromTemplateLlmCall`.
 */
export type UpdateEmailDraftForLeadLlmCall = (
  model: string,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  options: {
    temperature: number;
    max_completion_tokens: number;
    response_format?: { type: 'json_object' };
    usageContext: LLMUsageContext;
    taskClass: GatewayTaskClass;
  },
) => Promise<{
  choices: Array<{ message: { content?: string | null } }>;
}>;

/** Matches `AgentModeService.prototype.getReportGenerationDefaultModel`'s real signature exactly. */
export type GetReportGenerationDefaultModelFn = () => Promise<string>;

/** Matches `AgentModeService.prototype.getSenderForLead`'s real signature exactly. */
export type GetSenderForLeadFn = (
  userId: string,
  leadSelectedSenderId?: string | null,
  listSenderId?: string | null,
  listOwnerId?: string | null,
) => Promise<{ fromName: string; notes?: string } | null>;

/**
 * ENG-2082/ENG-1388/ENG-945-carrying method: create or refine a lead's email
 * draft (and, when the lead has a LinkedIn URL, a companion LinkedIn
 * connection-request note) via two LLM calls. See this module's own header
 * comment for the ENG-2103 (F2 design-decision-list follow-up, Pattern A)
 * move notes — moved verbatim from
 * `AgentModeService.prototype.updateEmailDraftForLead`, with `callLLM`,
 * `getReportGenerationDefaultModel`, and `getSenderForLead` injected instead
 * of reading `this`.
 */
export async function updateEmailDraftForLead(
  listId: string,
  leadId: string,
  instruction: string,
  sessionId: string,
  userId: string,
  emailFormat: 'text' | 'html' | undefined,
  callLLM: UpdateEmailDraftForLeadLlmCall,
  getReportGenerationDefaultModel: GetReportGenerationDefaultModelFn,
  getSenderForLead: GetSenderForLeadFn,
): Promise<any> {
    try {
      const { crmDb } = await import('../../services/db');

      // Verify list ownership
      const list = await crmDb.getLeadListById(listId);
      if (!list) {
        return {
          success: false,
          message: 'Lead list not found',
          error: 'The specified lead list does not exist'
        };
      }

      const { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../../services/crmAccessControl');
      const hasAccess = await canDestructiveCrmList(userId, list);
      if (!hasAccess) {
        return {
          success: false,
          message: 'Access denied',
          error: CRM_EDITOR_REQUIRED_MESSAGE
        };
      }

      // Get the lead
      const lead = await crmDb.getLeadById(listId, leadId);
      if (!lead) {
        return {
          success: false,
          message: 'Lead not found',
          error: 'The specified lead does not exist'
        };
      }

      // No contact channel at all, nothing to draft. ENG-2082 opened lead capture to
      // phone-only submissions, and this runs fire-and-forget from the forward-lead webhook
      // whenever the list has autoDraftEnabled — so without a guard every phone-only capture
      // spends two billed LLM calls writing a polished email to a person who has no address
      // and a LinkedIn note for a lead with no LinkedIn, then reports success.
      //
      // Gated on email AND linkedin, not email alone. This function also produces the
      // LinkedIn connection-request note below, and linkedInInviteCrmMirror creates leads
      // that have a linkedin and NO email — refusing those would delete a working feature
      // to fix a new one.
      //
      // `skipped` so the caller can tell "nothing to do" from "this broke": webhooks.ts maps
      // a plain falsy result to autoDraftStatus='failed' and puts the error in the OWNER
      // ALERT, which would mean every phone-only capture emails its owner a failure notice.
      // Its sibling autoSend path already has the right word for this — 'skipped_no_email'.
      // Trimmed on both sides. The note gate below trims and this did not, so
      // `linkedin: '   '` passed here, closed there, and fell through to the
      // nothing-generated arm.
      if (!String(lead.email ?? '').trim() && !String(lead.linkedin ?? '').trim()) {
        return {
          success: false,
          skipped: true,
          reason: 'no_contact_channel',
          // The guard widened to email-or-linkedin; the message did not follow it, so a
          // LinkedIn-less, email-less lead reported a problem it only half had.
          message: 'No contact channel',
          error: 'This lead has neither an email address nor a LinkedIn profile — there is nothing to draft.'
        };
      }

      // Check do-not-contact status
      const { isDoNotContact: isDNC, getDoNotContactReason: getDNCReason } = await import('../../utils/leadContactStatus');
      if (isDNC(lead)) {
        const reason = getDNCReason(lead);
        return {
          success: false,
          message: 'Do not contact',
          error: `Cannot draft email for this lead: ${reason}. Remove the do-not-contact flag first if you want to contact them.`
        };
      }

      // Get engagement history
      const engagementsResult = await crmDb.getLeadEngagements(listId, leadId, userId);
      const engagements = engagementsResult.engagements || [];

      // Get brand guidelines
      const brandGuidelines = await readBrandGuidelines(userId);

      // Get market strategy. This prompt embeds formattedContent wholesale, so
      // it is NOT bounded by the tool-result page budget — before ENG-945 it
      // received 40 competitors in full and it still must (plus, now, the names
      // of any beyond that).
      const marketStrategy = await readMarketStrategy(userId, {
        minCompetitorsInFull: PROMPT_EMBEDDED_COMPETITOR_DETAIL,
        pagingHints: false
      });

      // Get sender information (from lead record, or default sender from CRM configuration)
      // Pass list.userId so org members use the list owner's sender config
      const leadSelectedSenderId = (lead as any).selectedSenderId;
      const senderInfo = await getSenderForLead(userId, leadSelectedSenderId, list?.listSenderId, list?.userId);

      // Get existing draft if it exists
      const existingDraft = (lead as any).emailDraft;

      // Get email draft format: use provided parameter, or lead's preference, or default to 'text'
      const emailDraftFormat = emailFormat || (lead as any).emailDraftFormat || 'text';

      // Build the prompt for LLM
      let emailPrompt = `You are an expert email marketing strategist. Create a personalized email draft for a lead based on the following information:

## Lead Information:
- Name: ${lead.firstName || ''} ${lead.lastName || ''}`.trim();

      if (lead.company) {
        emailPrompt += `\n- Company: ${lead.company}`;
      }
      if (lead.title) {
        emailPrompt += `\n- Title: ${lead.title}`;
      }
      if (lead.email) {
        emailPrompt += `\n- Email: ${lead.email}`;
      }
      if (lead.notes) {
        emailPrompt += `\n- Notes: ${lead.notes}`;
      }
      // ENG-1388: this draft is meant to be sent to the external lead/prospect,
      // so card revenue (Enigma, internal-use-only) must never inform it —
      // unconditionally, regardless of whether the requesting user is
      // themselves Enigma-allowlisted. That allowlist governs internal
      // visibility, not what may go into outward-facing content.
      const { stripCardRevenueKeys } = await import('../../utils/enrichmentMetadataPresentation');
      const emailPromptCustomFields = stripCardRevenueKeys(lead.customFields);
      if (emailPromptCustomFields && Object.keys(emailPromptCustomFields).length > 0) {
        emailPrompt += `\n- Custom Fields: ${JSON.stringify(emailPromptCustomFields, null, 2)}`;
      }

      // Add engagement history
      if (engagements.length > 0) {
        emailPrompt += `\n\n## Engagement History:`;
        engagements.slice(0, 10).forEach((eng: any, index: number) => {
          emailPrompt += `\n${index + 1}. ${eng.eventType} - ${eng.createdAt}`;
          if (eng.eventData?.subject) {
            emailPrompt += ` (Subject: ${eng.eventData.subject})`;
          }

          // Include email content if available (first 1k characters)
          if (eng.emailContent) {
            let contentPreview = '';
            // Prefer text content, fall back to HTML
            if (eng.emailContent.text) {
              contentPreview = eng.emailContent.text.substring(0, 1000);
            } else if (eng.emailContent.html) {
              // Strip HTML tags for preview, then take first 1k characters
              const textFromHtml = eng.emailContent.html
                .replace(/<[^>]*>/g, ' ') // Remove HTML tags
                .replace(/\s+/g, ' ') // Normalize whitespace
                .trim();
              contentPreview = textFromHtml.substring(0, 1000);
            }

            if (contentPreview) {
              const truncated = contentPreview.length >= 1000 ? contentPreview + '...' : contentPreview;
              emailPrompt += `\n   Email Content (first 1k characters):\n   ${truncated}`;
            }
          }
        });
      } else {
        emailPrompt += `\n\n## Engagement History: No previous engagements`;
      }

      // Add brand guidelines
      if (brandGuidelines.exists) {
        emailPrompt += `\n\n## Brand Guidelines:\n${brandGuidelines.formattedContent || JSON.stringify(brandGuidelines.brandData, null, 2)}`;
      } else {
        emailPrompt += `\n\n## Brand Guidelines: Not configured`;
      }

      // Add market strategy
      if (marketStrategy.exists) {
        emailPrompt += `\n\n## Market Strategy:\n${marketStrategy.formattedContent}`;
      } else {
        emailPrompt += `\n\n## Market Strategy: Not configured`;
      }

      // Add sender information
      if (senderInfo) {
        emailPrompt += `\n\n## Sender Information:
- From Name: ${senderInfo.fromName}`;
        if (senderInfo.notes) {
          emailPrompt += `\n- Notes: ${senderInfo.notes}`;
        }
        emailPrompt += `\n\nIMPORTANT: Use ONLY this sender information for the email signature. The signature MUST match the sender's name above, even if the lead's notes or engagement history mention a different person's name.`;
        if (senderInfo.notes) {
          emailPrompt += ` If the notes contain a meeting schedule link or other relevant information, consider including it in the email where appropriate.`;
        }
      } else {
        emailPrompt += `\n\n## Sender Information: Not configured (use a generic professional signature)`;
      }

      // Add existing draft if it exists
      if (existingDraft) {
        const existingContent = emailDraftFormat === 'text'
          ? (existingDraft.textContent || existingDraft.htmlContent || '')
          : (existingDraft.htmlContent || existingDraft.textContent || '');
        emailPrompt += `\n\n## Existing Email Draft (to refine/update):\nSubject: ${existingDraft.subject}\nContent:\n${existingContent}`;
      }

      // Add instruction
      emailPrompt += `\n\n## Instruction:\n${instruction}`;

      const contentType = emailDraftFormat === 'text' ? 'plain text' : 'HTML';
      emailPrompt += `\n\n## Requirements:
1. Create a professional, personalized email that aligns with the brand guidelines and market strategy
2. Use the lead's information to personalize the email (use their name, company, etc.)
3. Consider the engagement history to make the email contextually relevant
4. The email should be appropriate for the instruction provided
5. Subject line should be compelling and personalized (50-60 characters ideal)
6. Email content should be well-formatted, professional, and email-friendly (${contentType} format)
7. Include a clear call-to-action
8. Include an appropriate email signature at the end using the sender information provided (if available)
9. If updating an existing draft, improve it based on the instruction while maintaining the core message
${emailDraftFormat === 'text' ? '10. Use plain text format only - no HTML tags, no formatting markup. Use line breaks and simple text formatting.' : '10. Use HTML format with proper email-friendly HTML tags and styling.'}

Format the response as JSON with this structure:
${emailDraftFormat === 'text'
          ? `{
  "subject": "Email subject line (personalized, 50-60 characters)",
  "textContent": "Complete plain text email body (no HTML, use line breaks for paragraphs)"
}`
          : `{
  "subject": "Email subject line (personalized, 50-60 characters)",
  "htmlContent": "Complete HTML email body (well-formatted, professional, email-friendly HTML)"
}`}`;

      // The EMAIL draft runs only when there is an address to send to. This function also
      // produces the LinkedIn connection-request note below, and linkedInInviteCrmMirror
      // creates leads that have a linkedin and no email — so the guard at the top of this
      // function cannot refuse them outright. But widening that guard on its own left this
      // path still running for them: two billed LLM calls producing a polished draft
      // addressed to nobody, which is the exact harm the guard was added to prevent.
      let emailDraft: any = null;
      let emailData: any = null;
      if (lead.email) {
        const reportGenerationModel = await getReportGenerationDefaultModel();
        const completion = await callLLM(
          reportGenerationModel,
          [
            {
              role: "system",
              content: emailDraftFormat === 'text'
                ? "You are an expert email marketing strategist. Create personalized, professional plain text emails that align with brand guidelines and market strategy. Always respond with valid JSON containing subject and textContent fields. Use plain text only - no HTML tags or formatting markup."
                : "You are an expert email marketing strategist. Create personalized, professional emails that align with brand guidelines and market strategy. Always respond with valid JSON containing subject and htmlContent fields.",
            },
            { role: "user", content: emailPrompt },
          ],
          {
          temperature: 0.8,
            max_completion_tokens: 3000,
            response_format: { type: 'json_object' },
            usageContext: { userId, sessionId, feature: 'email_draft' },
            taskClass: 'content_generation',
          },
        );

        const responseContent = completion.choices[0].message.content;
        if (!responseContent) {
          throw new Error('No content generated from LLM');
        }

        // Parse the JSON response
        try {
          const cleanedContent = responseContent.replace(/```json\s*|\s*```/g, '').trim();
          emailData = JSON.parse(cleanedContent);
        } catch (parseError) {
          console.error('AgentMode: Error parsing email draft JSON:', parseError);
          throw new Error('Failed to parse email draft response');
        }

        // Validate required fields based on format
        if (emailDraftFormat === 'text') {
          if (!emailData.subject || !emailData.textContent) {
            throw new Error('LLM response missing required fields (subject, textContent)');
          }
        } else {
          if (!emailData.subject || !emailData.htmlContent) {
            throw new Error('LLM response missing required fields (subject, htmlContent)');
          }
        }

        // Save draft to lead record with sessionId
        const now = new Date().toISOString();
        emailDraft = {
          subject: emailData.subject,
          createdAt: existingDraft?.createdAt || now,
          updatedAt: now,
          sessionId: sessionId
        };

        if (emailDraftFormat === 'text') {
          emailDraft.textContent = emailData.textContent;
        } else {
          emailDraft.htmlContent = emailData.htmlContent;
        }

        // Shadow only (ENG-3067): counts specifics the brand facts do not contain.
        // Logs counts, never draft text; cannot change or fail the draft.
        logOutreachClaimCheckShadow({
          channel: 'email',
          listId,
          draft: { subject: emailData.subject, body: emailDraftFormat === 'text' ? emailData.textContent : emailData.htmlContent },
          facts: { brandData: brandGuidelines?.brandData, marketStrategyText: marketStrategy?.exists ? marketStrategy.formattedContent : '' },
          recipient: lead,
        });
      }

      // Build activity history section for message prompt (reuse already-fetched engagements)
      let messageActivityContext = '';
      if (engagements.length > 0) {
        messageActivityContext = '\n\n## Activity History (most recent first):';
        engagements.slice(0, 10).forEach((eng: any, index: number) => {
          messageActivityContext += `\n${index + 1}. [${eng.eventType}] ${eng.createdAt}`;
          if (eng.eventData?.subject) messageActivityContext += ` — Subject: ${eng.eventData.subject}`;
          if (eng.text) messageActivityContext += `\n   "${String(eng.text).slice(0, 300)}"`;
          else if (eng.emailContent?.text) {
            messageActivityContext += `\n   "${eng.emailContent.text.substring(0, 300)}"`;
          }
        });
      }

      // Create message draft optimised for LinkedIn connection invites. The char limit
      // depends on the sending account tier: 300 for Premium, 200 for free. Resolve the
      // account the same way the send-invite route does (list-assigned → user's own).
      // The email draft was gated on lead.email; this is the other half, and it was
      // missing. A commit claimed "the two drafts are independent now — email gated on
      // lead.email, note on lead.linkedin" and only shipped the first clause, so every
      // ordinary email-only lead captured into an autoDraft list paid a second billed LLM
      // call plus two LinkedIn API round trips to write a connection note for a lead with
      // no LinkedIn URL — and stored it as messageDraft. Exactly the mirror of the harm
      // the guard was added to stop; the env2 check only exercised the LinkedIn-only
      // direction, so nothing caught it.
      const wantsLinkedInNote = !!String((lead as any).linkedin ?? '').trim();
      const { linkedInOutreachService, LinkedInOutreachService } = await import('../../services/linkedInOutreachService');
      const inviteAccountId = wantsLinkedInNote
        ? ((list as any)?.linkedInAccountId
          || await linkedInOutreachService.resolveUserOwnedAccountId(userId))
        : null;
      const inviteCharLimit = inviteAccountId
        ? await linkedInOutreachService.getInviteCharLimitForAccount(userId, inviteAccountId)
        : 200;
      const leadName = [(lead as any).firstName, (lead as any).lastName].filter(Boolean).join(' ');
      const leadTitle = (lead as any).title || '';
      const leadCompany = (lead as any).company || '';
      const leadDesc = [leadName || null, leadTitle, leadCompany ? `at ${leadCompany}` : null].filter(Boolean).join(', ');
      // `emailData` is null for a LinkedIn-only lead — that is the entire point of
      // gating the email draft. The line below dereferenced it unconditionally, one line
      // ABOVE the ternary that correctly handles null, so the LinkedIn-only lead this
      // block exists to serve threw `Cannot read properties of null (reading
      // 'textContent')` and produced no note at all. Found on env2, not by the unit
      // test: that test asserts no email-strategist prompt was sent, which stays true
      // when the function throws before reaching any prompt.
      // The `|| ''` also bound to the false branch only, so a text draft with an empty
      // textContent threw here too.
      const emailSummary = emailData
        ? String((emailDraftFormat === 'text' ? emailData.textContent : emailData.htmlContent) || '').slice(0, 300)
        : '';
      // Same compact brand block as the CRM invite-note route (ENG-2967) — the
      // full formattedContent above is sized for the email prompt, not a 300-char note.
      const senderBrand = brandMessagingContextFromGuidelines(brandGuidelines);
      const messagePrompt = `You are writing a LinkedIn connection request note. The goal is to get the recipient to accept.

Recipient: ${leadDesc}${senderBrand ? `\nSender context (who is writing — do not pitch):\n${senderBrand}` : ''}
${emailData ? `Context from their email (use to understand the outreach angle): Subject: ${emailData.subject} — ${emailSummary}` : 'No email draft for this lead (no address on file) — write the note from their profile alone.'}
${messageActivityContext}

Write a note that:
- Leads with something specific about THEIR work, role, or company — show you looked them up
- Explains briefly WHY you want to connect, relevant to them
- Sounds like one human writing to another — warm, direct, no corporate speak
- Is under ${inviteCharLimit} characters total
- Opens with their first name naturally (e.g. "John, saw your work on..." or "Sarah —")
- Does NOT start with Hi or Hello
- Does NOT have a call to action ("would love to chat", "let's connect")
- Does NOT use: synergy, opportunity, exciting, leverage, passionate, innovative
- No emojis

Bad: "Your work in enterprise security is impressive. Would love to connect and explore synergies."
Good: "Sarah, Island's browser-isolation is one of the smarter takes on shadow IT — solves it without blocking employees."

Reply with ONLY valid JSON: {"content": "the note text"}`;

      const messageCompletion = wantsLinkedInNote
        ? await callLLM('gemini-3.5-flash', [
          { role: 'user', content: messagePrompt },
        ], {
          temperature: 0.8,
          max_completion_tokens: 2048,
          usageContext: { userId, sessionId, feature: 'invite_message' },
          taskClass: 'content_generation',
        })
        : null;

      const messageResponseContent = messageCompletion?.choices?.[0]?.message?.content ?? null;
      // Only a lead we actually asked for a note about can be missing one.
      if (wantsLinkedInNote && !messageResponseContent) {
        throw new Error('No message content generated from LLM');
      }

      // Parse the JSON response — Gemini may wrap it in markdown or prose
      let messageData: any = null;
      if (messageResponseContent) try {
        const cleanedMsg = messageResponseContent.replace(/```json\s*/g, '').replace(/\s*```/g, '').trim();
        const bs = cleanedMsg.indexOf('{');
        const be = cleanedMsg.lastIndexOf('}');
        if (bs !== -1 && be > bs) {
          messageData = JSON.parse(cleanedMsg.slice(bs, be + 1));
        } else {
          messageData = { content: cleanedMsg };
        }
      } catch (parseError) {
        console.error('AgentMode: Error parsing message draft JSON:', parseError);
        // Continue with email draft only if message draft fails
        messageData = null;
      }

      // Create message draft object if we got valid data — smart-trim to the account's
      // LinkedIn invite limit (300 Premium / 200 free) on a word boundary (surrogate-safe),
      // matching what sendInvitation does at send time — never a crude mid-word cut.
      let messageDraft = null;
      if (messageData && messageData.content) {
        const now = new Date().toISOString();
        let noteText = String(messageData.content);
        // Layer 2: if the draft exceeds the account limit, ask the model to rewrite it
        // shorter (capped), then Layer 3 hard-trims on a sentence/word boundary as the
        // guarantee — same trimInviteMessage() the inline send path uses, kept consistent.
        if (noteText.length > inviteCharLimit) {
          const { shortenInviteNoteToLimit } = await import('../../services/inviteNoteShortener');
          noteText = await shortenInviteNoteToLimit({ callLLM: callLLM as unknown as Pick<AgentModeService, 'callLLM'>['callLLM'] }, noteText, inviteCharLimit, 2, userId, sessionId);
        }
        messageDraft = {
          content: LinkedInOutreachService.trimInviteMessage(noteText, inviteCharLimit),
          createdAt: now,
          updatedAt: now,
          sessionId: sessionId
        };
        logOutreachClaimCheckShadow({
          channel: 'linkedin_note',
          listId,
          draft: { body: messageDraft.content },
          facts: { brandData: brandGuidelines?.brandData, marketStrategyText: marketStrategy?.exists ? marketStrategy.formattedContent : '' },
          recipient: lead,
        });
      }

      // Update lead with whichever drafts were actually produced. With both gated off
      // there is nothing to write, and an empty update is not free: it costs a read plus
      // an UpdateItem that only bumps updatedAt and re-projects the GSIs.
      const draftUpdates = {
        ...(emailDraft && { emailDraft, emailDraftFormat }),
        ...(messageDraft && { messageDraft: messageDraft })
      };
      if (Object.keys(draftUpdates).length > 0) {
        await crmDb.updateLead(listId, leadId, draftUpdates);
      }

      return {
        success: true,
        // `skipped` when NEITHER draft was produced. webhooks.ts maps `success && !skipped`
        // to autoDraftStatus='created', so without this the owner alert said "Auto Draft:
        // Created" over nothing at all — reachable when the note LLM returns parseable but
        // contentless JSON, or when `linkedin` is whitespace (the entry guard uses raw
        // truthiness, the note gate trims, so the two disagree on that value).
        ...(!emailData && !messageDraft ? { skipped: true, reason: 'nothing_generated' } : {}),
        // Say what actually happened. Each draft is now gated on its own channel, so all
        // four combinations are reachable and the old two-way message described one.
        message: emailData && messageDraft
          ? (existingDraft
            ? 'Email and message drafts updated successfully'
            : 'Email and message drafts created successfully')
          : emailData
            ? (existingDraft ? 'Email draft updated successfully' : 'Email draft created successfully')
            : messageDraft
              ? 'LinkedIn message draft created — no email draft, this lead has no address'
              : 'No draft created — nothing usable was generated for this lead',
        data: {
          // null, not a fabricated shape: webhooks.ts reads data.email to decide whether to
          // auto-send, and an object with undefined fields would read as a real draft.
          email: !emailData
            ? null
            : emailDraftFormat === 'text'
              ? {
                subject: emailData.subject,
                textContent: emailData.textContent
              }
              : {
                subject: emailData.subject,
                htmlContent: emailData.htmlContent
              },
          message: messageDraft ? { content: messageDraft.content } : null
        }
      };
    } catch (error) {
      console.error('AgentMode: Error updating email draft for lead:', error);
      return {
        success: false,
        message: 'Failed to create/update email draft',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

/**
 * Build a short, human-readable audit string describing why a lead was
 * discovered. Written to lead.system.findReason (NOT customFields, which
 * leaks into CSV exports and email-template variables). Returns null when
 * only free-text keywords were used — in that case there's no structured
 * filter worth capturing.
 *
 * Capped at 200 chars; long over-flow strings are sliced with an ellipsis
 * marker so DynamoDB items stay small.
 *
 * ENG-2103 (F2 design-decision-list follow-up, Pattern A): moved verbatim
 * from module scope in agentModeService.ts along with its only caller,
 * importLeadsFromSearch, below.
 */
function buildFindReason(filters: {
  keywords?: string;
  title?: string;
  company?: string;
  location?: string;
  industry?: string;
  school?: string;
  search_url?: string;
}): string | null {
  const parts: string[] = [];
  if (filters.title) parts.push(`title=${filters.title}`);
  if (filters.company) parts.push(`company=${filters.company}`);
  if (filters.location) parts.push(`location=${filters.location}`);
  if (filters.industry) parts.push(`industry=${filters.industry}`);
  if (filters.school) parts.push(`school=${filters.school}`);
  if (filters.search_url) parts.push('from-url');
  if (parts.length === 0) return null;
  const joined = parts.join('; ');
  return joined.length > 200 ? joined.slice(0, 197) + '...' : joined;
}

/**
 * Stable hash of the find-leads filter set, used as the key in the per-list
 * `searchCursors` map so the next top-up loop with the same criteria resumes
 * from the cursor we persisted last time.
 *
 * ENG-2103 (F2 design-decision-list follow-up, Pattern A): moved verbatim
 * from module scope in agentModeService.ts along with its only caller,
 * importLeadsFromSearch, below.
 */
function computeFindLeadsCriteriaHash(filters: {
  keywords?: string;
  search_url?: string;
  title?: string;
  company?: string;
  company_id?: string;
  location?: string;
  location_id?: string;
  industry?: string;
  industry_id?: string;
  school?: string;
  school_id?: string;
}): string {
  const orderedKeys = [
    'keywords', 'search_url', 'title', 'company', 'company_id',
    'location', 'location_id', 'industry', 'industry_id', 'school', 'school_id',
  ] as const;
  const obj: Record<string, string> = {};
  for (const k of orderedKeys) {
    const v = (filters as any)[k];
    if (v !== undefined && v !== null && v !== '') obj[k] = String(v);
  }
  // SHA-1 of canonical JSON, truncated to 16 hex chars — collision risk is
  // negligible for the per-list cardinality we expect here.
  return require('crypto').createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

/**
 * ENG-1049/ENG-975/ENG-1002/ENG-1558: search LinkedIn for people and import
 * the results directly into a CRM lead list, with a 4-tier company
 * resolution chain, a top-up pagination loop, dedup-aware trimming to
 * exactly `limit` new leads, and an optional post-import auto-enrich queue.
 * See this module's own header comment for the ENG-2103 (F2
 * design-decision-list follow-up, Pattern A) move notes — moved verbatim
 * from `AgentModeService.prototype.importLeadsFromSearch`, with `callLLM`
 * injected instead of reading `this`.
 */
export async function importLeadsFromSearch(
  callLLM: Pick<AgentModeService, 'callLLM'>['callLLM'],
  userId: string,
  args: {
    listId: string;
    keywords?: string;
    search_url?: string;
    title?: string;
    company?: string;
    company_id?: string;
    location?: string;
    location_id?: string;
    industry?: string;
    industry_id?: string;
    school?: string;
    school_id?: string;
    cursor?: string;
    limit?: number;
    auto_enrich?: boolean;
    /** When set, every imported lead in this batch gets
     *  `lead.system.icpSource = icpSource` so the UI can attribute the
     *  lead back to the persona that sourced it. Distinct from the
     *  `lead.icpMatch` scoring field (post-import scoring). */
    icpSource?: string;
    /** ENG-1558: post-filter on each lead's resolved employer headcount —
     *  same semantics as search-people's company_size_min/max. Applied AFTER
     *  the 4-tier company-resolution chain below (not on raw work_experience
     *  alone), so a lead whose company only resolved via title-parse/LLM/
     *  profile fallback is still correctly sized instead of excluded early. */
    company_size_min?: number;
    company_size_max?: number;
  },
): Promise<any> {
  const {
    listId, keywords, search_url, title, company, company_id,
    location, location_id, industry, industry_id, school, school_id,
    cursor, limit = 20, auto_enrich = false, icpSource,
    company_size_min, company_size_max,
  } = args;

  if (!listId) return { success: false, error: 'listId is required' };
  // Accept any of: keywords / search_url / cursor / structured filter.
  // Mirrors the search-people handler gate after Stage 2 + the keyword-synth fix.
  const hasFilter = !!(title || company || company_id
    || location || location_id || industry || industry_id || school || school_id);
  if (!keywords && !search_url && !cursor && !hasFilter) {
    return { success: false, error: 'At least one search filter is required: keywords, search_url, cursor, or a structured filter (title, company, location, industry, school)' };
  }

  const { linkedInOutreachService, isProvenDisconnectError } = await import('../../services/linkedInOutreachService');

  // Access check (ENG-1049): this function creates leads (batchCreateLeads
  // below), and is called directly by the import_leads_from_search Emma tool
  // — bypassing the canDestructiveCrmList check that crm.ts's POST
  // /lists/:listId/leads/find route applies before calling this same method.
  // Without this, any same-org member could import leads into another
  // member's list via Emma chat.
  try {
    const { crmDb: accessCrmDb } = await import('../../services/db');
    const accessList = await accessCrmDb.getLeadListById(listId);
    if (!accessList) {
      return { success: false, error: 'The specified lead list does not exist' };
    }
    const { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../../services/crmAccessControl');
    if (!(await canDestructiveCrmList(userId, accessList))) {
      return { success: false, error: CRM_EDITOR_REQUIRED_MESSAGE };
    }
  } catch (err) {
    // Fail closed — an access-check failure must never silently allow the
    // write. Distinct from the cosmetic, fail-soft list lookups below.
    return { success: false, error: 'Failed to verify list access' };
  }

  // Resolve account: user's own or platform-wide fallback. Keep usedSharedAccount
  // (not the flag-discarding resolveAccountId wrapper) — the reactive handler
  // below needs it to know whether accountId is this user's own account or the
  // ownerless site-wide pool (see the ownerUserId comment there).
  const { accountId, usedSharedAccount } = await linkedInOutreachService.resolveAccountIdWithSource(userId);
  if (!accountId) {
    return {
      success: false,
      error: 'No LinkedIn account is available for lead discovery. Ask your admin to configure platform-wide outreach accounts, or connect your own LinkedIn account in Settings → Connected Accounts.',
    };
  }

  // Build the audit string ONCE — same for every lead in this batch since
  // every lead in this loop came from the same set of filters.
  const findReason = buildFindReason({
    keywords, title, company, location, industry, school, search_url,
  });

  // Hash criteria so we can persist a per-(list, criteria) cursor and pick
  // up where the previous top-up loop stopped on a future call.
  const criteriaHash = computeFindLeadsCriteriaHash({
    keywords, search_url, title, company, company_id,
    location, location_id, industry, industry_id, school, school_id,
  });

  const { crmDb } = await import('../../services/db');

  // Initial cursor: caller-provided wins; otherwise resume from any cursor
  // we previously persisted for this exact criteria set on this list.
  let activeCursor: string | undefined = cursor;
  let preLoopList: any = null;
  try {
    preLoopList = await crmDb.getLeadListById(listId);
    if (!activeCursor) {
      const stored = (preLoopList as any)?.searchCursors?.[criteriaHash];
      if (stored?.cursor) activeCursor = stored.cursor as string;
    }
  } catch {
    // List read failure here is recoverable — fall through with no stored cursor.
  }

  // Top-up loop. Keep paginating until we've added `limit` *new* leads
  // (post-dedup), the search exhausts, or we hit the safety cap.
  const MAX_ITERATIONS = 20;
  let cumulativeNew = 0;
  let cumulativeMerged = 0;
  let totalFetched = 0;
  let iterationCount = 0;
  // `nextCursor` is the cursor we'll pass to the *next* searchPeople call.
  // `lastFetchCursor` is the cursor we passed to the *most recent* call —
  // tracked separately so that, if we end up trimming on the final page,
  // we can resume *that* page on the next call (the deleted-from-CRM leads
  // re-appear as "new" through dedup, so no candidate is permanently lost).
  let nextCursor: string | null | undefined = activeCursor ?? null;
  let lastFetchCursor: string | null | undefined = nextCursor;
  let safetyCapHit = false;
  let searchError: string | null = null;
  let searchUnavailable = false;
  const allErrors: string[] = [];
  // `lead` is the mapped payload the record was written from — the response
  // preview is derived from this so it can only ever describe real writes.
  const allCreated: Array<{ leadId: string; email?: string; lead?: any }> = [];
  // Out-of-network "LinkedIn Member" hits dropped before the write.
  let anonymizedSkipped = 0;
  // ENG-1558: leads dropped by the company_size_min/max post-filter
  // (outside the requested range, or an unverifiable employer).
  let companySizeFiltered = 0;
  // ENG-1558 follow-up: consecutive pages the size filter emptied
  // completely. A narrow company_size range against a market where it's
  // genuinely rare could otherwise burn all MAX_ITERATIONS pages — each
  // costing a full searchPeople call plus per-employer lookups — before
  // giving up. Bail out well before that once the filter has clearly
  // proven unproductive, rather than paying the full cap's cost every time.
  let consecutiveEmptiedBySizeFilter = 0;
  const SIZE_FILTER_EARLY_EXIT_AFTER = 3;
  let earlyExitOnSizeFilter = false;

  while (iterationCount < MAX_ITERATIONS) {
    iterationCount++;
    lastFetchCursor = nextCursor;
    let searchResult: any;
    try {
      // Structured filters (location/industry/school) are auto-resolved to
      // LinkedIn entity IDs by linkedInOutreachService when only free text
      // is supplied; pre-resolved *_id always wins.
      searchResult = await linkedInOutreachService.searchPeople(accountId, {
        keywords,
        url: search_url,
        title,
        company,
        company_id,
        location,
        location_id,
        industry,
        industry_id,
        school,
        school_id,
        cursor: lastFetchCursor ?? undefined,
      });
    } catch (e: any) {
      const infraFailure = isLinkedInInfraError(e);
      if (infraFailure) {
        console.warn('[importLeadsFromSearch] LinkedIn search unavailable (infrastructure):', e?.message);
      }
      searchError = infraFailure
        ? LINKEDIN_UNAVAILABLE_MESSAGE
        : (e?.message ? String(e.message) : String(e));
      // ENG-2205: resolveAccountId can now hand back an account whose probe was
      // merely indeterminate (not proven dead — see linkedInOutreachService's
      // probeAccountSession), so a real failure here is the backstop that proves
      // it either way. On a proven-dead session, correct the probe cache and
      // record the health event — otherwise this account stays cached as
      // 'unknown' for the full 10-minute window and gets handed to the next
      // caller (same user's retry, or another user sharing the site-wide pool)
      // instead of the pool correctly skipping it. Mirrors the identical reactive
      // handler in emma/impl/linkedin.ts. Uses the shared isProvenDisconnectError
      // predicate (not a hand-rolled AUTH_ERROR check) specifically because it
      // excludes a bare 403 — a permission/plan restriction, not a dead session.
      let provenDead = isProvenDisconnectError(e);
      if (provenDead) {
        linkedInOutreachService.clearStatusCache(accountId);
        // Unipile's explicit `errors/disconnected_account` is conclusive. A bare 401 is not (it can be a one-off
        // auth blip), and recording a disconnect pauses scheduled runs and emails the owner, so take a fresh
        // second opinion first; the sync cron still catches a genuinely dead session on its next pass.
        const explicitDisconnect = (e?.structuredError?.code || e?.body?.code || e?.code) === 'errors/disconnected_account';
        if (!explicitDisconnect) {
          provenDead = (await linkedInOutreachService.probeAccountSession(accountId)) === 'disconnected';
        }
      }
      if (provenDead) {
        const { recordUnipileAccountHealth } = await import('../../services/linkedInConnectionHealth');
        // ownerUserId must be omitted for the site-wide pool: recordUnipileAccountHealth
        // resolves an attributed owner only via getAccountsByUserId(ownerUserId) /
        // getAccountsByUserIdIncludingOrgShared(ownerUserId) — neither of which can ever
        // find the global fallback pool account under an unrelated customer's userId. A
        // truthy-but-wrong ownerUserId silently no-ops instead of reaching the dedicated
        // ownerless/oncall branch that exists specifically for this account class.
        await recordUnipileAccountHealth({
          accountId,
          ownerUserId: usedSharedAccount ? undefined : userId,
          state: 'disconnected',
        });
      }
      break;
    }

    const items = Array.isArray(searchResult?.items) ? searchResult.items : [];
    nextCursor = searchResult?.cursor ?? null;

    if (items.length === 0) {
      // ENG-975: breaking here with nothing imported reports "No results found
      // for the given search criteria." — which is also exactly what a schedule
      // whose account has lost people-search capability produces, making a
      // silent no-op look like an honest empty. Only the FIRST fetch of this
      // call is ambiguous; a later page running dry is normal exhaustion.
      //
      // That first fetch is ambiguous even when it resumes from a cursor. A
      // recurring schedule persists its cursor per (list, criteria) and picks
      // it up on the next run without the caller ever passing one, so keying
      // off "no cursor" would exempt precisely the repeat-schedule case this
      // bug was reported from. The probe settles it either way: an exhausted
      // search on a healthy account answers 'ok' and still reports the plain
      // empty, at the cost of one broad query per account per 10 minutes.
      if (iterationCount === 1
        && await linkedInOutreachService.probeSearchCapability(accountId) === 'degraded') {
        searchUnavailable = true;
        const { LINKEDIN_SEARCH_UNAVAILABLE_GUIDANCE } = await import('./linkedin');
        searchError = LINKEDIN_SEARCH_UNAVAILABLE_GUIDANCE;
      }
      break;
    }
    totalFetched += items.length;

    // Map Unipile search result fields → CRM lead fields, then resolve
    // missing companies through a 4-tier fallback chain. Each tier runs
    // only on leads still missing `company`:
    //   1. item.work_experience[].company (sync, from search result)
    //   2. parseCompanyFromTitle (regex, sync, instant)
    //   3. batchParseCompaniesFromTitlesWithLLM (ONE Gemini Flash call for all titles in the batch)
    //   4. Unipile getProfile via cache-first wrapper (HTTP, free on cache hit, parallel)

    // Phase 1: sync map for Tier 1 (work_experience) + Tier 2 (regex).
    const leads: any[] = items.map((item: any) => {
      const lead: any = {};
      if (item.name) {
        const parts = (item.name as string).trim().split(/\s+/);
        lead.firstName = parts[0] || '';
        lead.lastName = parts.slice(1).join(' ') || '';
      } else {
        if (item.first_name) lead.firstName = item.first_name;
        if (item.last_name) lead.lastName = item.last_name;
      }
      if (item.public_identifier) {
        lead.linkedin = `https://www.linkedin.com/in/${item.public_identifier}`;
      } else if (item.profile_url) {
        const baseUrl = (item.profile_url as string).split('?')[0];
        lead.linkedin = baseUrl;
      }
      if (item.headline) lead.title = item.headline;
      if (item.work_experience?.length) {
        const current = item.work_experience.find((w: any) => w.current) || item.work_experience[0];
        if (current?.company && !lead.company) lead.company = current.company;
        if (current?.position && !lead.title) lead.title = current.position;
      }
      if (!lead.company && lead.title) {
        const parsed = parseCompanyFromTitle(lead.title);
        if (parsed) lead.company = parsed;
      }
      if (item.location) {
        lead.customFields = mergeCustomFields(
          lead.customFields,
          { location: item.location },
          { source: 'agentMode.importLeadsFromSearch' },
        );
      }
      // sys is sidecar — see Phase 0b lead.system top-level field.
      const sys: Record<string, any> = {};
      if (findReason) sys.findReason = findReason;
      if (icpSource) sys.icpSource = icpSource;
      if (Object.keys(sys).length > 0) {
        lead.system = { ...(lead.system ?? {}), ...sys };
      }
      return lead;
    });

    // Phase 1b (ENG-1002): drop anonymized / identity-less hits BEFORE any
    // further work. LinkedIn returns out-of-network profiles as the
    // placeholder "LinkedIn Member" with no public identifier; persisting
    // one produces a nameless, emailless, un-linkable record that can never
    // be dedup'd — so every subsequent run of the same search creates
    // another copy. Skipping them also means the top-up loop keeps
    // paginating until it finds `limit` genuinely usable leads.
    const candidates: Array<{ lead: any; item: any }> = [];
    for (let i = 0; i < leads.length; i++) {
      if (isAnonymizedSearchLead(leads[i])) {
        anonymizedSkipped++;
        continue;
      }
      candidates.push({ lead: leads[i], item: items[i] });
    }
    let importable: any[] = candidates.map((c) => c.lead);
    if (importable.length === 0) {
      if (!nextCursor) break;
      continue;
    }

    // Phase 2: Tier 3 — one batched Gemini Flash call for all titles still
    // missing a company. Skipped entirely when no candidates remain.
    const llmIndices: number[] = [];
    const llmTitles: string[] = [];
    for (let i = 0; i < importable.length; i++) {
      if (!importable[i].company && typeof importable[i].title === 'string' && importable[i].title) {
        llmIndices.push(i);
        llmTitles.push(importable[i].title);
      }
    }
    if (llmTitles.length > 0) {
      try {
        const results = await batchParseCompaniesFromTitlesWithLLM(llmTitles, { callLLM }, userId);
        for (let k = 0; k < llmIndices.length; k++) {
          const v = results[k];
          if (v && v !== 'NONE') importable[llmIndices[k]].company = v;
        }
      } catch (e: any) {
        console.warn('[importLeadsFromSearch] LLM batch company-parse failed:', e?.message ?? String(e));
      }
    }

    // Phase 3: Tier 4 — Unipile getProfile for still-empty leads, parallel.
    await Promise.all(candidates.map(async ({ lead, item }) => {
      if (lead.company || !item.public_identifier || !accountId) return;
      try {
        const { getUnipileProfileService } = await import('../../services/unipileProfileServiceFactory');
        const profile = await getUnipileProfileService().getProfile(item.public_identifier, accountId);
        const raw = (profile as any)?.rawData ?? profile;
        const exp = raw?.work_experience;
        if (Array.isArray(exp) && exp.length) {
          const cur = exp.find((w: any) => w.current) || exp[0];
          if (cur?.company) lead.company = cur.company;
        }
      } catch (e: any) {
        console.warn('[importLeadsFromSearch] getProfile fallback failed:', e?.message ?? String(e));
      }
    }));

    // Phase 3.5 (ENG-1558): company-size post-filter, run AFTER every
    // resolution tier above so lead.company reflects the best available
    // employer name — filtering on Tier-1 (work_experience) alone, like
    // search-people does, would wrongly exclude leads whose company only
    // resolved via title-parse/LLM/profile fallback. Adapts each lead's
    // flat `.company` string into the work_experience shape
    // filterByCompanySize expects, tagging each with its array index so
    // the kept subset can be mapped back without disturbing `importable`'s
    // order (batchCreateLeads' returned sourceIndex must match).
    if (company_size_min != null || company_size_max != null) {
      const preFilterCount = importable.length;
      const sizableItems = importable.map((lead: any, idx: number) => ({
        __idx: idx,
        work_experience: lead.company ? [{ company: lead.company, current: true }] : [],
      }));
      const { items: kept } = await linkedInOutreachService.filterByCompanySize(
        sizableItems,
        { min: company_size_min, max: company_size_max },
        accountId,
      );
      const keepIdx = new Set(kept.map((it: any) => it.__idx));
      companySizeFiltered += importable.length - keepIdx.size;
      importable = importable.filter((_: any, i: number) => keepIdx.has(i));

      if (preFilterCount > 0 && importable.length === 0) {
        consecutiveEmptiedBySizeFilter++;
        if (consecutiveEmptiedBySizeFilter >= SIZE_FILTER_EARLY_EXIT_AFTER) {
          // The filter has proven unproductive several pages running —
          // stop paying for more searchPeople + per-employer lookup calls
          // rather than grinding to MAX_ITERATIONS on a range that's
          // clearly not matching this market.
          earlyExitOnSizeFilter = true;
          break;
        }
      } else {
        consecutiveEmptiedBySizeFilter = 0;
      }
    }
    if (importable.length === 0) {
      if (!nextCursor) break;
      continue;
    }

    const result = await crmDb.batchCreateLeads(listId, importable, { origin: 'linkedin' });
    cumulativeNew += result.newCount ?? 0;
    cumulativeMerged += result.mergedCount ?? 0;
    if (Array.isArray(result.errors) && result.errors.length) allErrors.push(...result.errors);
    const created = Array.isArray((result as any).created) ? (result as any).created : [];
    // Carry the source row alongside each created id so the response preview
    // is built from the records that were actually written — not from every
    // candidate we looked at (ENG-1002). Rows that dedup'd into an existing
    // lead, or that were unchanged no-ops, never appear in `created`.
    for (const entry of created) {
      const source = typeof entry?.sourceIndex === 'number' ? importable[entry.sourceIndex] : undefined;
      allCreated.push({ ...entry, lead: source });
    }

    if (cumulativeNew >= limit) break;
    if (!nextCursor) break;
  }

  // Did we exit because we hit the safety cap with more pages still
  // available? (Surfaces when iteration ran the full count without hitting
  // limit and a cursor remains.)
  if (iterationCount >= MAX_ITERATIONS && cumulativeNew < limit && nextCursor) {
    safetyCapHit = true;
  }

  // Trim post-hoc to exactly `limit` new leads. Trailing IDs in
  // `allCreated` come from the last batch insert in iteration order, so
  // dropping `excess` from the end gives a stable, predictable trim.
  let trimmedCount = 0;
  if (cumulativeNew > limit) {
    const excess = cumulativeNew - limit;
    const toTrim = allCreated.slice(allCreated.length - excess);
    for (const entry of toTrim) {
      try {
        await crmDb.deleteLead(listId, entry.leadId);
      } catch (e: any) {
        allErrors.push(`Failed to trim lead ${entry.leadId}: ${e?.message || e}`);
      }
    }
    allCreated.splice(allCreated.length - excess, excess);
    cumulativeNew -= excess;
    trimmedCount = excess;
  }

  // Resume cursor — the value we both surface to callers and persist:
  //  - If we trimmed on the final page, resume from THAT page's fetch
  //    cursor (lastFetchCursor) so the next call re-fetches it. The
  //    just-deleted leads come back through dedup as "new", so no candidate
  //    is permanently lost across calls.
  //  - Otherwise we advanced cleanly through every page we processed, so
  //    resume from `nextCursor` (the cursor returned by the last fetch).
  const resumeCursor: string | null = (trimmedCount > 0 ? lastFetchCursor : nextCursor) ?? null;
  try {
    await crmDb.setLeadListSearchCursor(listId, criteriaHash, resumeCursor);
  } catch {
    // Persistence failure is non-fatal — the loop already imported the leads.
  }

  // Surface the post-import list count.
  let listTotalAfterImport = 0;
  try {
    const list = await crmDb.getLeadListById(listId);
    listTotalAfterImport = (list as any)?.leadCount ?? 0;
  } catch {
    // List read failure must not fail the import — count of 0 signals
    // "unknown" to the caller and they can re-fetch separately.
  }

  const response: any = {
    success: true,
    imported: cumulativeNew,
    skipped: cumulativeMerged,
    list_total_after_import: listTotalAfterImport,
    errors: allErrors,
    total: totalFetched,
    cursor: resumeCursor,
    iterations: iterationCount,
    trimmed: trimmedCount,
    anonymizedSkipped,
    companySizeFiltered,
    safetyCapHit,
  };
  if (searchError) response.searchError = searchError;
  if (searchUnavailable) response.searchUnavailable = true;
  if (earlyExitOnSizeFilter) response.earlyExitOnSizeFilter = true;
  if (cumulativeNew === 0 && totalFetched === 0 && !searchError) {
    response.message = 'No results found for the given search criteria.';
  } else if (earlyExitOnSizeFilter) {
    // ENG-1558 follow-up: distinct from (and takes priority over) the
    // generic "excluded all, search exhausted normally" message below —
    // this stopped BEFORE exhausting, so there may be more matches the
    // cursor can still reach.
    response.message = cumulativeNew > 0
      ? `Imported ${cumulativeNew} lead(s), then stopped early after ${SIZE_FILTER_EARLY_EXIT_AFTER} consecutive pages where the company_size filter excluded every result. There may be more matches — resume from the returned cursor, or widen the range.`
      : `Stopped after ${SIZE_FILTER_EARLY_EXIT_AFTER} consecutive pages where every result was excluded by the company_size filter (out of range, or an unverifiable employer) — this looks like a narrow niche for this market, not an empty search. Widen the company_size range, or drop it to import the unfiltered results.`;
  } else if (cumulativeNew === 0 && anonymizedSkipped > 0 && !searchError) {
    response.message = `${anonymizedSkipped} search result(s) were out-of-network LinkedIn profiles with no name or profile URL and were not imported. Widen the search or connect a LinkedIn account with closer network reach.`;
  } else if (cumulativeNew === 0 && companySizeFiltered > 0 && !searchError) {
    // ENG-1558: same transparency principle as the anonymized-skip case
    // above — a company-size ask that excluded every candidate is a
    // narrow-niche result, not an empty search and not an outage.
    response.message = `${companySizeFiltered} search result(s) were excluded because their employer's size either fell outside the requested range or couldn't be verified. Widen the company_size range, or drop it to import the unfiltered results.`;
  }
  // Preview strictly the records that were written and survived trimming.
  response.importedLeads = allCreated.slice(0, 5).map((c) => c.lead).filter(Boolean);

  if (auto_enrich && cumulativeNew > 0) {
    const newLeadIds: string[] = allCreated.map((c) => c.leadId);
    if (newLeadIds.length > 0) {
      const autoEnrichModule = await import('../../services/agentModeService.autoEnrich');
      const job = await autoEnrichModule.enqueueFindEmailJobForNewLeads(userId, listId, newLeadIds);
      // Guard on jobId rather than truthiness — autoEnrich returns a
      // sentinel { jobId: '', queued: 0, reason: 'quota-exhausted' } in
      // the no-budget path that we must not surface as a job id.
      if (job?.jobId) response.autoEnrichJobId = job.jobId;
    }
  }

  return response;
}
