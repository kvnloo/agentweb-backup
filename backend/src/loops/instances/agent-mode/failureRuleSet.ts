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
import { EVT_TOOL_FAILED, EVT_TOOL_INVOKED } from './eventTypes';

export interface AgentFailureProposalPayload {
  toolName: string;
  failures: number;
  invocations: number;
  failureRate: number;
  topErrorClass: string;
  directive: string;
}

export interface AgentFailureRuleSetOptions {
  /** Minimum absolute failures for a tool before a fix is proposed. Default 3 —
   * below this it's noise, not a pattern. */
  minFailures?: number;
  /** Minimum failure rate (failures / invocations) before proposing. Default
   * 0.2 — a tool failing 20%+ of the time is broken enough to act on. */
  minFailureRate?: number;
}

interface ToolStats {
  toolName: string;
  invocations: number;
  failures: number;
  errorClasses: Map<string, number>;
}

export class AgentFailureRuleSet
  implements RuleSet<NormalizedEvent, AgentFailureProposalPayload>
{
  private readonly minFailures: number;
  private readonly minFailureRate: number;

  constructor(options: AgentFailureRuleSetOptions = {}) {
    this.minFailures = options.minFailures ?? 3;
    this.minFailureRate = options.minFailureRate ?? 0.2;
  }

  async evaluate(
    events: NormalizedEvent[],
    _window: TimeWindow,
  ): Promise<MutationProposal<AgentFailureProposalPayload>[]> {
    const byTool = new Map<string, ToolStats>();

    for (const e of events) {
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

    const proposals: MutationProposal<AgentFailureProposalPayload>[] = [];
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

    // Worst failure rate first — the orchestrator caps proposals per cycle, so
    // the highest-signal fixes survive the cap.
    proposals.sort((a, b) => b.payload.failureRate - a.payload.failureRate);
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
