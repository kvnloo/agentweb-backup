/**
 * Prospect Meeting Service
 *
 * Pulls meeting data from Google Calendar and enriches with Fathom recording data
 * to determine whether prospect meetings actually happened (vs no-shows).
 *
 * Key insight: calendar RSVPs and event status only show scheduling *intent*,
 * not actual attendance. To determine if a meeting happened, we check the
 * NUMBER OF DISTINCT SPEAKERS in the Fathom transcript:
 *   - 0 or 1 speaker = no-show (you talked to yourself or nobody)
 *   - 2+ speakers = real conversation happened ("Talked")
 *   - Past event with no recording = likely a no-show
 *
 * Flow:
 *   1. Pull Google Calendar events with external attendees (not @agentweb.pro)
 *   2. For past events, match Fathom recordings by time window (±15 min)
 *   3. If recording exists, fetch transcript and count distinct speakers
 *   4. Classify: "talked" / "no-show" / "upcoming" / "canceled"
 *
 * Used by the funnel service as the "Talked" stage data source.
 */

import { google } from 'googleapis';
import axios from 'axios';
import {
  getAccountByPlatform,
  getAccountsByUserId,
  updateAccountTokens,
  GmailConfig,
} from './connectedAccountsDb';
import { getGmailConfig, getFathomConfig } from '../config/integrations';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProspectMeeting {
  date: string;
  title: string;
  attendees: string[]; // external attendees only
  status: 'talked' | 'no-show' | 'upcoming' | 'canceled';
  speakerCount?: number; // distinct speakers from transcript (undefined if no recording)
  recordingUrl?: string; // Fathom link if available
  recordingId?: number; // Fathom recording ID for drill-down
  duration?: number; // minutes
}

/**
 * Classification of why a Google Calendar fetch failed. Surfaced up the stack
 * so callers (businessFunnelService → frontend) can distinguish "0 meetings"
 * from "we couldn't even read the calendar". Prior to this the service
 * collapsed every 403 into a bare empty array, which silently zeroed the
 * funnel's Talked stage regardless of the actual root cause.
 */
export type CalendarFetchError =
  | 'service_disabled'        // Google Calendar API not enabled in GCP project
  | 'scope_not_granted'       // User did not grant calendar scope at OAuth time
  | 'insufficient_permissions' // Token is valid but scope is missing / revoked
  | 'quota_exceeded'          // Per-minute or daily quota hit
  | 'forbidden_unknown'       // 403 with an unrecognized reason
  | 'unknown';                // Non-403 error bucket

/** A unique prospect (de-duped by email domain) with all their meetings rolled up */
export interface ProspectDetail {
  domain: string;            // e.g. "37angels.com"
  contacts: string[];        // unique email addresses at this domain
  meetingCount: number;       // total meetings (talked + no-show)
  talkedCount: number;        // meetings where conversation happened
  lastMeetingDate: string;    // most recent meeting date (ISO)
  meetings: ProspectMeeting[]; // individual meetings for drill-down
}

