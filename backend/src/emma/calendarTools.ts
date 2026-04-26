/**
 * Google Calendar tools for Emma.
 *
 * Three tools:
 *   - google_calendar_list_events  — list events in a date range
 *   - google_calendar_get_event    — get full details for a single event
 *   - google_calendar_list_calendars — list all calendars the user has access to
 *
 * All tools require the user to have Gmail connected with the
 * calendar.readonly scope granted.
 */

import { google } from 'googleapis';
import { emmaToolRegistry } from './registry';
import {
  getAccountByPlatform,
  updateAccountTokens,
  GmailConfig,
  hasGmailCalendarScope,
} from '../services/connectedAccountsDb';
import { getGmailConfig } from '../config/integrations';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// ── Token Helper ─────────────────────────────────────────────────────────────

async function getCalendarClient(userId: string) {
  const account = await getAccountByPlatform(userId, 'gmail');
  if (!account) return null;

  const config = account.config as GmailConfig;

  if (!hasGmailCalendarScope(config)) {
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractMeetingLink(description: string | null | undefined): string | null {
  if (!description) return null;
  const match = description.match(/https:\/\/(meet\.google\.com|zoom\.us|teams\.microsoft\.com)\S*/);
  return match ? match[0] : null;
}
