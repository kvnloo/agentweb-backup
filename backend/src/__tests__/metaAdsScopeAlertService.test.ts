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