export interface ProspectMeetingMetrics {
  totalMeetings: number; // prospect meetings where conversation happened (2+ speakers)
  uniqueProspectsTalked: number; // unique company domains with at least one 'talked' meeting
  previousPeriodMeetings: number; // for comparison
  upcomingBooked: number; // future prospect meetings
  noShows: number; // past meetings with 0-1 speakers or no recording
  meetings: ProspectMeeting[]; // list of actual meetings
  prospects: ProspectDetail[]; // de-duped by company domain, sorted by last meeting
  /**
   * When set, the Google Calendar fetch failed and the other counts should be
   * treated as "unknown, not zero". Used by the business funnel to show an
   * actionable banner instead of a misleading zero.
   */
  calendarError?: CalendarFetchError;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Domains considered "internal" — meetings with ONLY these attendees are excluded */
const INTERNAL_DOMAINS = ['agentweb.pro'];

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const FATHOM_API_BASE = 'https://api.fathom.ai/external/v1';

/** Build the correct auth header for Fathom — API keys use X-API-Key, OAuth tokens use Bearer */
function fathomAuthHeaders(token: string): Record<string, string> {
  // API keys contain a dot separator (e.g. "Llv8xnB-...CIg.Je9mHa1...")
  // OAuth access tokens are typically opaque strings without dots
  if (token.includes('.') && !token.startsWith('ey')) {
    return { 'X-API-Key': token };
  }
  return { Authorization: `Bearer ${token}` };
}

/** Time window (ms) for matching calendar events to Fathom recordings */
const RECORDING_MATCH_WINDOW_MS = 15 * 60 * 1000; // ±15 minutes

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check if an email address belongs to an internal team member.
 */
function isInternalEmail(email: string): boolean {
  const lower = email.toLowerCase().trim();
  return INTERNAL_DOMAINS.some(domain => lower.endsWith(`@${domain}`));
}

/**
 * Extract external attendees from a list of email addresses.
 */
function getExternalAttendees(emails: string[]): string[] {
  return emails.filter(email => !isInternalEmail(email));
}

/**
 * Determine raw temporal status of a calendar event.
 * Note: This is NOT the final meeting status — for past events, we use
 * speaker diarization to determine "talked" vs "no-show".
 */
function getTemporalStatus(
  endTime: string,
  eventStatus?: string,
): 'past' | 'upcoming' | 'canceled' {
  if (eventStatus === 'cancelled') return 'canceled';
  const now = new Date();
  const end = new Date(endTime);
  if (end < now) return 'past';
  return 'upcoming';
}

/**
 * Determine final meeting status based on speaker analysis from transcript.
 * This is the source of truth for whether a prospect meeting actually happened.
 *
 * Key: just having 2+ speakers isn't enough — it could be Harsha + Matt
 * on a call where the prospect no-showed. We need at least one speaker
 * who is NOT a known internal team member (@agentweb.pro).
 *
 * - Has external speaker = real conversation ("talked")
 * - Only internal speakers = no-show (team was on call but prospect didn't join)
 * - No recording for a past event = also no-show
 */
function classifyMeetingStatus(
  temporalStatus: 'past' | 'upcoming' | 'canceled',
  speakerAnalysis: { total: number; hasExternalSpeaker: boolean } | undefined,
  /**
   * Fallback signal from the Fathom listing response. When the transcript is
   * unavailable (common for fresh recordings where `GET /recordings/:id/transcript`
   * returns empty), we still know from the calendar invitees whether the
   * meeting had any external attendees. If the prospect was invited AND a
   * recording exists in the matching window, treat it as `talked` rather than
   * silently falling through to `no-show`.
   */
  fathomHasExternalInvitees?: boolean,
): 'talked' | 'no-show' | 'upcoming' | 'canceled' {
  if (temporalStatus === 'canceled') return 'canceled';
  if (temporalStatus === 'upcoming') return 'upcoming';

  // Past event — transcript speaker diarization is the strongest signal.
  if (speakerAnalysis?.hasExternalSpeaker) return 'talked';

  // Fallback: transcript unavailable but Fathom says the recording had
  // external invitees. A recording only exists if someone joined the call,
  // so this is a reliable signal that a conversation happened.
  if (!speakerAnalysis && fathomHasExternalInvitees) return 'talked';

  // Only internal speakers, no recording, or no external signal = no-show
  return 'no-show';
}

/**
 * Calculate duration in minutes between two ISO date strings.
 */
function getDurationMinutes(startTime: string, endTime: string): number {
  const start = new Date(startTime);
  const end = new Date(endTime);
  return Math.round((end.getTime() - start.getTime()) / 60000);
}

// ── Token Management ─────────────────────────────────────────────────────────

/**
 * Get a valid Google OAuth access token from the user's Gmail connected account.
 * Refreshes the token if it is about to expire.
 * Returns null if no Gmail account is connected.
 */
async function getGoogleAccessToken(userId: string): Promise<{ token: string; accountId: string } | null> {
  const account = await getAccountByPlatform(userId, 'gmail');
  if (!account) return null;

  const config = account.config as GmailConfig;
  const isExpiringSoon = config.token_expires_at - Date.now() < TOKEN_REFRESH_BUFFER_MS;

  if (!isExpiringSoon) {
    return { token: config.access_token, accountId: account.account_id };
  }

  // Token needs refresh
  if (!config.refresh_token) {
    // No refresh token — use existing token and hope for the best
    return { token: config.access_token, accountId: account.account_id };
  }

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
    const newToken = credentials.access_token!;
    const expiresAt = credentials.expiry_date || Date.now() + 3600 * 1000;

    await updateAccountTokens(userId, 'gmail', {
      access_token: newToken,
      token_expires_at: expiresAt,
    }, account.account_id);

    return { token: newToken, accountId: account.account_id };
  } catch (err: any) {
    console.warn('[ProspectMeeting] Token refresh failed, using existing token:', err?.message);
    return { token: config.access_token, accountId: account.account_id };
  }
}

