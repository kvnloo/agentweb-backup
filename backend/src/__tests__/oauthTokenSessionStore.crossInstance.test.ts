/**
 * ENG-162 acceptance criterion (3): a pending OAuth session created on instance A completes
 * on instance B.
 *
 * This is the bug the migration fixes: the old per-route in-memory `Map` lived in a single
 * process, so /finalize on EB instance A and /connect on instance B saw different maps and the
 * user got "Please reconnect" (masked only by ALB stickiness). The shared store keeps NO
 * module-level session state — the ONLY carrier is the settings table (DynamoDB in prod).
 *
 * We simulate two instances with two independent module loads of the store
 * (`jest.isolateModulesAsync`), both wired to ONE shared mocked settings table. Instance A
 * stores; instance B — a genuinely separate module instance — retrieves. If anything were held
 * in process memory, B would come up empty.
 */

// Single backing table shared across BOTH isolated module loads (the DynamoDB stand-in). Named
// `mock*` so Jest's hoisted `jest.mock` factory may reference it.
const mockSettingsTable = new Map<string, string>();

jest.mock('../services/settingsService', () => ({
  settingsService: {
    setSetting: jest.fn(async (name: string, value: string) => {
      mockSettingsTable.set(name, value);
    }),
    getSetting: jest.fn(async (name: string) => {
      const value = mockSettingsTable.get(name);
      return value ? { settingName: name, settingValue: value } : null;
    }),
    deleteSetting: jest.fn(async (name: string) => {
      mockSettingsTable.delete(name);
    }),
  },
}));

type Store = typeof import('../services/oauthTokenSessionStore');

/** Load a fresh, isolated instance of the store module — a stand-in for a separate EB instance. */
const onFreshInstance = async <R>(fn: (store: Store) => Promise<R>): Promise<R> => {
  let result!: R;
  await jest.isolateModulesAsync(async () => {
    const store = require('../services/oauthTokenSessionStore') as Store;
    result = await fn(store);
  });
  return result;
};

describe('oauthTokenSessionStore — cross-instance handoff (ENG-162)', () => {
  beforeEach(() => {
    mockSettingsTable.clear();
    jest.clearAllMocks();
  });

  it('hubspot: a session stored on instance A is retrievable on instance B', async () => {
    const payload = {
      tokens: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
      hubInfo: { hub_id: 42, hub_domain: 'acme.hubspot.com', user: 'u@acme.com' },
      accountType: 'crm' as const,
      grantedScopes: ['crm.objects.contacts.read'],
    };

    // Instance A: /finalize stores the pending session.
    const sessionId = await onFreshInstance((store) =>
      store.storeOAuthSession('user-A', 'hubspot', payload),
    );

    // Instance B: a DIFFERENT module load runs /connect and retrieves it — nothing carried over
    // in process memory, only through the shared (mocked Dynamo) table.
    const retrieved = await onFreshInstance((store) =>
      store.retrieveOAuthSession<typeof payload>(sessionId, 'user-A', 'hubspot'),
    );

    expect(retrieved).not.toBeNull();
    expect(retrieved!.hubInfo.hub_id).toBe(42);
    expect(retrieved!.accountType).toBe('crm');
    expect(retrieved!.tokens.access_token).toBe('at');
  });

  it('fathom: a session stored on instance A is retrievable on instance B', async () => {
    const payload = { tokens: { access_token: 'fat', refresh_token: 'frt', expires_in: 3600 } };

    const sessionId = await onFreshInstance((store) =>
      store.storeOAuthSession('user-B', 'fathom', payload),
    );

    const retrieved = await onFreshInstance((store) =>
      store.retrieveOAuthSession<typeof payload>(sessionId, 'user-B', 'fathom'),
    );

    expect(retrieved).not.toBeNull();
    expect(retrieved!.tokens.access_token).toBe('fat');
    expect(retrieved!.tokens.refresh_token).toBe('frt');
  });

  it('the two loads are genuinely separate module instances (not one shared object)', async () => {
    const storeFnA = await onFreshInstance(async (store) => store.retrieveOAuthSession);
    const storeFnB = await onFreshInstance(async (store) => store.retrieveOAuthSession);
    expect(storeFnA).not.toBe(storeFnB);
  });

  it('instance B still enforces one-time use across the handoff', async () => {
    const sessionId = await onFreshInstance((store) =>
      store.storeOAuthSession('user-C', 'fathom', {
        tokens: { access_token: 'x', expires_in: 3600 },
      }),
    );

    const first = await onFreshInstance((store) =>
      store.retrieveOAuthSession(sessionId, 'user-C', 'fathom'),
    );
    const second = await onFreshInstance((store) =>
      store.retrieveOAuthSession(sessionId, 'user-C', 'fathom'),
    );

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('instance B refuses another user presenting the session id', async () => {
    const sessionId = await onFreshInstance((store) =>
      store.storeOAuthSession('owner', 'hubspot', {
        tokens: { access_token: 'x', refresh_token: 'y', expires_in: 3600 },
        hubInfo: { hub_id: 1, hub_domain: 'd', user: 'u' },
        accountType: 'crm',
        grantedScopes: [],
      }),
    );

    const stolen = await onFreshInstance((store) =>
      store.retrieveOAuthSession(sessionId, 'attacker', 'hubspot'),
    );
    expect(stolen).toBeNull();
  });
});
