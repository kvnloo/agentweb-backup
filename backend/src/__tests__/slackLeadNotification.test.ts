/**
 * Tests for Slack lead notification feature:
 * - formatLeadNotificationPayload: message formatting
 * - sendLeadNotification: webhook HTTP call
 * - leadListAlertService: integration with Slack when slackWebhookUrl is set
 */

// Mock server before any imports
jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../controllers/templates', () => ({}));

// Mock fetch globally
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

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

describe('sendLeadNotification', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const lead: LeadNotificationPayload = {
    firstName: 'Test',
    lastName: 'User',
    email: 'test@example.com',
    listName: 'Demo',
    listId: 'list_demo',
  };

  it('sends POST to webhook URL with JSON payload', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    await sendLeadNotification('https://hooks.slack.com/test', lead);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/test');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(options.body);
    expect(body.text).toContain('Test User');
    expect(body.blocks).toBeDefined();
  });

  it('throws on non-OK response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: jest.fn().mockResolvedValue('invalid_token'),
    });

    await expect(
      sendLeadNotification('https://hooks.slack.com/bad', lead)
    ).rejects.toThrow('Slack webhook request failed (403)');
  });

  it('throws on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    await expect(
      sendLeadNotification('https://hooks.slack.com/fail', lead)
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
  const mockSendLeadNotification = jest.fn().mockResolvedValue(undefined);
  jest.mock('../services/slackService', () => ({
    sendLeadNotification: mockSendLeadNotification,
  }));

  // Import after mocks
  const { leadListAlertService } = require('../services/leadListAlertService');

  beforeEach(() => {
    mockSendEmail.mockClear();
    mockSendLeadNotification.mockClear();
    mockGetUserById.mockClear();
  });

  const user = { userId: 'user_1', email: 'owner@example.com' };
  const lead = {
    leadId: 'lead_1',
    firstName: 'John',
    lastName: 'Smith',
    email: 'john@test.com',
    company: 'TestCo',
  };

  it('sends Slack notification when slackWebhookUrl is configured', async () => {
    mockGetUserById.mockResolvedValueOnce(user);

    const list = {
      listId: 'list_1',
      userId: 'user_1',
      name: 'My Leads',
      alertEvents: ['api.lead_added'],
      slackWebhookUrl: 'https://hooks.slack.com/services/test',
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

    // Slack should also have been called
    expect(mockSendLeadNotification).toHaveBeenCalledTimes(1);
    expect(mockSendLeadNotification).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/test',
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

  it('does NOT send Slack notification when slackWebhookUrl is not set', async () => {
    mockGetUserById.mockResolvedValueOnce(user);

    const list = {
      listId: 'list_2',
      userId: 'user_1',
      name: 'No Webhook',
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
    expect(mockSendLeadNotification).not.toHaveBeenCalled();
  });

  it('still sends email even if Slack webhook fails', async () => {
    mockGetUserById.mockResolvedValueOnce(user);
    mockSendLeadNotification.mockRejectedValueOnce(new Error('webhook down'));

    const list = {
      listId: 'list_3',
      userId: 'user_1',
      name: 'Broken Webhook',
      alertEvents: ['api.lead_added'],
      slackWebhookUrl: 'https://hooks.slack.com/services/broken',
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
    expect(mockSendLeadNotification).toHaveBeenCalledTimes(1);
  });

  it('skips notification when event type is not in alertEvents', async () => {
    const list = {
      listId: 'list_4',
      userId: 'user_1',
      name: 'Filtered',
      alertEvents: ['email.received'],
      slackWebhookUrl: 'https://hooks.slack.com/services/test',
    };

    await leadListAlertService.notifyLeadListOwnerIfConfigured(
      list,
      lead,
      'api.lead_added',
      {},
      '2026-03-16T12:00:00.000Z'
    );

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockSendLeadNotification).not.toHaveBeenCalled();
  });
});