/**
 * Build a Google Calendar client using the user's Gmail OAuth token.
 * Returns null if no token is available or if calendar scope is not granted.
 */
async function getCalendarClient(userId: string) {
  const tokenResult = await getGoogleAccessToken(userId);
  if (!tokenResult) return null;

  const gmailConfig = await getGmailConfig();
  const oauth2Client = new google.auth.OAuth2(
    gmailConfig.clientId,
    gmailConfig.clientSecret,
  );
  oauth2Client.setCredentials({ access_token: tokenResult.token });

  return google.calendar({ version: 'v3', auth: oauth2Client });
}

// ── Fathom Integration ───────────────────────────────────────────────────────

/**
 * Retrieve the Fathom access token from the user's connected accounts.
 * Handles OAuth token refresh if needed.
 */
async function getFathomAccessToken(userId: string): Promise<string | null> {
  const accounts = await getAccountsByUserId(userId);
  const fathomAccount = accounts.find(acc => acc.platform === 'fathom');
  if (!fathomAccount) return null;

  const config = fathomAccount.config as any;

  // Check if OAuth token needs refresh
  if (config.refresh_token && config.token_expires_at && Date.now() > config.token_expires_at - 60000) {
    try {
      const fathomConfig = await getFathomConfig();
      const response = await axios.post(fathomConfig.tokenUrl, new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: config.refresh_token,
        client_id: fathomConfig.clientId,
        client_secret: fathomConfig.clientSecret,
      }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      });

      const { access_token, refresh_token, expires_in } = response.data as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };

      await updateAccountTokens(userId, 'fathom', {
        access_token,
        ...(refresh_token && { refresh_token }),
        token_expires_at: Date.now() + (expires_in * 1000),
      }, fathomAccount.account_id);
      return access_token;
    } catch (err: any) {
      console.warn('[ProspectMeeting] Fathom token refresh failed, using existing:', err?.message);
    }
  }

  return config.access_token || null;
}

interface FathomRecordingMatch {
  recordingId: number;
  title: string;
  url: string;
  startTime: string; // recording start time (ISO)
  endTime: string;
  /**
   * Fathom listing response flag derived from `calendar_invitees_domains_type`.
   * True when the meeting had at least one external invitee. Used as a
   * fallback signal when transcript speaker diarization is unavailable.
   */
  hasExternalInvitees: boolean;
}

/** Safety cap on Fathom pagination — 20 pages × 10/page = 200 recordings. */
export const FATHOM_MAX_PAGES = 20;

/**
 * Fetch Fathom meetings/recordings in a date range.
 *
 * Fathom's `/v1/meetings` endpoint paginates with `next_cursor` (default page
 * size of 10). This function follows the cursor until exhausted or until
 * FATHOM_MAX_PAGES is reached, so that a customer with 70+ recordings in the
 * last 30 days does not silently lose all but the first 10.
 *
 * Returns an array of recordings with their start times for ±15 min matching.
 */
