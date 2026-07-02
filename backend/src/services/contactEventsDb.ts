/**
 * AW-ContactEvents — append-only event log for CRM Unification v1.
 *
 * Every inbound signal (signup, stripe, lead form, emma session, fathom, manual,
 * enrichment, support) writes one row here. Every outbound consumer (heat score,
 * health score, lifecycle service, timeline UI) reads from here.
 *
 * Table schema:
 *   PK:  contactId (string — lowercase(email) OR `nocontact:{leadId}` fallback)
 *   SK:  eventTimestamp (ISO 8601 string)
 *   GSI: sourceRecordId-index (for idempotency lookup on webhook replay)
 *
 * Key invariants:
 * - append-only: no delete exposed, no update exposed
 * - idempotent: re-applying the same (source, sourceRecordId) must be a no-op
 *
 * Task: https://www.notion.so/34209247c951819abf12ca67728814a1 (A3)
 */

import { dynamodb } from '../config/aws';

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
export const CONTACT_EVENTS_TABLE = `${TABLE_PREFIX}AW-ContactEvents`;
export const CONTACT_EVENTS_SOURCE_RECORD_INDEX = 'sourceRecordId-index';
const TABLE_NAME = CONTACT_EVENTS_TABLE;

export type ContactEventSource =
  | 'signup'
  | 'stripe'
  | 'lead_form'
  | 'emma_session'
  | 'fathom'
  | 'manual'
  | 'enrichment'
  | 'support_issue'
  | 'engagement'
  | 'system';

export type ContactEventType =
  | 'contact.created'
  | 'contact.updated'
  | 'stage.changed'
  | 'lifecycle.changed'
  | 'payment.subscribed'
  | 'payment.updated'
  | 'payment.canceled'
  | 'meeting.attended'
  | 'support.opened'
  | 'support.resolved'
  | 'engagement.emma_session'
  | 'engagement.email_opened'
  | 'engagement.email_clicked'
  | 'engagement.linkedin_reply'
  | 'deal.created'
  | 'deal.stage_changed'
  | 'deal.primary_rotated'
  // Attribution — fired once per contact when UTM / referrer / landingUrl
  // is first captured. Dedupe via sourceRecordId so repeat signals on the
  // same lead create a single row. Payload holds the full AttributionTouch.
  | 'attribution.first_touch'
  // Activity timeline additions (see natural-language timeline task).
  | 'form.submitted'
  | 'page.visited'
  | 'user.registered'
  | 'onboarding.stage_changed'
  | 'manual.note'
  | string; // allow future-unknown types — keep flexible rather than locked

/**
 * Runtime-checkable set of the event types we explicitly model. Used by the
 * timeline renderer to pick a template, by the public events endpoint to
 * validate input, and by tests to lock the enum. Unknown types still flow
 * through (see the permissive `string` fallback on ContactEventType above)
 * so forward-compat isn't broken — this set is for "do we have a template?"
 * checks, not for gatekeeping writes.
 */
export const KNOWN_CONTACT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'contact.created',
  'contact.updated',
  'stage.changed',
  'lifecycle.changed',
  'payment.subscribed',
  'payment.updated',
  'payment.canceled',
  'meeting.attended',
  'support.opened',
  'support.resolved',
  'engagement.emma_session',
  'engagement.email_opened',
  'engagement.email_clicked',
  'engagement.linkedin_reply',
  'deal.created',
  'deal.stage_changed',
  'deal.primary_rotated',
  'attribution.first_touch',
  'form.submitted',
  'page.visited',
  'user.registered',
  'onboarding.stage_changed',
  'manual.note',
]);

/**
 * Event types a public (unauthenticated) caller is allowed to log via
 * POST /api/crm/public/events. This is intentionally narrow — only events
 * that are (a) safe to spoof and (b) commonly fired from a landing page.
 * Auth'd callers (Emma tools, server hooks) can log any KNOWN type.
 */
export const PUBLIC_LOGGABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'form.submitted',
  'page.visited',
]);

export interface ContactEvent {
  contactId: string;
  eventTimestamp: string;
  eventId: string;
  source: ContactEventSource;
  eventType: ContactEventType;
  payload: Record<string, unknown>;
  sourceRecordId: string;
  dealId?: string;
  /**
   * Optional tenant scope for multi-tenant CRM. Null/undefined for platform-level
   * (founders@ / AgentWeb itself) events. Set to the owning tenant's userId for
   * tenant-scoped events. Reserved for the next-sprint multi-tenant Epic; safe
   * to read/write today.
   */
  tenantId?: string;
  createdAt: string;
}

export interface LogEventInput {
  contactId: string;
  source: ContactEventSource;
  eventType: ContactEventType;
  payload?: Record<string, unknown>;
  sourceRecordId: string;
  dealId?: string;
  tenantId?: string;
  // Optional override — mostly for tests and retroactive event logging.
  eventTimestamp?: string;
}

export interface LogEventResult {
  event: ContactEvent;
  deduplicated: boolean;
}

/**
 * Normalise an email (or any candidate Contact key) into the contactId used as
 * the table's partition key. For leads with no email, callers should pass the
 * pre-constructed `nocontact:{leadId}` fallback.
 */
