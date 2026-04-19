/**
 * CRM Unification v1 — shared Lead schema helpers (A1).
 *
 * These utilities back the new fields on AW-Leads:
 *   domain, accountOwnerUserId, priority, expectedClose, closedDate,
 *   heatScore, lifecycle, role, isPrimary, dealIds[]
 *
 * Stored alongside the legacy fields; all new fields are optional for
 * backward-compat with the 17k existing lead rows.
 *
 * Task: https://www.notion.so/34209247c9518101bd58fe20939ad2ca
 */

export type LeadPriority = 'Low' | 'Medium' | 'High';

export const LEAD_LIFECYCLES = [
  'unknown',
  'inbox',
  'signed_up',
  'in_deal',
  'trialing',
  'paying',
  'at_risk',
  'churned',
] as const;
export type LeadLifecycle = (typeof LEAD_LIFECYCLES)[number];

export const LEAD_ROLES = [
  'KDM',
  'Champion',
  'Blocker',
  'Influencer',
  'Other',
] as const;
export type LeadRole = (typeof LEAD_ROLES)[number];

/**
 * Shape of the new optional fields layered onto AW-Leads rows.
 * Kept as a standalone interface so createLead / updateLead / sync endpoints
 * can all accept the same payload shape.
 */
export interface LeadCrmExtensions {
  domain?: string;
  accountOwnerUserId?: string;
  priority?: LeadPriority;
  expectedClose?: string; // ISO date string
  closedDate?: string; // ISO date string — auto-set on stage=Won/Lost
  heatScore?: number; // 0-100
  healthScore?: number; // 0-100 (used by paying tab)
  lifecycle?: LeadLifecycle;
  role?: LeadRole;
  isPrimary?: boolean;
  dealIds?: string[];
  /**
   * Owning tenant userId. Today this is almost always the founders@ userId
   * because AgentWeb is single-tenant on the CRM side. Reserved for the
   * next-sprint multi-tenant Epic — all writers should set it now so we don't
   * need a schema migration later.
   */
  tenantId?: string;
}

const VALID_PRIORITIES: ReadonlySet<string> = new Set<LeadPriority>(['Low', 'Medium', 'High']);
const VALID_LIFECYCLES: ReadonlySet<string> = new Set(LEAD_LIFECYCLES);
const VALID_ROLES: ReadonlySet<string> = new Set(LEAD_ROLES);

/**
 * Derive the company domain from an email address. Returns undefined when the
 * email is missing, malformed, or a generic free-email provider (gmail, yahoo,
 * outlook, hotmail, icloud, aol, proton) — those are not useful for
 * company-grouping.
 *
 * Normalisation: lowercase, strip plus-addressing on the local part is NOT
 * done here (plus-addressing doesn't change the domain), but the domain is
 * lowercased and any trailing whitespace / dots are trimmed.
 */
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'ymail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
]);

export function extractDomainFromEmail(email: string | null | undefined): string | undefined {
  if (!email || typeof email !== 'string') return undefined;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return undefined;
  const rawDomain = trimmed.slice(at + 1).replace(/\.+$/, '').trim();
  if (!rawDomain || !rawDomain.includes('.')) return undefined;
  if (FREE_EMAIL_DOMAINS.has(rawDomain)) return undefined;
  return rawDomain;
}

/**
 * Validate the enum-bearing CRM extension fields. Throws on invalid values so
 * DynamoDB never sees garbage. Silent no-op on undefined — callers decide
 * whether a field is required.
 */
export function validateLeadCrmExtensions(ext: LeadCrmExtensions): void {
  // null is a valid "remove this field" signal in update paths — let it through.
  if (ext.priority !== undefined && ext.priority !== null && !VALID_PRIORITIES.has(ext.priority)) {
    throw new Error(`Invalid lead priority: ${ext.priority}`);
  }
  if (ext.lifecycle !== undefined && ext.lifecycle !== null && !VALID_LIFECYCLES.has(ext.lifecycle)) {
    throw new Error(`Invalid lead lifecycle: ${ext.lifecycle}`);
  }
  if (ext.role !== undefined && ext.role !== null && !VALID_ROLES.has(ext.role)) {
    throw new Error(`Invalid lead role: ${ext.role}`);
  }
  if (ext.heatScore !== undefined && ext.heatScore !== null) {
    if (typeof ext.heatScore !== 'number' || Number.isNaN(ext.heatScore)) {
      throw new Error(`Invalid heatScore: ${ext.heatScore}`);
    }
    if (ext.heatScore < 0 || ext.heatScore > 100) {
      throw new Error(`heatScore out of range [0,100]: ${ext.heatScore}`);
    }
  }
  if (ext.healthScore !== undefined && ext.healthScore !== null) {
    if (typeof ext.healthScore !== 'number' || Number.isNaN(ext.healthScore)) {
      throw new Error(`Invalid healthScore: ${ext.healthScore}`);
    }
    if (ext.healthScore < 0 || ext.healthScore > 100) {
      throw new Error(`healthScore out of range [0,100]: ${ext.healthScore}`);
    }
  }
  if (ext.dealIds !== undefined && ext.dealIds !== null && !Array.isArray(ext.dealIds)) {
    throw new Error(`dealIds must be an array, got ${typeof ext.dealIds}`);
  }
}