async function getFathomRecordings(
  userId: string,
  startDate: string,
  endDate: string,
): Promise<FathomRecordingMatch[]> {
  const recordings: FathomRecordingMatch[] = [];
  const accessToken = await getFathomAccessToken(userId);
  if (!accessToken) return recordings;

  let cursor: string | undefined;
  let pageCount = 0;

  try {
    do {
      const params = new URLSearchParams({
        created_after: startDate,
        created_before: endDate,
      });
      if (cursor) params.set('cursor', cursor);

      const response = await axios.get(
        `${FATHOM_API_BASE}/meetings?${params.toString()}`,
        {
          headers: fathomAuthHeaders(accessToken),
          timeout: 10000,
        },
      );

      const rawData = response.data as any;
      const meetingsArray = Array.isArray(rawData) ? rawData
        : Array.isArray(rawData?.items) ? rawData.items
        : Array.isArray(rawData?.calls) ? rawData.calls
        : Array.isArray(rawData?.meetings) ? rawData.meetings
        : [];

      for (const m of meetingsArray) {
        const startTime = m.scheduled_start_time || m.recording_start_time || m.created_at;
        if (!startTime) continue;

        recordings.push({
          recordingId: m.recording_id,
          title: m.title || m.meeting_title || '',
          url: m.url || m.share_url || '',
          startTime,
          endTime: m.recording_end_time || '',
          hasExternalInvitees: m.calendar_invitees_domains_type === 'one_or_more_external',
        });
      }

      cursor = typeof rawData?.next_cursor === 'string' && rawData.next_cursor.length > 0
        ? rawData.next_cursor
        : undefined;
      pageCount++;
    } while (cursor && pageCount < FATHOM_MAX_PAGES);

    if (cursor) {
      console.warn(
        `[ProspectMeeting] Hit FATHOM_MAX_PAGES (${FATHOM_MAX_PAGES}) — truncating Fathom recordings. ` +
        `Fetched ${recordings.length} records so far.`,
      );
    }
  } catch (err: any) {
    console.warn('[ProspectMeeting] Fathom fetch failed (non-fatal):', err?.message);
  }

  return recordings;
}

// Exported for test harness so we can exercise pagination + the fallback
// classification path without going through the full calendar flow.
export const __test__ = {
  getFathomRecordings,
  classifyMeetingStatus,
  findMatchingRecording,
  analyzeSpeakers,
};

/**
 * Match a calendar event to a Fathom recording by time window (±15 minutes).
 * Returns the matched recording or undefined if no match within the window.
 */
function findMatchingRecording(
  eventStart: string,
  recordings: FathomRecordingMatch[],
): FathomRecordingMatch | undefined {
  const eventTime = new Date(eventStart).getTime();

  let bestMatch: FathomRecordingMatch | undefined;
  let bestDelta = Infinity;

  for (const recording of recordings) {
    const recordingTime = new Date(recording.startTime).getTime();
    const delta = Math.abs(eventTime - recordingTime);

    if (delta <= RECORDING_MATCH_WINDOW_MS && delta < bestDelta) {
      bestMatch = recording;
      bestDelta = delta;
    }
  }

  return bestMatch;
}

/**
 * Known internal team member names (first names or display names).
 * Used to filter out internal speakers from Fathom transcripts.
 * Fathom uses display names, not emails, so we match by name.
 */
const INTERNAL_SPEAKER_NAMES = [
  'harsha', 'rui', 'matt', 'matthew', 'fangfang', 'fong',
].map(n => n.toLowerCase());

/**
 * Check if a speaker name belongs to an internal team member.
 */
function isInternalSpeaker(speakerName: string): boolean {
  const lower = speakerName.toLowerCase().trim();
  return INTERNAL_SPEAKER_NAMES.some(name => lower.includes(name));
}

