/** ENG-3132 slice C. Admin-only, injection-safe CSV, payout months net clawbacks, createdBy never from the body. */
import express from 'express';
import request from 'supertest';
import { isAdmin } from '../middleware/admin';
import { createAdminZomaReferralsRouter } from '../routes/adminZomaReferrals';
import { buildAccrualEntry, buildReversalEntry, buildVoidEntry, type ZomaLedgerEntry, type ZomaReferralLedgerStore } from '../services/zomaReferralLedger';
import { csvText, summarizePayouts } from '../services/zomaReferralPayouts';
import type { ZomaReferralCode, ZomaReferralStore } from '../services/zomaReferralRegistry';

class MemoryRegistry implements ZomaReferralStore {
  rows = new Map<string, ZomaReferralCode>();
  async create(r: ZomaReferralCode) {
    if (this.rows.has(r.code)) return false;
    this.rows.set(r.code, r);
    return true;
  }
  async get(code: string) {
    return this.rows.get(code) ?? null;
  }
  async revoke(code: string, nowIso: string) {
    const r = this.rows.get(code);
    if (!r) return false;
    this.rows.set(code, { ...r, status: 'revoked', revokedAt: r.revokedAt ?? nowIso });
    return true;
  }
}

const ledgerOf = (rows: ZomaLedgerEntry[]): ZomaReferralLedgerStore => ({
  append: async () => true,
  listForReferredUser: async () => rows,
  listAll: async () => rows,
});

// Stands in for authenticateToken: identity comes from headers, the real isAdmin decides.
const fakeAuth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
  const id = req.header('x-test-user');
  (req as unknown as { user: unknown }).user = id ? { userId: id, email: `${id}@x.test`, isAdmin: req.header('x-test-admin') === '1' } : null;
  next();
};

function appWith(registry: ZomaReferralStore, ledger: ZomaReferralLedgerStore) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminZomaReferralsRouter({ registry, ledger, auth: [fakeAuth, isAdmin] }));
  return app;
}
const admin = { 'x-test-user': 'admin-1', 'x-test-admin': '1' };
const body = { code: 'sandra', referrerId: 'sandra', payeeName: 'Sandra Example' };

const attribution = { referredUserId: 'u1', referrerId: 'sandra', code: 'sandra', percentBps: 2000, invoiceId: 'in_1', paidAt: '2026-11-20T00:00:00.000Z', now: new Date('2026-11-20T00:00:00Z') };
const accrual = buildAccrualEntry({ ...attribution, baseCents: 5000 }); // +1000 in 2026-11
const clawback = buildReversalEntry({ ...attribution, creditNoteId: 'cn_1', creditedBaseCents: 5000, commissionCentsToReverse: 1000, creditedAt: '2026-12-03T00:00:00.000Z' }); // -1000 in 2026-12

describe('access', () => {
  it('rejects anonymous and non-admin callers on every endpoint', async () => {
    const app = appWith(new MemoryRegistry(), ledgerOf([]));
    for (const [method, url] of [['post', '/api/admin/zoma-referrals/codes'], ['get', '/api/admin/zoma-referrals/codes/sandra'], ['post', '/api/admin/zoma-referrals/codes/sandra/revoke'], ['get', '/api/admin/zoma-referrals/payouts?month=2026-11']] as const) {
      expect((await request(app)[method](url)).status).toBe(401);
      expect((await request(app)[method](url).set({ 'x-test-user': 'u' })).status).toBe(403);
    }
  });
});

describe('codes', () => {
  it('creates with createdBy from the authenticated admin, never the body; a duplicate is 409', async () => {
    const registry = new MemoryRegistry();
    const app = appWith(registry, ledgerOf([]));
    const res = await request(app).post('/api/admin/zoma-referrals/codes').set(admin).send({ ...body, createdBy: 'attacker' });
    expect(res.status).toBe(201);
    expect(registry.rows.get('sandra')).toMatchObject({ createdBy: 'admin-1', status: 'active' });
    expect((await request(app).post('/api/admin/zoma-referrals/codes').set(admin).send(body)).status).toBe(409);
  });

  it('names the invalid field with a 400', async () => {
    const app = appWith(new MemoryRegistry(), ledgerOf([]));
    expect((await request(app).post('/api/admin/zoma-referrals/codes').set(admin).send({ ...body, code: 'linkedin' })).body).toMatchObject({ field: 'code', reason: 'reserved' });
    expect((await request(app).post('/api/admin/zoma-referrals/codes').set(admin).send({ ...body, percentBps: 0 })).body).toMatchObject({ field: 'percentBps' });
  });

  it('reads one, 404s an unknown or malformed code, and revoke is idempotent keeping the first time', async () => {
    const registry = new MemoryRegistry();
    const app = appWith(registry, ledgerOf([]));
    await request(app).post('/api/admin/zoma-referrals/codes').set(admin).send(body);
    expect((await request(app).get('/api/admin/zoma-referrals/codes/sandra').set(admin)).body).toMatchObject({ code: 'sandra' });
    expect((await request(app).get('/api/admin/zoma-referrals/codes/nobody').set(admin)).status).toBe(404);
    expect((await request(app).get('/api/admin/zoma-referrals/codes/Bad%20Code').set(admin)).status).toBe(404);
    const first = await request(app).post('/api/admin/zoma-referrals/codes/sandra/revoke').set(admin);
    const second = await request(app).post('/api/admin/zoma-referrals/codes/sandra/revoke').set(admin);
    expect(first.body).toMatchObject({ status: 'revoked' });
    expect(second.body.revokedAt).toBe(first.body.revokedAt);
    expect((await request(app).post('/api/admin/zoma-referrals/codes/nobody/revoke').set(admin)).status).toBe(404);
  });

  it('answers 503, without the error text, when the store is down', async () => {
    const registry = new MemoryRegistry();
    registry.get = async () => {
      throw new Error('dynamo secret detail');
    };
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await request(appWith(registry, ledgerOf([]))).get('/api/admin/zoma-referrals/codes/sandra').set(admin);
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toContain('secret');
    } finally {
      error.mockRestore();
    }
  });
});

