/**
 * Regression test for ENG-265 review finding: sendEmailToLead and
 * sendEmailFromConfiguredSender (Emma's chat-driven send tools) used to call
 * the Resend/Gmail/Outlook provider APIs directly, bypassing sendAsSender
 * entirely — so a sender with a daily cap or an active warmup ramp could be
 * driven at unlimited volume from chat, with no enforcement at all.
 *
 * Both methods now resolve the sender via resolveSenderForSend and route the
 * actual send through sendAsSender, the same chokepoint every other send path
 * (crm.ts's single/bulk send routes, the drip worker) already uses. These
 * tests confirm a capped-out sender is blocked here too, and that the
 * provider is never called when that happens.
 */

const mockResendSendEmail = jest.fn();
jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: (...args: any[]) => mockResendSendEmail(...args),
  },
}));

const mockProviderSendEmail = jest.fn();
jest.mock('../services/emailProviderService', () => ({
  bootstrapEmailProviders: jest.fn(async () => undefined),
  getEmailProvider: jest.fn(() => ({ sendEmail: mockProviderSendEmail })),
  // ENG-1300: real impl — pure/deterministic, safe to keep real under this mock.
  emailProviderErrorStatus: jest.requireActual('../services/emailProviderService').emailProviderErrorStatus,
}));

// Real senderUsageTracker/sendAsSender run for real — only their DynamoDB deps
// are mocked, so this exercises the actual routing + cap-check wiring end to
// end rather than asserting against a mocked sendAsSender.
const mockReserveSend = jest.fn();
const mockReleaseSend = jest.fn();
jest.mock('../services/senderUsageTrackerFactory', () => ({
  senderUsageTracker: {
    reserveSend: (...args: any[]) => mockReserveSend(...args),
    releaseSend: (...args: any[]) => mockReleaseSend(...args),
    getUsage: jest.fn(),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn() },
}));

// ENG-673: the do-not-contact address guard has its own tests (contactGuard.test.ts); here it is controlled and defaults to "nobody blocked".
const mockBlockedRecipients = jest.fn().mockResolvedValue([]);
jest.mock('../services/contactGuard', () => ({
  blockedRecipients: (...a: any[]) => mockBlockedRecipients(...a),
  blockedMessage: (b: string[]) => `Not sent: ${b.join(', ')} is marked do-not-contact`,
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
const CAPPED_SENDER_ID = 'sender-capped';
const CAPPED_SENDER_EMAIL = 'sales@acme.com';

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(async () => ({ listId: 'list-1', userId: OWNER, name: 'Acme' })),
    getLeadById: jest.fn(async () => ({
      leadId: 'lead-1',
      email: 'lead@contractor.com',
      emailDraft: { subject: 'Hello', htmlContent: '<p>hi</p>' },
    })),
    updateLead: jest.fn(async () => undefined),
    claimLeadEmailDraft: jest.fn(async () => true),
    releaseLeadEmailDraftClaim: jest.fn(async () => undefined),
  },
}));

import { agentModeService } from '../services/agentModeService';
import { SenderDailyLimitExceededError } from '../services/senderUsageTracker';

const { settingsService } = require('../services/settingsService');

beforeEach(() => {
  jest.clearAllMocks();
  (settingsService.getSetting as jest.Mock).mockImplementation(async (name: string) => {
    if (name === `crm_sender_emails_${OWNER}`) {
      return {
        settingValue: JSON.stringify({
          senders: [{
            id: CAPPED_SENDER_ID,
            email: CAPPED_SENDER_EMAIL,
            fromName: 'Acme Sales',
            senderType: 'resend',
            dailyLimit: 5,
          }],
          defaultSenderId: CAPPED_SENDER_ID,
        }),
      };
    }
    return null;
  });
  mockReserveSend.mockRejectedValue(new SenderDailyLimitExceededError(CAPPED_SENDER_ID, 5));
});

describe('sendEmailToLead — daily-cap enforcement (ENG-265)', () => {
  it('blocks the send and never calls the provider once the sender is at its daily cap', async () => {
    const result = await (agentModeService as any).sendEmailToLead('list-1', 'lead-1', OWNER);

    expect(result.success).toBe(false);
    expect(result.message).toBe('Daily sending limit reached');
    expect(result.error).toContain('daily sending limit');
    expect(mockResendSendEmail).not.toHaveBeenCalled();
    expect(mockProviderSendEmail).not.toHaveBeenCalled();
    expect(mockReserveSend).toHaveBeenCalledWith(OWNER, CAPPED_SENDER_ID, 5);
    expect(mockReleaseSend).not.toHaveBeenCalled();
  });

  it('sends normally when the sender is under its cap', async () => {
    mockReserveSend.mockResolvedValue(undefined);
    mockResendSendEmail.mockResolvedValue({ id: 'email-1' });

    const result = await (agentModeService as any).sendEmailToLead('list-1', 'lead-1', OWNER);

    expect(result.success).toBe(true);
    expect(mockResendSendEmail).toHaveBeenCalledTimes(1);
    expect(mockReserveSend).toHaveBeenCalledWith(OWNER, CAPPED_SENDER_ID, 5);
    expect(mockReleaseSend).not.toHaveBeenCalled();
  });
});

describe('sendEmailFromConfiguredSender — do-not-contact (ENG-673)', () => {
  it('refuses an address that belongs to a do-not-contact lead, sends nothing and uses no daily-cap slot', async () => {
    mockBlockedRecipients.mockResolvedValueOnce(['someone@external.com']);
    const result = await (agentModeService as any).sendEmailFromConfiguredSender(OWNER, { to: 'someone@external.com', subject: 'Hello', html: '<p>Hi</p>' });
    expect(result).toEqual(expect.objectContaining({ success: false, reason: 'do_not_contact', code: 409 }));
    expect(mockBlockedRecipients).toHaveBeenCalledWith([OWNER], 'someone@external.com');
    expect(mockReserveSend).not.toHaveBeenCalled();
    expect(mockResendSendEmail).not.toHaveBeenCalled();
    expect(mockProviderSendEmail).not.toHaveBeenCalled();
  });
});

describe('sendEmailFromConfiguredSender — daily-cap enforcement (ENG-265)', () => {
  it('blocks the send and never calls the provider once the sender is at its daily cap', async () => {
    const result = await (agentModeService as any).sendEmailFromConfiguredSender(OWNER, {
      to: 'someone@external.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe('Daily sending limit reached');
    expect(mockResendSendEmail).not.toHaveBeenCalled();
    expect(mockProviderSendEmail).not.toHaveBeenCalled();
    expect(mockReleaseSend).not.toHaveBeenCalled();
  });

  it('sends normally when the sender is under its cap', async () => {
    mockReserveSend.mockResolvedValue(undefined);
    mockResendSendEmail.mockResolvedValue({ id: 'email-2' });

    const result = await (agentModeService as any).sendEmailFromConfiguredSender(OWNER, {
      to: 'someone@external.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
    });

    expect(result.success).toBe(true);
    expect(mockResendSendEmail).toHaveBeenCalledTimes(1);
    expect(mockReserveSend).toHaveBeenCalledWith(OWNER, CAPPED_SENDER_ID, 5);
    expect(mockReleaseSend).not.toHaveBeenCalled();
  });
});
