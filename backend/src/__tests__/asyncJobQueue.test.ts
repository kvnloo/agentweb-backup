// Unit tests for the generic async job queue (ENG-524 fast-follow).
//
// Crash-safety net for any webhook receiver's fire-and-forget processing: enqueue a
// durable row before processing, mark it complete when done. If the row was never
// marked complete (process crashed), the poller finds and retries it. enqueueJob must
// fail OPEN — any write failure, including the table not existing yet, returns
// 'unavailable' rather than throwing, so a caller can always fall back to processing
// inline exactly as it did before this queue existed.
const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  update: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDocumentClientMethods),
  },
}));

import {
  enqueueJob,
  markJobComplete,
  markJobFailed,
  registerProcessor,
  pollAndProcessOnce,
  startHeartbeat,
} from '../services/asyncJobQueue';

describe('asyncJobQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockDocumentClientMethods).forEach((method) => {
      (mockDocumentClientMethods as any)[method].mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
    });
  });

  describe('enqueueJob', () => {
    it('writes a pending row with a deterministic id and returns "enqueued" on success', async () => {
      const result = await enqueueJob('calendly_webhook', 'invitee-123', { foo: 'bar' });

      expect(result).toBe('enqueued');
      expect(mockDocumentClientMethods.put).toHaveBeenCalledTimes(1);
      const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
      expect(putCall.Item.id).toBe('calendly_webhook_invitee-123');
      expect(putCall.Item.source).toBe('calendly_webhook');
      expect(putCall.Item.status).toBe('pending');
      expect(JSON.parse(putCall.Item.payload)).toEqual({ foo: 'bar' });
      expect(putCall.ConditionExpression).toBe('attribute_not_exists(id)');
    });

    it('returns "duplicate" without throwing when the same dedupe key was already enqueued', async () => {
      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockRejectedValue({ code: 'ConditionalCheckFailedException' }),
      });

      const result = await enqueueJob('calendly_webhook', 'invitee-123', {});

      expect(result).toBe('duplicate');
    });

    it('returns "unavailable" without throwing when the table does not exist yet', async () => {
      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockRejectedValue({ code: 'ResourceNotFoundException', message: 'Table not found' }),
      });

      const result = await enqueueJob('calendly_webhook', 'invitee-123', {});

      expect(result).toBe('unavailable');
    });

    it('returns "unavailable" without throwing for any other unexpected DynamoDB error', async () => {
      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException')),
      });

      const result = await enqueueJob('calendly_webhook', 'invitee-123', {});

      expect(result).toBe('unavailable');
    });
  });

  describe('enqueueJob with claimImmediately', () => {
    // A caller that processes a job inline (same request that enqueued it) must
    // claim it as part of the SAME atomic write, not a separate follow-up call.
    // An earlier version used a second update() to claim after enqueueing, which
    // left a window — and a second independent failure mode — where the enqueue
    // could succeed but the claim update fail, leaving the row 'pending' and
    // claimable by the poller's next tick (every 30s in server.ts) while inline
    // processing was still running: duplicate CRM writes, duplicate CAPI sends.
    // Folding the claim into the enqueue's own put removes both the window and
    // that second failure mode outright.
    it('writes the row straight in as "processing" with a fresh updatedAt, in one put', async () => {
      const result = await enqueueJob('calendly_webhook', 'invitee-123', { foo: 'bar' }, { claimImmediately: true });

      expect(result).toBe('enqueued');
      expect(mockDocumentClientMethods.put).toHaveBeenCalledTimes(1);
      expect(mockDocumentClientMethods.update).not.toHaveBeenCalled();
      const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
      expect(putCall.Item.status).toBe('processing');
      expect(putCall.Item.updatedAt).toBeDefined();
    });

    it('a job enqueued with claimImmediately is not re-claimable by a poll tick that fires mid-processing', async () => {
      // Simulates the real sequence: enqueue-and-claim in one call -> poller ticks
      // while inline work is still running. The pending query legitimately returns
      // nothing (status was never 'pending'), and the stale-processing query returns
      // nothing either, because updatedAt was just written and is nowhere near the
      // 5-minute staleness threshold.
      const handler = jest.fn().mockResolvedValue(undefined);
      registerProcessor('test_source_claim_race', handler);

      mockDocumentClientMethods.query
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Items: [] }) }) // pending: none, enqueued straight as processing
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Items: [] }) }); // stale-processing: not stale yet

      await pollAndProcessOnce();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('markJobComplete / markJobFailed', () => {
    it('marks a job completed', async () => {
      await markJobComplete('calendly_webhook', 'invitee-123');

      const updateCall = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(updateCall.Key.id).toBe('calendly_webhook_invitee-123');
      expect(updateCall.ExpressionAttributeValues[':completed']).toBe('completed');
    });

    it('retries once and succeeds when the first completion write transiently fails', async () => {
      mockDocumentClientMethods.update
        .mockReturnValueOnce({ promise: jest.fn().mockRejectedValue(new Error('throttled')) })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });

      await expect(markJobComplete('calendly_webhook', 'invitee-123')).resolves.toBeUndefined();

      expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(2);
    });

    it('does not throw when markJobComplete fails on both the attempt and the retry (best-effort)', async () => {
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('down')),
      });

      await expect(markJobComplete('calendly_webhook', 'invitee-123')).resolves.toBeUndefined();
      expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(2);
    });

    it('re-queues (pending) after a failed attempt below the max attempt count', async () => {
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { id: 'calendly_webhook_invitee-123', attempts: 1 } }),
      });

      await markJobFailed('calendly_webhook', 'invitee-123', new Error('CAPI down'));

      const updateCall = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(updateCall.ExpressionAttributeValues[':status']).toBe('pending');
      expect(updateCall.ExpressionAttributeValues[':attempts']).toBe(2);
      expect(updateCall.ExpressionAttributeValues[':lastError']).toBe('CAPI down');
    });

    it('dead-letters (failed) once attempts reach the max', async () => {
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { id: 'calendly_webhook_invitee-123', attempts: 4 } }),
      });

      await markJobFailed('calendly_webhook', 'invitee-123', new Error('still down'));

      const updateCall = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(updateCall.ExpressionAttributeValues[':status']).toBe('failed');
      expect(updateCall.ExpressionAttributeValues[':attempts']).toBe(5);
    });

    it('retries once and succeeds when the first failed-state write transiently fails', async () => {
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { id: 'calendly_webhook_invitee-123', attempts: 1 } }),
      });
      mockDocumentClientMethods.update
        .mockReturnValueOnce({ promise: jest.fn().mockRejectedValue(new Error('throttled')) })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });

      await expect(markJobFailed('calendly_webhook', 'invitee-123', new Error('CAPI down'))).resolves.toBeUndefined();

      expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(2);
      // Both attempts read the SAME pre-retry attempts count (the failed first
      // write never landed), so the retry increments from the same base rather
      // than double-counting.
      expect(mockDocumentClientMethods.update.mock.calls[1][0].ExpressionAttributeValues[':attempts']).toBe(2);
    });

    it('does not throw when markJobFailed fails on both the attempt and the retry (best-effort)', async () => {
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { id: 'calendly_webhook_invitee-123', attempts: 1 } }),
      });
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('down')),
      });

      await expect(markJobFailed('calendly_webhook', 'invitee-123', new Error('boom'))).resolves.toBeUndefined();
      expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(2);
    });
  });

  describe('pollAndProcessOnce', () => {
    it('claims a pending job, dispatches it to the registered processor for its source, and marks it complete', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      registerProcessor('test_source_1', handler);

      mockDocumentClientMethods.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [{ id: 'test_source_1_abc', source: 'test_source_1', status: 'pending', payload: JSON.stringify({ x: 1 }), attempts: 0, updatedAt: '2026-01-01T00:00:00.000Z' }],
          }),
        })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Items: [] }) }); // stale-processing query

      await pollAndProcessOnce();

      expect(handler).toHaveBeenCalledWith({ x: 1 });
      const updateCalls = mockDocumentClientMethods.update.mock.calls;
      const completeCall = updateCalls.find((c: any) => c[0].ExpressionAttributeValues[':completed'] === 'completed');
      expect(completeCall).toBeDefined();
      expect(completeCall![0].Key.id).toBe('test_source_1_abc');
    });

    it('does not process a job whose claim conditional-update loses the race to another poller', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      registerProcessor('test_source_2', handler);

      mockDocumentClientMethods.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [{ id: 'test_source_2_abc', source: 'test_source_2', status: 'pending', payload: '{}', attempts: 0, updatedAt: '2026-01-01T00:00:00.000Z' }],
          }),
        })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Items: [] }) });
      // The claim update itself fails as if another instance already claimed it.
      mockDocumentClientMethods.update.mockReturnValueOnce({
        promise: jest.fn().mockRejectedValue({ code: 'ConditionalCheckFailedException' }),
      });

      await pollAndProcessOnce();

      expect(handler).not.toHaveBeenCalled();
    });

    it('re-claims a stale "processing" job (crashed mid-attempt) via the second query leg', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      registerProcessor('test_source_3', handler);

      mockDocumentClientMethods.query
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Items: [] }) }) // pending query: none
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [{ id: 'test_source_3_abc', source: 'test_source_3', status: 'processing', payload: '{}', attempts: 1, updatedAt: '2020-01-01T00:00:00.000Z' }],
          }),
        });

      await pollAndProcessOnce();

      expect(handler).toHaveBeenCalled();
    });

    it('increments attempts and re-queues as pending when the processor itself throws', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('boom'));
      registerProcessor('test_source_4', handler);

      mockDocumentClientMethods.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [{ id: 'test_source_4_abc', source: 'test_source_4', status: 'pending', payload: '{}', attempts: 0, updatedAt: '2026-01-01T00:00:00.000Z' }],
          }),
        })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Items: [] }) });

      await pollAndProcessOnce();

      const updateCalls = mockDocumentClientMethods.update.mock.calls;
      const failCall = updateCalls.find((c: any) => c[0].ExpressionAttributeValues?.[':lastError'] === 'boom');
      expect(failCall).toBeDefined();
      expect(failCall![0].ExpressionAttributeValues[':status']).toBe('pending');
      expect(failCall![0].ExpressionAttributeValues[':attempts']).toBe(1);
    });

    it('does not throw when no processor is registered for a job\'s source', async () => {
      mockDocumentClientMethods.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [{ id: 'unregistered_source_abc', source: 'unregistered_source', status: 'pending', payload: '{}', attempts: 0, updatedAt: '2026-01-01T00:00:00.000Z' }],
          }),
        })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Items: [] }) });

      await expect(pollAndProcessOnce()).resolves.toBeUndefined();
    });

    it('does not throw when the table is unreachable (nothing provisioned yet)', async () => {
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockRejectedValue({ code: 'ResourceNotFoundException' }),
      });

      await expect(pollAndProcessOnce()).resolves.toBeUndefined();
    });
  });

  // Greptile P1 on #2291: inline processing slower than the poller's stale
  // threshold used to look identical, to the poller's stale-reclamation query,
  // as a claim whose owning instance crashed — the poller would claim and
  // re-run the SAME job concurrently with the still-running original. A
  // periodic heartbeat that refreshes updatedAt while genuinely still
  // processing closes that window.
  describe('startHeartbeat', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('refreshes updatedAt on the claimed job at each interval tick', async () => {
      const stop = startHeartbeat('calendly_webhook', 'invitee-123');

      jest.advanceTimersByTime(60_000);
      await Promise.resolve(); // let the fire-and-forget update's promise chain settle

      expect(mockDocumentClientMethods.update).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { id: 'calendly_webhook_invitee-123' },
          ConditionExpression: '#status = :processing',
        }),
      );

      stop();
    });

    it('stops ticking once the returned stop function is called', async () => {
      const stop = startHeartbeat('calendly_webhook', 'invitee-123');
      stop();

      jest.advanceTimersByTime(5 * 60_000);
      await Promise.resolve();

      expect(mockDocumentClientMethods.update).not.toHaveBeenCalled();
    });

    it('is a safe no-op (never throws) when the conditional update fails — e.g. the job already moved past processing', async () => {
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockRejectedValue({ code: 'ConditionalCheckFailedException' }),
      });
      const stop = startHeartbeat('calendly_webhook', 'invitee-123');

      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      stop();

      // No assertion needed beyond "did not throw" — reaching this line is the test.
    });
  });
});
