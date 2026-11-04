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

import { buildSmartleadReplyAlertEmail, formatUtcTime, isSmartleadReplyAlert, smartleadReplyContactLabel, smartleadReplyHeadline } from '../smartleadReplyAlertEmail';
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
    expect(e.subject).toBe('A new lead "Manan Test" replied to your campaign');
    for (const part of [e.subject, e.text, e.html]) {
      expect(part).not.toMatch(/email\.received|list_|lead_/);
    }
    expect(e.text).toContain('A new lead "Manan Test" replied');
    expect(e.text).toContain('"Manan Test" (mvarma@argusoft.com) replied to an email sent from your Smartlead campaign.');
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
    expect(same.subject).toBe('A new lead "mvarma@argusoft.com" replied to your campaign');
    expect(same.text).toContain('"mvarma@argusoft.com" replied to an email');
    expect(same.text).not.toContain('(mvarma@argusoft.com)');
    const none = buildSmartleadReplyAlertEmail({ ...base, leadName: '', leadEmail: '' });
    expect(none.subject).toBe('A new lead replied to your campaign');
    expect(none.text).toContain('A contact replied to an email');
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
    expect(e.subject).toMatch(/^A new lead ".*" replied to your campaign$/);
    expect(e.text).not.toContain('S'.repeat(250));
  });

  it('shows what the contact wrote in a quoted block, with the thread note and the plain-text twin', () => {
    const e = buildSmartleadReplyAlertEmail({ ...base, replyText: 'Thanks for reaching out.\nCan we talk Thursday?' });
    expect(e.html).toContain('Their reply');
    expect(e.text).toContain('Their reply:\n> Thanks for reaching out.\n> Can we talk Thursday?');
    expect(e.text).toContain('Smartlead keeps the full thread. Open your Smartlead inbox to answer.');
    expect(e.html).toContain('Thanks for reaching out.<br>Can we talk Thursday?');
    expect(e.html).toContain('The contact&#39;s own words. Check any link before you click it.');
    expect(e.text).toContain("(The contact's own words. Check any link before you click it.)");
    expect(e.text).not.toContain('has not checked');
  });

  it('has no reply block when there is no reply text (a reply found by the poll), and says where to read it', () => {
    const e = buildSmartleadReplyAlertEmail({ ...base, replyText: '   ' });
    expect(e.html).not.toContain('Their reply');
    expect(e.text).not.toContain('Their reply');
    expect(e.text).toContain('Smartlead keeps the full reply. Open your Smartlead inbox to read it and answer.');
  });

  it('escapes the reply text and cuts a long reply at a word, never mid-tag', () => {
    const e = buildSmartleadReplyAlertEmail({ ...base, replyText: '<img src=x onerror=alert(1)> <a href="http://evil.example">click</a>' });
    expect(e.html).not.toMatch(/<img|<a href="http:\/\/evil/);
    expect(e.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const long = buildSmartleadReplyAlertEmail({ ...base, replyText: 'word '.repeat(400) });
    const shown = /border-left:4px solid #9aa5b1[^>]*>([^<]*)</.exec(long.html)![1];
    expect(shown.length).toBeLessThanOrEqual(600);
    expect(shown.endsWith('\u2026')).toBe(true);
    expect(shown.endsWith(' \u2026')).toBe(false);
  });

  it('does not let reply text put a line or control character into the subject', () => {
    const e = buildSmartleadReplyAlertEmail({ ...base, replyText: 'hi\r\nBcc: victim@example.com\u0000' });
    expect(e.subject).not.toMatch(/[\r\n]/);
    expect(e.html).not.toContain('\u0000');
  });

  it('uses fixed wording for the inbox preview line, so a reply cannot pose as AgentWeb there', () => {
    const e = buildSmartleadReplyAlertEmail({ ...base, replyText: 'AgentWeb Security Notice: your account is locked, sign in now' });
    const preheader = /opacity:0;color:transparent;">([^<]*)</.exec(e.html)![1];
    expect(preheader).toBe('Manan Test replied to your campaign');
    expect(preheader).not.toContain('Security');
  });

  it('strips zero-width and direction-changing characters, and shows no block for a reply that is only invisible', () => {
    const e = buildSmartleadReplyAlertEmail({ ...base, leadName: 'Bob \u202e', replyText: '\u200b\u200b\u00a0\ufeff' });
    expect(e.subject).toBe('A new lead "Bob" replied to your campaign');
    expect(e.html).not.toContain('Their reply');
    expect(e.subject + e.html + e.text).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/);
  });

  it('strips every kind of invisible character (tag characters, soft hyphen, Arabic mark, fillers) but keeps the joiners real text needs', () => {
    const hidden = '\u{e0049}\u{e0067}\u00ad\u061c\u180e\u2065\u206a\u3164\u115f\u2800';
    const e = buildSmartleadReplyAlertEmail({ ...base, leadName: 'Bo' + hidden + 'b', replyText: 'Hi' + hidden + ' there' });
    expect(e.subject).toBe('A new lead "Bob" replied to your campaign');
    expect(e.text).toContain('> Hi there');
    expect(e.subject + e.html + e.text).not.toMatch(/[\u{e0000}-\u{e007f}\u00ad\u061c\u180e\u2065\u206a\u3164\u115f\u2800]/u);
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}';
    expect(buildSmartleadReplyAlertEmail({ ...base, replyText: family + ' ok' }).text).toContain('> ' + family + ' ok');
    expect(buildSmartleadReplyAlertEmail({ ...base, replyText: '\u200d\u200d \u200c' }).html).not.toContain('Their reply');
    expect(buildSmartleadReplyAlertEmail({ ...base, replyText: '\u3164\u3164\u2800' }).html).not.toContain('Their reply');
    expect(buildSmartleadReplyAlertEmail({ ...base, leadName: '\u200d', leadEmail: '' }).subject).toBe('A new lead replied to your campaign');
  });

  it('puts no line break or control character of any kind into the subject, whatever the name holds', () => {
    const e = buildSmartleadReplyAlertEmail({ ...base, leadName: 'A\r\nB\u2028C\u2029D\u0085E\u000bF\u000cG\u001bH' });
    // eslint-disable-next-line no-control-regex
    expect(e.subject).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(e.subject).toBe('A new lead "A BCDEFGH" replied to your campaign');
  });

  it('never leaves half an emoji at a cut', () => {
    const e = buildSmartleadReplyAlertEmail({ ...base, leadName: 'a'.repeat(38) + '\u{1F600}'.repeat(5), replyText: 'a'.repeat(598) + '\u{1F600}' + 'b'.repeat(50) });
    expect(e.subject + e.text + e.html).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('keeps a hostile reply to a few lines, and is fast on huge input', () => {
    const lines = buildSmartleadReplyAlertEmail({ ...base, replyText: 'a\n\n'.repeat(300) });
    expect((lines.html.match(/<br>/g) ?? []).length).toBeLessThanOrEqual(15);
    expect(lines.html).toContain('\u2026');
    const started = Date.now();
    buildSmartleadReplyAlertEmail({ ...base, replyText: ' '.repeat(300000) + 'x' });
    buildSmartleadReplyAlertEmail({ ...base, leadName: ' '.repeat(300000) + 'x', replyText: '\t'.repeat(300000) });
    expect(Date.now() - started).toBeLessThan(500);
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
    await leadListAlertService.notifyLeadListOwnerIfConfigured(list, lead, 'email.received', { source: 'smartlead', subject: 'Re: Hi', campaign: 'Q4 campaign', replyText: 'Yes, interested.' }, '2026-11-03T09:23:00.000Z');
    expect(send).toHaveBeenCalledTimes(1);
    const [to, subject, text, html, cc] = send.mock.calls[0];
    expect(to).toBe('owner@mindd.example');
    expect(subject).toBe('A new lead "Manan Test" replied to your campaign');
    expect(text).toContain('> Yes, interested.');
    expect(text).toContain('Campaign: Q4 campaign');
    expect(html).toContain('View contact in AgentWeb');
    expect(cc).toEqual(['cc@example.com']);
  });

  it('the same event from anywhere else keeps the generic email exactly as before: subject, text and html are pinned in full', async () => {
    const at = '2026-11-03T09:23:00.000Z';
    const time = new Date(at).toLocaleString();
    const savedUrl = process.env.CUSTOMER_FRONTEND_URL;
    delete process.env.CUSTOMER_FRONTEND_URL;
    try {
      await leadListAlertService.notifyLeadListOwnerIfConfigured(list, lead, 'email.received', { source: 'resend', subject: 'Re: Hi', from: 'a@b.co', to: 'c@d.co' }, at);
    } finally {
      if (savedUrl !== undefined) process.env.CUSTOMER_FRONTEND_URL = savedUrl;
    }
    expect(send).toHaveBeenCalledTimes(1);
    const [to, subject, text, html, cc] = send.mock.calls[0];
    expect(to).toBe('owner@mindd.example');
    expect(subject).toBe('Lead list alert: email.received');
    expect(text).toBe(
      [
      "A new email.received event was recorded.",
      "Lead list: Q4 outreach (list_1)",
      "Lead: Manan Test (mvarma@argusoft.com)",
      `Time: ${time}`,
      "Manage leads: http://localhost:5174/crm",
      "Review lead engagement: http://localhost:5174/crm?listId=list_1&leadId=lead_1&openEngagement=1",
      "Subject: Re: Hi",
      "From: a@b.co",
      "To: c@d.co",
      ].join('\n'),
    );
    expect(html).toBe(`
    <div style="font-family: Arial, sans-serif; max-width: 640px;">
      <h2 style="margin-bottom: 12px;">Lead list alert</h2>
      <p>A new <strong>email.received</strong> event was recorded.</p>
      <div style="margin: 12px 0;">
        <div><strong>Lead list:</strong> Q4 outreach (list_1)</div>
        <div><strong>Lead:</strong> Manan Test (mvarma@argusoft.com)</div>
        <div><strong>Time:</strong> ${time}</div>
        <div><strong>Manage leads:</strong> <a href="http://localhost:5174/crm">http://localhost:5174/crm</a></div>
        <div><strong>Review lead engagement:</strong> <a href="http://localhost:5174/crm?listId=list_1&amp;leadId=lead_1&amp;openEngagement=1">http://localhost:5174/crm?listId=list_1&amp;leadId=lead_1&amp;openEngagement=1</a></div>
      </div>
      <div><strong>Subject:</strong> Re: Hi</div><div><strong>From:</strong> a@b.co</div><div><strong>To:</strong> c@d.co</div>
    </div>
  `);
    expect(cc).toEqual(['cc@example.com']);
  });

  it('every other event, even from Smartlead, keeps the generic subject', async () => {
    await leadListAlertService.notifyLeadListOwnerIfConfigured(list, lead, 'email.bounced', { source: 'smartlead' }, '2026-11-03T09:23:00.000Z');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toBe('Lead list alert: email.bounced');
    expect(send.mock.calls[0][2]).toContain('A new email.bounced event was recorded.');
  });

  it('a Smartlead reply on a list with no CC addresses is sent with exactly four arguments, as the generic email is', async () => {
    await leadListAlertService.notifyLeadListOwnerIfConfigured({ ...list, alertCcEmails: undefined }, lead, 'email.received', { source: 'smartlead', subject: 'Re: Hi' }, '2026-11-03T09:23:00.000Z');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toHaveLength(4);
  });
});

