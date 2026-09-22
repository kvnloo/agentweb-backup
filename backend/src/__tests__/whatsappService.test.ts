/**
 * whatsappService — WhatsApp Cloud API channel (ENG-273).
 *
 * Two platform rules drive almost every test here, and both are things Meta enforces
 * rather than preferences we chose:
 *
 *  1. The 24-hour service window. Free-form text is only legal inside it; outside, the
 *     send MUST use a pre-approved template. Getting this wrong is not a soft failure —
 *     it is error 131047 and a message the customer never receives.
 *  2. Marketing templates to US (+1) numbers have been paused by Meta since
 *     2025-04-01 and still are. Those sends fail with 131049. AgentWeb's customer base
 *     is US-centric, so this must surface as an actionable error at the boundary
 *     rather than as a mystery delivery failure.
 *
 * Opt-in/opt-out is likewise a platform obligation: STOP must take effect immediately
 * and must hold even when the phone maps to no known user.
 */

import {
  sendMessage,
  sendTemplate,
  toTemplateParam,
  redactPhone,
  getDisplayPhoneNumber,
  __resetDisplayPhoneNumberCache,
  toE164,
  recordInboundMessage,
  isServiceWindowOpen,
  recordOptOut,
  recordOptIn,
  isOptedOut,
  WhatsAppError,
  WhatsAppMarketingPausedError,
  WhatsAppWindowClosedError,
  WhatsAppOptedOutError,
  WhatsAppUndeliverableError,
  WhatsAppRateLimitError,
  TEMPLATES,
} from '../services/whatsappService';
import { MessagingChannelError } from '../services/messagingChannelService';

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    deleteSetting: jest.fn(),
  },
}));
jest.mock('../utils/secretsManager', () => ({
  getWhatsAppCredentials: jest.fn(),
}));

const { settingsService } = require('../services/settingsService');
const { getWhatsAppCredentials } = require('../utils/secretsManager');

const OK_RESPONSE = { messages: [{ id: 'wamid.TEST1' }] };

/** Meta error envelope, as the Graph API actually returns it. */
const metaError = (code: number, detail = 'boom') => ({
  error: { message: detail, type: 'OAuthException', code: 131000, error_data: { details: detail }, error_subcode: code },
});

let fetchMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  getWhatsAppCredentials.mockResolvedValue({
    phoneNumberId: '111',
    wabaId: '222',
    accessToken: 'tok',
    appSecret: 'sec',
    webhookVerifyToken: 'verify',
  });
  settingsService.getSetting.mockResolvedValue(null);
  settingsService.setSetting.mockResolvedValue(undefined);
  settingsService.deleteSetting.mockResolvedValue(undefined);
  fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => OK_RESPONSE,
  });
  (global as any).fetch = fetchMock;
});

// ── Destination normalization ──────────────────────────────────────────────

describe('toE164', () => {
  it('normalizes a US national number to E.164', () => {
    expect(toE164('(415) 555-0123', 'US')).toBe('+14155550123');
  });

  it('accepts an already-E.164 international number', () => {
    expect(toE164('+919700041411')).toBe('+919700041411');
  });

  it('rejects a number that cannot be strictly validated', () => {
    // Deliberately stricter than utils/phoneValidation.sanitizePhone, whose
    // digit-count fallback exists so enrichment does not DISCARD a local-format
    // number. Storing an ambiguous number is fine; messaging one is not.
    expect(toE164('97000 41411')).toBeNull();
    expect(toE164('555-CALL-NOW')).toBeNull();
    expect(toE164('')).toBeNull();
  });

  it('rejects a US number missing its area code rather than guessing', () => {
    expect(toE164('5550123', 'US')).toBeNull();
  });
});

// ── Service window ─────────────────────────────────────────────────────────

