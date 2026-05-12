/**
 * Tests for formatSlackHistoryAsContext in slackService.
 * The function looks up the user's most recent prior slack-bot session and returns
 * its already-computed sessionSummary as context. No Slack API or LLM calls needed.
 */

const mockGetUserSessions = jest.fn();

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getUserSessions: mockGetUserSessions,
  },
}));

// Slack web-api mock still needed because slackService imports WebClient at module level
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({})),
}));

describe('formatSlackHistoryAsContext', () => {
  let formatSlackHistoryAsContext: (userId: string) => Promise<string>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.isolateModules(() => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      formatSlackHistoryAsContext = require('../services/slackService').formatSlackHistoryAsContext;
    });
  });

  it('returns empty string when user has no prior sessions', async () => {
    mockGetUserSessions.mockResolvedValue({ sessions: [] });
    const result = await formatSlackHistoryAsContext('user-123');
    expect(result).toBe('');
  });

  it('returns empty string when prior session has no sessionSummary', async () => {
    mockGetUserSessions.mockResolvedValue({
      sessions: [{ sessionId: 'sess-1', userId: 'user-123', title: 'Old task' }],
    });
    const result = await formatSlackHistoryAsContext('user-123');
    expect(result).toBe('');
  });

  it('returns formatted context string from sessionSummary when available', async () => {
    mockGetUserSessions.mockResolvedValue({
      sessions: [{
        sessionId: 'sess-1',
        userId: 'user-123',
        title: 'Pipeline review',
        sessionSummary: {
          summary: 'Reviewed Q2 pipeline with Harsha. Identified 3 high-priority prospects.',
          evaluatedAt: '2026-05-10T10:00:00.000Z',
          evaluatedMessageIndex: 5,
        },
      }],
    });

    const result = await formatSlackHistoryAsContext('user-123');
    expect(result).toContain('Pipeline review');
    expect(result).toContain('Reviewed Q2 pipeline with Harsha. Identified 3 high-priority prospects.');
    expect(result).toContain('most recent previous AgentWeb session');
  });

  it('queries for the most recent agent/slack-bot session (limit 1, descending)', async () => {
    mockGetUserSessions.mockResolvedValue({ sessions: [] });
    await formatSlackHistoryAsContext('user-456');
    expect(mockGetUserSessions).toHaveBeenCalledWith(
      'user-456',
      'agent',
      1,
      true,
      undefined,
      'slack-bot'
    );
  });

  it('omits title from output when prior session has no title', async () => {
    mockGetUserSessions.mockResolvedValue({
      sessions: [{
        sessionId: 'sess-2',
        userId: 'user-123',
        sessionSummary: {
          summary: 'Updated CRM records.',
          evaluatedAt: '2026-05-10T10:00:00.000Z',
          evaluatedMessageIndex: 3,
        },
      }],
    });

    const result = await formatSlackHistoryAsContext('user-123');
    expect(result).toContain('Updated CRM records.');
    // No title in parentheses
    expect(result).not.toContain('(\"');
  });

  it('returns empty string when getUserSessions throws', async () => {
    mockGetUserSessions.mockRejectedValue(new Error('DynamoDB error'));
    const result = await formatSlackHistoryAsContext('user-123');
    expect(result).toBe('');
  });
});
