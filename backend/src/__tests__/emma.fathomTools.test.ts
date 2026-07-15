/**
 * Tests for Fathom meeting tools (fathom_get_meetings, fathom_get_transcript)
 * registered on the emmaToolRegistry.
 */

// Mock axios before any imports
jest.mock('axios');

// Mock connectedAccountsDb
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  updateAccountConfig: jest.fn(),
}));

// Mock integrations config
jest.mock('../config/integrations', () => ({
  getFathomConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3001/api/oauth/fathom/callback',
    scopes: ['public_api'],
    authorizationUrl: 'https://fathom.ai/oauth/authorize',
    tokenUrl: 'https://api.fathom.ai/external/v1/oauth2/token',
  }),
}));

import axios from 'axios';
import { emmaToolRegistry } from '../emma/registry';

// Import tools to register them
import '../emma/fathomTools';

import { getAccountsByUserId } from '../services/connectedAccountsDb';
import { userDb } from '../services/db';

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedGetAccounts = getAccountsByUserId as jest.MockedFunction<typeof getAccountsByUserId>;

// Helper to execute a registered tool
const executeTool = async (name: string, args: any, context: any = {}) => {
  const tool = emmaToolRegistry.getTool(name);
  if (!tool) throw new Error(`Tool "${name}" not found in registry`);
  return tool.execute(args, context);
};

const makeFathomAccount = (apiKey: string = 'test-fathom-key') => ({
  platform: 'fathom' as any,
  account_id: 'fathom-123',
  account_name: 'My Fathom',
  config: {
    access_token: apiKey,
    token_expires_at: Date.now() + 999999999,
    account_type: 'api_key' as const,
  },
  created_at: '2026-03-15T00:00:00Z',
  updated_at: '2026-03-15T00:00:00Z',
});

