import {
  registerSpecialist,
  clearSpecialists,
  runSpecialists,
  FieldSpecialist,
} from '../services/enrichmentSpecialists';

describe('enrichmentSpecialists', () => {
  beforeEach(() => clearSpecialists());

  it('returns empty when no specialist matches the field', async () => {
    const r = await runSpecialists(['industry'], {} as any, { userId: 'u1' });
    expect(r.resolvedFields).toEqual({});
    expect(r.resolvedMeta).toEqual({});
    expect(r.sourceContexts).toEqual([]);
  });

  it('runs a registered specialist and returns its value + metadata', async () => {
    const spec: FieldSpecialist = {
      fieldName: 'linkedin_url',
      label: 'unipile-linkedin',
      resolve: async () => ({
        value: 'https://www.linkedin.com/in/jane-doe',
        confidence: 'high',
        source: 'linkedin',
        sourceUrl: 'https://api.unipile.com/profile/jane',
      }),
    };
    registerSpecialist(spec);

    const r = await runSpecialists(['linkedin_url'], {} as any, { userId: 'u1' });
    expect(r.resolvedFields.linkedin_url).toBe('https://www.linkedin.com/in/jane-doe');
    expect(r.resolvedMeta.linkedin_url).toMatchObject({
      source: 'linkedin',
      confidence: 'high',
    });
  });

  it('aggregates sourceContexts per specialist label so verifyCitations can match the quote', async () => {
    registerSpecialist({
      fieldName: 'funding_round',
      label: 'crunchbase-serp',
      resolve: async () => ({ value: 'Series B', confidence: 'high', source: 'web_search', sourceQuote: 'closed Series B round' }),
    });
    registerSpecialist({
      fieldName: 'hq_city',
      label: 'crunchbase-serp',
      resolve: async () => ({ value: 'Palo Alto', confidence: 'high', source: 'web_search', sourceQuote: 'based in Palo Alto' }),
    });

    const r = await runSpecialists(['funding_round', 'hq_city'], {} as any, { userId: 'u1' });
    // Both quotes are deduped under one label entry
    expect(r.sourceContexts.length).toBe(1);
    expect(r.sourceContexts[0]).toContain('closed Series B round');
    expect(r.sourceContexts[0]).toContain('based in Palo Alto');
  });

  it('skips fields whose specialist returns null (e.g. no data)', async () => {
    registerSpecialist({
      fieldName: 'linkedin_url',
      label: 'unipile-linkedin',
      resolve: async () => null,
    });
    const r = await runSpecialists(['linkedin_url'], {} as any, { userId: 'u1' });
    expect(r.resolvedFields).toEqual({});
  });

  it('does not throw if a specialist throws (non-fatal degrade) and reports failure', async () => {
    registerSpecialist({
      fieldName: 'linkedin_url',
      label: 'unipile-linkedin',
      resolve: async () => { throw new Error('API down'); },
    });
    const r = await runSpecialists(['linkedin_url'], {} as any, { userId: 'u1' });
    expect(r.resolvedFields).toEqual({});
    expect(r.failures).toEqual([
      { field: 'linkedin_url', label: 'unipile-linkedin', message: 'API down' },
    ]);
  });

  it('captures non-Error thrown values as a string message', async () => {
    registerSpecialist({
      fieldName: 'linkedin_url',
      label: 'unipile-linkedin',
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      resolve: async () => { throw 'rate-limited'; },
    });
    const r = await runSpecialists(['linkedin_url'], {} as any, { userId: 'u1' });
    expect(r.failures).toEqual([
      { field: 'linkedin_url', label: 'unipile-linkedin', message: 'rate-limited' },
    ]);
  });

  it('returns an empty failures array when nothing throws', async () => {
    registerSpecialist({
      fieldName: 'linkedin_url',
      label: 'unipile-linkedin',
      resolve: async () => null,
    });
    const r = await runSpecialists(['linkedin_url'], {} as any, { userId: 'u1' });
    expect(r.failures).toEqual([]);
  });

  it('runs specialists in parallel for independent fields', async () => {
    let calls = 0;
    const slow = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return null; };
    registerSpecialist({ fieldName: 'a', label: 'spec-a', resolve: slow });
    registerSpecialist({ fieldName: 'b', label: 'spec-b', resolve: slow });

    const t0 = Date.now();
    await runSpecialists(['a', 'b'], {} as any, { userId: 'u1' });
    const elapsed = Date.now() - t0;

    expect(calls).toBe(2);
    expect(elapsed).toBeLessThan(30); // parallel — both 10ms calls overlap
  });
});
