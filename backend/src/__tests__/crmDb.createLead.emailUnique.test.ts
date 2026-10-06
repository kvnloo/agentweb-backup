/**
 * ENG-2321: exactly-once email-keyed create. The fake below enforces DynamoDB's semantics where they
 * matter (conditional put, all-or-nothing transactWrite with ConditionCheck, strongly consistent
 * get) and keeps the email-index GSI permanently STALE (query -> []), which is the production
 * condition that let N concurrent same-email submissions each write a row.
 */
jest.mock('../services/orgLeadNotificationService', () => ({ dispatchLeadCreated: jest.fn(), dispatchLeadsCreated: jest.fn() }));

const rows = new Map<string, any>();
const ops: string[] = [];
let conflictsToInject = 0;
const txCalls: any[] = [];
let txError: any = null;
let txAlways: any = null;
let putConflicts = 0;
let onPutConflict: (() => void) | null = null;
const tick = () => new Promise<void>((r) => setImmediate(r));
const k = (listId: string, leadId: string) => `${listId}|${leadId}`;
const condFail = (): any => Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
const canceled = (reasons: string[]): any => Object.assign(new Error('Transaction cancelled'), {
  code: 'TransactionCanceledException', CancellationReasons: reasons.map((Code) => ({ Code })),
});

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: async () => { await tick(); return { Items: [] }; } })),
      get: jest.fn((p: any) => ({
        promise: async () => {
          await tick();
          if (!String(p.TableName).endsWith('AW-Leads')) return { Item: { listId: p.Key.listId, userId: 'owner-1' } };
          ops.push(`get${p.ConsistentRead ? '(consistent)' : ''}:${p.Key.leadId}`);
          return { Item: rows.get(k(p.Key.listId, p.Key.leadId)) };
        },
      })),
      put: jest.fn((p: any) => ({
        promise: async () => {
          await tick();
          ops.push(`put:${p.Item.leadId}`);
          if (putConflicts > 0 && p.ConditionExpression) { putConflicts--; onPutConflict?.(); throw Object.assign(new Error('conflict'), { code: 'TransactionConflictException' }); }
          if (p.ConditionExpression && rows.has(k(p.Item.listId, p.Item.leadId))) throw condFail();
          rows.set(k(p.Item.listId, p.Item.leadId), p.Item);
          return {};
        },
      })),
      transactWrite: jest.fn((p: any) => ({
        promise: async () => {
          await tick();
          ops.push('transactWrite');
          txCalls.push(p);
          if (txAlways) throw txAlways;
          if (txError) { const e = txError; txError = null; throw e; }
          if (conflictsToInject > 0) { conflictsToInject--; throw canceled(p.TransactItems.map(() => 'TransactionConflict')); }
          const reasons = p.TransactItems.map((t: any) => {
            const kk = t.Put ? k(t.Put.Item.listId, t.Put.Item.leadId) : k(t.ConditionCheck.Key.listId, t.ConditionCheck.Key.leadId);
            // an unconditioned Put overwrites (DynamoDB semantics); only a stated condition can fail it
            return rows.has(kk) && (t.ConditionCheck || t.Put.ConditionExpression) ? 'ConditionalCheckFailed' : 'None';
          });
          if (reasons.some((r: string) => r !== 'None')) throw canceled(reasons);
          for (const t of p.TransactItems) if (t.Put) rows.set(k(t.Put.Item.listId, t.Put.Item.leadId), t.Put.Item);
          return {};
        },
      })),
      update: jest.fn(() => ({ promise: async () => ({}) })),
      delete: jest.fn(() => ({ promise: async () => ({}) })),
      scan: jest.fn(() => ({ promise: async () => ({ Items: [] }) })),
    })),
  },
  S3: jest.fn(() => ({})),
  SecretsManager: jest.fn(() => ({ getSecretValue: jest.fn() })),
}));

import { crmDb } from '../services/db';
import { emailLeadClock, emailTxBreaker } from '../utils/emailLeadId';

const W = 5000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % W); // a bucket start
const clockAt = (ms: number) => { emailLeadClock.now = () => ms; };
const create = (email: string, extra: any = {}) => crmDb.createLead('L1', { email, firstName: 'A', customFields: {}, emailUniqueCreate: true, ...extra });
const settle = async (ps: Promise<any>[]) => Promise.all(ps.map((p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))));
const leadRows = () => [...rows.values()];

