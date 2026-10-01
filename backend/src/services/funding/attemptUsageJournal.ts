/**
 * ENG-1816 F1 — AttemptUsageJournal: the seventh contract, forced by two facts
 * discovered after the original six-contract skeleton was designed.
 *
 * 1. `AW-SpendProjection` now has a live production writer (PR #3003) that folds
 *    every `lifecycle: "settled"` spend event into that subject's `settledMicroUsd`,
 *    with no funding dimension anywhere in the event. A customer-funded call that
 *    wrote a settled spend event through the existing rails would be folded into the
 *    customer's own AgentWeb cap the moment ENG-1250's enforcement flag goes global.
 *    So `recordLlmUsage`'s customer branch must touch NO existing rail at all.
 * 2. The ticket still requires per-attempt L/C, funding source/principal/connection/
 *    epoch, requested-vs-actual model/backend, and settlement state for EVERY
 *    attempt (AC11) — none of the existing rails (`AW-UsageRecords`, `AW-SpendEvents`)
 *    can hold that: every reader of `AW-UsageRecords` sums its cost as AgentWeb spend,
 *    and it is a daily aggregate with no per-attempt identity.
 *
 * F1 ships the port and its type only, bound to a no-op. The type mirrors the Attempt
 * record already specified for the `AW-AgentRuntimeState` data-plane request
 * (`run#<runId>` / `attempt#<ordinal>`), so A3 does not end up building a second,
 * competing shape when it binds the real implementation.
 */

import type { FundingRoute } from "./runFunding";

export interface AttemptUsage {
  runId: string;
  ordinal: number;
  candidate?: string;
  fundingSource: FundingRoute;
  fundingPrincipalId: string;
  connectionId?: string;
  credentialEpoch?: number;
  requestedModel: string;
  actualModel?: string;
  requestedBackend: string;
  actualBackend?: string;
  provider?: string;
  startedAt: string;
  endedAt?: string;
  outcome: "succeeded" | "failed" | "aborted";
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  /** List-equivalent model cost (L). */
  listEquivalentMicroUsd?: number;
  /**
   * Estimated incremental customer-provider cost (C) — a point or an interval. Must
   * NEVER default to 0: "unknown" and "zero" are different answers, and conflating
   * them is exactly what the value-reporting rules exist to prevent (never call a
   * subscription-funded route "free"; show zero only when included usage is actually
   * observed available, not merely absent from this record).
   */
  customerEstimateMicroUsd?: number;
  costProvenance?: string;
  priceVersion?: string;
  /**
   * The provider's own entitlement/limit readout for this attempt (e.g. Claude Code's
   * `rate_limit_event` — `unifiedWindows` utilization + `resetsAt`). Declared here so
   * B4 has a place to put it without bolting it on sideways later.
   */
  entitlementObs?: unknown;
  settlementState: "pending" | "settled" | "voided";
  /** Set only when AgentWeb paid (A > 0) — links back to the AW-SpendEvents row. */
  spendEventId?: string;
}

export interface AttemptUsageJournal {
  record(attempt: AttemptUsage): Promise<void>;
}

/**
 * F1's bound implementation. The `AW-AgentRuntimeState` Attempt table does not exist
 * yet (data-plane approval pending) — A3 replaces this with the real writer once it
 * does. A no-op here is correct, not a placeholder gap: F1's `route` is always
 * `agentweb`, so nothing should ever reach this journal in F1's own tests except the
 * synthetic negative-test attempt.
 */
class NoopAttemptUsageJournal implements AttemptUsageJournal {
  async record(): Promise<void> {
    // Intentionally empty. See class doc comment.
  }
}

let boundJournal: AttemptUsageJournal = new NoopAttemptUsageJournal();

export function getAttemptUsageJournal(): AttemptUsageJournal {
  return boundJournal;
}

/** A3 calls this once, at module load, to bind the real DynamoDB-backed journal. */
export function bindAttemptUsageJournal(journal: AttemptUsageJournal): void {
  boundJournal = journal;
}

/** Test hook: restore the no-op binding between test cases. */
export function __resetAttemptUsageJournalForTests(): void {
  boundJournal = new NoopAttemptUsageJournal();
}
