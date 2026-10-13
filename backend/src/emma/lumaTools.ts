/**
 * Luma tools for Emma (ENG-2338): read events and guest lists through Luma's public
 * API instead of driving a browser through Luma's bot-protected sign-in.
 *
 *   - luma_list_events — events on the connected Luma calendar
 *   - luma_get_guests  — registered guests for one event, newest first
 *
 * Both need a Luma calendar API key connected in Settings -> Login Credentials -> Luma API key
 * (platform = 'luma'; Luma Plus required). Without one they say so and the agent
 * falls back to the browser/session-cookie path.
 */

import { emmaToolRegistry } from './registry';
import {
  getAccountsWithOwnerIncludingOrgShared,
  updateAccountConfig,
} from '../services/connectedAccountsDb';
import { LumaApiService, LumaApiError, LumaGuest, parseLumaEventId, normalizeIsoUtc } from '../services/lumaApiService';
import { decryptPassword } from '../utils/crypto';

// A tool result over 8,000 chars is offloaded to S3 and the model is shown only the first 20,000, so one
// call is capped to what fits. Measured on realistic guests: ~230 chars bare, ~470 with the company +
// LinkedIn answers only, ~540 with three answers. 60 x 230 = ~14k, 35 x 470 = ~16k, 30 x 540 = ~16k.
// More is read by following next_cursor.
const DEFAULT_MAX_GUESTS = 40;
const HARD_MAX_GUESTS = 60;
const MAX_GUESTS_WITH_ANSWERS = 30;
const MAX_GUESTS_WITH_FILTERED_ANSWERS = 35;
const MAX_ANSWER_LABELS = 5;

/**
 * Keeps only the fields the agent uses. Drops nulls; drops first/last name when `name` is present;
 * and, unless asked for, registration answers — reduced to {label, value}, with Luma's internal
 * question ids and types removed, and optionally to answers whose label contains one of `labels`.
 * A guest list padded with these would be cut off mid-list by the 20,000-char view.
 */
function compactGuest(guest: LumaGuest, includeAnswers: boolean, labels: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(guest)) {
    if (value === null || value === undefined) continue;
    if ((key === 'first_name' || key === 'last_name') && guest.name) continue;
    if (key === 'registration_answers') {
      if (!includeAnswers || !Array.isArray(value)) continue;
      const answers = (value as any[])
        .filter((a) => a && a.value !== null && a.value !== undefined && a.value !== '')
        .filter((a) => labels.length === 0 || labels.some((l) => String(a.label ?? '').toLowerCase().includes(l)))
        .map((a) => ({ label: a.label, value: a.value }));
      if (answers.length > 0) out[key] = answers;
      continue;
    }
    out[key] = value;
  }
  return out;
}

const GUEST_STATUSES = ['approved', 'session', 'pending_approval', 'invited', 'declined', 'waitlist'];

const NOT_CONNECTED_MESSAGE =
  'No Luma API key is connected. Connecting one (Settings → Login Credentials → Luma API key, /settings/login-credentials; needs a Luma Plus ' +
  'calendar API key from luma.com/calendar/manage/api-keys) is the reliable way to read guest lists. ' +
  'Without it, fall back to the browser session-cookie path or a CSV export.';

type ResolvedLuma =
  | { client: LumaApiService; ownerUserId: string; calendarId: string; calendarName: string }
  | { error: string };

async function resolveLuma(userId: string, calendarId?: string): Promise<ResolvedLuma> {
  const all = await getAccountsWithOwnerIncludingOrgShared(userId);
  const accounts = all.filter((a) => a.platform === 'luma');
  if (accounts.length === 0) return { error: NOT_CONNECTED_MESSAGE };

  let account = accounts[0];
  if (calendarId) {
    const match = accounts.find((a) => a.account_id === calendarId);
    if (!match) {
      return { error: `No connected Luma calendar has id "${calendarId}". Connected: ${describe(accounts)}.` };
    }
    account = match;
  } else if (accounts.length > 1) {
    return {
      error: `Several Luma calendars are connected — pass calendar_id. Connected: ${describe(accounts)}.`,
    };
  }

  if ((account.config as any)?.needs_reconnect) {
    return {
      error:
        `The Luma API key for "${account.account_name}" was rejected earlier and needs to be replaced ` +
        '(Settings → Login Credentials → Luma API key). Fall back to the browser session-cookie path or a CSV export meanwhile.',
    };
  }

  let apiKey: string;
  try {
    apiKey = decryptPassword((account.config as any).access_token).password;
  } catch {
    return { error: `The stored Luma key for "${account.account_name}" could not be read. Reconnect Luma in Settings.` };
  }
  return {
    client: new LumaApiService(apiKey),
    ownerUserId: (account as any).userId,
    calendarId: account.account_id,
    calendarName: account.account_name,
  };
}

