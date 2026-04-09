/**
 * Tests for the Fathom pagination fix in prospectMeetingService.
 *
 * The bug: getFathomRecordings() fetched only page 1 of /v1/meetings,
 * silently dropping everything after the first 10 records, which zeroed
 * the "Talked" funnel stage for any user with > 10 recordings in the window.
 */
import axios from 'axios';

// Mock the connectedAccountsDb so getFathomAccessToken returns a static token.
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountByPlatform: jest.fn(),
  getAccountsByUserId: jest.fn(async () => [
    {
      platform: 'fathom',
      account_id: 'acc-1',
      config: { access_token: 'fake-token' },
    },
  ]),
  updateAccountTokens: jest.fn(),
}));

// Mock the Fathom config helper (only reached on refresh path which we don't hit)
jest.mock('../config/integrations', () => ({
  getGmailConfig: jest.fn(async () => ({
    clientId: 'x',
    clientSecret: 'y',
    redirectUri: 'z',
  })),
  getFathomConfig: jest.fn(async () => ({
    clientId: 'x',
    clientSecret: 'y',
    tokenUrl: 'http://localhost/token',
  })),
}));

jest.mock('axios');
// Cast to `any` so partial response mocks (just `{ data: ... }`) don't need
// the full AxiosXHR shape (status/statusText/headers/config) — the service
// only reads `.data`, so the extra fields would be dead weight.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedAxios = axios as any;

// Import AFTER mocks so the service picks up mocked modules.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  __test__,
  FATHOM_MAX_PAGES,
  __calendarErrorInternals__,
} = require('../services/prospectMeetingService');

