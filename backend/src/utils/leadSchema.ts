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

import type { AttributionTouch } from '../types/attribution';

export type LeadPriority = 'Low' | 'Medium' | 'High';

/**
 * Attribution fields layered onto AW-Leads rows. Mirrors the User schema so
 * channel-attribution queries work identically across Users and Leads.
 *
 * See backend/src/types/attribution.ts for AttributionTouch shape.
 */
export interface LeadAttributionFields {
  /**
   * Captured once at first lead creation; never mutated afterward.
   *
   * ⚠️ `firstTouch` IS NOT A PROXY FOR "ATTRIBUTED". Do not count it as one.
   * The landing-page capture middleware always writes `timestamp` + `landingUrl`,
   * and `normalizeAttribution` returns a touch for any of them — so a lead from a
   * completely UNTAGGED ad, or from direct/organic traffic, still gets a truthy
   * `firstTouch` with no `utm` inside it. That is correct (direct IS a channel),
   * but it means `attribute_exists(firstTouch)` answers "did capture run?", NOT
   * "do we know where this lead came from?".
   *
   * To count attributed leads, use `utmSource` (below) or `firstTouch.utm.source`.
   * This matters right now: capture has never executed in production, so today
   * ~0% of leads have a `firstTouch` at all. The moment it goes live that jumps to
   * ~100% whether or not a single ad carries a UTM — and reading that as success
   * would be wrong. (ENG-239; see eng-239-utm-attribution-handoff.md.)
   */
  firstTouch?: AttributionTouch;
  /** Refreshed on any repeat touch with a new attribution payload. */
  lastTouch?: AttributionTouch;
  /**
   * Denormalized from firstTouch.utm.source for cheap channel-attribution
   * queries without scanning the blob. Explicit override wins.
   *
   * This — not `firstTouch` — is the field that means "attributed". It is set only
   * when a real `utm_source` was captured, which is exactly why it exists.
   */
  utmSource?: string;
  /** Denormalized from firstTouch.utm.medium. */
  utmMedium?: string;
  /**
   * Denormalized from `firstTouch.clickIds` — the paid-click identifiers that
   * acquired this lead (`gclid`, `fbclid`, `ttclid`, `liFatId`, …).
   *
   * Deliberately a MAP, not one column per platform: `normalizeAttribution`
   * already accepts click IDs we have not enumerated here, and a new ad
   * platform must not require a schema change to be carried (ENG-1176 AC3).
   *
   * Written ONLY when at least one non-empty value was captured, so
   * `attribute_exists(clickIds)` answers "did a paid click acquire this lead?"
   * — the question `firstTouch` famously cannot answer (see the warning above).
   * An empty map would silently count an organic lead as attributed.
   *
   * Set once, from `firstTouch` only. A repeat visit carrying a fresh `gclid`
   * must not overwrite the click that actually acquired the lead, which is why
   * `lastTouch` never feeds this field.
   */
  clickIds?: Record<string, string>;
}

/**
 * Every top-level lead attribute a CRM filter may name (ENG-1218).
 *
 * ONE definition, consumed by both filter resolvers. It is not a convenience:
 * the filter engine resolves an unknown field to `lead.customFields[field]`
 * rather than erroring, so a field missing from this list does not fail — it
 * silently matches EVERY lead on `is_empty` and none on `is_not_empty`.
 *
 * `searchLeads` and `deleteLeadsByFilter` previously kept separate copies, and
 * both had drifted from the lead shape by 22 fields. Because one of those paths
 * is destructive, "delete the leads with no lifecycle set" selected the entire
 * list, and the confirm gate's preview displayed that wrong count as if it were
 * correct. ENG-1176 hit the same defect on `clickIds`, fixed the search path,
 * and missed the delete path precisely because the lists were separate.
 *
 * Adding a filterable field to the lead shape means adding it HERE, once.
 * `customFields` is deliberately absent — it is the fallback container, not a
 * filterable attribute.
 */
export const LEAD_STANDARD_FILTER_FIELDS = [
  'leadId',
  'email', 'firstName', 'lastName', 'phone', 'company', 'title', 'notes',
  'linkedin', 'companyLinkedin', 'status', 'dealValue', 'dealCurrency',
  'selectedSenderId',
  'contactStatus', 'contactStatusReason', 'contactStatusNote', 'contactStatusUpdatedBy',
  'domain', 'accountOwnerUserId', 'pocEmails',
  'priority', 'expectedClose', 'closedDate',
  'heatScore', 'healthScore', 'lifecycle', 'role', 'isPrimary',
  'firstTouch', 'lastTouch', 'utmSource', 'utmMedium', 'clickIds',
  'createdAt', 'updatedAt',
] as const;

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

