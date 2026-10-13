/**
 * Non-command WhatsApp messages: greet once, forward to the team (ENG-273).
 */
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn(), setSettingIfValueMatches: jest.fn(), setSettingIfAbsent: jest.fn() },
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

describe('redelivery of the same message', () => {
  beforeEach(() => {
    process.env.WHATSAPP_SUPPORT_INBOX = 'support@example.com';
    settingsService.setSettingIfAbsent.mockResolvedValue(true);
  });

  it('handles a message the first time it sees its id', async () => {
    await handleUnrecognizedMessage(PHONE, 'help', 'text', '', 'wamid.M1');
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendText).toHaveBeenCalledTimes(1);
    expect(settingsService.setSettingIfAbsent.mock.calls[0][0]).toBe('whatsapp:inbound-msg:wamid.M1');
  });

  it('neither forwards nor greets a second time when Meta redelivers it', async () => {
    settingsService.setSettingIfAbsent.mockResolvedValue(false);
    await handleUnrecognizedMessage(PHONE, 'help', 'text', '', 'wamid.M1');
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('still handles the message when the dedupe write fails (better a duplicate than a lost query)', async () => {
    settingsService.setSettingIfAbsent.mockRejectedValue(new Error('dynamo down'));
    await handleUnrecognizedMessage(PHONE, 'help', 'text', '', 'wamid.M1');
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('keeps the dedupe row for a day, in epoch seconds', async () => {
    await handleUnrecognizedMessage(PHONE, 'help', 'text', '', 'wamid.M1');
    const ttl = settingsService.setSettingIfAbsent.mock.calls[0][4];
    const now = Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(now + 23 * 3600);
    expect(ttl).toBeLessThan(now + 25 * 3600);
  });
});

describe('the greeting', () => {
  it('replies to a plain message', async () => {
    await handleUnrecognizedMessage(PHONE, 'hi');
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, SUPPORT_GREETING);
  });

  it('is sent once, not after every line the customer types', async () => {
    settingsService.getSetting.mockImplementation(async (k: string) =>
      k.startsWith('whatsapp:greeted:') ? { settingValue: new Date().toISOString() } : null,
    );
    await handleUnrecognizedMessage(PHONE, 'and another thing');
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('is sent again once the cooldown has passed', async () => {
    const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    settingsService.getSetting.mockImplementation(async (k: string) =>
      k.startsWith('whatsapp:greeted:') ? { settingValue: thirteenHoursAgo } : null,
    );
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
    await expect(supportInbox()).resolves.toBeNull();
    await handleUnrecognizedMessage(PHONE, 'hi');
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('defaults to the published address in production', async () => {
    process.env.NODE_ENV = 'production';
    await expect(supportInbox()).resolves.toBe('founders@agentweb.pro');
  });

  it('can be pointed at an inbox at runtime through a setting', async () => {
    settingsService.getSetting.mockImplementation(async (k: string) =>
      k === 'whatsapp:support-inbox' ? { settingValue: 'help@example.com' } : null,
    );
    await expect(supportInbox()).resolves.toBe('help@example.com');
  });

  it('lets the environment variable win over the setting', async () => {
    process.env.WHATSAPP_SUPPORT_INBOX = 'env@example.com';
    settingsService.getSetting.mockResolvedValue({ settingValue: 'help@example.com' });
    await expect(supportInbox()).resolves.toBe('env@example.com');
  });

  it('falls back to the default when the setting cannot be read', async () => {
    process.env.NODE_ENV = 'production';
    settingsService.getSetting.mockRejectedValue(new Error('dynamo down'));
    await expect(supportInbox()).resolves.toBe('founders@agentweb.pro');
  });

  it('forwards the customer query with who it is from', async () => {
    process.env.WHATSAPP_SUPPORT_INBOX = 'support@example.com';
    whatsapp.resolveUserIdByPhone.mockResolvedValue('user-1');
    userDb.getUserById.mockResolvedValue({ userId: 'user-1', email: 'cust@example.com' });

    await handleUnrecognizedMessage(PHONE, 'My campaign is stuck');

    const [to, subject, textBody] = emailService.sendEmail.mock.calls[0];
    expect(to).toBe('support@example.com');
    // The subject is logged by the mail layer, so it carries only the last four digits.
    expect(subject).not.toContain('918005326946');
    expect(subject).toContain('6946');
    // The body is where the team gets the full number to reply to.
    expect(textBody).toContain(PHONE);
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
    settingsService.getSetting.mockImplementation(async (k: string) =>
      k.startsWith('whatsapp:greeted:') ? { settingValue: new Date().toISOString() } : null,
    );
    await handleUnrecognizedMessage(PHONE, 'second line of my question');
    expect(emailService.sendEmail).toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('still greets when sending the forward fails, and never throws', async () => {
    process.env.WHATSAPP_SUPPORT_INBOX = 'support@example.com';
    emailService.sendEmail.mockRejectedValue(new Error('ses down'));
    await expect(handleUnrecognizedMessage(PHONE, 'hi')).resolves.toBeUndefined();
    expect(whatsapp.sendText).toHaveBeenCalled();
  });

  it('logs — without the number — when the mailer reports a failed forward', async () => {
    // sendEmail never throws; it RETURNS 'failed'. The customer was promised a reply, so
    // a lost forward must not be silent.
    process.env.WHATSAPP_SUPPORT_INBOX = 'support@example.com';
    emailService.sendEmail.mockResolvedValue('failed');
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await handleUnrecognizedMessage(PHONE, 'hi');
    const logged = (console.error as jest.Mock).mock.calls.flat().join(' ');
    expect(logged).toMatch(/could not forward/);
    expect(logged).not.toContain('918005326946');
  });

  it('does not log an error when the non-prod guard suppresses the forward', async () => {
    process.env.WHATSAPP_SUPPORT_INBOX = 'support@example.com';
    emailService.sendEmail.mockResolvedValue('suppressed');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await handleUnrecognizedMessage(PHONE, 'hi');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('keeps the phone number out of its logs', async () => {
    whatsapp.sendText.mockRejectedValue(new Error('x'));
    await handleUnrecognizedMessage(PHONE, 'hi');
    const logged = (console.warn as jest.Mock).mock.calls.flat().join(' ');
    expect(logged).not.toContain('918005326946');
  });
});

describe('the hourly forward limit', () => {
  const conditionalFailure = () => Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' });
  const isCounter = (k: string) => k.startsWith('whatsapp:forwards:');

  beforeEach(() => {
    process.env.WHATSAPP_SUPPORT_INBOX = 'support@example.com';
    settingsService.setSettingIfValueMatches.mockResolvedValue(undefined);
  });

  const counter = (used: number) =>
    settingsService.getSetting.mockImplementation(async (k: string) =>
      isCounter(k) ? { settingValue: String(used) } : null,
    );

  it('creates the counter on the first forward of the hour', async () => {
    await handleUnrecognizedMessage(PHONE, 'hello');
    const call = settingsService.setSetting.mock.calls.find((c: any[]) => isCounter(c[0]));
    expect(call[0]).toMatch(/^whatsapp:forwards:\+918005326946:\d{4}-\d{2}-\d{2}T\d{2}$/);
    expect(call[1]).toBe('1');
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('increments with a compare-and-swap against the value it read', async () => {
    counter(3);
    await handleUnrecognizedMessage(PHONE, 'hello');
    // Not an overwrite: a burst of simultaneous messages cannot all pass one read and all
    // write the same count.
    const [key, next, expected] = settingsService.setSettingIfValueMatches.mock.calls[0];
    expect(isCounter(key)).toBe(true);
    expect(next).toBe('4');
    expect(expected).toBe('3');
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('re-reads and retries when it loses the swap to a concurrent message', async () => {
    let reads = 0;
    settingsService.getSetting.mockImplementation(async (k: string) => {
      if (!isCounter(k)) return null;
      reads += 1;
      return { settingValue: reads === 1 ? '3' : '4' };
    });
    settingsService.setSettingIfValueMatches
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce(undefined);

    await handleUnrecognizedMessage(PHONE, 'hello');
    const swaps = settingsService.setSettingIfValueMatches.mock.calls;
    expect(swaps).toHaveLength(2);
    expect(swaps[1][1]).toBe('5'); // built on the fresh value, not the stale one
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('stops forwarding once the allowance is used up, so one number cannot flood the inbox', async () => {
    counter(20);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await handleUnrecognizedMessage(PHONE, 'spam');
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(settingsService.setSettingIfValueMatches).not.toHaveBeenCalled();
  });

  it('still greets a number that is over its allowance', async () => {
    counter(20);
    await handleUnrecognizedMessage(PHONE, 'spam');
    expect(whatsapp.sendText).toHaveBeenCalled();
  });

  it('keeps the number out of the over-limit log', async () => {
    counter(20);
    await handleUnrecognizedMessage(PHONE, 'spam');
    const logged = (console.warn as jest.Mock).mock.calls.flat().join(' ');
    expect(logged).toMatch(/exceeded/);
    expect(logged).not.toContain('918005326946');
  });

  it('expires the counter in epoch SECONDS', async () => {
    counter(3);
    await handleUnrecognizedMessage(PHONE, 'hello');
    const ttl = settingsService.setSettingIfValueMatches.mock.calls[0][5];
    const hours = (ttl - Date.now() / 1000) / 3600;
    expect(hours).toBeGreaterThan(1.9);
    expect(hours).toBeLessThan(2.1);
  });

  it('fails OPEN: a limiter fault never costs a customer their message', async () => {
    settingsService.getSetting.mockImplementation(async (k: string) => {
      if (isCounter(k)) throw new Error('dynamo down');
      return null;
    });
    await handleUnrecognizedMessage(PHONE, 'hello');
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('fails OPEN on a swap error that is not a lost race', async () => {
    counter(3);
    settingsService.setSettingIfValueMatches.mockRejectedValue(new Error('throttled'));
    await handleUnrecognizedMessage(PHONE, 'hello');
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('admits the message rather than dropping it when the swap stays contended', async () => {
    counter(3);
    settingsService.setSettingIfValueMatches.mockRejectedValue(conditionalFailure());
    await handleUnrecognizedMessage(PHONE, 'hello');
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe('media messages', () => {
  beforeEach(() => {
    process.env.WHATSAPP_SUPPORT_INBOX = 'support@example.com';
  });

  it('tells the team what the attachment is and where to find it', async () => {
    await handleUnrecognizedMessage(PHONE, 'my dashboard is broken', 'image', 'image, media id MEDIA-123');
    const [, , textBody, html] = emailService.sendEmail.mock.calls[0];
    expect(textBody).toContain('my dashboard is broken');
    expect(textBody).toContain('Attachment: image, media id MEDIA-123');
    expect(textBody).toMatch(/not attached to this email.*WhatsApp Manager/);
    expect(html).toContain('media id MEDIA-123');
  });

  it('still forwards a media message with no caption, and says so', async () => {
    await handleUnrecognizedMessage(PHONE, '', 'document', 'document, file "invoice.pdf", media id M9');
    const textBody = emailService.sendEmail.mock.calls[0][2];
    expect(textBody).toContain('[document message — no text]');
    expect(textBody).toContain('invoice.pdf');
  });

  it('escapes a hostile filename in the HTML body', async () => {
    await handleUnrecognizedMessage(PHONE, '', 'document', 'document, file "<img src=x onerror=1>.pdf"');
    const html = emailService.sendEmail.mock.calls[0][3];
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('adds no attachment line to a plain text message', async () => {
    await handleUnrecognizedMessage(PHONE, 'hello');
    expect(emailService.sendEmail.mock.calls[0][2]).not.toContain('Attachment:');
  });
});