describe('24-hour service window', () => {
  it('is closed when the customer has never messaged us', async () => {
    await expect(isServiceWindowOpen('+14155550123')).resolves.toBe(false);
  });

  it('opens when an inbound message is recorded', async () => {
    await recordInboundMessage('+14155550123');
    expect(settingsService.setSetting).toHaveBeenCalledWith(
      'whatsapp:window:+14155550123',
      expect.any(String),
      expect.any(String),
      'system',
      expect.any(Number),
    );
  });

  it('sets a DynamoDB TTL so a stale window expires without a sweeper', async () => {
    const before = Math.floor(Date.now() / 1000);
    await recordInboundMessage('+14155550123');
    const ttl = settingsService.setSetting.mock.calls[0][4];
    // ~24h out, in epoch SECONDS (not ms — the TTL attribute is seconds).
    expect(ttl).toBeGreaterThan(before + 23 * 3600);
    expect(ttl).toBeLessThanOrEqual(before + 25 * 3600);
  });

  it('reports open for an inbound recorded just now', async () => {
    settingsService.getSetting.mockResolvedValue({ settingValue: new Date().toISOString() });
    await expect(isServiceWindowOpen('+14155550123')).resolves.toBe(true);
  });

  it('reports closed for an inbound older than 24h even if the record survives', async () => {
    // TTL deletion is asynchronous and Dynamo makes no promptness guarantee, so the
    // window must be decided by the timestamp, never by the row still existing.
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    settingsService.getSetting.mockResolvedValue({ settingValue: old });
    await expect(isServiceWindowOpen('+14155550123')).resolves.toBe(false);
  });

  it('treats an unparseable stored timestamp as closed', async () => {
    settingsService.getSetting.mockResolvedValue({ settingValue: 'not-a-date' });
    await expect(isServiceWindowOpen('+14155550123')).resolves.toBe(false);
  });
});

// ── Consent ────────────────────────────────────────────────────────────────

