import { CooldownRuleSet } from '../../core/policy/cooldownRuleSet';
import type { LearningStore, NormalizedEvent, RuleSet } from '../../core/types';
import { AGENT_MODE_LOOP_ID } from './eventTypes';
import type { AgentFailureProposalPayload, AgentClaimMismatchProposalPayload } from './failureRuleSet';

type Payload = AgentFailureProposalPayload | AgentClaimMismatchProposalPayload;

/** Read old tool-level identities without rewriting stored history or new proposals.
 * The outer CooldownRuleSet independently checks the new class-level identity.
 * Reuse its cooldown semantics so expiry, in-flight and improved outcomes agree.
 */
export function withLegacyToolCooldown(
  inner: RuleSet<NormalizedEvent, Payload>,
  learning: LearningStore,
): RuleSet<NormalizedEvent, Payload> {
  return {
    async evaluate(events, window) {
      const proposals = await inner.evaluate(events, window);
      const legacy = new CooldownRuleSet<Payload>({
        evaluate: async () => proposals.filter(p => 'toolName' in p.payload).map(p => ({
          ...p,
          sourceRuleId: `tool-failure:${(p.payload as AgentFailureProposalPayload).toolName}`,
        })),
      }, learning, AGENT_MODE_LOOP_ID);
      const allowed = new Set((await legacy.evaluate(events, window)).map(p => p.proposalId));
      return proposals.filter(p => !('toolName' in p.payload) || allowed.has(p.proposalId));
    },
  };
}
