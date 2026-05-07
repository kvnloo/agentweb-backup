import { extractIcpFilters } from '../services/icpPersonaFilterExtractor';
import type { ICPPersona } from '../services/icpStatusService';

const persona = (over: Partial<ICPPersona> = {}): ICPPersona => ({
  name: 'Mid-market RevOps Leaders',
  pain: 'Manual data hand-offs',
  desire: 'Unified pipeline visibility',
  objection: 'Switching cost',
  meta_targeting_brief:
    'Mid-market RevOps managers at SaaS companies in North America who use Salesforce and need pipeline visibility.',
  ...over,
});

describe('extractIcpFilters', () => {
  it('extracts title from the last 2 words of the persona name', () => {
    const r = extractIcpFilters(persona());
    expect(r.title).toBe('RevOps Leaders');
  });

  it('uses the full name when the persona name is 1-2 words long', () => {
    const r = extractIcpFilters(persona({ name: 'CTO' }));
    expect(r.title).toBe('CTO');
    const r2 = extractIcpFilters(persona({ name: 'VP Sales' }));
    expect(r2.title).toBe('VP Sales');
  });

  it('uses the first sentence of the brief as keywords', () => {
    const r = extractIcpFilters(persona({
      meta_targeting_brief: 'Senior PMs at Series B SaaS. They are usually overloaded with roadmap work. They prioritise velocity.',
    }));
    expect(r.keywords).toBe('Senior PMs at Series B SaaS.');
  });

  it('truncates keywords to 200 chars', () => {
    const long = 'A'.repeat(500);
    const r = extractIcpFilters(persona({ meta_targeting_brief: long }));
    expect(r.keywords!.length).toBeLessThanOrEqual(200);
    expect(r.keywords!.endsWith('...')).toBe(true);
  });

  it('extracts location from "in <Region>" idiom', () => {
    expect(extractIcpFilters(persona()).location).toBe('North America');
    expect(extractIcpFilters(persona({
      meta_targeting_brief: 'Founders in San Francisco Bay Area building AI tooling.',
    })).location).toBe('San Francisco Bay Area');
  });

  it('extracts industry from "<Industry> companies" idiom or bare token', () => {
    expect(extractIcpFilters(persona()).industry).toBe('SaaS');
    expect(extractIcpFilters(persona({
      meta_targeting_brief: 'Engineering managers at FinTech companies in Europe.',
    })).industry).toBe('FinTech');
    expect(extractIcpFilters(persona({
      meta_targeting_brief: 'A typical HealthTech founder running a small team.',
    })).industry).toBe('HealthTech');
  });

  it('returns no industry/location when brief lacks recognisable idioms', () => {
    const r = extractIcpFilters(persona({
      meta_targeting_brief: 'Builders who care about speed and design.',
    }));
    expect(r.industry).toBeUndefined();
    expect(r.location).toBeUndefined();
  });

  it('falls back to name-as-keywords when brief is empty', () => {
    const r = extractIcpFilters(persona({ meta_targeting_brief: '' }));
    expect(r.keywords).toBe('Mid-market RevOps Leaders');
    expect(r.location).toBeUndefined();
    expect(r.industry).toBeUndefined();
  });

  it('returns an empty object when persona has neither name nor brief', () => {
    const r = extractIcpFilters({
      name: '',
      pain: '',
      desire: '',
      objection: '',
      meta_targeting_brief: '',
    });
    expect(r).toEqual({});
  });

  it('extracts location from "based in <City>" idiom', () => {
    expect(extractIcpFilters(persona({
      meta_targeting_brief: 'Founders based in Berlin building dev tools.',
    })).location).toBe('Berlin');
  });

  it('matches additional major cities', () => {
    for (const city of ['Tokyo', 'Singapore', 'Tel Aviv', 'Boston']) {
      const r = extractIcpFilters(persona({
        meta_targeting_brief: `Engineers in ${city} working on infra.`,
      }));
      expect(r.location).toBe(city);
    }
  });

  it('extracts B2B SaaS as industry (multi-word)', () => {
    const r = extractIcpFilters(persona({
      meta_targeting_brief: 'CTOs at B2B SaaS startups in North America.',
    }));
    expect(r.industry).toBe('B2B SaaS');
  });

  it('extracts DTC and Web3 as industries', () => {
    expect(extractIcpFilters(persona({
      meta_targeting_brief: 'Founders running DTC brands on Shopify.',
    })).industry).toBe('DTC');
    expect(extractIcpFilters(persona({
      meta_targeting_brief: 'Engineers building Web3 wallets.',
    })).industry).toBe('Web3');
  });
});
