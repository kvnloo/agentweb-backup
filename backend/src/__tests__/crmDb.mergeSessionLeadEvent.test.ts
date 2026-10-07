/**
 * ENG-2312 — contract for the atomic session-row writes in db.ts.
 *
 * These tests pin the EXACT DynamoDB request shapes. They cannot prove the expressions are
 * accepted by DynamoDB (a mocked DocumentClient never parses them — that has shipped broken
 * before), so `assertWellFormed` below statically checks the two things the real service
 * rejects most often (a placeholder used but undefined, defined but unused) and that no caller
 * key reaches an expression unescaped. The real-service proof is the DynamoDB-local run
 * recorded on the PR.
 */

jest.mock('../services/orgLeadNotificationService', () => ({ dispatchLeadCreated: jest.fn(), dispatchLeadsCreated: jest.fn() }));

const updateSpy: jest.Mock = jest.fn();
const putSpy: jest.Mock = jest.fn();
const querySpy: jest.Mock = jest.fn();
const getSpy: jest.Mock = jest.fn();
const wrap = (fn: jest.Mock) => jest.fn((p: any) => ({ promise: () => fn(p) }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: wrap(querySpy), get: wrap(getSpy), put: wrap(putSpy), update: wrap(updateSpy),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      scan: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      batchGet: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({})),
  SecretsManager: jest.fn(() => ({})),
}));

import { crmDb } from '../services/db';

const ccf = (code: string) => Object.assign(new Error(code), { code });

