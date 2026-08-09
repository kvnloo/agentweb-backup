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
  updateJobPayload,
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

    it('dead-letters (failed) once attempts reach the default max', async () => {
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { id: 'calendly_webhook_invitee-123', attempts: 4 } }),
      });

      await markJobFailed('calendly_webhook', 'invitee-123', new Error('still down'));

      const updateCall = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(updateCall.ExpressionAttributeValues[':status']).toBe('failed');
      expect(updateCall.ExpressionAttributeValues[':attempts']).toBe(5);
    });

    // Greptile P1 on #2291 (sixth pass): this used to hardcode the global MAX_ATTEMPTS
    // regardless of the source's own registered override — processClaimedJob (the
    // poller-claimed path) already looked this up correctly, but markJobFailed (the
    // inline/claimImmediately path, the common case for a fresh webhook delivery)
    // didn't, silently undoing calendly_webhook's own maxAttempts: 15 override
    // (registered specifically to outlast claimLeadStepOnce's 5-minute staleness
    // window) for every inline-processed job.
    it('respects a source\'s own registered maxAttempts override instead of the global default', async () => {
      registerProcessor('test_source_custom_max_inline', jest.fn(), { maxAttempts: 15 });
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { id: 'test_source_custom_max_inline_abc', attempts: 4 } }),
      });

      // attempts 4 -> 5: would dead-letter under the global default (5), but this
      // source's own override (15) means it should still be re-queued as 'pending'.
      await markJobFailed('test_source_custom_max_inline', 'abc', new Error('still down'));

      const updateCall = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(updateCall.ExpressionAttributeValues[':status']).toBe('pending');
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

  // Greptile P1 on #2291 (round 20): a processor may discover, mid-attempt, that
  // part of its own input has changed in a way future retries need — Calendly's
  // cleanup-retry job refreshes an OAuth token Calendly may rotate on every use.
  // If a maxAttempts: Infinity job (calendly_webhook_cleanup) can never persist
  // that rotation, every future retry keeps refreshing with the same
  // now-invalid pre-rotation token forever — not just a wasted attempt, an
  // infinite loop that can never make progress.
  describe('updateJobPayload', () => {
    it('overwrites the stored payload for the given job', async () => {
      await updateJobPayload('calendly_webhook_cleanup', 'https://api.calendly.com/webhook_subscriptions/AAAA', {
        webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA',
        refreshToken: 'rotated-refresh-token',
      });

      const updateCall = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(updateCall.Key.id).toBe('calendly_webhook_cleanup_https://api.calendly.com/webhook_subscriptions/AAAA');
      expect(updateCall.UpdateExpression).toContain('SET payload = :payload');
      expect(JSON.parse(updateCall.ExpressionAttributeValues[':payload'])).toEqual({
        webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA',
        refreshToken: 'rotated-refresh-token',
      });
    });

    // Greptile P1 on #2291 (round 21): the first version had no retry at all —
    // every sibling write in this file (markJobComplete, markJobFailed, the
    // heartbeat beat) retries once before giving up, and this one didn't,
    // purely an oversight this closes.
    it('retries once and succeeds when the first write transiently fails', async () => {
      mockDocumentClientMethods.update
        .mockReturnValueOnce({ promise: jest.fn().mockRejectedValue(new Error('throttled')) })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });

      await expect(updateJobPayload('calendly_webhook_cleanup', 'id-1', { any: 'payload' })).resolves.toBe(true);

      expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(2);
    });

    // Greptile P1 on #2291 (third pass): this used to resolve to void — a caller with
    // no other durable store to fall back to (connectedAccounts.ts persisting a
    // rotated Calendly refresh token) had no way to know this best-effort write also
    // failed. Now resolves false so the caller can react.
    //
    // Greptile P1 on #2291 (fourth pass): bumped from a single retry (2 attempts) to
    // a 3-attempt backoff, matching recordOrphanedCalendlyWebhook's pattern for the
    // same rotated-token scenario.
    it('does not throw, but resolves false, when the write fails on all 3 backoff attempts, and logs loudly', async () => {
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('down')),
      });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(updateJobPayload('calendly_webhook_cleanup', 'id-1', { any: 'payload' })).resolves.toBe(false);

      expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(3);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('updateJobPayload failed'), expect.anything());

      errorSpy.mockRestore();
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

    it('marks a job "failed" once it reaches the default MAX_ATTEMPTS (5)', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('still down'));
      registerProcessor('test_source_maxattempts_default', handler);

      mockDocumentClientMethods.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [{ id: 'test_source_maxattempts_default_abc', source: 'test_source_maxattempts_default', status: 'pending', payload: '{}', attempts: 4, updatedAt: '2026-01-01T00:00:00.000Z' }],
          }),
        })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Items: [] }) });

      await pollAndProcessOnce();

      const failCall = mockDocumentClientMethods.update.mock.calls.find((c: any) => c[0].ExpressionAttributeValues?.[':lastError'] === 'still down');
      expect(failCall![0].ExpressionAttributeValues[':status']).toBe('failed');
      expect(failCall![0].ExpressionAttributeValues[':attempts']).toBe(5);
    });

    // ENG-992: a job hitting its terminal 'failed' state used to blend into the same
    // "Processing failed" line every retry logs — nothing distinguished the terminal
    // attempt from the ones before it, so a permanently-stuck job had no way to
    // surface itself. This confirms the distinct, greppable escalation log fires
    // exactly on the terminal attempt, not on any earlier one.
    it('logs a distinct terminal-failure line only on the attempt that exhausts maxAttempts', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const handler = jest.fn().mockRejectedValue(new Error('still down'));
      registerProcessor('test_source_terminal_log', handler);

      mockDocumentClientMethods.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [{ id: 'test_source_terminal_log_abc', source: 'test_source_terminal_log', status: 'pending', payload: '{}', attempts: 3, updatedAt: '2026-01-01T00:00:00.000Z' }],
          }),
        })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Items: [] }) });

      await pollAndProcessOnce(); // attempts 3 -> 4, still 'pending', not terminal yet

      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('TERMINAL FAILURE'));

      mockDocumentClientMethods.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [{ id: 'test_source_terminal_log_abc', source: 'test_source_terminal_log', status: 'pending', payload: '{}', attempts: 4, updatedAt: '2026-01-01T00:00:00.000Z' }],
          }),
        })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Items: [] }) });

      await pollAndProcessOnce(); // attempts 4 -> 5, hits default MAX_ATTEMPTS, terminal

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('TERMINAL FAILURE: job test_source_terminal_log_abc'));

      errorSpy.mockRestore();
    });

    // Greptile P1 on #2291 (round 9, issue 3): calendly_webhook_cleanup jobs are
    // enqueued to durably record a webhook_id BEFORE the local account (the only
    // other copy of that identifier) is deleted on disconnect. Once the job hits
    // MAX_ATTEMPTS it goes 'failed' and the poller's claimable query never selects
    // 'failed' jobs again — permanently stranding a webhook Calendly will never let
    // a later reconnect re-create ("Already Exists"), since the identifier that
    // could clean it up now lives nowhere else. A source registered with
    // maxAttempts: Infinity keeps retrying indefinitely instead of ever going
    // terminally inert, so a Calendly outage or a token that's refreshable again
    // later still eventually resolves the orphan.
    it('never marks a job "failed" when its processor is registered with maxAttempts: Infinity, no matter how many attempts it has', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('calendly still down'));
      registerProcessor('calendly_webhook_cleanup_test', handler, { maxAttempts: Infinity });

      mockDocumentClientMethods.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [{ id: 'calendly_webhook_cleanup_test_abc', source: 'calendly_webhook_cleanup_test', status: 'pending', payload: '{}', attempts: 999, updatedAt: '2026-01-01T00:00:00.000Z' }],
          }),
        })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Items: [] }) });

      await pollAndProcessOnce();

      const failCall = mockDocumentClientMethods.update.mock.calls.find((c: any) => c[0].ExpressionAttributeValues?.[':lastError'] === 'calendly still down');
      expect(failCall).toBeDefined();
      expect(failCall![0].ExpressionAttributeValues[':status']).toBe('pending');
      expect(failCall![0].ExpressionAttributeValues[':attempts']).toBe(1000);
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

    // Greptile P1 on #2291 (round 25): this failure-state write used to be a bare
    // `.promise().catch(() => {})` with zero retry — every sibling write in this
    // file (markJobComplete, markJobFailed, updateJobPayload) already retries once
    // before giving up.
    it('retries once and succeeds when the poller-claimed failure-state write transiently fails', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('boom'));
      registerProcessor('test_source_retry_failure_write', handler);

      mockDocumentClientMethods.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [{ id: 'test_source_retry_failure_write_abc', source: 'test_source_retry_failure_write', status: 'pending', payload: '{}', attempts: 0, updatedAt: '2026-01-01T00:00:00.000Z' }],
          }),
        })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Items: [] }) });

      mockDocumentClientMethods.update
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) }) // claim conditional update
        .mockReturnValueOnce({ promise: jest.fn().mockRejectedValue(new Error('throttled')) }) // failure-state write attempt 1
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) }); // failure-state write retry succeeds

      await expect(pollAndProcessOnce()).resolves.toBeUndefined();

      const failCalls = mockDocumentClientMethods.update.mock.calls.filter(
        (c: any) => c[0].ExpressionAttributeValues?.[':lastError'] === 'boom',
      );
      expect(failCalls).toHaveLength(2);
      expect(failCalls[1][0].ExpressionAttributeValues[':attempts']).toBe(1);
    });

    it('does not throw, and leaves the job in "processing", when the poller-claimed failure-state write fails on both the attempt and the retry', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('boom'));
      registerProcessor('test_source_lost_failure_write', handler);

      mockDocumentClientMethods.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [{ id: 'test_source_lost_failure_write_abc', source: 'test_source_lost_failure_write', status: 'pending', payload: '{}', attempts: 0, updatedAt: '2026-01-01T00:00:00.000Z' }],
          }),
        })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Items: [] }) });

      mockDocumentClientMethods.update
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) }) // claim conditional update
        .mockReturnValueOnce({ promise: jest.fn().mockRejectedValue(new Error('down')) }) // failure-state write attempt 1
        .mockReturnValueOnce({ promise: jest.fn().mockRejectedValue(new Error('still down')) }); // retry also fails

      await expect(pollAndProcessOnce()).resolves.toBeUndefined();
      expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(3);
    });
  });

  // Greptile P1 on #2291 (round 9): startHeartbeat existed but was only ever wired
  // into the inline-processing path (claimImmediately). A job the POLLER itself
  // claims (pending, or reclaimed-stale) went through processClaimedJob with no
  // heartbeat at all, so a poller-owned job that ran longer than
  // STALE_PROCESSING_MS was reclaimed and processed a second time concurrently —
  // the exact race the inline-path heartbeat was built to close, just reopened on
  // the other claim path.
  describe('processClaimedJob heartbeat', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('keeps a poller-claimed job\'s updatedAt fresh via heartbeat while its processor is still running', async () => {
      let resolveProcessor: () => void = () => {};
      const handler = jest.fn(() => new Promise<void>((resolve) => { resolveProcessor = resolve; }));
      registerProcessor('test_source_hb', handler);

      mockDocumentClientMethods.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [{ id: 'test_source_hb_abc', source: 'test_source_hb', status: 'pending', payload: '{}', attempts: 0, updatedAt: '2026-01-01T00:00:00.000Z' }],
          }),
        })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Items: [] }) });

      const pollPromise = pollAndProcessOnce();
      // Fake timers also fake setImmediate, so flush the claim's own promise
      // chain (dynamodb.update().promise()) with plain microtask hops instead.
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }

      await jest.advanceTimersByTimeAsync(15_000);

      const heartbeatCall = mockDocumentClientMethods.update.mock.calls.find(
        (c: any) => c[0].ConditionExpression === '#status = :processing' && c[0].Key?.id === 'test_source_hb_abc',
      );
      expect(heartbeatCall).toBeDefined();

      resolveProcessor();
      await pollPromise;

      const heartbeatCallsAfterCompletion = mockDocumentClientMethods.update.mock.calls.filter(
        (c: any) => c[0].ConditionExpression === '#status = :processing',
      ).length;

      await jest.advanceTimersByTimeAsync(15_000);

      const heartbeatCallsAfterAnotherTick = mockDocumentClientMethods.update.mock.calls.filter(
        (c: any) => c[0].ConditionExpression === '#status = :processing',
      ).length;
      expect(heartbeatCallsAfterAnotherTick).toBe(heartbeatCallsAfterCompletion);
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

      jest.advanceTimersByTime(15_000);
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

      jest.advanceTimersByTime(15_000);
      await Promise.resolve();
      stop();

      // No assertion needed beyond "did not throw" — reaching this line is the test.
    });

    it('retries once within the same tick when a beat transiently fails', async () => {
      mockDocumentClientMethods.update
        .mockReturnValueOnce({ promise: jest.fn().mockRejectedValue(new Error('throttled')) })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });
      const stop = startHeartbeat('calendly_webhook', 'invitee-123');

      jest.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve(); // second microtask hop for the nested retry's own .catch chain
      stop();

      expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(2);
    });

    // Greptile P1 on #2291 (fourth pass): a double-failure here used to be swallowed
    // silently — every OTHER write in this file logs loudly on double-failure, this
    // one was the one inconsistency. Doesn't change the accepted, bounded race itself
    // (claimLeadStepOnce is the actual mutex), but sustained heartbeat failures — the
    // precondition for that race — deserve to be visible, not silent.
    it('logs a warning (does not silently swallow) when a beat fails on both the attempt and the retry', async () => {
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('dynamo down')),
      });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const stop = startHeartbeat('calendly_webhook', 'invitee-123');

      jest.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
      stop();

      expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Heartbeat failed twice in a row for job calendly_webhook_invitee-123'),
        expect.anything(),
      );

      warnSpy.mockRestore();
    });
  });
});
