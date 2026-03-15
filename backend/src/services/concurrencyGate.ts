/**
 * Concurrency gate — checks whether a user can start a new generation
 * based on their subscription tier's concurrent session limit.
 *
 * Fail-open: if we can't determine the answer, allow the request
 * so users aren't blocked by infrastructure issues.
 */

import { chatbotDb } from './chatbotService';
import { getMaxConcurrentSessions } from './subscriptionService';

export interface ConcurrencyGateResult {
  allowed: boolean;
  activeCount: number;
  limit: number;
  activeSessionIds: string[];
}

/**
 * Check if the user is allowed to start a new generation.
 * Returns { allowed: true } if under the limit, or
 * { allowed: false, activeSessionIds } if at/over the limit.
 *
 * Fails open on errors — never blocks a user due to infrastructure issues.
 */
export async function checkConcurrencyGate(
  userId: string
): Promise<ConcurrencyGateResult> {
  try {
    const [activeGenerations, maxConcurrent] = await Promise.all([
      chatbotDb.getActiveGenerations(userId),
      getMaxConcurrentSessions(userId),
    ]);

    if (activeGenerations.count >= maxConcurrent) {
      return {
        allowed: false,
        activeCount: activeGenerations.count,
        limit: maxConcurrent,
        activeSessionIds: activeGenerations.sessionIds,
      };
    }

    return {
      allowed: true,
      activeCount: activeGenerations.count,
      limit: maxConcurrent,
      activeSessionIds: activeGenerations.sessionIds,
    };
  } catch (error) {
    console.error('Concurrency gate check failed, failing open:', error);
    // Fail open — don't block the user if we can't check
    return {
      allowed: true,
      activeCount: 0,
      limit: 1,
      activeSessionIds: [],
    };
  }
}
