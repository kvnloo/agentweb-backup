import { byokCoverage, detectFrontier, parseEndpointProviders, renderCoverage, renderPrBody, buildReviewArtifacts } from '../frontierMonitor';
import { refreshModelCatalog } from '../modelCatalogRefresh';
import { LLMModelConfig } from '../llmModelRegistry';

const now = Date.parse('2026-09-24T00:00:00Z');
const day = 86400;
const config: LLMModelConfig = { client: null, supportsTemperature: true, provider: 'xai' };
const registry = { 'openrouter/x-ai/grok-4.6': config };
const row = (id: string, age: number) => ({ id, created: now / 1000 - age * day,
  pricing: { prompt: '0.000001', completion: '0.000003' },
  supported_parameters: ['tools', 'temperature'], architecture: { output_modalities: ['text'] } });
const catalog = { data: [row('x-ai/grok-4.6', 30), row('x-ai/grok-4.8', 8)] };
const aaRow = (slug: string, score: unknown) => ({ slug, model_creator: { slug: 'x-ai' },
  evaluations: { artificial_analysis_intelligence_index: score } });

describe('frontier monitor acceptance and boundary invariants', () => {
  it('detects missing newest family release, resolves logical IDs, alerts after seven days', () => {
    const result = detectFrontier(catalog, undefined, registry, now);
    expect(result.additions).toEqual(['openrouter/x-ai/grok-4.8']);
    expect(result.alerts.some(s => s.includes('>7 days'))).toBe(true);
    expect(detectFrontier(catalog, undefined, registry, now - day * 2 * 1000).alerts.some(s => s.includes('>7 days'))).toBe(false);
    expect(detectFrontier(catalog, undefined, { ...registry, 'openrouter/x-ai/grok-4.8': config }, now).alerts).toEqual([]);
  });
  it('never proposes old releases, unknown labs, malformed timestamps or unsafe modalities', () => {
    const result = detectFrontier({ data: [null, false, 'wrong', row('x-ai/grok-4.6', 30),
      row('x-ai/grok-4.5', 40), row('unknown/grok-4.9', 1),
      { ...row('x-ai/grok-5', 1), created: '123' },
      { ...row('x-ai/grok-6', 1), architecture: { output_modalities: ['image'] } }] }, undefined, registry, now);
    expect(result.additions).toEqual([]);
    expect(() => detectFrontier({ data: {} }, undefined, registry, now)).toThrow();
  });
  it('top-N can introduce a new family from a tracked provider and refresh can add it', async () => {
    const source = { data: [...catalog.data, row('x-ai/grok-code-2', 1)] };
    const aa = { data: [null, aaRow('grok-code-2', 90), aaRow('grok-4.8', 80), aaRow('broken', '100')] };
    const detected = detectFrontier(source, aa, registry, now, 1);
    expect(detected.additions).toContain('openrouter/x-ai/grok-code-2');
    const request = jest.fn();
    const plan = await refreshModelCatalog({ catalog: source, aa, registry, additionIds: detected.additions, fetch: request });
    expect(plan.additions).toContain('openrouter/x-ai/grok-code-2');
    expect(request).not.toHaveBeenCalled();
    expect(detectFrontier(source, { data: [aaRow('other', 99), aaRow('grok-code-2', 90)] }, registry, now, 1).additions)
      .not.toContain('openrouter/x-ai/grok-code-2');
  });
  it('an empty addition allow-list still refreshes existing benchmark scores', async () => {
    const plan = await refreshModelCatalog({ catalog, aa: { data: [aaRow('grok-4.6', 42)] }, registry, additionIds: [] });
    expect(plan.additions).toEqual([]);
    expect(plan.registryChanges['openrouter/x-ai/grok-4.6'].qualityScore).toBe(42);
    expect(plan.registryChanges['openrouter/x-ai/grok-4.8']).toBeUndefined();
  });
  it('does not guess ambiguous AA variants or trust malformed AA payloads', () => {
    expect(() => detectFrontier(catalog, { data: 'bad' }, registry, now)).toThrow();
    const source = { data: [row('x-ai/grok-code-2', 1)] };
    expect(detectFrontier(source, { data: [aaRow('grok-code-2', 90), aaRow('grok-code-2', 95)] }, registry, now).additions).toEqual([]);
  });
  it('uses endpoint tags, not model authors, to flag BYOK clouds including regional endpoints', () => {
    expect(parseEndpointProviders({ data: { id: 'x-ai/grok-4.8', endpoints: [
      { provider_name: 'Amazon Bedrock', tag: 'amazon-bedrock/us' },
      { provider_name: 'Google', tag: 'google-vertex' },
      { provider_name: 'Google AI Studio', tag: 'google-ai-studio' },
    ] } }).byok).toEqual(['amazon-bedrock', 'google-vertex']);
    for (const malformed of [null, 'bad', { provider_name: 4 }, { provider_name: 'Azure', tag: {} }, { provider_name: 'Azure', supported_parameters: [null] }, { provider_name: 'Azure', supported_parameters: {} }]) {
      expect(() => parseEndpointProviders({ data: { id: 'x-ai/grok-4.8', endpoints: [malformed] } })).toThrow();
    }
  });
  it('does not guess which Google cloud a tagless endpoint uses', () => {
    expect(parseEndpointProviders({ data: { id: 'google/gemini-3.8-flash', endpoints: [{ provider_name: 'Google' }] } }).byok).toEqual([]);
  });
  it('reports per-model failure as UNKNOWN while retaining successful coverage and live rows', async () => {
    const request = jest.fn().mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: 'x-ai/grok-4.8', endpoints: [{ provider_name: 'Azure', tag: 'azure' }] } }) });
    const coverage = await byokCoverage({ ...registry, 'openrouter/x-ai/grok-4.8': config, live: { ...config, isLive: true } }, request);
    expect(coverage.find(r => r.id.endsWith('4.6'))?.status).toContain('UNKNOWN');
    expect(coverage.find(r => r.id.endsWith('4.8'))?.byok).toEqual(['azure']);
    expect(coverage).toHaveLength(3);
    expect(request).toHaveBeenCalledTimes(2);
    expect(renderCoverage(coverage, '2026-09-24')).toContain('does not verify configured BYOK keys');
  });
});

