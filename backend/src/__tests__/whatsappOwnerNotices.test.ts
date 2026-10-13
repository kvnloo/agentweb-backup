/**
 * Emails to an account's owner about its WhatsApp connection (ENG-273).
 */
jest.mock('../services/settingsService', () => ({
  settingsService: { setSettingIfAbsent: jest.fn(), deleteSetting: jest.fn() },
}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/emailService', () => ({ emailService: { sendEmail: jest.fn() } }));

const { settingsService } = require('../services/settingsService');
const { userDb } = require('../services/db');
const { emailService } = require('../services/emailService');
import { notifyOwnerStopDisconnected, notifyOwnerUnreachable } from '../services/whatsappOwnerNotices';

beforeEach(() => {
  jest.resetAllMocks();
  userDb.getUserById.mockResolvedValue({ userId: 'u1', email: 'owner@example.com' });
  emailService.sendEmail.mockResolvedValue(undefined);
  settingsService.setSettingIfAbsent.mockResolvedValue(true);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('notifyOwnerStopDisconnected', () => {
  it('emails the account owner, and says what changed and how to undo it', async () => {
    await expect(notifyOwnerStopDisconnected('u1', 0)).resolves.toBe(true);
    const [to, subject, text, html] = emailService.sendEmail.mock.calls[0];
    expect(to).toBe('owner@example.com');
    expect(subject).toMatch(/WhatsApp connection was removed/);
    expect(text).toMatch(/without waiting for your review/i); // the consequence, stated plainly
    expect(text).toMatch(/START/);
    expect(html).toContain('<p>');
  });

  it('mentions cancelled approvals only when there were some, with correct grammar', async () => {
    await notifyOwnerStopDisconnected('u1', 0);
    expect(emailService.sendEmail.mock.calls[0][2]).not.toMatch(/cancelled/);
    await notifyOwnerStopDisconnected('u1', 1);
    expect(emailService.sendEmail.mock.calls[1][2]).toMatch(/1 approval request that was still waiting .* has been cancelled/);
    await notifyOwnerStopDisconnected('u1', 3);
    expect(emailService.sendEmail.mock.calls[2][2]).toMatch(/3 approval requests that were still waiting .* have been cancelled/);
  });

  it('never puts a phone number in the subject or body', async () => {
    await notifyOwnerStopDisconnected('u1', 2);
    const [, subject, text] = emailService.sendEmail.mock.calls[0];
    expect(`${subject} ${text}`).not.toMatch(/\+?\d{7,}/);
  });

  it('returns false without throwing when there is no email address', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1' });
    await expect(notifyOwnerStopDisconnected('u1', 0)).resolves.toBe(false);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('returns false, and logs, when the mail layer reports a failure', async () => {
    emailService.sendEmail.mockResolvedValue('failed');
    await expect(notifyOwnerStopDisconnected('u1', 0)).resolves.toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  it('never throws, even when the lookup itself blows up', async () => {
    userDb.getUserById.mockRejectedValue(new Error('dynamo down'));
    await expect(notifyOwnerStopDisconnected('u1', 0)).resolves.toBe(false);
  });
});

describe('notifyOwnerUnreachable', () => {
  it('emails once, then stays quiet for a day', async () => {
    settingsService.setSettingIfAbsent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(notifyOwnerUnreachable('u1')).resolves.toBe(true);
    await expect(notifyOwnerUnreachable('u1')).resolves.toBe(false);
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const [key, , , , ttl] = settingsService.setSettingIfAbsent.mock.calls[0];
    expect(key).toBe('whatsapp:unreachable-notice:u1');
    const now = Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(now + 23 * 3600);
    expect(ttl).toBeLessThan(now + 25 * 3600);
  });

  it('gives the day\'s slot back when the email itself fails, so the next failure can try again', async () => {
    emailService.sendEmail.mockResolvedValue('failed');
    await expect(notifyOwnerUnreachable('u1')).resolves.toBe(false);
    expect(settingsService.deleteSetting).toHaveBeenCalledWith('whatsapp:unreachable-notice:u1');
  });

  it('still sends when the rate-limit store is down (one extra email beats none)', async () => {
    settingsService.setSettingIfAbsent.mockRejectedValue(new Error('dynamo down'));
    await expect(notifyOwnerUnreachable('u1')).resolves.toBe(true);
  });
});
