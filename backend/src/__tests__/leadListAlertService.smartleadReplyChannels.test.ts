/**
 * ENG-2737: a Smartlead reply reads as a sentence on Slack and WhatsApp too, not as the raw event name `email.received`. Only that one alert
 * changes: every other event, and an `email.received` that did not come through Smartlead, sends exactly what it sent before.
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

const WA = {
  channel: 'whatsapp' as const,
  destination: '+14155550123',
  enabled: true,
  optIn: { at: '2026-08-01T00:00:00.000Z', source: 'inbound_verification', verifiedAt: '2026-08-01T00:00:00.000Z' },
};
const lead = { leadId: 'l1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', company: 'Analytical' };
const list = { listId: 'list-1', name: 'Q3 Inbound', userId: 'u1', alertEvents: ['email.received', 'email.opened'] };
const onSlack = { userId: 'u1', email: 'u@e.com', slackChannel: 'C1' };
const onWhatsApp = { userId: 'u1', email: 'u@e.com', messagingChannels: [WA] };
const SMARTLEAD = { source: 'smartlead', subject: 'Re: hello', campaign: 'Q4 push' };

const notify = (user: any, eventData: any, theLead: any = lead, eventType = 'email.received') => {
  userDb.getUserById.mockResolvedValue(user);
  return leadListAlertService.notifyLeadListOwnerIfConfigured(list, theLead, eventType, eventData, '2026-11-04T09:48:29.000Z');
};
const waSent = () => whatsapp.sendMessage.mock.calls[0][0];
const slackSent = () => sendLeadNotification.mock.calls[0][1];

beforeEach(() => {
  jest.resetAllMocks();
  whatsapp.sendMessage.mockResolvedValue({ messageId: 'wamid.1' });
  sendLeadNotification.mockResolvedValue(undefined);
});

describe('Slack', () => {
  it('shows a Smartlead reply as a sentence, keeping the event name and the rest of the payload', async () => {
    await notify(onSlack, SMARTLEAD);
    expect(sendLeadNotification).toHaveBeenCalledTimes(1);
    expect(sendLeadNotification.mock.calls[0][0]).toBe('C1');
    expect(slackSent()).toMatchObject({
      headline: 'A new lead "Ada Lovelace" replied to your campaign', eventType: 'email.received', email: 'ada@example.com', listName: 'Q3 Inbound', firstName: 'Ada',
    });
  });

  it('falls back to the address, and to a plain sentence when there is neither', async () => {
    await notify(onSlack, SMARTLEAD, { leadId: 'l2', email: 'bo@example.com' });
    expect(slackSent().headline).toBe('A new lead "bo@example.com" replied to your campaign');
    sendLeadNotification.mockClear();
    // neither a name nor an address: a plain sentence, never the lead's database id
    await notify(onSlack, SMARTLEAD, { leadId: 'l3', firstName: '', lastName: '' });
    expect(slackSent().headline).toBe('A new lead replied to your campaign');
  });

  it('sends NO headline for an email.received that did not come through Smartlead, or for any other event', async () => {
    await notify(onSlack, { subject: 'Hello' });
    expect('headline' in slackSent()).toBe(false);
    sendLeadNotification.mockClear();
    await notify(onSlack, { source: 'gmail', subject: 'Hello' });
    expect('headline' in slackSent()).toBe(false);
    sendLeadNotification.mockClear();
    await notify(onSlack, { source: 'smartlead' }, lead, 'email.opened');
    expect('headline' in slackSent()).toBe(false);
    expect(slackSent().eventType).toBe('email.opened');
  });
});

describe('WhatsApp', () => {
  it('opens with the SAME sentence as the email subject and the Slack header, then the list and the CRM link', async () => {
    const url = `${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/crm?listId=list-1`;
    const sentence = 'A new lead "Ada Lovelace" replied to your campaign';
    await notify(onWhatsApp, SMARTLEAD);
    expect(waSent().text).toBe(`${sentence}. List: Q3 Inbound. ${url}`);
    expect(waSent().template.name).toBe('agentweb_lead_alert');
    expect(waSent().template.variables).toEqual([sentence, `List: Q3 Inbound. ${url}`]);
    expect(JSON.stringify(waSent())).not.toContain('email.received');
    // the same sentence on the other two channels, from the same input
    const { emailService } = require('../services/emailService');
    expect(emailService.sendEmail.mock.calls[0][1]).toBe(sentence);
    await notify(onSlack, SMARTLEAD);
    expect(slackSent().headline).toBe(sentence);
  });

  it("keeps the contact's name to one safe line, and falls back to the address, then to a plain sentence", async () => {
    await notify(onWhatsApp, SMARTLEAD, { ...lead, firstName: 'Ann\nBob‮', lastName: '\t' });
    expect(waSent().template.variables[0]).toBe('A new lead "Ann Bob" replied to your campaign');
    expect(waSent().template.variables[0]).not.toMatch(/[\n\r\t‮]/);
    whatsapp.sendMessage.mockClear();
    await notify(onWhatsApp, SMARTLEAD, { leadId: 'l2', email: 'bo@example.com' });
    expect(waSent().template.variables[0]).toBe('A new lead "bo@example.com" replied to your campaign');
    whatsapp.sendMessage.mockClear();
    await notify(onWhatsApp, SMARTLEAD, { leadId: 'l3' });
    expect(waSent().template.variables).toHaveLength(2);
    expect(waSent().template.variables[0]).toBe('A new lead replied to your campaign');
    expect(JSON.stringify(waSent())).not.toContain('l3');
  });

  it('is exactly as before for an email.received that did not come through Smartlead, and for any other event', async () => {
    const url = `${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/crm?listId=list-1`;
    await notify(onWhatsApp, { subject: 'Hello' });
    expect(waSent().text).toBe(`Ada Lovelace — email.received on Q3 Inbound. ${url}`);
    expect(waSent().template.variables).toEqual(['Ada Lovelace', `email.received on Q3 Inbound. ${url}`]);
    whatsapp.sendMessage.mockClear();
    await notify(onWhatsApp, { source: 'smartlead' }, lead, 'email.opened');
    expect(waSent().text).toBe(`Ada Lovelace — email.opened on Q3 Inbound. ${url}`);
  });
});

describe('Email (the same contact name as the other channels)', () => {
  const { emailService } = require('../services/emailService');
  const sent = () => emailService.sendEmail.mock.calls[0] as [string, string, string, string];

  it('uses the name, else the address, else a plain sentence, and never a phone number or the lead id', async () => {
    await notify(onSlack, SMARTLEAD);
    expect(sent()[1]).toBe('A new lead "Ada Lovelace" replied to your campaign');

    emailService.sendEmail.mockClear();
    await notify(onSlack, SMARTLEAD, { leadId: 'lead_secret_id_9', email: 'bo@example.com' });
    expect(sent()[1]).toBe('A new lead "bo@example.com" replied to your campaign');

    emailService.sendEmail.mockClear();
    await notify(onSlack, SMARTLEAD, { leadId: 'lead_secret_id_9', phone: '2125559876', firstName: '', lastName: '' });
    const [, subject, text, html] = sent();
    expect(subject).toBe('A new lead replied to your campaign');
    // The button and the "View contact" line carry a link that legitimately contains the lead id; what must not appear is the id or the
    // phone number as the contact's NAME, so links are removed before looking.
    const visible = (body: string) => body.replace(/https?:\/\/[^\s"<]+/g, '');
    for (const body of [subject, visible(text), visible(html)]) {
      expect(body).not.toContain('lead_secret_id_9');
      expect(body).not.toContain('2125559876');
      expect(body).not.toContain('Unknown lead');
    }
  });

  it('is still the generic alert email for an email.received that did not come through Smartlead', async () => {
    await notify(onSlack, { subject: 'Hello' }, { leadId: 'lead_secret_id_9', phone: '2125559876', firstName: '', lastName: '' });
    expect(sent()[1]).toBe('Lead list alert: email.received');
  });
});
