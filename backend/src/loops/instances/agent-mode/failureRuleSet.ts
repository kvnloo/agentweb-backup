/**
 * AgentFailureRuleSet — the agent-mode loop's Policy layer (Layer 2).
 *
 * The funnel DSL filters by a fixed dimension value but can't GROUP BY an
 * open-ended dimension, and "which tool is repeatedly failing" requires exactly
 * that: cluster failures by toolName, then propose a fix for any tool whose
 * failures cross both a count and a rate threshold. So this is a small custom
 * RuleSet rather than a DSL rule list.
 *
 * Output proposal == the "repeated pattern + exact proposed fix" the audit asks
 * for: a `code_change` proposal carrying the failing tool, its failure count /
 * rate, and the dominant error class as the signature. The SpecOutputTool turns
 * it into a cloud-dev task; the gate routes it for approval; attribution later
 * grades whether the shipped fix actually lifted that tool's success rate. The
 * CooldownRuleSet wrapper stops the loop re-proposing a fix that's still in
 * flight or already failed.
 *
 * One proposal per failing tool, sorted worst-failure-rate first so the cap in
 * the orchestrator keeps the highest-signal fixes.
 */

import type {
  MutationProposal,
  NormalizedEvent,
  RuleSet,
  TimeWindow,
} from '../../core/types';
import { asMutationId } from '../../core/types';
import { EVT_RUN_VERDICT, EVT_TOOL_FAILED, EVT_TOOL_INVOKED } from './eventTypes';

export interface AgentFailureProposalPayload {
  toolName: string;
  failures: number;
  invocations: number;
  failureRate: number;
  topErrorClass: string;
  directive: string;
}

/**
 * Truthfulness proposal payload (ENG-143): the finalize guard's claim_mismatch
 * verdict reason clustered across the window. Distinct from
 * AgentFailureProposalPayload because these are whole-run verdicts, not
 * per-tool outcomes — agent_run_verdict carries no toolName dimension.
 */
export interface AgentClaimMismatchProposalPayload {
  occurrences: number;
  /** Up to 5 sample sessionIds for the reviewer to pull transcripts from. */
  sessionIds: string[];
  directive: string;
}

export interface AgentFailureRuleSetOptions {
  /** Minimum absolute failures for a tool before a fix is proposed. Default 3 —
   * below this it's noise, not a pattern. */
  minFailures?: number;
  /** Minimum failure rate (failures / invocations) before proposing. Default
   * 0.2 — a tool failing 20%+ of the time is broken enough to act on. */
  minFailureRate?: number;
  /** Minimum agent_run_verdict events carrying 'claim_mismatch' in the window
   * before proposing a truthfulness fix (ENG-143). Default 2 — a single
   * mismatch is reviewed inline by the guard's own visible correction; a
   * second one in the same window is a pattern worth a fix spec. */
  minClaimMismatches?: number;
}

interface ToolStats {
  toolName: string;
  invocations: number;
  failures: number;
  errorClasses: Map<string, number>;
}

