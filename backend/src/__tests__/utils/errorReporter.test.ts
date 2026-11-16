/**
 * Tests for errorReporter utility.
 *
 * As of 2026-05-07 the Notion + oncall-email side-effects were removed —
 * reportUIError now only emits a structured `console.error` log line.
 * These tests pin the new log-only contract: no Notion task creation,
 * no oncall email, dedup intact, enrichment + title prefix preserved.
 */

jest.mock('../../services/emailService', () => ({
  emailService: {
    sendOncallAlert: jest.fn(),
  },
}));
jest.mock('../../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

import { reportUIError, __clearDedupCacheForTests } from '../../utils/errorReporter';
import { emailService } from '../../services/emailService';
const { userDb } = require('../../services/db');

const mockSendOncallAlert = emailService.sendOncallAlert as jest.MockedFunction<typeof emailService.sendOncallAlert>;

function lastLogPayload(spy: jest.SpyInstance): { subject: string; errorMessage: string; context: Record<string, any> } {
  const calls = spy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const [tag, json] = calls[calls.length - 1];
  expect(tag).toBe('[uiError]');
  return JSON.parse(json as string);
}

describe('reportUIError', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    __clearDedupCacheForTests();
    logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe('no external side-effects', () => {
    it('never calls emailService.sendOncallAlert', async () => {
      await reportUIError({ operation: 'op', errorMessage: 'err', userId: 'u' });
      expect(mockSendOncallAlert).not.toHaveBeenCalled();
    });

    it('emits one structured log line per non-deduped report', async () => {
      await reportUIError({ operation: 'op', errorMessage: 'err' });
      const payload = lastLogPayload(logSpy);
      expect(payload.subject).toBe('UI Error: op');
      expect(payload.errorMessage).toBe('err');
      expect(payload.context).toMatchObject({ Operation: 'op', Error: 'err' });
    });

    it('includes userId and caller context in the log payload', async () => {
      await reportUIError({
        operation: 'schedule-manual-run',
        errorMessage: 'Run failed',
        userId: 'user-42',
        context: { 'Schedule ID': 'sched-123', 'Schedule Name': 'My Schedule' },
      });
      const payload = lastLogPayload(logSpy);
      expect(payload.context).toMatchObject({
        'User ID': 'user-42',
        'Schedule ID': 'sched-123',
        'Schedule Name': 'My Schedule',
      });
    });
  });

  describe('Deduplication', () => {
    it('deduplicates the same error within the window (second call skipped)', async () => {
      await reportUIError({ operation: 'dedup-op', errorMessage: 'same error' });
      await reportUIError({ operation: 'dedup-op', errorMessage: 'same error' });
      const uiErrorCalls = logSpy.mock.calls.filter((c) => c[0] === '[uiError]');
      expect(uiErrorCalls).toHaveLength(1);
    });

    it('normalizes UUID in error message for fingerprinting', async () => {
      await reportUIError({ operation: 'uuid-op', errorMessage: 'Session 550e8400-e29b-41d4-a716-446655440000 failed' });
      await reportUIError({ operation: 'uuid-op', errorMessage: 'Session aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee failed' });
      const uiErrorCalls = logSpy.mock.calls.filter((c) => c[0] === '[uiError]');
      expect(uiErrorCalls).toHaveLength(1);
    });

    it('does NOT dedup errors with different operations', async () => {
      await reportUIError({ operation: 'op-a', errorMessage: 'same error' });
      await reportUIError({ operation: 'op-b', errorMessage: 'same error' });
      const uiErrorCalls = logSpy.mock.calls.filter((c) => c[0] === '[uiError]');
      expect(uiErrorCalls).toHaveLength(2);
    });

    it('does NOT dedup structurally different error messages', async () => {
      await reportUIError({ operation: 'op', errorMessage: 'TypeError: cannot read x' });
      await reportUIError({ operation: 'op', errorMessage: 'ReferenceError: y is not defined' });
      const uiErrorCalls = logSpy.mock.calls.filter((c) => c[0] === '[uiError]');
      expect(uiErrorCalls).toHaveLength(2);
    });
  });

  describe('Error boundaries', () => {
    it('does not throw when called', async () => {
      await expect(
        reportUIError({ operation: 'minimal-op', errorMessage: 'just an error' })
      ).resolves.not.toThrow();
    });
  });

  describe('Title prefix', () => {
    it('uses "Onboarding Error:" subject for onboarding-prefixed operations', async () => {
      userDb.getUserById.mockResolvedValue({ userId: 'user-1', email: 'u@example.com' });
      await reportUIError({
        operation: 'onboarding:brand:submit',
        errorMessage: 'Submit failed',
        userId: 'user-1',
      });
      const payload = lastLogPayload(logSpy);
      expect(payload.subject).toBe('Onboarding Error: onboarding:brand:submit');
    });

    it('uses "UI Error:" subject for non-onboarding operations', async () => {
      await reportUIError({
        operation: 'react-error-boundary',
        errorMessage: 'Crash',
      });
      const payload = lastLogPayload(logSpy);
      expect(payload.subject).toBe('UI Error: react-error-boundary');
    });
  });

  describe('Onboarding enrichment', () => {
    it('enriches the log context with user identity, stage, step status, and recent events', async () => {
      userDb.getUserById.mockResolvedValue({
        userId: 'user-1',
        email: 'maya@example.com',
        createdAt: '2026-04-26T12:00:00.000Z',
        onboardingStage: 'brand_submitted',
        icpStatus: 'failed',
        icpStartedAt: '2026-04-27T10:00:00.000Z',
        icpError: 'LLM timeout',
        adImageStatus: 'idle',
        onboardingEvents: [
          { event: 'goal_selected', ts: '2026-04-26T12:01:00.000Z' },
          { event: 'brand_submitted', ts: '2026-04-26T12:02:30.000Z' },
        ],
      });

      await reportUIError({
        operation: 'onboarding:icp:llm-generation',
        errorMessage: 'LLM timeout',
        userId: 'user-1',
        context: { Source: 'backend', Step: 'icp' },
      });

      const ctx = lastLogPayload(logSpy).context;
      expect(ctx).toMatchObject({
        Operation: 'onboarding:icp:llm-generation',
        'User ID': 'user-1',
        'User Email': 'maya@example.com',
        'Onboarding Stage': 'brand_submitted',
      });
      expect(ctx['Investigate as User']).toContain('targetUserId=user-1');
      expect(ctx['Step Status']).toContain('icp=failed');
      expect(ctx['Step Status']).toContain('error=LLM timeout');
      expect(ctx['Recent Events (last 20)']).toContain('goal_selected');
      expect(ctx['Recent Events (last 20)']).toContain('brand_submitted');
    });

    it('does NOT enrich for non-onboarding operations', async () => {
      userDb.getUserById.mockResolvedValue({
        userId: 'user-1',
        email: 'someone@example.com',
        onboardingStage: 'goal_selected',
      });

      await reportUIError({
        operation: 'react-error-boundary',
        errorMessage: 'Crash',
        userId: 'user-1',
      });

      expect(userDb.getUserById).not.toHaveBeenCalled();
      const ctx = lastLogPayload(logSpy).context;
      expect(ctx).not.toHaveProperty('Onboarding Stage');
      expect(ctx).not.toHaveProperty('Step Status');
    });

    it('falls back gracefully when getUserById throws', async () => {
      userDb.getUserById.mockRejectedValue(new Error('DDB down'));

      await expect(
        reportUIError({
          operation: 'onboarding:icp:status-fetch',
          errorMessage: 'fetch failed',
          userId: 'user-1',
        })
      ).resolves.not.toThrow();

      const ctx = lastLogPayload(logSpy).context;
      expect(ctx).toMatchObject({
        Operation: 'onboarding:icp:status-fetch',
        'User ID': 'user-1',
      });
      expect(ctx).not.toHaveProperty('Onboarding Stage');
    });
  });

  describe('Attribution enrichment', () => {
    it('surfaces full firstTouch UTM (source/medium/campaign/content/term) as a pipe-delimited line', async () => {
      userDb.getUserById.mockResolvedValue({
        userId: 'user-1',
        firstTouch: {
          utm: {
            source: 'linkedin',
            medium: 'cpc',
            campaign: 'b2b-demo',
            content: 'creative-A',
            term: 'agentic-marketing',
          },
        },
      });

      await reportUIError({
        operation: 'onboarding:icp:llm-generation',
        errorMessage: 'LLM error',
        userId: 'user-1',
      });

      const ctx = lastLogPayload(logSpy).context;
      expect(ctx['Attribution (first touch UTM)']).toBe(
        'source=linkedin | medium=cpc | campaign=b2b-demo | content=creative-A | term=agentic-marketing',
      );
    });

    it('surfaces firstTouch referrer and landingUrl, truncating to 300 chars', async () => {
      const longUrl = 'https://example.com/' + 'x'.repeat(400);
      userDb.getUserById.mockResolvedValue({
        userId: 'user-1',
        firstTouch: {
          referrer: 'https://t.co/abc',
          landingUrl: longUrl,
        },
      });

      await reportUIError({
        operation: 'onboarding:competitor:llm-generation',
        errorMessage: 'fail',
        userId: 'user-1',
      });

      const ctx = lastLogPayload(logSpy).context;
      expect(ctx['Attribution (first touch referrer)']).toBe('https://t.co/abc');
      expect(ctx['Attribution (first touch landing URL)']).toHaveLength(300);
      expect(ctx).not.toHaveProperty('Attribution (first touch UTM)');
    });

    it('shows lastTouch source only when it differs from firstTouch source', async () => {
      userDb.getUserById.mockResolvedValue({
        userId: 'user-1',
        firstTouch: { utm: { source: 'linkedin' } },
        lastTouch: { utm: { source: 'direct' } },
      });

      await reportUIError({
        operation: 'onboarding:adImage:llm-generation',
        errorMessage: 'fail',
        userId: 'user-1',
      });

      const ctx = lastLogPayload(logSpy).context;
      expect(ctx['Attribution (last touch source)']).toBe('direct');
    });

    it('omits lastTouch source when it equals firstTouch source (avoid noise)', async () => {
      userDb.getUserById.mockResolvedValue({
        userId: 'user-1',
        firstTouch: { utm: { source: 'linkedin' } },
        lastTouch: { utm: { source: 'linkedin' } },
      });

      await reportUIError({
        operation: 'onboarding:adCopy:llm-generation',
        errorMessage: 'fail',
        userId: 'user-1',
      });

      const ctx = lastLogPayload(logSpy).context;
      expect(ctx).not.toHaveProperty('Attribution (last touch source)');
    });

    it('omits attribution fields entirely when user has no firstTouch / lastTouch', async () => {
      userDb.getUserById.mockResolvedValue({ userId: 'user-1' });

      await reportUIError({
        operation: 'onboarding:creativeDir:llm-generation',
        errorMessage: 'fail',
        userId: 'user-1',
      });

      const ctx = lastLogPayload(logSpy).context;
      expect(ctx).not.toHaveProperty('Attribution (first touch UTM)');
      expect(ctx).not.toHaveProperty('Attribution (first touch referrer)');
      expect(ctx).not.toHaveProperty('Attribution (first touch landing URL)');
      expect(ctx).not.toHaveProperty('Attribution (last touch source)');
    });
  });
});
