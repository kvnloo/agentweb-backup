/**
 * Lead-list alerts over WhatsApp (ENG-273).
 *
 * The Slack path here is Block Kit and is deliberately left byte-identical — the
 * existing leadListAlertService suites are the proof. This covers the additive
 * WhatsApp path and, importantly, that neither channel can break the email baseline
 * that already landed before either is attempted.
 */

import { leadListAlertService } from '../services/leadListAlertService';

jest.mock('../services/db', () => ({
  crmDb: {},
  userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/emailService', () => ({
  emailService: { sendEmail: jest.fn(), escapeHtml: (s: string) => s },
}));
jest.mock('../services/slackService', () => ({ sendLeadNotification: jest.fn() }));
jest.mock('../services/whatsappService', () => ({
  TEMPLATES: jest.requireActual('../services/whatsappService').TEMPLATES,
  sendMessage: jest.fn(),
}));

const { sendLeadNotification } = require('../services/slackService');
const { userDb } = require('../services/db');
const whatsapp = require('../services/whatsappService');

const WA = { channel: 'whatsapp' as const, destination: '+14155550123', enabled: true };

const lead = {
  leadId: 'l1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  company: 'Analytical',
};
const list = {
  listId: 'list-1',
  name: 'Q3 Inbound',
  userId: 'u1',
  alertEvents: ['email.received'],
};

/** Drive the notifier the same way the production callers do. */
const notify = (user: any, theLead: any = lead) => {
  userDb.getUserById.mockResolvedValue(user);
  return leadListAlertService.notifyLeadListOwnerIfConfigured(
    list,
    theLead,
    'email.received',
    { subject: 'Hello' },
    '2026-08-04T00:00:00.000Z',
  );
};

beforeEach(() => {
  jest.resetAllMocks();
  whatsapp.sendMessage.mockResolvedValue({ messageId: 'wamid.1' });
});

describe('WhatsApp lead alerts', () => {
  it('sends to WhatsApp when the user has it configured', async () => {
    await notify({ userId: 'u1', email: 'u@e.com', messagingChannels: [WA] });
    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendMessage.mock.calls[0][0].destination).toBe('+14155550123');
  });

  it('does not send to WhatsApp when the user has not configured it', async () => {
    await notify({ userId: 'u1', email: 'u@e.com', slackChannel: 'C1' });
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  it('sends to Slack and WhatsApp independently when both are configured', async () => {
    await notify({ userId: 'u1', email: 'u@e.com', slackChannel: 'C1', messagingChannels: [WA] });
    expect(sendLeadNotification).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('carries the LEAD_ALERT template with its full declared variable count', async () => {
    await notify({ userId: 'u1', email: 'u@e.com', messagingChannels: [WA] });
    const sent = whatsapp.sendMessage.mock.calls[0][0];
    expect(sent.template.name).toBe('agentweb_lead_alert');
    expect(sent.template.variables).toHaveLength(2);
    expect(sent.template.variables[0]).toBe('Ada Lovelace');
  });

  it('falls back to the lead email when the lead has no name', async () => {
    await notify(
      { userId: 'u1', email: 'u@e.com', messagingChannels: [WA] },
      { ...lead, firstName: undefined, lastName: undefined },
    );
    expect(whatsapp.sendMessage.mock.calls[0][0].template.variables[0]).toBe('ada@example.com');
  });

  it('a WhatsApp failure never propagates — the email baseline already landed', async () => {
    whatsapp.sendMessage.mockRejectedValue(new Error('131047 window closed'));
    await expect(
      notify({ userId: 'u1', email: 'u@e.com', messagingChannels: [WA] }),
    ).resolves.not.toThrow();
  });

  it('a Slack failure does not prevent the WhatsApp send', async () => {
    sendLeadNotification.mockRejectedValue(new Error('channel_not_found'));
    await notify({ userId: 'u1', email: 'u@e.com', slackChannel: 'C1', messagingChannels: [WA] });
    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
  });
});
