/**
 * ENG-2840 (W2-7): `add_lead_engagement`, Emma's tool for recording one event on a lead (a call, a meeting, a note), for outside agents.
 *
 * Emma's tool takes any `custom.*` type, any event data of any shape and size, and any date, with no limit per lead and no duplicate check.
 * The lead's events live inside the lead's own DynamoDB item (400 KB at most; when it is full every other writer on that lead fails too, the
 * provider webhooks included), some data keys mean something to other code (`smartleadEventKey` is how the Smartlead poller knows an event is
 * already recorded; the portal's Engagements dialog renders `from`/`to` of every event), and a key can call 60 times a minute. So, through MCP:
 *  - `event_type` is `custom.` + 1 to 53 of [a-z0-9_.-];
 *  - `event_data` is optional, a plain object of at most EVENT_DATA_MAX_KEYS keys (letters, digits, `_`; reserved keys refused), each value
 *    text (at most EVENT_DATA_MAX_TEXT characters, no control or invisible characters other than line breaks and tabs), a finite number, true/false
 *    or null; at most EVENT_DATA_MAX_BYTES serialized;
 *  - `event_date` is optional, an ISO 8601 date-time with a time zone, not more than 5 minutes ahead and not more than 366 days back;
 *  - `idempotency_key` is optional: an event with the same key already on the lead records nothing (`recorded: false, duplicate: true`), so a
 *    retry after a timeout is safe when the key is sent;
 *  - the route (`POST /api/emma/add-lead-engagement`, Emma's own handler and list check) stamps the event `channel: 'mcp'`, records at most
 *    MCP_ENGAGEMENTS_PER_LEAD such events per lead and none on a lead whose record is nearly full, and appends only if the lead did not change
 *    since it was read (re-reading and deciding again when it did);
 *  - each caller may record ENGAGEMENTS_PER_HOUR events an hour (counted when the route is called; in this process).
 * No owner alert is sent (the CRM route's alert is not called), no CRM sync, no conversion relay. An event whose type or data contains
 * "clicked", "replied" or "received" marks the lead as engaged (Emma's rule, unchanged). The portal's live CRM view is not refreshed (it
 * refreshes on its next load).
 *
 * Same pattern as the other wave-2 tools: arguments checked by name and by value here, the route's guard is the only tenant check (list
 * owner, organization owner, listed CRM editors), a refusal (`{ success: false }`, HTTP 200) is an error carrying only the route's short
 * message, a 4xx passes through, and a 5xx or an unreachable route is a fixed text that says the event may not have been recorded.
 */
import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';
import { ctx, jsonResult } from './toolHelpers';
import { exactArgs } from './memoryTools';
import { MCP_ENGAGEMENTS_PER_LEAD } from '../../utils/agentEngagementLimits';
import { BANNED_SCHEMA_FIELD } from './toolAnnotationPolicy';

const TOOL = 'add_lead_engagement';
const INPUTS = ['list_id', 'lead_id', 'event_type', 'event_data', 'event_date', 'idempotency_key'] as const;
const MAX_ID_CHARS = 200;
export const EVENT_TYPE_RE = /^custom\.[a-z0-9][a-z0-9_.-]{0,52}$/;
export const EVENT_DATA_MAX_KEYS = 20;
export const EVENT_DATA_MAX_TEXT = 500;
export const EVENT_DATA_MAX_BYTES = 2048;
export const EVENT_DATE_MAX_AHEAD_MS = 5 * 60_000;
export const EVENT_DATE_MAX_BACK_MS = 366 * 24 * 60 * 60_000;
export const ENGAGEMENTS_PER_HOUR = 120;
const HOUR_MS = 60 * 60_000;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DATA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
// Control characters other than tab and line feed, and zero-width / bidirectional formatting characters.
const BAD_TEXT_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069\ufeff]/;

/**
 * Keys that other code reads off an event, or that the route sets itself. Compared case-insensitively.
 * `smartleadEventKey`, `source`, `campaignId`, `invitationId`, `accountId`, `linkedin`: provider events (a forged one would make the
 * Smartlead poller skip a real event, or look like a LinkedIn or campaign event); `from`, `to`, `subject`, `message`, `content`, `platform`,
 * `reason`: read and rendered for every event by the portal and the summaries; `channel`, `idempotencyKey`, `eventId`, `eventType`,
 * `createdAt`: set by the server.
 */
export const RESERVED_DATA_KEYS: ReadonlySet<string> = new Set([
  'smartleadeventkey', 'source', 'campaignid', 'invitationid', 'accountid', 'linkedin',
  'from', 'to', 'subject', 'message', 'content', 'platform', 'reason',
  'channel', 'idempotencykey', 'eventid', 'eventtype', 'createdat',
]);

