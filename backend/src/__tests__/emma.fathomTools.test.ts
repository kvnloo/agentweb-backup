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
    mockedAxios.get = jest.fn().mockRejectedValue(new Error('Request failed with status code 401'));

    const result = await executeTool('fathom_get_meetings', {}, { userId: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to fetch meetings');
  });
});

// ── Pagination tests ──────────────────────────────────────────────────────────

describe('fathom_get_meetings — pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const makeMeeting = (id: number) => ({
    recording_id: id,
    title: `Meeting ${id}`,
    url: `https://fathom.ai/m/${id}`,
    created_at: `2026-03-${String(id).padStart(2, '0')}T10:00:00Z`,
    scheduled_start_time: `2026-03-${String(id).padStart(2, '0')}T10:00:00Z`,
    recording_start_time: `2026-03-${String(id).padStart(2, '0')}T10:00:00Z`,
    recording_end_time: `2026-03-${String(id).padStart(2, '0')}T10:30:00Z`,
    recorded_by: { name: 'Tester' },
    calendar_invitees: [{ name: 'Alice' }],
    default_summary: { short_hand_bullet: `Summary ${id}` },
    action_items: [{ text: `Action ${id}` }],
  });

  it('single-page response (no next_cursor) returns all items', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: {
        items: [makeMeeting(1), makeMeeting(2), makeMeeting(3)],
        limit: 10,
      },
    });

    const result = await executeTool('fathom_get_meetings', {}, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(3);
    expect(result.meetings).toHaveLength(3);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('multi-page response follows next_cursor and returns all items', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);

    const page1Items = Array.from({ length: 10 }, (_, i) => makeMeeting(i + 1));
    const page2Items = Array.from({ length: 10 }, (_, i) => makeMeeting(i + 11));
    const page3Items = Array.from({ length: 10 }, (_, i) => makeMeeting(i + 21));

    mockedAxios.get = jest.fn()
      .mockResolvedValueOnce({
        data: { items: page1Items, limit: 10, next_cursor: 'cursor_page2' },
      })
      .mockResolvedValueOnce({
        data: { items: page2Items, limit: 10, next_cursor: 'cursor_page3' },
      })
      .mockResolvedValueOnce({
        data: { items: page3Items, limit: 10 },
      });

    const result = await executeTool('fathom_get_meetings', {}, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(30);
    expect(result.meetings).toHaveLength(30);
    expect(mockedAxios.get).toHaveBeenCalledTimes(3);

    // Verify cursor is passed on subsequent requests
    const call2Url = (mockedAxios.get as jest.Mock).mock.calls[1][0];
    expect(call2Url).toContain('cursor=cursor_page2');
    const call3Url = (mockedAxios.get as jest.Mock).mock.calls[2][0];
    expect(call3Url).toContain('cursor=cursor_page3');
  });

  it('stops at FATHOM_TOOLS_MAX_PAGES safety cap', async () => {
    const { FATHOM_TOOLS_MAX_PAGES } = require('../emma/fathomTools');

    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);

    // Every page returns a cursor, forcing infinite pagination
    mockedAxios.get = jest.fn().mockImplementation(() =>
      Promise.resolve({
        data: {
          items: [makeMeeting(1)],
          limit: 10,
          next_cursor: 'infinite_cursor',
        },
      })
    );

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await executeTool('fathom_get_meetings', {}, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(FATHOM_TOOLS_MAX_PAGES);
    expect(mockedAxios.get).toHaveBeenCalledTimes(FATHOM_TOOLS_MAX_PAGES);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('FATHOM_TOOLS_MAX_PAGES')
    );

    warnSpy.mockRestore();
  });

  it('empty response returns empty array without infinite loop', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: { items: [], limit: 10 },
    });

    const result = await executeTool('fathom_get_meetings', {}, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
    expect(result.meetings).toHaveLength(0);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('terminates cleanly when next_cursor is null or undefined', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);

    // next_cursor: null should stop pagination
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: {
        items: [makeMeeting(1)],
        limit: 10,
        next_cursor: null,
      },
    });

    const result = await executeTool('fathom_get_meetings', {}, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('terminates cleanly when next_cursor is empty string', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);

    mockedAxios.get = jest.fn().mockResolvedValue({
      data: {
        items: [makeMeeting(1)],
        limit: 10,
        next_cursor: '',
      },
    });

    const result = await executeTool('fathom_get_meetings', {}, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('network error returns failure with error message', async () => {
    mockedGetAccounts.mockResolvedValue([makeFathomAccount()] as any);
    mockedAxios.get = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await executeTool('fathom_get_meetings', {}, { userId: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to fetch meetings');
    expect(result.message).toContain('ECONNREFUSED');
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
});
