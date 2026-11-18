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
 * rate, and the cohort's dominant error class as the signature. The SpecOutputTool turns
 * it into a cloud-dev task; the gate routes it for approval; attribution later
 * grades whether the shipped fix actually lifted that tool's success rate. The
 * CooldownRuleSet wrapper stops the loop re-proposing a fix that's still in
 * flight or already failed.
 *
 * One proposal per actionable failure class per tool, sorted by count so the cap in
 * the orchestrator keeps the highest-signal fixes.
 */

import type {
  MutationProposal,
  NormalizedEvent,
  RuleSet,
  TimeWindow,
} from '../../core/types';
import { asMutationId } from '../../core/types';
import { redactSensitive } from '../../../mcp/client/mcpToolTelemetry';
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
  /**
   * ENG-589: up to 3 representative traces (`run <runId>` + session when known)
   * for this failure class, so a filed issue links straight to evidence.
   */
  sampleTraces?: string[];
  /**
   * ENG-3088: when each failure in this class happened (ISO, oldest first), so
   * intake can tell a window that merely still contains old failures from one
   * with a failure newer than the last thing posted on the issue. Set as a
   * non-enumerable property, so it is never serialised or stored.
   */
  failureTimes?: string[];
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
  /** Minimum failures per class per tool before a fix is proposed. Default 3 —
   * below this it's noise, not a pattern. */
  minFailures?: number;
  /** Minimum class failure rate (class failures / tool invocations). Default
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
  failureTypes: Map<string, number>;
  /** Representative message per (failure class, error class) pair. */
  messagesByType: Map<string, string>;
  errorClassesByType: Map<string, Map<string, number>>;
  /** ENG-589: up to MAX_SAMPLE_TRACES distinct trace refs per failure class. */
  tracesByType: Map<string, string[]>;
  /** ENG-3088: event time (ms) of every failure per failure class. */
  timesByType: Map<string, number[]>;
}

const MAX_SAMPLE_TRACES = 3;

/**
 * Failure classes that are NOT a handler defect, so they must never be dispatched
 * as "investigate the handler" (ENG-820).
 *   by_design            — the tool worked as intended (policy block, empty result)
 *   model_uninstalled_tool — the model called a tool it does not have; registry/prompt
 * Both were measured at 23 of 217 failures in the Jul 28 – Aug 1 window.
 */
export const NON_DISPATCHABLE_FAILURE_TYPES = new Set(['by_design', 'model_uninstalled_tool', 'not_connected']);

/**
 * ENG-2943: the never-connected precondition ("No Fathom account connected.
 * Please connect...") means the user never linked the integration. There is no
 * account to repair and no handler bug, so it must not file an oncall row.
 * Genuine auth failures on a connected account (expired/revoked token, missing
 * scope, invalid_grant) do not match and stay `config`.
 */
const NEVER_CONNECTED_RE = /\bno\s+[\w .\-/]{1,40}?\s+accounts?\s+(?:is\s+|are\s+)?connected\b/i;

/**
 * ENG-3037: the same precondition in its other wording, "<X> not connected.
 * Connect ..." / "<X> account not connected. Please connect ...". This is an
 * allow-list of the integrations whose throw site was read and fires only when
 * no connected-account row exists (googleDriveAccess, hubspotService,
 * gmailService, outlookService, attioService) — not a general "not connected"
 * pattern. Deliberately left as `config`, because a connected account can
 * produce them: LinkedIn Ads (adsApis also throws it for a row with no
 * access_token), bare "ClickUp/Foreplay not connected" (returned when a stored
 * token fails to decrypt), and any message naming one specific account.
 */
const NOT_CONNECTED_PRECONDITION_RE =
  /\bGoogle Drive not connected\. Connect Google Drive in Settings\b|\b(?:Gmail|Outlook|HubSpot|Attio) account not connected\. Please connect\b/i;

