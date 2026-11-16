/**
 * ENG-2157: guard for PUT/PATCH /api/crm/lists/:listId/leads/:leadId.
 *
 * That route used to hand the whole request body to crmDb.updateLead, which understands ~50 keys. Many are
 * written by the server only (sync ids, attribution, the once-a-day auto-send marker, internal write
 * flags). No customer-portal code sends them and Emma's own update_lead tool filters to 11 fields; the MCP
 * `lead.update` action forwards its body verbatim, so real usage there is unknown. Hence three modes:
 *
 *   log      (default) report which of those keys arrive, by name and channel only - never values. Behaviour unchanged.
 *   enforce  drop them, and stamp contactStatusUpdatedBy with the authenticated user.
 *   off      do nothing.
 *
 * Do-not-contact / unsubscribe keys are deliberately NOT dropped: the portal's Mark DNC, Remove and Resubscribe
 * buttons write them through this route. They are audited instead (see contactSuppressionAuditEvent).
 */

export type LeadPutGuardMode = 'off' | 'log' | 'enforce';

export const SERVER_OWNED_LEAD_KEYS: readonly string[] = [
  'syncMetadata', 'lastAutoSendAt', 'system', 'nameCompanyKey',
  'firstTouch', 'lastTouch', 'utmSource', 'utmMedium', 'clickIds', 'metaFbp', 'clientIp', 'clientUserAgent',
  'linkedInInviteSentAt', 'linkedInInviteAcceptedAt', 'linkedinIdentityVerifiedAt', 'linkedinIdentityVerifiedUrl',
  'suppressConversionRelay', 'skipFieldNamesUpdate', 'customFieldsKeyMerge',
  'contactStatusUpdatedBy', 'contactStatusUpdatedAt',
];

const MAX_REPORTED_KEYS = 25;

export function leadPutGuardMode(env: NodeJS.ProcessEnv = process.env): LeadPutGuardMode {
  const v = String(env.CRM_LEAD_PUT_GUARD ?? '').trim().toLowerCase();
  return v === 'off' || v === 'enforce' ? v : 'log';
}

export function contactSuppressionAuditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.CRM_CONTACT_STATUS_AUDIT ?? '').trim().toLowerCase() !== 'off';
}

export type LeadWriteChannel = 'ui' | 'agent';

/** The MCP client marks its calls `X-AgentWeb-Channel: agent` (mcp/server/httpClient.ts). A client can set it too: this is telemetry, not a trust boundary. */
export function leadWriteChannel(req: { headers?: Record<string, unknown> } | undefined): LeadWriteChannel {
  return String(req?.headers?.['x-agentweb-channel'] ?? '').toLowerCase() === 'agent' ? 'agent' : 'ui';
}

function isBodyObject(b: unknown): b is Record<string, unknown> {
  return !!b && typeof b === 'object' && !Array.isArray(b);
}

export interface LeadPutGuardOptions {
  mode?: LeadPutGuardMode;
  channel: LeadWriteChannel;
  userId: string;
  log?: (message: string, detail: Record<string, unknown>) => void;
}

export interface LeadPutGuardResult {
  /** The same object that came in unless mode is `enforce` and something was dropped. */
  body: any;
  flaggedKeys: string[];
  dropped: boolean;
}

/** Never throws; on any failure the request proceeds exactly as it did before this guard existed. */
export function guardLeadPutBody(body: unknown, opts: LeadPutGuardOptions): LeadPutGuardResult {
  const untouched: LeadPutGuardResult = { body, flaggedKeys: [], dropped: false };
  try {
    const mode = opts.mode ?? leadPutGuardMode();
    if (mode === 'off' || !isBodyObject(body)) return untouched;

    // Look up the known keys instead of walking the body: the cost does not depend on how many keys a client sends, and padding the
    // body with filler keys cannot push a server-owned key out of view.
    const flagged = SERVER_OWNED_LEAD_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(body, key));
    if (flagged.length === 0) return untouched;

    const enforce = mode === 'enforce';
    const log = opts.log ?? ((message, detail) => console.warn(`${message} ${JSON.stringify(detail)}`));
    try {
      // Key names and channel only: values can be customer data.
      log('[crm-lead-put-guard] server-owned keys in lead update body', {
        mode, channel: opts.channel, userId: opts.userId, keys: flagged.slice(0, MAX_REPORTED_KEYS), dropped: enforce,
      });
    } catch { /* a logging failure must never reach the request */ }

    if (!enforce) return { body, flaggedKeys: flagged, dropped: false };

    const cleaned: Record<string, unknown> = { ...body };
    for (const key of flagged) delete cleaned[key];
    // The client no longer decides who changed a suppression, or when. updateLead writes the actor/time pair whenever contactStatus is present and not null
    // (any value, including an empty string), so stamp in exactly those cases: otherwise a stale actor would sit next to a fresh time.
    if (cleaned.contactStatus !== undefined && cleaned.contactStatus !== null) cleaned.contactStatusUpdatedBy = opts.userId;
    return { body: cleaned, flaggedKeys: flagged, dropped: true };
  } catch {
    return untouched;
  }
}

