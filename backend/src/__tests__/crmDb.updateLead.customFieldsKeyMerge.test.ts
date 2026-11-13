/**
 * ENG-2320 — crmDb.updateLead's opt-in `customFieldsKeyMerge` mode: the request SHAPES.
 *
 * A mocked DocumentClient records an expression string and never parses it, which is how
 * `SET domain = :x` shipped broken before. Here the aws-sdk is replaced by helpers/leadTableFake,
 * which EXECUTES every UpdateExpression and throws what DynamoDB throws for the classes that
 * matter: reserved word used bare, undefined / unused `#name` or `:value` placeholder,
 * overlapping document paths, a document-path write under a missing parent. The assertions on
 * top pin the shape (what is written, in how many items, and what is NOT written). The
 * real-service proof for the same expressions is the dynamodb-local run recorded on the PR.
 */

import { LeadTableFake } from './helpers/leadTableFake';

jest.mock('aws-sdk', () => {
  const { LeadTableFake: Fake } = require('./helpers/leadTableFake');
  const fake = new Fake();
  (globalThis as any).__leadTableFake = fake;
  const base: any = {
    config: { update: jest.fn() },
    DynamoDB: { DocumentClient: jest.fn(() => fake.client()) },
    S3: jest.fn(() => ({})),
    SecretsManager: jest.fn(() => ({})),
  };
  const proxy: any = new Proxy(base, { get: (t, p) => (p === 'default' ? proxy : p in t ? t[p] : jest.fn(() => ({}))) });
  return proxy;
});
jest.mock('../services/orgLeadNotificationService', () => ({ dispatchLeadCreated: jest.fn(), dispatchLeadsCreated: jest.fn() }));

import { crmDb } from '../services/db';

const fake: LeadTableFake = (globalThis as any).__leadTableFake;
const L = 'L1';
const row = (extra: any = {}) => ({ listId: L, leadId: 'lead_1', email: 'a@b.com', createdAt: 'x', customFields: { source: 'lp', keep: 'me' }, ...extra });
const leadUpdates = () => fake.updates.filter((u) => u.TableName === 'AW-Leads');
const listUpdates = () => fake.updates.filter((u) => u.TableName === 'AW-LeadLists');

