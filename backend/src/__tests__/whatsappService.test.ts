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
