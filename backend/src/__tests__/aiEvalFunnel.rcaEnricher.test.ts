/**
 * Tests for the ai-eval-funnel RCA enricher.
 *
 * Behavioral contract (mirrors Notion task https://www.notion.so/36d09247c95181458a69ee59eca904bd):
 *   1. Returns 3-5 distinct topHypotheses + ≥3 ranked fixes on success.
 *   2. Bedrock errors degrade gracefully — returns { topHypotheses: [proposal.hypothesis], rankedFixes: [], error }.
 *   3. JSON schema mismatch on the LLM response degrades gracefully (same error path).
 *   4. 25-second hard timeout — slow Bedrock returns the same graceful error envelope.
 *   5. Prompt caching cachePoint is set on the system block (stable rule + mutation surface caching).
 *   6. The system prompt mentions the mutation surface keys + rule context so the LLM can ground its analysis.
 *   7. claude-sonnet-4-6 is the model used.
 */

import type { MutationProposal } from '../loops/core/types';
import { asMutationId } from '../loops/core/types';
import type { AiEvalProposalPayload } from '../loops/instances/ai-eval-funnel/rules';

// --- Mock Bedrock --------------------------------------------------------
const mockBedrockSend = jest.fn();
let lastConverseInput: any = null;

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: mockBedrockSend,
  })),
  ConverseCommand: jest.fn().mockImplementation((input: any) => {
    lastConverseInput = input;
    return { input };
  }),
}));

// Import AFTER the mock so the module picks up the mocked client.
import { enrichWithRCA, RCA_TIMEOUT_MS } from '../loops/instances/ai-eval-funnel/rcaEnricher';

const SAMPLE_MUTATION_SURFACE = [
  { key: 'hero_heading', kind: 'copy' },
  { key: 'hero_cta', kind: 'copy' },
  { key: 'report_view_cta', kind: 'copy' },
  { key: 'ai_eval_emma_prompt', kind: 'code_change' },
] as const;

function makeProposal(overrides: Partial<MutationProposal<AiEvalProposalPayload>> = {}): MutationProposal<AiEvalProposalPayload> {
  return {
    proposalId: asMutationId('prop-1'),
    sourceRuleId: 'capture-broken',
    hypothesis: 'Lots of landings but very few form submits — capture is broken.',
    kind: 'copy',
    payload: {
      targetKey: 'hero_heading',
      directive: 'rewrite to make the eval feel zero-cost',
      autoShipSafe: true,
    },
    triggeringStats: {
      landed_count: 250,
      form_submitted_count: 8,
      ratio: 0.032,
    },
    ...overrides,
  };
}

function bedrockResponseWithJson(jsonObj: unknown) {
  return {
    output: {
      message: {
        role: 'assistant',
        content: [{ text: JSON.stringify(jsonObj) }],
      },
    },
    usage: { inputTokens: 100, outputTokens: 50 },
    stopReason: 'end_turn',
  };
}