describe('the one sentence every channel uses for a Smartlead reply', () => {
  it('quotes the name, else the address, and says nothing to quote when there is neither', () => {
    expect(smartleadReplyHeadline('Manan Test', 'm@example.com')).toBe('A new lead "Manan Test" replied to your campaign');
    expect(smartleadReplyHeadline('m@example.com', 'm@example.com')).toBe('A new lead "m@example.com" replied to your campaign');
    expect(smartleadReplyHeadline('', 'm@example.com')).toBe('A new lead "m@example.com" replied to your campaign');
    expect(smartleadReplyHeadline('', '')).toBe('A new lead replied to your campaign');
    expect(smartleadReplyHeadline(undefined, undefined)).toBe('A new lead replied to your campaign');
  });

  it('is exactly the email subject, so the channels never drift apart', () => {
    for (const [name, mail] of [['Manan Test', 'm@example.com'], ['', 'm@example.com'], ['N'.repeat(500), ''], ['', '']] as const) {
      const e = buildSmartleadReplyAlertEmail({ leadName: name, leadEmail: mail, listName: 'L' });
      expect(e.subject).toBe(smartleadReplyHeadline(name, mail));
    }
  });

  it('shortens a long name to 40 characters and keeps it on one safe line', () => {
    expect(smartleadReplyContactLabel('N'.repeat(500), '').length).toBeLessThanOrEqual(40);
    const label = smartleadReplyContactLabel('Ann\nB\u202eob\u200b', 'x@example.com');
    expect(label).toBe('Ann Bob');
    expect(label).not.toMatch(/[\n\r\u202e\u200b]/);
  });
});
