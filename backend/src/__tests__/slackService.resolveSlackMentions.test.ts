/**
 * Tests for resolveSlackMentionsInText in slackService.
 * Uses jest.isolateModules so SLACK_BOT_TOKEN is set before the module initializes.
 */

const mockUsersInfo = jest.fn();

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    users: { info: mockUsersInfo },
  })),
}));

describe('resolveSlackMentionsInText', () => {
  let resolveSlackMentionsInText: (text: string) => Promise<string>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Load the module fresh each test so the displayNameCache is empty
    jest.isolateModules(() => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      resolveSlackMentionsInText = require('../services/slackService').resolveSlackMentionsInText;
    });
  });

  it('returns text unchanged when there are no user mentions', async () => {
    const text = 'Hello, can you help me schedule a meeting?';
    const result = await resolveSlackMentionsInText(text);
    expect(result).toBe(text);
  });

  it('resolves a single user mention to display name', async () => {
    mockUsersInfo.mockResolvedValue({
      ok: true,
      user: { profile: { display_name: 'Fangfang Li', real_name: 'Fangfang Li' }, real_name: 'Fangfang Li' },
    });

    const result = await resolveSlackMentionsInText('<@U0B0XGBEDT> is available Thursday');
    expect(result).toBe('@Fangfang Li is available Thursday');
  });

  it('resolves multiple distinct user mentions', async () => {
    mockUsersInfo.mockImplementation(({ user }: { user: string }) => {
      const names: Record<string, string> = { U111: 'Alice', U222: 'Bob' };
      return Promise.resolve({
        ok: true,
        user: { profile: { display_name: names[user] ?? user, real_name: names[user] ?? user }, real_name: names[user] ?? user },
      });
    });

    const result = await resolveSlackMentionsInText('<@U111> and <@U222> will both join');
    expect(result).toBe('@Alice and @Bob will both join');
  });

  it('deduplicates API calls for repeated mentions of the same user', async () => {
    mockUsersInfo.mockResolvedValue({
      ok: true,
      user: { profile: { display_name: 'Carol', real_name: 'Carol' }, real_name: 'Carol' },
    });

    const result = await resolveSlackMentionsInText('<@UCAROL> said hi, and then <@UCAROL> said bye');
    expect(result).toBe('@Carol said hi, and then @Carol said bye');
    expect(mockUsersInfo).toHaveBeenCalledTimes(1);
  });

  it('falls back to raw user ID when Slack API call fails', async () => {
    mockUsersInfo.mockRejectedValue(new Error('Slack API error'));

    const result = await resolveSlackMentionsInText('Please ask <@UUNKNOWN> for details');
    expect(result).toBe('Please ask @UUNKNOWN for details');
  });

  it('preserves surrounding text unchanged', async () => {
    mockUsersInfo.mockResolvedValue({
      ok: true,
      user: { profile: { display_name: 'Dave', real_name: 'Dave' }, real_name: 'Dave' },
    });

    const result = await resolveSlackMentionsInText('Hi <@UDAVE>! Can you review the PR?');
    expect(result).toBe('Hi @Dave! Can you review the PR?');
  });
});
