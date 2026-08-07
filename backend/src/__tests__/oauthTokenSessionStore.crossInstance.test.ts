/**
 * ENG-162 acceptance criterion (3): a pending OAuth session created on instance A completes
 * on instance B.
 *
 * This is the bug the migration fixes: the old per-route in-memory `Map` lived in a single
 * process, so /finalize on EB instance A and /connect on instance B saw different maps and the
 * user got "Please reconnect" (masked only by ALB stickiness). The shared store keeps NO
 * module-level session state — the ONLY carrier is AW-OAuthSessions (DynamoDB in prod).
 *
 * We simulate two instances with two independent module loads of the store
 * (`jest.isolateModulesAsync`), both wired to ONE shared mocked Dynamo table. Instance A
 * stores; instance B — a genuinely separate module instance — retrieves. If anything were held
 * in process memory, B would come up empty.
 */

// Single backing table shared across BOTH isolated module loads (the DynamoDB stand-in). Named
// `mock*` so Jest's hoisted `jest.mock` factory may reference it.
const mockOAuthTable = new Map<string, {
  sessionId: string;
  userId: string;
  provider: string;
  data: unknown;
}>();

jest.mock('../services/db', () => ({
  oauthSessionDb: {
    savePending: jest.fn(async (session: any) => {
      if (mockOAuthTable.has(session.sessionId)) throw new Error('session id collision');
      mockOAuthTable.set(session.sessionId, session);
    }),
    consumePending: jest.fn(async (sessionId: string, userId: string, provider: string) => {
      const session = mockOAuthTable.get(sessionId);
      if (!session || session.userId !== userId || session.provider !== provider) return null;
      // Delete and return happen as one mocked Dynamo operation.
      mockOAuthTable.delete(sessionId);
      return session.data;
    }),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    deleteSetting: jest.fn(),
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
    mockOAuthTable.clear();
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

  it('allows exactly one of two concurrent instances to consume a session', async () => {
    const sessionId = await onFreshInstance((store) =>
      store.storeOAuthSession('user-C', 'fathom', {
        tokens: { access_token: 'x', expires_in: 3600 },
      }),
    );
    const consumeA = await onFreshInstance(async (store) => store.retrieveOAuthSession);
    const consumeB = await onFreshInstance(async (store) => store.retrieveOAuthSession);

    const results = await Promise.all([
      consumeA(sessionId, 'user-C', 'fathom'),
      consumeB(sessionId, 'user-C', 'fathom'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('stores same-user sibling sessions independently so neither can overwrite the other', async () => {
    const [first, second] = await onFreshInstance(async (store) => Promise.all([
      store.storeOAuthSession('user-D', 'hubspot', { marker: 'first' }),
      store.storeOAuthSession('user-D', 'hubspot', { marker: 'second' }),
    ]));

    await expect(onFreshInstance((store) =>
      store.retrieveOAuthSession(first, 'user-D', 'hubspot'),
    )).resolves.toEqual({ marker: 'first' });
    await expect(onFreshInstance((store) =>
      store.retrieveOAuthSession(second, 'user-D', 'hubspot'),
    )).resolves.toEqual({ marker: 'second' });
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

  // The /connect routes only reject a FALSY id (`if (!tokenSessionId)`), so a malformed body
  // like `{"tokenSessionId": {}}` is truthy and reaches the store. Without the typeof guard it
  // becomes a DynamoDB partition key of the wrong type: a ValidationException surfacing as a
  // 500, where every other unusable session yields 401. An unusable id is an invalid session.
  it.each([
    ['an object', { evil: true }],
    ['an array', ['a']],
    ['a number', 12345],
  ])('returns null without querying Dynamo when the session id is %s', async (_label, badId) => {
    const { oauthSessionDb } = require('../services/db');

    await expect(onFreshInstance((store) =>
      store.retrieveOAuthSession(badId as any, 'user-E', 'hubspot'),
    )).resolves.toBeNull();

    expect(oauthSessionDb.consumePending).not.toHaveBeenCalled();
  });
});
