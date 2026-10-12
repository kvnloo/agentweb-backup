/**
 * ENG-2105 (A1): store-level guards that hold even when two requests race, which the
 * service's own checks cannot cover.
 */
import type { LlmConnectionRecord } from '../llmConnectionDb';
import { makeDb } from './llmConnectionTestKit';

const NOW = '2026-10-09T00:00:00.000Z';
const LATER = '2026-10-09T00:05:00.000Z';

function record(overrides: Partial<LlmConnectionRecord> = {}): LlmConnectionRecord {
  return {
    connectionId: 'conn-1',
    ownerUserId: 'user-1',
    kind: 'api_key',
    provider: 'anthropic',
    status: 'active',
    keyLast4: 'abcd',
    createdAt: NOW,
    updatedAt: NOW,
    orgId: 'org-1',
    sealed: { v: 1, wrappedDataKey: 'w', iv: 'i', ciphertext: 'c', tag: 't' },
    ...overrides,
  };
}

describe('LlmConnectionDb', () => {
  it('refuses to overwrite an existing connection id', async () => {
    const { db } = makeDb();
    await db.create(record());
    await expect(db.create(record({ ownerUserId: 'user-2' }))).rejects.toMatchObject({ code: 'ConditionalCheckFailedException' });
    expect((await db.get('conn-1'))?.ownerUserId).toBe('user-1');
  });

  it('revokes once: the key and the org share go in that write, and a second revoke changes nothing', async () => {
    const { db } = makeDb();
    await db.create(record());
    expect(await db.revoke('conn-1', { userId: 'user-1' }, LATER)).toBe(true);
    const row = await db.get('conn-1');
    expect(row).toMatchObject({ status: 'revoked', revokedAt: LATER, revokedByUserId: 'user-1' });
    expect(row?.sealed).toBeUndefined();
    expect(row?.orgId).toBeUndefined();

    expect(await db.revoke('conn-1', { userId: 'user-9' }, '2026-10-10T00:00:00.000Z')).toBe(false);
    expect((await db.get('conn-1'))?.revokedByUserId).toBe('user-1');
    expect(await db.revoke('no-such-id', { userId: 'user-1' }, LATER)).toBe(false);
    expect(await db.get('no-such-id')).toBeNull();
  });

  it('a check that finishes after a revoke cannot bring the connection back', async () => {
    const { db } = makeDb();
    await db.create(record());
    await db.revoke('conn-1', { userId: 'user-1' }, LATER);
    expect(await db.recordCheck('conn-1', { result: 'ok', status: 'active', ok: true }, LATER)).toBe(false);
    expect((await db.get('conn-1'))?.status).toBe('revoked');
  });

  it('a share that lands after a revoke does not re-share it', async () => {
    const { db } = makeDb();
    await db.create(record({ orgId: undefined }));
    await db.revoke('conn-1', { userId: 'user-1' }, LATER);
    expect(await db.setSharedOrg('conn-1', 'org-1', LATER)).toBe(false);
    expect(await db.listSharedWithOrg('org-1')).toEqual([]);
  });

  it('lists an owner\'s connections oldest first, and an org\'s shared ones only', async () => {
    const { db } = makeDb();
    await db.create(record({ connectionId: 'b', createdAt: '2026-10-09T00:00:02.000Z', orgId: undefined }));
    await db.create(record({ connectionId: 'a', createdAt: '2026-10-09T00:00:01.000Z' }));
    await db.create(record({ connectionId: 'c', ownerUserId: 'user-2', createdAt: '2026-10-09T00:00:03.000Z', orgId: 'org-2' }));
    expect((await db.listByOwner('user-1')).map((r) => r.connectionId)).toEqual(['a', 'b']);
    expect((await db.listSharedWithOrg('org-1')).map((r) => r.connectionId)).toEqual(['a']);

    expect(await db.setSharedOrg('a', null, LATER)).toBe(true);
    expect(await db.listSharedWithOrg('org-1')).toEqual([]);
  });

  it('finds every connection for a provider, active or revoked, across every user', async () => {
    const { db } = makeDb();
    await db.create(record({ connectionId: 'a', provider: 'anthropic', createdAt: '2026-10-09T00:00:01.000Z' }));
    await db.create(record({ connectionId: 'b', ownerUserId: 'user-2', provider: 'anthropic', createdAt: '2026-10-09T00:00:02.000Z', orgId: undefined }));
    await db.create(record({ connectionId: 'c', provider: 'openai', createdAt: '2026-10-09T00:00:03.000Z' }));
    await db.revoke('a', { userId: 'user-1' }, LATER);

    expect((await db.listByProvider('anthropic')).map((r) => r.connectionId)).toEqual(['a', 'b']);
    expect((await db.listByProvider('anthropic')).find((r) => r.connectionId === 'a')?.status).toBe('revoked');
    expect((await db.listByProvider('openai')).map((r) => r.connectionId)).toEqual(['c']);
    expect(await db.listByProvider('google')).toEqual([]);
  });

  it('records a failed check without touching the last-ok time', async () => {
    const { db } = makeDb();
    await db.create(record({ lastOkAt: NOW }));
    expect(await db.recordCheck('conn-1', { result: 'invalid_key', status: 'invalid', ok: false }, LATER)).toBe(true);
    expect(await db.get('conn-1')).toMatchObject({ status: 'invalid', lastCheckResult: 'invalid_key', lastCheckedAt: LATER, lastOkAt: NOW });
  });

  describe('the per-owner slot counter', () => {
    const LLM_CONNECTIONS_TABLE = require('../llmConnectionDb').LLM_CONNECTIONS_TABLE;
    const counterRow = (dynamo: any, ownerUserId: string) =>
      dynamo.items(LLM_CONNECTIONS_TABLE).find((r: any) => r.connectionId === `limit#${ownerUserId}`);

    it('enforces the cap atomically and releases a slot on revoke', async () => {
      const { db, dynamo } = makeDb();
      for (let i = 0; i < 3; i++) {
        expect(await db.createWithinLimit(record({ connectionId: `c${i}` }), 3)).toBe(true);
      }
      expect(await db.createWithinLimit(record({ connectionId: 'c-over' }), 3)).toBe(false);
      expect(counterRow(dynamo, 'user-1').activeCount).toBe(3);

      await db.revoke('c0', { userId: 'user-1' }, LATER);
      await db.releaseSlot('user-1');
      expect(counterRow(dynamo, 'user-1').activeCount).toBe(2);
      expect(await db.createWithinLimit(record({ connectionId: 'c-fits-now' }), 3)).toBe(true);
    });

    it('never goes negative, which would otherwise let more than the cap through', async () => {
      const { db, dynamo } = makeDb();
      await db.releaseSlot('owner-x'); // nothing created yet -- must be a harmless no-op
      expect(counterRow(dynamo, 'owner-x')).toBeUndefined();

      expect(await db.createWithinLimit(record({ connectionId: 'c1', ownerUserId: 'owner-x' }), 5)).toBe(true);
      await db.revoke('c1', { userId: 'owner-x' }, LATER);
      await db.releaseSlot('owner-x'); // back to 0
      await db.releaseSlot('owner-x'); // already 0 -- must stay 0, not go negative
      expect(counterRow(dynamo, 'owner-x').activeCount).toBe(0);

      for (let i = 0; i < 5; i++) {
        expect(await db.createWithinLimit(record({ connectionId: `c${i + 2}`, ownerUserId: 'owner-x' }), 5)).toBe(true);
      }
      // A counter that went negative would still read as "< cap" here and wrongly admit one more.
      expect(await db.createWithinLimit(record({ connectionId: 'one-too-many', ownerUserId: 'owner-x' }), 5)).toBe(false);
    });
  });
});
