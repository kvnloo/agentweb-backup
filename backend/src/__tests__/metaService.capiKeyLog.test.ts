/**
 * ENG-926 AC2 — the send-side record of what identity reached Meta.
 *
 * Meta's `/stats?aggregation=match_keys` does NOT report `fbc` or `fbp`. Verified 2026-08-18
 * across three production pixels with real paid traffic and ~15 distinct event types: zero
 * occurrences of either, including on a lander proven to set both cookies. AC2 was once judged
 * FAILED on the inference "no fbc in match_keys, therefore no fbc was sent" — an instrument
 * that cannot measure the thing it was being read for.
 *
 * This log line is the only send-side proof available without Business Manager access, so the
 * tests below pin BOTH halves of its contract: it names every key, and it leaks no value.
 */

import { metaService } from '../services/metaService';
import * as crypto from 'crypto';

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

/** EVERY argument of every call, not just the first — a value logged as a second argument
 *  would otherwise be invisible to these assertions. */
const allLogOutput = () =>
  logSpy.mock.calls.map((c) => c.map((a: any) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')).join('\n');

const okResponse = () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ fbtrace_id: 'trace-xyz' }),
});

let logSpy: jest.SpyInstance;
let originalFetch: any;

beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  originalFetch = (global as any).fetch;
  (global as any).fetch = jest.fn().mockResolvedValue(okResponse());
});

afterEach(() => {
  logSpy.mockRestore();
  (global as any).fetch = originalFetch;
});

const capiLine = () =>
  logSpy.mock.calls
    .map((c) => c.map((a: any) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    .find((l) => l.includes('user_data keys:')) ?? '';

describe('the CAPI key-set log', () => {
  it('names fbc and fbp when they are sent — the claim /stats cannot support', async () => {
    await (metaService as any).sendCapiLeadEvent('px1', 'tok', {
      eventId: 'evt-1',
      email: 'someone@example.test',
      firstName: 'Ada',
      lastName: 'Lovelace',
      fbc: 'fb.1.1787057756535.SYNTHETICCLICKID',
      fbp: 'fb.1.1787057756458.1234567890',
      eventName: 'Schedule',
    });

    const line = capiLine();
    expect(line).toContain('CAPI Schedule accepted');
    expect(line).toContain('px1');
    expect(line).toContain('evt-1');
    // Sorted, so the assertion does not depend on construction order.
    expect(line).toContain('user_data keys: em,fbc,fbp,fn,ln');
  });

  it('LEAKS NO VALUES — not the click id, not the email, not a hash', async () => {
    await (metaService as any).sendCapiLeadEvent('px1', 'tok', {
      eventId: 'evt-2',
      email: 'leak-check@example.test',
      phone: '+15550100839',
      fbc: 'fb.1.1787057756535.DO_NOT_LOG_THIS_CLICK_ID',
      fbp: 'fb.1.1787057756458.DO_NOT_LOG_THIS_BROWSER_ID',
      clientIp: '203.0.113.55',
      userAgent: 'Mozilla/5.0 (a real browser)',
      eventName: 'Lead',
    });

    const all = allLogOutput();

    // Plaintext.
    expect(all).not.toContain('DO_NOT_LOG_THIS_CLICK_ID');
    expect(all).not.toContain('DO_NOT_LOG_THIS_BROWSER_ID');
    expect(all).not.toContain('leak-check@example.test');
    expect(all).not.toContain('203.0.113.55');
    expect(all).not.toContain('Mozilla/5.0');
    expect(all).not.toContain('15550100839');

    // And the HASHES — which is the form a real leak would actually take. `userData.em` and
    // `userData.ph` hold SHA-256 digests, never the plaintext, so a regression that logged
    // the VALUES of user_data would emit these and every assertion above would still pass.
    expect(all).not.toContain(sha256('leak-check@example.test'));
    expect(all).not.toContain(sha256('15550100839'));
    // The KEYS are still named, so suppressing values did not suppress the evidence.
    expect(capiLine()).toContain('client_ip_address');
    expect(capiLine()).toContain('fbc');
  });

  it('reports (none) rather than an empty list when no identity was available', async () => {
    await (metaService as any).sendCapiLeadEvent('px1', 'tok', { eventId: 'evt-3' });
    expect(capiLine()).toContain('user_data keys: (none)');
  });

  it('omits fbc from the key list when none was resolved — the failure AC2 was looking for', async () => {
    await (metaService as any).sendCapiLeadEvent('px1', 'tok', {
      eventId: 'evt-4',
      email: 'someone@example.test',
      firstName: 'Ada',
      lastName: 'Lovelace',
      eventName: 'Schedule',
    });
    const line = capiLine();
    expect(line).toContain('user_data keys: em,fn,ln');
    expect(line).not.toContain('fbc');
  });

  it('does not log the line at all when Meta rejects the event', async () => {
    // A rejected send must not leave a record implying identity reached Meta.
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      json: async () => ({ error: { message: 'Invalid parameter' } }),
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await (metaService as any).sendCapiLeadEvent('px1', 'tok', {
      eventId: 'evt-5',
      fbc: 'fb.1.1.X',
      eventName: 'Schedule',
    });

    expect(capiLine()).toBe('');
  });
});
