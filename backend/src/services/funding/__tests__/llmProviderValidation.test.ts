/**
 * ENG-2105 (A1): checking a customer's key against its provider.
 */
import { isSupportedByokProvider, keyCheckAccepted, validateProviderKey } from '../llmProviderValidation';

const KEY = 'sk-THE-CUSTOMER-KEY-0123456789abcdef';

function fetchReturning(status: number, body = '') {
  return jest.fn(async (_url: string, _init: any) => ({ status, text: async () => body }));
}

describe('validateProviderKey', () => {
  it('sends the key in a header and never in the URL', async () => {
    for (const provider of ['anthropic', 'openai', 'google'] as const) {
      const fetchImpl = fetchReturning(200);
      await validateProviderKey(provider, KEY, fetchImpl);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).not.toContain(KEY);
      expect(JSON.stringify(init.headers)).toContain(KEY);
      expect(init.method).toBe('GET');
    }
  });

  it('calls each provider\'s own models endpoint', async () => {
    const urls: Record<string, string> = {};
    for (const provider of ['anthropic', 'openai', 'google'] as const) {
      const fetchImpl = fetchReturning(200);
      await validateProviderKey(provider, KEY, fetchImpl);
      urls[provider] = new URL(fetchImpl.mock.calls[0][0]).host;
    }
    expect(urls).toEqual({
      anthropic: 'api.anthropic.com',
      openai: 'api.openai.com',
      google: 'generativelanguage.googleapis.com',
    });
  });

  it.each([
    ['anthropic', 200, '', 'ok'],
    ['anthropic', 401, '{"error":{"type":"authentication_error"}}', 'invalid_key'],
    ['anthropic', 403, '', 'insufficient_permissions'],
    ['anthropic', 429, '{"error":{"type":"rate_limit_error"}}', 'rate_limited'],
    ['anthropic', 529, '', 'provider_unreachable'],
    ['openai', 401, '{"error":{"code":"invalid_api_key"}}', 'invalid_key'],
    ['openai', 429, '{"error":{"code":"insufficient_quota"}}', 'quota_exhausted'],
    ['openai', 429, '{"error":{"code":"rate_limit_exceeded"}}', 'rate_limited'],
    ['openai', 403, '', 'insufficient_permissions'],
    ['google', 400, '{"error":{"details":[{"reason":"API_KEY_INVALID"}]}}', 'invalid_key'],
    ['google', 403, '{"error":{"message":"API key not valid. Please pass a valid API key."}}', 'invalid_key'],
    ['google', 403, '{"error":{"status":"PERMISSION_DENIED"}}', 'insufficient_permissions'],
    ['google', 400, '{"error":{"message":"bad request"}}', 'unknown'],
    ['openai', 402, '', 'quota_exhausted'],
    ['openai', 418, '', 'unknown'],
  ] as const)('%s answering %i maps to a fixed result', async (provider, status, body, expected) => {
    expect(await validateProviderKey(provider, KEY, fetchReturning(status, body))).toBe(expected);
  });

  it('reports an unreachable provider without surfacing the failure, which can carry the key', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error(`connect failed for request with header x-api-key: ${KEY}`);
    });
    expect(await validateProviderKey('anthropic', KEY, fetchImpl as any)).toBe('provider_unreachable');
  });

  it('returns only the fixed result even when the provider echoes the key', async () => {
    const result = await validateProviderKey('openai', KEY, fetchReturning(401, `Incorrect API key provided: ${KEY}`));
    expect(result).toBe('invalid_key');
  });

  it('treats ok and rate-limited as an accepted key, and nothing else', () => {
    expect(keyCheckAccepted('ok')).toBe(true);
    expect(keyCheckAccepted('rate_limited')).toBe(true);
    for (const r of ['invalid_key', 'insufficient_permissions', 'quota_exhausted', 'provider_unreachable', 'unknown'] as const) {
      expect(keyCheckAccepted(r)).toBe(false);
    }
  });

  it('knows exactly the supported providers', () => {
    expect(['anthropic', 'openai', 'google'].every(isSupportedByokProvider)).toBe(true);
    for (const other of ['xai', 'Anthropic', '', null, 7, undefined]) expect(isSupportedByokProvider(other)).toBe(false);
  });
});
