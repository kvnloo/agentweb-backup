/**
 * Luma tools for Emma (ENG-2338): read events and guest lists through Luma's public
 * API instead of driving a browser through Luma's bot-protected sign-in.
 *
 *   - luma_list_events — events on the connected Luma calendar
 *   - luma_get_guests  — registered guests for one event, newest first
 *
 * Both need a Luma calendar API key connected in Settings -> Connected Accounts
 * (platform = 'luma'; Luma Plus required). Without one they say so and the agent
 * falls back to the browser/session-cookie path.
 */

import { emmaToolRegistry } from './registry';
import {
  getAccountsWithOwnerIncludingOrgShared,
  updateAccountConfig,
} from '../services/connectedAccountsDb';
import { LumaApiService, LumaApiError, parseLumaEventId } from '../services/lumaApiService';
import { decryptPassword } from '../utils/crypto';

const DEFAULT_MAX_GUESTS = 100;
const HARD_MAX_GUESTS = 2000;
const GUEST_STATUSES = ['approved', 'session', 'pending_approval', 'invited', 'declined', 'waitlist'];

const NOT_CONNECTED_MESSAGE =
  'No Luma API key is connected. Connecting one (Settings → Connected Accounts → Luma; needs a Luma Plus ' +
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
        '(Settings → Connected Accounts → Luma). Fall back to the browser session-cookie path or a CSV export meanwhile.',
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
        'subscription lapsed). The user needs to replace it in Settings → Connected Accounts → Luma. ' +
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
    return { success: false, message: `Luma is rate-limiting this calendar (200 requests/minute).${wait}` };
  }
  const detail = error instanceof Error ? error.message : 'unknown error';
  return { success: false, message: `Luma request failed: ${detail}.` };
}

emmaToolRegistry.register({
  name: 'luma_list_events',
  definition: {
    name: 'luma_list_events',
    description:
      'List events on the user\'s connected Luma calendar via the Luma API (newest first). Use this to find an event id ' +
      'before luma_get_guests. Prefer it over browsing luma.com — no browser login or bot check involved. ' +
      'Requires a Luma API key connected in Settings → Connected Accounts; if none is, the tool says so.',
    inputSchema: {
      type: 'object',
      properties: {
        after: { type: 'string', description: 'ISO 8601 datetime — only events starting after this.' },
        before: { type: 'string', description: 'ISO 8601 datetime — only events starting before this.' },
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

    for (const key of ['after', 'before'] as const) {
      if (args?.[key] && Number.isNaN(Date.parse(args[key]))) {
        return { success: false, message: `${key} must be an ISO 8601 datetime.` };
      }
    }
    const limit = args?.limit === undefined ? undefined : Number(args.limit);
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return { success: false, message: 'limit must be a positive number.' };
    }

    const resolved = await resolveLuma(userId, args?.calendar_id);
    if ('error' in resolved) return { success: false, message: resolved.error };

    try {
      const page = await resolved.client.listEvents({
        after: args?.after,
        before: args?.before,
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
      'approval_status, registered_at, phone_number and registration_answers. Use registered_after to pull only recent ' +
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
        registered_after: { type: 'string', description: 'ISO 8601 datetime — only guests who registered after this.' },
        max_guests: {
          type: 'number',
          description: `Soft cap per call (default ${DEFAULT_MAX_GUESTS}, max ${HARD_MAX_GUESTS}); whole 100-guest pages are returned, so it can overshoot slightly. Results include registration answers, so keep it small and page with next_cursor.`,
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
    if (args?.registered_after && Number.isNaN(Date.parse(args.registered_after))) {
      return { success: false, message: 'registered_after must be an ISO 8601 datetime.' };
    }

    const resolved = await resolveLuma(userId, args?.calendar_id);
    if ('error' in resolved) return { success: false, message: resolved.error };

    const maxGuests = Math.min(Math.max(Number(args?.max_guests) || DEFAULT_MAX_GUESTS, 1), HARD_MAX_GUESTS);
    try {
      const page = await resolved.client.listGuests({
        eventId,
        approvalStatus: status,
        registeredAfter: args?.registered_after,
        cursor: args?.cursor,
        maxGuests,
      });
      return {
        success: true,
        calendar: resolved.calendarName,
        event_id: eventId,
        approval_status: status,
        count: page.guests.length,
        guests: page.guests,
        has_more: page.has_more,
        ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
        ...(page.interrupted
          ? { interrupted: `Stopped early (${page.interrupted}). These guests are valid; call again with next_cursor to continue.` }
          : {}),
      };
    } catch (error) {
      return lumaFailure(error, resolved);
    }
  },
});
