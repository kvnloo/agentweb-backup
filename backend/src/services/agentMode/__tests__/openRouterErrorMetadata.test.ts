import { normalizeOpenRouterErrorMetadata, UPSTREAM_ERROR_LOG_MAX_CHARS } from '../openRouterMetadata';

// ENG-2721: the real prod shape of an OpenRouter "400 Provider returned error"
// (openai SDK APIError: body.error lands on `error.error`).
function providerError(metadata: unknown): any {
  return Object.assign(new Error('400 Provider returned error'), {
    status: 400,
    error: { message: 'Provider returned error', code: 400, metadata },
  });
}

describe('normalizeOpenRouterErrorMetadata (ENG-2721)', () => {
  it('surfaces provider_name and the raw upstream reason from a provider 400', () => {
    const out = normalizeOpenRouterErrorMetadata(providerError({
      provider_name: 'Google AI Studio',
      raw: '{"error":{"code":400,"message":"function_declarations: too many"}}',
    }));
    expect(out.provider).toBe('Google AI Studio');
    expect(out.upstream_error).toContain('function_declarations: too many');
  });

  it('serializes a non-string raw body', () => {
    const out = normalizeOpenRouterErrorMetadata(providerError({ raw: { error: { message: 'bad schema' } } }));
    expect(out.upstream_error).toBe('{"error":{"message":"bad schema"}}');
  });

  it('bounds the upstream body', () => {
    const out = normalizeOpenRouterErrorMetadata(providerError({ raw: 'x'.repeat(5000) }));
    expect(out.upstream_error).toHaveLength(UPSTREAM_ERROR_LOG_MAX_CHARS);
  });

  it('omits upstream_error and keeps provider undefined when no metadata', () => {
    const out = normalizeOpenRouterErrorMetadata(new Error('boom'));
    expect(out).toEqual({ provider: undefined, is_byok: undefined });
  });

  it('still prefers the endpoints-selected provider when present', () => {
    const out = normalizeOpenRouterErrorMetadata(providerError({
      provider_name: 'Fallback',
      endpoints: { available: [{ provider_name: 'Vertex', selected: true }] },
      is_byok: true,
    }));
    expect(out.provider).toBe('Vertex');
    expect(out.is_byok).toBe(true);
  });
});
