/**
 * Tests for the daily DM digest's RCA enrichment integration.
 *
 * The cron's `postDailyDigest` reads RCA enrichment from
 * `mutation.artifact.rcaEnrichment` (populated by LinearIntakeTool.apply()).
 * These tests pin the DM format and the graceful-degradation behavior when
 * enrichment is missing or carries an error.
 */

import { _postDailyDigestForTesting } from '../loops/instances/ai-eval-funnel';
import type { LoopRunResult, Mutation, MutationProposal } from '../loops/core/types';
import { asLoopId, asMutationId, asRunId } from '../loops/core/types';
import type { AiEvalProposalPayload } from '../loops/instances/ai-eval-funnel/rules';

function proposal(
  proposalId: string,
  sourceRuleId: string,
  hypothesis: string,
  triggeringStats: Record<string, number> = {},
): MutationProposal<AiEvalProposalPayload> {
  return {
    proposalId: asMutationId(proposalId),
    sourceRuleId,
    hypothesis,
    kind: 'copy',
    payload: { targetKey: 'hero_heading', directive: 'x', autoShipSafe: true },
    triggeringStats,
  };
}

function mutation(
  proposalId: string,
  ruleId: string,
  artifact: Record<string, unknown>,
): Mutation {
  return {
    mutationId: asMutationId(`${proposalId}:mutation`),
    proposalId: asMutationId(proposalId),
    kind: 'copy',
    artifact,
  };
}

function runResult(proposals: MutationProposal<AiEvalProposalPayload>[]): LoopRunResult {
  const now = new Date('2026-05-27T16:00:00Z');
  return {
    loopId: asLoopId('ai-eval-funnel'),
    runId: asRunId('run-test-1'),
    startedAt: now,
    finishedAt: now,
    eventsScanned: 300,
    proposals,
    mutations: [],
    approvals: [],
    blocked: false,
    durationMs: 1000,
    tokensSpentUsd: 0,
  };
}

describe('postDailyDigest with RCA enrichment', () => {
  let slackPosts: Array<{ user: string; message: string }>;
  let mockSlack: { postMessage: jest.Mock };

  beforeEach(() => {
    slackPosts = [];
    mockSlack = {
      postMessage: jest.fn().mockImplementation(async (user: string, message: string) => {
        slackPosts.push({ user, message });
      }),
    };
  });

  it('renders the top fix under each fired rule when enrichment succeeded', async () => {
    const props = [
      proposal('p1', 'capture-broken', 'Lots of landings but very few form submits.', {
        landed_count: 250,
        form_submitted_count: 8,
      }),
      proposal('p2', 'no-signup', 'Users complete the eval but few click signup.', {
        eval_completed_count: 42,
        signup_clicked_count: 2,
      }),
    ];
    const result = runResult(props);
    const muts: Mutation[] = [
      mutation('p1', 'capture-broken', {
        linearUrl: 'https://linear.app/emmabyaw/issue/ENG-601',
        title: 'fix(ai-eval-funnel): capture-broken — …',
        rcaEnrichment: {
          topHypotheses: ['LandedTracker pollutes the denominator', 'a', 'b'],
          rankedFixes: [
            {
              title: 'Scope rule denominator by landerPath = /ai-eval',
              impact: 'high',
              confidence: 'high',
              cost_sp: 1,
              why_this_rank: 'Fixes the measurement bug at the source.',
            },
          ],
        },
      }),
      mutation('p2', 'no-signup', {
        linearUrl: 'https://linear.app/emmabyaw/issue/ENG-602',
        title: 'fix(ai-eval-funnel): no-signup — …',
        rcaEnrichment: {
          topHypotheses: ['ReportView iframe disconnects sticky CTA', 'x', 'y'],
          rankedFixes: [
            {
              title: 'Inject signup CTA into the report HTML itself',
              impact: 'high',
              confidence: 'med',
              cost_sp: 2,
              why_this_rank: 'Removes iframe scroll-coupling.',
            },
          ],
        },
      }),
    ];

    await _postDailyDigestForTesting(result, muts, mockSlack, 'U08TM4QFQ1L');

    expect(mockSlack.postMessage).toHaveBeenCalledTimes(1);
    const message = slackPosts[0].message;
    expect(message).toContain('capture-broken');
    expect(message).toContain('no-signup');
    expect(message).toMatch(/↳ Top fix: Scope rule denominator/);
    expect(message).toMatch(/↳ Top fix: Inject signup CTA into the report HTML itself/);
  });

  it('truncates the top-fix line at 80 chars (with ellipsis)', async () => {
    const longTitle = 'A'.repeat(200);
    const props = [proposal('p1', 'capture-broken', 'x')];
    const result = runResult(props);
    const muts: Mutation[] = [
      mutation('p1', 'capture-broken', {
        title: 't',
        rcaEnrichment: {
          topHypotheses: ['a', 'b', 'c'],
          rankedFixes: [
            { title: longTitle, impact: 'high', confidence: 'high', cost_sp: 1, why_this_rank: 'x' },
          ],
        },
      }),
    ];

    await _postDailyDigestForTesting(result, muts, mockSlack, 'U08TM4QFQ1L');

    const message = slackPosts[0].message;
    const topFixLine = message.split('\n').find((l) => l.includes('Top fix:'));
    expect(topFixLine).toBeDefined();
    // The line includes prefix "   ↳ Top fix: " then up-to-80-char title with optional ellipsis.
    expect(topFixLine!.length).toBeLessThanOrEqual(120);
    expect(topFixLine).toMatch(/A+…?$/);
  });

  it('shows "RCA unavailable" when enrichment carries an error', async () => {
    const props = [proposal('p1', 'capture-broken', 'x')];
    const result = runResult(props);
    const muts: Mutation[] = [
      mutation('p1', 'capture-broken', {
        title: 't',
        rcaEnrichment: {
          topHypotheses: ['x'],
          rankedFixes: [],
          error: 'RCA enrichment unavailable: Bedrock 500',
        },
      }),
    ];

    await _postDailyDigestForTesting(result, muts, mockSlack, 'U08TM4QFQ1L');

    const message = slackPosts[0].message;
    expect(message).toMatch(/⚠️ RCA unavailable/);
  });

  it('does NOT crash when the mutation has no rcaEnrichment artifact', async () => {
    const props = [proposal('p1', 'capture-broken', 'fallback hypothesis text')];
    const result = runResult(props);
    const muts: Mutation[] = [mutation('p1', 'capture-broken', { title: 't' })];

    await expect(
      _postDailyDigestForTesting(result, muts, mockSlack, 'U08TM4QFQ1L'),
    ).resolves.not.toThrow();
    expect(mockSlack.postMessage).toHaveBeenCalledTimes(1);
  });

  it('does NOT crash when a mutation already has a Linear intake error', async () => {
    const props = [proposal('p1', 'capture-broken', 'x')];
    const result = runResult(props);
    const m = mutation('p1', 'capture-broken', { title: 't' });
    (m as Mutation & { error?: string }).error = 'Linear API 502';
    const muts: Mutation[] = [m];

    await _postDailyDigestForTesting(result, muts, mockSlack, 'U08TM4QFQ1L');

    const message = slackPosts[0].message;
    expect(message).toContain('Linear API 502');
  });

  it('is silent if slackUserId is unset', async () => {
    const result = runResult([]);
    await _postDailyDigestForTesting(result, [], mockSlack, undefined);
    expect(mockSlack.postMessage).not.toHaveBeenCalled();
  });
});
