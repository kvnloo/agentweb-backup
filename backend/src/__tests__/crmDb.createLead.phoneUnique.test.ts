/**
 * ENG-2123: exactly-once create for EMAIL-LESS form captures, keyed on the normalised phone, plus the
 * sparse `phoneKey` attribute and the PhoneKeyIndex lookup. The fake enforces DynamoDB semantics where
 * they matter (conditional put, all-or-nothing transactWrite with ConditionCheck, strongly consistent
 * get) with NO in-process mutex, so concurrent creates can only be separated by the conditions under test.
 */
jest.mock('../services/orgLeadNotificationService', () => ({ dispatchLeadCreated: jest.fn(), dispatchLeadsCreated: jest.fn() }));

const rows = new Map<string, any>();
const queries: any[] = [];
let queryImpl: (p: any) => any = () => ({ Items: [] });
let omitConditionChecks = false;
const tick = () => new Promise<void>((r) => setImmediate(r));
const k = (listId: string, leadId: string) => `${listId}|${leadId}`;
const canceled = (reasons: string[]): any => Object.assign(new Error('Transaction cancelled'), {
  code: 'TransactionCanceledException', CancellationReasons: reasons.map((Code) => ({ Code })),
});
const condFail = (): any => Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn((p: any) => ({ promise: async () => { await tick(); queries.push(p); return queryImpl(p); } })),
      get: jest.fn((p: any) => ({
        promise: async () => {
          await tick();
          if (!String(p.TableName).endsWith('AW-Leads')) return { Item: { listId: p.Key.listId, userId: 'owner-1' } };
          return { Item: rows.get(k(p.Key.listId, p.Key.leadId)) };
        },
      })),
      put: jest.fn((p: any) => ({
        promise: async () => {
          await tick();
          if (p.ConditionExpression && rows.has(k(p.Item.listId, p.Item.leadId))) throw condFail();
          rows.set(k(p.Item.listId, p.Item.leadId), p.Item);
          return {};
        },
      })),
      transactWrite: jest.fn((p: any) => ({
        promise: async () => {
          await tick();
          const items = omitConditionChecks ? p.TransactItems.filter((t: any) => t.Put) : p.TransactItems;
          const reasons = items.map((t: any) => {
            const kk = t.Put ? k(t.Put.Item.listId, t.Put.Item.leadId) : k(t.ConditionCheck.Key.listId, t.ConditionCheck.Key.leadId);
            return rows.has(kk) && (t.ConditionCheck || t.Put.ConditionExpression) ? 'ConditionalCheckFailed' : 'None';
          });
          if (reasons.some((r: string) => r !== 'None')) throw canceled(reasons);
          for (const t of items) if (t.Put) rows.set(k(t.Put.Item.listId, t.Put.Item.leadId), t.Put.Item);
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
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % W);
const clockAt = (ms: number) => { emailLeadClock.now = () => ms; };
const PHONE = '(212) 456-7890';
const KEY = '2124567890';
const make = (extra: any = {}, origin: any = 'form_fill', listId = 'L1') =>
  crmDb.createLead(listId, { firstName: 'Ana', phone: PHONE, customFields: {}, phoneUniqueCreate: true, ...extra }, origin);
const outcome = async (p: Promise<any>) => p.then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e }));

