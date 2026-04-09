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
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Import AFTER mocks so the service picks up mocked modules.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __test__, FATHOM_MAX_PAGES } = require('../services/prospectMeetingService');

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
});
