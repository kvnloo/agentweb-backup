/**
 * sendCapiLeadEvent (server-side Meta Conversions API).
 *
 * Fires a `Lead` event to Meta's CAPI from our own trusted backend (never from a generated
 * customer repo, which would leak the access token). Must never throw — a Meta-side failure
 * must not affect the lead save that already succeeded in the caller (webhooks.ts).
 */

import { metaService } from '../services/metaService';
import * as crypto from 'crypto';

describe('sendCapiLeadEvent', () => {
  let mockFetch: jest.SpyInstance;

  beforeEach(() => {
    mockFetch = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  const baseEvent = {
    eventId: 'evt_abc123',
    email: 'Test@Example.com',
    firstName: 'Jane',
    phone: '+1 555 000 1111',
    clientIp: '1.2.3.4',
    userAgent: 'Mozilla/5.0',
    sourceUrl: 'https://example.com/landing',
  };

  it('returns { success:false } (not throw) on an invalid/expired access token response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: jest.fn().mockResolvedValue({ error: { message: 'Error validating access token' } }),
    });

    const result = await metaService.sendCapiLeadEvent('px1', 'bad-token', baseEvent);
    expect(result.success).toBe(false);
  });

  it('returns { success:false } (not throw) when the Graph API returns an error payload', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ error: { message: 'Invalid parameter' } }),
    });

    const result = await metaService.sendCapiLeadEvent('px1', 'tok', baseEvent);
    expect(result.success).toBe(false);
  });

  it('returns { success:false } (not throw) when fetch itself rejects (network error)', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNRESET'));

    const result = await metaService.sendCapiLeadEvent('px1', 'tok', baseEvent);
    expect(result.success).toBe(false);
  });

  it('defaults event_name to "Lead" when no eventName is passed (existing callers, e.g. webhooks.ts)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ events_received: 1, fbtrace_id: 'trace1' }),
    });

    await metaService.sendCapiLeadEvent('px1', 'tok', baseEvent);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data[0].event_name).toBe('Lead');
  });

  it('sends the given eventName instead of "Lead" when one is passed (e.g. Calendly bookings send "Schedule", ENG-524)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ events_received: 1, fbtrace_id: 'trace1' }),
    });

    await metaService.sendCapiLeadEvent('px1', 'tok', { ...baseEvent, eventName: 'Schedule' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data[0].event_name).toBe('Schedule');
  });

  it('still sends even with no email and no phone (must not silently under-report Leads)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ events_received: 1, fbtrace_id: 'trace1' }),
    });

    const { email, phone, ...rest } = baseEvent;
    const result = await metaService.sendCapiLeadEvent('px1', 'tok', rest);
    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalled();
  });

  it('sends the exact CAPI payload shape, with a sha256-hashed email (not raw)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ events_received: 1, fbtrace_id: 'trace1' }),
    });

    const result = await metaService.sendCapiLeadEvent('px1', 'tok', baseEvent);
    expect(result.success).toBe(true);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/px1/events'),
      expect.objectContaining({ method: 'POST' }),
    );

    const call = mockFetch.mock.calls[0];
    const options = call[1];
    const body = JSON.parse(options.body);
    expect(body.access_token).toBe('tok');
    expect(body.data).toHaveLength(1);

    const evt = body.data[0];
    expect(evt.event_name).toBe('Lead');
    expect(evt.event_id).toBe('evt_abc123');
    expect(evt.action_source).toBe('website');
    expect(evt.event_source_url).toBe('https://example.com/landing');
    expect(typeof evt.event_time).toBe('number');

    // Email must be normalized (trim+lowercase) then sha256-hashed — never sent raw.
    const expectedHash = crypto.createHash('sha256').update('test@example.com').digest('hex');
    expect(evt.user_data.em).toEqual([expectedHash]);
    expect(JSON.stringify(evt.user_data)).not.toContain('Test@Example.com');

    expect(evt.user_data.client_ip_address).toBe('1.2.3.4');
    expect(evt.user_data.client_user_agent).toBe('Mozilla/5.0');
  });

  // ENG-492: Meta's documented CAPI normalization for `ph` is digits-only, then strip any
  // leading zero(s) (a national-dialing-prefix artifact, e.g. a UK number entered with its
  // domestic leading 0) before hashing. Missing before this: only non-digits were stripped.
  it('normalizes phone by stripping non-digits AND any leading zero(s) before hashing (Meta CAPI spec)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ events_received: 1, fbtrace_id: 'trace1' }),
    });

    await metaService.sendCapiLeadEvent('px1', 'tok', { ...baseEvent, phone: '07911 123456' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const expectedHash = crypto.createHash('sha256').update('7911123456').digest('hex');
    expect(body.data[0].user_data.ph).toEqual([expectedHash]);
  });

  it('does not strip digits that are not part of a leading-zero run (e.g. a 1 after the leading zeros stays)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ events_received: 1, fbtrace_id: 'trace1' }),
    });

    await metaService.sendCapiLeadEvent('px1', 'tok', { ...baseEvent, phone: '001 555 000 1111' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const expectedHash = crypto.createHash('sha256').update('15550001111').digest('hex');
    expect(body.data[0].user_data.ph).toEqual([expectedHash]);
  });

  // fbp/fbc are Meta's own first-party click-id cookies (set by the base Pixel snippet /
  // ad-click redirect) — a real match-quality signal, sent as opaque values (NOT hashed,
  // per Meta's CAPI spec — only PII fields like em/ph get sha256'd).
  it('includes user_data.fbp/fbc verbatim (not hashed) when provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ events_received: 1, fbtrace_id: 'trace1' }),
    });

    await metaService.sendCapiLeadEvent('px1', 'tok', {
      ...baseEvent,
      fbp: 'fb.1.1234567890.1122334455',
      fbc: 'fb.1.1234567890.AbCdEfGhIj',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data[0].user_data.fbp).toBe('fb.1.1234567890.1122334455');
    expect(body.data[0].user_data.fbc).toBe('fb.1.1234567890.AbCdEfGhIj');
  });

  it('omits user_data.fbp/fbc when not provided (does not send undefined/empty fields)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ events_received: 1, fbtrace_id: 'trace1' }),
    });

    await metaService.sendCapiLeadEvent('px1', 'tok', baseEvent);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data[0].user_data.fbp).toBeUndefined();
    expect(body.data[0].user_data.fbc).toBeUndefined();
  });

  // --- X-Business-Use-Case-Usage (Meta's real, dynamic CAPI rate-limit signal) ---

  it('parses a present X-Business-Use-Case-Usage header into result.usage', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ events_received: 1, fbtrace_id: 'trace1' }),
      headers: {
        get: (name: string) =>
          name === 'x-business-use-case-usage'
            ? JSON.stringify({ act_123: [{ type: 'ads_management', call_count: 42, total_cputime: 10, total_time: 15 }] })
            : null,
      },
    });

    const result = await metaService.sendCapiLeadEvent('px1', 'tok', baseEvent);

    expect(result.success).toBe(true);
    expect(result.usage).toEqual({
      callCountPct: 42,
      totalTimePct: 15,
      totalCpuTimePct: 10,
      estimatedMinutesToRegainAccess: undefined,
    });
  });

  it('parses estimated_time_to_regain_access once actually throttled', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: jest.fn().mockResolvedValue({ error: { message: 'User request limit reached' } }),
      headers: {
        get: (name: string) =>
          name === 'x-business-use-case-usage'
            ? JSON.stringify({ act_123: [{ type: 'ads_management', call_count: 100, total_cputime: 40, total_time: 55, estimated_time_to_regain_access: 7 }] })
            : null,
      },
    });

    const result = await metaService.sendCapiLeadEvent('px1', 'tok', baseEvent);

    expect(result.success).toBe(false);
    expect(result.usage?.estimatedMinutesToRegainAccess).toBe(7);
    expect(result.usage?.callCountPct).toBe(100);
  });

  it('a response with no .headers at all (every other test in this file) still resolves normally, usage is undefined', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ events_received: 1, fbtrace_id: 'trace1' }),
    });

    const result = await metaService.sendCapiLeadEvent('px1', 'tok', baseEvent);

    expect(result.success).toBe(true);
    expect(result.usage).toBeUndefined();
  });

  it('a malformed (non-JSON) header value is caught, not thrown', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ events_received: 1, fbtrace_id: 'trace1' }),
      headers: { get: (name: string) => (name === 'x-business-use-case-usage' ? 'not-json{{{' : null) },
    });

    const result = await metaService.sendCapiLeadEvent('px1', 'tok', baseEvent);

    expect(result.success).toBe(true);
    expect(result.usage).toBeUndefined();
  });

  // --- event_time: real client-submission time, not server CAPI-send time (ENG-449) ---

  it('uses a valid eventTimeSeconds verbatim as event_time', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ events_received: 1, fbtrace_id: 'trace1' }),
    });

    await metaService.sendCapiLeadEvent('px1', 'tok', { ...baseEvent, eventTimeSeconds: 1750000000 });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data[0].event_time).toBe(1750000000);
  });

  it.each([
    ['NaN', NaN],
    ['negative', -5],
    ['non-integer', 123.45],
    ['zero', 0],
  ])('falls back to current server time when eventTimeSeconds is invalid (%s)', async (_label, invalid) => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ events_received: 1, fbtrace_id: 'trace1' }),
    });
    const before = Math.floor(Date.now() / 1000);

    await metaService.sendCapiLeadEvent('px1', 'tok', { ...baseEvent, eventTimeSeconds: invalid as number });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data[0].event_time).toBeGreaterThanOrEqual(before);
    expect(body.data[0].event_time).not.toBe(invalid);
  });

  it('falls back to current server time when eventTimeSeconds is omitted entirely (matches every pre-existing test/caller)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ events_received: 1, fbtrace_id: 'trace1' }),
    });
    const before = Math.floor(Date.now() / 1000);

    await metaService.sendCapiLeadEvent('px1', 'tok', baseEvent);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data[0].event_time).toBeGreaterThanOrEqual(before);
  });

  // ENG-926 §C: custom_data carries the revenue on a closed-won Purchase. Without
  // value/currency the event still counts but is useless for value-based bidding, which
  // is the entire reason the CRM → Meta relay exists.
  describe('custom_data', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ events_received: 1, fbtrace_id: 'trace1' }),
      });
    });

    it('omits custom_data entirely when no customData is passed — existing callers unchanged', async () => {
      await metaService.sendCapiLeadEvent('px1', 'tok', baseEvent);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data[0]).not.toHaveProperty('custom_data');
    });

    it('emits value and currency when both are supplied', async () => {
      await metaService.sendCapiLeadEvent('px1', 'tok', {
        ...baseEvent,
        eventName: 'Purchase',
        customData: { value: 5000, currency: 'USD' },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data[0].custom_data).toEqual({ value: 5000, currency: 'USD' });
    });

    it('emits currency alone when the deal has no value — a won deal with no amount is still a conversion', async () => {
      await metaService.sendCapiLeadEvent('px1', 'tok', {
        ...baseEvent,
        eventName: 'Purchase',
        customData: { currency: 'EUR' },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data[0].custom_data).toEqual({ currency: 'EUR' });
    });

    it('emits a zero value rather than dropping it — 0 is a real amount, not "absent"', async () => {
      await metaService.sendCapiLeadEvent('px1', 'tok', {
        ...baseEvent,
        eventName: 'Purchase',
        customData: { value: 0, currency: 'USD' },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data[0].custom_data.value).toBe(0);
    });

    it('omits custom_data when the object is present but empty', async () => {
      await metaService.sendCapiLeadEvent('px1', 'tok', { ...baseEvent, customData: {} });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data[0]).not.toHaveProperty('custom_data');
    });
  });
});