/** Static stand-in for DynamoDB's expression validation. */
function assertWellFormed(p: any) {
  const expr = [p.UpdateExpression, p.ConditionExpression].filter(Boolean).join(' ');
  const names = p.ExpressionAttributeNames ?? {};
  const values = p.ExpressionAttributeValues ?? {};
  const usedNames = new Set(expr.match(/#[A-Za-z0-9_]+/g) ?? []);
  const usedValues = new Set(expr.match(/:[A-Za-z0-9_]+/g) ?? []);
  for (const n of usedNames) expect(names).toHaveProperty([n as string]);
  for (const v of usedValues) expect(values).toHaveProperty([v as string]);
  for (const n of Object.keys(names)) expect(usedNames.has(n)).toBe(true);
  for (const v of Object.keys(values)) expect(usedValues.has(v)).toBe(true);
  // No caller-chosen key may appear verbatim in an expression (reserved words, dots, spaces).
  const bare = expr.replace(/[#:][A-Za-z0-9_]+/g, '');
  for (const real of Object.values(names) as string[]) {
    if (!['leadId', 'updatedAt', 'customFields'].includes(real)) {
      const esc = real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(bare).not.toMatch(new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`));
    }
  }
}

describe('crmDb.mergeSessionLeadEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateSpy.mockResolvedValue({ Attributes: { leadId: 'L', customFields: {} } });
  });

  it('scalars: one document-path SET per key, conditional on the row existing, returns the pre-image', async () => {
    await crmDb.mergeSessionLeadEvent('list1', 'lead_1_abc', {
      customFields: { dwellSec: 12, activeSec: 7 },
    });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const p = updateSpy.mock.calls[0][0];
    expect(p.Key).toEqual({ listId: 'list1', leadId: 'lead_1_abc' });
    expect(p.UpdateExpression).toBe('SET #ua = :ts, #cf.#k0 = :v0, #cf.#k1 = :v1');
    expect(p.ConditionExpression).toBe('attribute_exists(#lid)');
    expect(p.ReturnValues).toBe('ALL_OLD');
    expect(p.ExpressionAttributeNames).toEqual({
      '#lid': 'leadId', '#ua': 'updatedAt', '#cf': 'customFields', '#k0': 'dwellSec', '#k1': 'activeSec',
    });
    expect(p.ExpressionAttributeValues).toMatchObject({ ':v0': 12, ':v1': 7 });
    assertWellFormed(p);
  });

  it('escapes reserved words and awkward characters in caller-chosen keys (names AND values)', async () => {
    const nasty = { domain: 'a.com', system: 's', name: 'n', 'a.b': 1, 'with space': 2, 'dash-ed': 3, 'ünï': 4 };
    await crmDb.mergeSessionLeadEvent('list1', 'lead_1_abc', {
      customFields: nasty,
      topLevel: { company: 'Acme', lastTouch: { utm: { source: 'x' } } },
      topLevelIfNotExists: { firstTouch: { utm: { source: 'x' } }, clientIp: '1.2.3.4' },
      monotonic: { counterKey: 'eventCount', counter: 3, fields: { journey: ['a'], eventCount: 3, clickLog: [] } },
    });
    for (const [call] of updateSpy.mock.calls) assertWellFormed(call);
    const first = updateSpy.mock.calls[0][0];
    expect(Object.values(first.ExpressionAttributeNames)).toEqual(expect.arrayContaining(Object.keys(nasty)));
    expect(first.UpdateExpression).toContain('#n1 = if_not_exists(#n1, :n1)');
  });

  it('journey group: ONE conditional UpdateItem guarded on the stored counter, applied => guardApplied true', async () => {
    const r = await crmDb.mergeSessionLeadEvent('list1', 'lead_1_abc', {
      customFields: { dwellSec: 1 },
      monotonic: { counterKey: 'eventCount', counter: 5, fields: { journey: 'x', eventCount: 5 } },
    });
    expect(updateSpy).toHaveBeenCalledTimes(2); // scalars, then the guarded group
    const g = updateSpy.mock.calls[1][0];
    expect(g.ConditionExpression).toBe(
      'attribute_exists(#lid) AND (attribute_not_exists(#cf.#ctr) OR NOT attribute_type(#cf.#ctr, :numType) OR #cf.#ctr <= :ctr)');
    expect(g.UpdateExpression).toBe('SET #ua = :ts, #cf.#g0 = :g0, #cf.#g1 = :g1');
    expect(g.ExpressionAttributeValues).toMatchObject({ ':ctr': 5, ':numType': 'N' });
    expect(g.ExpressionAttributeNames['#ctr']).toBe('eventCount');
    // the guarded write must never carry the scalar fields: a failed condition fails the item
    expect(JSON.stringify(g)).not.toContain('dwellSec');
    expect(r.guardApplied).toBe(true);
  });

  it('stale journey (older event arrives late): guard fails => guardApplied false, scalars still written, no throw', async () => {
    updateSpy
      .mockResolvedValueOnce({ Attributes: { customFields: { eventCount: 9 } } })
      .mockRejectedValueOnce(ccf('ConditionalCheckFailedException'));
    const r = await crmDb.mergeSessionLeadEvent('list1', 'lead_1_abc', {
      customFields: { dwellSec: 1 },
      monotonic: { counterKey: 'eventCount', counter: 2, fields: { eventCount: 2, journey: 'old' } },
    });
    expect(r).toMatchObject({ exists: true, guardApplied: false });
  });

  it('two groups: each is its OWN conditional UpdateItem on its OWN counter; one stale group does not block the other', async () => {
    updateSpy
      .mockResolvedValueOnce({ Attributes: { customFields: {} } })     // scalars
      .mockRejectedValueOnce(ccf('ConditionalCheckFailedException'))   // PROGRESS stale
      .mockResolvedValueOnce({});                                      // CLICKS applied
    const r = await crmDb.mergeSessionLeadEvent('list1', 'lead_1_abc', {
      customFields: { name: 'n' },
      monotonic: [
        { counterKey: 'eventCount', counter: 2, fields: { eventCount: 2, lastEvent: 'play_start' } },
        { counterKey: 'clickCount', counter: 1, fields: { clickCount: 1, system: 'reserved', 'a.b': 1 } },
      ],
    });
    expect(updateSpy).toHaveBeenCalledTimes(3);
    const [, progress, clicks] = updateSpy.mock.calls.map((c) => c[0]);
    for (const g of [progress, clicks]) {
      assertWellFormed(g);
      expect(g.ConditionExpression).toBe(
        'attribute_exists(#lid) AND (attribute_not_exists(#cf.#ctr) OR NOT attribute_type(#cf.#ctr, :numType) OR #cf.#ctr <= :ctr)');
      expect(g.ExpressionAttributeValues).toMatchObject({ ':numType': 'N' });
    }
    expect(progress.ExpressionAttributeNames['#ctr']).toBe('eventCount');
    expect(progress.ExpressionAttributeValues[':ctr']).toBe(2);
    expect(clicks.ExpressionAttributeNames['#ctr']).toBe('clickCount');
    expect(clicks.ExpressionAttributeValues[':ctr']).toBe(1);
    expect(Object.values(clicks.ExpressionAttributeNames)).toEqual(expect.arrayContaining(['system', 'a.b']));
    // a group's UpdateItem never carries another group's (or the scalars') fields
    expect(JSON.stringify(progress)).not.toMatch(/clickCount|system|"name"/);
    expect(JSON.stringify(clicks)).not.toMatch(/lastEvent|eventCount/);
    expect(r).toMatchObject({ exists: true, guardApplied: true }); // any group applied
  });

  it('guardApplied is true when the FIRST group applied and a later one was stale', async () => {
    updateSpy.mockResolvedValueOnce({ Attributes: {} }).mockResolvedValueOnce({}).mockRejectedValueOnce(ccf('ConditionalCheckFailedException'));
    const r = await crmDb.mergeSessionLeadEvent('l', 'x', { monotonic: [
      { counterKey: 'eventCount', counter: 2, fields: { eventCount: 2 } },
      { counterKey: 'clickCount', counter: 1, fields: { clickCount: 1 } },
    ] });
    expect(r.guardApplied).toBe(true);
  });

  it('all groups stale => guardApplied false; no throw', async () => {
    updateSpy.mockResolvedValueOnce({ Attributes: {} }).mockRejectedValue(ccf('ConditionalCheckFailedException'));
    const r = await crmDb.mergeSessionLeadEvent('l', 'x', { monotonic: [
      { counterKey: 'eventCount', counter: 1, fields: { eventCount: 1 } },
      { counterKey: 'clickCount', counter: 1, fields: { clickCount: 1 } },
    ] });
    expect(updateSpy).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ exists: true, guardApplied: false, changed: false });
  });

  it('changed is detected from a later applied group (pre-image differs only in CLICKS)', async () => {
    updateSpy.mockResolvedValueOnce({ Attributes: { customFields: { eventCount: 2, clickCount: 0 } } }).mockResolvedValue({});
    const r = await crmDb.mergeSessionLeadEvent('l', 'x', { monotonic: [
      { counterKey: 'eventCount', counter: 2, fields: { eventCount: 2 } },
      { counterKey: 'clickCount', counter: 1, fields: { clickCount: 1 } },
    ] });
    expect(r.changed).toBe(true);
  });

  it('row deleted meanwhile: exists=false and the journey write is not attempted', async () => {
    updateSpy.mockRejectedValueOnce(ccf('ConditionalCheckFailedException'));
    const r = await crmDb.mergeSessionLeadEvent('list1', 'lead_1_abc', {
      customFields: { a: 1 }, monotonic: { counterKey: 'eventCount', counter: 1, fields: { eventCount: 1 } },
    });
    expect(r.exists).toBe(false);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('reports changed only when the atomic pre-image differs', async () => {
    updateSpy.mockResolvedValueOnce({ Attributes: { customFields: { dwellSec: 5 } } });
    expect((await crmDb.mergeSessionLeadEvent('l', 'x', { customFields: { dwellSec: 5 } })).changed).toBe(false);
    updateSpy.mockResolvedValueOnce({ Attributes: { customFields: { dwellSec: 5 } } });
    expect((await crmDb.mergeSessionLeadEvent('l', 'x', { customFields: { dwellSec: 6 } })).changed).toBe(true);
  });

  it('bounds a hostile key count: chunks of 100, hard cap 300, each chunk well-formed', async () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) many[`k${i}`] = i;
    await crmDb.mergeSessionLeadEvent('l', 'x', { customFields: many });
    expect(updateSpy).toHaveBeenCalledTimes(3);
    for (const [call] of updateSpy.mock.calls) {
      assertWellFormed(call);
      expect(call.UpdateExpression.length).toBeLessThan(4096);
    }
  });

  it('drops undefined values and empty keys instead of sending an invalid request', async () => {
    await crmDb.mergeSessionLeadEvent('l', 'x', { customFields: { ok: 1, bad: undefined, '': 'x' } });
    const p = updateSpy.mock.calls[0][0];
    expect(Object.values(p.ExpressionAttributeNames)).not.toContain('');
    expect(p.UpdateExpression).toBe('SET #ua = :ts, #cf.#k0 = :v0');
  });

  it('missing customFields map: bootstraps it once and retries (instead of a 500)', async () => {
    updateSpy
      .mockRejectedValueOnce(Object.assign(new Error('The document path provided in the update expression is invalid for update'), { code: 'ValidationException' }))
      .mockResolvedValue({ Attributes: {} });
    const r = await crmDb.mergeSessionLeadEvent('l', 'x', { customFields: { a: 1 } });
    expect(r.exists).toBe(true);
    expect(updateSpy.mock.calls[1][0].UpdateExpression).toBe('SET #cf = if_not_exists(#cf, :empty)');
    expect(updateSpy).toHaveBeenCalledTimes(3);
  });
});

describe('crmDb.createLead — conditional session create (ENG-2312)', () => {
  const cond = () => ccf('ConditionalCheckFailedException');
  beforeEach(() => {
    jest.clearAllMocks();
    querySpy.mockResolvedValue({ Items: [] });
    getSpy.mockResolvedValue({ Item: { listId: 'list1', userId: 'u1', fieldNames: [] } });
    putSpy.mockResolvedValue({});
    updateSpy.mockResolvedValue({ Attributes: {} });
  });
  const leadCountAdds = () => updateSpy.mock.calls.filter(([p]) => String(p.UpdateExpression).includes('ADD leadCount'));

  it('puts with attribute_not_exists(leadId), skips the email-index pre-check, and increments leadCount exactly once', async () => {
    await crmDb.createLead('list1', {
      email: 's-abc@sessions.go.dramabreak.ai', leadId: 'lead_1_abc', failIfExists: true,
      skipEmailDuplicateCheck: true, suppressSideEffects: true, customFields: { dwellSec: 1 },
    });
    expect(querySpy).not.toHaveBeenCalled(); // no getLeadByEmail
    expect(putSpy.mock.calls[0][0].ConditionExpression).toBe('attribute_not_exists(leadId)');
    expect(putSpy.mock.calls[0][0].Item.leadId).toBe('lead_1_abc');
    expect(leadCountAdds()).toHaveLength(1);
  });

  it('LOSER of the conditional put: tagged leadAlreadyExists and NO create-time work (no leadCount, no fieldNames)', async () => {
    putSpy.mockRejectedValue(cond());
    await expect(crmDb.createLead('list1', {
      email: 's-abc@sessions.go.dramabreak.ai', leadId: 'lead_1_abc', failIfExists: true,
      skipEmailDuplicateCheck: true, suppressSideEffects: true, customFields: { dwellSec: 1 },
    })).rejects.toMatchObject({ leadAlreadyExists: true });
    expect(leadCountAdds()).toHaveLength(0);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('default behaviour unchanged: without the opt-in the email pre-check still runs and still throws a plain Error', async () => {
    querySpy.mockResolvedValue({ Items: [{ leadId: 'other' }] });
    await expect(crmDb.createLead('list1', { email: 'a@b.com' })).rejects.toThrow(/already exists in this list/);
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(querySpy.mock.calls[0][0].IndexName).toBe('email-index');
    expect(putSpy).not.toHaveBeenCalled();
  });
});
