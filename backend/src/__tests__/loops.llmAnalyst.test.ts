/**
 * Tests for LlmAnalystRuleSet — the LLM-as-policy layer-2 implementation.
 *
 * Behavioral acceptance criteria (human-written):
 *  - no events → no LLM call, no proposals (nothing to analyze)
 *  - the LLM's reasoned issues become MutationProposals with the right shape
 *  - code_change proposals are NEVER auto-ship-safe, even if the LLM says so
 *  - empty/healthy verdict ({"issues":[]}) → no proposals
 *  - malformed LLM output → no proposals (never crash the loop)
 *  - bedrock failure → no proposals (degrade, don't throw)
 *  - maxProposals is respected
 *  - the prompt the LLM sees includes the event summary (counts + journeys)
 */

import { LlmAnalystRuleSet } from '../loops/core/policy/llmAnalystRuleSet';
import type { BedrockPort, BedrockResult } from '../loops/core/ports';
import type { NormalizedEvent, TimeWindow } from '../loops/core/types';
import { asSubjectId } from '../loops/core/types';

const WINDOW: TimeWindow = { start: new Date(0), end: new Date(100_000) };
const CONFIG = {
  model: 'claude-sonnet-4-6',
  flowDescription: 'Onboarding: pick channel, generate ads, swipe to like, continue.',
  targetMetricName: 'onboarding_completion_rate',
  chapterDimension: 'chapter',
};

function ev(eventType: string, subject: string, dims?: Record<string, string | number>): NormalizedEvent {
  return { subjectId: asSubjectId(subject), eventType, ts: new Date(1000), ...(dims ? { dimensions: dims } : {}) };
}

function bedrockReturning(text: string): { port: BedrockPort; invoke: jest.Mock } {
  const invoke = jest.fn(async (): Promise<BedrockResult> => ({ text, inputTokens: 1, outputTokens: 1, costUsd: 0 }));
  return { port: { invoke }, invoke };
}

const SAMPLE_EVENTS: NormalizedEvent[] = [
  ev('reached_ad_reveal', 's1', { chapter: 'adReveal' }),
  ev('reached_ad_reveal', 's2', { chapter: 'adReveal' }),
  ev('reached_ad_reveal', 's3', { chapter: 'adReveal' }),
  ev('exited', 's1', { chapter: 'adReveal' }),
];

describe('LlmAnalystRuleSet', () => {
  it('makes no LLM call and returns nothing when there are no events', async () => {
    const { port, invoke } = bedrockReturning('{"issues":[]}');
    const rs = new LlmAnalystRuleSet('onboarding', port, CONFIG);
    const out = await rs.evaluate([], WINDOW);
    expect(out).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("turns the LLM's reasoned issues into proposals", async () => {
    const { port } = bedrockReturning(
      JSON.stringify({
        issues: [
          {
            title: 'Ad regeneration stuck',
            whatHappened: 'Users finish the deck and see "regenerating" but no new ads appear',
            evidence: '3 reached adReveal, all exited without continuing',
            suggestedFix: 'Wire the onDeckEmpty handler to actually regenerate',
            kind: 'code_change',
            severity: 'high',
            autoShipSafe: true,
          },
        ],
      }),
    );
    const rs = new LlmAnalystRuleSet('onboarding', port, CONFIG);
    const out = await rs.evaluate(SAMPLE_EVENTS, WINDOW);

    expect(out).toHaveLength(1);
    const p = out[0];
    expect(p.sourceRuleId).toBe('llm-analyst:ad-regeneration-stuck');
    expect(p.kind).toBe('code_change');
    expect(p.hypothesis).toContain('regenerating');
    expect(p.payload.directive).toContain('onDeckEmpty');
    // code_change is NEVER auto-ship-safe, even though the LLM said true.
    expect(p.payload.autoShipSafe).toBe(false);
    expect(p.triggeringStats.analyst).toBe('llm');
    expect(p.triggeringStats.reached_ad_reveal_count).toBe(3);
  });

  it('keeps autoShipSafe=true only for low-risk copy fixes', async () => {
    const { port } = bedrockReturning(
      JSON.stringify({ issues: [{ title: 'Weak CTA', suggestedFix: 'Punchier headline', kind: 'copy', autoShipSafe: true }] }),
    );
    const out = await new LlmAnalystRuleSet('onboarding', port, CONFIG).evaluate(SAMPLE_EVENTS, WINDOW);
    expect(out[0].kind).toBe('copy');
    expect(out[0].payload.autoShipSafe).toBe(true);
  });

  it('returns no proposals on a healthy verdict', async () => {
    const { port } = bedrockReturning('{"issues":[]}');
    const out = await new LlmAnalystRuleSet('onboarding', port, CONFIG).evaluate(SAMPLE_EVENTS, WINDOW);
    expect(out).toEqual([]);
  });

  it('tolerates markdown fences around the JSON', async () => {
    const { port } = bedrockReturning('```json\n{"issues":[{"title":"X","kind":"copy","suggestedFix":"y"}]}\n```');
    const out = await new LlmAnalystRuleSet('onboarding', port, CONFIG).evaluate(SAMPLE_EVENTS, WINDOW);
    expect(out).toHaveLength(1);
  });

  it('returns nothing (never throws) on malformed LLM output', async () => {
    const { port } = bedrockReturning('the funnel looks broken, you should fix it');
    const out = await new LlmAnalystRuleSet('onboarding', port, CONFIG).evaluate(SAMPLE_EVENTS, WINDOW);
    expect(out).toEqual([]);
  });

  it('returns nothing (degrades) when bedrock throws', async () => {
    const port: BedrockPort = { invoke: jest.fn().mockRejectedValue(new Error('Bedrock 500')) };
    const out = await new LlmAnalystRuleSet('onboarding', port, CONFIG).evaluate(SAMPLE_EVENTS, WINDOW);
    expect(out).toEqual([]);
  });

  it('respects maxProposals', async () => {
    const { port } = bedrockReturning(
      JSON.stringify({ issues: [1, 2, 3, 4, 5].map((n) => ({ title: `Issue ${n}`, kind: 'copy', suggestedFix: 'f' })) }),
    );
    const out = await new LlmAnalystRuleSet('onboarding', port, { ...CONFIG, maxProposals: 2 }).evaluate(SAMPLE_EVENTS, WINDOW);
    expect(out).toHaveLength(2);
  });

  it('feeds the LLM a summary including per-step counts and journeys', async () => {
    const { port, invoke } = bedrockReturning('{"issues":[]}');
    await new LlmAnalystRuleSet('onboarding', port, CONFIG).evaluate(SAMPLE_EVENTS, WINDOW);
    const userPrompt = invoke.mock.calls[0][0].userPrompt as string;
    expect(userPrompt).toContain('Per-step counts');
    expect(userPrompt).toContain('adReveal');
    expect(userPrompt).toContain('Representative user journeys');
    expect(userPrompt).toContain('onboarding_completion_rate');
  });
});
