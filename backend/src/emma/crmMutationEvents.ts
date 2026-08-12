// CRM data-change notification helper.
//
// When the agent successfully runs a CRM-mutating tool (update a lead, send an
// email, change status, import leads, …), the CRM page in the customer portal
// needs to refresh so the user sees the new data WITHOUT a manual reload.
//
// Enrichment and tech-stack detection already broadcast their own completion
// events (`crm-enrichment-complete` / `crm-tech-stack-complete`) which the CRM
// page listens to. This helper covers the remaining write tools by emitting a
// single generic `crm-data-changed` event carrying the affected listId (and
// leadId when the mutation targets one lead) so the page can refetch.

/** Socket.IO event name the CRM page listens to for generic data refreshes. */
export const CRM_DATA_CHANGED_EVENT = 'crm-data-changed';

// Tools that mutate CRM lead/list data and therefore warrant a refresh.
//
// Deliberately EXCLUDES the enrichment tools (`enrich_leads_execute`,
// `enrich_leads_preview`, `enrich_lead_custom`) and tech-stack detection —
// those already emit their own richer completion events, so adding
// crm-data-changed for them would just double the refetch.
export const CRM_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'update_lead',
  'update_lead_status',
  'set_lead_contact_status',
  'send_email_to_lead',
  'update_email_draft_for_lead',
  'add_leads_to_list',
  'delete_leads',
  'delete_leads_by_filter',
  'create_lead_list',
  'update_lead_list',
  'delete_lead_list',
  'configure_lead_statuses',
  'add_lead_engagement',
  'assign_lead',
  'import_leads_from_search',
]);

/**
 * Should a CRM-mutating tool result broadcast a refresh?
 *
 * A result that reports `success: false` normally wrote nothing, so the page
 * has nothing new to show. A PARTIAL import is the exception (ENG-1133): it
 * reports the call as incomplete — so the agent resumes the missing rows
 * instead of claiming a clean import — while the rows that did land are
 * already in the list and have to appear without a manual reload.
 */
export function shouldEmitCrmDataChanged(result: unknown): boolean {
  const r = result as { success?: unknown; partial?: unknown } | null | undefined;
  if (r && r.success === false) {
    return r.partial === true;
  }
  return true;
}

export interface CrmDataChangedPayload {
  /** The affected lead list, when the tool targets one. Absent for list-create. */
  listId?: string;
  /** The affected lead, when the tool targets a single lead. */
  leadId?: string;
  /** The tool that triggered the change — for debugging / future filtering. */
  source: string;
}

/**
 * Build the `crm-data-changed` payload for a successful tool call, or return
 * `null` when the tool is not a CRM mutation (so the caller emits nothing).
 *
 * Reads `list_id` / `lead_id` from the tool arguments when present. These are
 * optional in the payload: `create_lead_list` has no list_id yet, and the CRM
 * page treats a missing listId as "refresh the list index regardless".
 */
export function buildCrmDataChangedPayload(
  toolName: string,
  args: Record<string, unknown> | undefined | null,
): CrmDataChangedPayload | null {
  if (!CRM_MUTATING_TOOLS.has(toolName)) return null;

  const payload: CrmDataChangedPayload = { source: toolName };

  const listId = args?.list_id;
  if (typeof listId === 'string' && listId.length > 0) {
    payload.listId = listId;
  }

  const leadId = args?.lead_id;
  if (typeof leadId === 'string' && leadId.length > 0) {
    payload.leadId = leadId;
  }

  return payload;
}
