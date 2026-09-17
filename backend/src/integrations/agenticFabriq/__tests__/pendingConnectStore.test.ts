import {
  clearPendingConnectsForTest,
  connectionIdForAccount,
  consumePendingConnect,
  createPendingConnect,
} from '../pendingConnectStore';

describe('bounded pending connect state', () => {
  beforeEach(() => clearPendingConnectsForTest());

  it('derives a stable opaque connection id per exact account', () => {
    expect(connectionIdForAccount('mailbox-a')).toMatch(/^[a-f0-9]{32}$/);
    expect(connectionIdForAccount('mailbox-a')).toBe(connectionIdForAccount('mailbox-a'));
    expect(connectionIdForAccount('mailbox-a')).not.toBe(connectionIdForAccount('mailbox-b'));
  });

  it('atomically consumes a callback only once', async () => {
    const id = await createPendingConnect('user-a', 'mailbox-a', 'gmail', 1000);
    const [first, second] = await Promise.all([
      consumePendingConnect(id, 1001),
      consumePendingConnect(id, 1001),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(first ?? second).toMatchObject({ userId: 'user-a', accountId: 'mailbox-a', provider: 'gmail' });
  });

  it('fails closed after the ten-minute expiry', async () => {
    const id = await createPendingConnect('user-a', 'mailbox-a', 'gmail', 1000);
    await expect(consumePendingConnect(id, 1000 + 10 * 60 * 1000 + 1)).resolves.toBeNull();
  });
});
