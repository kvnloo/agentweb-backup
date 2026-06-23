/**
 * Unit tests for the runCriticReal real-dep implementation (exposed via
 * buildOrchestratorDeps().runCriticOverWebFills).
 *
 * The boundary-level tests in crmEnrichmentServiceV3.test.ts mock
 * runCriticOverWebFills entirely, so the actual critic prompt has no coverage
 * there. These tests exercise the impl directly to lock in the entity-identity
 * guard that fixes the Slashy/Slash bug — the critic must instruct the model to
 * verify the source describes the SAME company as the lead, and must surface a
 * "contradicted" verdict back to the orchestrator.
 */

import { buildOrchestratorDeps } from '../services/enrichmentV3RealDeps';
import type { LeadRecord } from '../services/crmEnrichmentService';

// ── LLM mock ──────────────────────────────────────────────────────────────────

const mockGenerateJSONContent = jest.fn();
jest.mock('../utils/llmService', () => ({
  createLLMService: jest.fn(() => ({
    generateJSONContent: mockGenerateJSONContent,
  })),
}));

function makeLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    leadId: 'lead-1',
    email: 'harsha@slashy.com',
    company: 'Slashy',
    website: 'https://usedash.ai',
    enrichmentMetadata: {},
    customFields: {},
    ...overrides,
  } as LeadRecord;
}

function getRunCritic() {
  return buildOrchestratorDeps('user-1').runCriticOverWebFills;
}

function lastCallPrompts(): { system: string; user: string } {
  const call = mockGenerateJSONContent.mock.calls[mockGenerateJSONContent.mock.calls.length - 1];
  return { system: call[0] as string, user: call[1] as string };
}

beforeEach(() => {
  mockGenerateJSONContent.mockReset();
});

describe('runCriticReal — entity identity guard (Slashy bug)', () => {
  const fills = [{
    field: 'funding_stage',
    value: 'Series C',
    meta: {
      source: 'web_search' as const,
      provider: 'llm_web_search',
      enrichedAt: '2026-01-01T00:00:00Z',
      sourceUrl: 'https://www.morningstar.com/news/business-wire/slash-unicorn',
      sourceQuote: "who led Slash's Series B just 16 months ago",
    },
  }];

  it('SUCCESS: empty fills short-circuits without calling the LLM', async () => {
    const runCritic = getRunCritic();
    const result = await runCritic({ lead: makeLead(), fills: [] });
    expect(result).toEqual({ verdicts: {} });
    expect(mockGenerateJSONContent).not.toHaveBeenCalled();
  });

  it('the system prompt instructs the model to verify company identity', async () => {
    mockGenerateJSONContent.mockResolvedValue({ funding_stage: 'contradicted' });
    const runCritic = getRunCritic();
    await runCritic({ lead: makeLead(), fills });
    const { system } = lastCallPrompts();
    // Identity verification language must be present.
    expect(system.toLowerCase()).toContain('identity');
    expect(system.toLowerCase()).toContain('different company');
    expect(system.toLowerCase()).toContain('contradicted');
  });

  it('the user prompt includes the lead company AND website so the model can judge identity', async () => {
    mockGenerateJSONContent.mockResolvedValue({ funding_stage: 'supported' });
    const runCritic = getRunCritic();
    await runCritic({ lead: makeLead(), fills });
    const { user } = lastCallPrompts();
    expect(user).toContain('Slashy');
    expect(user).toContain('usedash.ai');
    expect(user).toContain('harsha@slashy.com');
  });

  it('FAIL CASE: a "contradicted" verdict from the model is surfaced for the field', async () => {
    mockGenerateJSONContent.mockResolvedValue({ funding_stage: 'contradicted' });
    const runCritic = getRunCritic();
    const result = await runCritic({ lead: makeLead(), fills });
    expect(result.verdicts.funding_stage).toBe('contradicted');
  });

  it('FAIL CASE: an unrecognized verdict string is ignored (not surfaced)', async () => {
    mockGenerateJSONContent.mockResolvedValue({ funding_stage: 'maybe' });
    const runCritic = getRunCritic();
    const result = await runCritic({ lead: makeLead(), fills });
    expect(result.verdicts.funding_stage).toBeUndefined();
  });

  it('FAIL CASE: an LLM error yields empty verdicts (fail-soft, lead not failed)', async () => {
    mockGenerateJSONContent.mockRejectedValue(new Error('boom'));
    const runCritic = getRunCritic();
    const result = await runCritic({ lead: makeLead(), fills });
    expect(result).toEqual({ verdicts: {} });
  });

  it('SUCCESS CASE: a "supported" verdict is surfaced for the field', async () => {
    mockGenerateJSONContent.mockResolvedValue({ funding_stage: 'supported' });
    const runCritic = getRunCritic();
    const result = await runCritic({ lead: makeLead(), fills });
    expect(result.verdicts.funding_stage).toBe('supported');
  });
});