describe('fathom_get_meetings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should be registered in emmaToolRegistry', () => {
    expect(emmaToolRegistry.getTool('fathom_get_meetings')).toBeDefined();
  });

  it('returns formatted meeting list from Fathom API', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: [
        {
          id: 1,
          recording_id: 101,
          title: 'Sprint Planning',
          created_at: '2026-03-15T10:00:00Z',
          duration_seconds: 1800,
          participants: ['Alice', 'Bob'],
          summary: 'Discussed Q2 roadmap priorities.',
          action_items: [
            { text: 'Alice to update backlog' },
            { text: 'Bob to review PRs' },
          ],
        },
        {
          id: 2,
          recording_id: 102,
          title: '1:1 with Manager',
          created_at: '2026-03-14T14:00:00Z',
          duration_seconds: 900,
          participants: ['Alice', 'Charlie'],
          summary: 'Reviewed performance goals.',
          action_items: [],
        },
      ],
    });

    const result = await executeTool('fathom_get_meetings', { limit: 10 }, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.meetings).toHaveLength(2);
    expect(result.meetings[0].title).toBe('Sprint Planning');
    expect(result.meetings[0].recording_id).toBe(101);
    expect(result.meetings[0].action_items_count).toBe(2);
    expect(result.meetings[1].title).toBe('1:1 with Manager');
    expect(result.meetings[1].action_items_count).toBe(0);

    // Verify API call
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.fathom.ai/external/v1/meetings'),
      expect.objectContaining({
        headers: { 'Authorization': 'Bearer test-fathom-key' },
      })
    );
  });

  it('follows next_cursor pagination and aggregates all pages', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);
    // Page 1 returns 2 meetings + a cursor; page 2 returns 1 meeting + no cursor.
    mockedAxios.get = jest.fn()
      .mockResolvedValueOnce({
        data: {
          items: [
            { recording_id: 201, title: 'Meeting A', created_at: '2026-03-15T10:00:00Z' },
            { recording_id: 202, title: 'Meeting B', created_at: '2026-03-15T11:00:00Z' },
          ],
          next_cursor: 'CURSOR_PAGE_2',
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            { recording_id: 203, title: 'Florence Sync', created_at: '2026-03-16T09:00:00Z' },
          ],
          next_cursor: null,
        },
      });

    const result = await executeTool('fathom_get_meetings', {}, { userId: 'user-1' });

    expect(result.success).toBe(true);
    // All three meetings across both pages must be present — not just the first page.
    expect(result.meetings).toHaveLength(3);
    expect(result.count).toBe(3);
    const titles = result.meetings.map((m: any) => m.title);
    expect(titles).toContain('Florence Sync');

    // Two HTTP calls: initial page + cursor-followed page.
    expect((mockedAxios.get as jest.Mock)).toHaveBeenCalledTimes(2);
    const secondCallUrl = (mockedAxios.get as jest.Mock).mock.calls[1][0];
    expect(secondCallUrl).toContain('cursor=CURSOR_PAGE_2');
  });

  it('reproduces the reported bug: finds people whose meetings are past page 1', async () => {
    // Regression for the "cross-reference who we met last week" bug: Florence
    // and Susthmia's meetings sat on page 2, so the first-page-only tool
    // reported it "could not find" them. With cursor following they surface.
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);
    const page1 = Array.from({ length: 10 }, (_, i) => ({
      recording_id: 1000 + i,
      title: `Internal Standup ${i + 1}`,
      created_at: '2026-06-16T10:00:00Z',
      calendar_invitees: [{ name: 'Rui', email: 'rui@agentweb.pro' }],
    }));
    const page2 = [
      { recording_id: 2001, title: 'Florence Intro Call', created_at: '2026-06-17T15:00:00Z',
        calendar_invitees: [{ name: 'Florence', email: 'florence@acme.com' }] },
      { recording_id: 2002, title: 'Susthmia Discovery', created_at: '2026-06-18T16:00:00Z',
        calendar_invitees: [{ name: 'Susthmia', email: 'susthmia@beta.io' }] },
    ];
    mockedAxios.get = jest.fn()
      .mockResolvedValueOnce({ data: { items: page1, next_cursor: 'PAGE2' } })
      .mockResolvedValueOnce({ data: { items: page2, next_cursor: null } });

    const result = await executeTool(
      'fathom_get_meetings',
      { created_after: '2026-06-15T00:00:00Z', created_before: '2026-06-22T00:00:00Z' },
      { userId: 'user-1' },
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(12);
    const everyone = result.meetings.flatMap((m: any) => m.participants);
    expect(everyone).toContain('Florence');
    expect(everyone).toContain('Susthmia');
  });

  it('stops paginating at the page cap to avoid runaway loops', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);
    // Always return a cursor — the cap must break the loop.
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: {
        items: [{ recording_id: 1, title: 'Loop', created_at: '2026-03-15T10:00:00Z' }],
        next_cursor: 'NEVER_ENDING',
      },
    });

    const result = await executeTool('fathom_get_meetings', {}, { userId: 'user-1' });

    expect(result.success).toBe(true);
    // Must not exceed the safety cap of HTTP calls.
    expect((mockedAxios.get as jest.Mock).mock.calls.length).toBeLessThanOrEqual(20);
  });

  it('passes date filters to the API', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);
    mockedAxios.get = jest.fn().mockResolvedValue({ data: [] });

    await executeTool(
      'fathom_get_meetings',
      { created_after: '2026-03-01T00:00:00Z', created_before: '2026-03-15T00:00:00Z' },
      { userId: 'user-1' }
    );

    const callUrl = (mockedAxios.get as jest.Mock).mock.calls[0][0];
    expect(callUrl).toContain('created_after=2026-03-01T00%3A00%3A00Z');
    expect(callUrl).toContain('created_before=2026-03-15T00%3A00%3A00Z');
    expect(callUrl).not.toContain('limit=');
    expect(callUrl).not.toContain('include_summary');
  });

  it('returns helpful error when no Fathom account is connected', async () => {
    mockedGetAccounts.mockResolvedValue([]);

    const result = await executeTool('fathom_get_meetings', {}, { userId: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('connect your Fathom account');
  });

  it('returns error when userId is missing', async () => {
    const result = await executeTool('fathom_get_meetings', {}, {});

    expect(result.success).toBe(false);
    expect(result.message).toContain('Authentication required');
  });

  it('handles Fathom API errors gracefully', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);
    mockedAxios.get = jest.fn().mockRejectedValue(new Error('Network Error'));

    const result = await executeTool('fathom_get_meetings', {}, { userId: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to fetch meetings');
  });

  it('returns reconnect message when token is invalid (401)', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);
    mockedAxios.get = jest.fn().mockRejectedValue({
      response: { status: 401 },
      message: 'Request failed with status code 401',
    });

    const result = await executeTool('fathom_get_meetings', {}, { userId: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('reconnect');
  });
});