describe('prospectMeetingService — Fathom pagination + fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getFathomRecordings pagination', () => {
    it('follows next_cursor across multiple pages', async () => {
      mockedAxios.get
        .mockResolvedValueOnce({
          data: {
            items: [
              { recording_id: 1, scheduled_start_time: '2026-04-01T10:00:00Z', calendar_invitees_domains_type: 'one_or_more_external' },
              { recording_id: 2, scheduled_start_time: '2026-04-01T11:00:00Z', calendar_invitees_domains_type: 'internal_only' },
            ],
            next_cursor: 'cursor-page-2',
          },
        })
        .mockResolvedValueOnce({
          data: {
            items: [
              { recording_id: 3, scheduled_start_time: '2026-04-02T10:00:00Z', calendar_invitees_domains_type: 'one_or_more_external' },
            ],
            next_cursor: 'cursor-page-3',
          },
        })
        .mockResolvedValueOnce({
          data: {
            items: [
              { recording_id: 4, scheduled_start_time: '2026-04-03T10:00:00Z', calendar_invitees_domains_type: 'one_or_more_external' },
            ],
            next_cursor: null,
          },
        });

      const recordings = await __test__.getFathomRecordings(
        'user-1',
        '2026-04-01T00:00:00Z',
        '2026-04-30T23:59:59Z',
      );

      // All three pages should have been fetched.
      expect(mockedAxios.get).toHaveBeenCalledTimes(3);
      expect(recordings).toHaveLength(4);
      expect(recordings.map((r: any) => r.recordingId)).toEqual([1, 2, 3, 4]);

      // The second call should include the cursor from page 1.
      const secondCallUrl = mockedAxios.get.mock.calls[1][0] as string;
      expect(secondCallUrl).toContain('cursor=cursor-page-2');
      const thirdCallUrl = mockedAxios.get.mock.calls[2][0] as string;
      expect(thirdCallUrl).toContain('cursor=cursor-page-3');
    });

    it('captures hasExternalInvitees from calendar_invitees_domains_type', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          items: [
            { recording_id: 1, scheduled_start_time: '2026-04-01T10:00:00Z', calendar_invitees_domains_type: 'one_or_more_external' },
            { recording_id: 2, scheduled_start_time: '2026-04-01T11:00:00Z', calendar_invitees_domains_type: 'internal_only' },
            { recording_id: 3, scheduled_start_time: '2026-04-01T12:00:00Z' /* missing */ },
          ],
        },
      });

      const recordings = await __test__.getFathomRecordings(
        'user-1',
        '2026-04-01T00:00:00Z',
        '2026-04-02T00:00:00Z',
      );

      expect(recordings[0].hasExternalInvitees).toBe(true);
      expect(recordings[1].hasExternalInvitees).toBe(false);
      expect(recordings[2].hasExternalInvitees).toBe(false);
    });

    it('respects FATHOM_MAX_PAGES cap', async () => {
      // Every response says "there is another page" — the loop must stop
      // at FATHOM_MAX_PAGES and not hammer Fathom forever.
      mockedAxios.get.mockResolvedValue({
        data: {
          items: [
            { recording_id: 1, scheduled_start_time: '2026-04-01T10:00:00Z' },
          ],
          next_cursor: 'never-ending',
        },
      });

      const recordings = await __test__.getFathomRecordings(
        'user-1',
        '2026-04-01T00:00:00Z',
        '2026-04-30T23:59:59Z',
      );

      expect(mockedAxios.get).toHaveBeenCalledTimes(FATHOM_MAX_PAGES);
      expect(recordings).toHaveLength(FATHOM_MAX_PAGES);
    });

    it('returns an empty array and swallows Fathom errors (non-fatal)', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('boom'));

      const recordings = await __test__.getFathomRecordings(
        'user-1',
        '2026-04-01T00:00:00Z',
        '2026-04-02T00:00:00Z',
      );

      expect(recordings).toEqual([]);
    });
  });

  describe('classifyMeetingStatus fallback', () => {
    const { classifyMeetingStatus } = __test__;

    it('returns "talked" when transcript has an external speaker', () => {
      const result = classifyMeetingStatus(
        'past',
        { total: 2, hasExternalSpeaker: true },
        false,
      );
      expect(result).toBe('talked');
    });

    it('returns "talked" when transcript is unavailable but Fathom shows external invitees', () => {
      const result = classifyMeetingStatus('past', undefined, true);
      expect(result).toBe('talked');
    });

    it('returns "no-show" when transcript is unavailable and no external invitees', () => {
      const result = classifyMeetingStatus('past', undefined, false);
      expect(result).toBe('no-show');
    });

    it('returns "no-show" when transcript has only internal speakers (ignores fallback)', () => {
      // If we actually analyzed the transcript and everyone was internal,
      // trust the transcript over the calendar-invitees heuristic.
      const result = classifyMeetingStatus(
        'past',
        { total: 2, hasExternalSpeaker: false },
        true,
      );
      expect(result).toBe('no-show');
    });

    it('returns "upcoming" for future events regardless of fallback', () => {
      const result = classifyMeetingStatus('upcoming', undefined, true);
      expect(result).toBe('upcoming');
    });

    it('returns "canceled" for canceled events', () => {
      const result = classifyMeetingStatus('canceled', undefined, true);
      expect(result).toBe('canceled');
    });
  });

  describe('analyzeSpeakers empty-transcript handling', () => {
    const { analyzeSpeakers, classifyMeetingStatus } = __test__;

    it('returns undefined when Fathom responds 200 with an empty transcript', async () => {
      // Fresh recording — Fathom returns HTTP 200 but the transcript array is
      // empty because diarization hasn't run yet. Must be treated as "unknown"
      // (undefined), NOT as `{ total: 0, hasExternalSpeaker: false }`, so the
      // calendar-invitees fallback in classifyMeetingStatus can fire.
      mockedAxios.get.mockResolvedValueOnce({ data: { transcript: [] } });

      const result = await analyzeSpeakers('user-1', 12345);
      expect(result).toBeUndefined();
    });

    it('end-to-end: empty transcript + external invitees → "talked"', async () => {
      // This is the exact bug the PR was supposed to fix: a fresh recording
      // with no diarized transcript yet, but Fathom's listing confirms the
      // meeting had external invitees. Previously this bucketed as no-show.
      mockedAxios.get.mockResolvedValueOnce({ data: { transcript: [] } });

      const speakerAnalysis = await analyzeSpeakers('user-1', 12345);
      const status = classifyMeetingStatus(
        'past',
        speakerAnalysis,
        true, // fathomHasExternalInvitees
      );

      expect(speakerAnalysis).toBeUndefined();
      expect(status).toBe('talked');
    });

    it('classifyCalendarError: SERVICE_DISABLED is recognized from error status', () => {
      const err = {
        response: {
          status: 403,
          data: {
            error: {
              status: 'PERMISSION_DENIED',
              message: 'Google Calendar API has not been used in project 123 before or it is disabled.',
              errors: [{ reason: 'accessNotConfigured' }],
            },
          },
        },
      };
      expect(__calendarErrorInternals__.classifyCalendarError(err)).toBe('service_disabled');
    });

    it('classifyCalendarError: quotaExceeded is recognized', () => {
      const err = {
        response: {
          status: 403,
          data: { error: { errors: [{ reason: 'quotaExceeded' }] } },
        },
      };
      expect(__calendarErrorInternals__.classifyCalendarError(err)).toBe('quota_exceeded');
    });

    it('classifyCalendarError: insufficientPermissions is distinct from scope_not_granted', () => {
      const err = {
        response: {
          status: 403,
          data: { error: { errors: [{ reason: 'insufficientPermissions' }] } },
        },
      };
      expect(__calendarErrorInternals__.classifyCalendarError(err)).toBe('insufficient_permissions');
    });

    it('classifyCalendarError: generic 403 with scope mention → scope_not_granted', () => {
      const err = {
        response: {
          status: 403,
          data: { error: { message: 'Request had insufficient authentication scopes.' } },
        },
      };
      expect(__calendarErrorInternals__.classifyCalendarError(err)).toBe('scope_not_granted');
    });

    it('classifyCalendarError: unrecognized 403 → forbidden_unknown', () => {
      const err = {
        response: { status: 403, data: { error: { message: 'something weird' } } },
      };
      expect(__calendarErrorInternals__.classifyCalendarError(err)).toBe('forbidden_unknown');
    });

    it('classifyCalendarError: non-403 errors → unknown', () => {
      expect(__calendarErrorInternals__.classifyCalendarError({ code: 500 })).toBe('unknown');
      expect(__calendarErrorInternals__.classifyCalendarError(new Error('ETIMEDOUT'))).toBe('unknown');
    });

    it('describeCalendarError returns a message for every classification', () => {
      for (const err of [
        'service_disabled',
        'scope_not_granted',
        'insufficient_permissions',
        'quota_exceeded',
        'forbidden_unknown',
        'unknown',
      ]) {
        const msg = __calendarErrorInternals__.describeCalendarError(err);
        expect(typeof msg).toBe('string');
        expect(msg.length).toBeGreaterThan(10);
      }
    });

    it('still returns a populated analysis when the transcript has speakers', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          transcript: [
            { speaker: 'Harsha Vankayalapati' },
            { speaker: 'Jane Prospect' },
            { speaker: 'Harsha Vankayalapati' },
          ],
        },
      });

      const result = await analyzeSpeakers('user-1', 12345);
      expect(result).toBeDefined();
      expect(result!.total).toBe(2);
      // Note: hasExternalSpeaker depends on isInternalSpeaker heuristics;
      // the key assertion is that total > 0 so the fallback path is skipped.
      expect(result!.total).toBeGreaterThan(0);
    });
  });
});
