/**
 * ENG-1557 v1: lets `manage_leads` action `add` create a lead in a specific
 * customer's list on the customer's behalf, via `client_id` — the first
 * write action to graduate out of ENG-1596's read-only descope. Scoped
 * narrowly per Harsha's own ask on ENG-1557 ("scope v1 to a specific
 * object/action behind a flag, with dry-run/logging first"): only `add`,
 * gated by MANAGE_LEADS_CROSS_ACCOUNT_ADD_ENABLED (default OFF), with a
 * `dry_run` mode that works regardless of the flag so the mechanism can be
 * proven out before anything is ever actually written.
 *
 * Reuses `resolveClientScopedContext` unconditionally — admin check, target
 * customer check, and delegate-token mint all run even on a dry-run call,
 * since proving THAT mechanism works is exactly what's being demonstrated
 * before the flag gets flipped. Only the actual mutating `mcpFetch` call is
 * gated by dry_run/the flag; nothing else changes from how `list`/`get`
 * already work.
 *
 * `update`/`delete` remain hard-rejected in apiTools.ts — this module is
 * `add`-only by design, not a general write-enablement point.
 */

import { mcpFetch } from './httpClient';
import { jsonResult } from './toolHelpers';
import { resolveClientScopedContext } from './adminClientScope';
import { recordAdminAudit } from '../../services/adminAuditLog';

const isCrossAccountAddEnabled = (): boolean =>
  process.env.MANAGE_LEADS_CROSS_ACCOUNT_ADD_ENABLED === 'true';

/**
 * `manage_leads` action `add` sends one lead per call. The tool's `leads`
 * input is array-typed (matching the pre-existing schema), but the REST
 * route it calls (`POST /api/crm/lists/:listId/leads`) has always read
 * `req.body` as a single lead's fields directly, never `{ leads: [...] }` —
 * so every prior `add` call (cross-account or not) has silently sent the
 * wrong shape and created a lead with every field undefined. Fixed here,
 * not folded into the client_id feature: this changes behavior for the
 * existing self-scoped `add` path too, as its own correctness fix.
 */
export function normalizeAddLeadPayload(leads: unknown): Record<string, unknown> {
  if (!Array.isArray(leads) || leads.length !== 1) {
    throw new Error(
      `manage_leads action "add" creates exactly one lead per call; received ${Array.isArray(leads) ? leads.length : typeof leads}.`
    );
  }
  return leads[0] as Record<string, unknown>;
}

/**
 * Previews what a real `add` would do, without ever calling
 * `crmDb.createLead`. Replicates the REST route's own checks
 * (`crm.ts`'s `POST /lists/:listId/leads`) in the same order — list exists,
 * caller has CRM-editor access to it, no existing lead with the same email —
 * so the preview reflects what the real write would actually decide.
 *
 * Known tradeoff: check ORDER is duplicated between that route and this
 * function. If the route's own checks are ever reordered or extended, this
 * preview won't automatically follow — update both together.
 */
export async function previewLeadAdd(
  actingUserId: string,
  listId: string,
  leadPayload: Record<string, unknown>,
): Promise<{ wouldSucceed: boolean; reason?: string; existingLeadId?: string; listName?: string }> {
  const { crmDb } = await import('../../services/db');
  const { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } = await import('../../services/crmAccessControl');

  const list = await crmDb.getLeadListById(listId);
  if (!list) {
    return { wouldSucceed: false, reason: 'Lead list not found' };
  }

  if (!(await canDestructiveCrmList(actingUserId, list))) {
    return { wouldSucceed: false, reason: CRM_EDITOR_REQUIRED_MESSAGE };
  }

  const email = typeof leadPayload.email === 'string' ? leadPayload.email.trim().toLowerCase() : undefined;
  if (email) {
    const existing = await crmDb.getLeadByEmail(listId, email);
    if (existing) {
      return {
        wouldSucceed: false,
        reason: `Lead with email "${leadPayload.email}" already exists in this list`,
        existingLeadId: (existing as any).leadId,
      };
    }
  }

  return { wouldSucceed: true, listName: (list as any).name };
}

/**
 * Handles `manage_leads` `action:'add'` when `client_id` is present.
 * `apiTools.ts` only reaches this for `add` — `update`/`delete` never call in
 * here at all, they stay hard-rejected at the call site.
 */
export async function executeCrossAccountLeadAdd(args: any, context: any): Promise<any> {
  const listId = args.list_id;

  // Runs unconditionally, before dry_run/the flag are even inspected — even a
  // dry-run must prove the admin-check + delegate-token mint actually works,
  // since that's exactly what's being proven out before the flag gets
  // flipped. Throws immediately for a non-admin caller or an unresolvable
  // client_id, regardless of dry_run/flag state.
  const c = await resolveClientScopedContext(context, args.client_id, 'manage_leads');
  const scope = c.resolvedScope!; // always populated here — client_id is guaranteed present by the caller in apiTools.ts

  const leadPayload = normalizeAddLeadPayload(args.leads);
  const dryRun = args.dry_run === true;

  const auditBase = {
    actorUserId: scope.caller.userId,
    actorEmail: scope.caller.email,
    action: 'manage_leads_cross_account_add' as const,
    tool: 'manage_leads',
    targetUserId: scope.target.userId,
    targetEmail: scope.target.email,
    listId,
    leadEmail: typeof leadPayload.email === 'string' ? leadPayload.email : undefined,
    dryRun,
  };

  if (dryRun) {
    recordAdminAudit({ ...auditBase, outcome: 'planned' });
    const preview = await previewLeadAdd(scope.target.userId, listId, leadPayload);
    return jsonResult({ dryRun: true, ...preview });
  }

  if (!isCrossAccountAddEnabled()) {
    recordAdminAudit({ ...auditBase, outcome: 'blocked_by_flag' });
    throw new Error(
      'manage_leads cross-account "add" is disabled — set MANAGE_LEADS_CROSS_ACCOUNT_ADD_ENABLED=true to allow it. dry_run:true still works regardless of this flag.'
    );
  }

  recordAdminAudit({ ...auditBase, outcome: 'planned' });
  try {
    const data = await mcpFetch({
      method: 'POST',
      path: `/api/crm/lists/${listId}/leads`,
      context: c,
      body: leadPayload,
    });
    recordAdminAudit({ ...auditBase, outcome: 'created', leadId: data?.leadId });
    return jsonResult(data);
  } catch (error: any) {
    recordAdminAudit({ ...auditBase, outcome: 'failed', error: error?.message });
    throw error;
  }
}