export function isNeverConnectedMessage(message: string): boolean {
  return NEVER_CONNECTED_RE.test(message) || NOT_CONNECTED_PRECONDITION_RE.test(message);
}

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
  const redactedSample = sampleMessage ? redactSensitive(sampleMessage).slice(0, 160) : '';
  const sample = redactedSample ? ` Representative failure: "${redactedSample}".` : '';
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
        failureTypes: new Map<string, number>(),
        messagesByType: new Map<string, string>(),
        errorClassesByType: new Map<string, Map<string, number>>(),
        tracesByType: new Map<string, string[]>(),
        timesByType: new Map<string, number[]>(),
      };
      if (e.eventType === EVT_TOOL_INVOKED) {
        stats.invocations++;
      } else {
        const ec = strDim(e.dimensions?.errorClass) ?? 'UnknownError';
        const em = strDim(e.dimensions?.errorMessage) || '';
        const ft = isNeverConnectedMessage(em) ? 'not_connected' : strDim(e.dimensions?.failureType) || '';
        stats.failureTypes.set(ft, (stats.failureTypes.get(ft) ?? 0) + 1);
        // Store under this event's OWN (failure class, error class) pair, so
        // the directive can quote a message that actually belongs to both the
        // failure class AND the error class it is advising on.
        const mk = msgKey(ft, ec);
        if (em && !stats.messagesByType.has(mk)) stats.messagesByType.set(mk, em);
        const perType = stats.errorClassesByType.get(ft) ?? new Map<string, number>();
        perType.set(ec, (perType.get(ec) ?? 0) + 1);
        stats.errorClassesByType.set(ft, perType);
        const traces = stats.tracesByType.get(ft) ?? [];
        const sid = strDim(e.dimensions?.sessionId);
        const ref = `run ${String(e.subjectId)}${sid ? ` (session ${sid})` : ''}`;
        if (traces.length < MAX_SAMPLE_TRACES && !traces.includes(ref)) traces.push(ref);
        stats.tracesByType.set(ft, traces);
        const at = e.ts instanceof Date ? e.ts.getTime() : NaN;
        if (Number.isFinite(at)) {
          const times = stats.timesByType.get(ft) ?? [];
          times.push(at);
          stats.timesByType.set(ft, times);
        }
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
      // Dropping a tool because its dominant class is non-dispatchable would
      // hide a recurring `bug` cohort behind a larger `by_design` one.
      const actionableTypes = new Map<string, number>();
      let excludedNonActionable = 0;
      for (const [ft, n] of stats.failureTypes) {
        if (NON_DISPATCHABLE_FAILURE_TYPES.has(ft)) excludedNonActionable += n;
        else actionableTypes.set(ft, n);
      }
      const actionableFailures = Array.from(actionableTypes.values()).reduce((a, b) => a + b, 0);

      if (actionableFailures === 0) continue;

      const denom = stats.invocations > 0 ? stats.invocations : actionableFailures;
      for (const [failureType, failures] of actionableTypes) {
        const failureRate = failures / denom;
        if (failures < this.minFailures || failureRate < this.minFailureRate) continue;

        const handlerBug = failureType !== 'config' && failureType !== 'schema_reject';
        const topErrorClass = dominantKey(stats.errorClassesByType.get(failureType)!);
        const sourceRuleId = `tool-failure:${stats.toolName}:${failureType || 'unclassified'}`;

        proposals.push({
          proposalId: asMutationId(`agent-mode:${sourceRuleId}`),
          sourceRuleId,
          hypothesis:
            `Tool \`${stats.toolName}\` failed ${failures}/${denom} times ` +
            `(${(failureRate * 100).toFixed(0)}%) this window, dominated by ${topErrorClass}` +
            ` [${failureType || 'unclassified'}]` +
            `${excludedNonActionable > 0 ? ` (+${excludedNonActionable} non-actionable excluded)` : ''}. ` +
            (handlerBug
              ? `Investigate the handler + propose a robustness fix.`
              : failureType === 'config'
                ? `Configuration/credential issue — resolve the account, not the code.`
                : `Declared schema and handler disagree — fix the contract.`),
          kind: 'code_change',
          payload: {
            toolName: stats.toolName,
            failures,
            invocations: stats.invocations,
            failureRate,
            topErrorClass,
            failureType,
            sampleTraces: [...(stats.tracesByType.get(failureType) ?? [])],
            directive: directiveFor(
              failureType,
              stats.toolName,
              topErrorClass,
              failures,
              denom,
              stats.messagesByType.get(msgKey(failureType, topErrorClass)) ?? '',
              this.minFailureRate,
            ),
          },
          triggeringStats: {
            toolName: stats.toolName,
            failures,
            failureType,
            excludedNonActionable,
            invocations: stats.invocations,
            failureRatePct: Math.round(failureRate * 100),
            topErrorClass,
          },
        });
        // ENG-3088: run-scoped input for intake only. Non-enumerable on purpose: the proposal is
        // JSON-serialised into the learning store and the fix spec, and this must not become a
        // stored field there.
        Object.defineProperty(proposals[proposals.length - 1].payload, 'failureTimes', {
          value: [...(stats.timesByType.get(failureType) ?? [])]
            .sort((x, y) => x - y)
            .map((ms) => new Date(ms).toISOString()),
          enumerable: false,
        });
      }
    }

    // ENG-820: rank by failure COUNT, not rate. Impact is volume x rate, and
    // ranking by rate alone hid the single largest source of failures in the
    // window (save_memory, 33 failures at 33%) behind a tool with 6 failures at
    // 100%. Rate remains the admission gate above; it is no longer the order.
    //
    // Count and rate can both tie, and when they do the order decided which
    // tools survived the orchestrator's cap — on arrival order, i.e. nothing.
    // The remaining keys (failure class, then tool name) are arbitrary but
    // stable, so the same window always ranks the same way.
    proposals.sort((a, b) => {
      const countA = 'failures' in a.payload ? a.payload.failures : Infinity;
      const countB = 'failures' in b.payload ? b.payload.failures : Infinity;
      if (countA !== countB) return countB - countA;
      const rateA = 'failureRate' in a.payload ? a.payload.failureRate : Infinity;
      const rateB = 'failureRate' in b.payload ? b.payload.failureRate : Infinity;
      if (rateA !== rateB) return rateB - rateA;
      const typeA = 'failureType' in a.payload ? String(a.payload.failureType ?? '') : '';
      const typeB = 'failureType' in b.payload ? String(b.payload.failureType ?? '') : '';
      if (typeA !== typeB) return typeA < typeB ? -1 : 1;
      const toolA = 'toolName' in a.payload ? String(a.payload.toolName ?? '') : '';
      const toolB = 'toolName' in b.payload ? String(b.payload.toolName ?? '') : '';
      if (toolA !== toolB) return toolA < toolB ? -1 : 1;
      return 0;
    });
    return proposals;
  }
}

function strDim(v: string | number | boolean | null | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * The highest-count key, with a deterministic tie-break.
 *
 * Without the tie-break, a 9-config vs 9-bug tool resolves to whichever class
 * this Map happened to see first — i.e. DynamoDB event arrival order — and the
 * operator instruction flips between "reconnect the account" and "investigate
 * the handler" across runs on identical data. Lexical order is arbitrary but
 * stable, which is the property that matters: the same window must always
 * produce the same directive. Neither cohort is lost either way — the loser is
 * named and given its own secondary action.
 */
/**
 * Composite map key for a (failureType, errorClass) pair. NUL (\u0000) cannot appear
 * in either dimension value, so the key is unambiguous.
 */
function msgKey(failureType: string, errorClass: string): string {
  return `${failureType}\u0000${errorClass}`;
}

function dominantKey(counts: Map<string, number>): string {
  let best = 'UnknownError';
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN || (n === bestN && k < best)) {
      bestN = n;
      best = k;
    }
  }
  return best;
}
