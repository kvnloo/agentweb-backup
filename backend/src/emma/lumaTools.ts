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

const MAX_ANSWER_CHARS = 300;
// Per-guest total for answers: even a form with hundreds of long questions must not make ONE guest overflow the view
// (the page-size loop cannot shrink below a single guest).
const MAX_GUEST_ANSWER_CHARS = 6000;
// Anything longer than this after compaction cannot be shown: the model sees only the first 20,000 chars.
const MAX_RESULT_CHARS = 17_000;

/** Registration answers are typed by the guest and unbounded; cap each so one guest cannot eat the view. */
function capAnswerValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_ANSWER_CHARS ? `${value.slice(0, MAX_ANSWER_CHARS)}… [truncated]` : value;
  }
  if (Array.isArray(value)) return value.map(capAnswerValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, capAnswerValue(v)]));
  }
  return value;
}

/**
 * True when an answer is one the caller asked for. Matched on the question label, on Luma's question type
 * ("company"), and on a URL value naming the site ("linkedin"): a company question labelled "Where do you
 * work?" or a LinkedIn question labelled "Your profile" must not silently vanish.
 */
function answerMatches(answer: any, labels: string[]): boolean {
  const label = String(answer?.label ?? '').toLowerCase();
  const type = String(answer?.question_type ?? '').toLowerCase();
  const value = typeof answer?.value === 'string' ? answer.value.toLowerCase() : '';
  return labels.some((l) => label.includes(l) || type === l || (value.startsWith('http') && value.includes(l)));
}

/**
 * Keeps only the fields the agent uses. Drops nulls; drops first/last name when `name` is present;
 * and, unless asked for, registration answers — reduced to {label, value}, with Luma's internal
 * question ids and types removed, long free text capped, and optionally narrowed to the answers
 * matching `labels`. A guest list padded with these would be cut off mid-list by the 20,000-char view.
 */
function compactGuest(
  guest: LumaGuest,
  includeAnswers: boolean,
  labels: string[] = [],
  includePhone = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(guest)) {
    if (value === null || value === undefined) continue;
    if ((key === 'first_name' || key === 'last_name') && guest.name) continue;
    // Data minimisation: a phone number is personal data the skills never use, so it is only sent when asked for.
    if (key === 'phone_number' && !includePhone) continue;
    if (key === 'registration_answers') {
      if (!includeAnswers || !Array.isArray(value)) continue;
      const wanted = (value as any[])
        .filter((a) => a && a.value !== null && a.value !== undefined && a.value !== '')
        .filter((a) => labels.length === 0 || answerMatches(a, labels))
        .map((a) => ({ label: a.label, value: capAnswerValue(a.value) }));
      let budget = MAX_GUEST_ANSWER_CHARS;
      const answers: typeof wanted = [];
      for (const a of wanted) {
        const size = JSON.stringify(a).length;
        if (answers.length > 0 && size > budget) break;
        answers.push(a);
        budget -= size;
      }
      if (answers.length > 0) out[key] = answers;
      if (answers.length < wanted.length) out.answers_omitted = wanted.length - answers.length;
      continue;
    }
    out[key] = value;
  }
  return out;
}

const GUEST_STATUSES = ['approved', 'session', 'pending_approval', 'invited', 'declined', 'waitlist'];

const NOT_CONNECTED_MESSAGE =
  'NOTHING WAS PULLED: no Luma API key is connected for this account. That is normal and NOT an error — most accounts read Luma through ' +
  'the browser. Do not stop and do not report a failure: continue the task now with the browser session-cookie path ' +
  '(or ask for a CSV export). You may mention once that a Luma Plus calendar API key (create it at ' +
  'luma.com/calendar/manage/api-keys) saved on the "Luma API key" card in ' +
  '[Settings → Login Credentials](/settings/login-credentials) would let future pulls skip the login — give that exact link. ' +
  'In a scheduled or unattended run, just continue.';

const keyRejectedMessage = (calendarName: string) =>
  `NOTHING WAS PULLED: the Luma API key for the calendar "${calendarName}" was rejected by Luma (revoked, the wrong calendar, or the Luma ` +
  'Plus subscription lapsed), so the API path is unavailable. Do not stop: continue with the browser session-cookie ' +
  'path or a CSV export, and tell the user the key needs replacing on the "Luma API key" card in ' +
  '[Settings → Login Credentials](/settings/login-credentials).';

/**
 * "No usable key" is a normal state for most accounts, not a failure. It is returned as a SUCCESS so the dispatcher
 * does not paint a red "failed" card at users who never had a key, does not count it in failedFunctions, and does
 * not append "do NOT retry / report the blocker" guidance that made a weak model abandon a scheduled run
 * (observed in production on 2026-10-14: two failed luma_list_events calls, then the run ended having done nothing).
 */
const unavailable = (reason: 'no_key' | 'key_rejected', message: string) => ({
  success: true,
  connected: false,
  // `success: true` only means "the tool ran without error". A weak model read it as "the pull succeeded" and told the
  // user it had pulled guests (seen live on gpt-5.4-nano), so the result says in plain fields that no data came back.
  nothing_pulled: true,
  reason,
  message,
});