function refuse(message: string): never {
  throw new Error(`${TOOL}: ${message} Nothing was recorded.`);
}

function idArg(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') refuse(`${field} is required and must be text.`);
  const id = value as string;
  if (id.length > MAX_ID_CHARS || id !== id.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(id)) {
    refuse(`${field} is not a valid id. Use an id returned by manage_leads, search_leads or list_lead_lists.`);
  }
  return id;
}

function eventDataArg(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    refuse('event_data must be an object of simple values (text, numbers, true/false, null).');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > EVENT_DATA_MAX_KEYS) refuse(`event_data has ${entries.length} keys; at most ${EVENT_DATA_MAX_KEYS}.`);
  for (const [key, item] of entries) {
    if (!DATA_KEY_RE.test(key)) refuse(`event_data key "${key.slice(0, 40)}" is not allowed: keys are a letter then letters, digits or _, at most 40 characters.`);
    if (RESERVED_DATA_KEYS.has(key.toLowerCase())) refuse(`event_data key "${key}" is reserved (other parts of AgentWeb read it). Use another name.`);
    // The public-schema privacy rule (no transcripts, raw locations or IP addresses), applied to the free keys too.
    if (BANNED_SCHEMA_FIELD.test(key)) refuse(`event_data key "${key}" is not accepted: transcripts, locations and IP addresses are not stored on leads through this tool.`);
    if (item === null || typeof item === 'boolean') continue;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) refuse(`event_data.${key} must be a finite number.`);
      continue;
    }
    if (typeof item === 'string') {
      if (item.length > EVENT_DATA_MAX_TEXT || BAD_TEXT_RE.test(item)) {
        refuse(`event_data.${key} must be at most ${EVENT_DATA_MAX_TEXT} characters, with no control or invisible characters other than line breaks and tabs.`);
      }
      continue;
    }
    refuse(`event_data.${key} must be text, a number, true/false or null (no nested objects or lists).`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > EVENT_DATA_MAX_BYTES) refuse(`event_data is ${bytes} bytes; at most ${EVENT_DATA_MAX_BYTES}.`);
  return value as Record<string, unknown>;
}

function eventDateArg(value: unknown, now: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !ISO_DATE_TIME_RE.test(value)) {
    refuse('event_date must be an ISO 8601 date-time with a time zone, such as 2026-11-26T14:30:00Z.');
  }
  const at = Date.parse(value as string);
  if (Number.isNaN(at)) refuse('event_date is not a real date.');
  if (at > now + EVENT_DATE_MAX_AHEAD_MS) refuse('event_date is in the future. Record an event when it has happened.');
  if (at < now - EVENT_DATE_MAX_BACK_MS) refuse('event_date is more than a year ago.');
  return new Date(at).toISOString();
}

/** The request body, or the refusal. Pure apart from reading the clock. */
export function addEngagementRequest(args: unknown, now = Date.now()): Record<string, unknown> {
  const a = exactArgs(TOOL, args, INPUTS);
  const body: Record<string, unknown> = {
    list_id: idArg('list_id', a.list_id),
    lead_id: idArg('lead_id', a.lead_id),
  };
  if (typeof a.event_type !== 'string' || !EVENT_TYPE_RE.test(a.event_type)) {
    refuse('event_type must be "custom." followed by 1 to 53 lowercase letters, digits, _, . or - (for example custom.phone_call, custom.meeting).');
  }
  body.event_type = a.event_type;
  const data = eventDataArg(a.event_data);
  if (data) body.event_data = data;
  const date = eventDateArg(a.event_date, now);
  if (date) body.event_date = date;
  if (a.idempotency_key !== undefined && a.idempotency_key !== null) {
    if (typeof a.idempotency_key !== 'string' || !IDEMPOTENCY_KEY_RE.test(a.idempotency_key)) {
      refuse('idempotency_key must be 8 to 64 letters, digits, - or _.');
    }
    body.idempotency_key = a.idempotency_key;
  }
  return body;
}

/** Events recorded per caller in the last hour (this process). */
export const engagementBudget = {
  calls: new Map<string, number[]>(),
  reset(): void {
    this.calls.clear();
  },
  /** Seconds to wait when the caller is over the hourly allowance, else 0 (and the call is counted). */
  take(caller: string, now = Date.now()): number {
    const recent = (this.calls.get(caller) ?? []).filter((t) => t > now - HOUR_MS);
    if (recent.length >= ENGAGEMENTS_PER_HOUR) {
      this.calls.set(caller, recent);
      return Math.max(1, Math.ceil((recent[0] + HOUR_MS - now) / 1000));
    }
    recent.push(now);
    this.calls.set(caller, recent);
    return 0;
  },
};

function callerOf(context: any): string {
  const c = ctx(context) as any;
  return String(c?.userId || c?.agentUserId || '');
}

