import { normalizeOpenRouterCatalog, normalizeOpenRouterCatalogEntry } from '../openRouterCatalog';

const sonnet = {
  id: 'anthropic/claude-sonnet-5',
  name: 'Anthropic: Claude Sonnet 5',
  context_length: 1000000,
  supported_parameters: ['tools', 'temperature', 'max_tokens'],
  architecture: { input_modalities: ['text', 'image'] },
  pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003', input_cache_write: '0.00000375' },
};

describe('normalizeOpenRouterCatalogEntry (ENG-1689)', () => {
  it('converts per-token pricing to per-1M and maps capabilities', () => {
    const r = normalizeOpenRouterCatalogEntry(sonnet);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidate).toMatchObject({
      modelId: 'openrouter/anthropic/claude-sonnet-5',
      publisher: 'anthropic',
      contextLength: 1000000,
      supportsTemperature: true,
      supportsTools: true,
      advertisesImageInput: true,
      price: { inPerM: 3, outPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
    });
  });

  it('never enables a discovered model (ENG-1606 approval gate)', () => {
    const r = normalizeOpenRouterCatalogEntry(sonnet);
    expect(r.ok && r.candidate.enabled).toBe(false);
  });

  it('rejects untracked publishers, missing/invalid and zero pricing', () => {
    expect(normalizeOpenRouterCatalogEntry({ ...sonnet, id: 'randolab/foo' })).toMatchObject({ ok: false, reason: 'untracked publisher randolab' });
    expect(normalizeOpenRouterCatalogEntry({ ...sonnet, pricing: { prompt: '0.000003' } })).toMatchObject({ ok: false });
    expect(normalizeOpenRouterCatalogEntry({ ...sonnet, pricing: { prompt: '-1', completion: '0.1' } })).toMatchObject({ ok: false });
    expect(normalizeOpenRouterCatalogEntry({ ...sonnet, pricing: { prompt: '0', completion: '0' } })).toMatchObject({ ok: false, reason: 'zero pricing' });
    expect(normalizeOpenRouterCatalogEntry({ ...sonnet, id: '../etc' })).toMatchObject({ ok: false, reason: 'invalid id' });
  });

  it('omits absent cache prices and capabilities', () => {
    const r = normalizeOpenRouterCatalogEntry({ id: 'openai/gpt-x', pricing: { prompt: '0.000001', completion: '0.000002' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidate.price).toEqual({ inPerM: 1, outPerM: 2 });
    expect(r.candidate).toMatchObject({ supportsTemperature: false, supportsTools: false, contextLength: null, name: 'openai/gpt-x' });
  });
});

describe('normalizeOpenRouterCatalog', () => {
  it('splits candidates and rejections and dedupes ids', () => {
    const out = normalizeOpenRouterCatalog({ data: [sonnet, sonnet, { id: 'meta-llama/x', pricing: {} }] });
    expect(out.candidates).toHaveLength(1);
    expect(out.rejected.map(r => r.reason)).toEqual(['duplicate id', 'untracked publisher meta-llama']);
  });

  it('tolerates a malformed body', () => {
    expect(normalizeOpenRouterCatalog({} as any)).toEqual({ candidates: [], rejected: [] });
  });
});
