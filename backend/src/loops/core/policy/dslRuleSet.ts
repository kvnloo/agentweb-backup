/**
 * Generic DSL-driven RuleSet — accepts a `Rule[]` list and uses the policy
 * DSL (`./dsl.ts`) to evaluate each rule's `when` clause against the event
 * window. When a rule fires, materializes its `then` template into a
 * MutationProposal carrying:
 *   - the rule's id (so the smoke harness can assert which rule fired)
 *   - the rule's hypothesis (for the human reviewer)
 *   - a snapshot of the triggering stats (so the proposal contains the
 *     reason it exists — error text, timeout, complaint, etc.)
 *
 * Rules are processed in `priority` order, highest first. Cooldown is
 * informational here; per-rule cooldown enforcement is the LearningStore's
 * responsibility (Phase 2 wiring).
 */

import type { MutationProposal, NormalizedEvent, Rule, RuleSet, TimeWindow } from '../types';
import { asMutationId } from '../types';
import { evaluate } from './dsl';

let counter = 0;
function nextProposalId(loopId: string, ruleId: string): string {
  counter++;
  return `${loopId}:${ruleId}:${Date.now()}:${counter}`;
}

/** Compute aggregate stats for the rule's triggering data. The Generator
 * + the Slack DM both consume this. */
function computeTriggeringStats(rule: Rule<unknown>, events: readonly NormalizedEvent[]): Record<string, number | string> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    counts[`${e.eventType}_count`] = (counts[`${e.eventType}_count`] ?? 0) + 1;
  }

  // Surface any error/complaint text from the events as a representative
  // sample for the Generator to consume.
  const errorSample = events.find((e) => e.dimensions?.errorMessage)?.dimensions?.errorMessage;
  const complaintSample = events.find((e) => e.dimensions?.complaintText)?.dimensions?.complaintText;
  const timeoutSample = events.find((e) => e.dimensions?.elapsedMs)?.dimensions?.elapsedMs;

  const stats: Record<string, number | string> = { ...counts, ruleId: rule.id };
  if (errorSample) stats.errorSample = String(errorSample);
  if (complaintSample) stats.complaintSample = String(complaintSample);
  if (typeof timeoutSample === 'number') stats.timeoutSample = timeoutSample;
  return stats;
}

export class DslRuleSet<TProposal> implements RuleSet<NormalizedEvent, TProposal> {
  constructor(
    private readonly loopId: string,
    private readonly rules: readonly Rule<TProposal>[],
  ) {}

  async evaluate(events: NormalizedEvent[], window: TimeWindow): Promise<MutationProposal<TProposal>[]> {
    const sorted = [...this.rules].sort((a, b) => b.priority - a.priority);
    const proposals: MutationProposal<TProposal>[] = [];

    for (const rule of sorted) {
      let fired = false;
      try {
        fired = evaluate(rule.when, events, window);
      } catch (err) {
        // Skip rules whose `when` doesn't parse — surface as a console
        // warning so the manifest author sees it. Don't crash the whole loop.
        // eslint-disable-next-line no-console
        console.warn(`[loops/policy] rule "${rule.id}" condition unparseable:`, String(err));
        continue;
      }
      if (!fired) continue;

      const stats = computeTriggeringStats(rule, events);
      proposals.push({
        proposalId: asMutationId(nextProposalId(this.loopId, rule.id)),
        sourceRuleId: rule.id,
        hypothesis: rule.then.hypothesis,
        kind: rule.then.kind,
        payload: rule.then.payload,
        triggeringStats: stats,
      });
    }

    return proposals;
  }
}
