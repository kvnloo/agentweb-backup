import { LLM_MODEL_REGISTRY } from '../llmModelRegistry';
import { deriveDominanceLegacyIds, inferFamily, scheduleBackupModels } from '../modelSupersession';
import { cleanModelName, discoverNewModels, refreshModelCatalog, refreshScores } from '../modelCatalogRefresh';
import { MODEL_PRICING } from '../../../utils/llmPricing';
import { patchObject, mergeSetLiteral } from '../../../scripts/refreshModelCatalog';

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
    // Unreviewed models must never reach customers on their own (ENG-2293).
    expect(additions[0].config.adminOnly).toBe(true);
    expect(discoverNewModels({ data: [{ ...row, pricing: { prompt: '0.00000029', completion: '0.000003' } }] })[0].price.inPerM).toBe(0.29);
    // A fixed local registry, not the live LLM_MODEL_REGISTRY — these assertions pin
    // exact qualityScore/qualityScoreSource matching behavior, which the live import
    // drifts whenever the catalog refresh itself updates a real score (ENG-2293).
    const scoreRegistry = {
      [grok[0]]: { client: null, supportsTemperature: true, provider: 'xai' as const, qualityScore: 10,
        qualityScoreSource: 'Artificial Analysis Intelligence Index v4.3.2, snapshot 2026-09-22, Grok 4.6, high' },
      [grok[1]]: { client: null, supportsTemperature: true, provider: 'xai' as const, qualityScore: 20,
        qualityScoreSource: 'Artificial Analysis Intelligence Index v4.3.2, snapshot 2026-09-22, Grok 4.7, xhigh' },
    };
    const valid = { slug: 'grok-4.6', model_creator: { slug: 'x-ai' }, evaluations: { artificial_analysis_intelligence_index: 45 } };
    const scores = refreshScores(scoreRegistry, { data: [null, valid, { ...valid, evaluations: { artificial_analysis_intelligence_index: '99' } }] }, '2026-09-24');
    expect(scores.changes[grok[0]].qualityScore).toBe(45);
    expect(scores.changes[grok[1]]).toBeUndefined();
    expect(refreshScores(scoreRegistry, { data: [{ ...valid, slug: 'grok-4-6-high', name: 'Grok 4.6 (high)' }] }, '2026-09-24').changes[grok[0]].qualityScore).toBe(45);
    expect(refreshScores(scoreRegistry, { data: [valid, valid] }, '2026-09-24').changes).toEqual({});
  });
  it('matches the 0423 and 0813 DeepSeek V4 Pro entries to their own AA rows, not the bare-name row (ENG-2293)', () => {
    // AA's bare `deepseek-v4-pro` slug names the 0813 release; OpenRouter's bare
    // `deepseek-v4-pro` is the 0423 release (AA: `deepseek-v4-pro-0424`). Matching
    // by bare name wrote 0813's score (36) onto the 0423 entry (true: 30) every run.
    const old = 'openrouter/deepseek/deepseek-v4-pro', ga = 'openrouter/deepseek/deepseek-v4-pro-0813';
    const reg = {
      [old]: { client: null, supportsTemperature: true, provider: 'deepseek' as const, qualityScore: 36, qualityScoreSource: 'stale' },
      [ga]: { client: null, supportsTemperature: true, provider: 'deepseek' as const },
    };
    const aa = (slug: string, score: number) => ({ slug, model_creator: { slug: 'deepseek' }, evaluations: { artificial_analysis_intelligence_index: score } });
    const { changes } = refreshScores(reg, { data: [aa('deepseek-v4-pro', 36), aa('deepseek-v4-pro-0424', 30)] }, '2026-10-07');
    expect(changes[old].qualityScore).toBe(30);
    expect(changes[old].qualityScoreSource).toContain('deepseek-v4-pro-0424');
    expect(changes[ga].qualityScore).toBe(36);
    // Idempotent once correct: the next daily run must not flip the old entry back.
    const settled = { [old]: { ...reg[old], qualityScore: 30 }, [ga]: { ...reg[ga], qualityScore: 36 } };
    expect(refreshScores(settled, { data: [aa('deepseek-v4-pro', 36), aa('deepseek-v4-pro-0424', 30)] }, '2026-10-07').changes).toEqual({});
    // A missing slug is a loud "unmatched", never a silent wrong match.
    expect(refreshScores(settled, { data: [aa('deepseek-v4-pro', 36)] }, '2026-10-07').reports.join()).toContain(`${old}: AA unmatched`);
  });
  it('merges additions into an override Set regardless of existing quote style, and is idempotent (ENG-2293)', () => {
    const singleQuoted = "const explicitCacheOverrides = new Set(['gpt-4o', 'openrouter/anthropic/claude-fable-5.1']);";
    const merged = mergeSetLiteral(singleQuoted, 'explicitCacheOverrides', ['openrouter/new/model-x']);
    expect(merged).toContain("'gpt-4o'");
    expect(merged).toContain("'openrouter/anthropic/claude-fable-5.1'");
    expect(merged).toContain("'openrouter/new/model-x'");
    // A quote-only extractor would silently DROP these two on a double-quoted line —
    // this is the exact regression this test locks in (ENG-2293 second review pass).
    const doubleQuoted = 'const explicitCacheOverrides = new Set(["gpt-4o", "openrouter/anthropic/claude-fable-5.1"]);';
    const mergedFromDoubleQuoted = mergeSetLiteral(doubleQuoted, 'explicitCacheOverrides', ['openrouter/new/model-x']);
    expect(mergedFromDoubleQuoted).toContain("'gpt-4o'");
    expect(mergedFromDoubleQuoted).toContain("'openrouter/anthropic/claude-fable-5.1'");
    expect(mergedFromDoubleQuoted).toContain("'openrouter/new/model-x'");
    // Re-running on the already-merged output must not duplicate entries.
    const twice = mergeSetLiteral(merged, 'explicitCacheOverrides', ['openrouter/new/model-x']);
    expect(twice).toBe(merged);
  });
  it('flags a wildly mispriced addition as a loud warning, never a blocking failure (ENG-2293 follow-up)', async () => {
    const outlierRow = { ...row, id: 'x-ai/grok-4.9', pricing: { prompt: '0.0001', completion: '0.0003' } }; // $100/$300 per M — absurd vs grok's real ~$2-6 range
    const request = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [outlierRow] }) });
    const plan = await refreshModelCatalog({ fetch: request, aaApiKey: '', additionIds: ['openrouter/x-ai/grok-4.9'] });
    expect(plan.additions).toContain('openrouter/x-ai/grok-4.9');
    expect(plan.reports.some(r => r.includes('PRICE OUTLIER') && r.includes('openrouter/x-ai/grok-4.9'))).toBe(true);
  });
  it('reports a much CHEAPER addition as information, not a warning (generation-over-generation drop)', async () => {
    const cheapRow = { ...row, id: 'x-ai/grok-4.9', pricing: { prompt: '0.0000001', completion: '0.0000003' } }; // ~20x under grok's ~$2-6
    const request = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [cheapRow] }) });
    const plan = await refreshModelCatalog({ fetch: request, aaApiKey: '', additionIds: ['openrouter/x-ai/grok-4.9'] });
    expect(plan.reports.some(r => r.startsWith('⚠️ PRICE OUTLIER'))).toBe(false);
    expect(plan.reports.some(r => r.startsWith('ℹ️ PRICE DROP') && r.includes('openrouter/x-ai/grok-4.9'))).toBe(true);
  });
  it('still warns when a free ($0) quote lands against paid siblings', async () => {
    const freeRow = { ...row, id: 'x-ai/grok-4.9', pricing: { prompt: '0', completion: '0' } };
    const request = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [freeRow] }) });
    const plan = await refreshModelCatalog({ fetch: request, aaApiKey: '', additionIds: ['openrouter/x-ai/grok-4.9'] });
    expect(plan.reports.some(r => r.startsWith('⚠️ PRICE OUTLIER'))).toBe(true);
  });
  it('warns about a long-prompt price tier and lists what a human must set before customer exposure', async () => {
    const tiered = { ...row, id: 'x-ai/grok-4.9', name: 'xAI: Grok 4.9',
      pricing: { prompt: '0.000002', completion: '0.000006', overrides: [{ min_prompt_tokens: 100000, prompt: '0.00001', completion: '0.00003' }] },
      supported_parameters: ['tools', 'temperature', 'reasoning_effort'],
      architecture: { output_modalities: ['text'], input_modalities: ['text', 'image'] } };
    const request = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [tiered] }) });
    const plan = await refreshModelCatalog({ fetch: request, aaApiKey: '', additionIds: ['openrouter/x-ai/grok-4.9'] });
    expect(plan.reports.some(r => r.startsWith('⚠️ LONG-PROMPT PRICE TIER') && r.includes('5.0x'))).toBe(true);
    const exposure = plan.reports.find(r => r.startsWith('ℹ️ BEFORE CUSTOMER EXPOSURE'))!;
    expect(exposure).toContain('description and tier');
    expect(exposure).toContain('accepts images');
    expect(exposure).toContain('reasoning_effort');
    // The registry entry itself stays admin-only and carries the cleaned name.
    expect(plan.registryChanges['openrouter/x-ai/grok-4.9']).toMatchObject({ adminOnly: true, name: 'Grok 4.9' });
  });
  it('notes time-of-day price windows on an existing model instead of reporting plain drift', async () => {
    const windowed = { ...row, id: 'x-ai/grok-4.7', pricing: { prompt: '0.000001', completion: '0.000003',
      overrides: [{ utc_days: ['monday'], prompt: '0.000002', completion: '0.000006' }] } };
    const request = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [windowed] }) });
    const plan = await refreshModelCatalog({ fetch: request, aaApiKey: '' });
    expect(plan.reports.some(r => r.startsWith('openrouter/x-ai/grok-4.7:') && r.includes('time-of-day price windows'))).toBe(true);
  });
  it('keeps a NEW model\'s own "no Artificial Analysis match" line visible as information', async () => {
    const newRow = { ...row, id: 'x-ai/grok-4.9', pricing: { prompt: '0.000002', completion: '0.000006' } };
    const aa = { data: [{ slug: 'something-else', model_creator: { slug: 'x-ai' }, evaluations: { artificial_analysis_intelligence_index: 40 } }] };
    const plan = await refreshModelCatalog({ catalog: { data: [newRow] }, aa, additionIds: ['openrouter/x-ai/grok-4.9'] });
    expect(plan.reports.some(r => r.startsWith('ℹ️ AA SCORE: openrouter/x-ai/grok-4.9'))).toBe(true);
    expect(plan.reports.some(r => r === 'openrouter/x-ai/grok-4.9: AA unmatched; score unchanged')).toBe(false);
  });
  it('strips the "<Vendor>: " prefix from OpenRouter display names', () => {
    expect(cleanModelName('Anthropic: Claude Haiku 5.5')).toBe('Claude Haiku 5.5');
    expect(cleanModelName('Z.ai: GLM 5.3')).toBe('GLM 5.3');
    expect(cleanModelName('Grok 4.8')).toBe('Grok 4.8');
    expect(cleanModelName('Mistral: ')).toBe('Mistral:'); // nothing after the colon: keep it
  });
  it('does not flag an addition priced in line with its family', async () => {
    const normalRow = { ...row, id: 'x-ai/grok-4.9', pricing: { prompt: '0.000002', completion: '0.000006' } }; // in grok's real range
    const request = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [normalRow] }) });
    const plan = await refreshModelCatalog({ fetch: request, aaApiKey: '', additionIds: ['openrouter/x-ai/grok-4.9'] });
    expect(plan.additions).toContain('openrouter/x-ai/grok-4.9');
    expect(plan.reports.some(r => r.includes('PRICE OUTLIER'))).toBe(false);
  });
  it('does not flag a free addition matching a free family as an outlier (ratio must not force Infinity at a zero baseline)', async () => {
    const zeroPrices = { ...MODEL_PRICING, [grok[0]]: { inPerM: 0, outPerM: 0 }, [grok[1]]: { inPerM: 0, outPerM: 0 } };
    const freeRow = { ...row, id: 'x-ai/grok-4.95', pricing: { prompt: '0', completion: '0' } };
    const request = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [freeRow] }) });
    const plan = await refreshModelCatalog({ fetch: request, aaApiKey: '', prices: zeroPrices, additionIds: ['openrouter/x-ai/grok-4.95'] });
    expect(plan.additions).toContain('openrouter/x-ai/grok-4.95');
    expect(plan.reports.some(r => r.includes('PRICE OUTLIER'))).toBe(false);
  });
  it('compares a new addition against its closest family tier, not a skewed average (ENG-2293 second review pass)', async () => {
    // Real risk found on review: a family can legitimately span tiers under one
    // name — gpt-sol's two correctly-priced members alone already span 2.8x. A
    // flat average baseline would false-flag a brand new, normal tier member;
    // comparing against the closest sibling must not.
    const tieredPrices = { ...MODEL_PRICING, [grok[0]]: { inPerM: 12, outPerM: 12 }, [grok[1]]: { inPerM: 4, outPerM: 4 } };
    const newRow = { ...row, id: 'x-ai/grok-4.95', pricing: { prompt: '0.000002', completion: '0.000002' } }; // blended $2/M
    const request = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [newRow] }) });
    const plan = await refreshModelCatalog({ fetch: request, aaApiKey: '', prices: tieredPrices, additionIds: ['openrouter/x-ai/grok-4.95'] });
    expect(plan.additions).toContain('openrouter/x-ai/grok-4.95');
    // Family average is (12+4)/2=8 — $2/M is 4x off that (would false-flag).
    // Closest sibling is $4/M — $2/M is only 2x off that — correctly not flagged.
    expect(plan.reports.some(r => r.includes('PRICE OUTLIER'))).toBe(false);
  });
  it('patches only requested members and is idempotent', () => {
    const source = "export const X = { /* preserve */ 'a': 1, 'b': 2 };";
    const patched = patchObject(source, 'X', { a: 3, c: 4 });
    expect(patched).toContain("/* preserve */ 'a': 3, 'b': 2");
    expect(patchObject(patched, 'X', { a: 3, c: 4 })).toBe(patched);
  });
});
