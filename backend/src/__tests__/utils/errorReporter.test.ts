/**
 * Tests for errorReporter utility — UI error dedup + Notion/email reporting.
 */

// Mock notionService and emailService before importing errorReporter
jest.mock('../../services/notionService', () => ({
  createOncallItem: jest.fn(),
}));
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
import { createOncallItem } from '../../services/notionService';
import { emailService } from '../../services/emailService';
const { userDb } = require('../../services/db');

const mockCreateOncallItem = createOncallItem as jest.MockedFunction<typeof createOncallItem>;
const mockSendOncallAlert = emailService.sendOncallAlert as jest.MockedFunction<typeof emailService.sendOncallAlert>;

describe('reportUIError', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __clearDedupCacheForTests();
    mockCreateOncallItem.mockResolvedValue({ pageId: 'page-abc', notionUrl: 'https://notion.so/page-abc' });
    mockSendOncallAlert.mockResolvedValue(undefined);
  });

  describe('Notion item creation', () => {
    it('creates Notion item with Oncall + UI Error tags', async () => {
      await reportUIError({
        operation: 'test-op',
        errorMessage: 'Something broke',
        userId: 'user-1',
      });

      expect(mockCreateOncallItem).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'UI Error: test-op',
          description: 'Something broke',
          additionalTags: ['UI Error'],
        })
      );
    });

    it('includes userId and context in Notion item', async () => {
      await reportUIError({
        operation: 'schedule-manual-run',
        errorMessage: 'Run failed',
        userId: 'user-42',
        context: { 'Schedule ID': 'sched-123', 'Schedule Name': 'My Schedule' },
      });

      expect(mockCreateOncallItem).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            'User ID': 'user-42',
            'Schedule ID': 'sched-123',
            'Schedule Name': 'My Schedule',
          }),
        })
      );
    });

    it('passes notionUrl to sendOncallAlert so it sends slim email', async () => {
      await reportUIError({ operation: 'op', errorMessage: 'err' });

      expect(mockSendOncallAlert).toHaveBeenCalledWith(
        'UI Error: op',
        'err',
        expect.any(Object),
        'https://notion.so/page-abc'
      );
    });

    it('falls back to email-only when Notion creation fails', async () => {
      mockCreateOncallItem.mockRejectedValueOnce(new Error('Notion API down'));

      await reportUIError({ operation: 'failing-op', errorMessage: 'oops' });

      // Falls back: sendOncallAlert called without notionUrl
      expect(mockSendOncallAlert).toHaveBeenCalledWith(
        'UI Error: failing-op',
        'oops',
        expect.any(Object)
      );
      // notionUrl argument not passed (only 3 args)
      const call = mockSendOncallAlert.mock.calls[0];
      expect(call).toHaveLength(3);
    });
  });

  describe('Deduplication', () => {
    it('deduplicates the same error within the window (second call skipped)', async () => {
      await reportUIError({ operation: 'dedup-op', errorMessage: 'same error' });
      await reportUIError({ operation: 'dedup-op', errorMessage: 'same error' });
      expect(mockCreateOncallItem).toHaveBeenCalledTimes(1);
    });

    it('normalizes UUID in error message for fingerprinting', async () => {
      // Same error structure but different UUIDs — should dedup to same fingerprint
      await reportUIError({ operation: 'uuid-op', errorMessage: 'Session 550e8400-e29b-41d4-a716-446655440000 failed' });
      await reportUIError({ operation: 'uuid-op', errorMessage: 'Session aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee failed' });
      expect(mockCreateOncallItem).toHaveBeenCalledTimes(1);
    });

    it('does NOT dedup errors with different operations', async () => {
      await reportUIError({ operation: 'op-a', errorMessage: 'same error' });
      await reportUIError({ operation: 'op-b', errorMessage: 'same error' });
      expect(mockCreateOncallItem).toHaveBeenCalledTimes(2);
    });

    it('does NOT dedup structurally different error messages', async () => {
      await reportUIError({ operation: 'op', errorMessage: 'TypeError: cannot read x' });
      await reportUIError({ operation: 'op', errorMessage: 'ReferenceError: y is not defined' });
      expect(mockCreateOncallItem).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error boundaries', () => {
    it('does not throw when Notion fails and email also fails', async () => {
      mockCreateOncallItem.mockRejectedValue(new Error('Notion down'));
      mockSendOncallAlert.mockRejectedValue(new Error('Email down'));

      await expect(
        reportUIError({ operation: 'double-fail-op', errorMessage: 'both systems down' })
      ).resolves.not.toThrow();
    });

    it('works without optional userId or context', async () => {
      await expect(
        reportUIError({ operation: 'minimal-op', errorMessage: 'just an error' })
      ).resolves.not.toThrow();
      expect(mockCreateOncallItem).toHaveBeenCalled();
    });
  });

  describe('onboarding-tagged enrichment', () => {
    it('enriches the context with user identity, stage, step status, and recent events', async () => {
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

      const call = mockCreateOncallItem.mock.calls[0][0];
      expect(call.context).toMatchObject({
        Operation: 'onboarding:icp:llm-generation',
        'User ID': 'user-1',
        'User Email': 'maya@example.com',
        'Onboarding Stage': 'brand_submitted',
      });
      expect(call.context!['Investigate as User']).toContain('targetUserId=user-1');
      expect(call.context!['Step Status']).toContain('icp=failed');
      expect(call.context!['Step Status']).toContain('error=LLM timeout');
      expect(call.context!['Recent Events (last 20)']).toContain('goal_selected');
      expect(call.context!['Recent Events (last 20)']).toContain('brand_submitted');
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
      const call = mockCreateOncallItem.mock.calls[0][0];
      expect(call.context).not.toHaveProperty('Onboarding Stage');
      expect(call.context).not.toHaveProperty('Step Status');
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

      // Notion task still fires with the base context (no enrichment).
      const call = mockCreateOncallItem.mock.calls[0][0];
      expect(call.context).toMatchObject({
        Operation: 'onboarding:icp:status-fetch',
        'User ID': 'user-1',
      });
      expect(call.context).not.toHaveProperty('Onboarding Stage');
    });
  });

  describe('attribution enrichment', () => {
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

      const ctx = mockCreateOncallItem.mock.calls[0][0].context!;
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

      const ctx = mockCreateOncallItem.mock.calls[0][0].context!;
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

      const ctx = mockCreateOncallItem.mock.calls[0][0].context!;
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

      const ctx = mockCreateOncallItem.mock.calls[0][0].context!;
      expect(ctx).not.toHaveProperty('Attribution (last touch source)');
    });

    it('omits attribution fields entirely when user has no firstTouch / lastTouch', async () => {
      userDb.getUserById.mockResolvedValue({ userId: 'user-1' });

      await reportUIError({
        operation: 'onboarding:creativeDir:llm-generation',
        errorMessage: 'fail',
        userId: 'user-1',
      });

      const ctx = mockCreateOncallItem.mock.calls[0][0].context!;
      expect(ctx).not.toHaveProperty('Attribution (first touch UTM)');
      expect(ctx).not.toHaveProperty('Attribution (first touch referrer)');
      expect(ctx).not.toHaveProperty('Attribution (first touch landing URL)');
      expect(ctx).not.toHaveProperty('Attribution (last touch source)');
    });
  });
});
