/**
 * Unit tests for the DynamoDB-backed loop dispatch tracker (v2).
 *
 * Tracks Slack message timestamps that have already been dispatched to
 * cloud-dev so a second ✅ reaction on the same daily-digest DM does NOT
 * fire duplicate EC2 launches. v2 persists to DynamoDB (AW-LoopDispatches)
 * via the injected DynamoPort, so the dedupe set survives backend redeploys.
 *
 * Acceptance criteria (HUMAN-WRITTEN — Notion task 37009247…; agent must not modify):
 *   1. Dedupe survives redeploy: after markDispatched(ts), a brand-new tracker
 *      instance backed by the SAME table reports isDispatched(ts) === true.
 *   2. (no-double-dispatch — covered end-to-end in slack.aiEvalReaction.test.ts)
 *   3. First reaction still dispatches: an unseen ts → isDispatched === false,
 *      then after mark it is true.
 *   4. DynamoDB failure is non-fatal: a throwing port degrades to in-memory and
 *      does not propagate (covered via the module singleton + integration test).
 */

import {
  DynamoLoopDispatchTracker,
  TTL_MS,
  LOOP_DISPATCHES_TABLE,
  isDispatched as singletonIsDispatched,
  markDispatched as singletonMarkDispatched,
  getDispatched as singletonGetDispatched,
  _resetForTesting,
} from '../services/loopDispatchTracker';
import type { DynamoAttributeMap, DynamoPort } from '../loops/core/ports';

/**
 * In-memory fake DynamoPort keyed on the `messageTs` partition key, so two
 * tracker instances sharing one fake simulate two backend processes hitting
 * the same persistent table.
 */
function fakeDynamo() {
  const items = new Map<string, DynamoAttributeMap>();
  const port: DynamoPort = {
    putItem: jest.fn(async (_table: string, item: DynamoAttributeMap) => {
      const key = String(item.messageTs);
      items.set(key, { ...item });
    }),
    getItem: jest.fn(async (_table: string, key: DynamoAttributeMap) => {
      return items.get(String(key.messageTs)) ?? null;
    }),
    query: jest.fn(async () => ({ items: [] })),
  };
  return { port, items };
}

const TS = '1700000000.000001';
const TS2 = '1700000000.000002';