/**
 * The default `statusConfig` a lead list falls back to when it has none stored.
 *
 * This literal previously existed twice — `createLeadList` (which persists it) and
 * `getLeadListStatuses` (which substitutes it on read). A third consumer appeared in
 * sequences.ts, where treating "no statusConfig" as "no statuses" made a filter on the
 * perfectly real status `churned` answer 400. Three copies of a vocabulary is how the
 * copies drift, so it lives here with the rest of the lead vocabulary instead.
 *
 * `at_risk` and `churned` are deliberately BOTH lead statuses and lifecycle stages; any
 * code deciding "is this value a lifecycle stage?" has to check the list's statuses too.
 */
export interface LeadStatusConfigEntry {
  value: string;
  label: string;
  color: string;
  type: string;
}

const DEFAULT_PROSPECT_STATUS_CONFIG: readonly LeadStatusConfigEntry[] = [
  { value: 'new', label: 'New', color: 'gray', type: 'active' },
  { value: 'contacted', label: 'Contacted', color: 'blue', type: 'active' },
  { value: 'qualified', label: 'Qualified', color: 'indigo', type: 'active' },
  { value: 'proposal_sent', label: 'Proposal Sent', color: 'purple', type: 'active' },
  { value: 'negotiating', label: 'Negotiating', color: 'yellow', type: 'active' },
  { value: 'won', label: 'Won', color: 'green', type: 'won' },
  { value: 'lost', label: 'Lost', color: 'red', type: 'lost' },
  { value: 'churned', label: 'Churned', color: 'orange', type: 'churned' },
];

const DEFAULT_CUSTOMER_STATUS_CONFIG: readonly LeadStatusConfigEntry[] = [
  { value: 'onboarding', label: 'Onboarding', color: 'blue', type: 'active' },
  { value: 'active', label: 'Active', color: 'green', type: 'active' },
  { value: 'at_risk', label: 'At Risk', color: 'yellow', type: 'active' },
  { value: 'churned', label: 'Churned', color: 'orange', type: 'churned' },
];

/**
 * ENG-2311: a `session` list holds one row per landing-page visitor SESSION (engagement
 * telemetry written by custom LPs through forward-lead), not a person or a deal. Nothing
 * downstream may treat those rows as pipeline: there are no deal stages to move through, and
 * a won/lost/qualified-typed status on one would be read by the Meta conversion relay as a
 * real conversion. So the config is a single non-terminal entry. It is non-empty on purpose —
 * an empty config makes mapStatusToMetaEvent fall back to the SALES defaults (which contain
 * `won`), and sequences.ts treats "no statuses" as a 400 for any status filter.
 */
const DEFAULT_SESSION_STATUS_CONFIG: readonly LeadStatusConfigEntry[] = [
  { value: 'new', label: 'New', color: 'gray', type: 'active' },
];

/**
 * A FRESH array of fresh objects every call — one of the two consumers writes the result
 * straight into DynamoDB and the other hands it to a caller, so a shared reference here
 * would be a mutation waiting to happen.
 */
export function defaultStatusConfigFor(listType?: string | null): LeadStatusConfigEntry[] {
  const source = listType === 'customers'
    ? DEFAULT_CUSTOMER_STATUS_CONFIG
    : listType === 'session'
      ? DEFAULT_SESSION_STATUS_CONFIG
      : DEFAULT_PROSPECT_STATUS_CONFIG;
  return source.map((s) => ({ ...s }));
}

/**
 * The ONLY accepted `listType` values. `listType` is set-once (see crm.ts / emma leads.ts),
 * so a value accepted here can never be corrected later — keep this the single source of
 * truth rather than re-spelling the union at each validation site.
 */
export const LEAD_LIST_TYPES = ['sales', 'customers', 'session'] as const;
export type LeadListType = (typeof LEAD_LIST_TYPES)[number];
export function isLeadListType(value: unknown): value is LeadListType {
  return typeof value === 'string' && (LEAD_LIST_TYPES as readonly string[]).includes(value);
}

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
  /**
   * ENG-2082: a phone-only capture is contactable and inbound. Without it the lifecycle
   * default below keys on email alone, so every phone-only lead is STORED with no
   * lifecycle at all — and `lifecycle is_empty` in delete_leads_by_filter then selects
   * exactly those rows. computeLifecycle already treats phone as contactable; this is the
   * write path catching up so the stored field agrees with the computed one.
   */
  phone?: string;
  accountOwnerUserId?: string;
  /** Additional POC emails (non-org users). Stored as a list on the lead record. */
  pocEmails?: string[];
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

