/**
 * ENG-1250 §3b — the persisted monthly projection store.
 *
 * The load-bearing claims: the snapshot round-trips faithfully, a bad
 * subject/month is refused before it can poison admission, and the
 * persisted-vs-derived reconciliation distinguishes "missing" from "drifting"
 * (conflating them would let "never written" read as "reconciles").
 */
jest.mock('aws-sdk', () => {
  const mockDynamoDB = { put: jest.fn(), get: jest.fn(), batchGet: jest.fn() };
  return { DynamoDB: { DocumentClient: jest.fn(() => mockDynamoDB) }, config: { update: jest.fn() } };
});

import AWS from 'aws-sdk';
import {
  SPEND_PROJECTION_TABLE,
  getProjection,
  getProjectionsBatch,
  putProjection,
  reconcilePersistedProjection,
  PersistedProjection,
} from '../services/spendProjectionDb';
import { MonthlyProjection } from '../services/spendProjection';

const mockDynamoDB = new (AWS.DynamoDB.DocumentClient as any)();

const aProjection = (over: Partial<MonthlyProjection> = {}): MonthlyProjection => ({
  billingUserId: 'owner-1',
  billingMonth: '2026-09',
  settledMicroUsd: 12500,
  reservedMicroUsd: 0,
  includedAllowanceMicroUsd: 200_000_000,
  purchasedCreditsMicroUsd: 0,
  adminAdjustmentMicroUsd: 0,
  migrationAdjustmentMicroUsd: 0,
  usableAllowanceMicroUsd: 200_000_000,
  remainingMicroUsd: 199_987_500,
  overspentMicroUsd: 0,
  unlimited: false,
  policyMode: 'full_choice',
  settledEventCount: 1,
  reservedEventCount: 0,
  voidedEventCount: 0,
  excludedEventCount: 0,
  ...over,
});

describe('putProjection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
  });

  it('writes the projection plus a computedAt stamp to the projection table', async () => {
    const result = await putProjection(aProjection(), '2026-09-17T10:00:00.000Z');

    const arg = mockDynamoDB.put.mock.calls[0][0];
    expect(arg.TableName).toBe(SPEND_PROJECTION_TABLE);
    expect(arg.Item.billingUserId).toBe('owner-1');
    expect(arg.Item.billingMonth).toBe('2026-09');
    expect(arg.Item.computedAt).toBe('2026-09-17T10:00:00.000Z');
    expect(result.settledMicroUsd).toBe(12500);
    // §4 seeds the admission balance unfloored: usable − settled − reserved.
    expect(result.availableMicroUsd).toBe(200_000_000 - 12500 - 0);
  });

  it('refuses an empty subject — a keyless snapshot would poison admission reads', async () => {
    await expect(putProjection(aProjection({ billingUserId: '' }))).rejects.toThrow(/empty subject or bad month/);
    expect(mockDynamoDB.put).not.toHaveBeenCalled();
  });

  it.each(['2026-13', '2026-00', '2026-9', 'nope'])('refuses a bad month %s', async (bad) => {
    await expect(putProjection(aProjection({ billingMonth: bad }))).rejects.toThrow(/bad month/);
    expect(mockDynamoDB.put).not.toHaveBeenCalled();
  });

  it('canonicalises a valid computedAt to a UTC ISO instant', async () => {
    const result = await putProjection(aProjection(), '2026-09-17T10:00:00+01:00');
    // +01:00 normalises to 09:00Z
    expect(result.computedAt).toBe('2026-09-17T09:00:00.000Z');
    expect(mockDynamoDB.put.mock.calls[0][0].Item.computedAt).toBe('2026-09-17T09:00:00.000Z');
  });

  it.each(['', 'not-a-date'])('refuses an unparseable computedAt %p', async (bad) => {
    await expect(putProjection(aProjection(), bad)).rejects.toThrow(/ISO-8601 instant/);
    expect(mockDynamoDB.put).not.toHaveBeenCalled();
  });
});

describe('getProjection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads by the composite key and returns null when absent', async () => {
    mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });

    await expect(getProjection('owner-1', '2026-09')).resolves.toBeNull();
    expect(mockDynamoDB.get.mock.calls[0][0].Key).toEqual({ billingUserId: 'owner-1', billingMonth: '2026-09' });
  });

  it('returns the stored snapshot when present', async () => {
    const stored: PersistedProjection = { ...aProjection(), computedAt: '2026-09-17T10:00:00.000Z', availableMicroUsd: 0 };
    mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: stored }) });

    const got = await getProjection('owner-1', '2026-09');
    expect(got?.settledMicroUsd).toBe(12500);
    expect(got?.computedAt).toBe('2026-09-17T10:00:00.000Z');
  });
});

