import {
  extractOnboardingContext,
  onboardingFacts,
  ONBOARDING_LIST_FIELDS,
  ONBOARDING_SCALAR_FIELDS,
  OnboardingExtractorLlm,
} from '../fathomOnboardingContextExtractor';

const URL = 'https://fathom.video/calls/123';

function fakeLlm(response: unknown): OnboardingExtractorLlm & { calls: number } {
  const llm = {
    calls: 0,
    async generateJson() {
      llm.calls += 1;
      return typeof response === 'function' ? (response as () => unknown)() : response;
    },
  };
  return llm;
}

function f(value: string, kind: 'fact' | 'internal_note' = 'fact', timestampSeconds?: number) {
  return { value, confidence: 0.9, kind, ...(timestampSeconds !== undefined ? { timestampSeconds } : {}) };
}

function validResponse() {
  return {
    companyName: f('Acme', 'fact', 12),
    contactName: f('Jane Doe'),
    contactEmail: f('jane@acme.com'),
    domain: f('acme.com'),
    productCategory: f('Water heaters'),
    icp: f('Homeowners'),
    primaryGtmGoal: f('More booked installs'),
    winMetric: f('20 leads/week'),
    urgency: f('Launch in 2 weeks', 'fact', 300),
    suggestedFirstWinPath: f('Google Search campaign', 'internal_note'),
    channels: [f('Google Ads'), f('Meta')],
    setupBlockers: [f('No pixel access')],
    fitNotes: [f('Probably a great fit for Pro', 'internal_note')],
    featureGapsOrRisks: [],
  };
}

describe('extractOnboardingContext (ENG-2530)', () => {
  it('uses only the injected LLM and returns a typed context with every field', async () => {
    const llm = fakeLlm(validResponse());
    const result = await extractOnboardingContext({ sourceText: 'summary', recordingUrl: URL }, { llm });
    expect(llm.calls).toBe(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const k of ONBOARDING_SCALAR_FIELDS) expect(k in result.context).toBe(true);
    for (const k of ONBOARDING_LIST_FIELDS) expect(Array.isArray(result.context[k])).toBe(true);
    expect(result.context.companyName?.value).toBe('Acme');
  });

  it('attaches the Fathom URL to every field, plus timestamp when available', async () => {
    const result = await extractOnboardingContext({ sourceText: 's', recordingUrl: URL }, { llm: fakeLlm(validResponse()) });
    if (!result.ok) throw new Error('expected ok');
    const fields = [
      ...ONBOARDING_SCALAR_FIELDS.map((k) => result.context[k]).filter(Boolean),
      ...ONBOARDING_LIST_FIELDS.flatMap((k) => result.context[k]),
    ];
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) expect(field!.source.url).toBe(URL);
    expect(result.context.companyName!.source).toEqual({ url: URL, timestampSeconds: 12 });
    expect(result.context.contactName!.source).toEqual({ url: URL });
  });

  it('separates internal/speculative notes from customer-stated facts', async () => {
    const result = await extractOnboardingContext({ sourceText: 's', recordingUrl: URL }, { llm: fakeLlm(validResponse()) });
    if (!result.ok) throw new Error('expected ok');
    expect(result.context.fitNotes[0].kind).toBe('internal_note');
    const factValues = onboardingFacts(result.context).map(([, v]) => v.value);
    expect(factValues).toContain('Acme');
    expect(factValues).not.toContain('Probably a great fit for Pro');
    expect(factValues).not.toContain('Google Search campaign');
  });

  it.each([
    ['non-JSON string', 'not json'],
    ['missing field', (() => { const r: any = validResponse(); delete r.icp; return r; })()],
    ['unknown kind', { ...validResponse(), icp: { value: 'x', confidence: 0.5, kind: 'guess' } }],
    ['confidence out of range', { ...validResponse(), icp: { value: 'x', confidence: 2, kind: 'fact' } }],
    ['list field not array', { ...validResponse(), channels: 'Google' }],
    ['extra field', { ...validResponse(), budget: f('$5k') }],
    ['null response', null],
  ])('malformed LLM output (%s) yields a typed retryable failure, never a partial object', async (_n, resp) => {
    const result = await extractOnboardingContext({ sourceText: 's', recordingUrl: URL }, { llm: fakeLlm(resp) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_llm_output');
    expect(result.error.retryable).toBe(true);
    expect((result as any).context).toBeUndefined();
  });

  it('accepts a JSON string response', async () => {
    const result = await extractOnboardingContext(
      { sourceText: 's', recordingUrl: URL },
      { llm: fakeLlm(JSON.stringify(validResponse())) },
    );
    expect(result.ok).toBe(true);
  });

  it('maps an LLM call error to a retryable llm_call_failed', async () => {
    const llm: OnboardingExtractorLlm = { generateJson: async () => { throw new Error('timeout'); } };
    const result = await extractOnboardingContext({ sourceText: 's', recordingUrl: URL }, { llm });
    expect(result).toEqual({ ok: false, error: { code: 'llm_call_failed', retryable: true, message: 'timeout' } });
  });

  it('is deterministic: same input + same fake response -> identical output', async () => {
    const a = await extractOnboardingContext({ sourceText: 's', recordingUrl: URL }, { llm: fakeLlm(validResponse) });
    const b = await extractOnboardingContext({ sourceText: 's', recordingUrl: URL }, { llm: fakeLlm(validResponse) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