type ResolvedLuma =
  | { client: LumaApiService; ownerUserId: string; calendarId: string; calendarName: string }
  | { unavailable: ReturnType<typeof unavailable> }
  | { error: string };

async function resolveLuma(userId: string, calendarId?: string): Promise<ResolvedLuma> {
  const all = await getAccountsWithOwnerIncludingOrgShared(userId);
  const accounts = all.filter((a) => a.platform === 'luma');
  if (accounts.length === 0) return { unavailable: unavailable('no_key', NOT_CONNECTED_MESSAGE) };

  let account = accounts[0];
  if (calendarId) {
    const match = accounts.find((a) => a.account_id === calendarId);
    if (!match) {
      return { error: `No connected Luma calendar has id "${calendarId}". Connected: ${describe(accounts)}.` };
    }
    account = match;
  } else if (accounts.length > 1) {
    // A key shared with the org must not break a teammate who already has their own calendar (ENG-2737): the caller's single own
    // connection wins, as with Smartlead. Anything else is ambiguous and asks for calendar_id.
    const own = accounts.filter((a) => a.userId === userId);
    if (own.length === 1) {
      account = own[0];
    } else {
      return {
        error: `Several Luma calendars are connected — pass calendar_id. Connected: ${describe(accounts)}.`,
      };
    }
  }

  let apiKey: string;
  try {
    apiKey = decryptPassword((account.config as any).access_token).password;
  } catch {
    return { unavailable: unavailable('key_rejected', keyRejectedMessage(account.account_name)) };
  }

  if ((account.config as any)?.needs_reconnect) {
    // A flagged key is re-probed with one cheap call instead of staying dead forever: two 401s during a short Luma
    // auth outage must not silently push every later run (scheduled ones included) onto the bot-blocked browser path.
    const probe = await new LumaApiService(apiKey).getCalendar().then(
      () => 'ok' as const,
      (e) => (e instanceof LumaApiError && e.isAuthFailure ? ('rejected' as const) : ('unknown' as const)),
    );
    if (probe === 'rejected') {
      return { unavailable: unavailable('key_rejected', keyRejectedMessage(account.account_name)) };
    }
    if (probe === 'ok') {
      await updateAccountConfig((account as any).userId, 'luma', account.account_id, () => ({ updates: {}, unset: ['needs_reconnect'] })).catch(
        (e) => console.warn('[Luma] Could not clear the recovered key flag:', e instanceof Error ? e.message : e),
      );
    }
    // 'unknown' (timeout / 429 / network): not proof either way, so try the real call and let it report honestly.
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

/**
 * Maps a Luma failure to an agent-facing message, flagging a dead key so Settings shows it.
 * `errorClass` is set explicitly (honoured by toolResultError) so retry guidance never depends on prose:
 * a calendar called "Founders 500 Club" in the message would otherwise match the embedded-status pattern.
 */
async function lumaFailure(error: unknown, resolved: Extract<ResolvedLuma, { client: LumaApiService }>) {
  if (error instanceof LumaApiError && error.isAuthFailure) {
    // A single 401 could be a Luma-side blip; flagging the key dead makes every later call (and the Settings card)
    // say it is broken until the user re-enters it. Confirm with an independent call before believing it.
    const confirm = await resolved.client.getCalendar().then(
      () => 'works' as const,
      (e) => (e instanceof LumaApiError && e.isAuthFailure ? ('rejected' as const) : ('unknown' as const)),
    );
    if (confirm === 'works') {
      return {
        success: false,
        errorClass: 'upstream_5xx',
        message: 'Luma answered that request with an authorisation error, but the key still works. Retry once.',
      };
    }
    if (confirm === 'unknown') {
      // Could not prove either way (Luma timing out / rate-limiting): do not flag the key and do not claim it works.
      return {
        success: false,
        errorClass: 'upstream_5xx',
        message: 'Luma answered with an authorisation error and could not be re-checked just now. Retry once in a moment.',
      };
    }
    await updateAccountConfig(resolved.ownerUserId, 'luma', resolved.calendarId, { needs_reconnect: true }).catch(
      (e) => console.warn('[Luma] Could not flag the rejected key:', e instanceof Error ? e.message : e),
    );
    return unavailable('key_rejected', keyRejectedMessage(resolved.calendarName));
  }
  if (error instanceof LumaApiError && error.isForbidden) {
    return {
      success: false,
      // An argument problem (wrong event / wrong calendar), not a dead credential: `auth` would tell the model to
      // have the user reconnect an account that is fine.
      errorClass: 'invalid_args',
      message:
        `Luma says the key for the calendar "${resolved.calendarName}" cannot access that event — it probably belongs to a different ` +
        'calendar. The key itself is fine. Check the event id with luma_list_events, pass the calendar_id of the calendar that hosts it if it is ' +
        'connected or shared with the user, or ask the user for a key from that calendar.',
    };
  }
  if (error instanceof LumaApiError && error.status === 429) {
    const wait = error.retryAfterSeconds ? `Retry after ${error.retryAfterSeconds}s` : 'Wait about a minute';
    return {
      success: false,
      errorClass: 'rate_limit',
      message: `Luma rate limit hit (HTTP 429; 200 requests/minute per calendar). ${wait}, then retry the same call.`,
    };
  }
  const detail = error instanceof Error ? error.message : 'unknown error';
  if (error instanceof LumaApiError && error.status === 0) {
    const timedOut = /respond in time/.test(detail);
    return {
      success: false,
      errorClass: timedOut ? 'timeout' : 'network',
      message: `${timedOut ? 'The request timed out' : 'Network error reaching Luma'} (${detail}). Retry once.`,
    };
  }
  return { success: false, message: `Luma request failed: ${detail}.` };
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
        calendar_id: { type: 'string', description: 'Needed when several Luma calendars are connected, or to use a calendar a teammate shared instead of your own.' },
      },
      required: [],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId;
    if (!userId) return { success: false, message: 'Authentication required: no user context.' };

    // Key first: a user with no key must get the normal "carry on with the browser" answer, not an argument error.
    const resolved = await resolveLuma(userId, args?.calendar_id);
    if ('unavailable' in resolved) return resolved.unavailable;
    if ('error' in resolved) return { success: false, message: resolved.error };

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
      'approval_status, registered_at when present (phone number only with include_phone); registration answers only with include_registration_answers or answer_labels. Use registered_after to pull only recent ' +
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
        include_phone: {
          type: 'boolean',
          description: 'Include each guest\'s phone number (default false; only ask for it if the task needs it).',
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
        calendar_id: { type: 'string', description: 'Needed when several Luma calendars are connected, or to use a calendar a teammate shared instead of your own.' },
      },
      required: ['event'],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId;
    if (!userId) return { success: false, message: 'Authentication required: no user context.' };

    // Key first (see luma_list_events): a bad slug link from a key-less user must not become a red failure.
    const resolved = await resolveLuma(userId, args?.calendar_id);
    if ('unavailable' in resolved) return resolved.unavailable;
    if ('error' in resolved) return { success: false, message: resolved.error };

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
    // Accept a bare string or a comma-separated one too: a model that sends "company, linkedin" must not get
    // silently-empty answers.
    const rawLabels: unknown[] = Array.isArray(args?.answer_labels)
      ? args.answer_labels
      : typeof args?.answer_labels === 'string'
        ? args.answer_labels.split(',')
        : [];
    const answerLabels: string[] = rawLabels
      .map((l) => String(l).trim().toLowerCase())
      .filter(Boolean)
      .slice(0, MAX_ANSWER_LABELS);
    const includeAnswers = args?.include_registration_answers === true || answerLabels.length > 0;
    const includePhone = args?.include_phone === true;

    const cap = !includeAnswers ? HARD_MAX_GUESTS : answerLabels.length > 0 ? MAX_GUESTS_WITH_FILTERED_ANSWERS : MAX_GUESTS_WITH_ANSWERS;
    const maxGuests = Math.min(Math.max(Math.floor(Number(args?.max_guests)) || Math.min(DEFAULT_MAX_GUESTS, cap), 1), cap);
    try {
      // The model is shown only the first 20,000 chars of a result and a Luma page cannot be split (the cursor
      // resumes at a page boundary). So if a page does not fit, re-read the SAME starting point with a smaller
      // page, sized from what we just measured, instead of asking the model to do it — a weak model that gets a
      // refusal may simply stop. Luma's rate limit (200/min) makes one or two extra reads cheap.
      let pageSize = maxGuests;
      let attempts = 0;
      for (;;) {
        const page = await resolved.client.listGuests({
          eventId,
          approvalStatus: status,
          registeredAfter,
          cursor: args?.cursor,
          maxGuests: pageSize,
        });
        const guests = page.guests.map((g) => compactGuest(g, includeAnswers, answerLabels, includePhone));
        const result = {
          success: true,
          calendar: resolved.calendarName,
          event_id: eventId,
          approval_status: status,
          count: guests.length,
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
          ...(answerLabels.length > 0 && guests.length > 0 && !guests.some((g) => g.registration_answers)
            ? {
                answers_note:
                  `None of the registration answers matched ${JSON.stringify(answerLabels)}. Retry with ` +
                  'include_registration_answers: true to see every question and pick the right ones.',
              }
            : {}),
          guests,
        };
        const size = JSON.stringify(result).length;
        if (size <= MAX_RESULT_CHARS || pageSize <= 1) return result;
        if (attempts >= 4) {
          return {
            success: false,
            errorClass: 'read_incomplete',
            message:
              `A page of guests is still too large to show (${size} chars; the answers are long free text). ` +
              `Call luma_get_guests again with ${args?.cursor ? 'the SAME cursor' : 'no cursor'} and a much smaller max_guests.`,
          };
        }
        const perGuest = size / Math.max(1, guests.length);
        pageSize = Math.max(1, Math.min(pageSize - 1, Math.floor((MAX_RESULT_CHARS * 0.9) / perGuest)));
        attempts += 1;
      }
    } catch (error) {
      return lumaFailure(error, resolved);
    }
  },
});