/** The route's `{ success: true }` answer, or an error carrying only its short `message`. */
export function engagementAnswer(answer: unknown): Record<string, unknown> {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    throw new Error(`${TOOL}: the CRM gave no answer, so the event may not have been recorded. Check with get_lead_engagements before trying again.`);
  }
  const result = answer as Record<string, unknown>;
  if (result.success !== true) {
    const message = typeof result.message === 'string' && result.message.trim() !== '' ? result.message.trim().slice(0, 300) : 'the request was refused';
    throw new Error(`${TOOL}: ${message.replace(/\.$/, '')}.`);
  }
  return {
    success: true,
    recorded: result.recorded !== false,
    ...(result.duplicate === true ? { duplicate: true } : {}),
    event_type: result.eventType,
    lead_name: result.leadName,
    message: result.message,
  };
}

async function execute(args: unknown, context: any): Promise<unknown> {
  const body = addEngagementRequest(args);
  const caller = callerOf(context);
  const wait = engagementBudget.take(caller);
  if (wait > 0) refuse(`you have recorded ${ENGAGEMENTS_PER_HOUR} events in the last hour, the most allowed. Try again in ${wait} seconds.`);
  let answer: unknown;
  try {
    answer = await mcpFetch({ method: 'POST', path: '/api/emma/add-lead-engagement', context: ctx(context), body });
  } catch (err: any) {
    const message = String(err?.message ?? '');
    const status = /^API error \((\d{3})\)/.exec(message)?.[1];
    if (status && status.startsWith('4')) throw err;
    throw new Error(`${TOOL}: the CRM ${status ? `could not answer (HTTP ${status})` : 'could not be reached'}, so the event may or may not have been recorded. Check with get_lead_engagements before trying again${body.idempotency_key ? ' (or retry with the same idempotency_key: a recorded event is not recorded twice)' : ''}.`);
  }
  return jsonResult(engagementAnswer(answer));
}

mcpToolRegistry.register({
  name: TOOL,
  requiresUserAccount: true,
  definition: {
    name: TOOL,
    description: 'Record one event on a lead: a call, a meeting, a note, anything that happened outside AgentWeb. '
      + 'event_type is "custom." plus 1 to 53 lowercase letters, digits, _, . or - (custom.phone_call, custom.meeting, custom.note). '
      + `event_data (optional) is an object of at most ${EVENT_DATA_MAX_KEYS} simple values (text up to ${EVENT_DATA_MAX_TEXT} characters, numbers, true/false, null; no nested objects; at most ${EVENT_DATA_MAX_BYTES} bytes); keys used by other parts of AgentWeb are refused: from, to, subject, message, content, platform, reason, source, linkedin, campaignId, accountId, invitationId, smartleadEventKey, channel, idempotencyKey. `
      + 'event_date (optional, default now) is an ISO 8601 date-time with a time zone, not in the future and not more than a year ago. '
      + 'Send idempotency_key (8 to 64 letters, digits, - or _) to make a retry safe: an event with the same key already on the lead is not recorded again (recorded: false, duplicate: true). Without it, a retry after a timeout can record the event twice. '
      + `A lead takes at most ${MCP_ENGAGEMENTS_PER_LEAD} events from outside agents, and none when its stored record is nearly full; you may record ${ENGAGEMENTS_PER_HOUR} events an hour. `
      + 'An event whose type or data contains "clicked", "replied" or "received" marks the lead as engaged. No alert is sent and no CRM is synced. '
      + 'list_id and lead_id come from manage_leads list or search_leads; you need edit access to the list. Read the history back with get_lead_engagements. '
      + 'Any other argument is refused by name.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The lead list the lead is in' },
        lead_id: { type: 'string', description: 'The lead id' },
        event_type: { type: 'string', description: 'custom. followed by a short lowercase name, e.g. custom.phone_call' },
        event_data: {
          type: 'object',
          description: `Optional details: at most ${EVENT_DATA_MAX_KEYS} simple values (text up to ${EVENT_DATA_MAX_TEXT} characters, numbers, true/false, null), for example note, outcome, duration_minutes; other plain keys are accepted, reserved ones are refused`,
          properties: {
            note: { type: 'string', description: 'What happened, in a sentence or two' },
            outcome: { type: 'string', description: 'The result, e.g. booked a demo' },
            duration_minutes: { type: 'number', description: 'How long it took' },
          },
          additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
          maxProperties: EVENT_DATA_MAX_KEYS,
        },
        event_date: { type: 'string', description: 'Optional ISO 8601 date-time with a time zone (default: now)' },
        idempotency_key: { type: 'string', description: 'Optional key that makes a retry safe (8 to 64 letters, digits, - or _)' },
      },
      required: ['list_id', 'lead_id', 'event_type'],
    },
  },
  execute,
});
