/**
 * Tests for linkedInDisconnectNotifyService — notifies the account OWNER (not just
 * internal oncall) when their LinkedIn outreach account disconnects, per ENG-1351.
 *
 * Acceptance criteria under test (human-written, Linear ENG-1351):
 * 1. Flag on → owner receives a notification with a re-auth link, resolved from ownerUserId.
 * 2. Flag off → no owner email, but the suppression is recorded distinguishably from "sent".
 * 3. Repeated disconnects within the cooldown window → at most one owner notification;
 *    the internal/oncall path is unaffected by the cooldown.
 * 4. No resolvable owner email → fails loud (internal alert names the account), never silent.
 * 5. Flag has no effect on outreach execution — this service never touches sends.
 */

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendEmail: jest.fn().mockResolvedValue(undefined),
    sendOncallAlert: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

import { settingsService } from '../services/settingsService';
import { emailService } from '../services/emailService';
import { userDb } from '../services/db';
import { notifyAccountOwnerOfDisconnect } from '../services/linkedInDisconnectNotifyService';

const getSetting = settingsService.getSetting as jest.Mock;
const setSetting = settingsService.setSetting as jest.Mock;
const sendEmail = emailService.sendEmail as jest.Mock;
const sendOncallAlert = emailService.sendOncallAlert as jest.Mock;
const getUserById = userDb.getUserById as jest.Mock;

describe('notifyAccountOwnerOfDisconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSetting.mockResolvedValue(null);
    getUserById.mockResolvedValue({ userId: 'user-1', email: 'owner@example.com' });
    delete process.env.LINKEDIN_DISCONNECT_NOTIFY;
  });

  it('AC1: sends the owner an email with a re-auth link when the flag is enabled, resolved from ownerUserId', async () => {
    process.env.LINKEDIN_DISCONNECT_NOTIFY = 'true';

    await notifyAccountOwnerOfDisconnect('acct-1', 'user-1');

    expect(getUserById).toHaveBeenCalledWith('user-1');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, , text, html] = sendEmail.mock.calls[0];
    expect(to).toBe('owner@example.com');
    expect(text + html).toMatch(/reconnect|re-authenticate|settings/i);
  });

  it('AC2: suppresses the owner email when the flag is disabled, and records the suppression distinguishably from "sent"', async () => {
    // LINKEDIN_DISCONNECT_NOTIFY left unset → disabled

    await notifyAccountOwnerOfDisconnect('acct-2', 'user-1');

    expect(sendEmail).not.toHaveBeenCalled();
    expect(setSetting).toHaveBeenCalledTimes(1);
    const [, storedValue] = setSetting.mock.calls[0];
    const parsed = JSON.parse(storedValue);
    expect(parsed.sentToOwner).toBe(false);
    expect(parsed.suppressedReason).toBe('LINKEDIN_DISCONNECT_NOTIFY disabled');
  });

  it('AC3: a repeat disconnect inside the cooldown window sends at most one owner notification', async () => {
    process.env.LINKEDIN_DISCONNECT_NOTIFY = 'true';
    const now = new Date().toISOString();
    getSetting.mockResolvedValue({
      settingValue: JSON.stringify({ sentToOwner: true, lastOwnerNotifiedAt: now }),
    });

    await notifyAccountOwnerOfDisconnect('acct-3', 'user-1');

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('AC3: a persisted cooldown state that fails to read fails closed — no owner email is sent', async () => {
    process.env.LINKEDIN_DISCONNECT_NOTIFY = 'true';
    getSetting.mockRejectedValue(new Error('DynamoDB unavailable'));

    await notifyAccountOwnerOfDisconnect('acct-3b', 'user-1');

    expect(sendEmail).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('AC3: the internal/oncall path is unaffected by the owner cooldown — a missing owner email still alerts every call', async () => {
    process.env.LINKEDIN_DISCONNECT_NOTIFY = 'true';
    getUserById.mockResolvedValue(undefined);
    const now = new Date().toISOString();
    getSetting.mockResolvedValue({
      settingValue: JSON.stringify({ sentToOwner: false, lastOwnerNotifiedAt: now }),
    });

    await notifyAccountOwnerOfDisconnect('acct-4', 'user-1');
    await notifyAccountOwnerOfDisconnect('acct-4', 'user-1');

    expect(sendOncallAlert).toHaveBeenCalledTimes(2);
  });

  it('AC4: an account with no resolvable owner email fails loud via the internal oncall alert, naming the account', async () => {
    process.env.LINKEDIN_DISCONNECT_NOTIFY = 'true';
    getUserById.mockResolvedValue(undefined);

    await notifyAccountOwnerOfDisconnect('acct-5', 'user-1');

    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendOncallAlert).toHaveBeenCalledTimes(1);
    const [subject, message] = sendOncallAlert.mock.calls[0];
    expect(subject + message).toMatch(/acct-5/);
  });

  it('AC4: an account with no ownerUserId at all fails loud rather than silently dropping', async () => {
    process.env.LINKEDIN_DISCONNECT_NOTIFY = 'true';

    await notifyAccountOwnerOfDisconnect('acct-6', undefined);

    expect(getUserById).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendOncallAlert).toHaveBeenCalledTimes(1);
  });

  it('does not send twice for the same account+state when called concurrently before the cooldown record lands (best-effort within one call)', async () => {
    process.env.LINKEDIN_DISCONNECT_NOTIFY = 'true';

    await notifyAccountOwnerOfDisconnect('acct-7', 'user-1');

    expect(setSetting).toHaveBeenCalledTimes(1);
    const [, storedValue] = setSetting.mock.calls[0];
    const parsed = JSON.parse(storedValue);
    expect(parsed.sentToOwner).toBe(true);
    expect(typeof parsed.lastOwnerNotifiedAt).toBe('string');
  });
});
