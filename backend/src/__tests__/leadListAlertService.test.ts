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

describe('leadListAlertService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CUSTOMER_FRONTEND_URL = 'https://customer.example.com';
  });

  it('sends alert email with CRM link and avoids repeating lead email', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ email: 'owner@example.com' });
    (emailService.sendEmail as jest.Mock).mockResolvedValue(undefined);

    await leadListAlertService.notifyLeadListOwnerIfConfigured(
      {
        listId: 'list-1',
        name: 'VIP Leads',
        userId: 'user-1',
        alertEvents: ['email.received'],
      },
      {
        leadId: 'lead-1',
        email: 'eve.h@apexgroup.co',
        firstName: 'eve.h@apexgroup.co',
        lastName: '',
      },
      'email.received',
      { subject: 'Hello' },
      '2024-01-02T10:00:00.000Z'
    );

    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
    const textContent = emailCall[2] as string;
    const htmlContent = emailCall[3] as string;

    expect(textContent).toContain('Lead: eve.h@apexgroup.co');
    expect(textContent).not.toContain('eve.h@apexgroup.co (eve.h@apexgroup.co)');
    expect(textContent).toContain('https://customer.example.com/crm');
    expect(htmlContent).toContain('https://customer.example.com/crm');
  });

  it('notifies list owner when alert event matches and lead exists', async () => {
    (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([
      { userId: 'user-1', email: 'owner@example.com', emailDomain: 'example.com' },
    ]);
    (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([
      { listId: 'list-1', name: 'List One', userId: 'user-1', alertEvents: ['email.clicked'] },
    ]);
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
      leadId: 'lead-1',
      email: 'lead@example.com',
      firstName: 'Lead',
      lastName: 'One',
    });
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      email: 'owner@example.com',
      emailDomain: 'example.com',
    });
    (emailService.sendEmail as jest.Mock).mockResolvedValue(undefined);

    await leadListAlertService.notifyForEmailEvent({
      eventType: 'email.clicked',
      leadEmail: 'lead@example.com',
      emailDomain: 'example.com',
      data: { click: { link: 'https://example.com' } },
      createdAt: '2024-02-01T12:00:00.000Z',
    });

    expect(userDb.getUsersByEmailDomain).toHaveBeenCalledWith('example.com');
    expect(crmDb.getLeadListsByUserId).toHaveBeenCalledWith('user-1');
    expect(crmDb.getLeadByEmail).toHaveBeenCalledWith('list-1', 'lead@example.com');
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  describe('system email filtering', () => {
    const systemEmails = [
      'no-reply@example.com',
      'noreply@example.com',
      'do-not-reply@example.com',
      'donotreply@example.com',
      'mailer-daemon@example.com',
      'postmaster@example.com',
      'NO-REPLY@EXAMPLE.COM',
    ];

    it.each(systemEmails)(
      'does not send alert for system email: %s',
      async (systemEmail) => {
        await leadListAlertService.notifyForEmailEvent({
          eventType: 'email.received',
          leadEmail: systemEmail,
          emailDomain: 'example.com',
          data: { subject: 'Auto-generated message' },
          createdAt: '2024-03-01T10:00:00.000Z',
        });

        expect(userDb.getUsersByEmailDomain).not.toHaveBeenCalled();
        expect(emailService.sendEmail).not.toHaveBeenCalled();
      }
    );

    it('still sends alert for regular lead emails', async () => {
      (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([
        { userId: 'user-1', email: 'owner@example.com', emailDomain: 'example.com' },
      ]);
      (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([
        { listId: 'list-1', name: 'List One', userId: 'user-1', alertEvents: ['email.received'] },
      ]);
      (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
        leadId: 'lead-1',
        email: 'real-person@company.com',
        firstName: 'Jane',
        lastName: 'Doe',
      });
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        email: 'owner@example.com',
        emailDomain: 'example.com',
      });
      (emailService.sendEmail as jest.Mock).mockResolvedValue(undefined);

      await leadListAlertService.notifyForEmailEvent({
        eventType: 'email.received',
        leadEmail: 'real-person@company.com',
        emailDomain: 'example.com',
        data: { subject: 'Interested in your product' },
        createdAt: '2024-03-01T10:00:00.000Z',
      });

      expect(userDb.getUsersByEmailDomain).toHaveBeenCalled();
      expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    });

    it('does not filter system-like substrings in normal emails', async () => {
      (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([
        { userId: 'user-1', email: 'owner@example.com', emailDomain: 'example.com' },
      ]);
      (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([
        { listId: 'list-1', name: 'List One', userId: 'user-1', alertEvents: ['email.received'] },
      ]);
      (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
        leadId: 'lead-1',
        email: 'reply-needed@example.com',
        firstName: 'Bob',
      });
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        email: 'owner@example.com',
        emailDomain: 'example.com',
      });
      (emailService.sendEmail as jest.Mock).mockResolvedValue(undefined);

      await leadListAlertService.notifyForEmailEvent({
        eventType: 'email.received',
        leadEmail: 'reply-needed@example.com',
        emailDomain: 'example.com',
        data: { subject: 'Question' },
        createdAt: '2024-03-01T10:00:00.000Z',
      });

      expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    });
  });
});
