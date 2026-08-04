/**
 * Tests for getCalendlyConfig in integrations.ts (ENG-524)
 * Covers: happy path, static URLs, caching (TTL), error propagation.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────
export {};

const mockGetCalendlyCredentials = jest.fn();

jest.mock('../utils/secretsManager', () => ({
  getCalendlyCredentials: (...args: any[]) => mockGetCalendlyCredentials(...args),
  getLinkedInCredentials: jest.fn(),
  getMetaCredentials: jest.fn(),
}));

// ── Tests ──────────────────────────────────────────────────────────────────

describe('getCalendlyConfig', () => {
  const mockCredentials = { clientId: 'test-client', clientSecret: 'test-secret' };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules(); // Reset module cache so cachedCalendlyConfig is cleared between tests
  });

  it('returns config with clientId and clientSecret from getCalendlyCredentials', async () => {
    mockGetCalendlyCredentials.mockResolvedValue(mockCredentials);
    const { getCalendlyConfig } = await import('../config/integrations');

    const config = await getCalendlyConfig();

    expect(config.clientId).toBe('test-client');
    expect(config.clientSecret).toBe('test-secret');
  });

  it('points at the auth.calendly.com authorization and token endpoints', async () => {
    mockGetCalendlyCredentials.mockResolvedValue(mockCredentials);
    const { getCalendlyConfig } = await import('../config/integrations');

    const config = await getCalendlyConfig();

    expect(config.authorizationUrl).toBe('https://auth.calendly.com/oauth/authorize');
    expect(config.tokenUrl).toBe('https://auth.calendly.com/oauth/token');
  });

  // Calendly scopes are configured app-level in the developer dashboard, not passed on the
  // /oauth/authorize request (unlike Outlook/HubSpot) — this list exists so the app
  // registration in the dashboard can be cross-checked against what the code actually calls:
  // GET /users/me (users:read) and POST /webhook_subscriptions for invitee.created
  // (webhooks:write + scheduled_events:read, per developer.calendly.com/scopes).
  it('lists exactly the scopes the registered app needs — no more, no less', async () => {
    mockGetCalendlyCredentials.mockResolvedValue(mockCredentials);
    const { getCalendlyConfig } = await import('../config/integrations');

    const config = await getCalendlyConfig();

    // webhooks:read is included even though the code never calls it — Calendly's dashboard
    // force-selects it alongside webhooks:write, so it's granted either way (ENG-524).
    expect(config.scopes.sort()).toEqual([
      'scheduled_events:read',
      'users:read',
      'webhooks:read',
      'webhooks:write',
    ]);
  });

  it('points at the api.calendly.com users/me and webhook_subscriptions endpoints', async () => {
    mockGetCalendlyCredentials.mockResolvedValue(mockCredentials);
    const { getCalendlyConfig } = await import('../config/integrations');

    const config = await getCalendlyConfig();

    expect(config.meUrl).toBe('https://api.calendly.com/users/me');
    expect(config.webhookSubscriptionsUrl).toBe('https://api.calendly.com/webhook_subscriptions');
  });

  it('config includes redirectUri with /api/oauth/calendly/callback path', async () => {
    mockGetCalendlyCredentials.mockResolvedValue(mockCredentials);
    const { getCalendlyConfig } = await import('../config/integrations');

    const config = await getCalendlyConfig();

    expect(config.redirectUri).toContain('/api/oauth/calendly/callback');
  });

  it('caches the result and calls getCalendlyCredentials only once within TTL', async () => {
    mockGetCalendlyCredentials.mockResolvedValue(mockCredentials);
    const { getCalendlyConfig } = await import('../config/integrations');

    await getCalendlyConfig();
    await getCalendlyConfig();
    await getCalendlyConfig();

    expect(mockGetCalendlyCredentials).toHaveBeenCalledTimes(1);
  });

  it('propagates error from getCalendlyCredentials', async () => {
    mockGetCalendlyCredentials.mockRejectedValue(new Error('Secrets Manager unavailable'));
    const { getCalendlyConfig } = await import('../config/integrations');

    await expect(getCalendlyConfig()).rejects.toThrow();
  });
});
