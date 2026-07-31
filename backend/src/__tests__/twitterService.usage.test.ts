/**
 * ENG-664 — twitterService.getXProjectUsage reads the shared X app's OWN billed
 * consumption from GET /2/usage/tweets (app-only Bearer). This is the "measured"
 * reconciliation anchor; it is NOT a per-user call and is never metered.
 */

const mockV2Get = jest.fn();
const twitterApiConstructorArgs: any[] = [];

jest.mock(
  'twitter-api-v2',
  () => ({
    TwitterApi: jest.fn().mockImplementation((arg: any) => {
      twitterApiConstructorArgs.push(arg);
      return { v2: { get: (...a: any[]) => mockV2Get(...a) } };
    }),
  }),
  { virtual: true }
);

const mockGetTwitterCredentials = jest.fn();
jest.mock('../utils/secretsManager', () => ({
  getTwitterCredentials: (...a: any[]) => mockGetTwitterCredentials(...a),
}));

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  updateAccountTokens: jest.fn(),
  updateAccountConfig: jest.fn(),
}));

import { TwitterService } from '../services/twitterService';

beforeEach(() => {
  jest.clearAllMocks();
  twitterApiConstructorArgs.length = 0;
  mockGetTwitterCredentials.mockResolvedValue({
    clientId: 'cid',
    clientSecret: 'csecret',
    bearerToken: 'BEARER-123',
  });
});

describe('getXProjectUsage', () => {
  it('parses the X usage payload (string counts → numbers) using the app bearer', async () => {
    mockV2Get.mockResolvedValue({
      data: { cap_reset_day: 3, project_cap: '2000000', project_usage: '4141', project_id: 'p1' },
    });

    const svc = new TwitterService();
    const usage = await svc.getXProjectUsage();

    expect(mockV2Get).toHaveBeenCalledWith('usage/tweets');
    expect(twitterApiConstructorArgs[0]).toBe('BEARER-123'); // app-only bearer client
    expect(usage).toEqual({
      projectId: 'p1',
      projectCap: 2_000_000,
      projectUsage: 4141,
      capResetDay: 3,
    });
  });

  it('coerces a missing/garbage payload to safe zeros', async () => {
    mockV2Get.mockResolvedValue({ data: {} });
    const usage = await new TwitterService().getXProjectUsage();
    expect(usage).toEqual({ projectId: null, projectCap: 0, projectUsage: 0, capResetDay: null });
  });

  it('throws a surfaced error when the X call fails', async () => {
    mockV2Get.mockRejectedValue(Object.assign(new Error('x'), { code: 403, data: { title: 'Forbidden' } }));
    await expect(new TwitterService().getXProjectUsage()).rejects.toThrow(/Forbidden|403/);
  });

  it('fails loudly when the secret has no bearer token', async () => {
    mockGetTwitterCredentials.mockResolvedValue({ clientId: 'cid', clientSecret: 'csecret' });
    await expect(new TwitterService().getXProjectUsage()).rejects.toThrow(/bearer token/i);
  });
});
