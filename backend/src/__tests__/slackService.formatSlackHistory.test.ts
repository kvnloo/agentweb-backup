/**
 * Tests for formatSlackHistoryAsContext in slackService.
 * Uses jest.isolateModules so SLACK_BOT_TOKEN is set before the module initializes.
 */

const mockHistoryConversationsHistory = jest.fn();
const mockHistoryConversationsInfo = jest.fn();
const mockHistoryUsersInfo = jest.fn();
const mockCallLLM = jest.fn();

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    conversations: {
      history: mockHistoryConversationsHistory,
      info: mockHistoryConversationsInfo,
    },
    users: { info: mockHistoryUsersInfo },
  })),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: mockCallLLM,
  },
}));

describe('formatSlackHistoryAsContext', () => {
  let formatSlackHistoryAsContext: (channelId: string, limit?: number) => Promise<string>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockHistoryConversationsInfo.mockResolvedValue({
      ok: true,
      channel: { name: 'general' },
    });
    mockCallLLM.mockResolvedValue({
      choices: [{ message: { content: 'Summary of the Slack conversation.' } }],
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

  it('defaults to fetching the last 10 messages', async () => {
    mockHistoryConversationsHistory.mockResolvedValue({ ok: true, messages: [] });
    await formatSlackHistoryAsContext('C12345');
    expect(mockHistoryConversationsHistory).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 })
    );
  });

  it('passes a custom limit parameter to conversations.history', async () => {
    mockHistoryConversationsHistory.mockResolvedValue({ ok: true, messages: [] });
    await formatSlackHistoryAsContext('C12345', 5);
    expect(mockHistoryConversationsHistory).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C12345', limit: 5 })
    );
  });

  it('calls Gemini Flash Lite to summarize the transcript', async () => {
    mockHistoryConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
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

    // Should have called the LLM with the transcript
    expect(mockCallLLM).toHaveBeenCalledWith(
      'gemini-3.1-flash-lite-preview',
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user', content: expect.stringContaining('Harsha: Here is the pipeline update') }),
      ]),
      expect.objectContaining({ temperature: 0 })
    );

    // Result should contain the Gemini summary, not raw timestamps
    expect(result).toContain('Summary of the Slack conversation.');
    expect(result).toContain('#general');
  });

  it('includes display names (oldest first) in the transcript sent to LLM', async () => {
    mockHistoryConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        // Slack returns newest-first; function reverses to oldest-first
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

    await formatSlackHistoryAsContext('C12345');

    const llmCall = mockCallLLM.mock.calls[0];
    const userMessage = llmCall[1].find((m: any) => m.role === 'user').content as string;
    // Oldest message (Harsha) should appear before newest (Rui)
    expect(userMessage.indexOf('Harsha')).toBeLessThan(userMessage.indexOf('Rui'));
  });

  it('falls back to raw transcript when Gemini summarization fails', async () => {
    mockHistoryConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        { ts: '1746056000.000000', user: 'U111', text: 'Hello world' },
      ],
    });
    mockHistoryUsersInfo.mockResolvedValue({
      ok: true,
      user: { profile: { display_name: 'Alice', real_name: 'Alice' }, real_name: 'Alice' },
    });
    mockCallLLM.mockRejectedValue(new Error('LLM unavailable'));

    const result = await formatSlackHistoryAsContext('C12345');
    // Falls back to raw transcript
    expect(result).toContain('Alice: Hello world');
    expect(result).toContain('#general');
  });

  it('normalizes mailto Slack links in message text before summarizing', async () => {
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

    await formatSlackHistoryAsContext('C12345');

    const llmCall = mockCallLLM.mock.calls[0];
    const userMessage = llmCall[1].find((m: any) => m.role === 'user').content as string;
    expect(userMessage).toContain('test@example.com for details');
    expect(userMessage).not.toContain('<mailto:');
  });

  it('returns empty string when conversations.history throws', async () => {
    mockHistoryConversationsHistory.mockRejectedValue(new Error('Slack API error'));
    const result = await formatSlackHistoryAsContext('C12345');
    expect(result).toBe('');
  });

  it('gracefully continues when conversations.info fails (falls back to channel ID in output)', async () => {
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
    expect(result).toContain('Summary of the Slack conversation.');
  });
});
