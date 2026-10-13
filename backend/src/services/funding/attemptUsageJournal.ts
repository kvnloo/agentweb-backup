/**
 * ENG-1816 — AttemptUsageJournal: where customer-funded usage is recorded.
 *
 * Why it exists. `AW-SpendProjection` has a live production writer (PR #3003) that folds
 * every `lifecycle: "settled"` spend event into that subject's `settledMicroUsd`, with no
 * funding dimension anywhere in the event. A customer-funded call that wrote a settled
 * spend event through the existing rails would be folded into the customer's own AgentWeb
 * cap the moment ENG-1250's enforcement flag goes global. So a customer-funded call
 * touches NO existing rail, and the per-attempt facts the ticket requires (L/C, funding
 * source and principal, connection, entitlement, settlement) live here instead.
 *
 * The journal is an append-only event log (decision-attempt-usage-journal):
 *  - one immutable row per recorded attempt, written once, at the end;
 *  - a correction is a NEW row that points at the one it corrects, never an edit;
 *  - every derived number (a connection's monthly usage, a run's total, the
 *    reconciliation with the ledger) is a projection that can be rebuilt by replaying
 *    the rows, which is why the store has a reader that iterates them.
 * A row is one recorded attempt: a single LLM call for API-key funding, a whole turn for
 * subscription funding (B4 writes its own rows; a `claude -p` turn never passes through
 * `callLLM`).
 */

import type { FundingRoute } from "./runFunding";

export interface AttemptUsage {
  /**
   * Unique id of this attempt and the idempotency key of its row. The provider's
   * generation id when there is one, so a retried write cannot double-record; the writer
   * supplies its own otherwise.
   */
  attemptId: string;
  /** The session/run this attempt belongs to. */
  runId: string;
  /** Who ran it. For an org-shared key this is a member, not the key's owner. */
  userId: string;
  billingUserId: string;
  fundingSource: FundingRoute;
  /** The account whose provider credential paid: the connection's owner. */
  fundingPrincipalId: string;
  connectionId?: string;
  credentialEpoch?: number;
  candidate?: string;
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
  /**
   * List-equivalent model cost (L), in micro-USD. ABSENT, never 0, when the model has no
   * price: "unknown" and "zero" are different answers, and conflating them is exactly
   * what the value-reporting rules exist to prevent. `priceVersion` is set only when L
   * was computed from the price book, so a row with neither is an unpriced model.
   */
  listEquivalentMicroUsd?: number;
  /**
   * What the customer's own provider account was charged (C), in micro-USD, when the
   * provider reports it (OpenRouter's upstream cost on a BYOK response). ABSENT, never 0,
   * when not reported. `costProvenance` says where it came from.
   */
  customerEstimateMicroUsd?: number;
  costProvenance?: string;
  priceVersion?: string;
  /**
   * The provider's own entitlement/limit readout for this attempt (e.g. Claude Code's
   * `rate_limit_event` — `unifiedWindows` utilization + `resetsAt`), filled by B4.
   */
  entitlementObs?: unknown;
  /** Customer-funded attempts are written once, at the end, so there is no "pending". */
  settlementState: "settled" | "voided";
  /** Set on a correction row: the attempt this one corrects. */
  correctsAttemptId?: string;
  /** Set only when AgentWeb paid (A > 0) — links back to the AW-SpendEvents row. */
  spendEventId?: string;
}

export interface AttemptUsageJournal {
  record(attempt: AttemptUsage): Promise<void>;
}

/** Test stand-in: records nothing. Production never uses it. */
class NoopAttemptUsageJournal implements AttemptUsageJournal {
  async record(): Promise<void> {
    // Intentionally empty.
  }
}

let boundJournal: AttemptUsageJournal | null = null;
let defaultJournal: AttemptUsageJournal | null = null;

/**
 * The journal to write to. The real DynamoDB journal is the default and is built on
 * first use, inside this module, NOT bound from `server.ts`: chats run in a forked worker
 * process where `server.ts` boot code never runs (the same class of bug as ENG-1912), so
 * a startup bind would leave the process where `callLLM` runs on a no-op and silently
 * drop every customer-funded record. Required lazily so merely importing this file does
 * not load the AWS SDK graph.
 */
export function getAttemptUsageJournal(): AttemptUsageJournal {
  if (boundJournal) return boundJournal;
  if (!defaultJournal) {
    const { DynamoAttemptUsageJournal } = require("./dynamoAttemptUsageJournal") as typeof import("./dynamoAttemptUsageJournal");
    defaultJournal = new DynamoAttemptUsageJournal();
  }
  return defaultJournal;
}

/** Replace the journal. For tests; production uses the default. */
export function bindAttemptUsageJournal(journal: AttemptUsageJournal): void {
  boundJournal = journal;
}

/** Test hook: back to a no-op between test cases. */
export function __resetAttemptUsageJournalForTests(): void {
  boundJournal = new NoopAttemptUsageJournal();
  defaultJournal = null;
}
