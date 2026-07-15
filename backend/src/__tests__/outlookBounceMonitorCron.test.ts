/**
 * Tests for the ENG-266 Part 3 Outlook bounce/complaint monitor — the B+
 * compliance floor. Resend's webhook-based auto-DNC suppression cannot fire
 * for a mailbox send (Graph produces no Resend webhooks), so this rebuilds the
 * bounce half by polling the connected mailbox's inbox for NDRs via Mail.Read.
 */

jest.mock('../services/db', () => ({
  userDb: { getAllUsers: jest.fn() },
  crmDb: {
    getLeadListsByUserId: jest.fn(),
    getLeadByEmail: jest.fn(),
    updateLead: jest.fn(),
  },
}));

jest.mock('../services/connectedAccountsDb', () => ({
  updateAccountConfig: jest.fn(),
}));

jest.mock('../services/outlookService', () => ({
  outlookService: { listRecentInboxMessages: jest.fn() },
}));

import { runOutlookBounceMonitor, extractBounceCandidate } from '../cron/outlookBounceMonitorCron';
import { userDb, crmDb } from '../services/db';
import { updateAccountConfig } from '../services/connectedAccountsDb';
import { outlookService } from '../services/outlookService';

const mockGetAllUsers = userDb.getAllUsers as jest.Mock;
const mockGetLeadListsByUserId = crmDb.getLeadListsByUserId as jest.Mock;
const mockGetLeadByEmail = crmDb.getLeadByEmail as jest.Mock;
const mockUpdateLead = crmDb.updateLead as jest.Mock;
const mockUpdateAccountConfig = updateAccountConfig as jest.Mock;
const mockListRecentInboxMessages = outlookService.listRecentInboxMessages as jest.Mock;

beforeEach(() => jest.clearAllMocks());

const ndrMessage = (over: any = {}) => ({
  id: 'ndr-1',
  subject: 'Undeliverable: Hi there',
  receivedDateTime: '2026-07-14T10:00:00Z',
  from: 'Mail Delivery Subsystem <postmaster@baldwin.com>',
  body: 'The following recipient could not be reached: bad@contractor.com',
  ...over,
});

const outlookAccount = (over: any = {}) => ({
  platform: 'outlook',
  account_id: 'acct-1',
  account_name: 'Hunter',
  config: { account_type: 'outlook', email: 'hunter@baldwin.com', lastNdrCheckAt: '2026-07-13T00:00:00Z', ...over },
  created_at: '',
  updated_at: '',
});

// ─── extractBounceCandidate — pure classifier ─────────────────────────────────

describe('extractBounceCandidate — FAIL cases', () => {
  it('returns null for a normal (non-NDR) message', () => {
    expect(
      extractBounceCandidate({
        subject: 'Re: bonds',
        from: 'Lead <lead@contractor.com>',
        body: 'Sounds good, let\'s talk Tuesday.',
      }),
    ).toBeNull();
  });

  it('returns null when the subject looks like an NDR but no address can be extracted', () => {
    expect(
      extractBounceCandidate({
        subject: 'Undeliverable: Hi there',
        from: 'Mail Delivery Subsystem <postmaster@baldwin.com>',
        body: 'Delivery has failed. No further details available.',
      }),
    ).toBeNull();
  });

  it('returns null when neither the subject nor the sender look like an NDR, even with an email address in the body', () => {
    expect(
      extractBounceCandidate({
        subject: 'Following up',
        from: 'Lead <lead@contractor.com>',
        body: 'CC my colleague at colleague@contractor.com on this.',
      }),
    ).toBeNull();
  });
});

describe('extractBounceCandidate — SUCCESS cases', () => {
  it('extracts the recipient from a typical Exchange Online "Undeliverable:" NDR', () => {
    expect(extractBounceCandidate(ndrMessage())).toBe('bad@contractor.com');
  });

  it('matches on the postmaster/mailer-daemon sender pattern even with a non-obvious subject', () => {
    expect(
      extractBounceCandidate({
        subject: 'Delivery has failed',
        from: 'MAILER-DAEMON@baldwin.com',
        body: 'Your message to the following recipient(s) could not be delivered: dead@contractor.com',
      }),
    ).toBe('dead@contractor.com');
  });
});

