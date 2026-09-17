/**
 * Protects the 900s-token / no-in-place-refresh contract: cache per user,
 * re-mint ~60s before expiry (never wait for a hard failure), single-flight
 * concurrent mints for the same user, and invalidateUser() drops the cache
 * (used on connection.needs_reauth).
 */
import { AgenticFabriqTokenCache } from '../tokenCache';
import type { AgenticFabriqClient } from '../client';

function fakeClient(overrides: Partial<AgenticFabriqClient> = {}): AgenticFabriqClient {
  return {
    ensureExternalUser: jest.fn().mockResolvedValue(undefined),
    mintUserToken: jest.fn().mockResolvedValue({ access_token: 'tok_1', expires_in: 900, mcp_url: null }),
    ...overrides,
  } as any;
}

describe('AgenticFabriqTokenCache', () => {
  it('mints once and reuses the cached token while fresh', async () => {
    const client = fakeClient();
    const cache = new AgenticFabriqTokenCache(client);
    const t0 = 1_700_000_000_000;

    const first = await cache.getFreshToken('app_1', 'user_8412', t0);
    const second = await cache.getFreshToken('app_1', 'user_8412', t0 + 60_000); // 1 min later, well within the 900s window

    expect(first.accessToken).toBe('tok_1');
    expect(second.accessToken).toBe('tok_1');
    expect(client.mintUserToken).toHaveBeenCalledTimes(1);
  });

  it('re-mints ~60s before the 900s expiry rather than waiting for a hard 401', async () => {
    let mintCount = 0;
    const client = fakeClient({
      mintUserToken: jest.fn().mockImplementation(async () => {
        mintCount += 1;
        return { access_token: `tok_${mintCount}`, expires_in: 900, mcp_url: null };
      }),
    });
    const cache = new AgenticFabriqTokenCache(client);
    const t0 = 1_700_000_000_000;

    await cache.getFreshToken('app_1', 'user_8412', t0);
    // 900s - 60s buffer = 840s window; asking at 841s in should force a re-mint.
    const refreshed = await cache.getFreshToken('app_1', 'user_8412', t0 + 841_000);

    expect(refreshed.accessToken).toBe('tok_2');
    expect(client.mintUserToken).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent mints for the same user', async () => {
    const client = fakeClient();
    const cache = new AgenticFabriqTokenCache(client);
    const t0 = 1_700_000_000_000;

    const [a, b, c] = await Promise.all([
      cache.getFreshToken('app_1', 'user_8412', t0),
      cache.getFreshToken('app_1', 'user_8412', t0),
      cache.getFreshToken('app_1', 'user_8412', t0),
    ]);

    expect(client.mintUserToken).toHaveBeenCalledTimes(1);
    expect([a.accessToken, b.accessToken, c.accessToken]).toEqual(['tok_1', 'tok_1', 'tok_1']);
  });

  it('does not mix up two different users', async () => {
    let mintCount = 0;
    const client = fakeClient({
      mintUserToken: jest.fn().mockImplementation(async () => {
        mintCount += 1;
        return { access_token: `tok_${mintCount}`, expires_in: 900, mcp_url: null };
      }),
    });
    const cache = new AgenticFabriqTokenCache(client);
    const t0 = 1_700_000_000_000;

    const userA = await cache.getFreshToken('app_1', 'user_a', t0);
    const userB = await cache.getFreshToken('app_1', 'user_b', t0);

    expect(userA.accessToken).not.toBe(userB.accessToken);
  });

  it('invalidateUser drops the cache so the next call re-mints', async () => {
    let mintCount = 0;
    const client = fakeClient({
      mintUserToken: jest.fn().mockImplementation(async () => {
        mintCount += 1;
        return { access_token: `tok_${mintCount}`, expires_in: 900, mcp_url: null };
      }),
    });
    const cache = new AgenticFabriqTokenCache(client);
    const t0 = 1_700_000_000_000;

    await cache.getFreshToken('app_1', 'user_8412', t0);
    cache.invalidateUser('user_8412');
    const refreshed = await cache.getFreshToken('app_1', 'user_8412', t0 + 1000);

    expect(refreshed.accessToken).toBe('tok_2');
    expect(cache.hasCachedToken('user_8412')).toBe(true); // re-cached after the fresh mint
  });

  it('throws rather than caching an incomplete token response', async () => {
    const client = fakeClient({
      mintUserToken: jest.fn().mockResolvedValue({ access_token: '', expires_in: 900 }),
    });
    const cache = new AgenticFabriqTokenCache(client);
    await expect(cache.getFreshToken('app_1', 'user_8412', 1_700_000_000_000)).rejects.toThrow();
    expect(cache.hasCachedToken('user_8412')).toBe(false);
  });
});


describe('hostile token responses', () => {
  it.each([null, [], {},
    { access_token: ['secret'], expires_in: 900 },
    { access_token: 'secret\r\nX-Header: injected', expires_in: 900 },
    { access_token: 'secret', expires_in: '900' },
    { access_token: 'secret', expires_in: Infinity },
    { access_token: 'secret', expires_in: -1 },
    { access_token: 'secret', expires_in: 60 },
    { access_token: 'secret', expires_in: 901 },
    { access_token: 'secret', expires_in: 900, mcp_url: {} },
    { access_token: 'secret', expires_in: 900, mcp_url: '' },
  ])('never caches malformed token response %#', async (response) => {
    const cache = new AgenticFabriqTokenCache(fakeClient({ mintUserToken: jest.fn().mockResolvedValue(response) }));
    await expect(cache.getFreshToken('app', 'sensitive-user')).rejects.toThrow();
    expect(cache.hasCachedToken('sensitive-user')).toBe(false);
  });
  it('redacts the user identifier from token failures', async () => {
    const cache = new AgenticFabriqTokenCache(fakeClient({ mintUserToken: jest.fn().mockResolvedValue({}) }));
    await expect(cache.getFreshToken('app', 'sensitive-user')).rejects.not.toThrow('sensitive-user');
  });
  it('isolates tokens across apps as well as users and connections', async () => {
    const client = fakeClient();
    const cache = new AgenticFabriqTokenCache(client);
    await cache.getFreshToken('app-1', 'user', 'connection');
    await cache.getFreshToken('app-2', 'user', 'connection');
    expect(client.mintUserToken).toHaveBeenCalledTimes(2);
  });
});


describe('revocation during token mint', () => {
  it('does not resurrect a token after invalidation or share its in-flight mint', async () => {
    let complete!: (value: unknown) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const client = fakeClient({ mintUserToken: jest.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; signalStarted(); })).mockResolvedValue({ access_token: 'new_token', expires_in: 900 }) });
    const cache = new AgenticFabriqTokenCache(client);
    const oldMint = cache.getFreshToken('app', 'user');
    await started;
    cache.invalidateUser('user');
    const nextMint = cache.getFreshToken('app', 'user');
    complete({ access_token: 'old_token', expires_in: 900 });
    await expect(oldMint).rejects.toThrow();
    await expect(nextMint).resolves.toMatchObject({ accessToken: 'new_token' });
    await expect(cache.getFreshToken('app', 'user')).resolves.toMatchObject({ accessToken: 'new_token' });
  });
});
it('clears single-flight state even when dependency throws synchronously', async () => {
  const client = fakeClient({ ensureExternalUser: jest.fn().mockImplementationOnce(() => { throw new Error('failure'); }).mockResolvedValue(undefined) });
  const cache = new AgenticFabriqTokenCache(client);
  await expect(cache.getFreshToken('app','user')).rejects.toThrow();
  await expect(cache.getFreshToken('app','user')).resolves.toHaveProperty('accessToken');
});
