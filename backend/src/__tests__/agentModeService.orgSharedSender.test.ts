/**
 * Regression test for ENG-299.
 *
 * sendEmailToLead deliberately resolves the sender from the LIST OWNER's config
 * ("so org members can send using the owner's senders"), but then called the email
 * provider with the ACTOR's userId. The connected account lives on the owner's
 * record, so getAccountById(accountId, actorUserId) found nothing and the send
 * failed with "account not connected" — for a sender the UI happily offered.
 *
 * The owner's id also matters for the WRITE side: a refreshed (and, for Outlook,
 * rotated) token must be persisted back onto the OWNER's account, not the actor's.
 */

import { agentModeService } from '../services/agentModeService';

const OWNER = 'owner-user-1';
const ACTOR = 'org-member-2';
const ACCOUNT_ID = 'habeb@baldwin.com';

const sendEmail = jest.fn();

jest.mock('../services/emailProviderService', () => ({
  bootstrapEmailProviders: jest.fn(async () => undefined),
  getEmailProvider: jest.fn(() => ({ sendEmail })),
}));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn() },
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(async () => ({ listId: 'list-1', userId: OWNER, name: 'Baldwin' })),
    canOrgMemberAccessList: jest.fn(async () => true),
    getLeadById: jest.fn(async () => ({
      leadId: 'lead-1',
      email: 'lead@contractor.com',
      emailDraft: { subject: 'Surety bonds', htmlContent: '<p>hi</p>' },
    })),
    updateLead: jest.fn(async () => undefined),
    addEngagement: jest.fn(async () => undefined),
  },
  userDb: {
    getUserById: jest.fn(async (id: string) => ({ userId: id, orgId: 'org-A' })),
  },
  orgDb: {
    getOrgMembers: jest.fn(async () => []),
    getOrgById: jest.fn(async () => ({
      orgId: 'org-A',
      ownerUserId: 'org-owner-id',
      shareSettings: { crm: { enabled: true, editors: [ACTOR] } },
    })),
  },
}));

const { settingsService } = require('../services/settingsService');

beforeEach(() => {
  jest.clearAllMocks();
  sendEmail.mockResolvedValue({ messageId: 'sent-1', threadId: 't-1' });

  // The OWNER has an Outlook sender configured. The ACTOR has none.
  (settingsService.getSetting as jest.Mock).mockImplementation(async (name: string) => {
    if (name === `crm_sender_emails_${OWNER}`) {
      return {
        settingValue: JSON.stringify({
          senders: [{
            id: 's1',
            email: 'habeb@baldwin.com',
            fromName: 'Habeb',
            senderType: 'outlook',
            connectedAccountId: ACCOUNT_ID,
          }],
          defaultSenderId: 's1',
        }),
      };
    }
    return null; // the actor has no sender config of their own
  });
});

describe('sendEmailToLead — org member sending from the list owner’s mailbox sender (ENG-299)', () => {
  it('calls the email provider with the OWNER’s userId, not the actor’s', async () => {
    await (agentModeService as any).sendEmailToLead('list-1', 'lead-1', ACTOR);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [passedUserId, passedAccountId] = sendEmail.mock.calls[0];

    // Before the fix this was ACTOR, and the provider threw "account not connected"
    // because the account lives on the owner's record.
    expect(passedUserId).toBe(OWNER);
    expect(passedAccountId).toBe(ACCOUNT_ID);
  });

  it('still works when the actor IS the owner', async () => {
    await (agentModeService as any).sendEmailToLead('list-1', 'lead-1', OWNER);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe(OWNER);
  });
});