/**
 * Count distinct speakers in a Fathom transcript and determine
 * if any external (non-AgentWeb) person actually spoke.
 *
 * The key insight: 2+ speakers isn't enough — it could be Harsha + Matt
 * on a call where the prospect no-showed. We need at least one speaker
 * who is NOT a known internal team member.
 *
 * Returns { total, hasExternalSpeaker } or undefined if transcript unavailable.
 */
async function analyzeSpeakers(
  userId: string,
  recordingId: number,
): Promise<{ total: number; hasExternalSpeaker: boolean } | undefined> {
  try {
    const accessToken = await getFathomAccessToken(userId);
    if (!accessToken) return undefined;

    const response = await axios.get(
      `${FATHOM_API_BASE}/recordings/${recordingId}/transcript`,
      {
        headers: fathomAuthHeaders(accessToken),
        timeout: 10000,
      },
    );

    const data = response.data as any;
    const transcript = data?.transcript || [];

    // Count distinct speaker names
    const speakers = new Set<string>();
    for (const turn of transcript) {
      if (turn.speaker && typeof turn.speaker === 'string') {
        speakers.add(turn.speaker);
      }
    }

    // Treat an empty transcript (HTTP 200 with `{ transcript: [] }`) the same
    // as a 404 — Fathom returns this shape for fresh recordings that haven't
    // been diarized yet. Returning `undefined` lets `classifyMeetingStatus`
    // fall through to the calendar-invitees fallback instead of silently
    // bucketing the meeting as `no-show`.
    if (speakers.size === 0) {
      console.info(
        `[ProspectMeeting] Empty transcript for recording ${recordingId} (not yet diarized)`,
      );
      return undefined;
    }

    const hasExternalSpeaker = Array.from(speakers).some(s => !isInternalSpeaker(s));

    return { total: speakers.size, hasExternalSpeaker };
  } catch (err: any) {
    // 404 = recording exists in listing but transcript not ready yet
    if (err?.response?.status === 404) {
      console.info(`[ProspectMeeting] Transcript not available for recording ${recordingId}`);
      return undefined;
    }
    console.warn(`[ProspectMeeting] Transcript fetch failed for recording ${recordingId}:`, err?.message);
    return undefined;
  }
}

// ── Google Calendar Fetching ─────────────────────────────────────────────────

interface CalendarEventData {
  summary: string;
  start: string;
  end: string;
  status: string;
  attendees: string[];
}

interface CalendarFetchResult {
  events: CalendarEventData[];
  error?: CalendarFetchError;
}

/**
 * Classify a Google Calendar API error. Google returns 403 for a bunch of
 * very different failure modes and the previous implementation silently
 * collapsed them all into "empty results", which made debugging a
 * `SERVICE_DISABLED` incident require manual DynamoDB + HTTP forensics.
 *
 * This reads both the Google REST error shape (`err.response.data.error`)
 * and the googleapis SDK's wrapped shape (`err.errors[]`) so it works
 * regardless of which path threw.
 */
function classifyCalendarError(err: any): CalendarFetchError {
  const status = err?.response?.status ?? err?.code;
  if (status !== 403) {
    return 'unknown';
  }

  // Pull the first textual reason we can find. The googleapis SDK exposes
  // this on `err.errors[0].reason`; the REST response uses
  // `response.data.error.errors[0].reason`; newer Google errors surface a
  // top-level `response.data.error.status` enum like `PERMISSION_DENIED`.
  const reason: string | undefined =
    err?.errors?.[0]?.reason ||
    err?.response?.data?.error?.errors?.[0]?.reason;
  const statusEnum: string | undefined =
    err?.response?.data?.error?.status;
  const message: string | undefined =
    err?.response?.data?.error?.message || err?.message;

  const haystack = `${reason || ''} ${statusEnum || ''} ${message || ''}`.toLowerCase();

  if (
    haystack.includes('accessnotconfigured') ||
    haystack.includes('service_disabled') ||
    haystack.includes('has not been used') ||
    haystack.includes('is disabled')
  ) {
    return 'service_disabled';
  }
  if (haystack.includes('quota') || haystack.includes('rate_limit')) {
    return 'quota_exceeded';
  }
  if (haystack.includes('insufficientpermissions') || haystack.includes('insufficient_permissions')) {
    return 'insufficient_permissions';
  }
  if (
    haystack.includes('permission_denied') ||
    haystack.includes('forbidden') ||
    haystack.includes('scope')
  ) {
    return 'scope_not_granted';
  }
  return 'forbidden_unknown';
}

