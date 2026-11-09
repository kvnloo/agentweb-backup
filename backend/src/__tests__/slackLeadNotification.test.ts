/**
 * Tests for Slack lead notification feature:
 * - formatLeadNotificationPayload: message formatting
 * - sendLeadNotification: bot-based channel posting via slackClient
 * - leadListAlertService: integration with Slack when user has slackChannel
 */

// Mock server before any imports
jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../controllers/templates', () => ({}));

// Mock the @slack/web-api WebClient
const mockPostMessage = jest.fn();
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: mockPostMessage },
    conversations: { info: jest.fn(), list: jest.fn() },
    views: { open: jest.fn() },
  })),
}));

// Set env var before slackService is imported so the client initializes
process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';

import {
  formatLeadNotificationPayload,
  sendLeadNotification,
  LeadNotificationPayload,
} from '../services/slackService';

describe('formatLeadNotificationPayload', () => {
  const baseLead: LeadNotificationPayload = {
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    company: 'Acme Corp',
    listName: 'Inbound Leads',
    listId: 'list_123',
    crmUrl: 'https://app.example.com/crm?listId=list_123',
    timestamp: '2026-03-16T12:00:00.000Z',
  };

  it('includes all provided fields in the message', () => {
    const payload = formatLeadNotificationPayload({
      ...baseLead,
      phone: '+1-555-0100',
      linkedin: 'https://linkedin.com/in/janedoe',
      eventType: 'api.lead_added',
    });

    expect(payload.text).toContain('Jane Doe');
    expect(payload.text).toContain('Inbound Leads');

    // Should have header, section with fields, context, and actions blocks
    expect(payload.blocks).toHaveLength(4);
    expect(payload.blocks[0].type).toBe('header');
    expect(payload.blocks[0].text.text).toBe('api.lead_added');

    const fieldTexts = payload.blocks[1].fields.map((f: any) => f.text);
    expect(fieldTexts).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Jane Doe'),
        expect.stringContaining('jane@example.com'),
        expect.stringContaining('Acme Corp'),
        expect.stringContaining('+1-555-0100'),
        expect.stringContaining('Profile'),
        expect.stringContaining('Inbound Leads'),
      ])
    );

    // CRM button
    expect(payload.blocks[3].type).toBe('actions');
    expect(payload.blocks[3].elements[0].url).toBe(baseLead.crmUrl);
  });

  it('omits optional fields when not provided', () => {
    const payload = formatLeadNotificationPayload({
      listName: 'Sales',
      listId: 'list_456',
    });

    expect(payload.text).toContain('Unknown');
    expect(payload.text).toContain('Sales');

    const fieldTexts = payload.blocks[1].fields.map((f: any) => f.text);
    // Should only have Name and List — no email, company, phone, linkedin
    expect(fieldTexts).toHaveLength(2);
    expect(fieldTexts[0]).toContain('Unknown');
    expect(fieldTexts[1]).toContain('Sales');

    // No CRM button when crmUrl is missing
    expect(payload.blocks).toHaveLength(3); // header, section, context — no actions
  });

  it('uses default event label when eventType is not set', () => {
    const payload = formatLeadNotificationPayload(baseLead);
    expect(payload.blocks[0].text.text).toBe('New lead added');
  });

  it('handles lead with only firstName', () => {
    const payload = formatLeadNotificationPayload({
      firstName: 'Alice',
      listName: 'Test',
      listId: 'list_x',
    });
    expect(payload.text).toContain('Alice');
    const nameField = payload.blocks[1].fields[0].text;
    expect(nameField).toContain('Alice');
    expect(nameField).not.toContain('undefined');
  });
});

