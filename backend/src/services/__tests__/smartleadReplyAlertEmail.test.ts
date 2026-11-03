/**
 * ENG-673: the email a list owner gets when a contact replies through Smartlead. It is customer-facing, so these tests pin the wording rules
 * (no internal event name, a zone on the time, one button) and the safety rules (a contact controls its name and the reply subject), and that
 * every OTHER lead list alert keeps the generic email it has today.
 */
jest.mock('../db', () => ({ crmDb: {}, userDb: { getUserById: jest.fn() }, orgDb: {} }));
jest.mock('../emailService', () => ({
  emailService: {
    sendEmail: jest.fn().mockResolvedValue(undefined),
    escapeHtml: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  },
}));
jest.mock('../slackService', () => ({ sendLeadNotification: jest.fn() }));
jest.mock('../messagingChannelService', () => ({
  bootstrapMessagingChannels: jest.fn(),
  getMessagingChannel: jest.fn(),
  hasVerifiedWhatsApp: jest.fn().mockReturnValue(false),
  resolveDestination: jest.fn(),
}));
jest.mock('../whatsappService', () => ({ TEMPLATES: {} }));

import { buildSmartleadReplyAlertEmail, formatUtcTime, isSmartleadReplyAlert } from '../smartleadReplyAlertEmail';
import { leadListAlertService } from '../leadListAlertService';
import { userDb } from '../db';
import { emailService } from '../emailService';

const base = {
  leadName: 'Manan Test',
  leadEmail: 'mvarma@argusoft.com',
  listName: 'Q4 outreach',
  campaignName: 'Q4 campaign',
  replySubject: 'Re: Quick question',
  receivedAt: '2026-11-03T09:23:00.000Z',
  contactUrl: 'https://app.agentweb.pro/crm?listId=L&leadId=A&openEngagement=1',
};

describe('the Smartlead reply alert email', () => {
  it('says who replied in plain words, never an internal event name or a raw id', () => {
    const e = buildSmartleadReplyAlertEmail(base);
    expect(e.subject).toBe('Manan Test replied to your campaign');
    for (const part of [e.subject, e.text, e.html]) {
      expect(part).not.toMatch(/email\.received|list_|lead_/);
    }
    expect(e.text).toContain('Manan Test (mvarma@argusoft.com) replied to an email sent from your Smartlead campaign.');
    expect(e.text).toContain('Campaign: Q4 campaign');
    expect(e.text).toContain('Lead list: Q4 outreach');
    expect(e.text).toContain('Subject: Re: Quick question');
    expect(e.html).toContain('View contact in AgentWeb');
    expect(e.html).toContain('href="https://app.agentweb.pro/crm?listId=L&amp;leadId=A&amp;openEngagement=1"');
  });

  it('always shows the time with its zone', () => {
    expect(formatUtcTime('2026-11-03T09:23:00.000Z')).toBe('Nov 3, 2026, 9:23 AM UTC');
    expect(formatUtcTime('2026-11-03T21:05:00.000Z')).toBe('Nov 3, 2026, 9:05 PM UTC');
    expect(formatUtcTime('not a time')).toBeUndefined();
    expect(formatUtcTime(undefined)).toBeUndefined();
    expect(buildSmartleadReplyAlertEmail(base).text).toContain('Received: Nov 3, 2026, 9:23 AM UTC');
    expect(buildSmartleadReplyAlertEmail({ ...base, receivedAt: 'junk' }).text).not.toContain('Received:');
  });

  it('shows an address once when the name is the address, and falls back to "A contact"', () => {
    const same = buildSmartleadReplyAlertEmail({ ...base, leadName: 'mvarma@argusoft.com' });
    expect(same.subject).toBe('mvarma@argusoft.com replied to your campaign');
    expect(same.text).toContain('mvarma@argusoft.com replied to an email');
    expect(same.text).not.toContain('(mvarma@argusoft.com)');
    const none = buildSmartleadReplyAlertEmail({ ...base, leadName: '', leadEmail: '' });
    expect(none.subject).toBe('A contact replied to your campaign');
  });

  it('leaves out what is missing instead of printing a placeholder, and has no button without a link', () => {
    const e = buildSmartleadReplyAlertEmail({ leadName: 'Ann', listName: 'L1' });
    expect(e.text).not.toMatch(/Campaign:|Subject:|Received:|undefined|null/);
    expect(e.html).not.toContain('View contact in AgentWeb');
    expect(e.html).not.toMatch(/undefined|null/);
  });

  it('cannot be turned against the owner by a contact-controlled name or subject', () => {
    const e = buildSmartleadReplyAlertEmail({
      ...base,
      leadName: 'Eve\r\nBcc: victim@example.com <script>alert(1)</script>',
      replySubject: '"><img src=x onerror=alert(1)>',
      campaignName: '<b>x</b>',
      contactUrl: 'javascript:alert(1)',
    });
    expect(e.subject).not.toMatch(/[\r\n]/);
    expect(e.html).not.toMatch(/<script|<img|<b>x/);
    expect(e.html).toContain('&lt;script&gt;');
    expect(e.html).not.toContain('javascript:');
    expect(e.html).not.toContain('View contact in AgentWeb'); // a non-http link is dropped, so no button
  });

  it('keeps a very long name and subject short', () => {
    const e = buildSmartleadReplyAlertEmail({ ...base, leadName: 'N'.repeat(500), replySubject: 'S'.repeat(500) });
    expect(e.subject.length).toBeLessThanOrEqual(80);
    expect(e.text).not.toContain('S'.repeat(250));
  });

  it('tells a Smartlead reply from every other alert', () => {
    expect(isSmartleadReplyAlert('email.received', { source: 'smartlead' })).toBe(true);
    expect(isSmartleadReplyAlert(' Email.Received ', { source: 'smartlead' })).toBe(true);
    expect(isSmartleadReplyAlert('email.received', { source: 'resend' })).toBe(false);
    expect(isSmartleadReplyAlert('email.received', {})).toBe(false);
    expect(isSmartleadReplyAlert('email.received', undefined)).toBe(false);
    expect(isSmartleadReplyAlert('email.bounced', { source: 'smartlead' })).toBe(false);
  });
});

