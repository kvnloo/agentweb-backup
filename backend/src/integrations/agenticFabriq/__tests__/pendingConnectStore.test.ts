import crypto from 'crypto';
import { beginPendingConnectVerification, clearPendingConnectsForTest, connectionIdForAccount, consumePendingConnect, createPendingConnect, deletePendingConnect, finishPendingConnectVerification, verifiedConnectionIdForAccount } from '../pendingConnectStore';
const create = createPendingConnect as (...args: any[]) => Promise<any>;
const consume = consumePendingConnect as (...args: any[]) => Promise<any>;
const binding = connectionIdForAccount as (...args: any[]) => string;
const remove = deletePendingConnect as (...args: any[]) => Promise<void>;

describe('bounded single-use OAuth state', () => {
  it('draws a new random connection ID after a terminal attempt (retired IDs are not tracked)', async () => {
    const random = jest.spyOn(crypto, 'randomBytes');
    const first = await create('user-a', 'mailbox-a', 'gmail', 1000);
    await consume(first.connectionId, first.state, 1001);
    random.mockClear();
    const second = await create('user-a', 'mailbox-a', 'gmail', 1002);
    expect(random).toHaveBeenCalledWith(16);
    expect(second.connectionId).not.toBe(first.connectionId);
  });
  it('reconnects a completed mailbox at capacity without admitting a new binding', async () => {
    const first = await create('u', 'mailbox-0', 'gmail', 1000);
    const verification = await beginPendingConnectVerification(first.connectionId, 1001);
    await finishPendingConnectVerification(first.connectionId, verification!.verificationId, 'connected');
    for (let i = 1; i < 1000; i++) await create('u', `mailbox-${i}`, 'gmail', 1000);
    await expect(create('other', 'mailbox-0', 'gmail', 1002)).rejects.toThrow(/capacity/);
    await expect(create('u', 'new-mailbox', 'gmail', 1002)).rejects.toThrow(/capacity/);

    const replacement = await create('u', 'mailbox-0', 'gmail', 1002);
    expect(replacement.connectionId).not.toBe(first.connectionId);
    expect(verifiedConnectionIdForAccount('mailbox-0', 'u')).toBeUndefined();
    expect(await beginPendingConnectVerification(first.connectionId, 1003)).toBeNull();
    await expect(create('u', 'new-mailbox', 'gmail', 1003)).rejects.toThrow(/capacity/);
    const fresh = await beginPendingConnectVerification(replacement.connectionId, 1003);
    expect(await finishPendingConnectVerification(replacement.connectionId, fresh!.verificationId, 'connected')).toBe(true);
    expect(verifiedConnectionIdForAccount('mailbox-0', 'u')).toBe(replacement.connectionId);
    await expect(create('u', 'new-mailbox', 'gmail', 1004)).rejects.toThrow(/capacity/);
  });

  it('fails closed on a random connection collision without replacing another binding', async () => {
    jest.spyOn(crypto, 'randomBytes').mockImplementation(((size: number) => Buffer.alloc(size, 1)) as any);
    const first = await create('user-a', 'mailbox-a', 'gmail', 1000);
    await expect(create('user-b', 'mailbox-b', 'gmail', 1001)).rejects.toThrow();
    expect(await consume(first.connectionId, first.state, 1002)).toMatchObject({ userId: 'user-a', accountId: 'mailbox-a' });
  });

  beforeEach(() => { clearPendingConnectsForTest(); jest.spyOn(Date, 'now').mockReturnValue(1005); });
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
    expect(second.connectionId).not.toBe(first.connectionId);
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
  it('allows at most three serialized verification attempts and consumes terminal outcomes', async () => {
    const issued = await create('user-a', 'mailbox-a', 'gmail', 1000);
    const first = await beginPendingConnectVerification(issued.connectionId, 1001);
    expect(first).not.toBeNull();
    expect(await beginPendingConnectVerification(issued.connectionId, 1001)).toBeNull();
    await finishPendingConnectVerification(issued.connectionId, first!.verificationId, 'retry');
    const second = await beginPendingConnectVerification(issued.connectionId, 1002);
    await finishPendingConnectVerification(issued.connectionId, second!.verificationId, 'retry');
    const third = await beginPendingConnectVerification(issued.connectionId, 1003);
    await finishPendingConnectVerification(issued.connectionId, third!.verificationId, 'retry');
    expect(await beginPendingConnectVerification(issued.connectionId, 1004)).toBeNull();

    const terminal = await create('user-a', 'mailbox-a', 'gmail', 1000);
    const reserved = await beginPendingConnectVerification(terminal.connectionId, 1001);
    await finishPendingConnectVerification(terminal.connectionId, reserved!.verificationId, 'terminal');
    expect(await beginPendingConnectVerification(terminal.connectionId, 1002)).toBeNull();
  });
  it('replaces only the same user and mailbox attempt and invalidates its old state', async () => {
    const issued = await create('user-a', 'mailbox-a', 'gmail', 1000);
    const otherUser = await create('user-b', 'mailbox-a', 'gmail', 1000);
    const replacement = await create('user-a', 'mailbox-a', 'gmail', 1001);
    expect(replacement.connectionId).not.toBe(issued.connectionId);
    expect(replacement.state).not.toBe(issued.state);
    expect(await consume(issued.connectionId, issued.state, 1002)).toBeNull();
    expect(await consume(replacement.connectionId, replacement.state, 1002)).not.toBeNull();
    expect(await consume(otherUser.connectionId, otherUser.state, 1002)).not.toBeNull();
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
  it('keeps the third reservation alive when a concurrent replay arrives', async () => {
    const a = await create('u', 'a', 'gmail', 1000);
    for (let i = 0; i < 2; i++) {
      const v = await beginPendingConnectVerification(a.connectionId, 1001);
      await finishPendingConnectVerification(a.connectionId, v!.verificationId, 'retry');
    }
    const third = await beginPendingConnectVerification(a.connectionId, 1002);
    expect(await beginPendingConnectVerification(a.connectionId, 1003)).toBeNull();
    expect(await finishPendingConnectVerification(a.connectionId, third!.verificationId, 'connected')).toBe(true);
    expect(verifiedConnectionIdForAccount('a', 'u')).toBe(a.connectionId);
  });
  it('publishes only a verified binding and isolates user/mailbox lookups', async () => {
    const a = await create('u', 'a', 'gmail', 1000);
    expect(verifiedConnectionIdForAccount('a', 'u')).toBeUndefined();
    const v = await beginPendingConnectVerification(a.connectionId, 1001);
    await finishPendingConnectVerification(a.connectionId, v!.verificationId, 'connected');
    expect(verifiedConnectionIdForAccount('a', 'u')).toBe(a.connectionId);
    expect(verifiedConnectionIdForAccount('a', 'other')).toBeUndefined();
    expect(verifiedConnectionIdForAccount('other', 'u')).toBeUndefined();
    jest.spyOn(crypto, 'randomBytes').mockImplementation((() => Buffer.from(a.connectionId, 'hex')) as any);
    await expect(create('other', 'a', 'gmail', 1006)).rejects.toThrow(/collision/);
    await expect(create('u', 'a', 'gmail', 1006)).rejects.toThrow(/collision/);
    expect(verifiedConnectionIdForAccount('a', 'u')).toBe(a.connectionId);
  });
  it('cannot publish a superseded or expired in-flight callback', async () => {
    const a = await create('u', 'a', 'gmail', 1000);
    const v = await beginPendingConnectVerification(a.connectionId, 1001);
    await create('u', 'a', 'gmail', 1002);
    expect(await finishPendingConnectVerification(a.connectionId, v!.verificationId, 'connected')).toBe(false);
    const b = await create('u', 'b', 'gmail', 1000);
    const w = await beginPendingConnectVerification(b.connectionId, 1001);
    jest.spyOn(Date, 'now').mockReturnValue(601000);
    expect(await finishPendingConnectVerification(b.connectionId, w!.verificationId, 'connected')).toBe(false);
    expect(verifiedConnectionIdForAccount('b', 'u')).toBeUndefined();
  });

});
