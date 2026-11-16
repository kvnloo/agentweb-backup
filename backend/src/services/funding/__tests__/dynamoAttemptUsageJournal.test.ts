/**
 * ENG-2106 (A3): the attempt journal's store. Run against the executing in-memory
 * DynamoDB (it applies conditions and index queries for real), plus small stubs for the
 * failure and paging cases it cannot produce.
 */
import { InMemoryDynamo } from '../../../__tests__/helpers/inMemoryDynamo';
import type { AttemptUsage } from '../attemptUsageJournal';
import {
  ATTEMPT_USAGE_CONNECTION_INDEX,
  ATTEMPT_USAGE_PRINCIPAL_INDEX,
  ATTEMPT_USAGE_RETENTION_DAYS,
  ATTEMPT_USAGE_RUN_INDEX,
  ATTEMPT_USAGE_TABLE,
  AttemptUsageWriteError,
  DynamoAttemptUsageJournal,
} from '../dynamoAttemptUsageJournal';

const NOW = new Date('2026-10-13T08:00:00.000Z');

function attempt(overrides: Partial<AttemptUsage> = {}): AttemptUsage {
  return {
    attemptId: 'gen-1',
    runId: 'run-1',
    userId: 'member-1',
    billingUserId: 'owner-1',
    fundingSource: 'api_key',
    fundingPrincipalId: 'owner-1',
    connectionId: 'conn-1',
    requestedModel: 'gpt-4.1',
    actualModel: 'gpt-4.1',
    requestedBackend: 'emma_raw',
    provider: 'openai',
    startedAt: '2026-10-13T08:00:00.000Z',
    endedAt: '2026-10-13T08:00:00.000Z',
    outcome: 'succeeded',
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    settlementState: 'settled',
    ...overrides,
  };
}

function setup() {
  const dynamo = new InMemoryDynamo({
    [ATTEMPT_USAGE_TABLE]: {
      hash: 'attemptId',
      indexes: {
        [ATTEMPT_USAGE_RUN_INDEX]: { hash: 'runId', range: 'startedAt' },
        [ATTEMPT_USAGE_CONNECTION_INDEX]: { hash: 'connectionId', range: 'startedAt' },
        [ATTEMPT_USAGE_PRINCIPAL_INDEX]: { hash: 'fundingPrincipalId', range: 'startedAt' },
      },
    },
  });
  const Client = dynamo.documentClient;
  const sleep = jest.fn(async () => undefined);
  const journal = new DynamoAttemptUsageJournal(new Client() as any, sleep, () => NOW);
  return { dynamo, journal, sleep, rows: () => dynamo.items(ATTEMPT_USAGE_TABLE) };
}

