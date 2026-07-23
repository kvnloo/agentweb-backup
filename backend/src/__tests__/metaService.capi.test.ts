/**
 * ENG-449 — sendCapiLeadEvent (server-side Meta Conversions API).
 *
 * Fires a `Lead` event to Meta's CAPI from our own trusted backend (never from a generated
 * customer repo, which would leak the access token). Must never throw — a Meta-side failure
 * must not affect the lead save that already succeeded in the caller (webhooks.ts).
 */

import { metaService } from '../services/metaService';
import * as crypto from 'crypto';

describe('ENG-449 — sendCapiLeadEvent', () => {
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
});