beforeEach(() => {
  rows.clear(); queries.length = 0; queryImpl = () => ({ Items: [] }); omitConditionChecks = false;
  emailTxBreaker.openUntil = 0;
  clockAt(T0 + 100);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { jest.restoreAllMocks(); emailLeadClock.now = () => Date.now(); });

describe('phoneUniqueCreate', () => {
  it('writes a bucketed, time-prefixed id (keeps newest-first list order) and the sparse phoneKey', async () => {
    const lead = await make();
    expect(lead.leadId).toMatch(new RegExp(`^lead_${T0}_[0-9a-f]{12}$`));
    expect(lead.phoneKey).toBe(KEY);
    expect(rows.get(k('L1', lead.leadId)).phoneKey).toBe(KEY);
  });

  it('EIGHT concurrent same-number creates in one bucket produce ONE row; the losers carry the winner', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => outcome(make())));
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r): r is { ok: false; e: any } => !r.ok);
    expect(winners).toHaveLength(1);
    expect(rows.size).toBe(1);
    expect(losers).toHaveLength(7);
    for (const l of losers) {
      expect(l.e.duplicatePhone).toBe(true);
      expect(l.e.duplicateEmail).toBeUndefined();
      expect(l.e.existingLead.phoneKey).toBe(KEY);
    }
  });

  it('CONTROL: the same eight WITHOUT phoneUniqueCreate write eight rows (so the test above can fail)', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => outcome(make({ phoneUniqueCreate: false }))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(rows.size).toBe(8);
  });

  it('CONTROL: with the adjacent-bucket ConditionChecks removed, racers on either side of a boundary both write', async () => {
    omitConditionChecks = true;
    clockAt(T0 + W - 1);
    const a = await make();
    clockAt(T0 + W + 1);
    const b = await make();
    expect(a.leadId).not.toBe(b.leadId);
    expect(rows.size).toBe(2);
  });

  it('racers on either side of a bucket boundary are serialised by the adjacent-bucket check', async () => {
    clockAt(T0 + W - 1);
    await make();
    clockAt(T0 + W + 1);
    const second = await outcome(make());
    expect(second.ok).toBe(false);
    expect((second as any).e.duplicatePhone).toBe(true);
    expect(rows.size).toBe(1);
  });

  it('two buckets apart is a repeat visit for the index lookup, not for this create', async () => {
    clockAt(T0 + 100);
    await make();
    clockAt(T0 + 2 * W + 100);
    await make();
    expect(rows.size).toBe(2);
  });

  it('is per list: the same number in two lists is two rows', async () => {
    await make({}, 'form_fill', 'L1');
    await make({}, 'form_fill', 'L2');
    expect(rows.size).toBe(2);
  });

  it('different numbers in one bucket do not collide', async () => {
    await make();
    await make({ phone: '(212) 456-7891' });
    expect(rows.size).toBe(2);
  });

  it('does not share a key space with email ids', async () => {
    const lead = await make();
    const email = await crmDb.createLead('L1', { email: 'a@b.com', firstName: 'A', customFields: {}, emailUniqueCreate: true }, 'form_fill');
    expect(lead.leadId).not.toBe(email.leadId);
    expect(rows.size).toBe(2);
  });
});

describe('id namespace: a hostile "email" can never equal a phone id', () => {
  it('an email of literally phone:<digits> in the same bucket does not collide with the phone lead', async () => {
    const phone = await make();
    const hostile = await crmDb.createLead('L1', { email: 'phone:2124567890', firstName: 'X', customFields: {}, emailUniqueCreate: true }, 'form_fill');
    expect(hostile.leadId).not.toBe(phone.leadId);
    expect(rows.size).toBe(2);
  });
});

describe('where the exactly-once create and the phoneKey do NOT apply', () => {
  it.each([
    ['an email is present', { email: 'a@b.com' }, 'form_fill'],
    ['the origin is not a form capture', {}, 'manual'],
    ['no origin is given', {}, null],
    ['the number is junk (sequential)', { phone: '1234567890' }, 'form_fill'],
    ['the number is junk (one repeated digit)', { phone: '555-555-5555' }, 'form_fill'],
    ['the number is too short', { phone: '415-0142' }, 'form_fill'],
    ['a NANP exchange starts with 1', { phone: '212 156 7890' }, 'form_fill'],
    ['the number is a synthetic smoke-test number (it has its own deterministic-id path)', { phone: '(415) 555-0142' }, 'form_fill'],
    ['a linkedin url is present', { linkedin: 'https://www.linkedin.com/in/ana' }, 'form_fill'],
    ['sync metadata is present', { syncMetadata: { hubspot_contact_id: '9' } }, 'form_fill'],
  ])('%s: random id, no phoneKey', async (_n, extra, origin) => {
    const lead = await make(extra as any, origin as any);
    expect(lead.leadId).toMatch(/^lead_\d+_[a-z0-9]{9}$/);
    expect(lead).not.toHaveProperty('phoneKey');
  });

  it('a caller-supplied leadId wins and no phone bucket is used', async () => {
    const lead = await make({ leadId: 'lead_fixed', failIfExists: true });
    expect(lead.leadId).toBe('lead_fixed');
  });

  it('phoneKey is written (even without phoneUniqueCreate) for a form capture, so the key exists before the index', async () => {
    const lead = await make({ phoneUniqueCreate: false });
    expect(lead.phoneKey).toBe(KEY);
    expect(lead.leadId).toMatch(/^lead_\d+_[a-z0-9]{9}$/);
  });

  it('never writes an empty phoneKey (DynamoDB rejects an empty index key)', async () => {
    const lead = await make({ phone: '' });
    expect('phoneKey' in lead).toBe(false);
  });
});

