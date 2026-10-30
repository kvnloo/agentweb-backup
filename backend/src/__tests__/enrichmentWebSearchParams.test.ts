import { parseWebSearchParams } from '../services/enrichmentV3RealDeps';

describe('CRM_ENRICH_V3_WEB_SEARCH_PARAMS parsing (ENG-2720)', () => {
  beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('leaves OpenRouter defaults when unset or blank', () => {
    expect(parseWebSearchParams(undefined)).toBeUndefined();
    expect(parseWebSearchParams('')).toBeUndefined();
    expect(parseWebSearchParams('   ')).toBeUndefined();
  });

  it('accepts the documented limits', () => {
    expect(parseWebSearchParams('{"max_uses":2,"engine":"parallel","max_results":3,"search_context_size":"low"}'))
      .toEqual({ max_uses: 2, engine: 'parallel', max_results: 3, search_context_size: 'low' });
  });

  it('drops unknown keys and bad values instead of sending them to the provider', () => {
    expect(parseWebSearchParams('{"max_uses":0,"max_results":"3","engine":"bing","evil":1,"max_total_results":5}'))
      .toEqual({ max_total_results: 5 });
  });

  it('ignores invalid JSON and non-objects', () => {
    expect(parseWebSearchParams('{nope')).toBeUndefined();
    expect(parseWebSearchParams('[1,2]')).toBeUndefined();
    expect(parseWebSearchParams('"parallel"')).toBeUndefined();
  });
});