describe('opt-out (STOP)', () => {
  it('records an opt-out', async () => {
    await recordOptOut('+14155550123');
    expect(settingsService.setSetting).toHaveBeenCalledWith(
      'whatsapp:optout:+14155550123',
      expect.any(String),
      expect.any(String),
      'system',
    );
  });

  it('reports a recorded opt-out', async () => {
    settingsService.getSetting.mockResolvedValue({ settingValue: new Date().toISOString() });
    await expect(isOptedOut('+14155550123')).resolves.toBe(true);
  });

  it('opts back in on UNSTOP by clearing the record', async () => {
    await recordOptIn('+14155550123', 'unstop_keyword');
    expect(settingsService.deleteSetting).toHaveBeenCalledWith('whatsapp:optout:+14155550123');
  });

  it('blocks a send to an opted-out number before any network call', async () => {
    settingsService.getSetting.mockImplementation(async (k: string) =>
      k.startsWith('whatsapp:optout:') ? { settingValue: 'x' } : null,
    );
    await expect(sendMessage({ destination: '+14155550123', text: 'hi' })).rejects.toBeInstanceOf(
      WhatsAppOptedOutError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not put the raw phone number in the opted-out error message', async () => {
    // This error's .message ends up in application logs at every catch site up the
    // call chain (ship-notify, lead alerts) — it must not carry cleartext PII either.
    settingsService.getSetting.mockImplementation(async (k: string) =>
      k.startsWith('whatsapp:optout:') ? { settingValue: 'x' } : null,
    );
    const err: any = await sendMessage({ destination: '+14155550123', text: 'hi' }).catch((e) => e);
    expect(err.message).not.toContain('4155550123');
    expect(err.message).toContain('0123');
  });

  it('records an opt-out even for a number that maps to no known user', async () => {
    // STOP is a platform obligation, not a CRM operation. A blocklist keyed on the
    // phone is the only thing that works when the sender is not a known contact.
    await expect(recordOptOut('+19999999999')).resolves.toBeUndefined();
    expect(settingsService.setSetting).toHaveBeenCalled();
  });
});

// ── Send routing: window decides text vs template ──────────────────────────

describe('sendMessage — window-aware routing', () => {
  it('sends free-form text when the window is open', async () => {
    settingsService.getSetting.mockImplementation(async (k: string) =>
      k.startsWith('whatsapp:window:') ? { settingValue: new Date().toISOString() } : null,
    );
    await sendMessage({ destination: '+14155550123', text: 'hello' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe('text');
    expect(body.text.body).toBe('hello');
  });

  it('refuses a free-form send outside the window instead of letting Meta reject it', async () => {
    await expect(sendMessage({ destination: '+14155550123', text: 'hello' })).rejects.toBeInstanceOf(
      WhatsAppWindowClosedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not put the raw phone number in the window-closed error message', async () => {
    const err: any = await sendMessage({ destination: '+14155550123', text: 'hello' }).catch((e) => e);
    expect(err.message).not.toContain('4155550123');
    expect(err.message).toContain('0123');
  });

  it('sends the supplied template when the window is closed', async () => {
    await sendMessage({
      destination: '+14155550123',
      text: 'hello',
      template: { name: TEMPLATES.SHIP_NOTIFY.name, variables: ['Dark mode', 'https://x/y'] },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe('template');
    expect(body.template.name).toBe(TEMPLATES.SHIP_NOTIFY.name);
  });

  it('rejects a destination that is not a valid phone before calling Meta', async () => {
    await expect(sendMessage({ destination: 'not-a-phone', text: 'x' })).rejects.toBeInstanceOf(
      WhatsAppError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redacts even the raw, not-yet-validated destination in the invalid-phone error', async () => {
    // Not yet confirmed as E.164, but very likely a real attempted phone number.
    const err: any = await sendMessage({ destination: '+14155550123x', text: 'x' }).catch((e) => e);
    expect(err.message).not.toContain('4155550123');
  });

  it('returns the provider message handle', async () => {
    settingsService.getSetting.mockImplementation(async (k: string) =>
      k.startsWith('whatsapp:window:') ? { settingValue: new Date().toISOString() } : null,
    );
    await expect(sendMessage({ destination: '+14155550123', text: 'hi' })).resolves.toEqual({
      messageId: 'wamid.TEST1',
    });
  });
});

// ── Template registry ──────────────────────────────────────────────────────

describe('template registry', () => {
  it('declares name, language and variable order as constants', () => {
    // docs/integrations/README.md is explicit that an agent must not guess vendor
    // enums. Template names and variable ORDER are exactly that: Meta positions
    // {{1}}, {{2}} by index, so a reordering silently sends the wrong words.
    for (const tpl of Object.values(TEMPLATES)) {
      expect(typeof tpl.name).toBe('string');
      expect(typeof tpl.language).toBe('string');
      expect(Array.isArray(tpl.variables)).toBe(true);
    }
  });

  it('sends template variables as positional body parameters in declared order', async () => {
    await sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['Dark mode', 'https://x/y']);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const bodyComponent = body.template.components.find((c: any) => c.type === 'body');
    expect(bodyComponent.parameters.map((p: any) => p.text)).toEqual(['Dark mode', 'https://x/y']);
  });

  it('rejects a variable-count mismatch rather than sending a broken template', async () => {
    await expect(
      sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['only-one']),
    ).rejects.toBeInstanceOf(WhatsAppError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Template parameter hygiene ─────────────────────────────────────────────

describe('template parameter hygiene', () => {
  // Meta rejects an empty body parameter, a newline/tab inside one, and a run of 4+
  // spaces (132018) — each as a 400 that reads nothing like its cause. Values are
  // user-authored (public post titles, lead names), so the service enforces this.
  const bodyTexts = () => {
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    return body.template.components
      .find((c: any) => c.type === 'body')
      .parameters.map((p: any) => p.text);
  };

  it('leaves an ordinary value untouched', () => {
    expect(toTemplateParam('Dark mode — https://fb/p/dark?x=1&y=2')).toBe(
      'Dark mode — https://fb/p/dark?x=1&y=2',
    );
  });

  it('turns newlines and tabs into a space', () => {
    expect(toTemplateParam('line one\nline two\r\n\tline three')).toBe('line one line two line three');
  });

  it('collapses a run of spaces, which Meta rejects at four or more', () => {
    expect(toTemplateParam('a      b    c')).toBe('a b c');
  });

  it('replaces an empty or whitespace-only value with a placeholder', () => {
    expect(toTemplateParam('')).toBe('-');
    expect(toTemplateParam('   \n\t ')).toBe('-');
    expect(toTemplateParam(undefined as unknown as string)).toBe('-');
  });

  it('strips zero-width and bidi-override characters', () => {
    expect(toTemplateParam('pay​ment‮gnp.exe')).toBe('paymentgnp.exe');
  });

  it('a value that is only invisible characters becomes the placeholder, not empty', () => {
    expect(toTemplateParam('​‍﻿')).toBe('-');
  });

  it('caps at 1024 characters and never splits an emoji', () => {
    const out = toTemplateParam('😀'.repeat(2000));
    expect([...out]).toHaveLength(1024);
    expect(out.endsWith('…')).toBe(true);
    // A split surrogate pair would leave a lone half that JSON-encodes as garbage.
    expect(out).toBe(JSON.parse(JSON.stringify(out)));
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('does not truncate a value at exactly the limit', () => {
    expect(toTemplateParam('x'.repeat(1024))).toBe('x'.repeat(1024));
  });

  it('applies to the request actually sent to Meta, for every positional slot', async () => {
    await sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['Dark\nmode', '']);
    expect(bodyTexts()).toEqual(['Dark mode', '-']);
  });

  it('still counts an empty caller value as provided, so the placeholder is not a way around the count check', async () => {
    await expect(
      sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['only-one']),
    ).rejects.toBeInstanceOf(WhatsAppError);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['title', '']),
    ).resolves.toEqual({ messageId: 'wamid.TEST1' });
  });

  it('is applied on the window-closed sendMessage path too', async () => {
    await sendMessage({
      destination: '+14155550123',
      text: 'ignored — window closed',
      template: { name: TEMPLATES.LEAD_ALERT.name, variables: ['Ada\nLovelace', 'replied on  Q3 list'] },
    });
    expect(bodyTexts()).toEqual(['Ada Lovelace', 'replied on Q3 list']);
  });
});

describe('redactPhone', () => {
  it('keeps only the last 4 digits', () => {
    expect(redactPhone('+14155550123')).toBe('*******0123');
  });

  it('strips formatting characters before counting digits', () => {
    expect(redactPhone('+1 (415) 555-0123')).toBe('*******0123');
  });

  it('masks entirely rather than throwing on 4 or fewer digits', () => {
    expect(redactPhone('123')).toBe('***');
    expect(redactPhone('')).toBe('');
  });

  it('never contains the un-redacted middle digits', () => {
    const out = redactPhone('+14155550123');
    expect(out).not.toContain('4155550123'.slice(0, 6));
  });
});

// ── Display number ─────────────────────────────────────────────────────────

describe('getDisplayPhoneNumber', () => {
  // The number people are sent to message. Asked of Meta rather than configured: the
  // credentials carry the phone number ID, which is not the number, and a hand-copied
  // value that drifted would send verification messages to somebody else's WhatsApp.
  const displayResponse = (n = '+1 415-555-0100') => ({
    ok: true,
    status: 200,
    json: async () => ({ display_phone_number: n, id: '111' }),
  });

  beforeEach(() => {
    __resetDisplayPhoneNumberCache();
    fetchMock.mockResolvedValue(displayResponse());
  });

  it('returns the number as bare digits, ready for a wa.me link', async () => {
    await expect(getDisplayPhoneNumber()).resolves.toBe('14155550100');
  });

  it('asks Meta for display_phone_number of the configured phone number ID, with the token', async () => {
    await getDisplayPhoneNumber();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/111?fields=display_phone_number');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('bounds the request with a timeout so a hung Graph call cannot hang the route', async () => {
    await getDisplayPhoneNumber();
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('caches per phone number ID, so it is one lookup rather than one per request', async () => {
    await getDisplayPhoneNumber();
    await getDisplayPhoneNumber();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('looks again when the credentials point at a different phone number ID', async () => {
    await getDisplayPhoneNumber();
    getWhatsAppCredentials.mockResolvedValue({
      phoneNumberId: '999',
      wabaId: '222',
      accessToken: 'tok',
      appSecret: 'sec',
      webhookVerifyToken: 'verify',
    });
    fetchMock.mockResolvedValue(displayResponse('+44 20 7946 0000'));
    await expect(getDisplayPhoneNumber()).resolves.toBe('442079460000');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails without leaking the access token when Meta answers with an error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const err: any = await getDisplayPhoneNumber().catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppError);
    expect(err.message).toContain('401');
    expect(err.message).not.toContain('tok');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too short to be a number', '+123'],
  ])('refuses a response where the number is %s', async (_label, value) => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ display_phone_number: value }) });
    await expect(getDisplayPhoneNumber()).rejects.toBeInstanceOf(WhatsAppError);
  });

  it('does not cache a failure, so the next call can recover', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await expect(getDisplayPhoneNumber()).rejects.toBeInstanceOf(WhatsAppError);
    fetchMock.mockResolvedValue(displayResponse());
    await expect(getDisplayPhoneNumber()).resolves.toBe('14155550100');
  });
});

// ── Error mapping ──────────────────────────────────────────────────────────

describe('Meta error mapping', () => {
  const respondWith = (subcode: number, status = 400) => {
    fetchMock.mockResolvedValue({
      ok: false,
      status,
      json: async () => metaError(subcode),
    });
  };

  it('maps 131049 to an actionable US-marketing-pause error', async () => {
    respondWith(131049);
    const err = await sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['a', 'b']).catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppMarketingPausedError);
    // The next engineer must not have to search Meta's changelog to understand this.
    expect(err.message).toMatch(/marketing/i);
    expect(err.message).toMatch(/US|United States/);
  });

  it('maps 131047 to the window-closed error', async () => {
    respondWith(131047);
    await expect(
      sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['a', 'b']),
    ).rejects.toBeInstanceOf(WhatsAppWindowClosedError);
  });

  it('maps 131026 to undeliverable', async () => {
    respondWith(131026);
    await expect(
      sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['a', 'b']),
    ).rejects.toBeInstanceOf(WhatsAppUndeliverableError);
  });

  it('maps a 429 to a rate-limit error', async () => {
    respondWith(130429, 429);
    await expect(
      sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['a', 'b']),
    ).rejects.toBeInstanceOf(WhatsAppRateLimitError);
  });

  it('every mapped error is catchable as MessagingChannelError', async () => {
    respondWith(131049);
    await expect(
      sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['a', 'b']),
    ).rejects.toBeInstanceOf(MessagingChannelError);
  });

  it('surfaces an unmapped Meta error with its code instead of "Unknown error"', async () => {
    respondWith(999999);
    const err = await sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['a', 'b']).catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppError);
    expect(err.message).toMatch(/999999/);
  });

  it('surfaces a non-JSON gateway failure without throwing a parse error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    });
    await expect(
      sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['a', 'b']),
    ).rejects.toBeInstanceOf(WhatsAppError);
  });

  it('does not leak the access token into an error message', async () => {
    respondWith(131049);
    const err = await sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['a', 'b']).catch((e) => e);
    expect(err.message).not.toContain('tok');
  });
});

// ── Request shape ──────────────────────────────────────────────────────────

  it('bounds the send with a timeout, so a hung Graph request cannot hang the caller', async () => {
    await sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['a', 'b']);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

describe('Graph request shape', () => {
  it('posts to the configured phone number id with a bearer token', async () => {
    await sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['a', 'b']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/111/messages');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.method).toBe('POST');
  });

  it('addresses the recipient with messaging_product set to whatsapp', async () => {
    await sendTemplate('+14155550123', TEMPLATES.SHIP_NOTIFY, ['a', 'b']);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('+14155550123');
  });
});
