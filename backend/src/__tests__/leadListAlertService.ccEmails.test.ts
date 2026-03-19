import { leadListAlertService } from '../services/leadListAlertService';
import { crmDb, userDb } from '../services/db';
import { emailService } from '../services/emailService';

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: jest.fn(),
    getLeadByEmail: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
    getUsersByEmailDomain: jest.fn(),
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendEmail: jest.fn(),
    escapeHtml: (value: string) => value,
  },
}));

jest.mock('../services/slackService', () => ({
  sendLeadNotification: jest.fn(),
}));

describe('leadListAlertService CC emails', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CUSTOMER_FRONTEND_URL = 'https://customer.example.com';
  });

  it('sends alert email with CC when alertCcEmails is configured', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ email: 'owner@example.com' });
    (emailService.sendEmail as jest.Mock).mockResolvedValue(undefined);

    await leadListAlertService.notifyLeadListOwnerIfConfigured(
      {
        listId: 'list-1',
        name: 'VIP Leads',
        userId: 'user-1',
        alertEvents: ['api.lead_added'],
        alertCcEmails: ['cc1@example.com', 'cc2@example.com'],
      },
      {
        leadId: 'lead-1',
        email: 'lead@test.com',
        firstName: 'John',
        lastName: 'Doe',
      },
      'api.lead_added',
      { source: 'website' },
      '2024-01-02T10:00:00.000Z'
    );

    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const call = (emailService.sendEmail as jest.Mock).mock.calls[0];
    // sendEmail(to, subject, text, html, cc)
    expect(call[0]).toBe('owner@example.com');
    expect(call[4]).toEqual(['cc1@example.com', 'cc2@example.com']);
  });

  it('sends alert email without CC when alertCcEmails is empty', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ email: 'owner@example.com' });
    (emailService.sendEmail as jest.Mock).mockResolvedValue(undefined);

    await leadListAlertService.notifyLeadListOwnerIfConfigured(
      {
        listId: 'list-1',
        name: 'VIP Leads',
        userId: 'user-1',
        alertEvents: ['api.lead_added'],
        alertCcEmails: [],
      },
      {
        leadId: 'lead-1',
        email: 'lead@test.com',
        firstName: 'John',
      },
      'api.lead_added',
      {},
      '2024-01-02T10:00:00.000Z'
    );

    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const call = (emailService.sendEmail as jest.Mock).mock.calls[0];
    expect(call[4]).toBeUndefined();
  });

  it('sends alert email without CC when alertCcEmails is not set', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ email: 'owner@example.com' });
    (emailService.sendEmail as jest.Mock).mockResolvedValue(undefined);

    await leadListAlertService.notifyLeadListOwnerIfConfigured(
      {
        listId: 'list-1',
        name: 'VIP Leads',
        userId: 'user-1',
        alertEvents: ['api.lead_added'],
      },
      {
        leadId: 'lead-1',
        email: 'lead@test.com',
        firstName: 'John',
      },
      'api.lead_added',
      {},
      '2024-01-02T10:00:00.000Z'
    );

    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const call = (emailService.sendEmail as jest.Mock).mock.calls[0];
    expect(call[4]).toBeUndefined();
  });

  it('passes CC emails through notifyForEmailEvent flow', async () => {
    (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([
      { userId: 'user-1', email: 'owner@example.com', emailDomain: 'example.com' },
    ]);
    (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([
      {
        listId: 'list-1',
        name: 'List One',
        userId: 'user-1',
        alertEvents: ['email.received'],
        alertCcEmails: ['manager@example.com'],
      },
    ]);
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
      leadId: 'lead-1',
      email: 'lead@company.com',
      firstName: 'Jane',
    });
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      email: 'owner@example.com',
      emailDomain: 'example.com',
    });
    (emailService.sendEmail as jest.Mock).mockResolvedValue(undefined);

    await leadListAlertService.notifyForEmailEvent({
      eventType: 'email.received',
      leadEmail: 'lead@company.com',
      emailDomain: 'example.com',
      data: { subject: 'Hello' },
      createdAt: '2024-03-01T10:00:00.000Z',
    });

    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const call = (emailService.sendEmail as jest.Mock).mock.calls[0];
    expect(call[4]).toEqual(['manager@example.com']);
  });
});