describe('formatLeadNotificationPayload — a headline sentence (Smartlead reply)', () => {
  const lead: LeadNotificationPayload = {
    firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', company: 'Acme Corp', listName: 'Inbound Leads', listId: 'list_123',
    crmUrl: 'https://app.example.com/crm?listId=list_123', timestamp: '2026-03-16T12:00:00.000Z', eventType: 'email.received',
  };

  it('puts the sentence in the header and the fallback, and keeps the fields, the time and the button', () => {
    const withLine = formatLeadNotificationPayload({ ...lead, headline: 'A new lead "Jane Doe" replied to your campaign' });
    const without = formatLeadNotificationPayload(lead);
    expect(withLine.blocks[0].text.text).toBe('A new lead "Jane Doe" replied to your campaign');
    expect(withLine.text).toBe('A new lead "Jane Doe" replied to your campaign. List: Inbound Leads');
    expect(JSON.stringify(withLine.text + withLine.blocks)).not.toContain('email.received');
    expect(withLine.blocks.slice(1)).toEqual(without.blocks.slice(1));
  });

  it('escapes the fallback text for Slack, so a contact\'s name can not make a link or a mention', () => {
    const r = formatLeadNotificationPayload({ ...lead, headline: 'A new lead "<!channel> & <https://x.example|Click>" replied to your campaign' });
    expect(r.text).toContain('&lt;!channel&gt; &amp; &lt;https://x.example|Click&gt;');
    expect(r.text).not.toContain('<');
  });

  it('escapes the values it shows when a headline is set, and leaves them alone when it is not', () => {
    const hostile: LeadNotificationPayload = { ...lead, firstName: '<!channel> & <https://x.example|Click>', lastName: '', email: 'a<b>@example.com', company: 'Acme <!here>', phone: '<tel>', listName: 'List <!channel>' };
    const withLine = formatLeadNotificationPayload({ ...hostile, headline: 'A new lead replied to your campaign' });
    const fieldText = withLine.blocks[1].fields.map((f: { text: string }) => f.text).join('\n');
    expect(fieldText).toContain('&lt;!channel&gt; &amp; &lt;https://x.example|Click&gt;');
    expect(fieldText).toContain('a&lt;b&gt;@example.com');
    expect(fieldText).toContain('Acme &lt;!here&gt;');
    expect(fieldText).toContain('List &lt;!channel&gt;');
    expect(fieldText).not.toMatch(/<(?!https:\/\/linkedin)/);
    const plain = formatLeadNotificationPayload(hostile);
    expect(plain.blocks[1].fields.map((f: { text: string }) => f.text).join('\n')).toContain('<!channel> & <https://x.example|Click>');
  });

  it('keeps a hostile LinkedIn value to one link and survives non-string values, when a headline is set', () => {
    const hostile = formatLeadNotificationPayload({
      ...lead, headline: 'A new lead replied to your campaign', linkedin: 'https://linkedin.com/in/x|y><!channel><https://evil.example|click',
      phone: 5551234 as unknown as string, company: 42 as unknown as string,
    });
    const text = hostile.blocks[1].fields.map((f: { text: string }) => f.text).join('\n');
    const linkedin = hostile.blocks[1].fields.find((f: { text: string }) => f.text.startsWith('*LinkedIn:*')).text;
    expect(linkedin).toBe('*LinkedIn:*\n<https://linkedin.com/in/x%7Cy&gt;&lt;!channel&gt;&lt;https://evil.example%7Cclick|Profile>');
    expect((linkedin.match(/\|/g) || []).length).toBe(1);
    expect(linkedin).not.toContain('<!channel>');
    expect(text).toContain('5551234');
    expect(text).toContain('42');
    // without a headline the link is exactly what it was
    const plain = formatLeadNotificationPayload({ ...lead, linkedin: 'https://linkedin.com/in/janedoe' });
    expect(plain.blocks[1].fields.find((f: { text: string }) => f.text.startsWith('*LinkedIn:*')).text).toBe('*LinkedIn:*\n<https://linkedin.com/in/janedoe|Profile>');
  });

  it('shows a LinkedIn value that is not an http(s) address as plain text, never inside <...> where Slack reads !channel, @user and #channel as special links', () => {
    for (const value of ['!channel', '!here', '@U012ABCDEF', '#C012ABCDEF', '!subteam^S0123', 'javascript:alert(1)', 'ftp://x.example', '<!channel>']) {
      const r = formatLeadNotificationPayload({ ...lead, headline: 'A new lead replied to your campaign', linkedin: value });
      const text = r.blocks[1].fields.find((f: { text: string }) => f.text.startsWith('*LinkedIn:*')).text;
      expect(text).not.toContain('<');
      expect(text).not.toContain('|Profile');
    }
    // an http(s) address is still a link, in any letter case
    const ok = formatLeadNotificationPayload({ ...lead, headline: 'h', linkedin: 'HTTPS://linkedin.com/in/jane' });
    expect(ok.blocks[1].fields.find((f: { text: string }) => f.text.startsWith('*LinkedIn:*')).text).toBe('*LinkedIn:*\n<HTTPS://linkedin.com/in/jane|Profile>');
  });

  it('keeps spaces, tabs, new lines and line separators in a LinkedIn link target from ending or splitting the link', () => {
    const r = formatLeadNotificationPayload({ ...lead, headline: 'h', linkedin: 'https://linkedin.com/in/a b\tc\nd\u2028e' });
    const text = r.blocks[1].fields.find((f: { text: string }) => f.text.startsWith('*LinkedIn:*')).text;
    const link = text.slice(text.indexOf('<'));
    expect(link).toBe('<https://linkedin.com/in/a%20b%09c%0Ad%E2%80%A8e|Profile>');
    expect(/\s/.test(link)).toBe(false);
  });

  it('does not throw when the list name is not a string', () => {
    expect(() => formatLeadNotificationPayload({ ...lead, headline: 'h', listName: 5 as unknown as string })).not.toThrow();
    expect(() => formatLeadNotificationPayload({ ...lead, headline: 'h', listName: undefined as unknown as string })).not.toThrow();
  });

  it('leaves every alert without a headline exactly as it was (the raw event name and the old fallback)', () => {
    const r = formatLeadNotificationPayload(lead);
    expect(r.blocks[0].text.text).toBe('email.received');
    expect(r.text).toBe('email.received: Jane Doe (jane@example.com) — Inbound Leads');
    const none = formatLeadNotificationPayload({ ...lead, eventType: undefined });
    expect(none.blocks[0].text.text).toBe('New lead added');
  });

  it('does not touch the compact format, which never showed an event name', () => {
    const a = formatLeadNotificationPayload({ ...lead, compact: true });
    const b = formatLeadNotificationPayload({ ...lead, compact: true, headline: 'A new lead "Jane Doe" replied to your campaign' });
    expect(b).toEqual(a);
  });
});

