/**
 * Google Calendar tools for Emma.
 *
 * Four tools:
 *   - google_calendar_list_events  — list events in a date range
 *   - google_calendar_get_event    — get full details for a single event
 *   - google_calendar_list_calendars — list all calendars the user has access to
 *   - google_calendar_create_event — create (book) an event on the user's calendar
 *
 * The read tools require the user to have Gmail connected with the
 * calendar.readonly scope granted. google_calendar_create_event additionally
 * requires the calendar.events write scope.
 */

import { google } from 'googleapis';
import { emmaToolRegistry } from './registry';
import {
  getAccountByPlatform,
  updateAccountTokens,
  GmailConfig,
  hasGmailCalendarScope,
  hasGmailCalendarWriteScope,
} from '../services/connectedAccountsDb';
import { getGmailConfig } from '../config/integrations';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// ── Token Helper ─────────────────────────────────────────────────────────────

/**
 * Build an authenticated Google Calendar client for the user.
 *
 * @param requireWrite when true, the user must have granted a calendar write
 *   scope (calendar.events). Read-only connections return
 *   `{ error: 'write_scope_not_granted' }` so the caller can prompt a reconnect.
 */
async function getCalendarClient(userId: string, requireWrite = false) {
  const account = await getAccountByPlatform(userId, 'gmail');
  if (!account) return null;

  const config = account.config as GmailConfig;

  if (requireWrite) {
    if (!hasGmailCalendarWriteScope(config)) {
      return { error: 'write_scope_not_granted' as const };
    }
  } else if (!hasGmailCalendarScope(config)) {
    return { error: 'scope_not_granted' as const };
  }

  let token = config.access_token;

  // Refresh token if expiring soon
  if (config.token_expires_at - Date.now() < TOKEN_REFRESH_BUFFER_MS && config.refresh_token) {
    try {
      const gmailConfig = await getGmailConfig();
      const oauth2Client = new google.auth.OAuth2(
        gmailConfig.clientId,
        gmailConfig.clientSecret,
        gmailConfig.redirectUri,
      );
      oauth2Client.setCredentials({
        refresh_token: config.refresh_token,
        access_token: config.access_token,
      });
      const { credentials } = await oauth2Client.refreshAccessToken();
      token = credentials.access_token!;
      await updateAccountTokens(userId, 'gmail', {
        access_token: token,
        token_expires_at: credentials.expiry_date || Date.now() + 3600 * 1000,
      }, account.account_id);
    } catch (err: any) {
      console.warn('[CalendarTools] Token refresh failed, using existing:', err?.message);
    }
  }

  const gmailConfig = await getGmailConfig();
  const oauth2Client = new google.auth.OAuth2(gmailConfig.clientId, gmailConfig.clientSecret);
  oauth2Client.setCredentials({ access_token: token });
  return { client: google.calendar({ version: 'v3', auth: oauth2Client }) };
}

// ── google_calendar_list_events ──────────────────────────────────────────────

