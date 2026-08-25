/**
 * ENG-1263 / CodeRabbit regression: team identity is a positive internal-author
 * signal, so temporary Slack API failures must be retried rather than cached as
 * "external" for the rest of the process lifetime.
 */

// Force module scope (no other import/export in this file) — without it, TS
// treats this as a global script and its top-level `const mockUsersInfo`
// collides with the same name in slackService.resolveSlackMentions.test.ts
// (TS2451).
export {};

const mockUsersInfo = jest.fn();
const mockAuthTest = jest.fn();

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    users: { info: mockUsersInfo },
    auth: { test: mockAuthTest },
  })),
}));

describe('Slack team ID lookup cache (ENG-1263)', () => {
  let getSlackUserTeamId: (userId: string) => Promise<string | null>;
  let getOwnSlackTeamId: () => Promise<string | null>;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    mockUsersInfo.mockReset();
    mockAuthTest.mockReset();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.isolateModules(() => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ({ getSlackUserTeamId, getOwnSlackTeamId } = require('../services/slackService'));
    });
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('retries a user team lookup after a transient users.info failure', async () => {
    mockUsersInfo
      .mockRejectedValueOnce(new Error('temporary Slack outage'))
      .mockResolvedValueOnce({ ok: true, user: { team_id: 'TAGENTWEB01' } });

    await expect(getSlackUserTeamId('U_FANGFANG')).resolves.toBeNull();
    await expect(getSlackUserTeamId('U_FANGFANG')).resolves.toBe('TAGENTWEB01');
    expect(mockUsersInfo).toHaveBeenCalledTimes(2);
  });

  it('retries a user team lookup after Slack returns no usable team_id', async () => {
    mockUsersInfo
      .mockResolvedValueOnce({ ok: true, user: {} })
      .mockResolvedValueOnce({ ok: true, user: { team_id: 'TAGENTWEB01' } });

    await expect(getSlackUserTeamId('U_FANGFANG')).resolves.toBeNull();
    await expect(getSlackUserTeamId('U_FANGFANG')).resolves.toBe('TAGENTWEB01');
    expect(mockUsersInfo).toHaveBeenCalledTimes(2);
  });

  it('retries the app workspace lookup after a transient auth.test failure', async () => {
    mockAuthTest
      .mockRejectedValueOnce(new Error('temporary Slack outage'))
      .mockResolvedValueOnce({ ok: true, team_id: 'TAGENTWEB01' });

    await expect(getOwnSlackTeamId()).resolves.toBeNull();
    await expect(getOwnSlackTeamId()).resolves.toBe('TAGENTWEB01');
    expect(mockAuthTest).toHaveBeenCalledTimes(2);
  });

  it('still caches successful team ID lookups', async () => {
    mockUsersInfo.mockResolvedValue({ ok: true, user: { team_id: 'TAGENTWEB01' } });

    await expect(getSlackUserTeamId('U_FANGFANG')).resolves.toBe('TAGENTWEB01');
    await expect(getSlackUserTeamId('U_FANGFANG')).resolves.toBe('TAGENTWEB01');
    expect(mockUsersInfo).toHaveBeenCalledTimes(1);
  });
});
