import type { CompetitorKeyword, KeywordDataProvider, KeywordMetrics } from './types';

/** Deterministic 32-bit FNV-1a hash so fixture numbers are stable per input. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic fixture provider. Makes no network call, needs no credential,
 * incurs no spend. For tests and dark wiring only — never customer-facing.
 */
export class MockKeywordDataProvider implements KeywordDataProvider {
  readonly id = 'mock';

  async getKeywordMetrics(keywords: string[], locale: string): Promise<KeywordMetrics[]> {
    return keywords.map((keyword) => {
      const h = hash(`${locale}|${keyword}`);
      return {
        keyword,
        locale,
        searchVolume: (h % 50_000) + 10,
        difficulty: h % 101,
        cpcUsd: Math.round(((h >>> 8) % 2_000) + 5) / 100,
      };
    });
  }

  async getCompetitorKeywords(domain: string, locale: string): Promise<CompetitorKeyword[]> {
    const h = hash(`${locale}|${domain}`);
    return [0, 1, 2].map((i) => ({
      keyword: `${domain.split('.')[0]} keyword ${i + 1}`,
      position: ((h >>> i) % 20) + 1,
      searchVolume: ((h >>> (i + 4)) % 10_000) + 10,
    }));
  }
}
