import type { LearningRecord, LearningStore, NormalizedEvent, RuleSet } from '../../core/types';
import { AGENT_MODE_LOOP_ID } from './eventTypes';
import type { AgentFailureProposalPayload, AgentClaimMismatchProposalPayload } from './failureRuleSet';

type Payload = AgentFailureProposalPayload | AgentClaimMismatchProposalPayload;
const DAY_MS = 24 * 60 * 60 * 1000;

function isActive(record: LearningRecord | undefined, now: Date): boolean {
  if (!record) return false;
  if (record.verdict == null) return true;
  if (!['regressed', 'no_change', 'inconclusive'].includes(record.verdict)) return false;
  const shippedAt = record.shippedAt instanceof Date ? record.shippedAt : new Date(record.shippedAt!);
  return now.getTime() - shippedAt.getTime() < 14 * DAY_MS;
}

/** Apply class and legacy tool cooldown identities with one indexed history read. */
export function withLegacyToolCooldown(
  inner: RuleSet<NormalizedEvent, Payload>,
  learning: LearningStore,
): RuleSet<NormalizedEvent, Payload> {
  return {
    async evaluate(events, window) {
      const proposals = await inner.evaluate(events, window);
      if (proposals.length === 0) return proposals;
      const history = await learning.queryHistory({ loopId: AGENT_MODE_LOOP_ID });
      const latest = new Map<string, LearningRecord>();
      for (const record of history) {
        const ruleId = record.proposal?.sourceRuleId;
        if (!ruleId || !record.shippedAt) continue;
        const current = latest.get(ruleId);
        if (!current || record.sortKey > current.sortKey) latest.set(ruleId, record);
      }
      return proposals.filter((proposal) => {
        if (isActive(latest.get(proposal.sourceRuleId), window.end)) return false;
        if (!('toolName' in proposal.payload)) return true;
        const legacyId = `tool-failure:${(proposal.payload as AgentFailureProposalPayload).toolName}`;
        return !isActive(latest.get(legacyId), window.end);
      });
    },
  };
}
