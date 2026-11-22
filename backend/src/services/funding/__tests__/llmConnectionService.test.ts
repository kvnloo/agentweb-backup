/**
 * ENG-2105 (A1): the rules for customer provider keys, run against the real store
 * logic (an executing in-memory DynamoDB) and real envelope encryption with a KMS
 * stand-in. Only the provider check, the user/org lookups and the flag are faked.
 */
jest.mock('../../db', () => ({ userDb: {}, orgDb: {} }));
jest.mock('../fundingFlags', () => ({ isByokEnabledFor: jest.fn() }));

import { openSecret, sealSecret } from '../llmConnectionCrypto';
import { LlmConnectionError, LlmConnectionService, MAX_ACTIVE_CONNECTIONS_PER_OWNER } from '../llmConnectionService';
import type { KeyCheckResult } from '../llmProviderValidation';
import { FakeKms, makeDb } from './llmConnectionTestKit';

const KEY_A = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA-key1';
const KEY_B = 'sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB-key2';

const ORG = { orgId: 'org-1', ownerUserId: 'owner-1' };
const USERS: Record<string, any> = {
  solo: { userId: 'solo' },
  'owner-1': { userId: 'owner-1', orgId: 'org-1', orgRole: 'owner' },
  'owner-2': { userId: 'owner-2', orgId: 'org-1', orgRole: 'owner' },
  admin: { userId: 'admin', orgId: 'org-1', orgRole: 'admin' },
  member: { userId: 'member', orgId: 'org-1', orgRole: 'member' },
  outsider: { userId: 'outsider', orgId: 'org-2', orgRole: 'owner' },
};

function setup() {
  const store = makeDb();
  const kms = new FakeKms();
  let tick = 0;
  let ids = 0;
  const users = JSON.parse(JSON.stringify(USERS));
  const enabled = new Set(Object.keys(users));
  const validateKey = jest.fn(async (): Promise<KeyCheckResult> => 'ok');
  const onRevoked = jest.fn();
  const service = new LlmConnectionService({
    db: store.db,
    kms,
    validateKey,
    isByokEnabledFor: async (userId) => enabled.has(userId),
    onRevoked,
    getUser: async (userId) => users[userId] ?? null,
    getOrg: async (orgId) => (orgId === 'org-1' ? ORG : orgId === 'org-2' ? { orgId: 'org-2', ownerUserId: 'outsider' } : null),
    now: () => new Date(Date.UTC(2026, 9, 9, 0, 0, tick++)).toISOString(),
    newId: () => `conn-${++ids}`,
  });
  return { service, store, kms, validateKey, users, enabled, onRevoked };
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (err) => (err instanceof LlmConnectionError ? err.code : `unexpected: ${err?.message}`),
  );

