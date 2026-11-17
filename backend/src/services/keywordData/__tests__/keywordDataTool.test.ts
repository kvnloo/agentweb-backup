import {
  MAX_KEYWORDS_PER_REQUEST,
  NOT_CONNECTED_MESSAGE,
  resolveKeywordDataProvider,
  runKeywordDataTool,
} from '../keywordDataTool';
import { MockKeywordDataProvider } from '../mockProvider';

const credentialResolver = jest.fn(async () => null);
const ctx = { orgId: 'org-1', provider: new MockKeywordDataProvider() };

describe('keyword data tool (ENG-3139)', () => {
  it('returns not_connected without throwing or fabricating when no provider is configured', async () => {
    expect(resolveKeywordDataProvider({ credentialResolver }, undefined)).toBeNull();
    expect(resolveKeywordDataProvider({ credentialResolver }, '')).toBeNull();
    expect(resolveKeywordDataProvider({ credentialResolver }, 'semrush')).toBeNull();
    const res = await runKeywordDataTool(
      { action: 'keyword_metrics', keywords: ['shoes'] },
      { orgId: 'org-1', provider: null },
    );
    expect(res).toEqual({ ok: false, error: 'not_connected', message: NOT_CONNECTED_MESSAGE });
  });

  it('selects the mock provider from config', () => {
    expect(resolveKeywordDataProvider({ credentialResolver }, 'MOCK')?.id).toBe('mock');
    expect(credentialResolver).not.toHaveBeenCalled();
  });

  it('mock metrics have the contract shape and are deterministic', async () => {
    const a = await runKeywordDataTool({ action: 'keyword_metrics', keywords: ['running shoes', 'trail'] }, ctx);
    const b = await runKeywordDataTool({ action: 'keyword_metrics', keywords: ['running shoes', 'trail'] }, ctx);
    expect(a).toEqual(b);
    if (!a.ok) throw new Error('expected ok');
    expect(a.provider).toBe('mock');
    expect(a.metrics).toHaveLength(2);
    for (const m of a.metrics!) {
      expect(m.locale).toBe('en-US');
      expect(Number.isInteger(m.searchVolume)).toBe(true);
      expect(m.difficulty).toBeGreaterThanOrEqual(0);
      expect(m.difficulty).toBeLessThanOrEqual(100);
      expect(m.cpcUsd).toBeGreaterThan(0);
    }
  });

  it('mock competitor keywords have the contract shape', async () => {
    const res = await runKeywordDataTool({ action: 'competitor_keywords', domain: 'Example.com' }, ctx);
    if (!res.ok) throw new Error('expected ok');
    expect(res.competitorKeywords!.length).toBeGreaterThan(0);
    for (const k of res.competitorKeywords!) {
      expect(typeof k.keyword).toBe('string');
      expect(k.position).toBeGreaterThanOrEqual(1);
    }
  });

  it('rejects an empty keyword list', async () => {
    const res = await runKeywordDataTool({ action: 'keyword_metrics', keywords: ['', '  '] }, ctx);
    expect(res).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('caps an oversized batch and flags truncation', async () => {
    const keywords = Array.from({ length: MAX_KEYWORDS_PER_REQUEST + 25 }, (_, i) => `kw ${i}`);
    const res = await runKeywordDataTool({ action: 'keyword_metrics', keywords }, ctx);
    if (!res.ok) throw new Error('expected ok');
    expect(res.metrics).toHaveLength(MAX_KEYWORDS_PER_REQUEST);
    expect(res.truncated).toBe(true);
  });

  it('rejects a malformed domain', async () => {
    const res = await runKeywordDataTool({ action: 'competitor_keywords', domain: 'https://x' }, ctx);
    expect(res).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('turns provider failures into a result, not a throw', async () => {
    const failing = {
      id: 'boom',
      getKeywordMetrics: async () => {
        throw new Error('upstream 500');
      },
      getCompetitorKeywords: async () => [],
    };
    const res = await runKeywordDataTool(
      { action: 'keyword_metrics', keywords: ['a'] },
      { orgId: 'org-1', provider: failing },
    );
    expect(res).toEqual({ ok: false, error: 'provider_error', message: 'upstream 500' });
  });
});
