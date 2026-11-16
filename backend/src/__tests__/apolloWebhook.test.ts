/**
 * Tests for the Apollo waterfall webhook handler.
 *
 * Covers:
 *   - Path-based auth via /api/crm/webhooks/apollo/<secret>
 *   - Timing-safe compare (rejects wrong secrets, equal-length and not)
 *   - 503 when the secret can't load
 *   - Missing/invalid request_id
 *   - No placeholder cache row (replay or stale request_id)
 *   - Lead deleted before webhook arrives
 *   - Idempotent replay (apolloRequestId already stamped on the lead)
 *   - Successful write path
 */
import request from 'supertest';
import express from 'express';

const mockGetWebhookSecret = jest.fn();
jest.mock('../utils/secretsManager', () => ({
  getApolloWebhookSecret: () => mockGetWebhookSecret(),
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getEnrichmentCacheItem: jest.fn(),
    getLeadById: jest.fn(),
    updateLead: jest.fn(),
    getLeadListById: jest.fn(),
    setLeadEmailIfMissing: jest.fn(),
    putEnrichmentCacheItem: jest.fn(),
  },
}));

import apolloWebhookRouter, { cleanCallbackEmail, extractApolloEmail } from '../routes/apolloWebhook';
import { crmDb } from '../services/db';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

const app = express();
app.use(express.json());
app.use('/api/crm/webhooks/apollo', apolloWebhookRouter);

const SECRET = 'wh_secret_value_123';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetWebhookSecret.mockResolvedValue(SECRET);
  // Default ownership mock: list exists and is owned by u1 (matches the
  // userId stamped on placeholders in the happy-path fixtures).
  (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'u1' });
});

