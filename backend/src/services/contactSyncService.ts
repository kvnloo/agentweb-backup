/**
 * Contact Sync Service (B1)
 *
 * Single entry point for all inbound CRM signals. Enforces:
 *  - idempotency via sourceRecordId
 *  - identity resolution (email → domain → provisional)
 *  - append-only event log (AW-ContactEvents)
 *  - downstream recomputes (heat / health / lifecycle)
 *
 * This is a composition layer. All storage and scoring concerns are dependency-
 * injected so the service is trivial to unit test and so downstream hooks
 * (B2 signup, B3 Stripe) can swap in narrower fetchers as needed.
 *
 * NOTE: "Contact" is a logical concept keyed by normalized email. Physical
 * storage is still AW-Leads (possibly many rows for one Contact across lists).
 * Merging rules (source-aware overwrite) live here so per-source handlers
 * don't have to re-implement them.
 */

import {
  contactEventsDb as defaultEventsDb,
  normalizeContactId,
  ContactEventSource,
  ContactEventType,
  ContactEvent,
} from './contactEventsDb';
import {
  computeHeatScore,
  HeatScoreSignals,
} from './heatScoreService';
import {
  computeHealthScore,
  HealthScoreSignals,
} from './healthScoreService';
import {
  computeLifecycle,
  LifecycleSignals,
  LifecycleStage,
} from './lifecycleService';
import { extractDomainFromEmail } from '../utils/leadSchema';

export type SyncSource = ContactEventSource;

export interface SyncIdentity {
  email?: string | null;
  domain?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  linkedin?: string | null;
}

export interface SyncInput {
  source: SyncSource;
  sourceRecordId: string;
  identity: SyncIdentity;
  companyName?: string | null;
  customFields?: Record<string, unknown>;
  eventType: ContactEventType;
  payload?: Record<string, unknown>;
  /** Optional override — mostly for retroactive ingestion. */
  eventTimestamp?: string;
  /** Optional dealId to tag on the event. */
  dealId?: string;
}

export interface ResolvedContact {
  contactId: string;
  isProvisional: boolean;
  email: string | null;
  domain: string | null;
}

export interface SyncScoreSnapshot {
  heatScore: number;
  healthScore: number;
  lifecycle: LifecycleStage;
}

export interface SyncResult {
  contactId: string;
  created: boolean;
  deduplicated: boolean;
  event: ContactEvent;
  scores: SyncScoreSnapshot;
}

export interface ContactSignalBundle {
  heat: HeatScoreSignals;
  health: HealthScoreSignals;
  lifecycle: LifecycleSignals;
}

export interface ContactSyncDeps {
  eventsDb?: {
    logEvent: typeof defaultEventsDb.logEvent;
    findBySourceRecordId: typeof defaultEventsDb.findBySourceRecordId;
  };
  contactExists?: (contactId: string) => Promise<boolean>;
  loadSignals?: (contactId: string) => Promise<ContactSignalBundle>;
  persistScores?: (contactId: string, snap: SyncScoreSnapshot) => Promise<void>;
  now?: () => Date;
}

export function resolveIdentity(input: SyncInput): ResolvedContact {
  const rawEmail = (input.identity.email || '').trim().toLowerCase();
  const suppliedDomain = (input.identity.domain || '').trim().toLowerCase() || null;
  const derivedDomain = rawEmail ? extractDomainFromEmail(rawEmail) || null : null;
  const domain = suppliedDomain || derivedDomain;

  if (rawEmail) {
    return {
      contactId: normalizeContactId(rawEmail),
      isProvisional: false,
      email: rawEmail,
      domain,
    };
  }

  if (!input.sourceRecordId || !input.sourceRecordId.trim()) {
    throw new Error('contactSyncService.resolveIdentity: no email and no sourceRecordId');
  }

  return {
    contactId: `nocontact:${input.sourceRecordId.trim()}`,
    isProvisional: true,
    email: null,
    domain,
  };
}

export interface MergeContext {
  source: SyncSource;
  field: string;
}