emmaToolRegistry.register({
  name: 'google_calendar_list_events',
  definition: {
    name: 'google_calendar_list_events',
    description:
      'List events from the user\'s Google Calendar within a date range. ' +
      'Returns event title, date/time, attendees, location, and description. ' +
      'Requires Gmail connected with Calendar access (Settings → Connected Accounts). ' +
      'Use this when the user asks about their schedule, meetings, upcoming events, or calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        time_min: {
          type: 'string',
          description: 'Start of date range in ISO format (e.g. "2026-04-01T00:00:00Z"). Defaults to now.',
        },
        time_max: {
          type: 'string',
          description: 'End of date range in ISO format (e.g. "2026-04-30T23:59:59Z"). Defaults to 7 days from now.',
        },
        calendar_id: {
          type: 'string',
          description: 'Calendar ID to query. Defaults to "primary" (main calendar). Use google_calendar_list_calendars to find other calendar IDs.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of events to return (1-250). Defaults to 50.',
        },
        query: {
          type: 'string',
          description: 'Optional free-text search query to filter events by title or description.',
        },
      },
      required: [],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId;
    if (!userId) {
      return { success: false, message: 'Authentication required: no user context.' };
    }

    const result = await getCalendarClient(userId);
    if (!result) {
      return {
        success: false,
        message: 'No Gmail account connected. Please connect your Gmail account in Settings → Connected Accounts to use Google Calendar.',
      };
    }
    if ('error' in result) {
      return {
        success: false,
        message: 'Google Calendar access not granted. Please reconnect your Gmail account and allow Calendar access in Settings → Connected Accounts.',
      };
    }

    const { client } = result;
    const calendarId = args.calendar_id || 'primary';
    const timeMin = args.time_min || new Date().toISOString();
    const timeMax = args.time_max || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const maxResults = Math.min(args.max_results || 50, 250);

    try {
      const response = await client.events.list({
        calendarId,
        timeMin,
        timeMax,
        maxResults,
        singleEvents: true,
        orderBy: 'startTime',
        ...(args.query && { q: args.query }),
      });

      const items = response.data.items || [];
      const events = items.map((e: any) => ({
        id: e.id,
        title: e.summary || '(No title)',
        start: e.start?.dateTime || e.start?.date || null,
        end: e.end?.dateTime || e.end?.date || null,
        all_day: !e.start?.dateTime,
        location: e.location || null,
        description: e.description ? e.description.substring(0, 500) : null,
        status: e.status,
        organizer: e.organizer?.email || null,
        attendees: (e.attendees || []).map((a: any) => ({
          email: a.email,
          name: a.displayName || null,
          response: a.responseStatus,
          self: a.self || false,
        })),
        meeting_link: e.hangoutLink || extractMeetingLink(e.description) || null,
        html_link: e.htmlLink || null,
      }));

      return {
        success: true,
        calendar_id: calendarId,
        time_min: timeMin,
        time_max: timeMax,
        count: events.length,
        events,
      };
    } catch (error: any) {
      const status = error?.response?.status || error?.code;
      console.error('[google_calendar_list_events] API error:', error?.message);
      if (status === 403 || status === 401) {
        return {
          success: false,
          message: 'Calendar access denied. Please reconnect your Gmail account with Calendar access in Settings → Connected Accounts.',
        };
      }
      return {
        success: false,
        message: `Failed to fetch calendar events: ${error?.message || 'Unknown error'}`,
      };
    }
  },
});

// ── google_calendar_get_event ────────────────────────────────────────────────