describe('sendLeadNotification', () => {
  beforeEach(() => {
    mockPostMessage.mockReset();
  });

  const lead: LeadNotificationPayload = {
    firstName: 'Test',
    lastName: 'User',
    email: 'test@example.com',
    listName: 'Demo',
    listId: 'list_demo',
  };

  it('posts to the specified channel using slackClient.chat.postMessage', async () => {
    mockPostMessage.mockResolvedValueOnce({ ok: true, ts: '1234.5678' });

    await sendLeadNotification('C0AL81T5FAM', lead);

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const call = mockPostMessage.mock.calls[0][0];
    expect(call.channel).toBe('C0AL81T5FAM');
    expect(call.text).toContain('Test User');
    expect(call.blocks).toBeDefined();
    expect(call.blocks.length).toBeGreaterThan(0);
  });

  it('throws when Slack API returns not ok', async () => {
    mockPostMessage.mockResolvedValueOnce({ ok: false, error: 'channel_not_found' });

    await expect(
      sendLeadNotification('C_INVALID', lead)
    ).rejects.toThrow('Slack API error: channel_not_found');
  });

  it('throws when slackClient rejects', async () => {
    mockPostMessage.mockRejectedValueOnce(new Error('Network error'));

    await expect(
      sendLeadNotification('C0AL81T5FAM', lead)
    ).rejects.toThrow('Network error');
  });
});

