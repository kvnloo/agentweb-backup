/**
 * Tests for getHubSpotClientSecretForAppId in integrations.ts
 * Resolves the webhook-signing secret by the app that sent the event, so events
 * from apps we don't manage are not verified against our app's secret.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGetHubSpotCredentials = jest.fn();

jest.mock('../utils/secretsManager', () => ({
  getHubSpotCredentials: (...args: any[]) => mockGetHubSpotCredentials(...args),
}));

// ── Tests ──────────────────────────────────────────────────────────────────

describe('getHubSpotClientSecretForAppId', () => {
  const MANAGED_APP_ID = '42057552';
  const SECRET = 'managed-app-secret';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockGetHubSpotCredentials.mockResolvedValue({
      clientId: 'cid',
      clientSecret: SECRET,
      developerApiKey: 'dak',
      hubspotAppId: MANAGED_APP_ID,
    });
  });

  it('returns the secret when appId matches the managed app (number)', async () => {
    const { getHubSpotClientSecretForAppId } = await import('../config/integrations');
    expect(await getHubSpotClientSecretForAppId(42057552)).toBe(SECRET);
  });

  it('returns the secret when appId matches the managed app (string)', async () => {
    const { getHubSpotClientSecretForAppId } = await import('../config/integrations');
    expect(await getHubSpotClientSecretForAppId('42057552')).toBe(SECRET);
  });

  it('returns null for an appId from an app we do not manage', async () => {
    const { getHubSpotClientSecretForAppId } = await import('../config/integrations');
    expect(await getHubSpotClientSecretForAppId(99999999)).toBeNull();
  });

  it('falls back to the configured secret when appId is absent (legacy/test payloads)', async () => {
    const { getHubSpotClientSecretForAppId } = await import('../config/integrations');
    expect(await getHubSpotClientSecretForAppId(undefined)).toBe(SECRET);
    expect(await getHubSpotClientSecretForAppId(null)).toBe(SECRET);
    expect(await getHubSpotClientSecretForAppId('')).toBe(SECRET);
  });

  it('propagates errors when credentials cannot be loaded', async () => {
    mockGetHubSpotCredentials.mockRejectedValue(new Error('Secrets Manager unavailable'));
    const { getHubSpotClientSecretForAppId } = await import('../config/integrations');
    await expect(getHubSpotClientSecretForAppId(42057552)).rejects.toThrow();
  });
});