describe('POST /api/crm/webhooks/apollo — auth', () => {
  it('returns 404 when no path secret is supplied (route does not match)', async () => {
    const res = await request(app).post('/api/crm/webhooks/apollo').send({ request_id: 'r1' });
    expect(res.status).toBe(404);
    expect(mockCrmDb.getEnrichmentCacheItem).not.toHaveBeenCalled();
  });

  it('rejects with 401 when path secret is wrong (different length)', async () => {
    const res = await request(app)
      .post('/api/crm/webhooks/apollo/short')
      .send({ request_id: 'r1' });
    expect(res.status).toBe(401);
    expect(mockCrmDb.getEnrichmentCacheItem).not.toHaveBeenCalled();
  });

  it('rejects with 401 when path secret is wrong (same length)', async () => {
    const wrong = 'X'.repeat(SECRET.length);
    const res = await request(app)
      .post(`/api/crm/webhooks/apollo/${wrong}`)
      .send({ request_id: 'r1' });
    expect(res.status).toBe(401);
  });

  it('rejects with 503 when the secret cannot be loaded', async () => {
    mockGetWebhookSecret.mockRejectedValue(new Error('SM down'));
    const res = await request(app)
      .post(`/api/crm/webhooks/apollo/${SECRET}`)
      .send({ request_id: 'r1' });
    expect(res.status).toBe(503);
  });

  it('ignores the legacy X-Apollo-Webhook-Secret header (path is the source of truth)', async () => {
    // Header form is dead — Apollo never echoed it back. Sending it with no
    // path secret must not authenticate the request.
    const res = await request(app)
      .post('/api/crm/webhooks/apollo')
      .set('X-Apollo-Webhook-Secret', SECRET)
      .send({ request_id: 'r1' });
    expect(res.status).toBe(404);
  });

  it('does NOT accept the secret via a ?secret= query param', async () => {
    const res = await request(app)
      .post(`/api/crm/webhooks/apollo?secret=${encodeURIComponent(SECRET)}`)
      .send({ request_id: 'r1' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/crm/webhooks/apollo — payload handling', () => {
  function send(body: any) {
    return request(app)
      .post(`/api/crm/webhooks/apollo/${SECRET}`)
      .send(body);
  }

  it('rejects with 400 when request_id is missing', async () => {
    const res = await send({ person: { email: 'a@b.com' } });
    expect(res.status).toBe(400);
  });

  it('returns 202 matched:false when no placeholder cache row exists', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue(null);
    const res = await send({ request_id: 'unknown-id', person: { email: 'a@b.com' } });
    expect(res.status).toBe(202);
    expect(res.body.matched).toBe(false);
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('returns 202 leadDeleted:true when the lead has since been removed', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
    } as any);
    mockCrmDb.getLeadById.mockResolvedValue(null);
    const res = await send({ request_id: 'r1', person: { email: 'a@b.com' } });
    expect(res.status).toBe(202);
    expect(res.body.leadDeleted).toBe(true);
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('is idempotent: returns alreadyProcessed when apolloRequestId matches', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
    } as any);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'LD1', email: 'old@b.com',
      enrichmentMetadata: { email: { apolloRequestId: 'r1' } },
    } as any);

    const res = await send({ request_id: 'r1', person: { email: 'new@b.com' } });
    expect(res.status).toBe(200);
    expect(res.body.alreadyProcessed).toBe(true);
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('treats a padded request_id as the same id: same placeholder lookup, trimmed stored id, idempotent replay', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
    } as any);
    mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'LD1', email: '', enrichmentMetadata: {} } as any);
    (mockCrmDb as any).setLeadEmailIfMissing.mockResolvedValue({ written: true });

    await send({ request_id: 'r1', person: { email: 'apollo@b.com', email_status: 'verified' } });
    const plainLookup = mockCrmDb.getEnrichmentCacheItem.mock.calls[0];
    mockCrmDb.getEnrichmentCacheItem.mockClear();
    (mockCrmDb as any).setLeadEmailIfMissing.mockClear();
    await send({ request_id: ' r1\n ', person: { email: 'apollo@b.com', email_status: 'verified' } });
    expect(mockCrmDb.getEnrichmentCacheItem.mock.calls[0]).toEqual(plainLookup);
    expect((mockCrmDb as any).setLeadEmailIfMissing.mock.calls[0][3].apolloRequestId).toBe('r1');

    // A replay of the same id with padding must hit the idempotency early-out, not rewrite.
    (mockCrmDb as any).setLeadEmailIfMissing.mockClear();
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'LD1', email: 'apollo@b.com', enrichmentMetadata: { email: { apolloRequestId: 'r1' } },
    } as any);
    const replay = await send({ request_id: '  r1  ', person: { email: 'other@b.com' } });
    expect(replay.body.alreadyProcessed).toBe(true);
    expect((mockCrmDb as any).setLeadEmailIfMissing).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only request_id with 400', async () => {
    const res = await send({ request_id: '   ', person: { email: 'a@b.com' } });
    expect(res.status).toBe(400);
  });

  it('skips when lead already has a different email', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
    } as any);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'LD1', email: 'existing@b.com',
    } as any);

    const res = await send({ request_id: 'r1', person: { email: 'apollo@b.com', email_status: 'verified' } });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toMatch(/already has email/);
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('writes the email via the conditional setLeadEmailIfMissing path', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
    } as any);
    (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'u1' });
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'LD1', email: '', enrichmentMetadata: {},
    } as any);
    (mockCrmDb as any).setLeadEmailIfMissing.mockResolvedValue({ written: true });

    const res = await send({ request_id: 'r1', person: { email: 'apollo@b.com', email_status: 'verified' } });
    expect(res.status).toBe(200);
    expect(res.body.written).toBe(true);
    // Must NOT call the unconditional updateLead path.
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
    expect((mockCrmDb as any).setLeadEmailIfMissing).toHaveBeenCalledTimes(1);
    const [listId, leadId, email, meta] = (mockCrmDb as any).setLeadEmailIfMissing.mock.calls[0];
    expect(listId).toBe('L1');
    expect(leadId).toBe('LD1');
    expect(email).toBe('apollo@b.com');
    expect(meta.confidence).toBe('high');
    expect(meta.apolloRequestId).toBe('r1');
  });

  // ENG-2801: the matched path is now reachable in production, so what a callback may put on a customer lead is gated.
  describe('callback email validation', () => {
    function placeholderAndLead() {
      mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
        cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
      } as any);
      mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'LD1', email: '', enrichmentMetadata: {} } as any);
      (mockCrmDb as any).setLeadEmailIfMissing.mockResolvedValue({ written: true });
    }
    const wf = (...emails: any[]) => ({ request_id: 'r1', people: [{ waterfall: { emails: [{ vendors: [{ name: 'p', status: 'VERIFIED', emails }] }] } }] });
    const stamped = () => (mockCrmDb.putEnrichmentCacheItem as jest.Mock).mock.calls.map((c) => c[0].rawData?.status);

    const REJECTED: Array<[string, any]> = [
      ['not an address', 'not-an-email'],
      ['no TLD', 'a@b'],
      ['whitespace', 'a b@c.com'],
      ['CRLF header injection', 'a@b.com\r\nBcc: victim@y.com'],
      ['markup', '<script>alert(1)@x.com'],
      ['two addresses', 'a@b.com,c@d.com'],
      ['quoted display name', '"Bob" <bob@x.com>'],
      ['300 characters', 'x'.repeat(300) + '@a.com'],
      ['object', { email: 'a@b.com' }],
      ['nested array that would stringify to a valid address', ['a@b.com']],
      ['259 characters (fits the shape, exceeds 254)', 'a'.repeat(64) + '@' + 'b'.repeat(190) + '.com'],
      ['null', null],
      ['number', 12345],
      ['empty', ''],
      // ENG-2803: the shared strict validator (utils/sendEligibility) plus the callback-only rules.
      ['doubled dot', 'a..b@x.com'],
      ['leading dot', '.a@x.com'],
      ['trailing dot in the local part', 'a.@x.com'],
      ['domain label starting with a hyphen', 'a@x.-y.com'],
      ['one-letter TLD', 'a@b.c'],
      ['numeric TLD', 'a@b.123'],
      ['CSV formula lead =', '=cmd@x.com'],
      ['CSV formula lead +', '+tag@x.com'],
      ['CSV formula lead -', '-x@x.com'],
    ];
    it.each(REJECTED)('does not write a %s and treats the callback as no_email', async (_label, bad) => {
      placeholderAndLead();
      const res = await send(wf(bad));
      expect(res.status).toBe(200);
      expect(res.body.hadEmail).toBe(false);
      expect((mockCrmDb as any).setLeadEmailIfMissing).not.toHaveBeenCalled();
      expect(stamped()).toEqual(['no_email']); // the placeholder is never stamped completed with a junk value
    });

    it('falls through to the next group when the first holds nothing usable', async () => {
      placeholderAndLead();
      const body = { request_id: 'r1', people: [{ waterfall: { emails: [
        { vendors: [{ name: 'a', status: 'VERIFIED', emails: ['garbage'] }] },
        { vendors: [{ name: 'b', status: 'VERIFIED', emails: ['good@acme.com'] }] },
      ] } }] };
      const res = await send(body);
      expect(res.status).toBe(200);
      expect((mockCrmDb as any).setLeadEmailIfMissing.mock.calls[0][2]).toBe('good@acme.com');
    });

    it('takes the first usable address inside one vendor entry', async () => {
      placeholderAndLead();
      await send(wf('junk', 'second@acme.com'));
      expect((mockCrmDb as any).setLeadEmailIfMissing.mock.calls[0][2]).toBe('second@acme.com');
    });

    it('a non-string flat email or status no longer 500s (flat shape)', async () => {
      placeholderAndLead();
      const a = await send({ request_id: 'r1', person: { email: { x: 1 } } });
      expect(a.status).toBe(200);
      expect(a.body.hadEmail).toBe(false);
      placeholderAndLead();
      const b = await send({ request_id: 'r2', person: { email: 'ok@acme.com', email_status: 5 } });
      expect(b.status).toBe(200);
      expect((mockCrmDb as any).setLeadEmailIfMissing.mock.calls.pop()[2]).toBe('ok@acme.com');
    });

    it('caps a forged oversized status so it cannot bloat the lead (a 390 KB status was written verbatim before; this harness body limit is 100 KB)', async () => {
      placeholderAndLead();
      const huge = 'X'.repeat(90_000);
      const res = await send({ request_id: 'r1', people: [{ waterfall: { emails: [{ vendors: [{ name: 'p', status: huge, emails: ['good@acme.com'] }] }] } }] });
      expect(res.status).toBe(200);
      const meta = (mockCrmDb as any).setLeadEmailIfMissing.mock.calls[0][3];
      expect(meta.sourceQuote.length).toBeLessThan(100);
      const stampedRow = (mockCrmDb.putEnrichmentCacheItem as jest.Mock).mock.calls[0][0];
      expect(String(stampedRow.rawData.result.emailStatus ?? '').length).toBeLessThanOrEqual(40);
      // flat shape too
      placeholderAndLead();
      (mockCrmDb.putEnrichmentCacheItem as jest.Mock).mockClear();
      await send({ request_id: 'r2', person: { email: 'ok@acme.com', email_status: 'Y'.repeat(90_000) } });
      const flatRow = (mockCrmDb.putEnrichmentCacheItem as jest.Mock).mock.calls[0][0];
      expect(String(flatRow.rawData.result.emailStatus ?? '').length).toBeLessThanOrEqual(40);
    });

    it('stores only plain status characters and ignores a non-string status', async () => {
      placeholderAndLead();
      await send({ request_id: 'r1', people: [{ waterfall: { emails: [{ vendors: [{ name: 'p', status: { a: 1 }, emails: ['good@acme.com'] }] }] } }] });
      expect((mockCrmDb as any).setLeadEmailIfMissing.mock.calls[0][3].sourceQuote).toBe('Apollo waterfall (unknown)');
      placeholderAndLead();
      (mockCrmDb as any).setLeadEmailIfMissing.mockClear();
      await send({ request_id: 'r2', person: { email: 'ok@acme.com', email_status: '<b>Verified</b>\r\n' } });
      expect((mockCrmDb as any).setLeadEmailIfMissing.mock.calls[0][3].sourceQuote).toBe('Apollo waterfall (bverifiedb)');
    });

    it('a forged non-string verifier status cannot 500 the handler and never counts as validated', async () => {
      const forged = (status: any) => ({ request_id: 'r1', people: [{ waterfall: { emails: [{ vendors: [
        { name: 'f', status: 'GUESSED', emails: ['good@acme.com'] },
        { name: 'v', status, usedForVerification: true },
      ] }] } }] });
      for (const status of [{ toString: 1 }, { a: 1 }, ['validated'], 123, null]) {
        placeholderAndLead();
        (mockCrmDb as any).setLeadEmailIfMissing.mockClear();
        const res = await send(forged(status));
        expect(res.status).toBe(200);
        const meta = (mockCrmDb as any).setLeadEmailIfMissing.mock.calls[0][3];
        expect(meta.sourceQuote).toBe('Apollo waterfall (guessed)'); // not upgraded to verified
      }
      placeholderAndLead();
      (mockCrmDb as any).setLeadEmailIfMissing.mockClear();
      await send(forged('Validated'));
      expect((mockCrmDb as any).setLeadEmailIfMissing.mock.calls[0][3].sourceQuote).toBe('Apollo waterfall (verified)');
    });

    it('logs (without the value) when an email is rejected, and stays quiet when there is simply no email', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        placeholderAndLead();
        await send(wf('secret-garbage-value'));
        const rejectedCalls = warn.mock.calls.filter((c) => String(c[0]).includes('failed validation'));
        expect(rejectedCalls).toHaveLength(1);
        expect(rejectedCalls[0]).toContain('r1');
        expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-garbage-value');
        warn.mockClear();
        placeholderAndLead();
        await send({ request_id: 'r3', people: [{ waterfall: { emails: [{ vendors: [{ name: 'p', status: 'VERIFIED', emails: [] }] }] } }] });
        expect(warn.mock.calls.filter((c) => String(c[0]).includes('failed validation'))).toHaveLength(0);
      } finally { warn.mockRestore(); }
    });

    it('a transient list-read error answers 500 (so Apollo retries) and writes nothing', async () => {
      placeholderAndLead();
      (mockCrmDb as any).getLeadListById = jest.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
      const res = await send(wf('good@acme.com'));
      expect(res.status).toBe(500);
      expect((mockCrmDb as any).setLeadEmailIfMissing).not.toHaveBeenCalled();
      expect(mockCrmDb.putEnrichmentCacheItem).not.toHaveBeenCalled();
    });

    it('cleanCallbackEmail: every excluded character in the local part is rejected on its own', () => {
      const excluded = [' ', '<', '>', '"', '\\', ',', ';', ':', '(', ')', '[', ']', '\u0000', '\n', '\r', '\t', '‮', '​', ' ', 'é'];
      for (const c of excluded) expect(cleanCallbackEmail(`a${c}b@x.com`)).toBeUndefined();
      expect(cleanCallbackEmail("a!#$%&'*+/=?^_`{|}~-b@x.com")).toBe("a!#$%&'*+/=?^_`{|}~-b@x.com");
      expect(cleanCallbackEmail('a@b.c')).toBeUndefined(); // TLD needs 2+ letters (callback-only rule)
      expect(cleanCallbackEmail('a@x.xn--p1ai')).toBe('a@x.xn--p1ai'); // punycode TLD is legal (ENG-2803)
      expect(cleanCallbackEmail('a@b.co')).toBe('a@b.co');
      expect(cleanCallbackEmail('a@.b.com')).toBeUndefined();
      expect(cleanCallbackEmail('a@b-.com')).toBeUndefined();
      expect(cleanCallbackEmail('a@münchen.de')).toBeUndefined(); // IDN must arrive as punycode
      expect(cleanCallbackEmail('a@xn--mnchen-3ya.de')).toBe('a@xn--mnchen-3ya.de');
    });

    it('stops at the first usable address in a group and never reads the rest (ENG-2803)', () => {
      const emails = new Proxy(['junk', 'first@acme.com', 'second@acme.com'], {
        get(target, prop, recv) {
          if (prop === '2') throw new Error('read past the first usable address');
          return Reflect.get(target, prop, recv);
        },
      });
      const out = extractApolloEmail({ request_id: 'r1', people: [{ waterfall: { emails: [{ vendors: [{ name: 'p', status: 'verified', emails }] }] } }] });
      expect(out.email).toBe('first@acme.com');
    });

    // Typed handle on the mocked late write (ENG-2803 tests).
    const lateWrite = () => (mockCrmDb as unknown as { setLeadEmailIfMissing: jest.Mock }).setLeadEmailIfMissing;

    it('skips junk before the first usable address and writes that one', async () => {
      placeholderAndLead();
      const res = await send(wf('not-an-email', '=cmd@x.com', 'real@acme.com', 'later@acme.com'));
      expect(res.status).toBe(200);
      expect(lateWrite()).toHaveBeenCalledWith('L1', 'LD1', 'real@acme.com', expect.any(Object));
    });

    it('refuses a callback whose placeholder has expired, and writes nothing (ENG-2803)', async () => {
      placeholderAndLead();
      mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
        cacheType: 'apollo', expiresAt: Math.floor(Date.now() / 1000) - 60, rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
      } as unknown as Awaited<ReturnType<typeof mockCrmDb.getEnrichmentCacheItem>>);
      const res = await send(wf('good@acme.com'));
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ matched: false, expired: true });
      expect(lateWrite()).not.toHaveBeenCalled();
      expect(mockCrmDb.putEnrichmentCacheItem).not.toHaveBeenCalled();
    });

    it('accepts a callback whose placeholder has not expired yet', async () => {
      placeholderAndLead();
      mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
        cacheType: 'apollo', expiresAt: Math.floor(Date.now() / 1000) + 3600, rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
      } as unknown as Awaited<ReturnType<typeof mockCrmDb.getEnrichmentCacheItem>>);
      const res = await send(wf('good@acme.com'));
      expect(res.status).toBe(200);
      expect(lateWrite()).toHaveBeenCalledWith('L1', 'LD1', 'good@acme.com', expect.any(Object));
    });

    it('cleanCallbackEmail keeps ordinary and unusual-but-legal addresses', () => {
      for (const ok of ['avery@example.com', 'first.last+tag@sub.example.co.uk', "o'brien@company.com", '  padded@x.com  ']) {
        expect(cleanCallbackEmail(ok)).toBe(ok.trim());
      }
      // Normalized the way the lead write stores it (ENG-2803).
      expect(cleanCallbackEmail('A@B.IO')).toBe('a@b.io');
      expect(cleanCallbackEmail(' Mixed.Case@Example.COM ')).toBe('mixed.case@example.com');
      expect(cleanCallbackEmail(undefined)).toBeUndefined();
      expect(cleanCallbackEmail('a'.repeat(64) + '@x.com')).toBe('a'.repeat(64) + '@x.com');
      expect(cleanCallbackEmail('a'.repeat(65) + '@x.com')).toBeUndefined();
    });
  });

  it('reports written:false when the conditional update silently lost the race', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
    } as any);
    (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'u1' });
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'LD1', email: '', enrichmentMetadata: {},
    } as any);
    // Simulate Tier 1/2/4 filling the email between our read and DDB conditional.
    (mockCrmDb as any).setLeadEmailIfMissing.mockResolvedValue({ written: false });

    const res = await send({ request_id: 'r1', person: { email: 'apollo@b.com' } });
    expect(res.status).toBe(200);
    expect(res.body.written).toBe(false);
    // Still 200 — the lead has an email, the request was attributed, the
    // result just didn't apply (which is fine).
  });

  // The shape Apollo actually sends for run_waterfall_email — captured live
  // 2026-05-08. The flat `person.email` shape we previously read never appears
  // here in async mode, so the route used to silently lose every Tier 3 hit.
  describe('async waterfall payload shape', () => {
    function emptyLeadFixtures() {
      mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
        cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
      } as any);
      (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'u1' });
      mockCrmDb.getLeadById.mockResolvedValue({
        leadId: 'LD1', email: '', enrichmentMetadata: {},
      } as any);
      (mockCrmDb as any).setLeadEmailIfMissing.mockResolvedValue({ written: true });
    }

    it('extracts email + verified status from people[].waterfall.emails[].vendors[]', async () => {
      emptyLeadFixtures();
      const res = await send({
        request_id: 'r1',
        people: [{
          id: 'p1',
          waterfall: {
            emails: [{
              vendors: [
                { name: 'FindyMail', status: 'SKIPPED', emails: [], usedForVerification: false },
                { name: 'Apollo', status: 'VERIFIED', emails: ['ruiw@agentweb.pro'], usedForVerification: false },
                { name: 'ZeroBounce', status: 'validated', usedForVerification: true },
              ],
            }],
          },
        }],
      });
      expect(res.status).toBe(200);
      expect(res.body.written).toBe(true);
      const [, , email, meta] = (mockCrmDb as any).setLeadEmailIfMissing.mock.calls[0];
      expect(email).toBe('ruiw@agentweb.pro');
      expect(meta.confidence).toBe('high');
    });

    it('upgrades to verified/high when a verifier reports validated even if finder is GUESSED', async () => {
      emptyLeadFixtures();
      const res = await send({
        request_id: 'r1',
        people: [{
          waterfall: {
            emails: [{
              vendors: [
                { name: 'FindyMail', status: 'GUESSED', emails: ['guess@b.com'], usedForVerification: false },
                { name: 'ZeroBounce', status: 'validated', usedForVerification: true },
              ],
            }],
          },
        }],
      });
      expect(res.status).toBe(200);
      const [, , email, meta] = (mockCrmDb as any).setLeadEmailIfMissing.mock.calls[0];
      expect(email).toBe('guess@b.com');
      expect(meta.confidence).toBe('high');
    });

    it('returns hadEmail:false when every finder vendor SKIPPED with empty emails[]', async () => {
      emptyLeadFixtures();
      const res = await send({
        request_id: 'r1',
        people: [{
          waterfall: {
            emails: [{
              vendors: [
                { name: 'FindyMail', status: 'SKIPPED', emails: [] },
                { name: 'Apollo', status: 'SKIPPED', emails: [] },
              ],
            }],
          },
        }],
      });
      expect(res.status).toBe(200);
      expect(res.body.hadEmail).toBe(false);
      expect((mockCrmDb as any).setLeadEmailIfMissing).not.toHaveBeenCalled();
    });

    it('passes force:true on the placeholder put — without it ConditionExpression silently no-ops the update', async () => {
      // Regression: putEnrichmentCacheItem defaults to ConditionExpression
      // "attribute_not_exists(canonicalId) OR expiresAt < :now". Since the
      // placeholder was written by Tier 3 and is fresh (TTL 7d), the put
      // would silently fail with ConditionalCheckFailedException unless
      // force:true is passed. This test pins that contract.
      const placeholderRow = {
        canonicalId: 'cid', fieldGroup: 'sk',
        cacheType: 'apollo' as const,
        rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1', status: 'pending' },
      };
      mockCrmDb.getEnrichmentCacheItem.mockResolvedValue(placeholderRow as any);
      (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'u1' });
      mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'LD1', email: '', enrichmentMetadata: {} } as any);
      (mockCrmDb as any).setLeadEmailIfMissing.mockResolvedValue({ written: true });
      (mockCrmDb as any).putEnrichmentCacheItem.mockResolvedValue(undefined);

      await send({
        request_id: 'r1',
        people: [{ waterfall: { emails: [{ vendors: [
          { name: 'Apollo', status: 'VERIFIED', emails: ['ok@x.com'] },
        ] }] } }],
      });
      const callArgs = (mockCrmDb as any).putEnrichmentCacheItem.mock.calls[0];
      expect(callArgs[1]).toEqual(expect.objectContaining({ force: true }));
    });

    it('stamps rawData.result onto the placeholder so the waterfall poller sees the email', async () => {
      const placeholderRow = {
        canonicalId: 'cid', fieldGroup: 'sk',
        cacheType: 'apollo' as const,
        rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1', status: 'pending' },
      };
      mockCrmDb.getEnrichmentCacheItem.mockResolvedValue(placeholderRow as any);
      (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'u1' });
      mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'LD1', email: '', enrichmentMetadata: {} } as any);
      (mockCrmDb as any).setLeadEmailIfMissing.mockResolvedValue({ written: true });
      (mockCrmDb as any).putEnrichmentCacheItem.mockResolvedValue(undefined);

      const res = await send({
        request_id: 'r1',
        people: [{
          waterfall: { emails: [{ vendors: [
            { name: 'Apollo', status: 'VERIFIED', emails: ['polled@x.com'] },
            { name: 'ZeroBounce', status: 'validated', usedForVerification: true },
          ] }] },
        }],
      });
      expect(res.status).toBe(200);
      expect((mockCrmDb as any).putEnrichmentCacheItem).toHaveBeenCalled();
      const written = (mockCrmDb as any).putEnrichmentCacheItem.mock.calls[0][0];
      expect(written.rawData.status).toBe('completed');
      expect(written.rawData.result.email).toBe('polled@x.com');
      expect(written.rawData.result.emailStatus).toBe('verified');
      // Original placeholder fields preserved (listId/leadId/userId untouched).
      expect(written.rawData.listId).toBe('L1');
      expect(written.rawData.leadId).toBe('LD1');
      expect(written.rawData.userId).toBe('u1');
    });

    it('stamps no_email status when payload yields no email (broker chain dry)', async () => {
      const placeholderRow = {
        canonicalId: 'cid', fieldGroup: 'sk',
        cacheType: 'apollo' as const,
        rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1', status: 'pending' },
      };
      mockCrmDb.getEnrichmentCacheItem.mockResolvedValue(placeholderRow as any);
      (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'u1' });
      mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'LD1', email: '', enrichmentMetadata: {} } as any);
      (mockCrmDb as any).putEnrichmentCacheItem.mockResolvedValue(undefined);

      const res = await send({
        request_id: 'r1',
        people: [{ waterfall: { emails: [{ vendors: [
          { name: 'Apollo', status: 'SKIPPED', emails: [] },
        ] }] } }],
      });
      expect(res.status).toBe(200);
      expect(res.body.hadEmail).toBe(false);
      expect((mockCrmDb as any).putEnrichmentCacheItem).toHaveBeenCalled();
      const written = (mockCrmDb as any).putEnrichmentCacheItem.mock.calls[0][0];
      expect(written.rawData.status).toBe('no_email');
      expect(written.rawData.result.status).toBe('no_email');
    });

    it('picks the first finder vendor with a non-empty emails[] (preserves chain order)', async () => {
      emptyLeadFixtures();
      const res = await send({
        request_id: 'r1',
        people: [{
          waterfall: {
            emails: [{
              vendors: [
                { name: 'Apollo', status: 'VERIFIED', emails: ['first@b.com'] },
                { name: 'Hunter', status: 'VERIFIED', emails: ['second@b.com'] },
              ],
            }],
          },
        }],
      });
      const [, , email] = (mockCrmDb as any).setLeadEmailIfMissing.mock.calls[0];
      expect(email).toBe('first@b.com');
    });
  });
});