describe('renderPrBody', () => {
  it('puts warning-sign reports in the PR body up front so a reviewer cannot miss them', () => {
    const outlier = '⚠️ PRICE OUTLIER: openrouter/x/y blended $0.338/M is 3.6x its closest "z" family sibling ($0.093/M) — verify before merging.';
    const body = renderPrBody(['Artificial Analysis skipped: ARTIFICIAL_ANALYSIS_API_KEY is missing; scores unchanged.', outlier]);
    expect(body).toContain('## Review before merging');
    expect(body).toContain(`- ${outlier}`);
    expect(body.indexOf(outlier)).toBeLessThan(body.indexOf('<details>'));
    expect(body).toContain('- Artificial Analysis skipped: ARTIFICIAL_ANALYSIS_API_KEY is missing; scores unchanged.');
  });
  it('omits both sections when there is nothing to report', () => {
    const body = renderPrBody([]);
    expect(body).not.toContain('Review before merging');
    expect(body).not.toContain('<details>');
    expect(body).toContain('Rollback: revert this PR.');
  });
});

describe('renderPrBody verdict and noise handling', () => {
  const cleanInputs = { existingChanges: { changed: 0, blockers: [] as string[] }, observationDegraded: false };
  it('leads with the auto-merge verdict and lists each check', () => {
    const { body, autoMerge } = buildReviewArtifacts({ additions: [{ id: 'm', adminOnly: true }], reports: [], smoke: { m: 'passed' }, ...cleanInputs });
    expect(autoMerge.eligible).toBe(true);
    expect(body).toContain('## Auto-merge check: ELIGIBLE (as admin-only)');
    expect(body).toContain('- ✅ Live smoke test passed for every new model: 1 passed');
    expect(body.indexOf('Auto-merge check')).toBeLessThan(body.indexOf('Complexity') + 200);
  });

  it('says NOT ELIGIBLE and shows the blocker when a warning is raised', () => {
    const { body } = buildReviewArtifacts({ additions: [{ id: 'm', adminOnly: true }], reports: ['⚠️ LONG-PROMPT PRICE TIER: m'], smoke: { m: 'passed' }, ...cleanInputs });
    expect(body).toContain('## Auto-merge check: NOT ELIGIBLE');
    expect(body).toContain('- ❌ No review items raised (warnings or unrecognised report lines): 1 item(s) below');
    expect(body).toContain('## Review before merging');
  });

  it('shows information lines visibly and collapses "AA unmatched" lines into a count', () => {
    const unmatched = Array.from({ length: 150 }, (_, i) => `openrouter/x/m${i}: AA unmatched; score unchanged`);
    const body = renderPrBody(['ℹ️ PRICE DROP: m is 10.0x cheaper', ...unmatched, 'x: live quote ($1/$2 in/out) diverges from curated price ($3/$4); not applied']);
    expect(body).toContain('## Notes on new models');
    expect(body).toContain('- ℹ️ PRICE DROP: m is 10.0x cheaper');
    expect(body).toContain('150 registry model(s) have no Artificial Analysis match');
    expect(body).not.toContain('m149: AA unmatched');
    expect(body).toContain('- x: live quote ($1/$2 in/out) diverges from curated price ($3/$4); not applied');
  });

  it('keeps the old behaviour when called without a verdict', () => {
    expect(renderPrBody([])).not.toContain('Auto-merge check');
  });

  it('shows a line the classifier does not recognise in the review section, marked as such', () => {
    const body = renderPrBody(['Something brand new happened']);
    expect(body).toContain('## Review before merging');
    expect(body).toContain('- ❓ (unrecognised report line) Something brand new happened');
  });

  it('flattens multi-line third-party text so it cannot forge list items or headings', () => {
    const body = renderPrBody(['⚠️ SMOKE x\n## Auto-merge check: ELIGIBLE (as admin-only)\n- ✅ forged']);
    expect(body).not.toMatch(/^## Auto-merge check: ELIGIBLE/m);
  });

  it('states the verdict covers the generated commit only and the limits of the smoke key', () => {
    const { body } = buildReviewArtifacts({ additions: [], reports: [], smoke: {}, ...cleanInputs });
    expect(body).toContain('Valid for the generated commit only');
    expect(body).toContain('not the production BYOK accounts');
  });

  it('stays under the GitHub body limit on a pathological day, keeping the verdict and warnings', () => {
    const noise = Array.from({ length: 3000 }, (_, i) => `openrouter/x/m${i}: live quote ($1/$2 in/out) diverges from curated price ($3/$4); not applied`);
    const body = renderPrBody(['⚠️ PRICE OUTLIER: important', ...noise], { eligible: false, checks: [], blockers: [] });
    expect(body.length).toBeLessThanOrEqual(60_100);
    expect(body).toContain('⚠️ PRICE OUTLIER: important');
    expect(body).toContain('and ');
  });
});