/**
 * Human-friendly log message per classified error — keeps CloudWatch readable
 * while preserving enough signal to spot the next time Calendar API gets
 * accidentally disabled in GCP.
 */
function describeCalendarError(error: CalendarFetchError): string {
  switch (error) {
    case 'service_disabled':
      return 'Google Calendar API is disabled in the GCP project — enable it in the Google Cloud console.';
    case 'scope_not_granted':
      return 'Calendar scope was not granted on the Gmail OAuth connection — user needs to reconnect.';
    case 'insufficient_permissions':
      return 'Google token is missing the calendar.readonly scope — re-prompt the user for consent.';
    case 'quota_exceeded':
      return 'Google Calendar API quota exceeded — back off and retry later.';
    case 'forbidden_unknown':
      return 'Google Calendar returned 403 with an unrecognized reason.';
    default:
      return 'Google Calendar fetch failed for a non-403 reason.';
  }
}

/**
 * Fetch calendar events from Google Calendar API for a date range.
 * Returns an `{events, error}` tuple so the caller can distinguish "no
 * meetings" from "we could not even read the calendar". An empty `events`
 * array WITHOUT an `error` means the calendar is genuinely empty.
 */
async function fetchCalendarEvents(
  userId: string,
  timeMin: string,
  timeMax: string,
): Promise<CalendarFetchResult> {
  try {
    const calendar = await getCalendarClient(userId);
    if (!calendar) {
      // No Gmail connection at all — treat as scope-not-granted so callers
      // know to surface a "connect your calendar" CTA rather than a zero.
      return { events: [], error: 'scope_not_granted' };
    }

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    const events = response.data.items || [];

    const mapped = events
      .filter(event => {
        // Skip all-day events (no dateTime) — those are not meetings
        return event.start?.dateTime && event.end?.dateTime;
      })
      .map(event => ({
        summary: event.summary || '(No title)',
        start: event.start!.dateTime!,
        end: event.end!.dateTime!,
        status: event.status || 'confirmed',
        attendees: (event.attendees || [])
          .map(a => a.email || '')
          .filter(Boolean),
      }));

    return { events: mapped };
  } catch (err: any) {
    const error = classifyCalendarError(err);
    // Log at warn so it's visible but non-fatal — the funnel still renders,
    // just with the error surfaced on the Talked stage.
    console.warn(
      `[ProspectMeeting] Calendar fetch failed [${error}]: ${describeCalendarError(error)} ` +
      `(raw: ${err?.response?.data?.error?.message || err?.message || 'n/a'})`,
    );
    return { events: [], error };
  }
}

// Exported for tests — lets __tests__ exercise the classifier without
// having to stand up a full googleapis client.
export const __calendarErrorInternals__ = {
  classifyCalendarError,
  describeCalendarError,
};

// ── Period Helpers ──────────────────────────────────────────────────────────

/** Harsha's account — has Gmail (Google Calendar) and Fathom connected for meeting detection */
const HARSHA_USER_ID = '1743956381327';

function parsePeriodDays(period: string): number {
  const match = period.match(/^(\d+)d$/);
  return match ? parseInt(match[1], 10) : 30;
}