/**
 * `lifecycle` short-circuits the live computation in askCrmService (`lead.lifecycle ??
 * computeLifecycle(...)`), so a stored value is permanent for that lead. Anything that
 * can write the attribute has to check membership first, not just this file.
 */
export function isValidLeadLifecycle(value: unknown): boolean {
  return typeof value === 'string' && VALID_LIFECYCLES.has(value);
}
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

/**
 * What a bulk import did with one input row. Reported per row, aligned to the
 * caller's input array, so a partially-completed import can be resumed from
 * exactly the rows that never landed instead of being restarted (ENG-1133).
 *
 * `unprocessed` is the initial state: a row the importer never reached — the
 * only outcome that is neither a write nor a decision.
 */
export type LeadImportRowOutcome =
  | 'created'
  | 'merged'
  | 'already_present'
  | 'duplicate_in_request'
  | 'anonymized_skipped'
  | 'failed'
  | 'unprocessed';

/**
 * Synthesized lookup key for the cross-tenant NameCompanyLookupIndex GSI.
 * Only returned when all three components are non-empty strings — otherwise
 * the attribute is omitted from the lead item and the lead never appears in
 * the sparse GSI.
 */
export function computeNameCompanyKey(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  company: string | null | undefined,
): string | undefined {
  const f = typeof firstName === 'string' ? firstName.trim().toLowerCase() : '';
  const l = typeof lastName === 'string' ? lastName.trim().toLowerCase() : '';
  const c = typeof company === 'string' ? company.trim().toLowerCase() : '';
  if (!f || !l || !c) return undefined;
  return `${f}|${l}|${c}`;
}

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
 * - Defaults `lifecycle` to 'inbox' when the lead is CONTACTABLE (an email or a phone)
 *   and no lifecycle is supplied — phone was added in ENG-2082
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
  if (ext.pocEmails && ext.pocEmails.length > 0) out.pocEmails = ext.pocEmails;
  if (ext.priority) out.priority = ext.priority;
  if (ext.expectedClose) out.expectedClose = ext.expectedClose;
  if (ext.closedDate) out.closedDate = ext.closedDate;
  if (typeof ext.heatScore === 'number') out.heatScore = ext.heatScore;
  if (typeof ext.healthScore === 'number') out.healthScore = ext.healthScore;

  // Default lifecycle: if caller provided one, use it; otherwise default to 'inbox' when
  // the lead is CONTACTABLE — an email or a phone. Same rule computeLifecycle applies
  // (lifecycleService.ts); the two must agree or the stored field contradicts the computed
  // one for every phone-only lead.
  if (ext.lifecycle) {
    out.lifecycle = ext.lifecycle;
  } else if ((email && email.trim()) || (ext.phone && String(ext.phone).trim())) {
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
  if (ext.pocEmails !== undefined) {
    if (ext.pocEmails.length === 0) {
      removeFields.push('pocEmails');
    } else {
      setFields.push({ attr: 'pocEmails', placeholder: ':crmPocEmails', value: ext.pocEmails });
    }
  }

  return { setFields, removeFields };
}

/**
 * Build the DynamoDB-ready fragment for Lead attribution fields.
 *
 * Mirrors the User attribution shape (see services/db.ts User type) so the
 * "same email on both tables" case has identical semantics:
 * - firstTouch: set once, never overwritten by callers
 * - lastTouch: refreshed on each touch
 * - utmSource / utmMedium: denormalized from firstTouch.utm for cheap queries
 *
 * Omits every field that isn't populated — DynamoDB rejects undefined values
 * and empty strings are useless for GSI queries we might add later.
 *
 * Explicit utmSource / utmMedium passed in the extension win over the values
 * derived from firstTouch (useful for admin overrides). Whitespace-only
 * overrides fall back to the derived values.
 */