emmaToolRegistry.register({
  name: 'google_calendar_get_event',
  definition: {
    name: 'google_calendar_get_event',
    description:
      'Get full details for a specific Google Calendar event by its ID. ' +
      'Use the event ID from google_calendar_list_events results. ' +
      'Returns complete event details including full description, all attendees, and conference info.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: {
          type: 'string',
          description: 'The event ID from google_calendar_list_events (required).',
        },
        calendar_id: {
          type: 'string',
          description: 'Calendar ID the event belongs to. Defaults to "primary".',
        },
      },
      required: ['event_id'],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId;
    if (!userId) {
      return { success: false, message: 'Authentication required: no user context.' };
    }
    if (!args.event_id) {
      return { success: false, message: 'event_id is required. Use google_calendar_list_events to find event IDs.' };
    }

    const result = await getCalendarClient(userId);
    if (!result) {
      return {
        success: false,
        message: 'No Gmail account connected. Please connect your Gmail account in Settings → Connected Accounts.',
      };
    }
    if ('error' in result) {
      return {
        success: false,
        message: 'Google Calendar access not granted. Please reconnect your Gmail account with Calendar access in Settings → Connected Accounts.',
      };
    }

    const { client } = result;
    const calendarId = args.calendar_id || 'primary';

    try {
      const response = await client.events.get({ calendarId, eventId: args.event_id });
      const e = response.data;
      return {
        success: true,
        event: {
          id: e.id,
          title: e.summary || '(No title)',
          start: e.start?.dateTime || e.start?.date || null,
          end: e.end?.dateTime || e.end?.date || null,
          all_day: !e.start?.dateTime,
          location: e.location || null,
          description: e.description || null,
          status: e.status,
          organizer: e.organizer ? { email: e.organizer.email, name: e.organizer.displayName || null } : null,
          attendees: (e.attendees || []).map((a: any) => ({
            email: a.email,
            name: a.displayName || null,
            response: a.responseStatus,
            self: a.self || false,
            optional: a.optional || false,
          })),
          recurrence: e.recurrence || null,
          conference_data: e.conferenceData ? {
            type: e.conferenceData.conferenceSolution?.name || null,
            entry_points: (e.conferenceData.entryPoints || []).map((ep: any) => ({
              type: ep.entryPointType,
              uri: ep.uri,
              label: ep.label || null,
            })),
          } : null,
          meeting_link: e.hangoutLink || extractMeetingLink(e.description) || null,
          html_link: e.htmlLink || null,
          created: e.created,
          updated: e.updated,
        },
      };
    } catch (error: any) {
      const status = error?.response?.status || error?.code;
      if (status === 404) {
        return { success: false, message: `Event ${args.event_id} not found in calendar ${calendarId}.` };
      }
      console.error('[google_calendar_get_event] API error:', error?.message);
      return { success: false, message: `Failed to fetch event: ${error?.message || 'Unknown error'}` };
    }
  },
});

// ── google_calendar_list_calendars ───────────────────────────────────────────

emmaToolRegistry.register({
  name: 'google_calendar_list_calendars',
  definition: {
    name: 'google_calendar_list_calendars',
    description:
      'List all Google Calendars the user has access to (personal, shared, subscribed). ' +
      'Returns calendar ID, name, color, and access role. ' +
      'Use calendar IDs with google_calendar_list_events to query a specific calendar.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId;
    if (!userId) {
      return { success: false, message: 'Authentication required: no user context.' };
    }

    const result = await getCalendarClient(userId);
    if (!result) {
      return {
        success: false,
        message: 'No Gmail account connected. Please connect your Gmail account in Settings → Connected Accounts.',
      };
    }
    if ('error' in result) {
      return {
        success: false,
        message: 'Google Calendar access not granted. Please reconnect your Gmail account with Calendar access in Settings → Connected Accounts.',
      };
    }

    const { client } = result;

    try {
      const response = await client.calendarList.list({ maxResults: 100 });
      const items = response.data.items || [];
      const calendars = items.map((c: any) => ({
        id: c.id,
        name: c.summary || c.summaryOverride || '(Unnamed)',
        description: c.description || null,
        color: c.backgroundColor || null,
        access_role: c.accessRole,
        primary: c.primary || false,
        selected: c.selected || false,
      }));

      return {
        success: true,
        count: calendars.length,
        calendars,
      };
    } catch (error: any) {
      console.error('[google_calendar_list_calendars] API error:', error?.message);
      return { success: false, message: `Failed to fetch calendars: ${error?.message || 'Unknown error'}` };
    }
  },
});

// ── google_calendar_create_event ─────────────────────────────────────────────