export class AgentFailureRuleSet
  implements RuleSet<NormalizedEvent, AgentFailureProposalPayload | AgentClaimMismatchProposalPayload>
{
  private readonly minFailures: number;
  private readonly minFailureRate: number;
  private readonly minClaimMismatches: number;

  constructor(options: AgentFailureRuleSetOptions = {}) {
    this.minFailures = options.minFailures ?? 3;
    this.minFailureRate = options.minFailureRate ?? 0.2;
    this.minClaimMismatches = options.minClaimMismatches ?? 2;
  }

  async evaluate(
    events: NormalizedEvent[],
    _window: TimeWindow,
  ): Promise<MutationProposal<AgentFailureProposalPayload | AgentClaimMismatchProposalPayload>[]> {
    const byTool = new Map<string, ToolStats>();
    const claimMismatchSessions: string[] = [];

    for (const e of events) {
      if (e.eventType === EVT_RUN_VERDICT) {
        const reasons = strDim(e.dimensions?.reasons) ?? '';
        if (reasons.split(',').includes('claim_mismatch')) {
          claimMismatchSessions.push(strDim(e.dimensions?.sessionId) ?? String(e.subjectId));
        }
        continue;
      }
      if (e.eventType !== EVT_TOOL_INVOKED && e.eventType !== EVT_TOOL_FAILED) continue;
      const toolName = strDim(e.dimensions?.toolName);
      if (!toolName) continue; // can't attribute a fix without a tool name

      const stats = byTool.get(toolName) ?? {
        toolName,
        invocations: 0,
        failures: 0,
        errorClasses: new Map<string, number>(),
      };
      if (e.eventType === EVT_TOOL_INVOKED) {
        stats.invocations++;
      } else {
        stats.failures++;
        const ec = strDim(e.dimensions?.errorClass) ?? 'UnknownError';
        stats.errorClasses.set(ec, (stats.errorClasses.get(ec) ?? 0) + 1);
      }
      byTool.set(toolName, stats);
    }

    const proposals: MutationProposal<AgentFailureProposalPayload | AgentClaimMismatchProposalPayload>[] = [];

    if (claimMismatchSessions.length >= this.minClaimMismatches) {
      const sampleSessionIds = claimMismatchSessions.slice(0, 5);
      proposals.push({
        proposalId: asMutationId('agent-mode:claim-mismatch:truthfulness'),
        sourceRuleId: 'claim-mismatch:truthfulness',
        hypothesis:
          `The finalize guard recorded ${claimMismatchSessions.length} unresolved claim_mismatch ` +
          `verdicts this window (Emma claimed a completed action the run's tool ledger did not back, ` +
          `and the corrective turn did not resolve it). Review the flagged sessions for a systemic ` +
          `over-claiming pattern.`,
        kind: 'code_change',
        payload: {
          occurrences: claimMismatchSessions.length,
          sessionIds: sampleSessionIds,
          directive:
            `Pull the ${sampleSessionIds.length} sample session(s) [${sampleSessionIds.join(', ')}] and ` +
            `review what Emma claimed vs. what the tool ledger shows. If a claim class or tool keeps ` +
            `recurring, widen the finalize guard's lexicon/claim-class coverage or fix the underlying tool.`,
        },
        triggeringStats: {
          occurrences: claimMismatchSessions.length,
          sampleSessionIds: sampleSessionIds.join(','),
        },
      });
    }
    for (const stats of byTool.values()) {
      // Denominator is invocations; when only failures were recorded (no
      // matching invoked events in window), treat failures as the denominator
      // so a fully-broken tool still trips the rate gate.
      const denom = stats.invocations > 0 ? stats.invocations : stats.failures;
      const failureRate = denom > 0 ? stats.failures / denom : 0;

      if (stats.failures < this.minFailures) continue;
      if (failureRate < this.minFailureRate) continue;

      const topErrorClass = dominantKey(stats.errorClasses);
      proposals.push({
        proposalId: asMutationId(`agent-mode:tool-failure:${stats.toolName}`),
        sourceRuleId: `tool-failure:${stats.toolName}`,
        hypothesis:
          `Tool \`${stats.toolName}\` failed ${stats.failures}/${denom} times ` +
          `(${(failureRate * 100).toFixed(0)}%) this window, dominated by ${topErrorClass}. ` +
          `Investigate the handler + propose a robustness fix.`,
        kind: 'code_change',
        payload: {
          toolName: stats.toolName,
          failures: stats.failures,
          invocations: stats.invocations,
          failureRate,
          topErrorClass,
          directive:
            `Investigate why agent-mode tool "${stats.toolName}" is throwing ${topErrorClass} ` +
            `at a ${(failureRate * 100).toFixed(0)}% rate. Reproduce with a failing case, harden the ` +
            `handler (input validation, retries/backoff, or clearer error surfaced to the model), and ` +
            `add a regression test. Target: drive the tool success rate back above ` +
            `${((1 - this.minFailureRate) * 100).toFixed(0)}%.`,
        },
        triggeringStats: {
          toolName: stats.toolName,
          failures: stats.failures,
          invocations: stats.invocations,
          failureRatePct: Math.round(failureRate * 100),
          topErrorClass,
        },
      });
    }

    // Worst failure rate first (tool proposals only — the claim-mismatch
    // proposal has no failure rate and sorts first as the highest-signal
    // truthfulness pattern) — the orchestrator caps proposals per cycle, so
    // the highest-signal fixes survive the cap.
    proposals.sort((a, b) => {
      const rateA = 'failureRate' in a.payload ? a.payload.failureRate : Infinity;
      const rateB = 'failureRate' in b.payload ? b.payload.failureRate : Infinity;
      return rateB - rateA;
    });
    return proposals;
  }
}

function strDim(v: string | number | boolean | null | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function dominantKey(counts: Map<string, number>): string {
  let best = 'UnknownError';
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return best;
}