export function buildLeadAttributionFields(
  ext: LeadAttributionFields
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (ext.firstTouch) {
    out.firstTouch = ext.firstTouch;
  }
  if (ext.lastTouch) {
    out.lastTouch = ext.lastTouch;
  }

  // Denormalize utmSource / utmMedium from firstTouch unless an explicit
  // non-empty override is supplied. This matches the User shape written by
  // controllers/auth.ts and makes "all my leadgen from linkedin" queries a
  // single-key lookup instead of a scan.
  const explicitSource =
    typeof ext.utmSource === 'string' ? ext.utmSource.trim() : '';
  const explicitMedium =
    typeof ext.utmMedium === 'string' ? ext.utmMedium.trim() : '';
  const derivedSource = ext.firstTouch?.utm?.source?.trim() || '';
  const derivedMedium = ext.firstTouch?.utm?.medium?.trim() || '';

  const finalSource = explicitSource || derivedSource;
  const finalMedium = explicitMedium || derivedMedium;

  if (finalSource) out.utmSource = finalSource;
  if (finalMedium) out.utmMedium = finalMedium;

  // Denormalize the click IDs the same way, and for the same reason: today they
  // are reachable only by walking the firstTouch blob, so "what share of this
  // account's leads carry a click ID" needs a scan (ENG-1176 / ENG-926 §F).
  //
  // Copied into a fresh object rather than referenced, so a later mutation of
  // the stored blob cannot silently change the denormalized answer.
  const clickIds = pruneClickIds(ext.clickIds) || pruneClickIds(ext.firstTouch?.clickIds);
  if (clickIds) out.clickIds = clickIds;

  return out;
}

/**
 * Keep only the string click-ID values that carry something.
 *
 * Returns `undefined` — not `{}` — when nothing survives, because the caller
 * distinguishes "no paid click" (field absent) from "paid click" (field
 * present). An empty map written to the row would make every organic lead look
 * attributed to `attribute_exists`.
 *
 * Non-string values are dropped rather than coerced: a numeric `gclid` is
 * upstream corruption, and `String(12345)` would launder it into something that
 * looks like a real click ID in a report.
 */
export function pruneClickIds(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) out[key] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The keys `normalizeAttribution` can actually produce. See AttributionTouch.
 */
const TOUCH_SCALAR_KEYS = ['timestamp', 'referrer', 'landingUrl', 'sessionId'] as const;

/** The UTM spec is closed, so an unrecognised subkey is corruption. */
const UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'] as const;

/**
 * Does this nested map hold at least one real value?
 *
 * `allowedKeys` is applied to `utm` and deliberately NOT to `clickIds`, and the
 * asymmetry is the point. ENG-1176 made `clickIds` a map rather than one column
 * per platform so that a new ad network does not require a schema change to be
 * carried — `normalizeAttribution` already accepts click IDs not enumerated in
 * `AttributionTouch`. Restricting it to a known key list would silently drop
 * real paid-click attribution, which is precisely the failure ENG-1176 exists
 * to prevent. Do not "tighten" clickIds to match utm; there is a test pinning
 * this.
 */
function hasMeaningfulMap(value: unknown, allowedKeys?: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, v]) =>
      (!allowedKeys || allowedKeys.includes(key)) && typeof v === 'string' && v.trim() !== '',
  );
}

/**
 * A stored blob is usable only if it is a plain object carrying at least one
 * key attribution could have written, holding a value that actually says
 * something.
 *
 * Two things are deliberately NOT sufficient.
 *
 * Being a non-empty object: a legacy row such as `{ legacyBlob: true }` would
 * otherwise be promoted to a valid `firstTouch`.
 *
 * Carrying a recognised KEY: `{ timestamp: null }`, `{ landingUrl: '' }` and
 * `{ clickIds: {} }` hold exactly as much attribution as `{}` does. A key is
 * not evidence; a key with a real value is.
 *
 * Both routes end in the same wrong answer — every consumer that reads
 * presence-as-capture reports that capture ran on a record where nothing was
 * captured. The warning on `firstTouch` above explains why "did capture run?"
 * is a question people genuinely ask of this field, which is what makes a
 * false positive here expensive rather than untidy.
 *
 * One meaningful key is enough. The capture middleware always writes
 * `timestamp` + `landingUrl`, but a touch narrowed to a single real field is
 * still real data rather than corruption, and discarding it would lose
 * attribution we genuinely hold.
 */
function usableTouch(raw: unknown): AttributionTouch | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const touch = raw as Record<string, unknown>;
  const hasScalar = TOUCH_SCALAR_KEYS.some(
    (key) => typeof touch[key] === 'string' && (touch[key] as string).trim() !== '',
  );
  const hasMap = hasMeaningfulMap(touch.utm, UTM_KEYS) || hasMeaningfulMap(touch.clickIds);
  if (!hasScalar && !hasMap) return undefined;
  // Deep copy: the response must not alias the record the rest of the request
  // is still reading, and must not be mutable back into it.
  return JSON.parse(JSON.stringify(raw)) as AttributionTouch;
}