// ─── runOutlookBounceMonitor — orchestration ───────────────────────────────────

describe('runOutlookBounceMonitor — FAIL cases', () => {
  it('returns an empty summary and does not throw when user enumeration fails', async () => {
    mockGetAllUsers.mockRejectedValue(new Error('dynamo down'));
    const summary = await runOutlookBounceMonitor();
    expect(summary.scannedUsers).toBe(0);
    expect(mockListRecentInboxMessages).not.toHaveBeenCalled();
  });

  it('does not flag a lead when the candidate address matches nothing in the user\'s lists', async () => {
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', connected_accounts: [outlookAccount()] }]);
    mockListRecentInboxMessages.mockResolvedValue([ndrMessage()]);
    mockGetLeadListsByUserId.mockResolvedValue([{ listId: 'list-1' }]);
    mockGetLeadByEmail.mockResolvedValue(null);

    const summary = await runOutlookBounceMonitor();

    expect(summary.ndrCandidatesFound).toBe(1);
    expect(summary.leadsFlagged).toBe(0);
    expect(mockUpdateLead).not.toHaveBeenCalled();
    // The cursor still advances even when nothing matched.
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith('u1', 'outlook', 'acct-1', { lastNdrCheckAt: '2026-07-14T10:00:00Z' });
  });

  it('does not double-flag a lead that is already do-not-contact', async () => {
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', connected_accounts: [outlookAccount()] }]);
    mockListRecentInboxMessages.mockResolvedValue([ndrMessage()]);
    mockGetLeadListsByUserId.mockResolvedValue([{ listId: 'list-1' }]);
    mockGetLeadByEmail.mockResolvedValue({ leadId: 'lead-1', email: 'bad@contractor.com', contactStatus: 'do-not-contact' });

    const summary = await runOutlookBounceMonitor();

    expect(mockUpdateLead).not.toHaveBeenCalled();
    expect(summary.leadsFlagged).toBe(0);
  });

  it('continues to the next account when one account throws', async () => {
    mockGetAllUsers.mockResolvedValue([
      { userId: 'u1', connected_accounts: [outlookAccount({ email: 'a@baldwin.com' })] },
      { userId: 'u2', connected_accounts: [outlookAccount({ email: 'b@baldwin.com' })] },
    ]);
    mockListRecentInboxMessages
      .mockRejectedValueOnce(new Error('token revoked'))
      .mockResolvedValueOnce([]);

    const summary = await runOutlookBounceMonitor();

    expect(summary.scannedUsers).toBe(2);
    expect(summary.failed).toBe(1);
  });
});

describe('runOutlookBounceMonitor — SUCCESS cases', () => {
  it('flags a matching, non-DNC lead as do-not-contact with the correct fields', async () => {
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', connected_accounts: [outlookAccount()] }]);
    mockListRecentInboxMessages.mockResolvedValue([ndrMessage()]);
    mockGetLeadListsByUserId.mockResolvedValue([{ listId: 'list-1' }]);
    mockGetLeadByEmail.mockResolvedValue({ leadId: 'lead-1', email: 'bad@contractor.com' });

    const summary = await runOutlookBounceMonitor();

    expect(mockUpdateLead).toHaveBeenCalledWith(
      'list-1',
      'lead-1',
      expect.objectContaining({
        contactStatus: 'do-not-contact',
        contactStatusReason: 'bounced',
        unsubscribedFromGroupEmail: true,
      }),
    );
    expect(summary.leadsFlagged).toBe(1);
  });

  it('seeds the cursor to "now" on the first-ever run per account, without acting on any messages returned', async () => {
    mockGetAllUsers.mockResolvedValue([
      { userId: 'u1', connected_accounts: [outlookAccount({ lastNdrCheckAt: undefined })] },
    ]);
    mockListRecentInboxMessages.mockResolvedValue([ndrMessage()]);

    await runOutlookBounceMonitor();

    // First run: seed the cursor, but do not treat the fetched message as a bounce to act on.
    expect(mockGetLeadListsByUserId).not.toHaveBeenCalled();
    expect(mockUpdateLead).not.toHaveBeenCalled();
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
      'u1', 'outlook', 'acct-1',
      expect.objectContaining({ lastNdrCheckAt: expect.any(String) }),
    );
  });
});
