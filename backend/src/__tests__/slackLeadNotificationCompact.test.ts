/**
 * ENG-2391: compact (name, phone, email) Slack lead notification format.
 */
jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));
jest.mock('../controllers/templates', () => ({}));
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: jest.fn() },
    conversations: { info: jest.fn(), list: jest.fn() },
    views: { open: jest.fn() },
  })),
}));

import { formatLeadNotificationPayload, LeadNotificationPayload } from '../services/slackService';
import { isCompactLeadNotificationUser } from '../services/leadListAlertService';

const lead: LeadNotificationPayload = {
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  phone: '+1-555-0100',
  company: 'Acme Corp',
  linkedin: 'https://linkedin.com/in/jane',
  listName: 'Haven Leads',
  listId: 'list-1',
  crmUrl: 'https://app.example.com/crm?listId=list-1',
  eventType: 'lead_created',
};

const allText = (p: { text: string; blocks: any[] }) => JSON.stringify(p);

describe('compact lead notification (ENG-2391)', () => {
  // The payload carries "Received at <timestamp to the millisecond>". The default-format
  // test formats the same lead twice and requires the results to be identical, so on a
  // real clock it failed whenever the two calls landed in different milliseconds.
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-12T00:00:00.000Z'));
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  it('renders only name, phone, email', () => {
    const p = formatLeadNotificationPayload({ ...lead, compact: true });
    expect(p.blocks).toHaveLength(1);
    const fields = p.blocks[0].fields.map((f: any) => f.text);
    expect(fields).toEqual(['*Name:*\nJane Doe', '*Phone:*\n+1-555-0100', '*Email:*\njane@example.com']);
    const s = allText(p);
    for (const hidden of ['Acme Corp', 'linkedin', 'Haven Leads', 'Open CRM', 'lead_created', 'Received at']) {
      expect(s).not.toContain(hidden);
    }
  });

  it('shows missing fields as em dash instead of dropping them', () => {
    const p = formatLeadNotificationPayload({ listName: 'L', listId: 'l', email: '  ', compact: true });
    const fields = p.blocks[0].fields.map((f: any) => f.text);
    expect(fields).toEqual(['*Name:*\n—', '*Phone:*\n—', '*Email:*\n—']);
    expect(p.text).toBe('Name: — | Phone: — | Email: —');
  });

  it('leaves the default format unchanged for other orgs', () => {
    const p = formatLeadNotificationPayload(lead);
    const s = allText(p);
    expect(p.blocks[0].type).toBe('header');
    expect(s).toContain('Acme Corp');
    expect(s).toContain('Haven Leads');
    expect(s).toContain('Open CRM');
    expect(formatLeadNotificationPayload({ ...lead, compact: false })).toEqual(p);
  });

  it('selects compact users from LEAD_NOTIFICATION_COMPACT_USER_IDS', () => {
    const prev = process.env.LEAD_NOTIFICATION_COMPACT_USER_IDS;
    process.env.LEAD_NOTIFICATION_COMPACT_USER_IDS = ' user-haven , user-x ';
    expect(isCompactLeadNotificationUser('user-haven')).toBe(true);
    expect(isCompactLeadNotificationUser('user-other')).toBe(false);
    expect(isCompactLeadNotificationUser(undefined)).toBe(false);
    delete process.env.LEAD_NOTIFICATION_COMPACT_USER_IDS;
    expect(isCompactLeadNotificationUser('user-haven')).toBe(false);
    if (prev !== undefined) process.env.LEAD_NOTIFICATION_COMPACT_USER_IDS = prev;
  });
});
