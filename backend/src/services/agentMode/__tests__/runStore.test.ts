/**
 * runStore — durable run records + idempotency submit-locks + incident dedupe
 * on the AW-AgentRuns DynamoDB table (ENG-40, ENG-147, ENG-145, ENG-146).
 *
 * Tested against a DynamoDB DocumentClient fake (no network). The fake
 * implements the aws-sdk v2 `.promise()` call shape and enforces
 * `attribute_not_exists(pk)` conditional puts the way DynamoDB does.
 */

// agentModeAlerts pulls in chatbotService/emailService — mock it out entirely.
jest.mock('../../../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));

import {
  createRunRecord,
  markRunTerminal,
  claimIdempotency,
  releaseIdempotency,
  claimIncident,
  interactiveIdempotencyKey,
  scheduledIdempotencyKey,
  isRunStoreEnabled,
  IDEM_TTL_INTERACTIVE_S,
  IDEM_TTL_SCHEDULED_S,
  __setDocumentClientForTests,
} from '../runStore';
import { sendAgentModeOncallAlert } from '../../../utils/agentModeAlerts';

/** Conditional-put-aware in-memory DocumentClient fake. */
class DdbFake {
  items = new Map<string, any>();
  failNext: { op: string; error: any } | null = null;
  calls: Array<{ op: string; params: any }> = [];

  private maybeFail(op: string) {
    if (this.failNext && this.failNext.op === op) {
      const err = this.failNext.error;
      this.failNext = null;
      throw err;
    }
  }

  put = (params: any) => ({
    promise: async () => {
      this.calls.push({ op: 'put', params });
      this.maybeFail('put');
      if (
        params.ConditionExpression === 'attribute_not_exists(pk)' &&
        this.items.has(params.Item.pk)
      ) {
        const err: any = new Error('The conditional request failed');
        err.code = 'ConditionalCheckFailedException';
        throw err;
      }
      this.items.set(params.Item.pk, params.Item);
      return {};
    },
  });

  get = (params: any) => ({
    promise: async () => {
      this.calls.push({ op: 'get', params });
      this.maybeFail('get');
      return { Item: this.items.get(params.Key.pk) };
    },
  });

  update = (params: any) => ({
    promise: async () => {
      this.calls.push({ op: 'update', params });
      this.maybeFail('update');
      const item = this.items.get(params.Key.pk) || { pk: params.Key.pk };
      // Only supports the SET expression shape runStore uses.
      for (const [placeholder, value] of Object.entries(params.ExpressionAttributeValues || {})) {
        const name = placeholder.replace(':', '');
        const attrName = params.ExpressionAttributeNames?.[`#${name}`] || name;
        item[attrName] = value;
      }
      this.items.set(params.Key.pk, item);
      return {};
    },
  });

  delete = (params: any) => ({
    promise: async () => {
      this.calls.push({ op: 'delete', params });
      this.maybeFail('delete');
      this.items.delete(params.Key.pk);
      return {};
    },
  });
}

describe('runStore', () => {
  let fake: DdbFake;

  beforeEach(() => {
    fake = new DdbFake();
    __setDocumentClientForTests(fake as any);
    jest.clearAllMocks();
  });

  afterEach(() => {
    __setDocumentClientForTests(null);
    delete process.env.AGENT_RUN_STORE;
  });

  describe('isRunStoreEnabled', () => {
    it('is OFF when the env flag is absent (config-gated feature, no fallback)', () => {
      delete process.env.AGENT_RUN_STORE;
      expect(isRunStoreEnabled()).toBe(false);
    });

    it('is ON only when AGENT_RUN_STORE === "true"', () => {
      process.env.AGENT_RUN_STORE = 'true';
      expect(isRunStoreEnabled()).toBe(true);
      process.env.AGENT_RUN_STORE = 'false';
      expect(isRunStoreEnabled()).toBe(false);
    });
  });

  describe('createRunRecord', () => {
    it('writes a run#<runId> item with status=running, startedAt and a 30d ttl', async () => {
      const before = Math.floor(Date.now() / 1000);
      await createRunRecord({
        runId: 'r1',
        kind: 'interactive',
        sessionId: 's1',
        userId: 'u1',
      });
      const item = fake.items.get('run#r1');
      expect(item).toBeDefined();
      expect(item.status).toBe('running');
      expect(item.kind).toBe('interactive');
      expect(item.sessionId).toBe('s1');
      expect(item.userId).toBe('u1');
      expect(typeof item.startedAt).toBe('string');
      expect(item.ttl).toBeGreaterThanOrEqual(before + 30 * 24 * 3600 - 5);
    });

    it('includes scheduleId for scheduled runs', async () => {
      await createRunRecord({
        runId: 'r2',
        kind: 'scheduled',
        sessionId: '',
        userId: 'u1',
        scheduleId: 'sched-1',
      });
      expect(fake.items.get('run#r2').scheduleId).toBe('sched-1');
    });

    it('propagates a DynamoDB failure loudly (run-record creation is core state — NO silent fallback)', async () => {
      fake.failNext = { op: 'put', error: new Error('ddb down') };
      await expect(
        createRunRecord({ runId: 'r3', kind: 'interactive', sessionId: 's', userId: 'u' })
      ).rejects.toThrow('ddb down');
    });
  });

  describe('claimIdempotency', () => {
    it('first claim wins and records the runId', async () => {
      const res = await claimIdempotency('k1', 'run-a', IDEM_TTL_INTERACTIVE_S);
      expect(res).toEqual({ claimed: true });
      expect(fake.items.get('idem#k1').runId).toBe('run-a');
      expect(fake.items.get('idem#k1').ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('second claim for the same key loses and returns the in-flight runId', async () => {
      await claimIdempotency('k1', 'run-a', IDEM_TTL_INTERACTIVE_S);
      const res = await claimIdempotency('k1', 'run-b', IDEM_TTL_INTERACTIVE_S);
      expect(res.claimed).toBe(false);
      expect((res as any).inFlightRunId).toBe('run-a');
    });

    it('propagates unexpected DynamoDB errors (not conditional failures)', async () => {
      fake.failNext = { op: 'put', error: new Error('throttled') };
      await expect(claimIdempotency('k2', 'run-a', 600)).rejects.toThrow('throttled');
    });
  });

  describe('releaseIdempotency', () => {
    it('deletes the idem item so an identical resubmit after completion is accepted', async () => {
      await claimIdempotency('k1', 'run-a', IDEM_TTL_INTERACTIVE_S);
      await releaseIdempotency('k1');
      const res = await claimIdempotency('k1', 'run-b', IDEM_TTL_INTERACTIVE_S);
      expect(res).toEqual({ claimed: true });
    });

    it('is best-effort: a delete failure is swallowed (item expires via ttl), never thrown', async () => {
      await claimIdempotency('k1', 'run-a', IDEM_TTL_INTERACTIVE_S);
      fake.failNext = { op: 'delete', error: new Error('ddb down') };
      await expect(releaseIdempotency('k1')).resolves.toBeUndefined();
    });
  });

  describe('markRunTerminal', () => {
    it('sets terminal status, finishReason and ledgerSummary on the run record', async () => {
      await createRunRecord({ runId: 'r1', kind: 'interactive', sessionId: 's1', userId: 'u1' });
      await markRunTerminal('r1', 'completed', {
        finishReason: 'ok',
        ledgerSummary: { invoked: 3, succeeded: 2, failed: 1 },
      });
      const item = fake.items.get('run#r1');
      expect(item.status).toBe('completed');
      expect(item.finishReason).toBe('ok');
      expect(item.ledgerSummary).toEqual({ invoked: 3, succeeded: 2, failed: 1 });
      expect(typeof item.finishedAt).toBe('string');
    });

    it('retries once on failure, then succeeds without alerting', async () => {
      await createRunRecord({ runId: 'r1', kind: 'interactive', sessionId: 's1', userId: 'u1' });
      fake.failNext = { op: 'update', error: new Error('blip') };
      await markRunTerminal('r1', 'interrupted');
      expect(fake.items.get('run#r1').status).toBe('interrupted');
      expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
    });

    it('after retry also fails, fires ONE deduped oncall alert and does not throw (terminal update cannot retro-fail a delivered chat)', async () => {
      await createRunRecord({ runId: 'r1', kind: 'interactive', sessionId: 's1', userId: 'u1' });
      const failingFake = new DdbFake();
      failingFake.update = (() => ({
        promise: async () => {
          throw new Error('ddb down hard');
        },
      })) as any;
      __setDocumentClientForTests(failingFake as any);
      await expect(markRunTerminal('r1', 'failed')).resolves.toBeUndefined();
      expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
      const args = (sendAgentModeOncallAlert as jest.Mock).mock.calls[0][0];
      expect(args.dedupeKey).toBeTruthy();
    });
  });

  describe('claimIncident', () => {
    it('first claim per runId returns true; second returns false (one issue per run)', async () => {
      expect(await claimIncident('run-1')).toBe(true);
      expect(await claimIncident('run-1')).toBe(false);
    });

    it('different runIds claim independently', async () => {
      expect(await claimIncident('run-1')).toBe(true);
      expect(await claimIncident('run-2')).toBe(true);
    });

    it('propagates unexpected DynamoDB errors so the caller\'s best-effort wrapper logs them', async () => {
      fake.failNext = { op: 'put', error: new Error('ddb down') };
      await expect(claimIncident('run-3')).rejects.toThrow('ddb down');
    });
  });

  describe('idempotency keys', () => {
    it('interactive key is a stable sha256 of sessionId+userMessage+llmModel', () => {
      const a = interactiveIdempotencyKey('s1', 'hello', 'claude');
      const b = interactiveIdempotencyKey('s1', 'hello', 'claude');
      const c = interactiveIdempotencyKey('s1', 'hello!', 'claude');
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).toMatch(/^[a-f0-9]{64}$/);
    });

    it('scheduled key combines scheduleId and fireTime', () => {
      const a = scheduledIdempotencyKey('sched-1', '2026-07-01T00:00:00Z');
      const b = scheduledIdempotencyKey('sched-1', '2026-07-01T01:00:00Z');
      expect(a).not.toBe(b);
    });

    it('ttl constants: 10 min interactive, 24h scheduled', () => {
      expect(IDEM_TTL_INTERACTIVE_S).toBe(600);
      expect(IDEM_TTL_SCHEDULED_S).toBe(24 * 3600);
    });
  });
});