describe('reconcilePersistedProjection — §3 invariant at the persistence layer', () => {
  const derived = aProjection({ settledMicroUsd: 12500 });

  it('agrees when the snapshot matches a fresh derivation', () => {
    const persisted: PersistedProjection = { ...derived, computedAt: 'x', availableMicroUsd: 0 };
    const r = reconcilePersistedProjection(persisted, derived);
    expect(r).toMatchObject({ ok: true, missing: false, driftMicroUsd: 0 });
  });

  it('reports MISSING distinctly from drift — "never written" must not read as "reconciles"', () => {
    const r = reconcilePersistedProjection(null, derived);
    expect(r.ok).toBe(false);
    expect(r.missing).toBe(true);
    expect(r.persistedSettledMicroUsd).toBeNull();
    expect(r.driftMicroUsd).toBe(12500);
  });

  it('detects a drifting snapshot', () => {
    const stale: PersistedProjection = { ...derived, settledMicroUsd: 10000, computedAt: 'x', availableMicroUsd: 0 };
    const r = reconcilePersistedProjection(stale, derived);
    expect(r.ok).toBe(false);
    expect(r.missing).toBe(false);
    expect(r.driftMicroUsd).toBe(-2500);
  });

  it('tolerates one micro-dollar and fails just past it', () => {
    const within: PersistedProjection = { ...derived, settledMicroUsd: 12501, computedAt: 'x', availableMicroUsd: 0 };
    const beyond: PersistedProjection = { ...derived, settledMicroUsd: 12502, computedAt: 'x', availableMicroUsd: 0 };
    expect(reconcilePersistedProjection(within, derived).ok).toBe(true);
    expect(reconcilePersistedProjection(beyond, derived).ok).toBe(false);
  });
});


describe('getProjectionsBatch', () => {
  const resp = (items: any[], unprocessed?: any[]) => ({
    promise: () =>
      Promise.resolve({
        Responses: { [SPEND_PROJECTION_TABLE]: items },
        ...(unprocessed ? { UnprocessedKeys: { [SPEND_PROJECTION_TABLE]: { Keys: unprocessed } } } : {}),
      }),
  });
  const row = (id: string, settled: number) => ({ ...aProjection({ billingUserId: id, settledMicroUsd: settled }), computedAt: 't', availableMicroUsd: 0 });

  beforeEach(() => {
    mockDynamoDB.batchGet.mockReset();
  });

  it('returns a map keyed by billingUserId; a subject with no row is simply absent', async () => {
    mockDynamoDB.batchGet.mockReturnValueOnce(resp([row('a', 5), row('b', 7)]));

    const m = await getProjectionsBatch(['a', 'b', 'c-no-row'], '2026-10');

    expect([...m.keys()].sort()).toEqual(['a', 'b']);
    expect(m.get('a')!.settledMicroUsd).toBe(5);
    expect(m.has('c-no-row')).toBe(false);
    const keys = mockDynamoDB.batchGet.mock.calls[0][0].RequestItems[SPEND_PROJECTION_TABLE].Keys;
    expect(keys).toEqual([
      { billingUserId: 'a', billingMonth: '2026-10' },
      { billingUserId: 'b', billingMonth: '2026-10' },
      { billingUserId: 'c-no-row', billingMonth: '2026-10' },
    ]);
  });

  it('de-duplicates ids and skips empty ones, so a key is never requested twice', async () => {
    mockDynamoDB.batchGet.mockReturnValueOnce(resp([row('a', 1)]));
    await getProjectionsBatch(['a', 'a', '', 'a'], '2026-10');
    expect(mockDynamoDB.batchGet.mock.calls[0][0].RequestItems[SPEND_PROJECTION_TABLE].Keys).toHaveLength(1);
  });

  it('chunks at 100 keys per call (DynamoDB limit)', async () => {
    mockDynamoDB.batchGet.mockImplementation(() => resp([]));
    await getProjectionsBatch(Array.from({ length: 250 }, (_, i) => `u${i}`), '2026-10');
    expect(mockDynamoDB.batchGet).toHaveBeenCalledTimes(3);
    const sizes = mockDynamoDB.batchGet.mock.calls.map((c: any) => c[0].RequestItems[SPEND_PROJECTION_TABLE].Keys.length);
    expect(sizes).toEqual([100, 100, 50]);
  });

  it('makes no call at all for an empty list', async () => {
    const m = await getProjectionsBatch([], '2026-10');
    expect(m.size).toBe(0);
    expect(mockDynamoDB.batchGet).not.toHaveBeenCalled();
  });

  it('retries unprocessed keys and merges the late results', async () => {
    const late = [{ billingUserId: 'b', billingMonth: '2026-10' }];
    mockDynamoDB.batchGet
      .mockReturnValueOnce(resp([row('a', 1)], late))
      .mockReturnValueOnce(resp([row('b', 2)]));

    const m = await getProjectionsBatch(['a', 'b'], '2026-10');

    expect([...m.keys()].sort()).toEqual(['a', 'b']);
    expect(mockDynamoDB.batchGet).toHaveBeenCalledTimes(2);
    expect(mockDynamoDB.batchGet.mock.calls[1][0].RequestItems[SPEND_PROJECTION_TABLE].Keys).toEqual(late);
  });

  it('THROWS rather than return a partial map when keys stay unprocessed (absent would read as "no spend")', async () => {
    mockDynamoDB.batchGet.mockImplementation(() => resp([], [{ billingUserId: 'a', billingMonth: '2026-10' }]));
    await expect(getProjectionsBatch(['a'], '2026-10', 1)).rejects.toThrow(/still unprocessed/);
  });

  it('refuses a malformed month before any read', async () => {
    await expect(getProjectionsBatch(['a'], '2026-13')).rejects.toThrow(/bad billing month/);
    expect(mockDynamoDB.batchGet).not.toHaveBeenCalled();
  });
});
