/**
 * ENG-2984: send_email_to_lead claims the stored draft atomically (conditional REMOVE on the
 * existing draft value, draft kept until success) before the provider call, so two concurrent invocations for the same
 * lead produce at most one send; a failed send releases the claim, and a crash leaves the draft for a retry after the lease.
 *
 * The DB mock models DynamoDB's conditional semantics on one in-memory row: claim succeeds only
 * while the stored draft still equals the expected value. Real sendAsSender runs; only the
 * provider and the usage tracker's DynamoDB are mocked.
 */

const mockResendSendEmail = jest.fn();
jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: (...args: any[]) => mockResendSendEmail(...args) },
}));

jest.mock('../services/emailProviderService', () => ({
  bootstrapEmailProviders: jest.fn(async () => undefined),
  getEmailProvider: jest.fn(() => ({ sendEmail: jest.fn() })),
  emailProviderErrorStatus: jest.requireActual('../services/emailProviderService').emailProviderErrorStatus,
}));

jest.mock('../services/senderUsageTrackerFactory', () => ({
  senderUsageTracker: {
    reserveSend: jest.fn(async () => undefined),
    releaseSend: jest.fn(async () => undefined),
    getUsage: jest.fn(),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn() },
}));

jest.mock('../services/contactGuard', () => ({
  blockedRecipients: jest.fn(async () => []),
  blockedMessage: (b: string[]) => `Not sent: ${b.join(', ')}`,
}));

jest.mock('../services/crmAccessControl', () => ({
  canDestructiveCrmList: jest.fn(async () => true),
  CRM_EDITOR_REQUIRED_MESSAGE: 'Editor access required',
}));

jest.mock('../utils/leadContactStatus', () => ({
  isDoNotContact: jest.fn(() => false),
  getDoNotContactReason: jest.fn(() => null),
}));

const OWNER = 'user-1';
const DRAFT = { subject: 'Hello', htmlContent: '<p>hi</p>', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };

// One in-memory AW-Leads row.
const row: { emailDraft: any; claimedAt: number | null } = { emailDraft: null, claimedAt: null };
const LEASE_MS = 5 * 60 * 1000;

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(async () => ({ listId: 'list-1', userId: OWNER, name: 'Acme' })),
    getLeadById: jest.fn(async () => ({
      leadId: 'lead-1',
      email: 'lead@contractor.com',
      emailDraft: row.emailDraft ? { ...row.emailDraft } : undefined,
    })),
    updateLead: jest.fn(async (_l: string, _id: string, updates: any) => {
      if (updates.emailDraft === null) row.emailDraft = null;
    }),
    claimLeadEmailDraft: jest.fn(async (_l: string, _id: string, expected: any) => {
      if (!row.emailDraft || JSON.stringify(row.emailDraft) !== JSON.stringify(expected)) return false;
      if (row.claimedAt !== null && row.claimedAt >= Date.now() - LEASE_MS) return false;
      row.claimedAt = Date.now();
      return true;
    }),
    releaseLeadEmailDraftClaim: jest.fn(async () => {
      row.claimedAt = null;
    }),
  },
}));

import { agentModeService } from '../services/agentModeService';

const { settingsService } = require('../services/settingsService');
const { crmDb } = require('../services/db');

beforeEach(() => {
  jest.clearAllMocks();
  row.emailDraft = { ...DRAFT };
  row.claimedAt = null;
  (settingsService.getSetting as jest.Mock).mockImplementation(async (name: string) => {
    if (name === `crm_sender_emails_${OWNER}`) {
      return {
        settingValue: JSON.stringify({
          senders: [{ id: 's1', email: 'sales@acme.com', fromName: 'Acme', senderType: 'resend' }],
          defaultSenderId: 's1',
        }),
      };
    }
    return null;
  });
});

const send = () => (agentModeService as any).sendEmailToLead('list-1', 'lead-1', OWNER);

describe('sendEmailToLead — atomic draft claim (ENG-2984)', () => {
  it('two concurrent invocations for the same lead produce exactly one provider send', async () => {
    mockResendSendEmail.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { id: 'email-1' };
    });

    const results = await Promise.all([send(), send()]);

    expect(mockResendSendEmail).toHaveBeenCalledTimes(1);
    expect(results.filter((r: any) => r.success)).toHaveLength(1);
    const loser = results.find((r: any) => !r.success);
    expect(loser.message).toBe('Email draft already sent or changed');
    expect(row.emailDraft).toBeNull();
  });

  it('claims the draft before the provider is called', async () => {
    mockResendSendEmail.mockImplementation(async () => {
      expect(row.claimedAt).not.toBeNull();
      expect(row.emailDraft).toEqual(DRAFT);
      return { id: 'email-1' };
    });
    const result = await send();
    expect(result.success).toBe(true);
    expect(crmDb.claimLeadEmailDraft).toHaveBeenCalledWith('list-1', 'lead-1', expect.objectContaining({ subject: 'Hello' }));
  });

  it('keeps the draft and releases the claim when the provider send fails', async () => {
    mockResendSendEmail.mockRejectedValue(new Error('Resend API error: boom'));
    const result = await send();
    expect(result.success).toBe(false);
    expect(crmDb.releaseLeadEmailDraftClaim).toHaveBeenCalledTimes(1);
    expect(row.emailDraft).toEqual(DRAFT);
    expect(row.claimedAt).toBeNull();
  });

  it('a crash mid-send never deletes the draft; a retry after the claim lease expires sends it', async () => {
    // Simulate the process dying after the claim, before the provider returned: claim set, nothing released.
    row.claimedAt = Date.now();
    expect(row.emailDraft).toEqual(DRAFT);

    // Immediate retry is refused (claim still fresh) — no duplicate send.
    const early = await send();
    expect(early.success).toBe(false);
    expect(mockResendSendEmail).not.toHaveBeenCalled();
    expect(row.emailDraft).toEqual(DRAFT);

    // After the lease expires the draft is still there and a retry sends it once.
    row.claimedAt = Date.now() - LEASE_MS - 1;
    mockResendSendEmail.mockResolvedValue({ id: 'email-2' });
    const retry = await send();
    expect(retry.success).toBe(true);
    expect(mockResendSendEmail).toHaveBeenCalledTimes(1);
    expect(row.emailDraft).toBeNull();
    expect(row.claimedAt).toBeNull();
  });

  it('a single non-concurrent send behaves as before: one send, success, draft cleared', async () => {
    mockResendSendEmail.mockResolvedValue({ id: 'email-1' });
    const result = await send();
    expect(result).toEqual(expect.objectContaining({ success: true, emailId: 'email-1', to: 'lead@contractor.com', subject: 'Hello' }));
    expect(mockResendSendEmail).toHaveBeenCalledTimes(1);
    expect(crmDb.updateLead).toHaveBeenCalledWith('list-1', 'lead-1', { emailDraft: null });
    expect(row.emailDraft).toBeNull();
    expect(row.claimedAt).toBeNull();
  });
});
