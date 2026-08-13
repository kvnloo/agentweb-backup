/**
 * ENG-1158 — proactive notification when a Meta ads connection loses its scopes.
 *
 * The gap this closes: the moment we learn an ad account can no longer read ads
 * is inside an unattended run. Nothing told the owner. Account 922903076601160
 * silently produced zero-data scheduled reports for days, and the owner only
 * found out by reading a run's output. One email, at the moment of detection,
 * pointing at the exact screen that fixes it.
 */
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/emailService', () => ({
  emailService: {
    sendEmail: jest.fn().mockResolvedValue(undefined),
    escapeHtml: (s: string) =>
      String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'),
  },
}));

import { notifyMetaAdsScopeLost } from '../services/metaAdsScopeAlertService';
import { userDb } from '../services/db';
import { emailService } from '../services/emailService';
import { __resetMetaAdsScopeAlertGuard } from '../services/metaAdsScopeAlertService';

const sendEmail = emailService.sendEmail as jest.Mock;
const getUserById = userDb.getUserById as jest.Mock;

describe('notifyMetaAdsScopeLost (ENG-1158)', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    sendEmail.mockResolvedValue(undefined);
    process.env.CUSTOMER_FRONTEND_URL = 'https://app.agentweb.pro';
    // This alert only sends in production (see below). The behaviour under test
    // in every other case is what production does.
    process.env.NODE_ENV = 'production';
    __resetMetaAdsScopeAlertGuard();
  });

  /**
   * `ads_scope_alerted_at` is written by a read-modify-write with no condition,
   * so two runs racing on the same account can both read "not yet alerted" and
   * both send. The durable marker cannot close that window; this guard can.
   */
  describe('concurrent sends for the same account', () => {
    it('sends once when two callers race', async () => {
      getUserById.mockResolvedValue({ userId: 'owner1', email: 'owner@example.com' });

      const [first, second] = await Promise.all([
        notifyMetaAdsScopeLost({ ownerUserId: 'owner1', accountId: '922903076601160' }),
        notifyMetaAdsScopeLost({ ownerUserId: 'owner1', accountId: '922903076601160' }),
      ]);

      expect(sendEmail).toHaveBeenCalledTimes(1);
      // Both joiners get the SAME real outcome — here, a success.
      expect(first).toBe(true);
      expect(second).toBe(true);
    });

    /**
     * The first version of this guard recorded the attempt BEFORE sending, so a
     * failed send made every later caller report true — the callers then kept a
     * notice marker for an email that never went out and the owner was silenced
     * for good. Exactly the bug the marker retraction exists to prevent
     * (Greptile P1 on that guard).
     */
    it('reports a failed send as failed to every joiner, never as sent', async () => {
      getUserById.mockResolvedValue({ userId: 'owner1', email: 'owner@example.com' });
      sendEmail.mockRejectedValue(new Error('Resend down'));

      const [first, second] = await Promise.all([
        notifyMetaAdsScopeLost({ ownerUserId: 'owner1', accountId: '922903076601160' }),
        notifyMetaAdsScopeLost({ ownerUserId: 'owner1', accountId: '922903076601160' }),
      ]);

      expect(first).toBe(false);
      expect(second).toBe(false);
    });

    it('lets a later attempt retry after a failed send', async () => {
      // Nothing lingers to suppress the retry: the guard lives only for the
      // duration of the attempt, so the next run genuinely tries again.
      getUserById.mockResolvedValue({ userId: 'owner1', email: 'owner@example.com' });
      sendEmail.mockRejectedValueOnce(new Error('Resend down'));

      const failed = await notifyMetaAdsScopeLost({ ownerUserId: 'owner1', accountId: 'a1' });
      const retried = await notifyMetaAdsScopeLost({ ownerUserId: 'owner1', accountId: 'a1' });

      expect(failed).toBe(false);
      expect(retried).toBe(true);
      expect(sendEmail).toHaveBeenCalledTimes(2);
    });

    it('reports a missing address as failed, so the notice is retracted', async () => {
      getUserById.mockResolvedValue({ userId: 'owner1', email: undefined });

      await expect(
        notifyMetaAdsScopeLost({ ownerUserId: 'owner1', accountId: 'a1' })
      ).resolves.toBe(false);
    });

    it('does not suppress a different account for the same owner', async () => {
      getUserById.mockResolvedValue({ userId: 'owner1', email: 'owner@example.com' });

      await notifyMetaAdsScopeLost({ ownerUserId: 'owner1', accountId: 'acct-a' });
      await notifyMetaAdsScopeLost({ ownerUserId: 'owner1', accountId: 'acct-b' });

      expect(sendEmail).toHaveBeenCalledTimes(2);
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  /**
   * The dev and preview databases are clones of production and carry real
   * customer addresses, and this alert now fires from a cron that runs on boot.
   * Without this guard, spinning up a preview environment mails real people
   * about an account they cannot see.
   */
  describe('outside production', () => {
    it.each(['development', 'staging', 'test'])('sends nothing in %s', async (env) => {
      process.env.NODE_ENV = env;
      getUserById.mockResolvedValue({ userId: 'owner1', email: 'owner@example.com' });

      const sent = await notifyMetaAdsScopeLost({ ownerUserId: 'owner1', accountId: '1' });

      expect(sent).toBe(false);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('does not even look the owner up', async () => {
      process.env.NODE_ENV = 'development';

      await notifyMetaAdsScopeLost({ ownerUserId: 'owner1', accountId: '1' });

      expect(getUserById).not.toHaveBeenCalled();
    });
  });

  it('emails the connection owner with the reconnect destination', async () => {
    getUserById.mockResolvedValue({ userId: 'owner1', email: 'owner@example.com' });

    const sent = await notifyMetaAdsScopeLost({
      ownerUserId: 'owner1',
      accountId: '922903076601160',
      accountName: 'AgentWeb',
    });

    expect(sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, text, html] = sendEmail.mock.calls[0];
    expect(to).toBe('owner@example.com');
    expect(subject).toMatch(/meta/i);
    expect(text).toContain('https://app.agentweb.pro/settings/accounts');
    expect(html).toContain('https://app.agentweb.pro/settings/accounts');
  });

  it('names the affected ad account so a multi-account owner knows which to fix', async () => {
    getUserById.mockResolvedValue({ userId: 'owner1', email: 'owner@example.com' });

    await notifyMetaAdsScopeLost({
      ownerUserId: 'owner1',
      accountId: '922903076601160',
      accountName: 'AgentWeb',
    });

    const [, , text] = sendEmail.mock.calls[0];
    expect(text).toContain('922903076601160');
    expect(text).toContain('AgentWeb');
  });

  it('says outright that reporting is producing no data, not that nothing happened', async () => {
    // The distinction the customer explicitly asked for: an auth failure must
    // never read as "the campaigns had no activity".
    getUserById.mockResolvedValue({ userId: 'owner1', email: 'owner@example.com' });

    await notifyMetaAdsScopeLost({ ownerUserId: 'owner1', accountId: '922903076601160' });

    const [, , text] = sendEmail.mock.calls[0];
    expect(text).toMatch(/ads_read/);
    expect(text.toLowerCase()).toMatch(/no (campaign|metrics|data)/);
  });

  it('escapes an account name containing HTML rather than injecting it into the email', async () => {
    getUserById.mockResolvedValue({ userId: 'owner1', email: 'owner@example.com' });

    await notifyMetaAdsScopeLost({
      ownerUserId: 'owner1',
      accountId: '1',
      accountName: '<img src=x onerror=alert(1)>',
    });

    const [, , , html] = sendEmail.mock.calls[0];
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('still sends a usable email when neither the account label nor the portal URL is configured', async () => {
    delete process.env.CUSTOMER_FRONTEND_URL;
    getUserById.mockResolvedValue({ userId: 'owner1', email: 'owner@example.com' });

    await notifyMetaAdsScopeLost({ ownerUserId: 'owner1' });

    const [, , text] = sendEmail.mock.calls[0];
    expect(text).toContain('your Meta ad account');
    expect(text).toContain('http://localhost:5174/settings/accounts');
  });

  it('sends nothing when the owner has no email on file', async () => {
    getUserById.mockResolvedValue({ userId: 'owner1' });

    await expect(
      notifyMetaAdsScopeLost({ ownerUserId: 'owner1', accountId: '1' })
    ).resolves.toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends nothing when the owner cannot be resolved', async () => {
    getUserById.mockResolvedValue(null);

    await expect(
      notifyMetaAdsScopeLost({ ownerUserId: 'missing', accountId: '1' })
    ).resolves.toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('never throws into the caller — a failed alert must not mask the user-facing error', async () => {
    getUserById.mockRejectedValue(new Error('DynamoDB unavailable'));

    await expect(
      notifyMetaAdsScopeLost({ ownerUserId: 'owner1', accountId: '1' })
    ).resolves.toBe(false);
  });

  it('survives a thrown non-Error value without producing "undefined" in the log', async () => {
    getUserById.mockRejectedValue('DynamoDB exploded');

    await expect(
      notifyMetaAdsScopeLost({ ownerUserId: 'owner1', accountId: '1' })
    ).resolves.toBe(false);
  });

  it('swallows a send failure and reports it as not sent', async () => {
    getUserById.mockResolvedValue({ userId: 'owner1', email: 'owner@example.com' });
    sendEmail.mockRejectedValue(new Error('Resend down'));

    await expect(
      notifyMetaAdsScopeLost({ ownerUserId: 'owner1', accountId: '1' })
    ).resolves.toBe(false);
  });
});
