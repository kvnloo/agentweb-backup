/**
 * Non-command WhatsApp messages: greet once, forward to the team (ENG-273).
 */
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn() },
}));
jest.mock('../services/whatsappService', () => ({
  redactPhone: jest.requireActual('../services/whatsappService').redactPhone,
  resolveUserIdByPhone: jest.fn(),
  sendText: jest.fn(),
}));
jest.mock('../services/emailService', () => ({
  emailService: { sendEmail: jest.fn() },
}));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));

const { settingsService } = require('../services/settingsService');
const whatsapp = require('../services/whatsappService');
const { emailService } = require('../services/emailService');
const { userDb } = require('../services/db');

import {
  handleUnrecognizedMessage,
  supportInbox,
  SUPPORT_GREETING,
} from '../services/whatsappInboundSupport';

const PHONE = '+918005326946';
const ENV = { ...process.env };

beforeEach(() => {
  jest.resetAllMocks();
  process.env = { ...ENV, NODE_ENV: 'development' };
  delete process.env.WHATSAPP_SUPPORT_INBOX;
  settingsService.getSetting.mockResolvedValue(null);
  settingsService.setSetting.mockResolvedValue(undefined);
  whatsapp.sendText.mockResolvedValue({ messageId: 'wamid.G' });
  whatsapp.resolveUserIdByPhone.mockResolvedValue(null);
  emailService.sendEmail.mockResolvedValue(undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  process.env = ENV;
});

describe('the greeting', () => {
  it('replies to a plain message', async () => {
    await handleUnrecognizedMessage(PHONE, 'hi');
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, SUPPORT_GREETING);
  });

  it('is sent once, not after every line the customer types', async () => {
    settingsService.getSetting.mockResolvedValue({ settingValue: new Date().toISOString() });
    await handleUnrecognizedMessage(PHONE, 'and another thing');
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('is sent again once the cooldown has passed', async () => {
    const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    settingsService.getSetting.mockResolvedValue({ settingValue: thirteenHoursAgo });
    await handleUnrecognizedMessage(PHONE, 'hello again');
    expect(whatsapp.sendText).toHaveBeenCalled();
  });

  it('records the cooldown only after the greeting actually sent', async () => {
    whatsapp.sendText.mockRejectedValue(new Error('opted out'));
    await handleUnrecognizedMessage(PHONE, 'hi');
    expect(settingsService.setSetting).not.toHaveBeenCalled();
  });

  it('stores the cooldown TTL in epoch seconds', async () => {
    await handleUnrecognizedMessage(PHONE, 'hi');
    const ttl = settingsService.setSetting.mock.calls[0][4];
    const hours = (ttl - Date.now() / 1000) / 3600;
    expect(hours).toBeGreaterThan(11);
    expect(hours).toBeLessThan(13);
  });

  it('ignores reactions and other non-message events', async () => {
    await handleUnrecognizedMessage(PHONE, '', 'reaction');
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });
});

describe('forwarding to the team', () => {
  it('is off outside production unless an inbox is configured', async () => {
    expect(supportInbox()).toBeNull();
    await handleUnrecognizedMessage(PHONE, 'hi');
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('defaults to the published address in production', () => {
    process.env.NODE_ENV = 'production';
    expect(supportInbox()).toBe('founders@agentweb.pro');
  });

  it('forwards the customer query with who it is from', async () => {
    process.env.WHATSAPP_SUPPORT_INBOX = 'support@example.com';
    whatsapp.resolveUserIdByPhone.mockResolvedValue('user-1');
    userDb.getUserById.mockResolvedValue({ userId: 'user-1', email: 'cust@example.com' });

    await handleUnrecognizedMessage(PHONE, 'My campaign is stuck');

    const [to, subject, textBody] = emailService.sendEmail.mock.calls[0];
    expect(to).toBe('support@example.com');
    expect(subject).toContain(PHONE);
    expect(textBody).toContain('My campaign is stuck');
    expect(textBody).toContain('cust@example.com');
  });

  it('escapes the customer text in the HTML body', async () => {
    process.env.WHATSAPP_SUPPORT_INBOX = 'support@example.com';
    await handleUnrecognizedMessage(PHONE, '<script>alert(1)</script>');
    const html = emailService.sendEmail.mock.calls[0][3];
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('forwards every message even while the greeting is on cooldown', async () => {
    process.env.WHATSAPP_SUPPORT_INBOX = 'support@example.com';
    settingsService.getSetting.mockResolvedValue({ settingValue: new Date().toISOString() });
    await handleUnrecognizedMessage(PHONE, 'second line of my question');
    expect(emailService.sendEmail).toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('still greets when forwarding fails, and never throws', async () => {
    process.env.WHATSAPP_SUPPORT_INBOX = 'support@example.com';
    emailService.sendEmail.mockRejectedValue(new Error('ses down'));
    await expect(handleUnrecognizedMessage(PHONE, 'hi')).resolves.toBeUndefined();
    expect(whatsapp.sendText).toHaveBeenCalled();
  });

  it('keeps the phone number out of its logs', async () => {
    whatsapp.sendText.mockRejectedValue(new Error('x'));
    await handleUnrecognizedMessage(PHONE, 'hi');
    const logged = (console.warn as jest.Mock).mock.calls.flat().join(' ');
    expect(logged).not.toContain('918005326946');
  });
});