/**
 * Build the DynamoDB-ready `Item` fragment for the CRM extension fields.
 * - Validates enums
 * - Derives `domain` from `email` when not explicitly provided
 * - Omits empty-string / undefined values (DynamoDB GSI keys hate empty strings)
 * - Defaults `lifecycle` to 'inbox' when an email exists but no lifecycle is supplied
 */
export function buildLeadCrmFields(
  email: string | null | undefined,
  ext: LeadCrmExtensions = {}
): Record<string, unknown> {
  validateLeadCrmExtensions(ext);

  const out: Record<string, unknown> = {};

  // Domain: explicit override wins; otherwise derive from email.
  const domain = ext.domain?.trim().toLowerCase() || extractDomainFromEmail(email);
  if (domain) out.domain = domain;

  if (ext.accountOwnerUserId) out.accountOwnerUserId = ext.accountOwnerUserId;
  if (ext.priority) out.priority = ext.priority;
  if (ext.expectedClose) out.expectedClose = ext.expectedClose;
  if (ext.closedDate) out.closedDate = ext.closedDate;
  if (typeof ext.heatScore === 'number') out.heatScore = ext.heatScore;
  if (typeof ext.healthScore === 'number') out.healthScore = ext.healthScore;

  // Default lifecycle: if caller provided one, use it; otherwise default to 'inbox'
  // when we have an email (matches migration plan for backfilling 17k leads).
  if (ext.lifecycle) {
    out.lifecycle = ext.lifecycle;
  } else if (email && email.trim()) {
    out.lifecycle = 'inbox';
  }

  if (ext.role) out.role = ext.role;
  if (typeof ext.isPrimary === 'boolean') out.isPrimary = ext.isPrimary;
  if (ext.dealIds && ext.dealIds.length > 0) out.dealIds = ext.dealIds;
  if (ext.tenantId && ext.tenantId.trim()) out.tenantId = ext.tenantId.trim();

  return out;
}

/**
 * Build the UpdateExpression fragments for the CRM extension fields, for use
 * inside an existing updateLead call. Returns null values the caller should
 * translate to REMOVE clauses (matches the existing pattern in db.updateLead).
 */
export function buildLeadCrmUpdateFragments(ext: LeadCrmExtensions): {
  setFields: Array<{ attr: string; placeholder: string; value: unknown }>;
  removeFields: string[];
} {
  validateLeadCrmExtensions(ext);

  const setFields: Array<{ attr: string; placeholder: string; value: unknown }> = [];
  const removeFields: string[] = [];

  const pushOrRemove = <K extends keyof LeadCrmExtensions>(key: K, placeholder: string) => {
    const value = ext[key];
    if (value === undefined) return; // not in update
    if (value === null || (typeof value === 'string' && value === '')) {
      removeFields.push(String(key));
    } else {
      setFields.push({ attr: String(key), placeholder, value });
    }
  };

  pushOrRemove('domain', ':crmDomain');
  pushOrRemove('accountOwnerUserId', ':crmAccountOwnerUserId');
  pushOrRemove('priority', ':crmPriority');
  pushOrRemove('expectedClose', ':crmExpectedClose');
  pushOrRemove('closedDate', ':crmClosedDate');
  pushOrRemove('heatScore', ':crmHeatScore');
  pushOrRemove('healthScore', ':crmHealthScore');
  pushOrRemove('lifecycle', ':crmLifecycle');
  pushOrRemove('role', ':crmRole');

  if (ext.isPrimary !== undefined) {
    setFields.push({ attr: 'isPrimary', placeholder: ':crmIsPrimary', value: ext.isPrimary });
  }
  if (ext.dealIds !== undefined) {
    if (ext.dealIds.length === 0) {
      removeFields.push('dealIds');
    } else {
      setFields.push({ attr: 'dealIds', placeholder: ':crmDealIds', value: ext.dealIds });
    }
  }

  return { setFields, removeFields };
}
