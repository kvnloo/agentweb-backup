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

import { reportUIError, __clearDedupCacheForTests } from '../../utils/errorReporter';
import { createOncallItem } from '../../services/notionService';
import { emailService } from '../../services/emailService';

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
});
