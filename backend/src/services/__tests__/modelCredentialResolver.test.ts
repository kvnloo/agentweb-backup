import { ModelCredentialError, resolveModelCredential } from '../modelCredentialResolver';

const platformDefault = { anthropic: 'plat-anthropic', openai: 'plat-openai' };

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ModelCredentialError);
    return (e as ModelCredentialError).code;
  }
  throw new Error('expected throw');
};

describe('resolveModelCredential (ENG-2955)', () => {
  it.each(['anthropic', 'openai'])('uses org BYOK api_key ref for %s, billed to customer', (provider) => {
    const r = resolveModelCredential({
      orgId: 'org-a',
      provider,
      orgCredentialRefs: [{ ref: `byok-${provider}`, orgId: 'org-a', provider, kind: 'api_key' }],
      platformDefault,
    });
    expect(r).toEqual({ source: 'customer', ref: `byok-${provider}`, billTo: 'customer_direct', orgId: 'org-a', provider });
  });

  it('falls back to platform default, metered to AgentWeb, with orgId', () => {
    const r = resolveModelCredential({ orgId: 'org-a', provider: 'openai', orgCredentialRefs: [], platformDefault });
    expect(r).toEqual({ source: 'platform', ref: 'plat-openai', billTo: 'agentweb_metered', orgId: 'org-a', provider: 'openai' });
  });

  it('rejects subscription/OAuth logins with a typed error', () => {
    expect(
      code(() =>
        resolveModelCredential({
          orgId: 'org-a',
          provider: 'anthropic',
          orgCredentialRefs: [{ ref: 'claude-ai-login', orgId: 'org-a', provider: 'anthropic', kind: 'subscription_oauth' }],
          platformDefault,
        }),
      ),
    ).toBe('SUBSCRIPTION_LOGIN_REJECTED');
  });

  it('unknown provider -> typed error, never another org ref', () => {
    expect(
      code(() =>
        resolveModelCredential({
          orgId: 'org-a',
          provider: 'gemini',
          orgCredentialRefs: [{ ref: 'org-b-key', orgId: 'org-b', provider: 'gemini', kind: 'api_key' }],
          platformDefault,
        }),
      ),
    ).toBe('UNKNOWN_PROVIDER');
  });

  it('cross-tenant guard: another org BYOK ref is never used', () => {
    const r = resolveModelCredential({
      orgId: 'org-a',
      provider: 'anthropic',
      orgCredentialRefs: [{ ref: 'org-b-key', orgId: 'org-b', provider: 'anthropic', kind: 'api_key' }],
      platformDefault,
    });
    expect(r.source).toBe('platform');
    expect(r.ref).toBe('plat-anthropic');
  });

  it('missing orgId or platform default -> typed error', () => {
    expect(code(() => resolveModelCredential({ orgId: '', provider: 'openai', orgCredentialRefs: [], platformDefault }))).toBe('INVALID_INPUT');
    expect(code(() => resolveModelCredential({ orgId: 'org-a', provider: 'openai', orgCredentialRefs: [], platformDefault: {} }))).toBe('INVALID_INPUT');
  });

  it('return value never contains key material, only ref ids', () => {
    const secretish = { ref: 'ref-1', orgId: 'org-a', provider: 'anthropic', kind: 'api_key' as const, key: 'sk-ant-SECRET' };
    const r = resolveModelCredential({ orgId: 'org-a', provider: 'anthropic', orgCredentialRefs: [secretish], platformDefault });
    expect(Object.keys(r).sort()).toEqual(['billTo', 'orgId', 'provider', 'ref', 'source']);
    expect(JSON.stringify(r)).not.toContain('sk-');
  });
});
