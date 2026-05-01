/**
 * Item #13 — Enrichment evaluation harness.
 *
 * Runs the real CRM enrichment pipeline against a small golden set of well-known
 * companies and scores per-field accuracy. Gated behind ENABLE_LIVE_EVAL=1
 * because it makes real API calls (Google Custom Search + LLM) and costs ~$0.05/run.
 *
 * Usage:
 *   ENABLE_LIVE_EVAL=1 npx jest src/__tests__/enrichmentEval.test.ts
 *
 * Output: per-field accuracy + the raw enrichment results so you can eyeball
 * regressions when prompts/models change.
 *
 * Also includes an OFFLINE smoke test (always runs in CI) that exercises the
 * golden-set comparison logic with a fake LLM, so the harness itself is tested
 * even when the live eval is skipped.
 */

import goldenSet from './fixtures/enrichmentGoldenSet.json';

interface GoldenEntry {
  id: string;
  lead: {
    firstName: string;
    lastName: string;
    email: string;
    company: string;
  };
  outputFields: string[];
  expected: Record<string, string[]>;  // field → list of acceptable substrings (any-match counts as pass)
}

/**
 * Score a single enrichment: for each expected field, see if the actual value
 * (case-insensitive) contains any of the acceptable expected substrings.
 */
export function scoreEnrichment(
  expected: Record<string, string[]>,
  actual: Record<string, string | null | undefined>
): { perField: Record<string, boolean>; passed: number; total: number } {
  const perField: Record<string, boolean> = {};
  let passed = 0;
  for (const [field, candidates] of Object.entries(expected)) {
    const value = actual[field];
    if (typeof value !== 'string' || !value) {
      perField[field] = false;
      continue;
    }
    const lower = value.toLowerCase();
    const matched = candidates.some(c => lower.includes(c.toLowerCase()));
    perField[field] = matched;
    if (matched) passed++;
  }
  return { perField, passed, total: Object.keys(expected).length };
}

describe('enrichment eval harness — offline self-test', () => {
  it('scoreEnrichment counts per-field hits correctly', () => {
    const expected = { industry: ['SaaS', 'FinTech'], founded: ['2018'] };
    const actual = { industry: 'A SaaS company', founded: '2019' };
    const r = scoreEnrichment(expected, actual);
    expect(r.passed).toBe(1);   // industry passes, founded fails
    expect(r.total).toBe(2);
    expect(r.perField.industry).toBe(true);
    expect(r.perField.founded).toBe(false);
  });

  it('treats missing fields as failures', () => {
    const expected = { industry: ['SaaS'], founded: ['2018'] };
    const actual = { industry: 'SaaS' }; // founded missing
    const r = scoreEnrichment(expected, actual);
    expect(r.passed).toBe(1);
    expect(r.perField.founded).toBe(false);
  });

  it('matches case-insensitively', () => {
    const r = scoreEnrichment({ industry: ['saas'] }, { industry: 'SaaS' });
    expect(r.passed).toBe(1);
  });

  it('the golden set fixture is well-formed', () => {
    expect(Array.isArray(goldenSet)).toBe(true);
    expect((goldenSet as unknown as GoldenEntry[]).length).toBeGreaterThan(0);
    for (const entry of goldenSet as unknown as GoldenEntry[]) {
      expect(entry.id).toEqual(expect.any(String));
      expect(entry.lead.email).toContain('@');
      expect(Array.isArray(entry.outputFields)).toBe(true);
      expect(entry.outputFields.length).toBeGreaterThan(0);
      for (const f of entry.outputFields) {
        expect(entry.expected[f]).toBeDefined();
        expect(Array.isArray(entry.expected[f])).toBe(true);
      }
    }
  });
});

// ─── LIVE EVAL — only runs with ENABLE_LIVE_EVAL=1 ─────────────────────────────
//
// Spins up the full enrichment pipeline against real APIs (Google CSE, Gemini).
// Track results over time in backend/eval-results/YYYY-MM-DD.json (write on demand).

const liveEnabled = process.env.ENABLE_LIVE_EVAL === '1';
const describeLive = liveEnabled ? describe : describe.skip;

describeLive('enrichment eval harness — live run', () => {
  jest.setTimeout(180_000);  // 3 min for ~3 leads × multi-step enrichment

  it('runs golden set and reports per-field accuracy', async () => {
    const { CrmEnrichmentService } = await import('../services/crmEnrichmentService');
    const service = new CrmEnrichmentService();

    const allResults: Array<{ id: string; perField: Record<string, boolean>; actual: Record<string, any> }> = [];

    for (const entry of goldenSet as unknown as GoldenEntry[]) {
      const fakeLeadId = `eval-${entry.id}-${Date.now()}`;
      // Run preview() (dry-run, no DB writes)
      const result = await service.preview({
        listId: 'eval-list',
        userId: 'eval-user',
        instruction: `Research ${entry.lead.company} to find: ${entry.outputFields.join(', ')}.`,
        outputFields: entry.outputFields,
        sources: ['web_search'],
        leadIds: [fakeLeadId],
      } as any).catch(err => {
        console.warn(`[eval] ${entry.id} failed:`, err?.message);
        return { samples: [] } as any;
      });

      const sample = (result as any).samples?.[0];
      const actual = sample?.enrichedFields || {};
      const score = scoreEnrichment(entry.expected, actual);
      allResults.push({ id: entry.id, perField: score.perField, actual });
      console.log(`[eval] ${entry.id}: ${score.passed}/${score.total}`, score.perField);
    }

    const totalPassed = allResults.reduce((s, r) => s + Object.values(r.perField).filter(Boolean).length, 0);
    const totalFields = allResults.reduce((s, r) => s + Object.keys(r.perField).length, 0);
    const accuracy = totalFields === 0 ? 0 : totalPassed / totalFields;
    console.log(`\n[eval] Aggregate accuracy: ${(accuracy * 100).toFixed(1)}% (${totalPassed}/${totalFields})\n`);

    // Sanity threshold — well below "good" so prompt regressions trip it
    expect(accuracy).toBeGreaterThan(0.4);
  });
});