function describe(accounts: Array<{ account_id: string; account_name: string }>): string {
  return accounts.map((a) => `${a.account_name} (${a.account_id})`).join(', ');
}

/** Maps a Luma failure to an agent-facing message, flagging a dead key so Settings shows it. */
async function lumaFailure(error: unknown, resolved: Extract<ResolvedLuma, { client: LumaApiService }>) {
  if (error instanceof LumaApiError && error.isAuthFailure) {
    await updateAccountConfig(resolved.ownerUserId, 'luma', resolved.calendarId, { needs_reconnect: true }).catch(
      (e) => console.warn('[Luma] Could not flag the rejected key:', e instanceof Error ? e.message : e),
    );
    return {
      success: false,
      message:
        `Luma rejected the API key for "${resolved.calendarName}" (revoked, the wrong calendar, or the Luma Plus ` +
        'subscription lapsed). The user needs to replace it in Settings → Login Credentials → Luma API key. ' +
        'Fall back to the browser session-cookie path or a CSV export meanwhile.',
    };
  }
  if (error instanceof LumaApiError && error.isForbidden) {
    return {
      success: false,
      message:
        `Luma says the key for "${resolved.calendarName}" cannot access that event — it probably belongs to a different ` +
        'calendar. The key itself is fine. Check the event id with luma_list_events, or ask the user for a key from the calendar that hosts it.',
    };
  }
  if (error instanceof LumaApiError && error.status === 429) {
    const wait = error.retryAfterSeconds ? ` Retry after ${error.retryAfterSeconds}s.` : '';
    // Worded so the dispatcher's classifier reads it as `rate_limit` (wait, then retry once) and not as a
    // permanent failure: it matches "rate limit" / a bare 429, not "rate-limiting".
    return { success: false, message: `Luma rate limit hit (HTTP 429; 200 requests/minute per calendar).${wait || ' Wait about a minute'}, then retry the same call.` };
  }
  const detail = error instanceof Error ? error.message : 'unknown error';
  // "timed out" / "network error" so transient failures classify as retryable, not as a dead end.
  const transient =
    error instanceof LumaApiError && error.status === 0
      ? /respond in time/.test(detail) ? 'The request timed out' : 'Network error reaching Luma'
      : null;
  return { success: false, message: transient ? `${transient} (${detail}). Retry once.` : `Luma request failed: ${detail}.` };
}

emmaToolRegistry.register({
  name: 'luma_list_events',
  definition: {
    name: 'luma_list_events',
    description:
      'List events on the user\'s connected Luma calendar via the Luma API (newest first). Use this to find an event id ' +
      'before luma_get_guests. Prefer it over browsing luma.com — no browser login or bot check involved. ' +
      'Requires a Luma API key connected in Settings → Login Credentials (Luma API key card); if none is, the tool says so.',
    inputSchema: {
      type: 'object',
      properties: {
        after: { type: 'string', description: 'ISO 8601 date or datetime (no offset = UTC) — only events starting after this.' },
        before: { type: 'string', description: 'ISO 8601 date or datetime (no offset = UTC) — only events starting before this.' },
        limit: { type: 'number', description: 'Max events to return (default 25, max 100).' },
        cursor: { type: 'string', description: 'next_cursor from a previous call, to get the next page.' },
        calendar_id: { type: 'string', description: 'Only needed when several Luma calendars are connected.' },
      },
      required: [],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId;
    if (!userId) return { success: false, message: 'Authentication required: no user context.' };

    const bounds: { after?: string; before?: string } = {};
    for (const key of ['after', 'before'] as const) {
      if (!args?.[key]) continue;
      const iso = normalizeIsoUtc(args[key]);
      if (!iso) return { success: false, message: `${key} must be an ISO 8601 date or datetime.` };
      bounds[key] = iso;
    }
    const limit = args?.limit === undefined ? undefined : Math.floor(Number(args.limit));
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return { success: false, message: 'limit must be a positive number.' };
    }

    const resolved = await resolveLuma(userId, args?.calendar_id);
    if ('error' in resolved) return { success: false, message: resolved.error };

    try {
      const page = await resolved.client.listEvents({
        after: bounds.after,
        before: bounds.before,
        cursor: args?.cursor,
        limit,
      });
      return {
        success: true,
        calendar: resolved.calendarName,
        count: page.events.length,
        events: page.events,
        has_more: page.has_more,
        ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
      };
    } catch (error) {
      return lumaFailure(error, resolved);
    }
  },
});