describe('the lead list alert uses it only for a Smartlead reply', () => {
  const list = { listId: 'list_1', userId: 'u1', name: 'Q4 outreach', alertEvents: ['email.received', 'email.bounced'], alertCcEmails: ['cc@example.com'] };
  const lead = { listId: 'list_1', leadId: 'lead_1', firstName: 'Manan', lastName: 'Test', email: 'mvarma@argusoft.com' };
  const send = emailService.sendEmail as jest.Mock;
  beforeEach(() => {
    send.mockClear();
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'u1', email: 'owner@mindd.example' });
  });

  it('a Smartlead reply sends the new email, with the list CC addresses', async () => {
    await leadListAlertService.notifyLeadListOwnerIfConfigured(list, lead, 'email.received', { source: 'smartlead', subject: 'Re: Hi', campaign: 'Q4 campaign' }, '2026-11-03T09:23:00.000Z');
    expect(send).toHaveBeenCalledTimes(1);
    const [to, subject, text, html, cc] = send.mock.calls[0];
    expect(to).toBe('owner@mindd.example');
    expect(subject).toBe('Manan Test replied to your campaign');
    expect(text).toContain('Campaign: Q4 campaign');
    expect(html).toContain('View contact in AgentWeb');
    expect(cc).toEqual(['cc@example.com']);
  });

  it('the same event from anywhere else, and every other event, keeps the generic email exactly as before', async () => {
    await leadListAlertService.notifyLeadListOwnerIfConfigured(list, lead, 'email.received', { source: 'resend', subject: 'Re: Hi' }, '2026-11-03T09:23:00.000Z');
    await leadListAlertService.notifyLeadListOwnerIfConfigured(list, lead, 'email.bounced', { source: 'smartlead' }, '2026-11-03T09:23:00.000Z');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][1]).toBe('Lead list alert: email.received');
    expect(send.mock.calls[0][2]).toContain('A new email.received event was recorded.');
    expect(send.mock.calls[1][1]).toBe('Lead list alert: email.bounced');
  });
});