export function normalizeContactId(raw: string): string {
  return raw.trim().toLowerCase();
}

function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

class ContactEventsDb {
  /**
   * Idempotency check — looks up by sourceRecordId GSI.
   * Returns the matching ContactEvent if one exists, else null.
   */
  async findBySourceRecordId(sourceRecordId: string): Promise<ContactEvent | null> {
    const result = await dynamodb
      .query({
        TableName: TABLE_NAME,
        IndexName: CONTACT_EVENTS_SOURCE_RECORD_INDEX,
        KeyConditionExpression: 'sourceRecordId = :sri',
        ExpressionAttributeValues: { ':sri': sourceRecordId },
        Limit: 1,
      })
      .promise();

    const items = result.Items || [];
    return items.length > 0 ? (items[0] as ContactEvent) : null;
  }

  /**
   * Cheap boolean helper — useful for webhook handlers that only need to
   * early-exit on replay.
   */
  async isEventProcessed(sourceRecordId: string): Promise<boolean> {
    const existing = await this.findBySourceRecordId(sourceRecordId);
    return existing !== null;
  }

  /**
   * Append an event. Idempotent on sourceRecordId — if the same sourceRecordId
   * is replayed, the existing row is returned and nothing new is written.
   */
  async logEvent(input: LogEventInput): Promise<LogEventResult> {
    if (!input.contactId || !input.contactId.trim()) {
      throw new Error('contactEventsDb.logEvent: contactId is required');
    }
    if (!input.sourceRecordId || !input.sourceRecordId.trim()) {
      throw new Error('contactEventsDb.logEvent: sourceRecordId is required');
    }

    const existing = await this.findBySourceRecordId(input.sourceRecordId);
    if (existing) {
      return { event: existing, deduplicated: true };
    }

    const now = new Date().toISOString();
    const event: ContactEvent = {
      contactId: normalizeContactId(input.contactId),
      eventTimestamp: input.eventTimestamp || now,
      eventId: generateEventId(),
      source: input.source,
      eventType: input.eventType,
      payload: input.payload || {},
      sourceRecordId: input.sourceRecordId,
      createdAt: now,
      ...(input.dealId ? { dealId: input.dealId } : {}),
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    };

    await dynamodb
      .put({
        TableName: TABLE_NAME,
        Item: event,
        // Belt-and-suspenders — the sourceRecordId GSI check above is the
        // primary defence, but this guards against two writers racing on the
        // exact same (contactId, eventTimestamp) tuple.
        ConditionExpression: 'attribute_not_exists(contactId) AND attribute_not_exists(eventTimestamp)',
      })
      .promise()
      .catch(async err => {
        // If the condition failed, it's almost certainly a concurrent duplicate.
        // Re-check by sourceRecordId and return the winning row.
        if (err && (err.code === 'ConditionalCheckFailedException' || err.name === 'ConditionalCheckFailedException')) {
          const replay = await this.findBySourceRecordId(input.sourceRecordId);
          if (replay) return replay;
        }
        throw err;
      })
      .then(() => event);

    return { event, deduplicated: false };
  }

  /**
   * Read chronological timeline for a contact. Newest-first when
   * `scanIndexForward: false` is used (default here).
   */
  async getEventsForContact(
    contactId: string,
    opts: { limit?: number; startTime?: string; endTime?: string; ascending?: boolean } = {}
  ): Promise<ContactEvent[]> {
    const { limit = 100, startTime, endTime, ascending = false } = opts;
    const normId = normalizeContactId(contactId);

    const keyCondition: string[] = ['contactId = :cid'];
    const values: Record<string, unknown> = { ':cid': normId };

    if (startTime && endTime) {
      keyCondition.push('eventTimestamp BETWEEN :start AND :end');
      values[':start'] = startTime;
      values[':end'] = endTime;
    } else if (startTime) {
      keyCondition.push('eventTimestamp >= :start');
      values[':start'] = startTime;
    } else if (endTime) {
      keyCondition.push('eventTimestamp <= :end');
      values[':end'] = endTime;
    }

    const result = await dynamodb
      .query({
        TableName: TABLE_NAME,
        KeyConditionExpression: keyCondition.join(' AND '),
        ExpressionAttributeValues: values,
        Limit: limit,
        ScanIndexForward: ascending,
      })
      .promise();

    return (result.Items || []) as ContactEvent[];
  }

  /**
   * Read all events tagged with a given dealId. Uses a scan with filter —
   * acceptable at current scale (Deals are low-cardinality, event volume per
   * deal is bounded). Can upgrade to a dealId GSI later if hot.
   */
  async getEventsForDeal(dealId: string, opts: { limit?: number } = {}): Promise<ContactEvent[]> {
    const { limit = 200 } = opts;

    const result = await dynamodb
      .scan({
        TableName: TABLE_NAME,
        FilterExpression: 'dealId = :did',
        ExpressionAttributeValues: { ':did': dealId },
        Limit: limit,
      })
      .promise();

    return (result.Items || []) as ContactEvent[];
  }
}

export const contactEventsDb = new ContactEventsDb();