emmaToolRegistry.register({
  name: 'luma_get_guests',
  definition: {
    name: 'luma_get_guests',
    description:
      'Get the registered guests of one Luma event via the Luma API, newest registration first. `event` accepts the ' +
      'event id (evt-…) or a luma.com manage URL containing it (public slug links do not — find the id with luma_list_events). Returns guest_id, email, name, ' +
      'approval_status, registered_at and phone_number when present; registration answers only with include_registration_answers or answer_labels. Use registered_after to pull only recent ' +
      'registrants (e.g. a lookback window); de-duplicate on guest_id across calls. Invited-but-never-registered ' +
      'records are omitted unless approval_status is "invited". If has_more is true, call again with next_cursor. ' +
      'This is the reliable path — prefer it over scraping the guest table in a browser. Requires a connected Luma API key.',
    inputSchema: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'Event id (evt-…), or a luma.com/event/manage/evt-… URL. Not a public slug link.' },
        approval_status: {
          type: 'string',
          enum: GUEST_STATUSES,
          description: 'Which guests to return. Default "approved" (going). Use "pending_approval" for the approval queue.',
        },
        registered_after: {
          type: 'string',
          description: 'ISO 8601 date or datetime (no offset = UTC) — only guests who registered after this. Ignored for approval_status "invited", whose records have no registration time.',
        },
        include_registration_answers: {
          type: 'boolean',
          description: `Include each guest's registration-question answers as {label, value} (default false). Without answer_labels this is every answer, so calls are limited to ${MAX_GUESTS_WITH_ANSWERS} guests.`,
        },
        answer_labels: {
          type: 'array',
          items: { type: 'string' },
          description: `Only include answers whose question label contains one of these words (case-insensitive, up to ${MAX_ANSWER_LABELS}), e.g. ["company", "linkedin"]. Implies include_registration_answers and allows ${MAX_GUESTS_WITH_FILTERED_ANSWERS} guests per call.`,
        },
        max_guests: {
          type: 'number',
          description: `Soft cap per call (default ${DEFAULT_MAX_GUESTS}; max ${HARD_MAX_GUESTS}, or ${MAX_GUESTS_WITH_FILTERED_ANSWERS} with answer_labels, or ${MAX_GUESTS_WITH_ANSWERS} with all answers). Larger lists are read by calling again with next_cursor until has_more is false.`,
        },
        cursor: { type: 'string', description: 'next_cursor from a previous call, to continue.' },
        calendar_id: { type: 'string', description: 'Only needed when several Luma calendars are connected.' },
      },
      required: ['event'],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId;
    if (!userId) return { success: false, message: 'Authentication required: no user context.' };

    const eventId = parseLumaEventId(String(args?.event ?? ''));
    if (!eventId) {
      return {
        success: false,
        message:
          'No event id (evt-…) found in `event`. Public links like luma.com/<slug> do not contain it. Call luma_list_events ' +
          'and use the event_id of the event whose url or name matches, or pass a luma.com/event/manage/evt-… link.',
      };
    }
    const status = args?.approval_status ?? 'approved';
    if (!GUEST_STATUSES.includes(status)) {
      return { success: false, message: `approval_status must be one of: ${GUEST_STATUSES.join(', ')}.` };
    }
    let registeredAfter: string | undefined;
    if (args?.registered_after) {
      registeredAfter = normalizeIsoUtc(args.registered_after) ?? undefined;
      if (!registeredAfter) return { success: false, message: 'registered_after must be an ISO 8601 date or datetime.' };
    }
    const answerLabels: string[] = Array.isArray(args?.answer_labels)
      ? args.answer_labels.map((l: unknown) => String(l).trim().toLowerCase()).filter(Boolean).slice(0, MAX_ANSWER_LABELS)
      : [];
    const includeAnswers = args?.include_registration_answers === true || answerLabels.length > 0;

    const resolved = await resolveLuma(userId, args?.calendar_id);
    if ('error' in resolved) return { success: false, message: resolved.error };

    const cap = !includeAnswers ? HARD_MAX_GUESTS : answerLabels.length > 0 ? MAX_GUESTS_WITH_FILTERED_ANSWERS : MAX_GUESTS_WITH_ANSWERS;
    const maxGuests = Math.min(Math.max(Math.floor(Number(args?.max_guests)) || Math.min(DEFAULT_MAX_GUESTS, cap), 1), cap);
    try {
      const page = await resolved.client.listGuests({
        eventId,
        approvalStatus: status,
        registeredAfter,
        cursor: args?.cursor,
        maxGuests,
      });
      return {
        success: true,
        calendar: resolved.calendarName,
        event_id: eventId,
        approval_status: status,
        count: page.guests.length,
        // Paging fields BEFORE the guest list: if a result is ever cut for size, the tail goes, so these
        // must never be what is lost.
        has_more: page.has_more,
        ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
        ...(page.interrupted
          ? { interrupted: `Stopped early (${page.interrupted}). These guests are valid; call again with next_cursor to continue.` }
          : {}),
        ...(page.skippedWithoutRegistration
          ? { skipped_without_registration: page.skippedWithoutRegistration }
          : {}),
        guests: page.guests.map((g) => compactGuest(g, includeAnswers, answerLabels)),
      };
    } catch (error) {
      return lumaFailure(error, resolved);
    }
  },
});
