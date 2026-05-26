/**
 * Tests for leadListAlertService.notifyLinkedInConnectionAccepted
 */

import { leadListAlertService } from '../services/leadListAlertService';
import { userDb } from '../services/db';
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

const LIST = {
  listId: 'list-1',
  name: 'Outreach List',
  userId: 'user-1',
  alertCcEmails: [] as string[],
};

const LEAD = {
  leadId: 'lead-1',
  listId: 'list-1',
  email: 'john@example.com',
  firstName: 'John',
  lastName: 'Prospect',
  linkedin: 'https://www.linkedin.com/in/john-prospect',
  company: 'Acme',
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CUSTOMER_FRONTEND_URL = 'https://app.example.com';
  (userDb.getUserById as jest.Mock).mockResolvedValue({ email: 'owner@example.com', userId: 'user-1' });
  (emailService.sendEmail as jest.Mock).mockResolvedValue(undefined);
});

describe('notifyLinkedInConnectionAccepted', () => {
  it('sends email to list owner with lead name in subject', async () => {
    await leadListAlertService.notifyLinkedInConnectionAccepted(LIST, LEAD);

    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject] = (emailService.sendEmail as jest.Mock).mock.calls[0];
    expect(to).toBe('owner@example.com');
    expect(subject).toBe('John Prospect accepted your LinkedIn invitation');
  });

  it('includes CRM deep-link with openEngagement=1 in email body', async () => {
    await leadListAlertService.notifyLinkedInConnectionAccepted(LIST, LEAD);

    const [, , text, html] = (emailService.sendEmail as jest.Mock).mock.calls[0];
    const expectedUrl = 'https://app.example.com/crm?listId=list-1&leadId=lead-1&openEngagement=1';
    expect(text).toContain(expectedUrl);
    expect(html).toContain(expectedUrl);
  });

  it('includes "Send a message on LinkedIn" CTA button in HTML', async () => {
    await leadListAlertService.notifyLinkedInConnectionAccepted(LIST, LEAD);

    const [, , , html] = (emailService.sendEmail as jest.Mock).mock.calls[0];
    expect(html).toContain('Send a message on LinkedIn');
    expect(html).toContain('openEngagement=1');
  });

  it('does not send email when user is not found', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(null);

    await leadListAlertService.notifyLinkedInConnectionAccepted(LIST, LEAD);

    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('does not send email when user has no email', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-1' });

    await leadListAlertService.notifyLinkedInConnectionAccepted(LIST, LEAD);

    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('sends with CC emails when alertCcEmails is set', async () => {
    const listWithCc = { ...LIST, alertCcEmails: ['cc1@example.com', 'cc2@example.com'] };

    await leadListAlertService.notifyLinkedInConnectionAccepted(listWithCc, LEAD);

    expect(emailService.sendEmail).toHaveBeenCalledWith(
      'owner@example.com',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      ['cc1@example.com', 'cc2@example.com'],
    );
  });

  it('falls back to CRM base URL in engagement link when lead has no leadId', async () => {
    const leadNoId = { ...LEAD, leadId: undefined };

    await leadListAlertService.notifyLinkedInConnectionAccepted(LIST, leadNoId as any);

    const [, , text] = (emailService.sendEmail as jest.Mock).mock.calls[0];
    expect(text).toContain('https://app.example.com/crm');
  });

  it('shows lead email in body when name differs from email', async () => {
    await leadListAlertService.notifyLinkedInConnectionAccepted(LIST, LEAD);

    const [, , text] = (emailService.sendEmail as jest.Mock).mock.calls[0];
    expect(text).toContain('John Prospect (john@example.com)');
  });

  it('hides lead email when name equals email', async () => {
    const leadEmailName = { ...LEAD, firstName: 'john@example.com', lastName: '' };

    await leadListAlertService.notifyLinkedInConnectionAccepted(LIST, leadEmailName);

    const [, , text] = (emailService.sendEmail as jest.Mock).mock.calls[0];
    expect(text).not.toMatch(/john@example\.com \(john@example\.com\)/);
  });
});
