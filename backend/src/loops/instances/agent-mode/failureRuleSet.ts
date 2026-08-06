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
  /**
   * The decision-layer class this tool's failures cluster into (ENG-820).
   * Recorded on every agent_tool_failed event and previously ignored by this
   * policy, which is why 35% of dispatches were not handler bugs.
   */
  failureType: string;
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
  failureTypes: Map<string, number>;
  /**
   * A representative error message PER failure class. Keyed by class on purpose
   * (ENG-820 review): a tool with mixed classes would otherwise quote whichever
   * message arrived first, so a `config` directive could cite a `bug` message
   * and send the operator to reconnect an account over a TypeError.
   */
  messagesByType: Map<string, string>;
  /**
   * Error classes counted PER failure class. `errorClasses` above stays global
   * for the unclassified fallback, but the directive must cite an error class
   * from the same cohort it is advising on — otherwise a config-dominant tool
   * reports the error class of its handful of bug failures, and the operator
   * is told to reconnect an account on the evidence of a TypeError.
   */
  errorClassesByType: Map<string, Map<string, number>>;
}

/**
 * Failure classes that are NOT a handler defect, so they must never be dispatched
 * as "investigate the handler" (ENG-820).
 *   by_design            — the tool worked as intended (policy block, empty result)
 *   model_uninstalled_tool — the model called a tool it does not have; registry/prompt
 * Both were measured at 23 of 217 failures in the Jul 28 – Aug 1 window.
 */
const NON_DISPATCHABLE_FAILURE_TYPES = new Set(['by_design', 'model_uninstalled_tool']);

/**
 * Directive per failure class. The whole defect was appending one sentence —
 * "Investigate the handler + propose a robustness fix" — to every cluster
 * regardless of what the system already knew about it.
 */
