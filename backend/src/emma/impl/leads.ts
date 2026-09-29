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
 *  - `importLeadsFromSearch` (far from this cluster in the source file, near
 *    line 36752) does an "LLM batch company-parse" — same `this.callLLM`-shaped
 *    issue.
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
 */
import { LEAD_STANDARD_FILTER_FIELDS, projectLeadAttribution, defaultStatusConfigFor } from '../../utils/leadSchema';
import type { LeadImportRowOutcome } from '../../utils/leadSchema';
import { providerLabel } from '../../services/crmSenderTypes';
import { mergeCustomFields } from '../../utils/customFieldsGuard';
import { recoverLeadFromWrongList } from '../../services/agentMode/leadRecovery';
import { getCrmSenders } from './shared/crmSenders';

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

export async function createLeadList(name: string, description: string, userId: string, listType?: 'sales' | 'customers'): Promise<any> {
    try {
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
        // A file the user may re-send after a truncated run: dedupe the rows
        // that carry no identity of their own, or every retry duplicates them.
        dedupeByNameCompany: true,
        // Come back with a resumable partial rather than being guillotined by
        // the whole-turn cap with nothing to report (ENG-1133). Clamped to the
        // run's remaining budget: a full-length budget started late in a turn
        // would outlive the turn and lose the ledger it exists to produce.
        deadlineMs: leadImportWriteBudgetMs(Date.now(), options.turnDeadlineMs),
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

export async function getLeads(listId: string, userId: string, options: {
    search?: string;
    icpOnly?: boolean;
    engagedOnly?: boolean;
    status?: string;
    limit?: number;
    cursor?: string;
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

      if ((!filters || filters.length === 0) && !options?.search?.trim()) {
        return { success: false, message: 'At least one filter is required', error: 'Provide at least one filter criterion' };
      }

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

export async function getLeadDetails(listId: string, leadId: string, userId: string): Promise<any> {
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
      if (!lead) {
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
        crmDb.getLeadEngagements(listId, leadId, userId)
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

      const accountId: string | null = (list as any).linkedInAccountId ?? null;
      if (!accountId) {
        return {
          success: false,
          message: 'This list has no LinkedIn account assigned',
          error: 'Follow-up detection requires a LinkedIn account (list.linkedInAccountId) so connection status can be resolved. Assign one in the list settings.',
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

      void (async () => {
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
    listType?: 'sales' | 'customers';
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
    notes?: string
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
      const updates: any = { status };
      if (dealValue !== undefined) updates.dealValue = dealValue;
      if (dealCurrency !== undefined) updates.dealCurrency = dealCurrency;

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

export async function getLeadEngagements(listId: string, leadId: string, userId: string, limit?: number): Promise<any> {
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
        crmDb.getLeadEngagements(listId, leadId, userId)
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

export async function addLeadEngagement(
    listId: string, leadId: string, eventType: string,
    userId: string, eventData?: any, eventDate?: string
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

      const lead = await crmDb.getLeadById(listId, leadId);
      if (!lead) {
        return { success: false, message: 'Lead not found', error: 'The specified lead does not exist in this list' };
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
        if (error instanceof SenderDailyLimitExceededError) {
          return { success: false, message: 'Daily sending limit reached', error: error.message };
        }
        throw error;
      }

      // Clear the draft after successful send
      await crmDb.updateLead(listId, leadId, { emailDraft: null });

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
