/**
 * ENG-2113 (PR B): the per-call liveness check for a run funded by a subscription
 * connection. The bridge awaits it last before the executor, so a revoke, a disconnect,
 * a new host epoch or the feature being switched off is seen at the next call even when
 * the revoke was handled by another process.
 *
 * Returns false only for a definite "no longer valid". A failed read throws, which the
 * bridge answers with a retryable refusal without closing the run: a database blip must
 * not end a user's session.
 */

import type { RunToolTokenClaims } from "./runToolToken";
import type { LlmConnectionRecord } from "./llmConnectionDb";
import { getFundingFlags, isClaudeSubscriptionEnabledForFresh, FUNDING_ALLOW_ALL } from "./fundingFlags";

export interface BridgeLivenessDeps {
  getConnection(connectionId: string): Promise<LlmConnectionRecord | null>;
  now?: () => number;
}

export function createSubscriptionIsLive(deps: BridgeLivenessDeps) {
  const now = deps.now ?? Date.now;
  return async function isLive(run: RunToolTokenClaims, kind: { write: boolean }): Promise<boolean> {
    // A run that is not funded by a connection has nothing to check here.
    if (!run.connectionId) return true;
    const record = await deps.getConnection(run.connectionId);
    if (!record) return false;
    if (record.ownerUserId !== run.userId) return false;
    if (record.kind !== "claude_subscription" || record.status !== "active" || record.revokedAt) return false;
    if (record.subNeedsReconnect === true) return false;
    if (run.epoch !== undefined && record.subHostEpoch !== run.epoch) return false;
    if (record.subRefreshExpiresAtMs !== undefined && !(Number.isFinite(record.subRefreshExpiresAtMs) && record.subRefreshExpiresAtMs > now())) {
      return false;
    }
    if (kind.write) {
      // No cache and no last-good fallback: a write is only allowed on an answer read just now.
      return await isClaudeSubscriptionEnabledForFresh(run.userId);
    }
    const flags = await getFundingFlags();
    if (flags.killSwitch || !flags.claudeSubscription.enabled) return false;
    return run.userId !== FUNDING_ALLOW_ALL && flags.claudeSubscription.allowUserIds.includes(run.userId);
  };
}
