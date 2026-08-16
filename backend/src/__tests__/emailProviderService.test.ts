/**
 * Tests for emailProviderService
 * Covers: provider registry, account resolution, bootstrap
 */

// ── Mocks ──────────────────────────────────────────────────────────────────

// Resolution reads every account the caller can reach (own + org-shared), not
// just their own record — see ENG-943 and emailProviderService.orgShared.test.ts.
const mockGetAccountsWithOwnerIncludingOrgShared = jest.fn();

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsWithOwnerIncludingOrgShared: (...args: any[]) =>
    mockGetAccountsWithOwnerIncludingOrgShared(...args),
}));

// Prevent gmailService from importing googleapis at module load
jest.mock('../services/gmailService', () => ({
  gmailService: {
    searchEmails: jest.fn(),
    listEmails: jest.fn(),
    getEmails: jest.fn(),
    sendEmail: jest.fn(),
  },
}));

import {
  registerEmailProvider,
  getEmailProvider,
  resolveEmailAccount,
  bootstrapEmailProviders,
  EMAIL_PLATFORMS,
  type IEmailService,
  type EmailPlatform,
} from '../services/emailProviderService';

// ── Fixtures ───────────────────────────────────────────────────────────────

const makeMockProvider = (): IEmailService => ({
  searchEmails: jest.fn(),
  listEmails: jest.fn(),
  getEmails: jest.fn(),
  sendEmail: jest.fn(),
});

const makeAccount = (platform: string, accountId = 'acc-1') => ({
  platform,
  account_id: accountId,
  account_name: 'Test Account',
  userId: 'user-123',
  config: {
    account_type: platform,
    access_token: 'token',
    token_expires_at: Date.now() + 3600000,
  },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('emailProviderService', () => {

  // ── EMAIL_PLATFORMS constant ──────────────────────────────────────────────
  describe('EMAIL_PLATFORMS', () => {
    it('includes gmail', () => {
      expect(EMAIL_PLATFORMS).toContain('gmail');
    });
  });

  // ── Provider registry ─────────────────────────────────────────────────────
  describe('registerEmailProvider / getEmailProvider', () => {
    it('registers and retrieves a provider', () => {
      const provider = makeMockProvider();
      registerEmailProvider('gmail', provider);
      expect(getEmailProvider('gmail')).toBe(provider);
    });

    it('throws for an unregistered platform', () => {
      expect(() => getEmailProvider('outlook' as EmailPlatform)).toThrow(
        /No email provider registered for platform "outlook"/
      );
    });

    it('error message lists supported platforms', () => {
      const provider = makeMockProvider();
      registerEmailProvider('gmail', provider);
      expect(() => getEmailProvider('unknown' as EmailPlatform)).toThrow(/gmail/);
    });
  });

  // ── resolveEmailAccount ───────────────────────────────────────────────────
  describe('resolveEmailAccount', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      // Ensure a provider is registered for gmail
      registerEmailProvider('gmail', makeMockProvider());
    });

    it('resolves a valid gmail account', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([makeAccount('gmail', 'user@gmail.com')]);

      const result = await resolveEmailAccount('user-123', 'user@gmail.com');
      expect(result.platform).toBe('gmail');
      expect(result.provider).toBeDefined();
    });

    it('throws when account is not found', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([]);

      await expect(resolveEmailAccount('user-123', 'missing-acc')).rejects.toThrow(
        /not found/
      );
    });

    it('throws when account platform is not an email platform', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([makeAccount('linkedin', 'li-acc')]);

      await expect(resolveEmailAccount('user-123', 'li-acc')).rejects.toThrow(
        /not an email account/
      );
    });

    it('error for non-email platform mentions the platform name', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([makeAccount('meta', 'meta-acc')]);

      await expect(resolveEmailAccount('user-123', 'meta-acc')).rejects.toThrow(/meta/);
    });
  });

  // ── bootstrapEmailProviders ───────────────────────────────────────────────
  describe('bootstrapEmailProviders', () => {
    it('registers gmail provider so getEmailProvider works afterwards', async () => {
      await bootstrapEmailProviders();
      // If gmail was registered, getEmailProvider should not throw
      expect(() => getEmailProvider('gmail')).not.toThrow();
    });

    it('is idempotent — calling twice does not throw', async () => {
      await expect(Promise.all([
        bootstrapEmailProviders(),
        bootstrapEmailProviders(),
      ])).resolves.not.toThrow();
    });
  });
});
