/**
 * In-memory learning store for hermetic smoke tests.
 * Production loops use sharedLearningStore (Phase 2 — writes to Dev-AW-LoopLearning).
 */

import type { HistoryFilter, LearningEvent, LearningRecord, LearningStore, LoopId } from '../types';

let counter = 0;

export class InMemoryLearningStore implements LearningStore {
  private readonly events: LearningRecord[] = [];

  async record(event: LearningEvent): Promise<void> {
    counter++;
    this.events.push({ ...event, sortKey: `${event.ts.toISOString()}#${counter}` });
  }

  async queryHistory(filter: HistoryFilter): Promise<LearningRecord[]> {
    return this.events.filter((e) => {
      if (e.loopId !== filter.loopId) return false;
      if (filter.window) {
        if (e.ts < filter.window.start || e.ts > filter.window.end) return false;
      }
      if (filter.ruleIds && (!e.proposal || !filter.ruleIds.includes(e.proposal.sourceRuleId))) return false;
      // Match DynamoLearningStore: a status filter excludes records with no decision.
      if (filter.status && (!e.decision || !filter.status.includes(e.decision.status))) return false;
      return true;
    });
  }

  async lastOutcomeForRule(loopId: LoopId, ruleId: string): Promise<LearningRecord | null> {
    const matches = this.events
      .filter(
        (e) => e.loopId === loopId && e.verdict != null && e.proposal?.sourceRuleId === ruleId,
      )
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey));
    return matches[0] ?? null;
  }

  /** Test helper — total recorded events. */
  get size(): number {
    return this.events.length;
  }
}
