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
  // ENG-1300: real typed error classes — plain classes, no side effects to
  // import — needed to test emailProviderErrorStatus() against the real thing.
  ...(() => {
    const actual = jest.requireActual('../services/gmailService');
    return {
      GmailNotConnectedError: actual.GmailNotConnectedError,
      GmailTokenRevokedError: actual.GmailTokenRevokedError,
      GmailQuotaError: actual.GmailQuotaError,
      GmailSendNotAuthorizedError: actual.GmailSendNotAuthorizedError,
    };
  })(),
}));

import {
  registerEmailProvider,
  getEmailProvider,
  resolveEmailAccount,
  bootstrapEmailProviders,
  emailProviderErrorStatus,
  EMAIL_PLATFORMS,
  type IEmailService,
  type EmailPlatform,
} from '../services/emailProviderService';
import {
  GmailNotConnectedError,
  GmailTokenRevokedError,
  GmailQuotaError,
  GmailSendNotAuthorizedError,
} from '../services/gmailService';

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

  // ── emailProviderErrorStatus (ENG-1300) ───────────────────────────────────
  // Gmail/Outlook throw fully-typed EmailProviderError subclasses that
  // deliberately carry no HTTP status of their own — this maps by constructor
  // name to a representative HTTP-equivalent status instead of falling
  // through to the generic Error/bug classification.
  describe('emailProviderErrorStatus', () => {
    it('maps GmailNotConnectedError to 401', () => {
      expect(emailProviderErrorStatus(new GmailNotConnectedError())).toBe(401);
    });

    it('maps GmailTokenRevokedError to 401', () => {
      expect(emailProviderErrorStatus(new GmailTokenRevokedError())).toBe(401);
    });

    it('maps GmailSendNotAuthorizedError to 403', () => {
      expect(emailProviderErrorStatus(new GmailSendNotAuthorizedError())).toBe(403);
    });

    it('leaves GmailQuotaError unmapped (its message already classifies via classFromMessage\'s "quota exceeded" pattern)', () => {
      expect(emailProviderErrorStatus(new GmailQuotaError())).toBeUndefined();
    });

    it('returns undefined for a plain Error (e.g. Resend failures, which carry no typed class here)', () => {
      expect(emailProviderErrorStatus(new Error('Resend API error'))).toBeUndefined();
    });

    it('returns undefined for a non-Error value', () => {
      expect(emailProviderErrorStatus('not an error')).toBeUndefined();
      expect(emailProviderErrorStatus(undefined)).toBeUndefined();
    });
  });
});
