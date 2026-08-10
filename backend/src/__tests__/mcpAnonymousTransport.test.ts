/**
 * ENG-984 — lazy auth on the MCP transport.
 *
 * This deliberately opens a door that was closed, so the assertions are mostly
 * about what still does NOT get through. The permitted set is tiny and explicit;
 * everything else must fail closed, including malformed input.
 */

import {
  ANONYMOUS_TOOLS,
  MCP_ANONYMOUS_FLAG,
  isAnonymousDiscoveryEnabled,
  isAnonymouslyPermitted,
  newAnonymousUserId,
} from '../mcp/server/anonymousTransport';
import { isAnonymousUserId } from '../mcp/anonymousToolAccess';

describe('ENG-984: the rollback flag', () => {
  const original = process.env[MCP_ANONYMOUS_FLAG];
  afterEach(() => {
    if (original === undefined) delete process.env[MCP_ANONYMOUS_FLAG];
    else process.env[MCP_ANONYMOUS_FLAG] = original;
  });

  it('is OFF unless explicitly set to "true"', () => {
    delete process.env[MCP_ANONYMOUS_FLAG];
    expect(isAnonymousDiscoveryEnabled()).toBe(false);

    // Anything other than the exact string is off — no truthiness games on a
    // flag that opens an unauthenticated path.
    for (const v of ['1', 'yes', 'TRUE', 'on', '']) {
      process.env[MCP_ANONYMOUS_FLAG] = v;
      expect(isAnonymousDiscoveryEnabled()).toBe(false);
    }

    process.env[MCP_ANONYMOUS_FLAG] = 'true';
    expect(isAnonymousDiscoveryEnabled()).toBe(true);
  });
});

describe('ENG-984: what a stranger may do', () => {
  it('permits the discovery methods and nothing more', () => {
    for (const method of ['initialize', 'notifications/initialized', 'ping', 'tools/list']) {
      expect(isAnonymouslyPermitted({ jsonrpc: '2.0', id: 1, method })).toBe(true);
    }
  });

  it('refuses every method that is not discovery', () => {
    for (const method of [
      'tools/call',
      'resources/list',
      'resources/read',
      'prompts/list',
      'completion/complete',
      'logging/setLevel',
      'sampling/createMessage',
    ]) {
      expect(isAnonymouslyPermitted({ jsonrpc: '2.0', id: 1, method })).toBe(false);
    }
  });

  it('refuses a tools/call for a tool that is not explicitly allowlisted', () => {
    // Every real tool today. The allowlist is empty until a demo tool with its
    // own SSRF protection and caps ships.
    for (const name of [
      'emma_run_marketing_task',
      'emma_get_brand_profile',
      'emma_find_leads',
      'send_email',
      'generate_image',
      'freeze_user_account',
    ]) {
      expect(isAnonymouslyPermitted({ method: 'tools/call', params: { name } })).toBe(false);
    }
    expect(ANONYMOUS_TOOLS.size).toBe(0);
  });
});

describe('ENG-984: it fails closed on anything ambiguous', () => {
  it('refuses malformed and empty bodies', () => {
    for (const body of [undefined, null, '', 0, 'tools/list', [], {}, { method: 123 }, { params: {} }]) {
      expect(isAnonymouslyPermitted(body as unknown)).toBe(false);
    }
  });

  it('refuses a tools/call whose name is missing or not a string', () => {
    expect(isAnonymouslyPermitted({ method: 'tools/call' })).toBe(false);
    expect(isAnonymouslyPermitted({ method: 'tools/call', params: {} })).toBe(false);
    expect(isAnonymouslyPermitted({ method: 'tools/call', params: { name: 42 } })).toBe(false);
  });

  it('refuses a batch if ANY entry is protected', () => {
    // The smuggling case: a protected call riding beside a discovery one.
    const batch = [
      { method: 'initialize' },
      { method: 'tools/call', params: { name: 'send_email' } },
    ];
    expect(isAnonymouslyPermitted(batch)).toBe(false);
  });

  it('permits a batch only when every entry is discovery', () => {
    expect(isAnonymouslyPermitted([{ method: 'initialize' }, { method: 'tools/list' }])).toBe(true);
  });
});

describe('ENG-984: the anonymous identity', () => {
  it('is recognised as anonymous by the ENG-822 predicate', () => {
    // Second line of defence: even if a request reaches a handler, the existing
    // requiresUserAccount guard must still see it as account-less.
    const id = newAnonymousUserId();
    expect(id.startsWith('anon_')).toBe(true);
    expect(isAnonymousUserId(id)).toBe(true);
  });

  it('is unique per request, so no two visitors share a session identity', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newAnonymousUserId()));
    expect(ids.size).toBe(50);
  });

  it('never looks like a real account id', () => {
    // A real userId is a bare uuid. If an anonymous id could be mistaken for one
    // the IDOR control would have something to bite on.
    expect(newAnonymousUserId()).not.toMatch(/^[0-9a-f-]{36}$/);
  });
});
