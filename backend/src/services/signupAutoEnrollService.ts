/**
 * Signup Auto-Enroll Service
 *
 * When a new user signs up for AgentWeb, we auto-enroll them as a lead in the
 * founders@ "AgentWeb Signups" list so Emma (and the founders sales loop) can
 * see every signup without any manual import step.
 *
 * Today this is hard-scoped to founders@ because the customer-facing CRM is
 * single-tenant. When the multi-tenant Epic lands, this service's caller will
 * pass a `tenantId` and the list lookup will key on that — everything else
 * (idempotency, field merging, system-managed flag) is already multi-tenant
 * ready.
 *
 * Invariants:
 *  - Idempotent on email: a second signup with the same email does NOT create
 *    a duplicate lead row. It no-ops and logs.
 *  - Errors never propagate — signup must never fail because auto-enroll did.
 *  - Only fires when the scope is platform-level (i.e. no tenantId override).
 *    Tenant-scoped signups do NOT get enrolled into the founders list.
 *
 * Task: https://www.notion.so/34309247c95181ab8f61c0c651fc1cf3
 */

import type { SyncInput, SyncResult } from './contactSyncService';
import type { AttributionTouch } from '../types/attribution';
import { crmDb as defaultCrmDb } from './db';

/**
 * Flatten an AttributionTouch blob into the same customFields shape that
 * crmAutoSyncService writes on regular auto-sync. Keeps the two auto-enroll
 * paths producing structurally identical lead rows so the frontend filter +
 * Source column show the correct bucket regardless of which service created
 * the lead.
 */
function flattenAttributionToCustomFields(touch?: AttributionTouch): Record<string, string> {
  if (!touch) return {};
  const cf: Record<string, string> = {};
  if (touch.utm?.source) cf.utm_source = touch.utm.source;
  if (touch.utm?.medium) cf.utm_medium = touch.utm.medium;
  if (touch.utm?.campaign) cf.utm_campaign = touch.utm.campaign;
  if (touch.utm?.content) cf.utm_content = touch.utm.content;
  if (touch.utm?.term) cf.utm_term = touch.utm.term;
  if (touch.clickIds?.gclid) cf.gclid = touch.clickIds.gclid;
  if (touch.clickIds?.fbclid) cf.fbclid = touch.clickIds.fbclid;
  if (touch.clickIds?.ttclid) cf.ttclid = touch.clickIds.ttclid;
  if (touch.clickIds?.liFatId) cf.li_fat_id = touch.clickIds.liFatId;
  if (touch.referrer) cf.referrer = touch.referrer;
  if (touch.landingUrl) cf.landing_url = touch.landingUrl;
  if (touch.ref) cf.ref = touch.ref;
  return cf;
}

export const FOUNDERS_USERID = 'be754b6c-767e-44ec-b181-4042cfe45ea9';
export const FOUNDERS_SIGNUPS_LIST_NAME = 'AgentWeb Signups';

export interface AutoEnrollDeps {
  crmDb?: {
    getLeadListsByUserId: typeof defaultCrmDb.getLeadListsByUserId;
    createLeadList: typeof defaultCrmDb.createLeadList;
    getLeadByEmail: typeof defaultCrmDb.getLeadByEmail;
    createLead: typeof defaultCrmDb.createLead;
  };
  logger?: Pick<typeof console, 'error' | 'warn' | 'log'>;
}

export interface AutoEnrollContext {
  input: SyncInput;
  result: SyncResult;
}

export interface AutoEnrollOutcome {
  enrolled: boolean;
  reason:
    | 'not_signup'
    | 'not_platform_scope'
    | 'no_email'
    | 'deduplicated_event'
    | 'already_in_list'
    | 'created'
    | 'error';
  listId?: string;
  leadId?: string;
}

/**
 * Resolve (or create) the platform-level "AgentWeb Signups" list owned by
 * founders@. Uses name-equality matching to stay idempotent even if the
 * initial creation race-conditions between two signups.
 */