describe('the EMAIL exactly-once path is unchanged by the shared core (ENG-2321 regression guard)', () => {
  it('a same-email loser still throws duplicateEmail with the original message and the winner', async () => {
    const mk = () => crmDb.createLead('L1', { email: 'Ana@Example.com', firstName: 'A', customFields: {}, emailUniqueCreate: true }, 'form_fill');
    const first = await mk();
    const second = await outcome(mk());
    expect(second.ok).toBe(false);
    const err = (second as any).e;
    expect(err.duplicateEmail).toBe(true);
    expect(err.duplicatePhone).toBeUndefined();
    expect(err.message).toBe('Lead with email "ana@example.com" already exists in this list'); // createLead lowercases the stored address
    expect(err.existingLead.leadId).toBe(first.leadId);
  });
});

describe('getLeadIdsByPhoneKey', () => {
  it('queries PhoneKeyIndex by list and key with a bounded Limit and returns ids', async () => {
    queryImpl = () => ({ Items: [{ leadId: 'a' }, { leadId: 'b' }] });
    const r = await crmDb.getLeadIdsByPhoneKey('L1', KEY);
    expect(r).toEqual({ available: true, leadIds: ['a', 'b'], capped: false });
    expect(queries[0]).toMatchObject({ IndexName: 'PhoneKeyIndex', Limit: 6, ExpressionAttributeValues: { ':l': 'L1', ':k': KEY } });
    expect(queries[0].KeyConditionExpression).toBe('listId = :l AND phoneKey = :k');
  });

  it('more rows than the fan-out cap are reported as capped', async () => {
    queryImpl = () => ({ Items: Array.from({ length: 6 }, (_, i) => ({ leadId: `l${i}` })) });
    expect((await crmDb.getLeadIdsByPhoneKey('L1', KEY)).capped).toBe(true);
  });
});

// Kept last: the negative cache is module state and deliberately outlives a test.
describe('getLeadIdsByPhoneKey when the index cannot be used', () => {
  it('another error propagates (a bad expression must not silently disable dedupe)', async () => {
    queryImpl = () => { throw Object.assign(new Error('Invalid KeyConditionExpression'), { code: 'ValidationException' }); };
    await expect(crmDb.getLeadIdsByPhoneKey('L1', KEY)).rejects.toThrow(/Invalid KeyConditionExpression/);
  });

  it('a missing index is "unavailable", warned once, and not retried for the next call', async () => {
    queryImpl = () => { throw Object.assign(new Error('The table does not have the specified index: PhoneKeyIndex'), { code: 'ValidationException' }); };
    expect(await crmDb.getLeadIdsByPhoneKey('L1', KEY)).toEqual({ available: false, leadIds: [], capped: false });
    const before = queries.length;
    expect(await crmDb.getLeadIdsByPhoneKey('L1', KEY)).toEqual({ available: false, leadIds: [], capped: false });
    expect(queries.length).toBe(before);
    expect((console.warn as jest.Mock).mock.calls.filter((c) => String(c[0]).includes('PhoneKeyIndex unavailable'))).toHaveLength(1);
  });

  it('an index that is still BUILDING is unavailable too, and the 10-minute negative cache expires', async () => {
    const real = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(real + 11 * 60 * 1000); // past the cache set by the previous test
    queryImpl = () => { throw Object.assign(new Error('Cannot read from backfilling global secondary index: PhoneKeyIndex'), { code: 'ValidationException' }); };
    const before = queries.length;
    expect(await crmDb.getLeadIdsByPhoneKey('L1', KEY)).toEqual({ available: false, leadIds: [], capped: false });
    expect(queries.length).toBe(before + 1); // it really queried (the earlier cache had expired)
    spy.mockRestore();
  });
});