describe('leadListAlertService — Slack integration', () => {
  // These need separate mocks for the alert service dependencies
  const mockSendEmail = jest.fn().mockResolvedValue(undefined);
  const mockGetUserById = jest.fn();

  jest.mock('../services/db', () => ({
    crmDb: {
      getLeadListsByUserId: jest.fn(),
      getLeadByEmail: jest.fn(),
    },
    userDb: {
      getUserById: mockGetUserById,
      getUsersByEmailDomain: jest.fn().mockResolvedValue([]),
    },
  }));

  jest.mock('../services/emailService', () => ({
    emailService: {
      sendEmail: mockSendEmail,
      escapeHtml: (s: string) => s,
    },
  }));

  // We need to spy on sendLeadNotification
  const mockSendLeadNotificationFn = jest.fn().mockResolvedValue(undefined);
  jest.mock('../services/slackService', () => ({
    sendLeadNotification: mockSendLeadNotificationFn,
  }));

  // Import after mocks
  const { leadListAlertService } = require('../services/leadListAlertService');

  beforeEach(() => {
    mockSendEmail.mockClear();
    mockSendLeadNotificationFn.mockClear();
    mockGetUserById.mockClear();
  });

  const lead = {
    leadId: 'lead_1',
    firstName: 'John',
    lastName: 'Smith',
    email: 'john@test.com',
    company: 'TestCo',
  };

  it('sends Slack notification when user has slackChannel configured', async () => {
    const user = { userId: 'user_1', email: 'owner@example.com', slackChannel: 'C0AL81T5FAM' };
    mockGetUserById.mockResolvedValueOnce(user);

    const list = {
      listId: 'list_1',
      userId: 'user_1',
      name: 'My Leads',
      alertEvents: ['api.lead_added'],
    };

    await leadListAlertService.notifyLeadListOwnerIfConfigured(
      list,
      lead,
      'api.lead_added',
      { source: 'api' },
      '2026-03-16T12:00:00.000Z'
    );

    // Email should have been sent
    expect(mockSendEmail).toHaveBeenCalledTimes(1);

    // Slack should also have been called with the user's channel ID
    expect(mockSendLeadNotificationFn).toHaveBeenCalledTimes(1);
    expect(mockSendLeadNotificationFn).toHaveBeenCalledWith(
      'C0AL81T5FAM',
      expect.objectContaining({
        firstName: 'John',
        lastName: 'Smith',
        email: 'john@test.com',
        company: 'TestCo',
        listName: 'My Leads',
        listId: 'list_1',
      })
    );
  });

  it('does NOT send Slack notification when user has no slackChannel', async () => {
    const user = { userId: 'user_1', email: 'owner@example.com' };
    mockGetUserById.mockResolvedValueOnce(user);

    const list = {
      listId: 'list_2',
      userId: 'user_1',
      name: 'No Slack Channel',
      alertEvents: ['api.lead_added'],
    };

    await leadListAlertService.notifyLeadListOwnerIfConfigured(
      list,
      lead,
      'api.lead_added',
      {},
      '2026-03-16T12:00:00.000Z'
    );

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendLeadNotificationFn).not.toHaveBeenCalled();
  });

  it('still sends email even if Slack bot call fails', async () => {
    const user = { userId: 'user_1', email: 'owner@example.com', slackChannel: 'C_BROKEN' };
    mockGetUserById.mockResolvedValueOnce(user);
    mockSendLeadNotificationFn.mockRejectedValueOnce(new Error('channel_not_found'));

    const list = {
      listId: 'list_3',
      userId: 'user_1',
      name: 'Broken Channel',
      alertEvents: ['api.lead_added'],
    };

    // Should not throw
    await leadListAlertService.notifyLeadListOwnerIfConfigured(
      list,
      lead,
      'api.lead_added',
      {},
      '2026-03-16T12:00:00.000Z'
    );

    // Email still sent
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    // Slack was attempted
    expect(mockSendLeadNotificationFn).toHaveBeenCalledTimes(1);
  });

  it('skips notification when event type is not in alertEvents', async () => {
    const list = {
      listId: 'list_4',
      userId: 'user_1',
      name: 'Filtered',
      alertEvents: ['email.received'],
    };

    await leadListAlertService.notifyLeadListOwnerIfConfigured(
      list,
      lead,
      'api.lead_added',
      {},
      '2026-03-16T12:00:00.000Z'
    );

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockSendLeadNotificationFn).not.toHaveBeenCalled();
  });
});
