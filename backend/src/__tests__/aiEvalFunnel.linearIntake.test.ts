import {
  executionRouteForAiEvalProposal,
  LinearIntakeTool,
} from '../loops/instances/ai-eval-funnel/linearIntakeTool';
import type { MutationProposal } from '../loops/core/types';
import { asMutationId } from '../loops/core/types';
import type { AiEvalProposalPayload } from '../loops/instances/ai-eval-funnel/rules';

function proposal(
  overrides: Partial<MutationProposal<AiEvalProposalPayload>> = {},
): MutationProposal<AiEvalProposalPayload> {
  return {
    proposalId: asMutationId('prop-1'),
    sourceRuleId: 'eval-failing',
    hypothesis: 'More than 20% of started evals are failing.',
    kind: 'code_change',
    payload: {
      targetKey: 'ai_eval_emma_prompt',
      directive: 'make the agent more robust',
      autoShipSafe: false,
    },
    triggeringStats: { eval_started_count: 10, eval_failed_count: 3 },
    ...overrides,
  };
}

const enrichment = {
  topHypotheses: ['The tool schema drifted from the runtime contract.'],
  rankedFixes: [
    {
      title: 'Validate the schema at the gateway',
      impact: 'high' as const,
      confidence: 'high' as const,
      cost_sp: 1,
      why_this_rank: 'Fixes the failure at the boundary.',
    },
  ],
};

describe('LinearIntakeTool', () => {
  it('routes deterministic eval failures to Autofix through canonical Linear intake', async () => {
    const fileIssue = jest.fn().mockResolvedValue({
      pageId: 'ENG-600',
      url: 'https://linear/ENG-600',
      deduped: false,
      tracker: 'Linear',
    });
    const tool = new LinearIntakeTool({
      fileIssue,
      enricher: jest.fn().mockResolvedValue(enrichment),
    });

    const mutation = await tool.apply(proposal());

    expect(fileIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        executionRoute: 'autofix',
        source: 'ai-eval-funnel loop',
        notionContext: expect.objectContaining({
          'Alert Class': 'ai-eval-funnel:eval-failing',
          'Alert Priority': 'high',
        }),
      }),
    );
    expect(mutation.artifact).toMatchObject({
      linearIssueId: 'ENG-600',
      executionRoute: 'autofix',
      deduped: false,
    });
  });

  it('routes copy, UX, and onboarding behavior changes to human triage', () => {
    expect(
      executionRouteForAiEvalProposal(
        proposal({
          sourceRuleId: 'capture-broken',
          kind: 'copy',
          payload: {
            targetKey: 'hero_heading',
            directive: 'rewrite',
            autoShipSafe: true,
          },
        }),
      ),
    ).toBe('human-triage');
  });

  it('fails unknown code-change classes closed to human triage', () => {
    expect(executionRouteForAiEvalProposal(proposal({ sourceRuleId: 'new-unknown-rule' }))).toBe(
      'human-triage',
    );
  });

  it('surfaces canonical dedupe without filing a second task itself', async () => {
    const fileIssue = jest.fn().mockResolvedValue({
      pageId: 'ENG-601',
      url: 'https://linear/ENG-601',
      deduped: true,
      tracker: 'Linear',
    });
    const tool = new LinearIntakeTool({
      fileIssue,
      enricher: jest.fn().mockResolvedValue(enrichment),
    });

    const mutation = await tool.apply(proposal());

    expect(fileIssue).toHaveBeenCalledTimes(1);
    expect(mutation.artifact).toMatchObject({ linearIssueId: 'ENG-601', deduped: true });
  });

  it('returns a loud mutation error when Linear intake fails', async () => {
    const tool = new LinearIntakeTool({
      fileIssue: jest.fn().mockRejectedValue(new Error('Linear unavailable')),
      enricher: jest.fn().mockResolvedValue(enrichment),
    });

    const mutation = await tool.apply(proposal());

    expect(mutation.error).toBe('Linear unavailable');
    expect(mutation.artifact).toMatchObject({ executionRoute: 'autofix' });
  });

  it('keeps RCA and triggering evidence in the filed issue body', async () => {
    const fileIssue = jest.fn().mockResolvedValue({
      pageId: 'ENG-602',
      url: 'https://linear/ENG-602',
      deduped: false,
      tracker: 'Linear',
    });
    const tool = new LinearIntakeTool({
      fileIssue,
      enricher: jest.fn().mockResolvedValue(enrichment),
    });

    await tool.apply(proposal());

    const description = fileIssue.mock.calls[0][0].description as string;
    expect(description).toContain('## Root cause hypotheses');
    expect(description).toContain('## Triggering data');
    expect(description).toContain('## Acceptance criteria (system invariant)');
  });
});
