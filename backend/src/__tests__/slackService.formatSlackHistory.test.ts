/**
 * Tests for formatSlackHistoryAsContext in slackService.
 * Uses jest.isolateModules so SLACK_BOT_TOKEN is set before the module initializes.
 */

const mockHistoryConversationsHistory = jest.fn();
const mockHistoryConversationsInfo = jest.fn();
const mockHistoryUsersInfo = jest.fn();

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    conversations: {
      history: mockHistoryConversationsHistory,
      info: mockHistoryConversationsInfo,
    },
    users: { info: mockHistoryUsersInfo },
  })),
}));

describe('formatSlackHistoryAsContext', () => {
  let formatSlackHistoryAsContext: (channelId: string, limit?: number) => Promise<string>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockHistoryConversationsInfo.mockResolvedValue({
      ok: true,
      channel: { name: 'general' },
    });
    jest.isolateModules(() => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      formatSlackHistoryAsContext = require('../services/slackService').formatSlackHistoryAsContext;
    });
  });

  it('returns empty string when Slack client is not initialized', async () => {
    let fn: (channelId: string) => Promise<string>;
    jest.isolateModules(() => {
      delete process.env.SLACK_BOT_TOKEN;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      fn = require('../services/slackService').formatSlackHistoryAsContext;
    });
    const result = await fn!('C12345');
    expect(result).toBe('');
  });

  it('returns empty string when channel has no messages', async () => {
    mockHistoryConversationsHistory.mockResolvedValue({ ok: true, messages: [] });
    const result = await formatSlackHistoryAsContext('C12345');
    expect(result).toBe('');
  });

  it('formats messages with channel name, timestamps, and display names', async () => {
    mockHistoryConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        // Slack returns newest-first; the function reverses to oldest-first
        { ts: '1746057000.000000', user: 'U222', text: 'Thanks!' },
        { ts: '1746056000.000000', user: 'U111', text: 'Here is the pipeline update' },
      ],
    });
    mockHistoryUsersInfo.mockImplementation(({ user }: { user: string }) => {
      const names: Record<string, string> = { U111: 'Harsha', U222: 'Rui' };
      return Promise.resolve({
        ok: true,
        user: {
          profile: { display_name: names[user] ?? user, real_name: names[user] ?? user },
          real_name: names[user] ?? user,
        },
      });
    });

    const result = await formatSlackHistoryAsContext('C12345');

    expect(result).toContain('Slack channel conversation history for #general:');
    // Oldest message first
    expect(result.indexOf('Harsha')).toBeLessThan(result.indexOf('Rui'));
    expect(result).toContain('Harsha: Here is the pipeline update');
    expect(result).toContain('Rui: Thanks!');
  });

  it('passes the limit parameter to conversations.history', async () => {
    mockHistoryConversationsHistory.mockResolvedValue({ ok: true, messages: [] });
    await formatSlackHistoryAsContext('C12345', 25);
    expect(mockHistoryConversationsHistory).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C12345', limit: 25 })
    );
  });

  it('defaults to limit 50', async () => {
    mockHistoryConversationsHistory.mockResolvedValue({ ok: true, messages: [] });
    await formatSlackHistoryAsContext('C12345');
    expect(mockHistoryConversationsHistory).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 })
    );
  });

  it('normalizes mailto Slack links in message text', async () => {
    mockHistoryConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        { ts: '1746056000.000000', user: 'U111', text: 'Contact <mailto:test@example.com|test@example.com> for details' },
      ],
    });
    mockHistoryUsersInfo.mockResolvedValue({
      ok: true,
      user: { profile: { display_name: 'Alice', real_name: 'Alice' }, real_name: 'Alice' },
    });

    const result = await formatSlackHistoryAsContext('C12345');
    expect(result).toContain('test@example.com for details');
    expect(result).not.toContain('<mailto:');
  });

  it('returns empty string when conversations.history throws', async () => {
    mockHistoryConversationsHistory.mockRejectedValue(new Error('Slack API error'));
    const result = await formatSlackHistoryAsContext('C12345');
    expect(result).toBe('');
  });

  it('gracefully continues when conversations.info fails (falls back to channel ID)', async () => {
    mockHistoryConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        { ts: '1746056000.000000', user: 'U111', text: 'Hello' },
      ],
    });
    mockHistoryConversationsInfo.mockRejectedValue(new Error('no channel info'));
    mockHistoryUsersInfo.mockResolvedValue({
      ok: true,
      user: { profile: { display_name: 'Bob', real_name: 'Bob' }, real_name: 'Bob' },
    });

    const result = await formatSlackHistoryAsContext('C99999');
    // Falls back to channel ID when name lookup fails
    expect(result).toContain('C99999');
    expect(result).toContain('Bob: Hello');
  });
});
