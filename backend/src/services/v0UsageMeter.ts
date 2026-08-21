import { AsyncLocalStorage } from 'async_hooks';
import { recordVendorUsage } from './usageRecorderService';
import { computeAllocatedCost } from '../utils/vendorRateCard';

const actingUserStore = new AsyncLocalStorage<{ actingUserId: string }>();

/** Preserve the request actor while v0Service continues to use the page owner for access. */
export function withV0ActingUser<T>(actingUserId: string, work: () => Promise<T>): Promise<T> {
  return actingUserStore.run({ actingUserId }, work);
}

export interface V0UsageAttemptContext {
  actingUserId?: string;
  ownerUserId: string;
  operation: 'generate' | 'correction' | 'iterate';
  sessionId?: string;
}

/** Run one billable v0 SDK attempt and record it even when the request rejects. */
export async function runMeteredV0Attempt<T>(
  context: V0UsageAttemptContext,
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } finally {
    // The SDK does not expose whether a transport failure happened before or
    // after v0 accepted work. Recording each SDK invocation is the only
    // fail-safe accounting boundary: retries become separate billable attempts.
    try {
      const userId = context.actingUserId || actingUserStore.getStore()?.actingUserId || context.ownerUserId;
      void recordVendorUsage({
        userId,
        billingUserId: context.ownerUserId,
        provider: 'v0',
        operation: context.operation,
        feature: 'landing_page_generation',
        unit: 'generation',
        quantity: 1,
        costUsd: computeAllocatedCost('v0', 'landing_page_generation', 1),
        costSource: 'allocated',
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      });
    } catch (error) {
      // Metering is observational and must never replace the vendor result/error.
      console.error('[V0 SERVICE] Failed to prepare v0 usage record:', error);
    }
  }
}
