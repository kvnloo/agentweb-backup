/**
 * specOutputTool — produces a structured "fix spec" artifact for each
 * proposal. Output is the payload that gets shipped to cloud-dev as a
 * Notion task.
 *
 * Why not call Notion's API directly here: the framework is host-agnostic.
 * The actual Notion call happens in the smoke runner / cron wrapper that
 * has access to the host's Notion client. This tool produces the
 * declarative spec; the host turns it into an actual Notion task.
 *
 * Output artifact shape:
 *   {
 *     fixSpec: {
 *       title: "..."           // Notion task title
 *       summary: "..."         // 1-2 sentence what + why
 *       triggeringData: {...}  // the stats that caused the proposal
 *       proposedChange: {...}  // payload from the rule's then template
 *       reviewContext: "..."   // what Harsha needs to know to approve
 *       cloudDevTags: [...]    // tags so cloud-dev picks this up
 *     }
 *   }
 */

import type { Mutation, MutationProposal, MutationTools } from '../types';
import { asMutationId } from '../types';

export interface FixSpec {
  title: string;
  summary: string;
  triggeringData: Readonly<Record<string, unknown>>;
  proposedChange: unknown;
  reviewContext: string;
  cloudDevTags: readonly string[];
}

export class SpecOutputTool<TProposal> implements MutationTools<TProposal> {
  constructor(
    private readonly loopId: string,
    private readonly cloudDevTags: readonly string[] = ['cloud-dev', 'auto-loop'],
  ) {}

  async apply(proposal: MutationProposal<TProposal>): Promise<Mutation> {
    const fixSpec: FixSpec = {
      title: this.buildTitle(proposal),
      summary: proposal.hypothesis,
      triggeringData: proposal.triggeringStats,
      proposedChange: proposal.payload,
      reviewContext: this.buildReviewContext(proposal),
      cloudDevTags: this.cloudDevTags,
    };

    return {
      mutationId: asMutationId(`${proposal.proposalId}:mutation`),
      proposalId: proposal.proposalId,
      kind: proposal.kind,
      artifact: { fixSpec },
    };
  }

  private buildTitle(proposal: MutationProposal<TProposal>): string {
    // "fix(<loopId>): <ruleId> — <hypothesis first sentence>"
    const firstSentence = proposal.hypothesis.split(/[.!?]\s/)[0].slice(0, 80);
    return `fix(${this.loopId}): ${proposal.sourceRuleId} — ${firstSentence}`;
  }

  private buildReviewContext(proposal: MutationProposal<TProposal>): string {
    const lines: string[] = [
      `Loop: ${this.loopId}`,
      `Rule fired: ${proposal.sourceRuleId}`,
      `Hypothesis: ${proposal.hypothesis}`,
      '',
      'Triggering data:',
    ];
    for (const [k, v] of Object.entries(proposal.triggeringStats)) {
      lines.push(`  ${k}: ${typeof v === 'string' ? `"${v}"` : v}`);
    }
    return lines.join('\n');
  }
}