async function ensureFoundersSignupsList(
  crmDb: NonNullable<AutoEnrollDeps['crmDb']>,
  logger: NonNullable<AutoEnrollDeps['logger']>
): Promise<{ listId: string; created: boolean }> {
  const existing = await crmDb.getLeadListsByUserId(FOUNDERS_USERID);
  const match = (existing || []).find(
    (l: any) => l && typeof l.name === 'string' && l.name === FOUNDERS_SIGNUPS_LIST_NAME
  );
  if (match && match.listId) {
    return { listId: match.listId, created: false };
  }

  logger.log(
    `[signupAutoEnroll] creating "${FOUNDERS_SIGNUPS_LIST_NAME}" list for founders@ (no existing list found)`
  );
  const created = await crmDb.createLeadList(
    FOUNDERS_USERID,
    FOUNDERS_SIGNUPS_LIST_NAME,
    'Auto-populated list of every new AgentWeb signup. System-managed — do not hand-edit.',
    undefined, // alertEvents
    null, // listSenderId
    undefined, // autoDraftEnabled
    undefined, // autoDraftInstruction
    undefined, // autoSendEnabled
    undefined, // statusConfig — defaults to sales-style (New / Contacted / Qualified / ...)
    'sales', // listType — signups are top-of-funnel sales leads (customer-type lists are hidden in a separate section in the UI)
    true // isSystemManaged
  );
  return { listId: (created as any).listId, created: true };
}

function extractIdentityFields(input: SyncInput): {
  email: string;
  firstName: string;
  lastName: string;
  company: string;
  linkedin: string;
} {
  const id = input.identity || {};
  return {
    email: (id.email || '').trim().toLowerCase(),
    firstName: (id.firstName || '').trim(),
    lastName: (id.lastName || '').trim(),
    company: (input.companyName || '').trim(),
    linkedin: (id.linkedin || '').trim(),
  };
}

/**
 * Auto-enroll a signup event into the founders@ "AgentWeb Signups" list.
 *
 * Must never throw. Returns an outcome struct so the caller can assert on
 * what happened in tests but can otherwise ignore the return value.
 */
export async function enrollSignupIntoFoundersList(
  ctx: AutoEnrollContext,
  deps: AutoEnrollDeps = {}
): Promise<AutoEnrollOutcome> {
  const crmDb = deps.crmDb || defaultCrmDb;
  const logger = deps.logger || console;

  try {
    const { input, result } = ctx;

    // Guard 1: only signup + contact.created events enrol.
    if (input.source !== 'signup' || input.eventType !== 'contact.created') {
      return { enrolled: false, reason: 'not_signup' };
    }

    // Guard 2: only platform-scoped signups enrol into the founders list. If a
    // future tenant-scoped signup hook sets tenantId, it has its own list and
    // must not spill into founders@.
    if (input.tenantId && input.tenantId !== FOUNDERS_USERID) {
      return { enrolled: false, reason: 'not_platform_scope' };
    }

    // Guard 3: signup events without an email are noise — skip.
    const fields = extractIdentityFields(input);
    if (!fields.email) {
      return { enrolled: false, reason: 'no_email' };
    }

    // Guard 4: if the underlying event was deduplicated, we've already tried
    // to enrol this signup before — no-op.
    if (result.deduplicated) {
      return { enrolled: false, reason: 'deduplicated_event' };
    }

    const { listId } = await ensureFoundersSignupsList(crmDb, logger);

    // Idempotency: if the lead already exists in the list, do nothing.
    const existing = await crmDb.getLeadByEmail(listId, fields.email);
    if (existing) {
      logger.log(
        `[signupAutoEnroll] lead already in founders signups list (email=${fields.email}) — skipping`
      );
      return {
        enrolled: false,
        reason: 'already_in_list',
        listId,
        leadId: (existing as any).leadId,
      };
    }

    // Attribution was threaded through via SyncInput.payload.attribution by
    // the crmSignalHooks.onUserSignup path. Flatten into customFields so the
    // CRM Source column + Attribution filter can bucket the lead by channel.
    const attribution = (input.payload && typeof input.payload === 'object')
      ? (input.payload.attribution as AttributionTouch | undefined)
      : undefined;
    const attributionFields = flattenAttributionToCustomFields(attribution);

    const lead = await crmDb.createLead(listId, {
      email: fields.email,
      firstName: fields.firstName,
      lastName: fields.lastName,
      company: fields.company,
      linkedin: fields.linkedin,
      lifecycle: 'signed_up',
      tenantId: FOUNDERS_USERID,
      accountOwnerUserId: FOUNDERS_USERID,
      ...(Object.keys(attributionFields).length > 0 && { customFields: attributionFields }),
    });

    return {
      enrolled: true,
      reason: 'created',
      listId,
      leadId: (lead as any).leadId,
    };
  } catch (err: any) {
    logger.error(
      '[signupAutoEnroll] failed to enrol signup into founders list:',
      err?.message || err
    );
    return { enrolled: false, reason: 'error' };
  }
}
