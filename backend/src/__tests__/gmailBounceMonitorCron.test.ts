/**
 * ENG-2981 acceptance: Gmail permanent 5.x DSNs auto-DNC leads across the
 * owner's lists and record email.bounced; Delay DSNs and the sender's own
 * address are ignored.
 */
jest.mock('../services/db', () => ({
  userDb: { getAllUsers: jest.fn() },
  crmDb: { getLeadListsByUserId: jest.fn(), getLeadByEmail: jest.fn(), updateLead: jest.fn() },
}));
jest.mock('../services/connectedAccountsDb', () => ({ updateAccountConfig: jest.fn() }));
jest.mock('../services/gmailService', () => ({ gmailService: { listRawMessages: jest.fn() } }));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: { addEmailEvent: jest.fn() } }));

import { runGmailBounceMonitor, parseHardBounces } from '../cron/gmailBounceMonitorCron';
import { userDb, crmDb } from '../services/db';
import { updateAccountConfig } from '../services/connectedAccountsDb';
import { gmailService } from '../services/gmailService';
import { emailEventsDb } from '../services/emailEventsDb';

const SENDER = 'sondra@nuerraa.com';

const hardDsn = (rcpt: string, status = '5.1.1', action = 'failed') =>
  [
    'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    'Subject: Delivery Status Notification (Failure)',
    `X-Failed-Recipients: ${rcpt}`,
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
    '',
    '--b',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; googlemail.com',
    '',
    `Final-Recipient: rfc822; ${rcpt}`,
    `Action: ${action}`,
    `Status: ${status}`,
    '--b--',
  ].join('\r\n');

describe('parseHardBounces', () => {
  it('returns permanent 5.x failed recipients', () => {
    expect(parseHardBounces(hardDsn('Gone@Example.com'), SENDER)).toEqual([{ recipient: 'gone@example.com', status: '5.1.1' }]);
  });
  it('ignores Delay DSNs (Action: delayed / 4.x)', () => {
    expect(parseHardBounces(hardDsn('slow@example.com', '4.4.7', 'delayed'), SENDER)).toEqual([]);
  });
  it('ignores the sender own address', () => {
    expect(parseHardBounces(hardDsn(SENDER), SENDER)).toEqual([]);
  });
  it('ignores mail not from mailer-daemon/postmaster', () => {
    expect(parseHardBounces(hardDsn('x@example.com').replace(/^From: .*$/m, 'From: friend@example.com'), SENDER)).toEqual([]);
  });
  it('handles multiple recipient blocks, mixing hard and delayed', () => {
    const raw = hardDsn('a@example.com') + '\r\n\r\nFinal-Recipient: rfc822; b@example.com\r\nAction: delayed\r\nStatus: 4.2.2\r\n';
    expect(parseHardBounces(raw, SENDER).map(b => b.recipient)).toEqual(['a@example.com']);
  });
  it('falls back to X-Failed-Recipients only without a delivery-status block', () => {
    const raw = 'From: postmaster@example.org\r\nX-Failed-Recipients: c@example.com\r\n\r\n550 user unknown';
    expect(parseHardBounces(raw, SENDER)).toEqual([{ recipient: 'c@example.com', status: '5.0.0' }]);
    expect(parseHardBounces(raw.replace('550 user unknown', 'Status: 4.4.1 retrying'), SENDER)).toEqual([]);
  });
});

describe('runGmailBounceMonitor', () => {
  beforeEach(() => jest.clearAllMocks());
  const user = (cursor?: string) => ({
    userId: 'u1',
    emailDomain: 'nuerraa.com',
    connected_accounts: [{ platform: 'gmail', account_id: SENDER, config: { email: SENDER, ...(cursor && { lastBounceCheckAt: cursor }) } }],
  });

  it('seeds the cursor on first run without scanning history', async () => {
    (userDb.getAllUsers as jest.Mock).mockResolvedValue([user()]);
    const s = await runGmailBounceMonitor();
    expect(gmailService.listRawMessages).not.toHaveBeenCalled();
    expect(updateAccountConfig).toHaveBeenCalledWith('u1', 'gmail', SENDER, { lastBounceCheckAt: expect.any(String) });
    expect(s.gmailAccounts).toBe(1);
  });

  it('flags the lead in every list, records email.bounced, advances the cursor', async () => {
    (userDb.getAllUsers as jest.Mock).mockResolvedValue([user('2026-11-01T00:00:00.000Z')]);
    (gmailService.listRawMessages as jest.Mock).mockResolvedValue([
      { id: 'm1', receivedAt: '2026-11-02T00:00:00.000Z', raw: hardDsn('gone@example.com') },
      { id: 'm2', receivedAt: '2026-11-03T00:00:00.000Z', raw: hardDsn('slow@example.com', '4.4.7', 'delayed') },
    ]);
    (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([{ listId: 'L1' }, { listId: 'L2' }]);
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({ leadId: 'lead1' });

    const s = await runGmailBounceMonitor();

    expect((gmailService.listRawMessages as jest.Mock).mock.calls[0][2]).toBe(
      `from:(mailer-daemon OR postmaster) after:${Math.floor(Date.parse('2026-11-01T00:00:00.000Z') / 1000)}`,
    );
    expect(crmDb.getLeadByEmail).toHaveBeenCalledTimes(2);
    expect(crmDb.getLeadByEmail).toHaveBeenCalledWith('L1', 'gone@example.com');
    expect(crmDb.updateLead).toHaveBeenCalledWith('L2', 'lead1', expect.objectContaining({ contactStatus: 'do-not-contact', contactStatusReason: 'bounced' }));
    expect(emailEventsDb.addEmailEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'email.bounced' }), 'nuerraa.com', 'gmail-bounce:m1:gone@example.com', 'gone@example.com',
    );
    expect(updateAccountConfig).toHaveBeenCalledWith('u1', 'gmail', SENDER, { lastBounceCheckAt: '2026-11-03T00:00:00.000Z' });
    expect(s).toMatchObject({ hardBouncesFound: 1, leadsFlagged: 2, eventsRecorded: 1, failed: 0 });
  });

  it('skips already-DNC leads and tolerates duplicate events', async () => {
    (userDb.getAllUsers as jest.Mock).mockResolvedValue([user('2026-11-01T00:00:00.000Z')]);
    (gmailService.listRawMessages as jest.Mock).mockResolvedValue([{ id: 'm1', receivedAt: '2026-11-02T00:00:00.000Z', raw: hardDsn('gone@example.com') }]);
    (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([{ listId: 'L1' }]);
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({ leadId: 'lead1', contactStatus: 'do-not-contact' });
    (emailEventsDb.addEmailEvent as jest.Mock).mockRejectedValue(Object.assign(new Error('dup'), { isDuplicateEventId: true }));
    const s = await runGmailBounceMonitor();
    expect(crmDb.updateLead).not.toHaveBeenCalled();
    expect(s).toMatchObject({ leadsFlagged: 0, eventsRecorded: 0, failed: 0 });
  });

  it('isolates a failing account', async () => {
    (userDb.getAllUsers as jest.Mock).mockResolvedValue([user('2026-11-01T00:00:00.000Z')]);
    (gmailService.listRawMessages as jest.Mock).mockRejectedValue(new Error('token revoked'));
    const s = await runGmailBounceMonitor();
    expect(s.failed).toBe(1);
  });
});