describe('enrichWithRCA', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    lastConverseInput = null;
    process.env.AWS_REGION = 'us-west-2';
    process.env.AWS_ACCESS_KEY_ID = 'test-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns a validated enrichment on the happy path', async () => {
    mockBedrockSend.mockResolvedValueOnce(
      bedrockResponseWithJson({
        topHypotheses: [
          'LandedTracker fires on every site pathname while form_submitted only fires on /ai-eval — denominator is polluted.',
          'Bottom A/B audit form may be cannibalizing primary form submits without firing the same event.',
          'Hero CTA may scroll past the form on mobile, suppressing fills.',
        ],
        rankedFixes: [
          {
            title: 'Scope rule denominator by landerPath = /ai-eval',
            impact: 'high',
            confidence: 'high',
            cost_sp: 1,
            why_this_rank: 'Fixes the measurement bug at the source for ~zero risk.',
          },
          {
            title: 'Add form_attempted event before submit',
            impact: 'med',
            confidence: 'med',
            cost_sp: 2,
            why_this_rank: 'Gives a true intent denominator independent of LandedTracker.',
          },
          {
            title: 'A/B kill the bottom audit form',
            impact: 'med',
            confidence: 'low',
            cost_sp: 3,
            why_this_rank: 'Cleanest if cannibalization is the real cause; needs data first.',
          },
        ],
      }),
    );

    const result = await enrichWithRCA(makeProposal(), SAMPLE_MUTATION_SURFACE);

    expect(result.error).toBeUndefined();
    expect(result.topHypotheses).toHaveLength(3);
    expect(result.topHypotheses[0]).toMatch(/LandedTracker/);
    expect(result.rankedFixes).toHaveLength(3);
    expect(result.rankedFixes[0].impact).toBe('high');
    expect(result.rankedFixes[0].confidence).toBe('high');
    expect(result.rankedFixes[0].cost_sp).toBe(1);
    expect(result.rankedFixes[0].title).toMatch(/Scope rule denominator/);
  });

  it('uses claude-sonnet-4-6 via the cross-region inference profile', async () => {
    mockBedrockSend.mockResolvedValueOnce(
      bedrockResponseWithJson({
        topHypotheses: ['a', 'b', 'c'],
        rankedFixes: [
          { title: 'a', impact: 'high', confidence: 'high', cost_sp: 1, why_this_rank: 'x' },
          { title: 'b', impact: 'med', confidence: 'med', cost_sp: 2, why_this_rank: 'y' },
          { title: 'c', impact: 'low', confidence: 'low', cost_sp: 3, why_this_rank: 'z' },
        ],
      }),
    );

    await enrichWithRCA(makeProposal(), SAMPLE_MUTATION_SURFACE);

    expect(lastConverseInput).not.toBeNull();
    expect(lastConverseInput.modelId).toBe(
      'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-6',
    );
  });

  it('applies a cachePoint after the system prompt for prompt caching', async () => {
    mockBedrockSend.mockResolvedValueOnce(
      bedrockResponseWithJson({
        topHypotheses: ['a', 'b', 'c'],
        rankedFixes: [
          { title: 'a', impact: 'high', confidence: 'high', cost_sp: 1, why_this_rank: 'x' },
          { title: 'b', impact: 'med', confidence: 'med', cost_sp: 2, why_this_rank: 'y' },
          { title: 'c', impact: 'low', confidence: 'low', cost_sp: 3, why_this_rank: 'z' },
        ],
      }),
    );

    await enrichWithRCA(makeProposal(), SAMPLE_MUTATION_SURFACE);

    expect(lastConverseInput).not.toBeNull();
    const system = lastConverseInput.system as Array<Record<string, unknown>>;
    // First block holds the system text, last block is the cachePoint marker.
    expect(system.length).toBeGreaterThanOrEqual(2);
    expect(system[system.length - 1]).toEqual({ cachePoint: { type: 'default' } });
  });

  it('puts the rule context + mutation surface in the system prompt (so caching pays off)', async () => {
    mockBedrockSend.mockResolvedValueOnce(
      bedrockResponseWithJson({
        topHypotheses: ['a', 'b', 'c'],
        rankedFixes: [
          { title: 'a', impact: 'high', confidence: 'high', cost_sp: 1, why_this_rank: 'x' },
          { title: 'b', impact: 'med', confidence: 'med', cost_sp: 2, why_this_rank: 'y' },
          { title: 'c', impact: 'low', confidence: 'low', cost_sp: 3, why_this_rank: 'z' },
        ],
      }),
    );

    await enrichWithRCA(makeProposal(), SAMPLE_MUTATION_SURFACE);

    const system = lastConverseInput.system as Array<{ text?: string }>;
    const sysText = system.map((b) => b.text ?? '').join('\n');
    // Mentions specific telemetry events
    expect(sysText).toMatch(/landed/);
    expect(sysText).toMatch(/form_submitted/);
    expect(sysText).toMatch(/eval_completed/);
    // Mentions every mutation surface key so the LLM can ground recommendations
    for (const k of SAMPLE_MUTATION_SURFACE) {
      expect(sysText).toContain(k.key);
    }
    // Mentions the JSON output schema field names
    expect(sysText).toMatch(/topHypotheses/);
    expect(sysText).toMatch(/rankedFixes/);
    expect(sysText).toMatch(/cost_sp/);
  });

  it('puts the per-rule triggering stats in the user prompt only (not the cached system)', async () => {
    mockBedrockSend.mockResolvedValueOnce(
      bedrockResponseWithJson({
        topHypotheses: ['a', 'b', 'c'],
        rankedFixes: [
          { title: 'a', impact: 'high', confidence: 'high', cost_sp: 1, why_this_rank: 'x' },
          { title: 'b', impact: 'med', confidence: 'med', cost_sp: 2, why_this_rank: 'y' },
          { title: 'c', impact: 'low', confidence: 'low', cost_sp: 3, why_this_rank: 'z' },
        ],
      }),
    );

    const proposal = makeProposal({
      sourceRuleId: 'no-signup',
      hypothesis: 'Users complete the eval but few click signup.',
      triggeringStats: { eval_completed_count: 42, signup_clicked_count: 2, ratio: 0.047 },
    });

    await enrichWithRCA(proposal, SAMPLE_MUTATION_SURFACE);

    const userMsg = lastConverseInput.messages[0];
    const userText = userMsg.content.map((c: any) => c.text ?? '').join('\n');
    expect(userText).toContain('no-signup');
    expect(userText).toContain('42');
    expect(userText).toContain('signup_clicked_count');

    // Triggering stats must NOT appear in the cacheable system block (would defeat caching).
    const sysText = lastConverseInput.system.map((b: any) => b.text ?? '').join('\n');
    expect(sysText).not.toContain('42');
    expect(sysText).not.toContain('signup_clicked_count');
  });

  it('degrades gracefully when Bedrock throws — returns error envelope, no exception', async () => {
    mockBedrockSend.mockRejectedValueOnce(new Error('Bedrock 500: ServiceUnavailable'));

    const proposal = makeProposal();
    const result = await enrichWithRCA(proposal, SAMPLE_MUTATION_SURFACE);

    expect(result.error).toMatch(/RCA enrichment unavailable/);
    expect(result.error).toMatch(/ServiceUnavailable/);
    expect(result.topHypotheses).toEqual([proposal.hypothesis]);
    expect(result.rankedFixes).toEqual([]);
  });

  it('degrades gracefully when the LLM returns non-JSON text', async () => {
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: { role: 'assistant', content: [{ text: 'I cannot help with that, sorry.' }] },
      },
      usage: { inputTokens: 100, outputTokens: 10 },
      stopReason: 'end_turn',
    });

    const proposal = makeProposal();
    const result = await enrichWithRCA(proposal, SAMPLE_MUTATION_SURFACE);

    expect(result.error).toMatch(/RCA enrichment unavailable/);
    expect(result.topHypotheses).toEqual([proposal.hypothesis]);
    expect(result.rankedFixes).toEqual([]);
  });

  it('degrades gracefully when the LLM returns JSON with the wrong shape', async () => {
    mockBedrockSend.mockResolvedValueOnce(
      bedrockResponseWithJson({
        // missing rankedFixes entirely
        topHypotheses: ['a', 'b', 'c'],
      }),
    );

    const proposal = makeProposal();
    const result = await enrichWithRCA(proposal, SAMPLE_MUTATION_SURFACE);

    expect(result.error).toMatch(/RCA enrichment unavailable/);
    expect(result.topHypotheses).toEqual([proposal.hypothesis]);
    expect(result.rankedFixes).toEqual([]);
  });

  it('degrades gracefully when a ranked fix has an invalid impact value', async () => {
    mockBedrockSend.mockResolvedValueOnce(
      bedrockResponseWithJson({
        topHypotheses: ['a', 'b', 'c'],
        rankedFixes: [
          {
            title: 'x',
            impact: 'extremely high', // invalid — only high|med|low allowed
            confidence: 'high',
            cost_sp: 1,
            why_this_rank: 'r',
          },
          { title: 'y', impact: 'med', confidence: 'med', cost_sp: 2, why_this_rank: 'r' },
          { title: 'z', impact: 'low', confidence: 'low', cost_sp: 3, why_this_rank: 'r' },
        ],
      }),
    );

    const result = await enrichWithRCA(makeProposal(), SAMPLE_MUTATION_SURFACE);

    expect(result.error).toMatch(/RCA enrichment unavailable/);
    expect(result.rankedFixes).toEqual([]);
  });

  it('hard-timeout enforced at 25 seconds', async () => {
    expect(RCA_TIMEOUT_MS).toBe(25_000);

    jest.useFakeTimers();
    try {
      // Bedrock send returns a promise that never resolves.
      mockBedrockSend.mockImplementationOnce(() => new Promise(() => undefined));

      const proposal = makeProposal();
      const promise = enrichWithRCA(proposal, SAMPLE_MUTATION_SURFACE);

      // Advance past the 25s timeout
      jest.advanceTimersByTime(RCA_TIMEOUT_MS + 100);

      const result = await promise;
      expect(result.error).toMatch(/RCA enrichment unavailable/);
      expect(result.error?.toLowerCase()).toMatch(/timeout|timed out/);
      expect(result.topHypotheses).toEqual([proposal.hypothesis]);
      expect(result.rankedFixes).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('clamps topHypotheses to at most 5 entries even if the model returns more', async () => {
    mockBedrockSend.mockResolvedValueOnce(
      bedrockResponseWithJson({
        topHypotheses: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        rankedFixes: [
          { title: 'a', impact: 'high', confidence: 'high', cost_sp: 1, why_this_rank: 'x' },
          { title: 'b', impact: 'med', confidence: 'med', cost_sp: 2, why_this_rank: 'y' },
          { title: 'c', impact: 'low', confidence: 'low', cost_sp: 3, why_this_rank: 'z' },
        ],
      }),
    );

    const result = await enrichWithRCA(makeProposal(), SAMPLE_MUTATION_SURFACE);
    expect(result.error).toBeUndefined();
    expect(result.topHypotheses.length).toBeLessThanOrEqual(5);
  });
});