/** Static well-formedness: every placeholder defined and used; no caller key appears bare. */
function assertWellFormed(p: any, callerKeys: string[] = []) {
  const expr = [p.UpdateExpression, p.ConditionExpression].filter(Boolean).join(' ');
  const names = p.ExpressionAttributeNames ?? {};
  const values = p.ExpressionAttributeValues ?? {};
  const usedNames = new Set<string>(expr.match(/#[A-Za-z0-9_]+/g) ?? []);
  const usedValues = new Set<string>(expr.match(/:[A-Za-z0-9_]+/g) ?? []);
  for (const n of usedNames) expect(names).toHaveProperty([n]);
  for (const v of usedValues) expect(values).toHaveProperty([v]);
  for (const n of Object.keys(names)) expect(usedNames.has(n)).toBe(true);
  for (const v of Object.keys(values)) expect(usedValues.has(v)).toBe(true);
  const bare = expr.replace(/[#:][A-Za-z0-9_]+/g, '');
  for (const k of callerKeys) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(bare).not.toMatch(new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`));
  }
}

describe('crmDb.updateLead — customFieldsKeyMerge', () => {
  beforeEach(() => {
    fake.reset();
    fake.seedList({ listId: L, userId: 'u1', name: 'L', fieldNames: ['source'], leadCount: 1 });
    fake.seedLead(row());
  });

  it('rejects stale notes without applying sibling edits, then accepts a fresh merge', async () => {
    fake.seedLead(row({ notes: 'original\n\nconcurrent' }));
    await expect(crmDb.updateLead(L, 'lead_1', {
      expectedNotes: 'original', notes: 'original\n\nvisitor', firstName: 'stale',
    })).rejects.toMatchObject({ code: 'ConditionalCheckFailedException' });
    expect(fake.lead(L, 'lead_1').firstName).toBeUndefined();
    await crmDb.updateLead(L, 'lead_1', {
      expectedNotes: 'original\n\nconcurrent', notes: 'original\n\nconcurrent\n\nvisitor',
    });
    expect(fake.lead(L, 'lead_1').notes).toBe('original\n\nconcurrent\n\nvisitor');
    expect(fake.lead(L, 'lead_1').expectedNotes).toBeUndefined();
    expect(fake.list(L).fieldNames).not.toContain('expectedNotes');
  });

  it.each([undefined, '', null])('accepts a guarded first note when prior notes are %p', async (notes) => {
    fake.seedLead(row(notes === undefined ? {} : { notes }));
    await crmDb.updateLead(L, 'lead_1', { expectedNotes: notes === undefined ? '' : notes, notes: 'first' });
    expect(fake.lead(L, 'lead_1').notes).toBe('first');
    assertWellFormed(leadUpdates()[0]);
  });

  it('writes one document-path SET per key and never the whole map', async () => {
    await crmDb.updateLead(L, 'lead_1', { firstName: 'Ann', customFields: { q1: 'a', q2: 2 }, customFieldsKeyMerge: true });
    const [main] = leadUpdates();
    assertWellFormed(main, ['q1', 'q2', 'customFields']);
    expect(main.UpdateExpression).toMatch(/#cfMap\.#cfk0 = :cfv0/);
    expect(main.UpdateExpression).toMatch(/#cfMap\.#cfk1 = :cfv1/);
    expect(main.UpdateExpression).not.toMatch(/customFields = :customFields/);
    expect(main.ExpressionAttributeNames['#cfMap']).toBe('customFields');
    expect(Object.values(main.ExpressionAttributeValues)).toEqual(expect.arrayContaining(['a', 2]));
    // stored: the keys the caller did NOT carry survive
    expect(fake.lead(L, 'lead_1').customFields).toEqual({ source: 'lp', keep: 'me', q1: 'a', q2: 2 });
  });

  it('without the flag the whole-map SET is byte-identical to before', async () => {
    await crmDb.updateLead(L, 'lead_1', { customFields: { only: 1 } });
    const [main] = leadUpdates();
    expect(main.UpdateExpression).toMatch(/customFields = :customFields/);
    expect(main.ExpressionAttributeValues[':customFields']).toEqual({ only: 1 });
    expect(main.ExpressionAttributeNames?.['#cfMap']).toBeUndefined();
    expect(fake.lead(L, 'lead_1').customFields).toEqual({ only: 1 }); // overwrite semantics kept
    // and the list's fieldNames still go through the whole-array SET
    expect(listUpdates().some((u) => /SET fieldNames = :fieldNames/.test(u.UpdateExpression))).toBe(true);
  });

  it('survives reserved words and punctuation in caller keys (executed by the fake, not just recorded)', async () => {
    const cf: Record<string, any> = {
      domain: 'd', system: 's', name: 'n', status: 'st', source: 'named', type: 't', data: 1, value: 2,
      'a.b': 1, 'with space': 2, 'café': 3, 'k-1': 4, '#h': 5, ':c': 6, '0lead': 7, '💥': 8,
    };
    await crmDb.updateLead(L, 'lead_1', { customFields: cf, customFieldsKeyMerge: true });
    for (const u of leadUpdates()) assertWellFormed(u, Object.keys(cf));
    expect(fake.lead(L, 'lead_1').customFields).toEqual({ keep: 'me', ...cf });
  });

  it('drops a `__proto__` key like the whole-map write did, and stores `constructor` as plain data', async () => {
    const cf = JSON.parse('{"__proto__":{"x":1},"constructor":"c","ok":1}');
    await crmDb.updateLead(L, 'lead_1', { customFields: cf, customFieldsKeyMerge: true });
    const [main] = leadUpdates();
    expect(Object.values(main.ExpressionAttributeNames)).not.toContain('__proto__');
    const stored = fake.lead(L, 'lead_1').customFields;
    expect(Object.prototype.hasOwnProperty.call(stored, '__proto__')).toBe(false);
    expect(stored.constructor).toBe('c');
    expect(stored.ok).toBe(1);
    expect(({} as any).x).toBeUndefined();
  });

  it('drops empty-string keys and undefined values (neither can be a placeholder value)', async () => {
    await crmDb.updateLead(L, 'lead_1', { customFields: { '': 'x', u: undefined, ok: 1 }, customFieldsKeyMerge: true });
    const [main] = leadUpdates();
    expect(Object.values(main.ExpressionAttributeNames)).not.toContain('');
    expect(fake.lead(L, 'lead_1').customFields).toEqual({ source: 'lp', keep: 'me', ok: 1 });
  });

  it('chunks a large patch (50 keys per UpdateItem) instead of exceeding the expression limit', async () => {
    const cf = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`key_${i}`, i]));
    await crmDb.updateLead(L, 'lead_1', { customFields: cf, customFieldsKeyMerge: true });
    const writes = leadUpdates();
    expect(writes).toHaveLength(3);
    expect(writes.map((w) => Object.keys(w.ExpressionAttributeValues).filter((k) => k.startsWith(':cfv')).length)).toEqual([50, 50, 20]);
    for (const w of writes) {
      assertWellFormed(w);
      expect(Buffer.byteLength(w.UpdateExpression)).toBeLessThan(4096);
    }
    expect(Object.keys(fake.lead(L, 'lead_1').customFields)).toHaveLength(122); // 120 + source + keep
  });

  it('creates the customFields map once when the row has none, then retries', async () => {
    fake.seedLead(row({ leadId: 'lead_nomap', email: 'n@b.com', customFields: undefined }));
    await crmDb.updateLead(L, 'lead_nomap', { customFields: { q: 1 }, customFieldsKeyMerge: true });
    const writes = leadUpdates();
    expect(writes).toHaveLength(3); // failed per-key SET, bootstrap, retry
    expect(writes[1].UpdateExpression).toBe('SET #cfMap = if_not_exists(#cfMap, :emptyMap)');
    expect(writes[1].ConditionExpression).toBe('attribute_exists(#lid)');
    assertWellFormed(writes[1]);
    expect(fake.lead(L, 'lead_nomap').customFields).toEqual({ q: 1 });
  });

  it('does not bootstrap (and does not create a ghost row) for a lead that does not exist', async () => {
    await expect(crmDb.updateLead(L, 'lead_missing', { customFields: { q: 1 }, customFieldsKeyMerge: true })).rejects.toBeTruthy();
    expect(fake.lead(L, 'lead_missing')).toBeUndefined();
  });

  it('leaves the other top-level behaviour alone: nameCompanyKey, updatedAt, GSI self-heal ride the same item', async () => {
    fake.seedLead(row({ leadId: 'lead_legacy', email: 'l@b.com', linkedin: '', nameCompanyKey: '' }));
    await crmDb.updateLead(L, 'lead_legacy', { firstName: 'Bob', lastName: 'Lee', company: 'Acme', customFieldsKeyMerge: true, customFields: { z: 1 } });
    const [main] = leadUpdates();
    expect(main.UpdateExpression).toMatch(/nameCompanyKey = :nameCompanyKey/);
    expect(main.UpdateExpression).toMatch(/REMOVE linkedin/);
    expect(main.UpdateExpression).toMatch(/updatedAt = :updatedAt/);
    expect(leadUpdates()).toHaveLength(1);
    const stored = fake.lead(L, 'lead_legacy');
    expect(stored.linkedin).toBeUndefined();
    expect(stored.nameCompanyKey).toBeTruthy();
  });

  describe('list fieldNames sync', () => {
    it('appends only the truly-new names atomically and never rewrites the array', async () => {
      await crmDb.updateLead(L, 'lead_1', { customFields: { q1: 'a', source: 'lp' }, customFieldsKeyMerge: true });
      const lu = listUpdates();
      expect(lu).toHaveLength(1);
      assertWellFormed(lu[0]);
      expect(lu[0].UpdateExpression).toMatch(/list_append\(if_not_exists\(fieldNames, :empty\), :incoming\)/);
      expect(lu[0].ExpressionAttributeValues[':incoming'].sort()).toEqual(['keep', 'q1']); // 'source' already known; 'keep' is a stored key (drift heal)
      expect(lu[0].UpdateExpression).not.toMatch(/SET fieldNames = :fieldNames/);
    });

    it('with nothing new it still bumps the list updatedAt exactly once, like the old rewrite did', async () => {
      fake.seedList({ listId: L, userId: 'u1', name: 'L', fieldNames: ['source', 'keep'], leadCount: 1, updatedAt: 'old' });
      await crmDb.updateLead(L, 'lead_1', { customFields: { source: 'lp' }, customFieldsKeyMerge: true });
      const lu = listUpdates();
      expect(lu).toHaveLength(1);
      expect(lu[0].UpdateExpression).toBe('SET updatedAt = :updatedAt');
      expect(fake.list(L).updatedAt).not.toBe('old');
      expect(fake.list(L).fieldNames).toEqual(['source', 'keep']);
    });

    it('the mode flag itself is never offered as a field name', async () => {
      await crmDb.updateLead(L, 'lead_1', { firstName: 'Ann', customFieldsKeyMerge: true, customFields: { q: 1 } });
      expect(fake.list(L).fieldNames).not.toContain('customFieldsKeyMerge');
      expect(fake.list(L).fieldNames).toContain('firstName');
    });

    it('skipFieldNamesUpdate is still honoured', async () => {
      await crmDb.updateLead(L, 'lead_1', { customFields: { q: 1 }, customFieldsKeyMerge: true, skipFieldNamesUpdate: true });
      expect(listUpdates()).toHaveLength(0);
    });
  });
});
