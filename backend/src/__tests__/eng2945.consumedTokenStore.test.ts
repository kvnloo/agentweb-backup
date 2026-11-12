import {
  ConsumedTokenStore,
  InMemoryConsumedTokenStore,
  consumeToken,
  defaultConsumedTokenStore,
} from '../mcp/zomaWriteGuard';

const NOW = 1_800_000_000_000;
const tok = (id: string, exp = NOW + 60_000) => `${id}.${exp}.sig`;

describe('ENG-2945 ConsumedTokenStore', () => {
  it('rejects the second consume of the same token', async () => {
    const store = new InMemoryConsumedTokenStore();
    expect(await consumeToken(store, tok('a'), NOW)).toBe(true);
    expect(await consumeToken(store, tok('a'), NOW)).toBe(false);
  });

  it('rejects a cross-toolkit replay when two toolkits share the injected store', async () => {
    const shared = new InMemoryConsumedTokenStore();
    const metaDeps = { consumedTokens: shared };
    const googleDeps = { consumedTokens: shared };
    expect(await consumeToken(metaDeps.consumedTokens, tok('x'), NOW)).toBe(true);
    expect(await consumeToken(googleDeps.consumedTokens, tok('x'), NOW)).toBe(false);
  });

  it('rejects an expired token and prunes expired claims', async () => {
    const store = new InMemoryConsumedTokenStore();
    expect(await consumeToken(store, tok('old', NOW - 1), NOW)).toBe(false);
    expect(await consumeToken(store, tok('b', NOW + 10), NOW)).toBe(true);
    // after expiry the claim is pruned, but the token itself is expired so it is still refused
    expect(await consumeToken(store, tok('b', NOW + 10), NOW + 20)).toBe(false);
  });

  it('honours a fake async store (the durable swap point)', async () => {
    const calls: Array<[string, number]> = [];
    const fake: ConsumedTokenStore = {
      consume: jest.fn(async (token: string, expiresAt: number) => {
        calls.push([token, expiresAt]);
        await new Promise((r) => setTimeout(r, 1));
        return calls.length === 1;
      }),
    };
    expect(await consumeToken(fake, tok('f'), NOW)).toBe(true);
    expect(await consumeToken(fake, tok('f'), NOW)).toBe(false);
    expect(calls[0]).toEqual([tok('f'), NOW + 60_000]);
  });

  it('keeps the legacy Map injection semantics', async () => {
    const map = new Map<string, number>();
    expect(await consumeToken(map, tok('m'), NOW)).toBe(true);
    expect(await consumeToken(map, tok('m'), NOW)).toBe(false);
  });

  it('exposes one process-wide default store', () => {
    expect(defaultConsumedTokenStore).toBeInstanceOf(InMemoryConsumedTokenStore);
  });
});