emmaToolRegistry.register({
  name: 'google_calendar_create_event',
  definition: {
    name: 'google_calendar_create_event',
    description:
      'Create (book) a new event on the user\'s own Google Calendar — e.g. block ' +
      'time for a meeting, schedule an appointment, or hold a slot. ' +
      'Requires Gmail connected WITH Calendar write access (Settings → Connected Accounts). ' +
      'If the connection is read-only, this returns a clear message asking the user to ' +
      'reconnect and grant Calendar write access. ' +
      'Use this once the user has supplied a date/time and you have confirmed the details. ' +
      'Note: this writes to the user\'s OWN connected calendar only; it cannot modify other ' +
      'people\'s calendars. Adding attendees will send them an invitation from the user.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Event title / summary (required), e.g. "Strategy sync with Acme".',
        },
        start: {
          type: 'string',
          description:
            'Event start. For a timed event, an ISO 8601 datetime (e.g. "2026-06-30T14:00:00"). ' +
            'For an all-day event, a date "YYYY-MM-DD". Required.',
        },
        end: {
          type: 'string',
          description:
            'Event end, same format as start. For timed events this is required. ' +
            'For all-day events, omit to default to a single day. If a timed start is given ' +
            'without an end, the event defaults to 30 minutes.',
        },
        time_zone: {
          type: 'string',
          description:
            'IANA time zone for timed events (e.g. "America/Los_Angeles"). Strongly recommended ' +
            'for timed events so the slot lands at the intended local time. ' +
            'Ignored for all-day events.',
        },
        description: {
          type: 'string',
          description: 'Optional event description / agenda / notes.',
        },
        location: {
          type: 'string',
          description: 'Optional physical or virtual location text.',
        },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of attendee email addresses to invite. Each will receive a ' +
            'calendar invitation. Only include emails the user explicitly asked to invite.',
        },
        calendar_id: {
          type: 'string',
          description: 'Calendar ID to create the event on. Defaults to "primary".',
        },
        add_conference: {
          type: 'boolean',
          description:
            'When true, attach a Google Meet video conference link to the event. Defaults to false.',
        },
      },
      required: ['summary', 'start'],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId;
    if (!userId) {
      return { success: false, message: 'Authentication required: no user context.' };
    }
    if (!args.summary || typeof args.summary !== 'string' || !args.summary.trim()) {
      return { success: false, message: 'summary is required to create an event.' };
    }
    if (!args.start || typeof args.start !== 'string' || !args.start.trim()) {
      return { success: false, message: 'start (date or datetime) is required to create an event.' };
    }

    const result = await getCalendarClient(userId, /* requireWrite */ true);
    if (!result) {
      return {
        success: false,
        message: 'No Gmail account connected. Please connect your Gmail account in Settings → Connected Accounts to create calendar events.',
      };
    }
    if ('error' in result) {
      return {
        success: false,
        needs_reconnect: true,
        message:
          'Creating calendar events requires Calendar write access, which your Google ' +
          'connection does not have yet. Please go to Settings → Connected Accounts, ' +
          'reconnect your Gmail account, and allow Calendar access (including managing events). ' +
          'After reconnecting, I can book the event for you.',
      };
    }

    const { client } = result;
    const calendarId = args.calendar_id || 'primary';

    // Build start/end. An all-day event uses { date }; a timed event uses
    // { dateTime, timeZone }. We treat a bare "YYYY-MM-DD" start as all-day.
    const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(args.start.trim());
    let start: any;
    let end: any;

    if (isAllDay) {
      start = { date: args.start.trim() };
      // Google requires end.date for all-day events; default to the day after start.
      const endDate = args.end && /^\d{4}-\d{2}-\d{2}$/.test(args.end.trim())
        ? args.end.trim()
        : addDaysToDateString(args.start.trim(), 1);
      end = { date: endDate };
    } else {
      const timeZone = args.time_zone || undefined;
      start = { dateTime: args.start.trim(), ...(timeZone && { timeZone }) };
      const endDateTime = args.end && args.end.trim()
        ? args.end.trim()
        : addMinutesToDateTime(args.start.trim(), 30);
      if (!endDateTime) {
        return {
          success: false,
          message: 'Could not determine the event end time. Please provide a valid end datetime.',
        };
      }
      end = { dateTime: endDateTime, ...(timeZone && { timeZone }) };
    }

    const attendees = Array.isArray(args.attendees)
      ? args.attendees
          .filter((e: any) => typeof e === 'string' && e.includes('@'))
          .map((email: string) => ({ email: email.trim() }))
      : undefined;

    const requestBody: any = {
      summary: args.summary.trim(),
      start,
      end,
      ...(args.description && { description: String(args.description) }),
      ...(args.location && { location: String(args.location) }),
      ...(attendees && attendees.length > 0 && { attendees }),
    };

    let conferenceDataVersion: number | undefined;
    if (args.add_conference) {
      conferenceDataVersion = 1;
      requestBody.conferenceData = {
        createRequest: {
          // Deterministic-ish request id derived from the event summary + start
          // so retries don't spawn duplicate conferences. Math.random is not
          // used here intentionally.
          requestId: `aw-${userId}-${Buffer.from(`${args.summary}|${args.start}`).toString('base64').slice(0, 32)}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
    }

    try {
      const response = await client.events.insert({
        calendarId,
        requestBody,
        ...(conferenceDataVersion && { conferenceDataVersion }),
        ...(attendees && attendees.length > 0 && { sendUpdates: 'all' }),
      });

      const e = response.data;
      return {
        success: true,
        message: `Event "${e.summary || args.summary}" created.`,
        event: {
          id: e.id,
          title: e.summary || args.summary,
          start: e.start?.dateTime || e.start?.date || null,
          end: e.end?.dateTime || e.end?.date || null,
          all_day: !e.start?.dateTime,
          location: e.location || null,
          attendees: (e.attendees || []).map((a: any) => ({
            email: a.email,
            response: a.responseStatus,
          })),
          meeting_link: e.hangoutLink || null,
          html_link: e.htmlLink || null,
        },
      };
    } catch (error: any) {
      const status = error?.response?.status || error?.code;
      console.error('[google_calendar_create_event] API error:', error?.message);
      if (status === 403 || status === 401) {
        return {
          success: false,
          needs_reconnect: true,
          message:
            'Calendar write access was denied by Google. Please reconnect your Gmail account ' +
            'in Settings → Connected Accounts and allow Calendar access (including managing events).',
        };
      }
      if (status === 400) {
        return {
          success: false,
          message: `Could not create the event — Google rejected the request: ${error?.message || 'invalid request'}. Please check the date/time format.`,
        };
      }
      return {
        success: false,
        message: `Failed to create calendar event: ${error?.message || 'Unknown error'}`,
      };
    }
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Add N whole days to a "YYYY-MM-DD" date string, returning the same format.
 * Used to derive the exclusive end date for all-day events.
 */
function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Use UTC to avoid local-timezone date rollover.
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Add N minutes to an ISO 8601 datetime string, preserving any timezone offset
 * suffix the caller supplied. Returns null if the input can't be parsed.
 */
function addMinutesToDateTime(dateTimeStr: string, minutes: number): string | null {
  const hasZoneSuffix = /([zZ]|[+-]\d{2}:?\d{2})$/.test(dateTimeStr);

  if (hasZoneSuffix) {
    // Caller gave an absolute instant; shift it and return normalized UTC ISO.
    const ms = Date.parse(dateTimeStr);
    if (Number.isNaN(ms)) return null;
    return new Date(ms + minutes * 60 * 1000).toISOString();
  }

  // Floating local datetime (no zone), e.g. "2026-06-30T14:00:00". Parse the
  // wall-clock components as if UTC and format them back as UTC so parse and
  // format stay consistent (no server-timezone drift). The event's timeZone
  // field resolves the real instant.
  const m = dateTimeStr
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, min, s] = m;
  const baseMs = Date.UTC(+y, +mo - 1, +d, +h, +min, s ? +s : 0);
  const dt = new Date(baseMs + minutes * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}` +
    `T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`
  );
}

function extractMeetingLink(description: string | null | undefined): string | null {
  if (!description) return null;
  const match = description.match(/https:\/\/(meet\.google\.com|zoom\.us|teams\.microsoft\.com)\S*/);
  return match ? match[0] : null;
}
