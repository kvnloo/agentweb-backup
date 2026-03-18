/**
 * Tests for Fathom OAuth redirect URI correctness in integrations.ts
 *
 * The Fathom OAuth flow was failing with `invalid_redirect_uri` because
 * integrations.ts used `/api/oauth/callback/fathom` while the Express route
 * is mounted at `/api/oauth/fathom`. This test ensures the redirect URI
 * matches the canonical route pattern used by all other integrations.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGetFathomCredentials = jest.fn();

jest.mock('../utils/secretsManager', () => ({
  getFathomCredentials: (...args: any[]) => mockGetFathomCredentials(...args),
  getLinkedInCredentials: jest.fn(),
  getMetaCredentials: jest.fn(),
  getGmailCredentials: jest.fn(),
  getYouTubeCredentials: jest.fn(),
}));

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Fathom OAuth redirect URI', () => {
  const mockCredentials = { clientId: 'fathom-client-id', clientSecret: 'fathom-client-secret' };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('INTEGRATION_CONFIG.fathom.redirectUri uses /api/oauth/fathom/callback path (not /api/oauth/callback/fathom)', async () => {
    const { INTEGRATION_CONFIG } = await import('../config/integrations');

    // Must match the Express mount point: app.use("/api/oauth/fathom", fathomAuthRoutes)
    // which gives route /api/oauth/fathom/callback
    expect(INTEGRATION_CONFIG.fathom.redirectUri).toContain('/api/oauth/fathom/callback');
    expect(INTEGRATION_CONFIG.fathom.redirectUri).not.toContain('/api/oauth/callback/fathom');
  });

  it('getFathomConfig returns redirectUri with /api/oauth/fathom/callback', async () => {
    mockGetFathomCredentials.mockResolvedValue(mockCredentials);
    const { getFathomConfig } = await import('../config/integrations');

    const config = await getFathomConfig();

    expect(config.redirectUri).toContain('/api/oauth/fathom/callback');
    expect(config.redirectUri).not.toContain('/api/oauth/callback/fathom');
  });

  it('getFathomConfig returns credentials from secrets manager', async () => {
    mockGetFathomCredentials.mockResolvedValue(mockCredentials);
    const { getFathomConfig } = await import('../config/integrations');

    const config = await getFathomConfig();

    expect(config.clientId).toBe('fathom-client-id');
    expect(config.clientSecret).toBe('fathom-client-secret');
    expect(config.authorizationUrl).toContain('fathom.video');
    expect(config.tokenUrl).toContain('fathom.ai');
    expect(config.scopes).toContain('public_api');
  });

  it('Fathom redirect URI follows the same pattern as other integrations', async () => {
    const { INTEGRATION_CONFIG } = await import('../config/integrations');

    // All OAuth redirect URIs follow the pattern: /api/oauth/{platform}/callback
    expect(INTEGRATION_CONFIG.gmail.redirectUri).toContain('/api/oauth/gmail/callback');
    expect(INTEGRATION_CONFIG.youtube.redirectUri).toContain('/api/oauth/youtube/callback');
    expect(INTEGRATION_CONFIG.fathom.redirectUri).toContain('/api/oauth/fathom/callback');
  });
});
