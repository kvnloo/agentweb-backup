import { rejectUncitedWebValues } from '../services/enrichmentV3RealDeps';

/**
 * ENG-122: V3 web-tier extraction must not surface fabricated funding /
 * firmographic figures. A web-tier value with no supporting citation
 * (sourceQuote) was asserted by the LLM from its own training knowledge rather
 * than the provided/searched sources, so it must be dropped (→ null/unknown)
 * rather than persisted as a fact. Mirrors V2's verifyCitations rule.
 */
describe('rejectUncitedWebValues', () => {
  const fv = (value: string, extra?: { sourceQuote?: string; sourceUrl?: string }) => ({ value, ...extra });

  it('drops a funding_stage value that has NO sourceQuote (fabricated figure)', () => {
    const result = rejectUncitedWebValues({ funding_stage: fv('Series C') });
    expect(result.funding_stage).toBeUndefined();
  });

  it('drops a total_funding value with an empty-string sourceQuote', () => {
    const result = rejectUncitedWebValues({ total_funding: fv('$100M', { sourceQuote: '' }) });
    expect(result.total_funding).toBeUndefined();
  });

  it('drops a value whose sourceQuote is whitespace only', () => {
    const result = rejectUncitedWebValues({ arr: fv('$10M', { sourceQuote: '   ' }) });
    expect(result.arr).toBeUndefined();
  });

  it('keeps a funding_stage value that carries a real sourceQuote', () => {
    const result = rejectUncitedWebValues({
      funding_stage: fv('Series B', { sourceQuote: 'raised a $40M Series B led by Accel', sourceUrl: 'https://example.com' }),
    });
    expect(result.funding_stage?.value).toBe('Series B');
  });

  it('drops the uncited field but keeps the cited one in a mixed result', () => {
    const result = rejectUncitedWebValues({
      funding_stage: fv('Series C'),
      industry: fv('Fintech', { sourceQuote: 'Slash is a fintech company for agencies' }),
    });
    expect(result.funding_stage).toBeUndefined();
    expect(result.industry?.value).toBe('Fintech');
  });

  it('exempts linkedin URL fields (already citation-verified against the source)', () => {
    const result = rejectUncitedWebValues({
      linkedin_url: fv('https://www.linkedin.com/in/jane-doe-acme'),
      company_linkedin_url: fv('https://www.linkedin.com/company/acme'),
    });
    expect(result.linkedin_url?.value).toBe('https://www.linkedin.com/in/jane-doe-acme');
    expect(result.company_linkedin_url?.value).toBe('https://www.linkedin.com/company/acme');
  });
});
