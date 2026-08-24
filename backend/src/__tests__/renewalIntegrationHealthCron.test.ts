/**
 * Tests for the pre-renewal ad-integration health check (ENG-1270).
 *
 * Customers were charged on renewal while their primary ad integration was
 * silently disconnected (ThinkingAI, TransAmerica — August 2026 audit, both
 * caught manually). This cron scans users whose subscription renews within
 * the lookahead window and raises a visible, deduped alert when their ad
 * platform connection is missing or invalid — before the human forgets to look.
 */

jest.mock('../services/db', () => ({
  userDb: {
    scanWithFilter: jest.fn(),
  },
}));

const mockSendAlert = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: (...args: any[]) => mockSendAlert(...args),
}));

import { runRenewalIntegrationHealthCheck } from '../cron/renewalIntegrationHealthCron';
import { userDb } from '../services/db';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function periodEndInDays(days: number): string {
  return new Date(NOW + days * DAY_MS).toISOString();
}

function adAccount(overrides: Partial<{ platform: string; expiresAt: number }> = {}) {
  const { platform = 'meta', expiresAt = NOW + 30 * DAY_MS } = overrides;
  return {
    platform,
    account_id: 'act-1',
    account_name: 'Test Ad Account',
    config: { account_type: 'ad_account', access_token: 'tok', token_expires_at: expiresAt },
    created_at: '',
    updated_at: '',
  };
}

function user(overrides: Record<string, any> = {}) {
  return {
    userId: 'u1',
    email: 'user@example.com',
    subscription_status: 'active',
    current_period_end: periodEndInDays(5),
    emmaHelpInterests: ['paid_ads'],
    connected_accounts: [],
    ...overrides,
  };
}

describe('runRenewalIntegrationHealthCheck', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not flag a renewal-imminent account with no ad integration, because ads may not be in scope', async () => {
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
      user({ userId: 'u1', emmaHelpInterests: [], connected_accounts: [] }),
    ]);

    const summary = await runRenewalIntegrationHealthCheck();

    expect(summary.flagged).toBe(0);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('flags a renewal-imminent account whose ad token is expired', async () => {
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
      user({
        userId: 'u2',
        connected_accounts: [adAccount({ expiresAt: NOW - DAY_MS })],
      }),
    ]);

    const summary = await runRenewalIntegrationHealthCheck();

    expect(summary.flagged).toBe(1);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });

  it('does not flag a renewal-imminent account with a healthy connected ad integration', async () => {
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
      user({
        userId: 'u3',
        connected_accounts: [adAccount({ expiresAt: NOW + 30 * DAY_MS })],
      }),
    ]);

    const summary = await runRenewalIntegrationHealthCheck();

    expect(summary.flagged).toBe(0);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('does not flag a renewal-imminent account whose only connection is non-ad (e.g. Gmail)', async () => {
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
      user({
        userId: 'u4',
        connected_accounts: [
          { platform: 'gmail', account_id: 'g1', config: { account_type: 'personal', access_token: 't', token_expires_at: NOW + 30 * DAY_MS } },
        ],
        emmaHelpInterests: [],
      }),
    ]);

    const summary = await runRenewalIntegrationHealthCheck();

    expect(summary.flagged).toBe(0);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('does not throw and returns an empty summary when the scan fails', async () => {
    (userDb.scanWithFilter as jest.Mock).mockRejectedValue(new Error('dynamo down'));

    const summary = await runRenewalIntegrationHealthCheck();

    expect(summary.scannedUsers).toBe(0);
    expect(summary.flagged).toBe(0);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('continues scanning and flags other users when the alert for one user fails', async () => {
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
      user({ userId: 'u5', connected_accounts: [] }),
      user({ userId: 'u6', connected_accounts: [] }),
    ]);
    mockSendAlert.mockRejectedValueOnce(new Error('email down')).mockResolvedValueOnce(undefined);

    const summary = await runRenewalIntegrationHealthCheck();

    expect(summary.scannedUsers).toBe(2);
    expect(summary.flagged).toBe(2);
    expect(mockSendAlert).toHaveBeenCalledTimes(2);
  });

  /**
   * Regression fixtures — ENG-1270. The old check assumed all renewal-imminent
   * customers use ads, which misclassified TransAmerica's LinkedIn-only plan.
   */
  describe('regression: ads intent gates renewal health', () => {
    it('does not flag the TransAmerica-shaped account when it is using LinkedIn outreach rather than ads', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({
          userId: 'transamerica-user',
          current_period_end: periodEndInDays(13),
          connected_accounts: [
            { platform: 'linkedin', account_id: 'li-1', config: { access_token: 't' } },
          ],
          emmaHelpInterests: ['founder_led_sales'],
        }),
      ]);

      const summary = await runRenewalIntegrationHealthCheck();

      expect(summary.flagged).toBe(0);
    });

    it('flags a paid-ads customer with no ad account connected', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([
        user({ userId: 'paid-ads-user', emmaHelpInterests: ['paid_ads'], connected_accounts: [] }),
      ]);

      const summary = await runRenewalIntegrationHealthCheck();

      expect(summary.flagged).toBe(1);
      expect(mockSendAlert).toHaveBeenCalledWith(expect.objectContaining({
        context: expect.objectContaining({ userId: 'paid-ads-user' }),
      }));
    });
  });
});