describe('DynamoLoopDispatchTracker', () => {
  describe('markDispatched / isDispatched / getDispatched', () => {
    it('returns false for a never-seen messageTs', async () => {
      const { port } = fakeDynamo();
      const tracker = new DynamoLoopDispatchTracker(port);
      expect(await tracker.isDispatched(TS)).toBe(false);
      expect(await tracker.getDispatched(TS)).toBeNull();
    });

    it('returns true after markDispatched is called (first reaction dispatches)', async () => {
      const { port } = fakeDynamo();
      const tracker = new DynamoLoopDispatchTracker(port);
      expect(await tracker.isDispatched(TS)).toBe(false); // unseen first
      await tracker.markDispatched(TS, ['page-a', 'page-b']);
      expect(await tracker.isDispatched(TS)).toBe(true);
    });

    it('round-trips dispatchedAt + pageIds through getDispatched', async () => {
      const { port } = fakeDynamo();
      const fixedNow = 1_700_000_000_000;
      const tracker = new DynamoLoopDispatchTracker(port, { now: () => fixedNow });
      await tracker.markDispatched(TS, ['page-a', 'page-b']);

      const entry = await tracker.getDispatched(TS);
      expect(entry).not.toBeNull();
      expect(entry!.pageIds).toEqual(['page-a', 'page-b']);
      expect(entry!.dispatchedAt.getTime()).toBe(fixedNow);
    });

    it('different messageTs values are independent', async () => {
      const { port } = fakeDynamo();
      const tracker = new DynamoLoopDispatchTracker(port);
      await tracker.markDispatched(TS, ['page-a']);
      expect(await tracker.isDispatched(TS)).toBe(true);
      expect(await tracker.isDispatched(TS2)).toBe(false);
    });

    it('writes a ttl of floor(now/1000) + 7d (epoch seconds)', async () => {
      const { port, items } = fakeDynamo();
      const fixedNow = 1_700_000_000_000;
      const tracker = new DynamoLoopDispatchTracker(port, { now: () => fixedNow });
      await tracker.markDispatched(TS, ['page-a']);

      const stored = items.get(TS)!;
      expect(stored.ttl).toBe(Math.floor(fixedNow / 1000) + Math.floor(TTL_MS / 1000));
      // sanity: 7 days in seconds
      expect((stored.ttl as number) - Math.floor(fixedNow / 1000)).toBe(7 * 24 * 60 * 60);
    });

    it('writes to the LOOP_DISPATCHES_TABLE by default', async () => {
      const { port } = fakeDynamo();
      const tracker = new DynamoLoopDispatchTracker(port);
      await tracker.markDispatched(TS, ['page-a']);
      expect(port.putItem).toHaveBeenCalledWith(LOOP_DISPATCHES_TABLE, expect.any(Object));
    });
  });

  // -------------------------------------------------------------------------
  // AC #1 — Dedupe survives redeploy.
  // -------------------------------------------------------------------------
  describe('AC#1: dedupe survives a simulated redeploy', () => {
    it('a brand-new tracker backed by the same table still reports dispatched', async () => {
      const { port } = fakeDynamo();

      // Process #1 marks the dispatch...
      const trackerBeforeRedeploy = new DynamoLoopDispatchTracker(port);
      await trackerBeforeRedeploy.markDispatched(TS, ['page-a']);
      expect(await trackerBeforeRedeploy.isDispatched(TS)).toBe(true);

      // ...process #2 (redeployed backend) constructs a FRESH tracker over the
      // SAME persistent table. In v1 (in-memory Map) this returned false and
      // re-dispatched. With DynamoDB it must still be true.
      const trackerAfterRedeploy = new DynamoLoopDispatchTracker(port);
      expect(await trackerAfterRedeploy.isDispatched(TS)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // TTL passive-expiry guard.
  // -------------------------------------------------------------------------
  describe('TTL passive-expiry guard', () => {
    it('an item whose stored ttl is in the past reads as NOT dispatched even if still present', async () => {
      const { port, items } = fakeDynamo();
      const markTime = 1_700_000_000_000;
      const tracker = new DynamoLoopDispatchTracker(port, { now: () => markTime });
      await tracker.markDispatched(TS, ['page-a']);
      expect(await tracker.isDispatched(TS)).toBe(true);
      // The fake table still physically holds the row (DynamoDB TTL deletion lags).
      expect(items.has(TS)).toBe(true);

      // Read 8 days later — past the 7-day ttl.
      const eightDaysLater = markTime + 8 * 24 * 60 * 60 * 1000;
      const laterReader = new DynamoLoopDispatchTracker(port, { now: () => eightDaysLater });
      expect(await laterReader.isDispatched(TS)).toBe(false);
      expect(await laterReader.getDispatched(TS)).toBeNull();
    });

    it('an item still within the ttl reads as dispatched', async () => {
      const { port } = fakeDynamo();
      const markTime = 1_700_000_000_000;
      const tracker = new DynamoLoopDispatchTracker(port, { now: () => markTime });
      await tracker.markDispatched(TS, ['page-a']);

      const oneDayLater = markTime + 24 * 60 * 60 * 1000;
      const laterReader = new DynamoLoopDispatchTracker(port, { now: () => oneDayLater });
      expect(await laterReader.isDispatched(TS)).toBe(true);
    });

    it('an item with no stored ttl never expires by the guard (forward-compat)', async () => {
      const { port, items } = fakeDynamo();
      // Simulate a legacy row written without a ttl attribute.
      items.set(TS, { messageTs: TS, pageIds: JSON.stringify(['page-a']), dispatchedAt: new Date(0).toISOString() });
      const tracker = new DynamoLoopDispatchTracker(port, { now: () => 9_999_999_999_999 });
      expect(await tracker.isDispatched(TS)).toBe(true);
    });
  });

  describe('malformed stored data is tolerated', () => {
    it('getDispatched returns empty pageIds when the stored JSON is corrupt', async () => {
      const { port, items } = fakeDynamo();
      items.set(TS, { messageTs: TS, pageIds: 'not-json{', dispatchedAt: new Date().toISOString() });
      const tracker = new DynamoLoopDispatchTracker(port);
      const entry = await tracker.getDispatched(TS);
      expect(entry).not.toBeNull();
      expect(entry!.pageIds).toEqual([]);
    });
  });

  describe('TTL constant', () => {
    it('TTL_MS is 7 days in milliseconds', () => {
      expect(TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });
});

// ---------------------------------------------------------------------------
// Module-level singleton — the production call sites use these. They must
// degrade to in-memory when DynamoDB throws (AC #4) and never propagate.
// ---------------------------------------------------------------------------

describe('loopDispatchTracker module singleton', () => {
  afterEach(() => {
    _resetForTesting();
    jest.restoreAllMocks();
  });

  it('uses the injected fake tracker and persists across the singleton API', async () => {
    const { port } = fakeDynamo();
    _resetForTesting(port);

    expect(await singletonIsDispatched(TS)).toBe(false);
    await singletonMarkDispatched(TS, ['page-a']);
    expect(await singletonIsDispatched(TS)).toBe(true);
    expect((await singletonGetDispatched(TS))!.pageIds).toEqual(['page-a']);
  });

  // AC #4 — DynamoDB failure is non-fatal: degrade to in-memory, do not throw.
  describe('AC#4: DynamoDB failure is non-fatal', () => {
    it('markDispatched does not throw and isDispatched falls back to in-memory when the port throws', async () => {
      const throwingPort: DynamoPort = {
        putItem: jest.fn().mockRejectedValue(new Error('dynamo down')),
        getItem: jest.fn().mockRejectedValue(new Error('dynamo down')),
        query: jest.fn().mockRejectedValue(new Error('dynamo down')),
      };
      _resetForTesting(throwingPort);
      jest.spyOn(console, 'error').mockImplementation(() => undefined);

      // Must NOT throw — degrade silently to the in-memory fallback Map.
      await expect(singletonMarkDispatched(TS, ['page-a'])).resolves.toBeUndefined();
      // The fallback still dedupes within the process.
      expect(await singletonIsDispatched(TS)).toBe(true);
      // A different ts the fallback never saw is not dispatched.
      expect(await singletonIsDispatched(TS2)).toBe(false);
    });

    it('isDispatched returns false (not a thrown error) for an unseen ts when the port throws', async () => {
      const throwingPort: DynamoPort = {
        putItem: jest.fn().mockRejectedValue(new Error('dynamo down')),
        getItem: jest.fn().mockRejectedValue(new Error('dynamo down')),
        query: jest.fn().mockRejectedValue(new Error('dynamo down')),
      };
      _resetForTesting(throwingPort);
      jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(singletonIsDispatched(TS)).resolves.toBe(false);
    });
  });
});
