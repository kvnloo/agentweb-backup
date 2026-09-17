import crypto from 'crypto';
import { clearPendingConnectsForTest, connectionIdForAccount, consumePendingConnect, createPendingConnect, deletePendingConnect } from '../pendingConnectStore';
const create = createPendingConnect as (...args: any[]) => Promise<any>;
const consume = consumePendingConnect as (...args: any[]) => Promise<any>;
const binding = connectionIdForAccount as (...args: any[]) => string;
const remove = deletePendingConnect as (...args: any[]) => Promise<void>;

describe('bounded single-use OAuth state', () => {
  beforeEach(() => clearPendingConnectsForTest());
  afterEach(() => jest.restoreAllMocks());
  it('binds stable connections to both user and mailbox', () => {
    expect(binding('mailbox-a', 'user-a')).toMatch(/^[a-f0-9]{32}$/);
    expect(binding('mailbox-a', 'user-a')).toBe(binding('mailbox-a', 'user-a'));
    expect(binding('mailbox-a', 'user-a')).not.toBe(binding('mailbox-a', 'user-b'));
  });
  it('issues a cryptographically random nonce separate from connection identity', async () => {
    const random = jest.spyOn(crypto, 'randomBytes');
    const first = await create('user-a', 'mailbox-a', 'gmail', 1000);
    expect(first.state).toMatch(/^[a-f0-9]{64}$/);
    expect(random).toHaveBeenCalledWith(32);
    await consume(first.connectionId, first.state, 1001);
    const second = await create('user-a', 'mailbox-a', 'gmail', 1002);
    expect(second.connectionId).toBe(first.connectionId);
    expect(second.state).not.toBe(first.state);
  });
  it('compares state in constant time and atomically consumes only one concurrent callback', async () => {
    const compare = jest.spyOn(crypto, 'timingSafeEqual');
    const issued = await create('user-a', 'mailbox-a', 'gmail', 1000);
    const results = await Promise.all([consume(issued.connectionId, issued.state, 1001), consume(issued.connectionId, issued.state, 1001)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({ userId: 'user-a', accountId: 'mailbox-a', provider: 'gmail', connectionId: issued.connectionId });
    expect(compare).toHaveBeenCalled();
  });
  it('does not overwrite an outstanding attempt', async () => {
    const issued = await create('user-a', 'mailbox-a', 'gmail', 1000);
    await expect(create('user-a', 'mailbox-a', 'gmail', 1001)).rejects.toThrow();
    expect(await consume(issued.connectionId, issued.state, 1002)).not.toBeNull();
  });
  it('does not delete valid state on forged state or crossed user binding', async () => {
    const a = await create('user-a', 'mailbox-a', 'gmail', 1000);
    const b = await create('user-b', 'mailbox-a', 'gmail', 1000);
    expect(await consume(a.connectionId, b.state, 1001)).toBeNull();
    expect(await consume(a.connectionId, '0'.repeat(64), 1001)).toBeNull();
    await remove(a.connectionId, b.state);
    expect(await consume(a.connectionId, a.state, 1001)).not.toBeNull();
    expect(await consume(b.connectionId, b.state, 1001)).not.toBeNull();
  });
  it('expires at the exact TTL boundary and rejects future creation timestamps', async () => {
    const a = await create('user-a', 'mailbox-a', 'gmail', 1000);
    expect(await consume(a.connectionId, a.state, 601000)).toBeNull();
    const b = await create('user-a', 'mailbox-a', 'gmail', 1000);
    expect(await consume(b.connectionId, b.state, 999)).toBeNull();
  });
  it.each(['outlook', '', undefined])('rejects unsupported provider %s', async provider => {
    await expect(create('user-a', 'mailbox-a', provider, 1000)).rejects.toThrow();
  });
});