function directiveFor(
  failureType: string,
  toolName: string,
  topErrorClass: string,
  failures: number,
  denom: number,
  sampleMessage: string,
  minFailureRate: number,
): string {
  const pct = `${Math.round((failures / (denom || 1)) * 100)}%`;
  const sample = sampleMessage ? ` Representative failure: "${sampleMessage.slice(0, 160)}".` : '';
  if (failureType === 'config') {
    // Not a code change. Someone has to reconnect an account, grant a scope, or
    // top up a balance — and they need to know which.
    return (
      `NOT a handler bug — "${toolName}" failed ${failures}/${denom} (${pct}) with configuration/credential errors.` +
      `${sample} Resolve the account itself: reconnect or re-authorise the connected account, grant the missing ` +
      `scope, or top up the depleted balance for "${toolName}". No code change is expected; if the account is ` +
      `healthy and this persists, reclassify it.`
    );
  }
  if (failureType === 'schema_reject') {
    // The handler is fine; the declared contract and what the model sends disagree.
    return (
      `Contract mismatch, not a handler defect — "${toolName}" rejected ${failures}/${denom} (${pct}) of calls at ` +
      `validation.${sample} Compare the declared JSON schema against what the handler actually accepts and make ` +
      `them agree, then add a regression test for the argument shape the model is really sending.`
    );
  }
  return (
    `Investigate why agent-mode tool "${toolName}" is throwing ${topErrorClass} ` +
    `at a ${pct} rate.${sample} Reproduce with a failing case, harden the ` +
    `handler (input validation, retries/backoff, or clearer error surfaced to the model), and ` +
    `add a regression test. Target: drive the tool success rate back above ` +
    `${((1 - minFailureRate) * 100).toFixed(0)}%.`
  );
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
        failureTypes: new Map<string, number>(),
        messagesByType: new Map<string, string>(),
        errorClassesByType: new Map<string, Map<string, number>>(),
      };
      if (e.eventType === EVT_TOOL_INVOKED) {
        stats.invocations++;
      } else {
        stats.failures++;
        const ec = strDim(e.dimensions?.errorClass) ?? 'UnknownError';
        stats.errorClasses.set(ec, (stats.errorClasses.get(ec) ?? 0) + 1);
        const ft = strDim(e.dimensions?.failureType) || '';
        if (ft) stats.failureTypes.set(ft, (stats.failureTypes.get(ft) ?? 0) + 1);
        const em = strDim(e.dimensions?.errorMessage) || '';
        // Store under this event's OWN class, so the directive can quote a
        // message that actually belongs to the class it is advising on.
        if (em && !stats.messagesByType.has(ft)) stats.messagesByType.set(ft, em);
        const perType = stats.errorClassesByType.get(ft) ?? new Map<string, number>();
        perType.set(ec, (perType.get(ec) ?? 0) + 1);
        stats.errorClassesByType.set(ft, perType);
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
      // ENG-820: exclude non-actionable FAILURES, not the tools that have them.
      //
      // Dropping a tool because its dominant class is non-dispatchable would
      // hide a recurring `bug` cohort behind a larger `by_design` one — the
      // exact opposite of this issue's intent, which is to remove noise without
      // losing signal. So the tool is judged on its actionable failures alone.
      const actionableTypes = new Map<string, number>();
      let excludedNonActionable = 0;
      for (const [ft, n] of stats.failureTypes) {
        if (NON_DISPATCHABLE_FAILURE_TYPES.has(ft)) excludedNonActionable += n;
        else actionableTypes.set(ft, n);
      }
      // Failures with no recorded class (pre-backfill) are actionable: failing
      // the other way would hide real bugs.
      const classified = Array.from(stats.failureTypes.values()).reduce((a, b) => a + b, 0);
      const unclassified = Math.max(0, stats.failures - classified);
      const actionableFailures =
        Array.from(actionableTypes.values()).reduce((a, b) => a + b, 0) + unclassified;

      if (actionableFailures === 0) continue;

      // Denominator is invocations; when only failures were recorded (no
      // matching invoked events in window), treat the actionable failures as
      // the denominator so a fully-broken tool still trips the rate gate.
      const denom = stats.invocations > 0 ? stats.invocations : actionableFailures;
      const failureRate = denom > 0 ? actionableFailures / denom : 0;

      if (actionableFailures < this.minFailures) continue;
      if (failureRate < this.minFailureRate) continue;

      const failureType = actionableTypes.size > 0 ? dominantKey(actionableTypes) : '';
      const handlerBug = failureType !== 'config' && failureType !== 'schema_reject';
      // Cite an error class from the SAME cohort as the chosen failure class.
      // Falls back to the global aggregate only when the class has none of its
      // own (i.e. unclassified failures), where global IS the right cohort.
      const cohort = stats.errorClassesByType.get(failureType);
      const topErrorClass = cohort && cohort.size > 0
        ? dominantKey(cohort)
        : dominantKey(stats.errorClasses);
      proposals.push({
        proposalId: asMutationId(`agent-mode:tool-failure:${stats.toolName}`),
        sourceRuleId: `tool-failure:${stats.toolName}`,
        hypothesis:
          `Tool \`${stats.toolName}\` failed ${actionableFailures}/${denom} times ` +
          `(${(failureRate * 100).toFixed(0)}%) this window, dominated by ${topErrorClass}` +
          `${failureType ? ` [${failureType}]` : ''}` +
          `${excludedNonActionable > 0 ? ` (+${excludedNonActionable} non-actionable excluded)` : ''}. ` +
          (handlerBug
            ? `Investigate the handler + propose a robustness fix.`
            : failureType === 'config'
              ? `Configuration/credential issue — resolve the account, not the code.`
              : `Declared schema and handler disagree — fix the contract.`),
        kind: 'code_change',
        payload: {
          toolName: stats.toolName,
          failures: actionableFailures,
          invocations: stats.invocations,
          failureRate,
          topErrorClass,
          failureType,
          directive: directiveFor(
            failureType,
            stats.toolName,
            topErrorClass,
            actionableFailures,
            denom,
            stats.messagesByType.get(failureType) ?? '',
            this.minFailureRate,
          ),
        },
        triggeringStats: {
          toolName: stats.toolName,
          failures: actionableFailures,
          excludedNonActionable,
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
    // ENG-820: rank by failure COUNT, not rate. Impact is volume x rate, and
    // ranking by rate alone hid the single largest source of failures in the
    // window (save_memory, 33 failures at 33%) behind a tool with 6 failures at
    // 100%. Rate remains the admission gate above; it is no longer the order.
    proposals.sort((a, b) => {
      const countA = 'failures' in a.payload ? a.payload.failures : Infinity;
      const countB = 'failures' in b.payload ? b.payload.failures : Infinity;
      if (countA !== countB) return countB - countA;
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
