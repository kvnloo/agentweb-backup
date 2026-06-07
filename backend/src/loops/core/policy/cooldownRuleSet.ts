/**
 * CooldownRuleSet — the Layer-5 read-back that makes a loop self-aware of its
 * own in-flight + failed fixes. Wraps any RuleSet and drops a proposal when the
 * same rule's last shipped fix is either:
 *   - still in flight (shipped, not yet graded by attribution), OR
 *   - graded as regressed / no_change / inconclusive within the cooldown window.
 *
 * This is what stops the loop re-proposing a fix it already dispatched (or one
 * that already failed). An `improved` fix is NOT suppressed — if the issue
 * resurfaces after a win, the loop is free to act again.
 *
 * Generic: wraps the DSL ruleset or the LLM analyst identically. Reads the
 * durable learning store, so it works across runs + redeploys.
 */

import type { LearningRecord, LearningStore, LoopId, MutationProposal, NormalizedEvent, RuleSet, TimeWindow } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CooldownOptions {
  /** Days to suppress a rule after its last fix regressed / didn't move the
   * metric. Default 14. */
  cooldownDays?: number;
  /** Also suppress a rule whose last fix is shipped-but-not-yet-graded (don't
   * re-propose while a fix is in flight). Default true. */
  suppressInFlight?: boolean;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
}

export class CooldownRuleSet<TProposal> implements RuleSet<NormalizedEvent, TProposal> {
  private readonly cooldownDays: number;
  private readonly suppressInFlight: boolean;

  constructor(
    private readonly inner: RuleSet<NormalizedEvent, TProposal>,
    private readonly learning: LearningStore,
    private readonly loopId: LoopId,
    options: CooldownOptions = {},
  ) {
    this.cooldownDays = options.cooldownDays ?? 14;
    this.suppressInFlight = options.suppressInFlight ?? true;
  }

  async evaluate(events: NormalizedEvent[], window: TimeWindow): Promise<MutationProposal<TProposal>[]> {
    const proposals = await this.inner.evaluate(events, window);
    if (proposals.length === 0) return proposals;

    const history = await this.learning.queryHistory({ loopId: this.loopId });
    const now = window.end;

    return proposals.filter((p) => !this.onCooldown(p.sourceRuleId, history, now));
  }

  /** True if this rule's most recent shipped fix is in flight or a recent failure. */
  private onCooldown(ruleId: string, history: readonly LearningRecord[], now: Date): boolean {
    const forRule = history
      .filter((r) => r.proposal?.sourceRuleId === ruleId && r.shippedAt)
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey));
    const last = forRule[0];
    if (!last) return false;

    // In flight: shipped, attribution hasn't graded it yet → don't re-propose.
    if (this.suppressInFlight && last.verdict == null) return true;

    // Graded failure within the cooldown window → suppress. ('improved' is not
    // a failure — let it resurface and propose again if the data warrants.)
    if (last.verdict === 'regressed' || last.verdict === 'no_change' || last.verdict === 'inconclusive') {
      const ref = toDate(last.shippedAt) ?? last.ts;
      if (now.getTime() - ref.getTime() < this.cooldownDays * DAY_MS) return true;
    }
    return false;
  }
}