describe('payout roll-up', () => {
  it('groups by each row\'s own month: a December refund is a negative in December, November stays closed', () => {
    expect(summarizePayouts([accrual, clawback], '2026-11')).toEqual([{ referrerId: 'sandra', code: 'sandra', accruedCents: 1000, reversedCents: 0, voidedCents: 0, netCents: 1000, invoiceCount: 1 }]);
    expect(summarizePayouts([accrual, clawback], '2026-12')).toEqual([{ referrerId: 'sandra', code: 'sandra', accruedCents: 0, reversedCents: 1000, voidedCents: 0, netCents: -1000, invoiceCount: 0 }]);
  });

  it('a void adds back in its own month and counts each invoice once', () => {
    const voided = buildVoidEntry(clawback, '2026-12-20T00:00:00.000Z', new Date());
    const second = buildAccrualEntry({ ...attribution, invoiceId: 'in_2', paidAt: '2026-12-05T00:00:00.000Z', baseCents: 5000 });
    expect(summarizePayouts([accrual, clawback, voided, second], '2026-12')[0]).toMatchObject({ accruedCents: 1000, reversedCents: 1000, voidedCents: 1000, netCents: 1000, invoiceCount: 1 });
  });

  it('serves JSON with the payee name, rejects a bad month, and 503s when the ledger is down', async () => {
    const registry = new MemoryRegistry();
    const app = appWith(registry, ledgerOf([accrual]));
    await request(app).post('/api/admin/zoma-referrals/codes').set(admin).send(body);
    const res = await request(app).get('/api/admin/zoma-referrals/payouts?month=2026-11').set(admin);
    expect(res.body).toMatchObject({ month: '2026-11', totalNetCents: 1000, rows: [{ code: 'sandra', payeeName: 'Sandra Example', netCents: 1000 }] });
    for (const month of ['2026-13', '2026-1', 'abc', '']) {
      expect((await request(app).get(`/api/admin/zoma-referrals/payouts?month=${month}`).set(admin)).status).toBe(400);
    }
    expect((await request(app).get('/api/admin/zoma-referrals/payouts').set(admin)).status).toBe(400);
    const down: ZomaReferralLedgerStore = { ...ledgerOf([]), listAll: async () => { throw new Error('boom'); } };
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await request(appWith(registry, down)).get('/api/admin/zoma-referrals/payouts?month=2026-11').set(admin)).status).toBe(503);
    } finally {
      error.mockRestore();
    }
  });
});

describe('CSV', () => {
  it('neutralises spreadsheet formulas in free text and escapes delimiters', () => {
    expect(csvText('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    for (const lead of ['+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvText(lead).replace(/^"/, '').startsWith("'")).toBe(true);
    expect(csvText('Sandra, Inc.')).toBe('"Sandra, Inc."');
    expect(csvText('line1\nline2')).toBe('"line1\nline2"');
    expect(csvText('Sandra Example')).toBe('Sandra Example');
  });

  it('downloads a CSV whose payee cell cannot run as a formula, and keeps a negative net as a plain number', async () => {
    const registry = new MemoryRegistry();
    registry.rows.set('sandra', { code: 'sandra', referrerId: 'sandra', payeeName: '=cmd|\' /C calc\'!A0', status: 'active', createdAt: '2026-11-01T00:00:00Z', createdBy: 'a' });
    const res = await request(appWith(registry, ledgerOf([accrual, clawback]))).get('/api/admin/zoma-referrals/payouts?month=2026-12&format=csv').set(admin);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('zoma-referral-payouts-2026-12.csv');
    const [header, row] = res.text.trim().split('\n');
    expect(header).toBe('month,referrer_id,code,payee_name,accrued_cents,reversed_cents,voided_cents,net_cents,invoices');
    expect(row).toBe('2026-12,sandra,sandra,\'=cmd|\' /C calc\'!A0,0,1000,0,-1000,0');
  });
});