const PAYMENT_FIELDS = new Set([
  'subscriptionType',
  'stripeStatus',
  'stripeCustomerId',
  'mrr',
  'currentPeriodEnd',
]);

const HUMAN_EDITABLE_FIELDS = new Set([
  'firstName',
  'lastName',
  'company',
  'companyName',
  'role',
  'title',
  'linkedinUrl',
  'notes',
]);

export function mergeFields<T extends Record<string, unknown>>(
  existing: T,
  incoming: Partial<T>,
  ctx: { source: SyncSource }
): T {
  const out: Record<string, unknown> = { ...existing };
  for (const [field, nextValue] of Object.entries(incoming)) {
    if (nextValue === undefined) continue;

    const currentValue = out[field];
    const existingIsEmpty =
      currentValue === null ||
      currentValue === undefined ||
      currentValue === '';

    if (existingIsEmpty) {
      out[field] = nextValue;
      continue;
    }

    if (ctx.source === 'stripe' && PAYMENT_FIELDS.has(field)) {
      out[field] = nextValue;
      continue;
    }

    if (
      (ctx.source === 'lead_form' ||
        ctx.source === 'fathom' ||
        ctx.source === 'manual') &&
      HUMAN_EDITABLE_FIELDS.has(field)
    ) {
      out[field] = nextValue;
      continue;
    }
  }
  return out as T;
}

export async function syncContact(
  input: SyncInput,
  deps: ContactSyncDeps = {}
): Promise<SyncResult> {
  if (!input.source) {
    throw new Error('contactSyncService.syncContact: source is required');
  }
  if (!input.eventType) {
    throw new Error('contactSyncService.syncContact: eventType is required');
  }
  if (!input.sourceRecordId || !input.sourceRecordId.trim()) {
    throw new Error('contactSyncService.syncContact: sourceRecordId is required');
  }

  const eventsDb = deps.eventsDb || defaultEventsDb;
  const resolved = resolveIdentity(input);

  const existingEvent = await eventsDb.findBySourceRecordId(input.sourceRecordId);
  if (existingEvent) {
    return {
      contactId: existingEvent.contactId,
      created: false,
      deduplicated: true,
      event: existingEvent,
      scores: {
        heatScore: 0,
        healthScore: 0,
        lifecycle: 'unknown',
      },
    };
  }

  const created = deps.contactExists
    ? !(await deps.contactExists(resolved.contactId))
    : true;

  const enrichedPayload: Record<string, unknown> = {
    ...(input.payload || {}),
    _identity: {
      email: resolved.email,
      domain: resolved.domain,
      firstName: input.identity.firstName || null,
      lastName: input.identity.lastName || null,
      linkedin: input.identity.linkedin || null,
    },
    ...(input.companyName ? { _companyName: input.companyName } : {}),
    ...(input.customFields ? { _customFields: input.customFields } : {}),
    _provisional: resolved.isProvisional,
  };

  const logResult = await eventsDb.logEvent({
    contactId: resolved.contactId,
    source: input.source,
    eventType: input.eventType,
    payload: enrichedPayload,
    sourceRecordId: input.sourceRecordId,
    eventTimestamp: input.eventTimestamp,
    dealId: input.dealId,
  });

  let scores: SyncScoreSnapshot = {
    heatScore: 0,
    healthScore: 0,
    lifecycle: 'unknown',
  };
  if (deps.loadSignals) {
    const bundle = await deps.loadSignals(resolved.contactId);
    const nowFn = deps.now ? deps.now() : new Date();
    scores = {
      heatScore: computeHeatScore(bundle.heat, nowFn),
      healthScore: computeHealthScore(bundle.health, nowFn),
      lifecycle: computeLifecycle(bundle.lifecycle, nowFn),
    };
    if (deps.persistScores) {
      await deps.persistScores(resolved.contactId, scores);
    }
  }

  return {
    contactId: resolved.contactId,
    created,
    deduplicated: logResult.deduplicated,
    event: logResult.event,
    scores,
  };
}
