/**
 * Tests for getGmailConfig in integrations.ts
 * Covers: happy path, caching (TTL), error propagation
 */

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGetGmailCredentials = jest.fn();

jest.mock('../utils/secretsManager', () => ({
  getGmailCredentials: (...args: any[]) => mockGetGmailCredentials(...args),
  getLinkedInCredentials: jest.fn(),
  getMetaCredentials: jest.fn(),
}));

// ── Tests ──────────────────────────────────────────────────────────────────

describe('getGmailConfig', () => {
  const mockCredentials = { clientId: 'test-client-id', clientSecret: 'test-client-secret' };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules(); // Reset module cache so cachedGmailConfig is cleared between tests
  });

  it('returns config with credentials from secrets manager', async () => {
    mockGetGmailCredentials.mockResolvedValue(mockCredentials);
    const { getGmailConfig } = await import('../config/integrations');

    const config = await getGmailConfig();

    expect(config.clientId).toBe('test-client-id');
    expect(config.clientSecret).toBe('test-client-secret');
    expect(config.authorizationUrl).toContain('accounts.google.com');
    expect(config.tokenUrl).toContain('googleapis.com');
    expect(config.scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(config.scopes).toContain('https://www.googleapis.com/auth/gmail.send');
  });

  it('requests both calendar read and write scopes (enables event booking)', async () => {
    mockGetGmailCredentials.mockResolvedValue(mockCredentials);
    const { getGmailConfig } = await import('../config/integrations');

    const config = await getGmailConfig();

    // Read scope so the agent can list/inspect events.
    expect(config.scopes).toContain('https://www.googleapis.com/auth/calendar.readonly');
    // Write scope so the agent can actually create/book events.
    expect(config.scopes).toContain('https://www.googleapis.com/auth/calendar.events');
  });

  it('caches the result and does not call secrets manager again within TTL', async () => {
    mockGetGmailCredentials.mockResolvedValue(mockCredentials);
    const { getGmailConfig } = await import('../config/integrations');

    await getGmailConfig();
    await getGmailConfig();
    await getGmailConfig();

    expect(mockGetGmailCredentials).toHaveBeenCalledTimes(1);
  });

  it('refetches after cache TTL expires', async () => {
    jest.useFakeTimers();
    mockGetGmailCredentials.mockResolvedValue(mockCredentials);
    const { getGmailConfig } = await import('../config/integrations');

    await getGmailConfig(); // populates cache
    expect(mockGetGmailCredentials).toHaveBeenCalledTimes(1);

    // Advance past the 5-minute TTL
    jest.advanceTimersByTime(6 * 60 * 1000);

    await getGmailConfig(); // cache expired — should refetch
    expect(mockGetGmailCredentials).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });

  it('throws when secrets manager fails', async () => {
    mockGetGmailCredentials.mockRejectedValue(new Error('Secrets Manager unavailable'));
    const { getGmailConfig } = await import('../config/integrations');

    await expect(getGmailConfig()).rejects.toThrow();
  });

  it('config includes redirectUri with /api/oauth/gmail/callback path', async () => {
    mockGetGmailCredentials.mockResolvedValue(mockCredentials);
    const { getGmailConfig } = await import('../config/integrations');

    const config = await getGmailConfig();
    expect(config.redirectUri).toContain('/api/oauth/gmail/callback');
  });
});
