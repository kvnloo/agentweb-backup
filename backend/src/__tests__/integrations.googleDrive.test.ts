/**
 * Tests for getGoogleDriveConfig in integrations.ts
 * Covers: happy path, scopes, caching (TTL), error propagation
 */

// ── Mocks ──────────────────────────────────────────────────────────────────
export {};

const mockGetGmailCredentials = jest.fn();

jest.mock('../utils/secretsManager', () => ({
  getGmailCredentials: (...args: any[]) => mockGetGmailCredentials(...args),
  getLinkedInCredentials: jest.fn(),
  getMetaCredentials: jest.fn(),
}));

// ── Tests ──────────────────────────────────────────────────────────────────

describe('getGoogleDriveConfig', () => {
  const mockCredentials = { clientId: 'test-client', clientSecret: 'test-secret' };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules(); // Reset module cache so cachedGoogleDriveConfig is cleared between tests
  });

  it('returns config with clientId and clientSecret from getGmailCredentials', async () => {
    mockGetGmailCredentials.mockResolvedValue(mockCredentials);
    const { getGoogleDriveConfig } = await import('../config/integrations');

    const config = await getGoogleDriveConfig();

    expect(config.clientId).toBe('test-client');
    expect(config.clientSecret).toBe('test-secret');
  });

  it('includes drive scope in scopes array', async () => {
    mockGetGmailCredentials.mockResolvedValue(mockCredentials);
    const { getGoogleDriveConfig } = await import('../config/integrations');

    const config = await getGoogleDriveConfig();

    expect(config.scopes).toContain('https://www.googleapis.com/auth/drive');
  });

  it('includes drive, documents, and spreadsheets scopes', async () => {
    mockGetGmailCredentials.mockResolvedValue(mockCredentials);
    const { getGoogleDriveConfig } = await import('../config/integrations');

    const config = await getGoogleDriveConfig();

    expect(config.scopes).toContain('https://www.googleapis.com/auth/drive');
    expect(config.scopes).toContain('https://www.googleapis.com/auth/documents');
    expect(config.scopes).toContain('https://www.googleapis.com/auth/spreadsheets');
  });

  it('does not use the narrower drive.file scope — full drive was chosen deliberately for read access to pre-existing files', async () => {
    mockGetGmailCredentials.mockResolvedValue(mockCredentials);
    const { getGoogleDriveConfig } = await import('../config/integrations');

    const config = await getGoogleDriveConfig();

    expect(config.scopes).not.toContain('https://www.googleapis.com/auth/drive.file');
  });

  it('config includes redirectUri with /api/oauth/google-drive/callback path', async () => {
    mockGetGmailCredentials.mockResolvedValue(mockCredentials);
    const { getGoogleDriveConfig } = await import('../config/integrations');

    const config = await getGoogleDriveConfig();

    expect(config.redirectUri).toContain('/api/oauth/google-drive/callback');
  });

  it('caches the result and calls getGmailCredentials only once within TTL', async () => {
    mockGetGmailCredentials.mockResolvedValue(mockCredentials);
    const { getGoogleDriveConfig } = await import('../config/integrations');

    await getGoogleDriveConfig();
    await getGoogleDriveConfig();
    await getGoogleDriveConfig();

    expect(mockGetGmailCredentials).toHaveBeenCalledTimes(1);
  });

  it('propagates error from getGmailCredentials', async () => {
    mockGetGmailCredentials.mockRejectedValue(new Error('Secrets Manager unavailable'));
    const { getGoogleDriveConfig } = await import('../config/integrations');

    await expect(getGoogleDriveConfig()).rejects.toThrow();
  });
});