// ---- Suppression audit ----------------------------------------------------------------------------------------------

const KNOWN_STATUSES = new Set(['active', 'do-not-contact', 'unsubscribed']);
const KNOWN_REASONS = new Set(['opted-out', 'bounced', 'complained', 'requested-removal', 'admin-flagged', 'compliance', 'other']);

// The PUT route does not validate these values, so a client can send any string. The audit event is stored on the lead and
// db.addLeadEngagement scans an event's text for "clicked" / "replied" / "received" to raise isEngaged: only fixed vocabulary goes in.
const status = (v: unknown): string | null => (typeof v === 'string' && v ? (KNOWN_STATUSES.has(v) ? v : 'other') : null);
const reason = (v: unknown): string | null => (typeof v === 'string' && v ? (KNOWN_REASONS.has(v) ? v : 'other') : null);

export function touchesContactSuppression(updates: unknown): boolean {
  return isBodyObject(updates) && (updates.contactStatus !== undefined || updates.unsubscribedFromGroupEmail !== undefined);
}

export interface ContactSuppressionAuditInput {
  before: any;
  updates: unknown;
  actorUserId: string;
  delegatedByUserId?: string | null;
  channel: LeadWriteChannel;
  now?: Date;
}

/** An engagement event for a real change to a lead's contact status or group-email unsubscribe, or null when nothing changed. Never throws. */
export function contactSuppressionAuditEvent(input: ContactSuppressionAuditInput): { eventType: string; eventData: Record<string, unknown>; createdAt: string } | null {
  try {
    const { before, updates } = input;
    if (!before || !isBodyObject(updates)) return null;
    const beforeStatus = status(before.contactStatus);
    const beforeUnsub = before.unsubscribedFromGroupEmail === true;
    const afterStatus = updates.contactStatus !== undefined ? status(updates.contactStatus) : beforeStatus;
    const afterUnsub = updates.unsubscribedFromGroupEmail !== undefined ? updates.unsubscribedFromGroupEmail === true : beforeUnsub;
    if (afterStatus === beforeStatus && afterUnsub === beforeUnsub) return null;

    const parts: string[] = [];
    if (afterStatus !== beforeStatus) parts.push(`Contact status: ${beforeStatus ?? 'none'} → ${afterStatus ?? 'none'}`);
    if (afterUnsub !== beforeUnsub) parts.push(`Group email: ${afterUnsub ? 'unsubscribed' : 'subscribed'}`);
    return {
      eventType: 'contact_status.changed',
      eventData: {
        // FLAT primitives on purpose. The customer portal's Engagements dialog (CRM.tsx) reads eventData.from / eventData.to for EVERY event type
        // and renders them as React children, so an object there crashes the page; EngagementTimeline's generic row shows eventData.note.
        // Do not name a key from / to / subject / message / content / platform.
        fromStatus: beforeStatus,
        toStatus: afterStatus,
        fromGroupEmailUnsubscribed: beforeUnsub,
        toGroupEmailUnsubscribed: afterUnsub,
        ...(updates.contactStatusReason !== undefined ? { reason: reason(updates.contactStatusReason) } : {}),
        actorUserId: input.actorUserId,
        ...(input.delegatedByUserId ? { delegatedByUserId: input.delegatedByUserId } : {}),
        channel: input.channel,
        via: 'lead-put',
        note: parts.join('; '),
      },
      createdAt: (input.now ?? new Date()).toISOString(),
    };
  } catch {
    return null;
  }
}
