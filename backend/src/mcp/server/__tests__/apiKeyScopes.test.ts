import { effectiveApiKeyScopes, findScopeDenial } from '../apiKeyScopes';

// ENG-1083 decision A: API key scopes are a real permission boundary.
const lookup = (name: string) =>
  name === 'get_stats' ? { readOnly: true } : name === 'send_email' ? { readOnly: false } : undefined;

const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });

describe('ENG-1083 API key scope enforcement', () => {
  it('grandfathers legacy records without a scopes array to both scopes', () => {
    expect(effectiveApiKeyScopes(undefined)).toEqual(['tools:read', 'tools:execute']);
    expect(effectiveApiKeyScopes(null as any)).toEqual(['tools:read', 'tools:execute']);
    expect(effectiveApiKeyScopes(['tools:read'])).toEqual(['tools:read']);
    expect(effectiveApiKeyScopes([])).toEqual([]);
  });

  it('read-only key may call read-only tools but is denied write tools', () => {
    expect(findScopeDenial(call('get_stats'), ['tools:read'], lookup)).toBeNull();
    const denial = findScopeDenial(call('send_email'), ['tools:read'], lookup);
    expect(denial).toMatchObject({ tool: 'send_email', requiredScope: 'tools:execute' });
  });

  it('execute key may call write and read tools', () => {
    expect(findScopeDenial(call('send_email'), ['tools:execute'], lookup)).toBeNull();
    expect(findScopeDenial(call('get_stats'), ['tools:execute'], lookup)).toBeNull();
  });

  it('empty-scope key is denied every tool call', () => {
    expect(findScopeDenial(call('get_stats'), [], lookup)).toMatchObject({ requiredScope: 'tools:read' });
    expect(findScopeDenial(call('send_email'), [], lookup)).toMatchObject({ requiredScope: 'tools:execute' });
  });

  it('unknown tools are treated as writes (fail closed)', () => {
    expect(findScopeDenial(call('mystery'), ['tools:read'], lookup)).toMatchObject({ requiredScope: 'tools:execute' });
  });

  it('checks every message in a JSON-RPC batch and ignores non-call methods', () => {
    expect(findScopeDenial({ method: 'tools/list' }, [], lookup)).toBeNull();
    expect(findScopeDenial([call('get_stats'), call('send_email')], ['tools:read'], lookup)).toMatchObject({ tool: 'send_email' });
  });
});