/**
 * The single attribution shape returned by every lead-returning path
 * (ENG-1175). Spread it into a projection; do not re-derive it inline.
 *
 * ONE definition on purpose. ENG-1176 shipped two defects — one on the
 * destructive delete path — because the standard-field list had been copied
 * into eight places and the copies drifted. The logic was shared, the data was
 * not. Three projections each maintaining their own idea of "the attribution
 * fields" would reproduce that exactly, and the failure would again be a
 * confidently wrong answer rather than an error.
 *
 * Every field is OMITTED when absent rather than emitted empty or null. That is
 * the whole contract, and it is load-bearing: `firstTouch: {}` would report
 * "capture ran and found nothing" for a lead where capture never ran at all,
 * and those are different answers to the only question the launch gates ask
 * (ENG-1175 AC1/AC4). The same reasoning drives the empty-map rule on
 * `clickIds` — see `pruneClickIds` above.
 *
 * A malformed stored blob is dropped, not thrown on: the caller asked for a
 * lead, and one corrupt attribution field must not make the whole record
 * unreadable.
 */
export function projectLeadAttribution(lead: any): Partial<LeadAttributionFields> {
  if (!lead || typeof lead !== 'object') return {};
  const out: Partial<LeadAttributionFields> = {};

  const firstTouch = usableTouch(lead.firstTouch);
  if (firstTouch) out.firstTouch = firstTouch;

  const lastTouch = usableTouch(lead.lastTouch);
  if (lastTouch) out.lastTouch = lastTouch;

  if (typeof lead.utmSource === 'string' && lead.utmSource.trim()) out.utmSource = lead.utmSource;
  if (typeof lead.utmMedium === 'string' && lead.utmMedium.trim()) out.utmMedium = lead.utmMedium;

  const clickIds = pruneClickIds(lead.clickIds);
  if (clickIds) out.clickIds = clickIds;

  return out;
}

/**
 * Status a pending_review lead moves to once its draft has been sent: 'contacted'
 * when the list has it, else the first active working status. Returns null (leave
 * the status alone) for leads that aren't in review.
 */
export function statusAfterReviewedSend(
  currentStatus: string | undefined | null,
  statusConfig?: Array<{ value: string; type?: string }>,
  listType?: string | null,
): string | null {
  if (currentStatus !== 'pending_review') return null;
  const config = statusConfig?.length ? statusConfig : (defaultStatusConfigFor(listType) as Array<{ value: string; type?: string }>);
  const working = config.filter(st => st.value !== 'pending_review' && (!st.type || st.type === 'active'));
  return (working.find(st => st.value === 'contacted') ?? working[0])?.value ?? null;
}

/** The AI-draft review status: a lead here is waiting for a human to approve its draft. */
export const REVIEW_DRAFT_STATUS = 'pending_review';

const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

/**
 * Whether a lead carries a usable stored draft (ENG-2966). Email = emailDraft with a
 * subject and a text or html body; linkedin = messageDraft.content. With no channel,
 * either counts.
 */
export function hasPersistedDraftForChannel(lead: unknown, channel?: 'email' | 'linkedin'): boolean {
  const asRecord = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  const email = asRecord(asRecord(lead)?.emailDraft);
  const hasEmail = !!email && nonEmpty(email.subject) && (nonEmpty(email.textContent) || nonEmpty(email.htmlContent));
  const message = asRecord(asRecord(lead)?.messageDraft);
  const hasMessage = !!message && nonEmpty(message.content);
  if (channel === 'email') return hasEmail;
  if (channel === 'linkedin') return hasMessage;
  return hasEmail || hasMessage;
}

/**
 * Error text when `status` is the review status but `lead` (as it would be after the
 * write) has no persisted draft — the Pending Review queue would show nothing to
 * approve. Null when the write is fine.
 */
export function missingReviewDraftError(status: unknown, lead: unknown): string | null {
  if (status !== REVIEW_DRAFT_STATUS || hasPersistedDraftForChannel(lead)) return null;
  return `Cannot set status "${REVIEW_DRAFT_STATUS}": the lead has no saved draft to review. `
    + 'Create the draft first (pass message_draft for LinkedIn, or email_subject and email_body for email), then set the status.';
}
