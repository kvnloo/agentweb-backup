/**
 * Tests for the memoized Teams CloudAdapter (ENG-272).
 *
 * The invariant worth a test: the memo must not outlive the credentials it was built from.
 * A client-secret rotation keeps the same appId, so an appId-only cache key would keep
 * handing back an adapter authenticating with the retired password until the process
 * restarted (CodeRabbit, PR #3139).
 */

export {}; // isolate module scope so top-level mocks don't collide with sibling test files

const mockCloudAdapter = jest.fn();
const mockGetTeamsBotCredentials = jest.fn();

jest.mock('botbuilder', () => ({
  CloudAdapter: function (...args: any[]) {
    mockCloudAdapter(...args);
    return { process: jest.fn(), onTurnError: undefined };
  },
  ConfigurationBotFrameworkAuthentication: jest.fn(),
}));

jest.mock('../utils/secretsManager', () => ({
  getTeamsBotCredentials: (...args: any[]) => mockGetTeamsBotCredentials(...args),
}));

const CREDS = { appId: 'app-1', appPassword: 'secret-v1', tenantId: 'tenant-1' };

describe('getTeamsBotAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockGetTeamsBotCredentials.mockResolvedValue(CREDS);
  });

  it('reuses the adapter while credentials are unchanged', async () => {
    const { getTeamsBotAdapter } = require('../services/teams/teamsBotAdapter');

    const a = await getTeamsBotAdapter();
    const b = await getTeamsBotAdapter();

    // Rebuilding per request would throw away the SDK's Connector token cache.
    expect(a).toBe(b);
    expect(mockCloudAdapter).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when the client secret is rotated, even though appId is unchanged', async () => {
    const { getTeamsBotAdapter } = require('../services/teams/teamsBotAdapter');

    await getTeamsBotAdapter();
    mockGetTeamsBotCredentials.mockResolvedValue({ ...CREDS, appPassword: 'secret-v2' });
    const after = await getTeamsBotAdapter();

    expect(mockCloudAdapter).toHaveBeenCalledTimes(2);
    expect(after).toBeDefined();
  });

  it('rebuilds when the tenant changes', async () => {
    const { getTeamsBotAdapter } = require('../services/teams/teamsBotAdapter');

    await getTeamsBotAdapter();
    mockGetTeamsBotCredentials.mockResolvedValue({ ...CREDS, tenantId: 'tenant-2' });
    await getTeamsBotAdapter();

    expect(mockCloudAdapter).toHaveBeenCalledTimes(2);
  });

  it('propagates a credentials failure instead of serving a stale adapter', async () => {
    const { getTeamsBotAdapter } = require('../services/teams/teamsBotAdapter');

    await getTeamsBotAdapter();
    mockGetTeamsBotCredentials.mockRejectedValue(new Error('secret unavailable'));

    // Fail closed: the route turns this into a 401 rather than authenticating with old creds.
    await expect(getTeamsBotAdapter()).rejects.toThrow('secret unavailable');
  });
});