function getDateRanges(period: string): {
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
} {
  const days = parsePeriodDays(period);
  const now = new Date();

  const end = new Date(now);
  end.setUTCHours(23, 59, 59, 999);

  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - days);
  start.setUTCHours(0, 0, 0, 0);

  const prevEnd = new Date(start);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - days);

  return {
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    previousStartDate: prevStart.toISOString(),
    previousEndDate: prevEnd.toISOString(),
  };
}

// ── Main Service ─────────────────────────────────────────────────────────────

/**
 * Get prospect meeting metrics for a given period string (e.g. "30d").
 *
 * This is the primary entry point for the funnel service's "Talked" stage.
 * It identifies prospect meetings (events with external attendees) and uses
 * Fathom transcript speaker diarization to determine if the meeting actually
 * happened (2+ speakers) or was a no-show (0-1 speakers / no recording).
 *
 * @param period - Period string like "30d", "7d", "90d"
 */
export async function getProspectMeetingMetrics(period: string): Promise<ProspectMeetingMetrics> {
  // Uses Harsha's account which has Gmail (Calendar) and Fathom connected
  const userId = HARSHA_USER_ID;
  const { startDate, endDate, previousStartDate, previousEndDate } = getDateRanges(period);

  // Track the first calendar-side error we hit so we can surface it on the
  // return value. If the main window fetch fails, later fetches will almost
  // certainly fail the same way — we keep going to exercise the Fathom path
  // for CloudWatch signal but preserve the original error classification.
  let calendarError: CalendarFetchError | undefined;

  try {
    // Fetch current period events and Fathom recordings in parallel
    const [currentFetch, fathomRecordings] = await Promise.all([
      fetchCalendarEvents(userId, startDate, endDate),
      getFathomRecordings(userId, startDate, endDate),
    ]);
    const currentEvents = currentFetch.events;
    if (currentFetch.error) calendarError = currentFetch.error;

    // Also fetch upcoming events (from now to 30 days ahead) for "booked" count
    const now = new Date();
    const thirtyDaysAhead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const upcomingFetch = await fetchCalendarEvents(
      userId,
      now.toISOString(),
      thirtyDaysAhead.toISOString(),
    );
    const upcomingEvents = upcomingFetch.events;
    if (!calendarError && upcomingFetch.error) calendarError = upcomingFetch.error;

    // Filter to prospect meetings and build results
    const meetings: ProspectMeeting[] = [];
    let noShows = 0;
    let talked = 0;
    let externalEvents = 0;
    let pastExternal = 0;
    let matched = 0;
    let transcriptOk = 0;

    for (const event of currentEvents) {
      const externalAttendees = getExternalAttendees(event.attendees);
      if (externalAttendees.length === 0) continue; // internal-only meeting
      externalEvents++;

      const temporalStatus = getTemporalStatus(event.end, event.status);

      // For past events, try to match a Fathom recording and analyze speakers
      let speakerAnalysis: { total: number; hasExternalSpeaker: boolean } | undefined;
      let recordingUrl: string | undefined;
      let recordingId: number | undefined;
      let matchedRecordingHasExternalInvitees = false;

      if (temporalStatus === 'past') {
        pastExternal++;
        const recording = findMatchingRecording(event.start, fathomRecordings);
        if (recording) {
          matched++;
          recordingUrl = recording.url;
          recordingId = recording.recordingId;
          matchedRecordingHasExternalInvitees = recording.hasExternalInvitees;
          speakerAnalysis = await analyzeSpeakers(userId, recording.recordingId);
          // Only count as "transcript ok" when we actually got diarized speaker
          // data — an empty transcript already returns `undefined` from
          // analyzeSpeakers, but guard on `total > 0` defensively so the
          // CloudWatch signal stays accurate if that invariant ever loosens.
          if (speakerAnalysis && speakerAnalysis.total > 0) transcriptOk++;
        }
      }

      const status = classifyMeetingStatus(
        temporalStatus,
        speakerAnalysis,
        matchedRecordingHasExternalInvitees,
      );
      if (status === 'no-show' || status === 'canceled') noShows++;
      if (status === 'talked') talked++;

      meetings.push({
        date: event.start,
        title: event.summary,
        attendees: externalAttendees,
        status,
        speakerCount: speakerAnalysis?.total,
        recordingUrl,
        recordingId,
        duration: getDurationMinutes(event.start, event.end),
      });
    }

    // Count upcoming prospect meetings
    const upcomingBooked = upcomingEvents.filter(event => {
      const externalAttendees = getExternalAttendees(event.attendees);
      return externalAttendees.length > 0;
    }).length;

    // Fetch previous period for comparison
    let previousPeriodMeetings = 0;
    try {
      const [previousFetch, previousRecordings] = await Promise.all([
        fetchCalendarEvents(userId, previousStartDate, previousEndDate),
        getFathomRecordings(userId, previousStartDate, previousEndDate),
      ]);
      if (!calendarError && previousFetch.error) calendarError = previousFetch.error;
      const previousEvents = previousFetch.events;

      for (const event of previousEvents) {
        const externalAttendees = getExternalAttendees(event.attendees);
        if (externalAttendees.length === 0) continue;

        const temporalStatus = getTemporalStatus(event.end, event.status);
        if (temporalStatus !== 'past') continue;

        const recording = findMatchingRecording(event.start, previousRecordings);
        const sa = recording ? await analyzeSpeakers(userId, recording.recordingId) : undefined;
        const prevStatus = classifyMeetingStatus(
          temporalStatus,
          sa,
          recording?.hasExternalInvitees,
        );
        if (prevStatus === 'talked') previousPeriodMeetings++;
      }
    } catch {
      // Non-fatal — comparison data is optional
    }

    const fathomExternal = fathomRecordings.filter(r => r.hasExternalInvitees).length;
    console.info(
      `[ProspectMeeting] period=${period} events=${currentEvents.length} ` +
      `externalEvents=${externalEvents} pastExternal=${pastExternal} ` +
      `fathomRecordings=${fathomRecordings.length} fathomExternal=${fathomExternal} ` +
      `matched=${matched} transcriptOk=${transcriptOk} talked=${talked} noShows=${noShows}`,
    );

    // De-duplicate meetings by external attendee domain → unique prospects
    const prospectMap = new Map<string, ProspectDetail>();
    for (const m of meetings) {
      for (const email of m.attendees) {
        const domain = email.split('@')[1]?.toLowerCase() || 'unknown';
        const existing = prospectMap.get(domain);
        if (existing) {
          existing.meetingCount++;
          if (m.status === 'talked') existing.talkedCount++;
          if (!existing.contacts.includes(email)) existing.contacts.push(email);
          if (m.date > existing.lastMeetingDate) existing.lastMeetingDate = m.date;
          existing.meetings.push(m);
        } else {
          prospectMap.set(domain, {
            domain,
            contacts: [email],
            meetingCount: 1,
            talkedCount: m.status === 'talked' ? 1 : 0,
            lastMeetingDate: m.date,
            meetings: [m],
          });
        }
      }
    }
    const prospects = Array.from(prospectMap.values())
      .sort((a, b) => b.lastMeetingDate.localeCompare(a.lastMeetingDate));
    const uniqueProspectsTalked = prospects.filter(p => p.talkedCount > 0).length;

    return {
      totalMeetings: talked,
      uniqueProspectsTalked,
      previousPeriodMeetings,
      upcomingBooked,
      noShows,
      meetings,
      prospects,
      ...(calendarError && { calendarError }),
    };
  } catch (err: any) {
    console.error('[ProspectMeeting] Failed to get metrics:', err?.message);
    return {
      totalMeetings: 0,
      uniqueProspectsTalked: 0,
      previousPeriodMeetings: 0,
      upcomingBooked: 0,
      noShows: 0,
      meetings: [],
      prospects: [],
      ...(calendarError && { calendarError }),
    };
  }
}