describe('fathom_get_transcript', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should be registered in emmaToolRegistry', () => {
    expect(emmaToolRegistry.getTool('fathom_get_transcript')).toBeDefined();
  });

  it('returns formatted transcript for a valid recording', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: {
        transcript: [
          { speaker: 'Alice', text: 'Let me walk through the roadmap.', start_time: 0 },
          { speaker: 'Bob', text: 'Sounds good, go ahead.', start_time: 5.2 },
          { speaker: 'Alice', text: 'First priority is the landing page builder.', start_time: 8.1 },
        ],
      },
    });

    const result = await executeTool('fathom_get_transcript', { recording_id: 101 }, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.transcript).toHaveLength(3);
    expect(result.transcript[0].speaker).toBe('Alice');
    expect(result.transcript[0].text).toBe('Let me walk through the roadmap.');

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.fathom.ai/external/v1/recordings/101/transcript',
      expect.objectContaining({
        headers: { 'Authorization': 'Bearer test-fathom-key' },
      })
    );
  });

  it('returns error for invalid/not-found recording_id', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);
    mockedAxios.get = jest.fn().mockRejectedValue({
      response: { status: 404, data: { error: 'Recording not found' } },
      message: 'Request failed with status code 404',
    });

    const result = await executeTool('fathom_get_transcript', { recording_id: 99999 }, { userId: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('returns helpful error when no Fathom account is connected', async () => {
    mockedGetAccounts.mockResolvedValue([]);

    const result = await executeTool('fathom_get_transcript', { recording_id: 101 }, { userId: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('connect your Fathom account');
  });

  it('returns error when recording_id is missing', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);

    const result = await executeTool('fathom_get_transcript', {}, { userId: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('recording_id is required');
  });

  it('handles Fathom API errors gracefully', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);
    mockedAxios.get = jest.fn().mockRejectedValue(new Error('Network Error'));

    const result = await executeTool('fathom_get_transcript', { recording_id: 101 }, { userId: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to fetch transcript');
  });

  it('returns reconnect message when token is invalid (401)', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);
    mockedAxios.get = jest.fn().mockRejectedValue({
      response: { status: 401 },
      message: 'Request failed with status code 401',
    });

    const result = await executeTool('fathom_get_transcript', { recording_id: 101 }, { userId: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('reconnect');
  });
});

describe('fathom_get_onboarding_context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should be registered in emmaToolRegistry', () => {
    expect(emmaToolRegistry.getTool('fathom_get_onboarding_context')).toBeDefined();
  });

  it('returns only reviewed Fathom onboarding contexts for the current account', async () => {
    jest.spyOn(userDb, 'getUserById').mockResolvedValueOnce({
      userId: 'user-1',
      email: 'owner@acme.ai',
      fathomOnboardingIngestions: [
        {
          recordingId: '123',
          recordingUrl: 'https://fathom.video/calls/123',
          status: 'reviewed',
          extractionState: 'human_reviewed',
          updatedAt: '2026-07-08T20:00:00.000Z',
          matchReason: 'manual_target_user',
          context: { companyName: 'Acme AI', primaryGtmGoal: 'Book qualified demos' },
        },
        {
          recordingId: '456',
          status: 'needs_review',
          extractionState: 'auto_extracted',
          context: { companyName: 'Draft Co' },
        },
      ],
    } as any);

    const result = await executeTool('fathom_get_onboarding_context', {}, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.contexts).toEqual([
      expect.objectContaining({
        recordingId: '123',
        extractionState: 'human_reviewed',
        context: expect.objectContaining({ companyName: 'Acme AI' }),
      }),
    ]);
  });

  it('requires user context', async () => {
    const result = await executeTool('fathom_get_onboarding_context', {}, {});

    expect(result.success).toBe(false);
    expect(result.message).toContain('Authentication required');
  });
});
