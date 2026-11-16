import {
  SmartleadPushRunDb,
  SmartleadPushRunStoreError,
  fromRunItem,
  toRunItem,
  type PushRun,
} from '../smartleadPushRunDb';
import { toRunView } from '../smartleadPushService';

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

  it('a run with no event counters reads without them; stored counters read back, and an odd value counts as zero', () => {
    expect('events' in fromRunItem(toRunItem(run(), 1))).toBe(false);
    expect(fromRunItem({ ...toRunItem(run(), 1), events: { replied: 2, bounced: 1, unsubscribed: 3 } }).events).toEqual({ replied: 2, bounced: 1, unsubscribed: 3 });
    expect(fromRunItem({ ...toRunItem(run(), 1), events: { replied: 'x', unsubscribed: null } }).events).toEqual({ replied: 0, bounced: 0, unsubscribed: 0 });
    expect('events' in fromRunItem({ ...toRunItem(run(), 1), events: 'junk' })).toBe(false);
  });
});

describe('counting a contact event on a run (ENG-673)', () => {
  const lost = () => Object.assign(new Error('condition'), { code: 'ConditionalCheckFailedException' });
  /** A fake table client: `hasRun`/`hasEvents` decide which condition holds. Records every update it is sent. */
  const fake = (state: { hasRun: boolean; hasEvents: boolean; counts?: Record<string, number> }) => {
    const calls: any[] = [];
    const client: any = {
      update: (params: any) => ({
        promise: async () => {
          calls.push(params);
          const expr: string = params.UpdateExpression;
          if (expr.includes('if_not_exists')) {
            if (!state.hasRun || !state.hasEvents) throw lost();
            const kind = params.ExpressionAttributeNames['#k'];
            state.counts = { ...(state.counts ?? {}), [kind]: ((state.counts ?? {})[kind] ?? 0) + 1 };
            return {};
          }
          if (!state.hasRun || state.hasEvents) throw lost();
          state.hasEvents = true;
          return {};
        },
      }),
    };
    return { db: new SmartleadPushRunDb(client, 'T', () => 0, async () => undefined), calls, state };
  };

  it('adds to a counter that exists, with one update and no lease or status involved', async () => {
    const f = fake({ hasRun: true, hasEvents: true });
    expect(await f.db.countContactEvent('r1', 'replied')).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].UpdateExpression).toBe('SET #e.#k = if_not_exists(#e.#k, :zero) + :one');
    expect(f.calls[0].ConditionExpression).toBe('attribute_exists(pk) AND attribute_exists(#e)');
    expect(f.calls[0].ExpressionAttributeNames).toEqual({ '#e': 'events', '#k': 'replied' });
    expect(f.state.counts).toEqual({ replied: 1 });
  });

  it('creates the counters once for a run that has none (an older run), then counts', async () => {
    const f = fake({ hasRun: true, hasEvents: false });
    expect(await f.db.countContactEvent('r1', 'bounced')).toBe(true);
    expect(f.calls).toHaveLength(3); // refused, create (only where none exist), count
    expect(f.calls[1].ConditionExpression).toBe('attribute_exists(pk) AND attribute_not_exists(#e)');
    expect(f.state.counts).toEqual({ bounced: 1 });
  });

  it('reports false, and creates nothing, when the run is gone', async () => {
    const f = fake({ hasRun: false, hasEvents: false });
    expect(await f.db.countContactEvent('missing', 'unsubscribed')).toBe(false);
    expect(f.state.hasEvents).toBe(false);
  });

  it('reads only the counters of a run, and nothing for a run with none or a missing run', async () => {
    const items: Record<string, any> = { a: { pk: 'a', sk: 'RUN', events: { replied: 2, unsubscribed: 1 } }, b: { pk: 'b', sk: 'RUN' } };
    const seen: any[] = [];
    const client: any = { get: (params: any) => ({ promise: async () => { seen.push(params); return { Item: items[params.Key.pk] }; } }) };
    const db = new SmartleadPushRunDb(client, 'T', () => 0, async () => undefined);
    expect(await db.getRunEvents('a')).toEqual({ replied: 2, bounced: 0, unsubscribed: 1 });
    expect(await db.getRunEvents('b')).toBeUndefined();
    expect(await db.getRunEvents('zzz')).toBeUndefined();
    expect(seen[0]).toMatchObject({ ProjectionExpression: '#e', ExpressionAttributeNames: { '#e': 'events' } });
  });

  it('refuses a kind it does not know before any write', async () => {
    const f = fake({ hasRun: true, hasEvents: true });
    await expect(f.db.countContactEvent('r1', 'deleted' as any)).rejects.toBeInstanceOf(SmartleadPushRunStoreError);
    expect(f.calls).toHaveLength(0);
  });

  it('the run view carries the event counters only when there are some', () => {
    expect('events' in toRunView(run())).toBe(false);
    expect(toRunView(run({ events: { replied: 1, bounced: 0, unsubscribed: 2 } })).events).toEqual({ replied: 1, bounced: 0, unsubscribed: 2 });
  });
});
