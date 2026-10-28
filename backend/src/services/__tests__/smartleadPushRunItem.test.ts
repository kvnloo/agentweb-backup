import {
  SmartleadPushRunStoreError,
  fromRunItem,
  toRunItem,
  type PushRun,
} from '../smartleadPushRunDb';

const run = (over: Partial<PushRun> = {}): PushRun => ({
  runId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', schemaVersion: 1, status: 'running', ownerId: 'u1', pushedBy: 'u1', keyOwnerId: 'u1', smartleadAccountId: 'smartlead-u1',
  channel: 'ui', listId: 'list_1', campaignId: 77, campaignName: 'Q4', campaignSource: 'selected', options: { includeUnverified: false }, sequenceHash: 'abc',
  previewEligible: 50, counts: { examined: 0, added: 0, alreadyInCampaign: 0, unconfirmed: 0, withdrawn: 0, skippedByReason: {} }, cursor: null, listExhausted: false,
  batchAttempts: 0, leaseOwner: 'w1', leaseEpoch: 1, leaseUntil: 1000, createdAt: '2026-10-27T00:00:00.000Z', startedAt: '2026-10-27T00:00:00.000Z', ...over,
});

describe('push run items (ENG-673)', () => {
  it('round-trips a run, including its cursor and counts', () => {
    const r = run({ cursor: { listId: 'list_1', leadId: 'lead_9' }, counts: { examined: 5, added: 3, alreadyInCampaign: 1, unconfirmed: 0, withdrawn: 0, skippedByReason: { missing_tag: 1 } }, orgId: 'org1', pauseReason: 'x' });
    expect(fromRunItem(toRunItem(r, 99))).toEqual(r);
  });

  it('puts the run in the sparse resume index only while it is live', () => {
    expect(toRunItem(run({ status: 'running' }), 1).active).toBe('Y');
    expect(toRunItem(run({ status: 'paused' }), 1).active).toBe('P');
    expect(toRunItem(run({ status: 'partial' }), 1).active).toBe('P');
    for (const status of ['completed', 'failed', 'canceled'] as const) expect('active' in toRunItem(run({ status }), 1)).toBe(false);
  });

  it('carries the keys of every index, so a run shows up in each', () => {
    const item = toRunItem(run(), 1);
    expect(item).toMatchObject({ pk: run().runId, sk: 'RUN', kind: 'RUN', listId: 'list_1', ownerId: 'u1', createdAt: '2026-10-27T00:00:00.000Z', leaseUntil: 1000, ttl: 1 });
  });

  it('ignores attributes it does not know and tolerates missing optional ones (a newer or older writer)', () => {
    const item = { ...toRunItem(run(), 1), futureField: { a: 1 }, schemaVersion: 7 };
    delete (item as any).counts;
    delete (item as any).options;
    const read = fromRunItem(item);
    expect(read.schemaVersion).toBe(7);
    expect(read.counts).toEqual({ examined: 0, added: 0, alreadyInCampaign: 0, unconfirmed: 0, withdrawn: 0, skippedByReason: {} });
    expect(read.options).toEqual({});
    expect('futureField' in read).toBe(false);
  });

  it('refuses a status it does not know instead of guessing: an older instance must stop, not act on a state it cannot read', () => {
    expect(() => fromRunItem({ ...toRunItem(run(), 1), status: 'preparing' })).toThrow(SmartleadPushRunStoreError);
    expect(() => fromRunItem({ pk: 'x', sk: 'LOCK' })).toThrow(SmartleadPushRunStoreError);
  });

  it('reads a malformed cursor as no cursor, never as a partial key', () => {
    for (const cursor of [{ listId: 'l' }, { leadId: 'x' }, 'str', 5]) expect(fromRunItem({ ...toRunItem(run(), 1), cursor }).cursor).toBeNull();
  });
});
