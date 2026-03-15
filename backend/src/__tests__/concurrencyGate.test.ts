/**
 * Tests for concurrency gate enforcement and orphan recovery.
 * Part 3 of the multi-task concurrency control system.
 */

// Mock chatbotService before importing anything
jest.mock('../services/chatbotService', () => {
  const originalModule = jest.requireActual('../services/chatbotService');
  return {
    ...originalModule,
    chatbotDb: {
      ...originalModule.chatbotDb,
      updateGenerationStatus: jest.fn(),
      getActiveGenerations: jest.fn(),
      getUserSessions: jest.fn(),
      getChatSession: jest.fn(),
    },
  };
});

jest.mock('../services/subscriptionService', () => ({
  ...jest.requireActual('../services/subscriptionService'),
  getMaxConcurrentSessions: jest.fn(),
}));

import { chatbotDb, ChatSession } from '../services/chatbotService';
import { getMaxConcurrentSessions } from '../services/subscriptionService';
import { checkConcurrencyGate } from '../services/concurrencyGate';
import { recoverOrphanedSessions, ORPHAN_THRESHOLD_MS } from '../services/orphanRecovery';

const mockGetActiveGenerations = chatbotDb.getActiveGenerations as jest.Mock;
const mockGetMaxConcurrent = getMaxConcurrentSessions as jest.Mock;
const mockUpdateGenerationStatus = chatbotDb.updateGenerationStatus as jest.Mock;
const mockGetUserSessions = chatbotDb.getUserSessions as jest.Mock;

describe('Concurrency Gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('checkConcurrencyGate', () => {
    const userId = 'user-123';

    // --- FAILURE CASES ---

    it('should reject when user is at concurrency limit (Basic tier, 1 slot)', async () => {
      mockGetActiveGenerations.mockResolvedValue({
        count: 1,
        sessionIds: ['session-active-1'],
      });
      mockGetMaxConcurrent.mockResolvedValue(1);

      const result = await checkConcurrencyGate(userId);

      expect(result.allowed).toBe(false);
      expect(result.activeSessionIds).toEqual(['session-active-1']);
      expect(result.limit).toBe(1);
      expect(result.activeCount).toBe(1);
    });

    it('should reject when user exceeds concurrency limit', async () => {
      mockGetActiveGenerations.mockResolvedValue({
        count: 4,
        sessionIds: ['s1', 's2', 's3', 's4'],
      });
      mockGetMaxConcurrent.mockResolvedValue(3); // Pro tier

      const result = await checkConcurrencyGate(userId);

      expect(result.allowed).toBe(false);
      expect(result.activeCount).toBe(4);
      expect(result.limit).toBe(3);
    });

    it('should handle errors from getActiveGenerations gracefully', async () => {
      mockGetActiveGenerations.mockRejectedValue(new Error('DynamoDB timeout'));
      mockGetMaxConcurrent.mockResolvedValue(1);

      // Should allow on error (fail-open) to not block users
      const result = await checkConcurrencyGate(userId);
      expect(result.allowed).toBe(true);
    });

    // --- SUCCESS CASE ---

    it('should allow when user has available slots', async () => {
      mockGetActiveGenerations.mockResolvedValue({
        count: 1,
        sessionIds: ['session-1'],
      });
      mockGetMaxConcurrent.mockResolvedValue(3); // Pro tier, 1/3 used

      const result = await checkConcurrencyGate(userId);

      expect(result.allowed).toBe(true);
      expect(result.activeCount).toBe(1);
      expect(result.limit).toBe(3);
    });

    it('should allow when user has zero active generations', async () => {
      mockGetActiveGenerations.mockResolvedValue({
        count: 0,
        sessionIds: [],
      });
      mockGetMaxConcurrent.mockResolvedValue(1);

      const result = await checkConcurrencyGate(userId);

      expect(result.allowed).toBe(true);
      expect(result.activeCount).toBe(0);
    });
  });
});

describe('Orphan Recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- FAILURE CASES ---

  it('should reset sessions stuck in "generating" for over the threshold', async () => {
    const staleTimestamp = new Date(Date.now() - ORPHAN_THRESHOLD_MS - 60000).toISOString(); // 1hr + 1min ago
    mockGetUserSessions.mockResolvedValue({
      sessions: [
        {
          sessionId: 'orphan-1',
          userId: 'user-a',
          generationStatus: 'generating',
          generationStartedAt: staleTimestamp,
        },
      ],
    });
    mockUpdateGenerationStatus.mockResolvedValue({});

    const recovered = await recoverOrphanedSessions([
      {
        sessionId: 'orphan-1',
        userId: 'user-a',
        generationStatus: 'generating' as const,
        generationStartedAt: staleTimestamp,
      },
    ]);

    expect(recovered).toBe(1);
    expect(mockUpdateGenerationStatus).toHaveBeenCalledWith('orphan-1', 'error');
  });

  it('should recover multiple orphaned sessions', async () => {
    const staleTimestamp = new Date(Date.now() - ORPHAN_THRESHOLD_MS - 60000).toISOString();
    mockUpdateGenerationStatus.mockResolvedValue({});

    const recovered = await recoverOrphanedSessions([
      {
        sessionId: 'orphan-1',
        userId: 'user-a',
        generationStatus: 'generating' as const,
        generationStartedAt: staleTimestamp,
      },
      {
        sessionId: 'orphan-2',
        userId: 'user-b',
        generationStatus: 'generating' as const,
        generationStartedAt: staleTimestamp,
      },
    ]);

    expect(recovered).toBe(2);
    expect(mockUpdateGenerationStatus).toHaveBeenCalledTimes(2);
  });

  it('should handle updateGenerationStatus errors without crashing', async () => {
    const staleTimestamp = new Date(Date.now() - ORPHAN_THRESHOLD_MS - 60000).toISOString();
    mockUpdateGenerationStatus.mockRejectedValue(new Error('DynamoDB error'));

    const recovered = await recoverOrphanedSessions([
      {
        sessionId: 'orphan-fail',
        userId: 'user-a',
        generationStatus: 'generating' as const,
        generationStartedAt: staleTimestamp,
      },
    ]);

    // Should return 0 since recovery failed, but not throw
    expect(recovered).toBe(0);
  });

  // --- SUCCESS CASE (no orphans) ---

  it('should not reset sessions that are within the threshold', async () => {
    const recentTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago

    const recovered = await recoverOrphanedSessions([
      {
        sessionId: 'active-1',
        userId: 'user-a',
        generationStatus: 'generating' as const,
        generationStartedAt: recentTimestamp,
      },
    ]);

    expect(recovered).toBe(0);
    expect(mockUpdateGenerationStatus).not.toHaveBeenCalled();
  });

  it('should recover sessions without generationStartedAt as a safety net', async () => {
    mockUpdateGenerationStatus.mockResolvedValue({});

    const recovered = await recoverOrphanedSessions([
      {
        sessionId: 'no-timestamp',
        userId: 'user-a',
        generationStatus: 'generating' as const,
        // No generationStartedAt — treat as orphan (safety net)
      },
    ]);

    // Sessions with no startedAt and status 'generating' should be recovered as a safety net
    expect(recovered).toBe(1);
    expect(mockUpdateGenerationStatus).toHaveBeenCalledWith('no-timestamp', 'error');
  });

  it('should return 0 when given empty array', async () => {
    const recovered = await recoverOrphanedSessions([]);
    expect(recovered).toBe(0);
    expect(mockUpdateGenerationStatus).not.toHaveBeenCalled();
  });
});