describe('POST /api/crm/webhooks/apollo — ownership reverification (C1)', () => {
  function send(body: any) {
    return request(app)
      .post(`/api/crm/webhooks/apollo/${SECRET}`)
      .send(body);
  }

  // All cases below use a real lead that WOULD be writable if ownership
  // wasn't enforced. The assertion that updateLead was NOT called is what
  // proves the ownership gate caught the request.
  beforeEach(() => {
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'LD1', email: '', enrichmentMetadata: {},
    } as any);
  });

  it('rejects when placeholder has no userId stamp (legacy/forged)', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1' /* no userId */ },
    } as any);
    const res = await send({ request_id: 'r1', person: { email: 'apollo@b.com' } });
    expect(res.body.matched).toBe(false);
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('rejects when list owner no longer matches placeholder userId', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
    } as any);
    (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue({ listId: 'L1', userId: 'someone-else' });

    const res = await send({ request_id: 'r1', person: { email: 'apollo@b.com' } });
    expect(res.body.matched).toBe(false);
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it('rejects when the list itself has been deleted', async () => {
    mockCrmDb.getEnrichmentCacheItem.mockResolvedValue({
      cacheType: 'apollo', rawData: { listId: 'L1', leadId: 'LD1', userId: 'u1' },
    } as any);
    (mockCrmDb as any).getLeadListById = jest.fn().mockResolvedValue(null);

    const res = await send({ request_id: 'r1', person: { email: 'apollo@b.com' } });
    expect(res.body.matched).toBe(false);
    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });
});
