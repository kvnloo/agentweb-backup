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

  it('caps max_results at 25 so an out-of-range value is not sent on every web-tier call', () => {
    expect(parseWebSearchParams('{"max_results":25}')).toEqual({ max_results: 25 });
    expect(parseWebSearchParams('{"max_results":26}')).toBeUndefined();
    expect(parseWebSearchParams('{"max_results":50,"engine":"parallel"}')).toEqual({ engine: 'parallel' });
  });

  it('drops prototype-pollution style and injection keys without touching Object.prototype', () => {
    const hostile = '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"toString":"x","type":"evil","tools":[],"model":"x","parameters":{"engine":"exa"},"engine":"parallel"}';
    expect(parseWebSearchParams(hostile)).toEqual({ engine: 'parallel' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });

  it('ignores invalid JSON and non-objects', () => {
    expect(parseWebSearchParams('{nope')).toBeUndefined();
    expect(parseWebSearchParams('[1,2]')).toBeUndefined();
    expect(parseWebSearchParams('"parallel"')).toBeUndefined();
  });
});