describe('LlmConnectionService', () => {
  describe('adding a key', () => {
    it('stores it sealed and returns only a masked view', async () => {
      const { service, store } = setup();
      const view = await service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: `  ${KEY_A}\n` });

      expect(view).toMatchObject({ connectionId: 'conn-1', provider: 'anthropic', status: 'active', keyLast4: 'key1', ownedByCaller: true });
      expect(JSON.stringify(view)).not.toContain(KEY_A);
      expect(view).not.toHaveProperty('sealed');
      expect(view).not.toHaveProperty('secretRef');

      const [row] = store.rows();
      expect(JSON.stringify(row)).not.toContain(KEY_A);
      expect(row.sealed).toMatchObject({ v: 1 });
      expect(row.keyLast4).toBe('key1');
    });

    it('checks the key with the provider first and stores nothing when it is refused', async () => {
      const { service, store, validateKey } = setup();
      validateKey.mockResolvedValueOnce('invalid_key');
      const err = await service.add({ userId: 'solo' }, { provider: 'openai', apiKey: KEY_B }).catch((e) => e);
      expect(err).toBeInstanceOf(LlmConnectionError);
      expect(err).toMatchObject({ code: 'key_rejected', checkResult: 'invalid_key', httpStatus: 422 });
      expect(String(err.message)).not.toContain(KEY_B);
      expect(store.rows()).toHaveLength(0);
    });

    it('stores nothing when the provider cannot be reached', async () => {
      const { service, store, validateKey } = setup();
      validateKey.mockResolvedValueOnce('provider_unreachable');
      expect(await code(service.add({ userId: 'solo' }, { provider: 'openai', apiKey: KEY_B }))).toBe('provider_unreachable');
      expect(store.rows()).toHaveLength(0);
    });

    it('accepts a key the provider is only rate-limiting', async () => {
      const { service, validateKey } = setup();
      validateKey.mockResolvedValueOnce('rate_limited');
      expect((await service.add({ userId: 'solo' }, { provider: 'openai', apiKey: KEY_B })).status).toBe('active');
    });

    it.each([
      ['an unsupported provider', { provider: 'xai', apiKey: KEY_A }, 'unsupported_provider'],
      ['a key that is too short', { provider: 'openai', apiKey: 'sk-short' }, 'invalid_key_format'],
      ['a key with spaces inside', { provider: 'openai', apiKey: 'sk-aaaaaaaaaaaaaaaa bbbbbbbbbbbb' }, 'invalid_key_format'],
      ['a non-string key', { provider: 'openai', apiKey: { $ne: '' } }, 'invalid_key_format'],
    ])('refuses %s before calling the provider', async (_label, input, expected) => {
      const { service, validateKey } = setup();
      expect(await code(service.add({ userId: 'solo' }, input as any))).toBe(expected);
      expect(validateKey).not.toHaveBeenCalled();
    });

    it('allows several keys, including several for one provider, and caps the total', async () => {
      const { service } = setup();
      for (let i = 0; i < MAX_ACTIVE_CONNECTIONS_PER_OWNER; i++) {
        await service.add({ userId: 'solo' }, { provider: i % 2 ? 'openai' : 'anthropic', apiKey: `${KEY_A}-${i}` });
      }
      expect(await code(service.add({ userId: 'solo' }, { provider: 'google', apiKey: KEY_B }))).toBe('limit_reached');
      const first = (await service.list('solo')).connections[0];
      await service.revoke({ userId: 'solo' }, first.connectionId);
      expect(await code(service.add({ userId: 'solo' }, { provider: 'google', apiKey: KEY_B }))).toBe('resolved');
    });

    it('enforces the cap atomically: concurrent adds past it cannot all succeed', async () => {
      const { service } = setup();
      for (let i = 0; i < MAX_ACTIVE_CONNECTIONS_PER_OWNER - 1; i++) {
        await service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: `${KEY_A}-${i}` });
      }
      const attempts = await Promise.all(
        [0, 1, 2].map((i) => code(service.add({ userId: 'solo' }, { provider: 'openai', apiKey: `${KEY_B}-${i}` }))),
      );
      expect(attempts.filter((r) => r === 'resolved')).toHaveLength(1);
      expect(attempts.filter((r) => r === 'limit_reached')).toHaveLength(2);
      expect((await service.list('solo')).connections).toHaveLength(MAX_ACTIVE_CONNECTIONS_PER_OWNER);
    });

    it('frees a slot on revoke so a later add can use it, and a double revoke frees only one slot', async () => {
      const { service } = setup();
      for (let i = 0; i < MAX_ACTIVE_CONNECTIONS_PER_OWNER; i++) {
        await service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: `${KEY_A}-${i}` });
      }
      const first = (await service.list('solo')).connections[0];
      await service.revoke({ userId: 'solo' }, first.connectionId);
      await service.revoke({ userId: 'solo' }, first.connectionId); // idempotent; must not double-free

      expect(await code(service.add({ userId: 'solo' }, { provider: 'openai', apiKey: KEY_B }))).toBe('resolved');
      expect(await code(service.add({ userId: 'solo' }, { provider: 'google', apiKey: KEY_B }))).toBe('limit_reached');
    });

    it('records the admin when the key was added in a delegated session', async () => {
      const { service, store } = setup();
      await service.add({ userId: 'solo', adminId: 'admin-9' }, { provider: 'anthropic', apiKey: KEY_A });
      expect(store.rows()[0].addedByAdminId).toBe('admin-9');
    });

    it('is refused when BYOK is switched off for the user, and nothing reaches the provider', async () => {
      const { service, validateKey, enabled } = setup();
      enabled.delete('solo');
      expect(await code(service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: KEY_A }))).toBe('byok_disabled');
      expect(validateKey).not.toHaveBeenCalled();
    });
  });

  describe('org rules', () => {
    it('lets only an org owner add a key', async () => {
      const { service } = setup();
      expect(await code(service.add({ userId: 'owner-1' }, { provider: 'anthropic', apiKey: KEY_A }))).toBe('resolved');
      expect(await code(service.add({ userId: 'admin' }, { provider: 'anthropic', apiKey: KEY_A }))).toBe('forbidden');
      expect(await code(service.add({ userId: 'member' }, { provider: 'anthropic', apiKey: KEY_A }))).toBe('forbidden');
    });

    it('stops showing a shared key once the person who shared it is no longer an owner of that org', async () => {
      const { service, users } = setup();
      const { connectionId } = await service.add({ userId: 'owner-1' }, { provider: 'anthropic', apiKey: KEY_A, shareWithOrg: true });
      users['owner-1'] = { userId: 'owner-1', orgId: 'org-9', orgRole: 'owner' };
      expect((await service.list('member')).connections).toHaveLength(0);
      void connectionId;
    });

    it('shows a shared key to members, masked and marked as not theirs', async () => {
      const { service } = setup();
      await service.add({ userId: 'owner-1' }, { provider: 'anthropic', apiKey: KEY_A, shareWithOrg: true });
      await service.add({ userId: 'owner-1' }, { provider: 'openai', apiKey: KEY_B });

      const forMember = await service.list('member');
      expect(forMember).toMatchObject({ canManage: false, inOrg: true });
      expect(forMember.connections).toHaveLength(1);
      expect(forMember.connections[0]).toMatchObject({ provider: 'anthropic', ownedByCaller: false, sharedWithOrgId: 'org-1' });
      expect(JSON.stringify(forMember)).not.toContain(KEY_A);

      expect((await service.list('owner-1')).connections).toHaveLength(2);
      expect((await service.list('outsider')).connections).toHaveLength(0);
    });

    it('lets only the key\'s own owner share or unshare it', async () => {
      const { service } = setup();
      const { connectionId } = await service.add({ userId: 'owner-1' }, { provider: 'anthropic', apiKey: KEY_A });
      expect((await service.setShared({ userId: 'owner-1' }, connectionId, true)).sharedWithOrgId).toBe('org-1');
      expect(await code(service.setShared({ userId: 'owner-2' }, connectionId, false))).toBe('forbidden');
      expect(await code(service.setShared({ userId: 'member' }, connectionId, false))).toBe('forbidden');
      expect((await service.setShared({ userId: 'owner-1' }, connectionId, false)).sharedWithOrgId).toBeUndefined();
      expect((await service.list('member')).connections).toHaveLength(0);
    });

    it('refuses sharing for a user with no org', async () => {
      const { service } = setup();
      expect(await code(service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: KEY_A, shareWithOrg: true }))).toBe('not_in_org');
      const { connectionId } = await service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: KEY_A });
      expect(await code(service.setShared({ userId: 'solo' }, connectionId, true))).toBe('not_in_org');
    });

    it('lets another owner revoke a shared key, but not a member, and hides other orgs\' keys entirely', async () => {
      const { service } = setup();
      const { connectionId } = await service.add({ userId: 'owner-1' }, { provider: 'anthropic', apiKey: KEY_A, shareWithOrg: true });
      expect(await code(service.revoke({ userId: 'member' }, connectionId))).toBe('forbidden');
      expect(await code(service.revoke({ userId: 'admin' }, connectionId))).toBe('forbidden');
      expect(await code(service.revoke({ userId: 'outsider' }, connectionId))).toBe('not_found');
      expect(await code(service.revoke({ userId: 'owner-2' }, connectionId))).toBe('resolved');
    });

    it('lets a member revoke a key they own from before they joined', async () => {
      const { service, users } = setup();
      const { connectionId } = await service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: KEY_A });
      users.solo = { userId: 'solo', orgId: 'org-1', orgRole: 'member' };
      expect(await code(service.revoke({ userId: 'solo' }, connectionId))).toBe('resolved');
    });
  });

  describe('revoking', () => {
    it('deletes the encrypted key in the same write and keeps the masked row', async () => {
      const { service, store } = setup();
      const { connectionId } = await service.add({ userId: 'owner-1' }, { provider: 'anthropic', apiKey: KEY_A, shareWithOrg: true });
      await service.revoke({ userId: 'owner-1', adminId: 'admin-9' }, connectionId);

      const [row] = store.rows();
      expect(row.sealed).toBeUndefined();
      expect(row.orgId).toBeUndefined();
      expect(row).toMatchObject({ status: 'revoked', keyLast4: 'key1', revokedByUserId: 'owner-1', revokedByAdminId: 'admin-9' });
      expect((await service.list('owner-1')).connections).toHaveLength(0);
      expect((await service.list('member')).connections).toHaveLength(0);
    });

    it('takes effect on the very next use', async () => {
      const { service } = setup();
      const { connectionId } = await service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: KEY_A });
      expect((await service.getKeyMaterial(connectionId, 'solo')).apiKey).toBe(KEY_A);
      await service.revoke({ userId: 'solo' }, connectionId);
      expect(await code(service.getKeyMaterial(connectionId, 'solo'))).toBe('not_usable');
      expect(await service.listUsableForUser('solo')).toEqual([]);
    });

    it('is idempotent, and works even when BYOK is switched off', async () => {
      const { service, enabled } = setup();
      const { connectionId } = await service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: KEY_A });
      enabled.delete('solo');
      expect(await code(service.revoke({ userId: 'solo' }, connectionId))).toBe('resolved');
      expect(await code(service.revoke({ userId: 'solo' }, connectionId))).toBe('resolved');
      expect((await service.list('solo')).connections).toHaveLength(0);
    });

    it('cannot be undone by sharing or re-checking', async () => {
      const { service, store } = setup();
      const { connectionId } = await service.add({ userId: 'owner-1' }, { provider: 'anthropic', apiKey: KEY_A });
      await service.revoke({ userId: 'owner-1' }, connectionId);
      expect(await code(service.setShared({ userId: 'owner-1' }, connectionId, true))).toBe('not_found');
      expect(await code(service.validate({ userId: 'owner-1' }, connectionId))).toBe('not_found');
      expect(store.rows()[0].status).toBe('revoked');
    });
  });

  describe('re-checking a stored key', () => {
    it('does not report a connection as active when it was revoked while the provider call was in flight', async () => {
      const { service, validateKey } = setup();
      const { connectionId } = await service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: KEY_A });
      validateKey.mockImplementationOnce(async () => {
        await service.revoke({ userId: 'solo' }, connectionId);
        return 'ok';
      });
      expect(await code(service.validate({ userId: 'solo' }, connectionId))).toBe('not_found');
    });

    it('does not report a connection as active when it was revoked while an unreachable provider call was in flight', async () => {
      const { service, validateKey } = setup();
      const { connectionId } = await service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: KEY_A });
      validateKey.mockImplementationOnce(async () => {
        await service.revoke({ userId: 'solo' }, connectionId);
        return 'provider_unreachable';
      });
      expect(await code(service.validate({ userId: 'solo' }, connectionId))).toBe('not_found');
    });

    it('does not report a connection as active when it is revoked between the fresh re-read and the final write', async () => {
      const { service, store } = setup();
      const { connectionId } = await service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: KEY_A });
      // visible()'s own db.get is the FIRST call (authorization + snapshot); the fresh
      // re-read validate() does after the provider call is the SECOND. Only that second
      // call is this window: the re-read still sees "active" (its own call already
      // captured the snapshot), but the connection is gone by the time recordCheck's own
      // conditional write runs. recordCheck's returned false is what must stop this, not
      // the re-read, which has already passed by then.
      const realGet = store.db.get.bind(store.db);
      let getCalls = 0;
      jest.spyOn(store.db, 'get').mockImplementation(async (id: string) => {
        getCalls += 1;
        if (getCalls !== 2) return realGet(id);
        const snapshot = await realGet(id);
        await service.revoke({ userId: 'solo' }, id);
        return snapshot; // stale: returned AFTER the real revoke, but captured before it
      });
      expect(await code(service.validate({ userId: 'solo' }, connectionId))).toBe('not_found');
    });

    it('marks the connection invalid when the provider now refuses the key, and it stops being usable', async () => {
      const { service, validateKey, store } = setup();
      const { connectionId } = await service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: KEY_A });
      validateKey.mockResolvedValueOnce('invalid_key');
      const checked = await service.validate({ userId: 'solo' }, connectionId);
      expect(checked.result).toBe('invalid_key');
      expect(checked.connection.status).toBe('invalid');
      expect(validateKey).toHaveBeenLastCalledWith('anthropic', KEY_A);
      expect(store.rows()[0]).toMatchObject({ status: 'invalid', lastCheckResult: 'invalid_key' });
      expect(await code(service.getKeyMaterial(connectionId, 'solo'))).toBe('not_usable');

      validateKey.mockResolvedValueOnce('ok');
      expect((await service.validate({ userId: 'solo' }, connectionId)).connection.status).toBe('active');
    });

    it('leaves the status alone when the provider is unreachable', async () => {
      const { service, validateKey, store } = setup();
      const { connectionId } = await service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: KEY_A });
      validateKey.mockResolvedValueOnce('provider_unreachable');
      expect((await service.validate({ userId: 'solo' }, connectionId)).result).toBe('provider_unreachable');
      expect(store.rows()[0].status).toBe('active');
    });

    it('keeps an out-of-quota key active: the account is empty, the key is fine', async () => {
      const { service, validateKey } = setup();
      const { connectionId } = await service.add({ userId: 'solo' }, { provider: 'openai', apiKey: KEY_B });
      validateKey.mockResolvedValueOnce('quota_exhausted');
      expect((await service.validate({ userId: 'solo' }, connectionId)).connection.status).toBe('active');
    });
  });

  describe('a Claude login is never treated as an API key (ENG-2110)', () => {
    const LOGIN = '{"claudeAiOauth":{"accessToken":"SENTINEL-ACCESS-TOKEN","refreshToken":"SENTINEL-REFRESH-TOKEN"}}';
    async function withLogin(ownerId = 'solo', over: Record<string, unknown> = {}) {
      const ctx = setup();
      const sealed = await sealSecret(ctx.kms, LOGIN, { connectionId: 'login-1', ownerUserId: ownerId, provider: 'anthropic', purpose: 'claude_login' });
      await ctx.store.db.create({
        connectionId: 'login-1', ownerUserId: ownerId, kind: 'claude_subscription', provider: 'anthropic', status: 'active', keyLast4: '',
        createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', sealed,
        subVersion: 1, subNeedsReconnect: false, subType: 'max', subRefreshExpiresAtMs: Date.UTC(2026, 10, 12), ...over,
      } as any);
      return ctx;
    }

    it('is listed for its owner with plan, expiry and reconnect state, and no secret', async () => {
      const { service } = await withLogin();
      const { connections } = await service.list('solo');
      expect(connections).toHaveLength(1);
      expect(connections[0]).toMatchObject({ kind: 'claude_subscription', health: { expiresAt: '2026-11-12T00:00:00.000Z' }, subscription: { plan: 'max', needsReconnect: false } });
      expect(JSON.stringify(connections)).not.toMatch(/SENTINEL|wrappedDataKey|ciphertext/);
    });

    it('is not usable as a key by anyone, and is never decrypted by the key paths', async () => {
      const { service, kms } = await withLogin();
      expect(await service.listUsableForUser('solo')).toEqual([]);
      expect(await code(service.getKeyMaterial('login-1', 'solo'))).toBe('not_usable');
      expect(kms.decryptCalls).toHaveLength(0);
    });

    it('is not sent to a provider key validator', async () => {
      const { service, validateKey, kms } = await withLogin();
      expect(await code(service.validate({ userId: 'solo' }, 'login-1'))).toBe('not_found');
      expect(validateKey).not.toHaveBeenCalled();
      expect(kms.decryptCalls).toHaveLength(0);
    });

    it('cannot be shared with an org, even by its owner', async () => {
      const { service } = await withLogin('owner-1');
      expect(await code(service.setShared({ userId: 'owner-1' }, 'login-1', true))).toBe('forbidden');
      expect(await code(service.setShared({ userId: 'owner-1' }, 'login-1', false))).toBe('forbidden');
    });

    it('is invisible to other people, including org members', async () => {
      const { service } = await withLogin('owner-1');
      expect((await service.list('member')).connections).toEqual([]);
      expect(await code(service.revoke({ userId: 'member' }, 'login-1'))).toBe('not_found');
    });

    it('cannot be opened with the API-key context, and an API key cannot be opened with the login context', async () => {
      const { kms } = await withLogin();
      const row = (await (await withLogin()).store.db.get('login-1'))!;
      expect(row.sealed).toBeTruthy();
      const sealedKey = await sealSecret(kms, KEY_A, { connectionId: 'k', ownerUserId: 'solo', provider: 'anthropic' });
      await expect(openSecret(kms, sealedKey, { connectionId: 'k', ownerUserId: 'solo', provider: 'anthropic', purpose: 'claude_login' })).rejects.toBeTruthy();
      const ctx = await withLogin();
      const stored = (await ctx.store.db.get('login-1'))!.sealed!;
      await expect(openSecret(ctx.kms, stored, { connectionId: 'login-1', ownerUserId: 'solo', provider: 'anthropic' })).rejects.toBeTruthy();
    });

    it('tells the revoke hook, so a running turn in this process can stop at once', async () => {
      const { service, onRevoked } = await withLogin();
      await service.revoke({ userId: 'solo' }, 'login-1');
      await service.revoke({ userId: 'solo' }, 'login-1'); // a repeat does not fire it again
      expect(onRevoked).toHaveBeenCalledTimes(1);
      expect(onRevoked).toHaveBeenCalledWith('login-1');
    });

    it('still tells the revoke hook when the slot bookkeeping afterwards fails', async () => {
      const { service, store, onRevoked } = await withLogin();
      jest.spyOn(store.db, 'releaseSlot').mockRejectedValue(new Error('dynamo blip'));
      await expect(service.revoke({ userId: 'solo' }, 'login-1')).rejects.toBeTruthy();
      expect(onRevoked).toHaveBeenCalledWith('login-1'); // the revoke was committed: the holder must still be stopped
    });

    it('is revoked like any connection: the sealed login is gone and the slot is freed', async () => {
      const { service, store } = await withLogin();
      await service.revoke({ userId: 'solo' }, 'login-1');
      const row = (await store.db.get('login-1'))!;
      expect(row.status).toBe('revoked');
      expect(row.sealed).toBeUndefined();
      expect((await service.list('solo')).connections).toEqual([]);
    });
  });

  describe('routing state for a provider (ENG-2108)', () => {
    it('reports a usable own key, and that a connection exists', async () => {
      const { service } = setup();
      const { connectionId } = await service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: KEY_A });
      const state = await service.routingStateFor('solo', 'anthropic');
      expect(state.hasConnection).toBe(true);
      expect(state.usable.map((c) => c.connectionId)).toEqual([connectionId]);
    });

    it('still says a connection exists when the key is invalid and so cannot serve (never "no connection")', async () => {
      const { service, validateKey } = setup();
      const { connectionId } = await service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: KEY_A });
      validateKey.mockResolvedValueOnce('invalid_key');
      await service.validate({ userId: 'solo' }, connectionId);
      expect(await service.routingStateFor('solo', 'anthropic')).toEqual({ hasConnection: true, usable: [] });
    });

    it('treats a revoked connection as no connection: revoking is how a customer says they are done', async () => {
      const { service } = setup();
      const { connectionId } = await service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: KEY_A });
      await service.revoke({ userId: 'solo' }, connectionId);
      expect(await service.routingStateFor('solo', 'anthropic')).toEqual({ hasConnection: false, usable: [] });
    });

    it('does not count a Claude login as a connection for the provider (kind isolation)', async () => {
      const { service, store } = setup();
      await store.db.create({
        connectionId: 'login-only', ownerUserId: 'solo', kind: 'claude_subscription', provider: 'anthropic', status: 'active', keyLast4: '',
        createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', sealed: { v: 1, wrappedDataKey: 'w', iv: 'i', ciphertext: 'c', tag: 't' },
        subVersion: 1, subNeedsReconnect: false,
      } as any);
      expect(await service.routingStateFor('solo', 'anthropic')).toEqual({ hasConnection: false, usable: [] });
    });

    it('rejects, rather than answering "no connection", for a user who does not exist', async () => {
      const { service } = setup();
      await expect(service.routingStateFor('ghost-user', 'anthropic')).rejects.toBeTruthy();
    });

    it('only looks at the requested provider', async () => {
      const { service } = setup();
      await service.add({ userId: 'solo' }, { provider: 'openai', apiKey: KEY_B });
      expect(await service.routingStateFor('solo', 'anthropic')).toEqual({ hasConnection: false, usable: [] });
      expect((await service.routingStateFor('solo', 'openai')).hasConnection).toBe(true);
    });

    it('sees a key shared with the org by an owner, for a member', async () => {
      const { service } = setup();
      const { connectionId } = await service.add({ userId: 'owner-1' }, { provider: 'anthropic', apiKey: KEY_A, shareWithOrg: true });
      const state = await service.routingStateFor('member', 'anthropic');
      expect(state.hasConnection).toBe(true);
      expect(state.usable.map((c) => c.connectionId)).toEqual([connectionId]);
    });

    it('does not see a shared key once its sharer is no longer an owner of the org, or a key shared with another org', async () => {
      const { service, users } = setup();
      await service.add({ userId: 'owner-1' }, { provider: 'anthropic', apiKey: KEY_A, shareWithOrg: true });
      expect((await service.routingStateFor('outsider', 'anthropic')).hasConnection).toBe(false);
      users['owner-1'] = { userId: 'owner-1', orgId: 'org-9', orgRole: 'owner' };
      expect(await service.routingStateFor('member', 'anthropic')).toEqual({ hasConnection: false, usable: [] });
    });

    it('reports nothing when BYOK is switched off for the account that pays', async () => {
      const { service, enabled } = setup();
      await service.add({ userId: 'owner-1' }, { provider: 'anthropic', apiKey: KEY_A, shareWithOrg: true });
      enabled.delete('owner-1');
      expect(await service.routingStateFor('member', 'anthropic')).toEqual({ hasConnection: false, usable: [] });
      expect(await service.routingStateFor('owner-1', 'anthropic')).toEqual({ hasConnection: false, usable: [] });
    });
  });

  describe('using keys for a run', () => {
    it('returns the raw key only to the owner or to a member of the org it is shared with', async () => {
      const { service } = setup();
      const shared = await service.add({ userId: 'owner-1' }, { provider: 'anthropic', apiKey: KEY_A, shareWithOrg: true });
      const priv = await service.add({ userId: 'owner-1' }, { provider: 'openai', apiKey: KEY_B });

      expect(await service.getKeyMaterial(shared.connectionId, 'member')).toEqual({ provider: 'anthropic', apiKey: KEY_A });
      expect(await code(service.getKeyMaterial(priv.connectionId, 'member'))).toBe('not_usable');
      expect(await code(service.getKeyMaterial(shared.connectionId, 'outsider'))).toBe('not_usable');
      expect(await code(service.getKeyMaterial(shared.connectionId, 'solo'))).toBe('not_usable');
      expect(await code(service.getKeyMaterial('no-such-id', 'owner-1'))).toBe('not_usable');
    });

    it('lists usable keys in the order to try them: own in the order added, then the org\'s', async () => {
      const { service, users, enabled } = setup();
      users.member2 = { userId: 'member2', orgId: 'org-1', orgRole: 'owner' };
      enabled.add('member2');
      await service.add({ userId: 'owner-1' }, { provider: 'anthropic', apiKey: KEY_A, shareWithOrg: true });
      await service.add({ userId: 'member2' }, { provider: 'anthropic', apiKey: `${KEY_A}-x` });
      await service.add({ userId: 'member2' }, { provider: 'anthropic', apiKey: `${KEY_A}-y` });

      const usable = await service.listUsableForUser('member2');
      expect(usable.map((c) => [c.ownerUserId, c.keyLast4])).toEqual([
        ['member2', 'y1-x'.slice(-4)],
        ['member2', 'y1-y'.slice(-4)],
        ['owner-1', 'key1'],
      ]);
    });

    it('stops honoring a shared key once the person who shared it is no longer an owner of that org', async () => {
      const { service, users } = setup();
      const { connectionId } = await service.add({ userId: 'owner-1' }, { provider: 'anthropic', apiKey: KEY_A, shareWithOrg: true });
      users['owner-1'] = { userId: 'owner-1', orgId: 'org-9', orgRole: 'owner' };
      expect(await code(service.getKeyMaterial(connectionId, 'member'))).toBe('not_usable');
      expect(await service.listUsableForUser('member')).toEqual([]);
    });

    it('yields nothing when BYOK is switched off for the account that pays', async () => {
      const { service, enabled } = setup();
      const { connectionId } = await service.add({ userId: 'owner-1' }, { provider: 'anthropic', apiKey: KEY_A, shareWithOrg: true });
      enabled.delete('owner-1');
      expect(await service.listUsableForUser('member')).toEqual([]);
      expect(await code(service.getKeyMaterial(connectionId, 'member'))).toBe('byok_disabled');
    });

    it('cannot open a sealed key that was copied onto another connection\'s row', async () => {
      const { service, store } = setup();
      const a = await service.add({ userId: 'solo' }, { provider: 'anthropic', apiKey: KEY_A });
      const b = await service.add({ userId: 'outsider' }, { provider: 'anthropic', apiKey: KEY_B });
      const rows = store.rows();
      const rowA = rows.find((r) => r.connectionId === a.connectionId)!;
      const rowB = rows.find((r) => r.connectionId === b.connectionId)!;
      store.dynamo.seed(require('../llmConnectionDb').LLM_CONNECTIONS_TABLE, { ...rowB, sealed: rowA.sealed });
      await expect(service.getKeyMaterial(b.connectionId, 'outsider')).rejects.toThrow();
    });
  });

  it('grants nothing when the org a user belongs to cannot be loaded, failing closed rather than open', async () => {
    const { service, users } = setup();
    users['owner-1'].orgId = 'org-missing';
    expect(await code(service.add({ userId: 'owner-1' }, { provider: 'anthropic', apiKey: KEY_A }))).toBe('forbidden');
    const list = await service.list('owner-1');
    expect(list).toMatchObject({ canManage: false, inOrg: false });
  });

  it('refuses everything for an unknown user', async () => {
    const { service, enabled } = setup();
    enabled.add('ghost');
    expect(await code(service.list('ghost'))).toBe('forbidden');
    expect(await code(service.add({ userId: 'ghost' }, { provider: 'anthropic', apiKey: KEY_A }))).toBe('forbidden');
  });
});
