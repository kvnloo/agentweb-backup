/**
 * Tests for NotionDigestTool body rendering with RCA enrichment.
 *
 * The tool's `buildBody` (and `buildChildren` via Notion blocks) must:
 *   1. Insert a "Root cause hypotheses" section + "Ranked fixes" section between
 *      the existing Summary and Triggering data sections when enrichment succeeded.
 *   2. Replace those two sections with a single "RCA unavailable" block when
 *      enrichment carries an error.
 *   3. Preserve the existing Summary / Triggering data / Proposed change sections.
 */

import { NotionDigestTool } from '../loops/instances/ai-eval-funnel/notionDigestTool';
import type { MutationProposal } from '../loops/core/types';
import { asMutationId } from '../loops/core/types';
import type { AiEvalProposalPayload } from '../loops/instances/ai-eval-funnel/rules';

function proposal(): MutationProposal<AiEvalProposalPayload> {
  return {
    proposalId: asMutationId('prop-1'),
    sourceRuleId: 'capture-broken',
    hypothesis: 'Lots of landings but very few form submits — capture is broken.',
    kind: 'copy',
    payload: { targetKey: 'hero_heading', directive: 'rewrite', autoShipSafe: true },
    triggeringStats: { landed_count: 250, form_submitted_count: 8, ratio: 0.032 },
  };
}

describe('NotionDigestTool.buildBody with RCA enrichment', () => {
  const tool = new NotionDigestTool({ token: 'test-token' });

  it('renders Root cause hypotheses + Ranked fixes between Summary and Triggering data', () => {
    const enrichment = {
      topHypotheses: [
        'LandedTracker fires on every site pathname while form_submitted only fires on /ai-eval — denominator polluted.',
        'Bottom audit form may be cannibalizing primary form submits.',
        'Hero CTA may scroll past the form on mobile.',
      ],
      rankedFixes: [
        {
          title: 'Scope rule denominator by landerPath = /ai-eval',
          impact: 'high' as const,
          confidence: 'high' as const,
          cost_sp: 1,
          why_this_rank: 'Fixes measurement at the source.',
        },
        {
          title: 'Add form_attempted event',
          impact: 'med' as const,
          confidence: 'med' as const,
          cost_sp: 2,
          why_this_rank: 'True intent denominator.',
        },
        {
          title: 'A/B kill the bottom audit form',
          impact: 'med' as const,
          confidence: 'low' as const,
          cost_sp: 3,
          why_this_rank: 'Cleanest if cannibalization is real.',
        },
      ],
    };

    const body = (tool as any).buildBody(proposal(), enrichment) as string;

    expect(body).toContain('## Summary');
    expect(body).toContain('## Root cause hypotheses');
    expect(body).toContain('## Ranked fixes');
    expect(body).toContain('## Triggering data');
    expect(body).toContain('## Proposed change');

    // Order — Summary ... Root cause ... Ranked fixes ... Triggering data
    const idxSummary = body.indexOf('## Summary');
    const idxHypo = body.indexOf('## Root cause hypotheses');
    const idxFixes = body.indexOf('## Ranked fixes');
    const idxTrig = body.indexOf('## Triggering data');
    expect(idxSummary).toBeLessThan(idxHypo);
    expect(idxHypo).toBeLessThan(idxFixes);
    expect(idxFixes).toBeLessThan(idxTrig);

    // Each hypothesis appears as a bullet
    expect(body).toMatch(/- LandedTracker fires/);
    expect(body).toMatch(/- Bottom audit form/);

    // Each ranked fix is rendered with impact / confidence / cost
    expect(body).toMatch(/\*\*1\. Scope rule denominator/);
    expect(body).toMatch(/impact: high.+confidence: high.+cost: 1 SP/);
    expect(body).toMatch(/Fixes measurement at the source/);
  });

  it('renders only the "RCA unavailable" section when enrichment.error is set', () => {
    const enrichment = {
      topHypotheses: ['Lots of landings but very few form submits — capture is broken.'],
      rankedFixes: [],
      error: 'RCA enrichment unavailable: Bedrock 500: ServiceUnavailable',
    };

    const body = (tool as any).buildBody(proposal(), enrichment) as string;

    expect(body).toContain('## Summary');
    expect(body).toContain('## RCA unavailable');
    expect(body).toContain('Bedrock 500: ServiceUnavailable');
    expect(body).not.toContain('## Root cause hypotheses');
    expect(body).not.toContain('## Ranked fixes');
    // Triggering data + Proposed change are still present
    expect(body).toContain('## Triggering data');
    expect(body).toContain('## Proposed change');
  });

  it('omits RCA sections entirely when no enrichment is provided', () => {
    const body = (tool as any).buildBody(proposal()) as string;

    expect(body).toContain('## Summary');
    expect(body).not.toContain('## Root cause hypotheses');
    expect(body).not.toContain('## Ranked fixes');
    expect(body).not.toContain('## RCA unavailable');
    expect(body).toContain('## Triggering data');
  });

  it('buildChildren renders the RCA sections as Notion blocks', () => {
    const enrichment = {
      topHypotheses: ['hyp1', 'hyp2', 'hyp3'],
      rankedFixes: [
        { title: 'Fix1', impact: 'high' as const, confidence: 'high' as const, cost_sp: 1, why_this_rank: 'r1' },
        { title: 'Fix2', impact: 'med' as const, confidence: 'med' as const, cost_sp: 2, why_this_rank: 'r2' },
        { title: 'Fix3', impact: 'low' as const, confidence: 'low' as const, cost_sp: 3, why_this_rank: 'r3' },
      ],
    };
    const body = (tool as any).buildBody(proposal(), enrichment) as string;
    const children = (tool as any).buildChildren(body) as Array<Record<string, unknown>>;

    const headingTexts = children
      .filter((c) => c.type === 'heading_2')
      .map((c: any) => c.heading_2.rich_text[0].text.content);
    expect(headingTexts).toContain('Root cause hypotheses');
    expect(headingTexts).toContain('Ranked fixes');
  });
});
