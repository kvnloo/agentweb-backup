import { LLM_MODEL_REGISTRY } from '../llmModelRegistry';
import { deriveDominanceLegacyIds, inferFamily, scheduleBackupModels } from '../modelSupersession';
import { discoverNewModels, refreshModelCatalog, refreshScores } from '../modelCatalogRefresh';
import { patchObject } from '../../../scripts/refreshModelCatalog';

const grok = ['openrouter/x-ai/grok-4.6', 'openrouter/x-ai/grok-4.7'];
const candidates = grok.map(id => ({ id, ...LLM_MODEL_REGISTRY[id] }));
const row = { id: 'x-ai/grok-4.8', name: 'Grok 4.8', pricing: { prompt: '0.000001', completion: '0.000003' },
  supported_parameters: ['tools', 'temperature'], architecture: { output_modalities: ['text'] } };

describe('catalog critical invariants', () => {
  it('Grok 4.7 supersedes 4.6 at actual prices; backups include its successor', () => {
    expect([...deriveDominanceLegacyIds(candidates)]).toEqual([grok[0]]);
    expect(scheduleBackupModels([grok[0]], grok)).toEqual([grok[1]]);
    expect(scheduleBackupModels([grok[0]], [grok[0]])).toEqual([grok[0]]);
    expect(LLM_MODEL_REGISTRY[grok[0]]).toBeDefined(); // remains callable
  });
  it.each([
    ['openrouter/anthropic/claude-opus-5.5', 'anthropic.claude-sonnet-5'],
    ['openrouter/deepseek/deepseek-v4-pro', 'openrouter/deepseek/deepseek-v4-flash'],
  ])('does not conflate distinct lines: %s / %s', (a, b) => {
    expect(deriveDominanceLegacyIds([{ id: a, cost: 1, qualityScore: 99 }, { id: b, cost: 10, qualityScore: 10 }]).size).toBe(0);
  });
  it('infers versions consistently and respects explicit families', () => {
    expect(inferFamily(grok[0])).toBe('grok');
    expect(inferFamily('openrouter/openai/gpt-5.6-sol')).toBe(inferFamily('openrouter/openai/gpt-6-sol'));
    expect(inferFamily(grok[0], { family: 'custom' })).toBe('custom');
    expect(inferFamily('openrouter/qwen/qwen3-32b')).not.toBe(inferFamily('openrouter/qwen/qwen3-235b'));
  });
  it.each([
    [9.5, 41, false], [9.49, 40, true], [10, 41.01, true],
    [10.01, 45, false], [8, 39.9, false], [10, 40, false], [NaN, 50, false],
  ])('ties and regressions: cost %s quality %s => legacy %s', (cost, qualityScore, expected) => {
    const result = deriveDominanceLegacyIds([
      { id: 'a', family: 'test', cost: 10, qualityScore: 40 },
      { id: 'b', family: 'test', cost, qualityScore },
    ]);
    expect(result.has('a')).toBe(expected);
  });
  it('missing AA key causes no score changes and no AA request', async () => {
    const request = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    const plan = await refreshModelCatalog({ fetch: request, aaApiKey: '' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(Object.values(plan.registryChanges).every(p => p.qualityScore === undefined && p.qualityScoreSource === undefined)).toBe(true);
    expect(plan.reports.join()).toContain('scores unchanged');
  });
  it('validates each external row, preserves unknown scores, and converts prices to $/M', () => {
    const additions = discoverNewModels({ data: [null, 'bad', row, { ...row, id: 'unknown/grok-4.8' },
      { ...row, id: 'x-ai/grok-4.9', pricing: { prompt: '', completion: 'NaN' } }] });
    expect(additions.map(m => m.id)).toEqual(['openrouter/x-ai/grok-4.8']);
    expect(additions[0].price).toEqual({ inPerM: 1, outPerM: 3 });
    expect(discoverNewModels({ data: [{ ...row, pricing: { prompt: '0.00000029', completion: '0.000003' } }] })[0].price.inPerM).toBe(0.29);
    const valid = { slug: 'grok-4.6', model_creator: { slug: 'x-ai' }, evaluations: { artificial_analysis_intelligence_index: 45 } };
    const scores = refreshScores(LLM_MODEL_REGISTRY, { data: [null, valid, { ...valid, evaluations: { artificial_analysis_intelligence_index: '99' } }] }, '2026-09-24');
    expect(scores.changes[grok[0]].qualityScore).toBe(45);
    expect(scores.changes[grok[1]]).toBeUndefined();
    expect(refreshScores(LLM_MODEL_REGISTRY, { data: [{ ...valid, slug: 'grok-4-6-high', name: 'Grok 4.6 (high)' }] }, '2026-09-24').changes[grok[0]].qualityScore).toBe(45);
    expect(refreshScores(LLM_MODEL_REGISTRY, { data: [valid, valid] }, '2026-09-24').changes).toEqual({});
  });
  it('patches only requested members and is idempotent', () => {
    const source = "export const X = { /* preserve */ 'a': 1, 'b': 2 };";
    const patched = patchObject(source, 'X', { a: 3, c: 4 });
    expect(patched).toContain("/* preserve */ 'a': 3, 'b': 2");
    expect(patchObject(patched, 'X', { a: 3, c: 4 })).toBe(patched);
  });
});