describe('crmDb.createLead — emailUniqueCreate', () => {
  const realNow = emailLeadClock.now;
  beforeEach(() => {
    rows.clear(); ops.length = 0; txCalls.length = 0; txError = null; txAlways = null; putConflicts = 0; onPutConflict = null; emailTxBreaker.openUntil = 0; conflictsToInject = 0;
    delete process.env.LEAD_EMAIL_UNIQUE_CREATE; delete process.env.LEAD_EMAIL_UNIQUE_BUCKET_MS;
    clockAt(T0 + 100);
  });
  afterAll(() => { emailLeadClock.now = realNow; });

  it('REPRODUCTION: with the kill switch OFF, 12 concurrent same-email creates write 12 rows (stale GSI)', async () => {
    process.env.LEAD_EMAIL_UNIQUE_CREATE = 'false';
    await settle(Array.from({ length: 12 }, () => create('Dup@Example.com')));
    expect(leadRows()).toHaveLength(12);
    expect(leadRows().every((r) => /^lead_\d{13}_[a-z0-9]{9}$/.test(r.leadId) || /^lead_\d+_[a-z0-9]+$/.test(r.leadId))).toBe(true);
    expect(ops).not.toContain('transactWrite');
  });

  it('12 concurrent same-email creates in one bucket -> exactly one row; losers get the typed duplicate with the winner row', async () => {
    const res = await settle(Array.from({ length: 12 }, () => create('Dup@Example.com')));
    expect(leadRows()).toHaveLength(1);
    const winners = res.filter((r: any) => r.ok);
    const losers = res.filter((r: any) => !r.ok) as any[];
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(11);
    for (const l of losers) {
      expect(l.e.duplicateEmail).toBe(true);
      expect(l.e.existingLead.leadId).toBe(leadRows()[0].leadId);
    }
  });

  it('id shape: lead_<13-digit bucket start>_<12 hex>, email stored lower-cased', async () => {
    await create('  Dup@Example.com ');
    const [row] = leadRows();
    expect(row.leadId).toMatch(/^lead_\d{13}_[0-9a-f]{12}$/);
    expect(row.leadId.split('_')[1]).toBe(String(T0));
    expect(row.email).toBe('dup@example.com');
  });

  it('normalisation: case/whitespace variants of one address collide', async () => {
    const res = await settle(['a@x.com', ' A@X.COM', 'a@x.com  ', 'A@x.Com'].map((e) => create(e)));
    expect(leadRows()).toHaveLength(1);
    expect(res.filter((r: any) => r.ok)).toHaveLength(1);
  });

  it('different emails / different lists in one bucket do not collide', async () => {
    await create('a@x.com'); await create('b@x.com');
    await crmDb.createLead('L2', { email: 'a@x.com', customFields: {}, emailUniqueCreate: true });
    expect(leadRows()).toHaveLength(3);
  });

  it('expression shape: one transaction = Put(attribute_not_exists) + ConditionCheck(prev) + ConditionCheck(next)', async () => {
    await create('a@x.com');
    expect(txCalls).toHaveLength(1);
    const items = txCalls[0].TransactItems;
    expect(items).toHaveLength(3);
    const [put, prev, next] = items;
    expect(put.Put.ConditionExpression).toBe('attribute_not_exists(leadId)');
    expect(put.Put.Item.leadId).toBe(`lead_${T0}_${put.Put.Item.leadId.split('_')[2]}`);
    const h = put.Put.Item.leadId.split('_')[2];
    expect(prev.ConditionCheck).toMatchObject({ Key: { listId: 'L1', leadId: `lead_${T0 - W}_${h}` }, ConditionExpression: 'attribute_not_exists(leadId)' });
    expect(next.ConditionCheck).toMatchObject({ Key: { listId: 'L1', leadId: `lead_${T0 + W}_${h}` }, ConditionExpression: 'attribute_not_exists(leadId)' });
    expect(prev.ConditionCheck.TableName).toBe(put.Put.TableName);
  });

  describe('bucket boundary (injectable clock)', () => {
    it('racers on either side of a boundary (T0+W-1 vs T0+W) still yield ONE row, in either order', async () => {
      for (const order of [[-1, 0], [0, -1]]) {
        rows.clear();
        const a = (() => { clockAt(T0 + W + order[0]); return create('b@x.com'); })();
        const b = (() => { clockAt(T0 + W + order[1]); return create('b@x.com'); })();
        // the id is fixed synchronously at the start of createLead, so each racer used its own clock reading
        await settle([a, b]);
        expect(leadRows()).toHaveLength(1);
      }
    });

    it('the loser of a cross-bucket race adopts the OTHER bucket\'s row', async () => {
      clockAt(T0 + W - 1); await create('b@x.com');
      clockAt(T0 + W);
      await expect(create('b@x.com')).rejects.toMatchObject({ duplicateEmail: true, existingLead: { leadId: expect.stringContaining(`lead_${T0}_`) } });
      expect(leadRows()).toHaveLength(1);
    });

    it('also in the other direction (next bucket already written)', async () => {
      clockAt(T0 + W); await create('b@x.com');
      clockAt(T0 + W - 1);
      await expect(create('b@x.com')).rejects.toMatchObject({ duplicateEmail: true });
      expect(leadRows()).toHaveLength(1);
    });

    it('buckets two apart (>= BUCKET apart) are NOT serialised by the transaction: the email-index pre-check owns that case', async () => {
      clockAt(T0); await create('b@x.com');
      clockAt(T0 + 2 * W); await create('b@x.com');
      expect(leadRows()).toHaveLength(2); // the stale fake GSI cannot catch it; real GSI lag << BUCKET
    });

    it('bucket width is env-tunable and clamped', async () => {
      process.env.LEAD_EMAIL_UNIQUE_BUCKET_MS = '2000';
      clockAt(T0 + 2500); await create('c@x.com');
      expect(leadRows()[0].leadId.split('_')[1]).toBe(String(T0 + 2000));
      rows.clear();
      process.env.LEAD_EMAIL_UNIQUE_BUCKET_MS = '5';
      clockAt(T0 + 100); await create('c@x.com');
      expect(leadRows()[0].leadId.split('_')[1]).toBe(String(T0));
    });
  });

  describe('contention + failure handling', () => {
    it('retries a TransactionConflict and then succeeds', async () => {
      conflictsToInject = 2;
      await create('d@x.com');
      expect(leadRows()).toHaveLength(1);
      expect(ops.filter((o) => o === 'transactWrite')).toHaveLength(3);
    });

    it('after retries are exhausted with nothing visible, degrades to the conditional put on the SAME id (no 500)', async () => {
      conflictsToInject = 99;
      await create('d@x.com');
      expect(leadRows()).toHaveLength(1);
      expect(ops[ops.length - 1]).toMatch(/^put:lead_\d{13}_/);
    });

    it('a non-transaction error (e.g. throttling) is not swallowed', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      txError = Object.assign(new Error('throttled'), { code: 'ProvisionedThroughputExceededException' });
      await expect(create('e@x.com')).rejects.toBeDefined();
      expect(leadRows().filter((r) => r.email === 'e@x.com')).toHaveLength(0);
    });
  });

  describe('ENG-2321 degraded mode: role lacks transaction permissions (AccessDeniedException)', () => {
    const denied = () => Object.assign(new Error('not authorized to perform: dynamodb:ConditionCheckItem'), { code: 'AccessDeniedException' });
    let errSpy: jest.SpyInstance;
    beforeEach(() => { txAlways = denied(); errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined); });
    afterEach(() => errSpy.mockRestore());

    it('still creates the lead exactly once via the conditional put on the SAME bucketed id; no throw; logs the greppable tag', async () => {
      const lead = await create('h@x.com');
      expect(leadRows()).toHaveLength(1);
      expect(lead.leadId).toMatch(/^lead_\d{13}_[0-9a-f]{12}$/);
      expect(ops.filter((o) => o === 'transactWrite')).toHaveLength(1);
      expect(ops[ops.length - 1]).toBe(`put:${lead.leadId}`);
      expect(errSpy.mock.calls.filter((c) => String(c[0]).includes('[ENG-2321] ConditionCheck denied on AW-Leads - degraded to conditional put'))).toHaveLength(1);
    });

    it('circuit breaker: a second create inside the interval does not retry the transaction; after it, it does', async () => {
      await create('h@x.com');
      await create('i@x.com');
      expect(txCalls).toHaveLength(1);
      expect(leadRows()).toHaveLength(2);
      expect(errSpy.mock.calls.filter((c) => String(c[0]).includes('[ENG-2321]'))).toHaveLength(1); // logged once per interval
      clockAt(T0 + 100 + 10 * 60 * 1000 + 1);
      await create('j@x.com');
      expect(txCalls).toHaveLength(2);
      expect(errSpy.mock.calls.filter((c) => String(c[0]).includes('[ENG-2321]'))).toHaveLength(2);
    });

    it('breaker interval is env-tunable', async () => {
      process.env.LEAD_EMAIL_UNIQUE_TX_BACKOFF_MS = '2000';
      await create('h@x.com');
      clockAt(T0 + 100 + 2001);
      await create('i@x.com');
      expect(txCalls).toHaveLength(2);
      delete process.env.LEAD_EMAIL_UNIQUE_TX_BACKOFF_MS;
    });

    it('12 same-bucket racers in degraded mode -> one row; losers adopt through the typed duplicate', async () => {
      const res = await settle(Array.from({ length: 12 }, () => create('Dup@Example.com')));
      expect(leadRows()).toHaveLength(1);
      const losers = res.filter((r: any) => !r.ok) as any[];
      expect(losers).toHaveLength(11);
      for (const l of losers) expect(l.e).toMatchObject({ duplicateEmail: true, existingLead: { leadId: leadRows()[0].leadId } });
    });

    it('pre-probe: a cross-bucket pair in degraded mode adopts the neighbouring bucket\'s row (either direction)', async () => {
      clockAt(T0 + W - 1); await create('k@x.com');
      clockAt(T0 + W);
      await expect(create('k@x.com')).rejects.toMatchObject({ duplicateEmail: true });
      rows.clear(); emailTxBreaker.openUntil = 0;
      clockAt(T0 + W); await create('m@x.com');
      clockAt(T0 + W - 1);
      await expect(create('m@x.com')).rejects.toMatchObject({ duplicateEmail: true });
      expect(leadRows()).toHaveLength(1);
    });

    it('conflict on the fallback put is retried, then the lead is created once (no throw)', async () => {
      putConflicts = 2;
      await create('n@x.com');
      expect(leadRows()).toHaveLength(1);
      expect(ops.filter((o) => o.startsWith('put:'))).toHaveLength(3);
    });

    it('conflict on the fallback put, winner becomes visible -> adopts via duplicateEmail', async () => {
      putConflicts = 1;
      // the winner holds the SAME bucketed id ours targets:
      onPutConflict = () => { const mine = ops[ops.length - 1].slice(4); rows.set(k('L1', mine), { listId: 'L1', leadId: mine, email: 'n@x.com' }); };
      await expect(create('n@x.com')).rejects.toMatchObject({ duplicateEmail: true });
      expect(leadRows()).toHaveLength(1);
    });

    it('retries exhausted with nothing adoptable -> legacy random-id create succeeds, no throw, returned leadId is the written one', async () => {
      putConflicts = 99;
      const lead = await create('o@x.com');
      expect(leadRows()).toHaveLength(1);
      expect(lead.leadId).toBe(leadRows()[0].leadId);
      expect(lead.leadId).toMatch(/^lead_\d+_[a-z0-9]{1,9}$/);
      expect(lead.leadId).not.toMatch(/_[0-9a-f]{12}$/);
    });

    it('only AccessDeniedException degrades: other errors (e.g. ValidationException) still surface', async () => {
      txAlways = Object.assign(new Error('bad'), { code: 'ValidationException' });
      await expect(create('l@x.com')).rejects.toBeDefined();
      expect(leadRows()).toHaveLength(0);
      expect(emailTxBreaker.openUntil).toBe(0);
    });
  });

  describe('opt-in + kill switch leave the legacy path untouched', () => {
    it('no emailUniqueCreate flag -> plain put, random id, no transaction', async () => {
      await crmDb.createLead('L1', { email: 'f@x.com', customFields: {} });
      expect(ops).not.toContain('transactWrite');
      expect(leadRows()[0].leadId).toMatch(/^lead_\d+_[a-z0-9]+$/);
      expect(leadRows()[0].leadId).not.toMatch(/_[0-9a-f]{12}$/);
    });
    it('LEAD_EMAIL_UNIQUE_CREATE=false (also 0/off/no) -> legacy', async () => {
      for (const v of ['false', '0', 'off', 'NO']) {
        rows.clear(); ops.length = 0; process.env.LEAD_EMAIL_UNIQUE_CREATE = v;
        await create('f@x.com');
        expect(ops).not.toContain('transactWrite');
      }
    });
    it('no email, or a caller-supplied leadId -> legacy (phone-only / ENG-2082 / session paths)', async () => {
      await crmDb.createLead('L1', { phone: '2125550147', customFields: {}, emailUniqueCreate: true });
      await crmDb.createLead('L1', { email: 'g@x.com', customFields: {}, leadId: 'lead_1_fixed', failIfExists: true, emailUniqueCreate: true });
      expect(ops).not.toContain('transactWrite');
      expect(rows.has(k('L1', 'lead_1_fixed'))).toBe(true);
    });
  });
});