async function collect<T>(it: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('DynamoAttemptUsageJournal', () => {
  describe('writing', () => {
    it('stores the attempt as one row with a 400-day expiry and the time it was recorded', async () => {
      const { journal, rows } = setup();
      await journal.record(attempt());

      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        attemptId: 'gen-1',
        runId: 'run-1',
        userId: 'member-1',
        fundingPrincipalId: 'owner-1',
        connectionId: 'conn-1',
        settlementState: 'settled',
        recordedAt: NOW.toISOString(),
        ttl: Math.floor(NOW.getTime() / 1000) + ATTEMPT_USAGE_RETENTION_DAYS * 86_400,
      });
    });

    it('leaves unknown costs absent rather than writing zero', async () => {
      const { journal, rows } = setup();
      await journal.record(attempt());
      const row = rows()[0];
      for (const key of ['listEquivalentMicroUsd', 'customerEstimateMicroUsd', 'priceVersion', 'costProvenance', 'entitlementObs']) {
        expect(row).not.toHaveProperty(key);
      }
    });

    it('records a duplicate of the same attempt once, and keeps the first row untouched', async () => {
      const { journal, rows } = setup();
      await journal.record(attempt({ usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } }));
      await expect(
        journal.record(attempt({ usage: { inputTokens: 999, outputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0 } })),
      ).resolves.toBeUndefined();
      expect(rows()).toHaveLength(1);
      expect(rows()[0].usage.inputTokens).toBe(100);
    });

    it('keeps an entitlement readout that is small and replaces one that is not', async () => {
      const { journal, rows } = setup();
      await journal.record(attempt({ attemptId: 'a', entitlementObs: { five_hour: { utilization: 0.4 } } }));
      await journal.record(attempt({ attemptId: 'b', entitlementObs: { blob: 'x'.repeat(40_000) } }));
      const byId = Object.fromEntries(rows().map((r) => [r.attemptId, r]));
      expect(byId.a.entitlementObs).toEqual({ five_hour: { utilization: 0.4 } });
      expect(byId.b.entitlementObs).toEqual({ truncated: true });
    });

    it.each([
      ['no attempt id', { attemptId: '' }],
      ['no run', { runId: '' }],
      ['no paying account', { fundingPrincipalId: '' }],
      ['no start time', { startedAt: '' }],
    ])('refuses an attempt with %s and writes nothing', async (_label, bad) => {
      const { journal, rows } = setup();
      await expect(journal.record(attempt(bad as Partial<AttemptUsage>))).rejects.toMatchObject({
        name: 'AttemptUsageWriteError',
        code: 'invalid_attempt',
      });
      expect(rows()).toHaveLength(0);
    });
  });

  describe('failures', () => {
    function stubbed(errors: Array<{ code: string } | null>) {
      let n = 0;
      const put = jest.fn(() => ({
        promise: async () => {
          const e = errors[Math.min(n++, errors.length - 1)];
          if (e) throw Object.assign(new Error(`secret request details ${e.code}`), e);
          return {};
        },
      }));
      const sleep = jest.fn(async () => undefined);
      return { put, sleep, journal: new DynamoAttemptUsageJournal({ put, query: jest.fn() } as any, sleep, () => NOW) };
    }

    it('retries a throttled write with a short backoff and then succeeds', async () => {
      const { journal, put, sleep } = stubbed([{ code: 'ThrottlingException' }, { code: 'ProvisionedThroughputExceededException' }, null]);
      await expect(journal.record(attempt())).resolves.toBeUndefined();
      expect(put).toHaveBeenCalledTimes(3);
      expect((sleep.mock.calls as number[][]).map((c) => c[0])).toEqual([50, 200]);
    });

    it('gives up after the retries and throws an error carrying the attempt id and code only', async () => {
      const { journal, put } = stubbed([{ code: 'ThrottlingException' }]);
      const err = await journal.record(attempt({ attemptId: 'gen-9' })).catch((e) => e);
      expect(put).toHaveBeenCalledTimes(3);
      expect(err).toBeInstanceOf(AttemptUsageWriteError);
      expect(err).toMatchObject({ attemptId: 'gen-9', code: 'ThrottlingException' });
      expect(String(err.message)).not.toContain('secret request details');
    });

    it('does not retry a failure that retrying cannot fix', async () => {
      const { journal, put, sleep } = stubbed([{ code: 'ValidationException' }]);
      await expect(journal.record(attempt())).rejects.toMatchObject({ code: 'ValidationException' });
      expect(put).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('treats a duplicate reported while a retry was in flight as success', async () => {
      const { journal, put } = stubbed([{ code: 'ThrottlingException' }, { code: 'ConditionalCheckFailedException' }]);
      await expect(journal.record(attempt())).resolves.toBeUndefined();
      expect(put).toHaveBeenCalledTimes(2);
    });
  });

  describe('replaying attempts', () => {
    async function seeded() {
      const ctx = setup();
      await ctx.journal.record(attempt({ attemptId: 'c', startedAt: '2026-10-13T08:00:03.000Z' }));
      await ctx.journal.record(attempt({ attemptId: 'a', startedAt: '2026-10-13T08:00:01.000Z' }));
      await ctx.journal.record(attempt({ attemptId: 'b', startedAt: '2026-10-13T08:00:02.000Z', connectionId: 'conn-2' }));
      await ctx.journal.record(attempt({ attemptId: 'd', startedAt: '2026-10-13T08:00:04.000Z', runId: 'run-2', fundingPrincipalId: 'owner-2', connectionId: undefined }));
      return ctx;
    }

    it('returns a connection\'s attempts in time order, without the storage-only fields', async () => {
      const { journal } = await seeded();
      const out = await collect(journal.iterateAttempts({ connectionId: 'conn-1' }));
      expect(out.map((a) => a.attemptId)).toEqual(['a', 'c']);
      expect(out[0]).not.toHaveProperty('ttl');
      expect(out[0]).not.toHaveProperty('recordedAt');
    });

    it('omits attempts with no connection from the connection index, but not from the run or customer views', async () => {
      const { journal } = await seeded();
      expect((await collect(journal.iterateAttempts({ connectionId: 'conn-1' }))).map((a) => a.attemptId)).not.toContain('d');
      expect((await collect(journal.iterateAttempts({ runId: 'run-2' }))).map((a) => a.attemptId)).toEqual(['d']);
      expect((await collect(journal.iterateAttempts({ fundingPrincipalId: 'owner-2' }))).map((a) => a.attemptId)).toEqual(['d']);
    });

    it('returns a customer\'s attempts across all their connections', async () => {
      const { journal } = await seeded();
      expect((await collect(journal.iterateAttempts({ fundingPrincipalId: 'owner-1' }))).map((a) => a.attemptId)).toEqual(['a', 'b', 'c']);
    });

    it('limits the replay to a time range, inclusive at both ends', async () => {
      const { journal } = await seeded();
      const out = await collect(
        journal.iterateAttempts({ fundingPrincipalId: 'owner-1' }, { from: '2026-10-13T08:00:02.000Z', to: '2026-10-13T08:00:03.000Z' }),
      );
      expect(out.map((a) => a.attemptId)).toEqual(['b', 'c']);
    });

    it('follows pagination until the index is exhausted', async () => {
      const pages = [
        { Items: [{ ...attempt({ attemptId: 'p1' }), ttl: 1, recordedAt: 'x' }], LastEvaluatedKey: { attemptId: 'p1' } },
        { Items: [{ ...attempt({ attemptId: 'p2' }), ttl: 1, recordedAt: 'x' }] },
      ];
      const query = jest.fn((_p?: any) => ({ promise: async () => pages.shift() }));
      const journal = new DynamoAttemptUsageJournal({ put: jest.fn(), query } as any, async () => undefined, () => NOW);
      const out = await collect(journal.iterateAttempts({ runId: 'run-1' }));
      expect(out.map((a) => a.attemptId)).toEqual(['p1', 'p2']);
      expect(query).toHaveBeenCalledTimes(2);
      expect((query.mock.calls[1] as any[])[0].ExclusiveStartKey).toEqual({ attemptId: 'p1' });
    });
  });
});
