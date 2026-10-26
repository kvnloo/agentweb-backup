/**
 * Emma tool: call_attio_api — Attio list/list-entry management and
 * CPL/attribution lead counts. Extracted out of the AgentMode monolith
 * (agentModeService.ts is "mid-restructure": new CRM-integration business
 * logic belongs under services/agentMode/*.ts, not inline in that file).
 *
 * Deliberately narrower than handleHubspotApi — Attio has no equivalent of
 * HubSpot's marketing-asset concepts (campaigns, emails, landing pages,
 * workflows, social broadcasts), so this only covers lists and list entries.
 *
 * Self-contained: no dependency on AgentModeService instance state, so it's
 * a plain module of free functions rather than requiring injected ports.
 */

import { AttioService } from '../attioService';

// call_attio_api's LIST_ENTRIES ADD_ENTRIES/REMOVE_ENTRIES accept a caller-supplied
// record_ids array with no inherent size limit. Cap it and bound concurrency so a
// large or malicious batch can't fan out into an unbounded burst of Attio API calls.
const MAX_LIST_ENTRY_RECORD_IDS = 100;
const LIST_ENTRY_CONCURRENCY = 5;

async function runWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

const RECORD_ENTITY_ALIASES: Record<string, 'people' | 'companies'> = {
  PERSON: 'people', PEOPLE: 'people', CONTACT: 'people', CONTACTS: 'people',
  COMPANY: 'companies', COMPANIES: 'companies',
};
const SEARCH_ACTION_ALIASES = new Set(['SEARCH', 'SEARCH_RECORDS', 'FIND', 'FIND_RECORDS']);

/**
 * Repairs the model's common call_attio_api record-lookup shapes (ENG-2580,
 * prod agent_tool_failed): `{action:'search_records', params:{query}}` with no
 * entity_type, and `{entity_type:'person', action:'list'}`. Hoists `params.*`
 * fields that are not already set at the top level.
 */
export function normalizeAttioArgs(raw: any): { args: any; entityType: string; action: string } {
  const args: any = { ...(raw ?? {}) };
  if (args.params && typeof args.params === 'object' && !Array.isArray(args.params)) {
    for (const [k, v] of Object.entries(args.params)) if (args[k] === undefined) args[k] = v;
  }
  let entityType = String(args.entity_type ?? '').toUpperCase();
  let action = String(args.action ?? '').toUpperCase();
  if (SEARCH_ACTION_ALIASES.has(action)) action = 'SEARCH';
  if (RECORD_ENTITY_ALIASES[entityType]) {
    if (args.object_type === undefined) args.object_type = RECORD_ENTITY_ALIASES[entityType];
    entityType = 'RECORDS';
  }
  if (!entityType && action === 'SEARCH' && args.query !== undefined) entityType = 'RECORDS';
  // No workspace endpoint is exposed by this service. Reach the actionable
  // handler diagnostic rather than failing required-field validation.
  if (!entityType && action === 'GET_WORKSPACE') entityType = 'WORKSPACE';
  delete args.params;
  return { args, entityType, action };
}

async function resolveAttioService(userId: string, accountId?: string): Promise<AttioService> {
  try {
    return await AttioService.create(userId, accountId);
  } catch (err: any) {
    // An explicit account_id or a multi-account ambiguity is actionable by the
    // caller — surface it instead of silently falling back to token-paste.
    if (accountId || /multiple attio accounts/i.test(err?.message ?? '')) throw err;
    // Fall back to token-paste: scan lead lists for Attio apiKeyEncrypted
  }
  const { crmDb } = await import('../db');
  const lists = await crmDb.getLeadListsByUserId(userId);
  for (const list of lists as any[]) {
    const attioConfig = list?.externalCrmSyncConfigs?.attio;
    if (attioConfig?.apiKeyEncrypted) {
      const { decryptPassword } = await import('../../utils/crypto');
      const { password } = decryptPassword(attioConfig.apiKeyEncrypted);
      return AttioService.fromToken(password);
    }
  }
  throw new Error('No Attio account connected. Please connect Attio in Settings → External CRM Sync or via OAuth in Connected Accounts.');
}

/**
 * Resolves a `list_id` argument that may be either an AgentWeb lead-list id
 * or a raw Attio list id. Emma's other tools (get_lead_lists, etc.) only
 * ever hand back AgentWeb list ids, so without this the model has no way
 * to discover the Attio deal-list's actual id and either guesses wrong
 * (404) or asks the user to paste a UUID it has no reason to know. If
 * `candidateId` matches one of the user's own lead lists with a cached
 * `attioDealListId`, substitute that; otherwise assume it's already a raw
 * Attio list id (still supported, for anyone who does have one to hand).
 *
 * When candidateId DOES resolve to a real AgentWeb list, enforces this
 * repo's shared CRM sharing policy before returning its Attio list id —
 * externalCrmSyncService.getConfig's own visibility check only requires
 * same-org membership, which is not sufficient for a mutating action
 * (a same-org member who isn't the list owner/org owner/CRM editor must
 * not be able to add or remove entries in another member's Attio deal
 * list just by knowing their AgentWeb list id). Raw Attio list ids that
 * don't match any AgentWeb list are unaffected — the mutation there runs
 * under the caller's own connected Attio credentials with no AgentWeb
 * object to protect, same as always.
 */
async function resolveAttioListId(userId: string, candidateId: string, requireDestructive: boolean = false): Promise<string> {
  const { crmDb } = await import('../db');
  const list = await crmDb.getLeadListById(candidateId).catch(() => null) as any;
  // Gate on `list` alone, not `list && attioDealListId` — the access check
  // must fire whenever candidateId resolves to a real AgentWeb list owned by
  // someone else, regardless of whether that list has synced to Attio yet.
  // The narrower gate let a caller name another member's not-yet-synced
  // AgentWeb list id and fall through with zero access check (harmless today
  // only because the fallthrough then 404s against the caller's own Attio
  // credentials — structurally fragile, not something to rely on).
  if (list) {
    const { canAccessCrmList, canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../crmAccessControl');
    const allowed = requireDestructive
      ? await canDestructiveCrmList(userId, list)
      : await canAccessCrmList(userId, list);
    if (!allowed) throw new Error(CRM_EDITOR_REQUIRED_MESSAGE);
    const attioDealListId = list.externalCrmSyncConfigs?.attio?.attioDealListId;
    if (attioDealListId) return attioDealListId;
    throw new Error(`List "${list.name || candidateId}" hasn't synced to an Attio deal list yet — push it once first.`);
  }
  return candidateId;
}

/** Whether the given raw Attio list id holds Company records rather than People. */
async function isAttioCompanyList(svc: AttioService, attioListId: string): Promise<boolean> {
  try {
    const lists = await svc.getAllLists();
    return lists.find(l => l.id === attioListId)?.parentObject === 'companies';
  } catch {
    // Lookup failure — default to the pre-existing people-only behavior.
    return false;
  }
}

/**
 * Emma tool: read-only Attio lead counts, for CPL/attribution reporting, plus
 * Attio list/list-entry management. See call_attio_api's tool definition
 * (emma/tools.ts) for the full ENTITY_TYPE + ACTION matrix.
 */
export async function handleAttioApi(userId: string, args: any): Promise<any> {
  const normalized = normalizeAttioArgs(args);
  args = normalized.args;
  const entityType: string = normalized.entityType;
  const action: string = normalized.action;
  if (!entityType) {
    return { success: false, error: 'entity_type is required. Valid: RECORDS (SEARCH/LIST people or companies), LIST_ENTRIES, LISTS.' };
  }
  if (!['RECORDS', 'LIST_ENTRIES', 'LISTS'].includes(entityType)) {
    return { success: false, error: `Unknown entity_type "${entityType}". Valid: RECORDS (SEARCH/LIST people or companies), LIST_ENTRIES (LIST/COUNT/ADD_ENTRIES/REMOVE_ENTRIES), LISTS. Workspace lookup is not supported; use LISTS LIST to discover lists.` };
  }
  try {
    const svc = await resolveAttioService(userId, args?.account_id);

    // ─── LIST_ENTRIES ──────────────────────────────────────────────────────
    // Entry-level actions scoped to one already-identified list — these go
    // through resolveAttioListId (AgentWeb list id or raw Attio list id),
    // same as the pre-existing COUNT action.
    if (entityType === 'LIST_ENTRIES') {
      switch (action) {
        case 'COUNT': {
          if (!args?.list_id) return { success: false, error: 'list_id is required for LIST_ENTRIES COUNT.' };
          const attioListId = await resolveAttioListId(userId, args.list_id, false);
          const { count, capped } = await svc.countListEntries(attioListId);
          return {
            success: true,
            count,
            ...(capped
              ? { capped: true, note: `This list has more than ${count} entries; the count was capped for performance and reflects a floor, not the exact total.` }
              : {}),
          };
        }
        case 'LIST': {
          // Read one page of the list's entries (ENG-2578). Agents asked for
          // this and got "Unknown action" — there was no read path at all.
          if (!args?.list_id) return { success: false, error: 'list_id is required for LIST_ENTRIES LIST.' };
          const rawOffset = Number(args?.offset ?? 0);
          const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
          const attioListId = await resolveAttioListId(userId, args.list_id, false);
          const { entries, nextOffset } = await svc.listListEntriesDetailed(attioListId, offset);
          return {
            success: true,
            entries: entries.map(e => ({ entryId: e.entryId, recordId: e.personRecordId, values: e.values })),
            ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
          };
        }
        case 'ADD_ENTRIES': {
          if (!args?.list_id) return { success: false, error: 'list_id is required for LIST_ENTRIES ADD_ENTRIES.' };
          // record_ids comes from model-generated tool arguments and is never
          // type-checked against the schema — a string here (e.g. a single id
          // passed without brackets) has a truthy .length and would otherwise
          // be iterated character-by-character.
          const rawAddIds: unknown[] = Array.isArray(args?.record_ids) ? args.record_ids : [];
          if (!rawAddIds.length || rawAddIds.some(id => typeof id !== 'string' || !id.trim())) {
            return { success: false, error: 'record_ids must be a non-empty array of record id strings for LIST_ENTRIES ADD_ENTRIES.' };
          }
          // Dedupe within the call — each add is otherwise its own entry (ENG-2632).
          const recordIds: string[] = [...new Set((rawAddIds as string[]).map(id => id.trim()))];
          if (recordIds.length > MAX_LIST_ENTRY_RECORD_IDS) {
            return { success: false, error: `record_ids exceeds the maximum of ${MAX_LIST_ENTRY_RECORD_IDS} per call.` };
          }
          const attioListId = await resolveAttioListId(userId, args.list_id, true);
          // Company lists send parent_object: 'companies' to Attio, not 'people' —
          // addPersonToList always assumes people, so a company record silently
          // fails to attach unless we route by the list's actual object type.
          const isCompanyList = await isAttioCompanyList(svc, attioListId);
          const results = await runWithConcurrency(recordIds, LIST_ENTRY_CONCURRENCY, async recordId => {
            try {
              // Upsert (PUT) so re-adding a record already on the list is a
              // no-op rather than a second entry (ENG-2632).
              const entryId = await svc.upsertListEntry(attioListId, recordId, isCompanyList ? 'companies' : 'people');
              return { recordId, success: true, entryId };
            } catch (err: any) {
              return { recordId, success: false, error: err?.response?.data?.message ?? err?.message };
            }
          });
          // If every record failed, the call as a whole did not succeed —
          // the model should see that rather than a blanket success: true.
          return { success: results.some(r => r.success), results };
        }
        case 'REMOVE_ENTRIES': {
          if (!args?.list_id) return { success: false, error: 'list_id is required for LIST_ENTRIES REMOVE_ENTRIES.' };
          const rawRemoveIds: unknown[] = Array.isArray(args?.record_ids) ? args.record_ids : [];
          if (!rawRemoveIds.length || rawRemoveIds.some(id => typeof id !== 'string' || !id.trim())) {
            return { success: false, error: 'record_ids must be a non-empty array of record id strings for LIST_ENTRIES REMOVE_ENTRIES.' };
          }
          const recordIds: string[] = [...new Set((rawRemoveIds as string[]).map(id => id.trim()))];
          if (recordIds.length > MAX_LIST_ENTRY_RECORD_IDS) {
            return { success: false, error: `record_ids exceeds the maximum of ${MAX_LIST_ENTRY_RECORD_IDS} per call.` };
          }
          const attioListId = await resolveAttioListId(userId, args.list_id, true);
          const isCompanyList = await isAttioCompanyList(svc, attioListId);
          const objectSlug: 'people' | 'companies' = isCompanyList ? 'companies' : 'people';
          const results = await runWithConcurrency(recordIds, LIST_ENTRY_CONCURRENCY, async recordId => {
            try {
              // A record can hold several entries in one list; remove them all
              // or the record stays on the list after a "remove" (ENG-2632).
              const entryIds = await svc.findListEntries(attioListId, recordId, objectSlug);
              if (!entryIds.length) return { recordId, success: false, error: 'No list entry found for this record.' };
              for (const entryId of entryIds) await svc.deleteListEntry(attioListId, entryId);
              return { recordId, success: true, removedEntries: entryIds.length };
            } catch (err: any) {
              return { recordId, success: false, error: err?.response?.data?.message ?? err?.message };
            }
          });
          return { success: results.some(r => r.success), results };
        }
        default:
          return { success: false, error: `Unknown action "${action}" for LIST_ENTRIES. Valid: COUNT, LIST, ADD_ENTRIES, REMOVE_ENTRIES.` };
      }
    }

    // ─── LISTS ─────────────────────────────────────────────────────────────
    // Whole-list actions (create/enumerate a list itself). No DELETE action:
    // live-verified against Attio's REST API that no delete-list endpoint
    // exists at all — deleting a list is only possible through Attio's own
    // UI. Deliberately NOT routed through resolveAttioListId — that helper
    // exists specifically to disambiguate an entry-scoped id against one
    // already-bound deal list, and applying it here (e.g. to a raw id
    // returned by LIST/GET) risks silently resolving to an unrelated
    // AgentWeb list's own deal-list id.
    if (entityType === 'LISTS') {
      switch (action) {
        case 'LIST': {
          const lists = await svc.getAllLists();
          return { success: true, lists };
        }
        case 'GET': {
          if (!args?.list_id) return { success: false, error: 'list_id is required for LISTS GET.' };
          const lists = await svc.getAllLists();
          const list = lists.find(l => l.id === args.list_id);
          if (!list) return { success: false, error: `List not found in Attio: ${args.list_id}` };
          return { success: true, list };
        }
        case 'CREATE': {
          const name: string = args?.name ?? '';
          if (!name.trim()) return { success: false, error: 'name is required for LISTS CREATE.' };
          const objectSlug: 'people' | 'companies' = args?.object_type === 'companies' ? 'companies' : 'people';
          const listId = await svc.createList(name.trim(), objectSlug);
          return { success: true, list_id: listId };
        }
        default:
          return { success: false, error: `Unknown action "${action}" for LISTS. Valid: LIST, GET, CREATE. (Attio's API has no delete-list endpoint — remove a list from Attio's own UI.)` };
      }
    }

    // ─── RECORDS (ENG-2580) ────────────────────────────────────────────────
    // Read-only People/Company lookup. Agents tried search_records / PERSON
    // LIST and had no read path at all.
    if (entityType === 'RECORDS') {
      const objectSlug: 'people' | 'companies' = args?.object_type === 'companies' ? 'companies' : 'people';
      switch (action) {
        case 'SEARCH': {
          const query = typeof args?.query === 'string' ? args.query.trim() : '';
          if (!query) return { success: false, error: 'query is required for RECORDS SEARCH.' };
          const records = await svc.searchRecords(objectSlug, query);
          return { success: true, object_type: objectSlug, records };
        }
        case 'LIST': {
          const rawOffset = Number(args?.offset ?? 0);
          const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
          const page = objectSlug === 'companies' ? await svc.listCompanies(offset) : await svc.listPeople(offset);
          const records = 'companies' in page ? page.companies : page.people;
          return {
            success: true,
            object_type: objectSlug,
            records,
            ...(page.nextOffset !== undefined ? { next_offset: page.nextOffset } : {}),
          };
        }
        default:
          return { success: false, error: `Unknown action "${action}" for RECORDS. Valid: SEARCH, LIST.` };
      }
    }

    return { success: false, error: `Unknown entity_type "${entityType}". Valid: RECORDS, LIST_ENTRIES, LISTS.` };
  } catch (err: any) {
    return { success: false, error: err?.message ?? 'Attio API call failed.', attioError: err?.response?.data ?? null, status: err?.response?.status ?? null };
  }
}
