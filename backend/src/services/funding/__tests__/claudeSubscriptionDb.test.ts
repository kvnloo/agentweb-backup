/**
 * ENG-2110 (B3): the store's single-live-copy protocol for a Claude login. A refresh token
 * is single-use (verified live), so these conditional writes are what keeps two processes
 * from ever holding the same login, and a stale save from overwriting a newer one.
 */
import type { LlmConnectionRecord, SubHealth } from '../llmConnectionDb';
import { makeDb } from './llmConnectionTestKit';

const NOW = Date.UTC(2026, 9, 14);
const ISO = (ms: number) => new Date(ms).toISOString();
const SEAL = (n: string) => ({ v: 1 as const, wrappedDataKey: `w${n}`, iv: `i${n}`, ciphertext: `c${n}`, tag: `t${n}` });
const HEALTH: SubHealth = { type: 'max', tier: 'default_claude_max_20x', accessExpiresAtMs: NOW + 8 * 3600_000, refreshExpiresAtMs: NOW + 30 * 86400_000 };

function sub(over: Partial<LlmConnectionRecord> = {}): LlmConnectionRecord {
  return {
    connectionId: 'sub-1', ownerUserId: 'user-1', kind: 'claude_subscription', provider: 'anthropic', status: 'active', keyLast4: '',
    createdAt: ISO(NOW), updatedAt: ISO(NOW), sealed: SEAL('0'),
    subVersion: 1, subNeedsReconnect: false, subType: 'max', subTier: 'x', subAccessExpiresAtMs: NOW, subRefreshExpiresAtMs: NOW + 30 * 86400_000,
    ...over,
  };
}
function apiKey(over: Partial<LlmConnectionRecord> = {}): LlmConnectionRecord {
  return { connectionId: 'key-1', ownerUserId: 'user-1', kind: 'api_key', provider: 'anthropic', status: 'active', keyLast4: 'abcd', createdAt: ISO(NOW), updatedAt: ISO(NOW), sealed: SEAL('k'), ...over };
}

describe('lease', () => {
  it('is exclusive until it expires, then can be taken over', async () => {
    const { db } = makeDb();
    await db.create(sub());
    expect(await db.acquireSubLease('sub-1', 'A', NOW, 90_000)).toBe(true);
    expect(await db.acquireSubLease('sub-1', 'B', NOW + 1000, 90_000)).toBe(false);
    expect(await db.acquireSubLease('sub-1', 'B', NOW + 90_001, 90_000)).toBe(true);
    expect((await db.get('sub-1'))?.subLeaseOwner).toBe('B');
  });

  it.each([
    ['revoked', { revokedAt: ISO(NOW), status: 'revoked' as const }],
    ['expired', { status: 'expired' as const }],
    ['invalid', { status: 'invalid' as const }],
    ['flagged needs-reconnect', { subNeedsReconnect: true }],
  ])('is refused for a connection that is %s', async (_l, over) => {
    const { db } = makeDb();
    await db.create(sub(over));
    expect(await db.acquireSubLease('sub-1', 'A', NOW, 90_000)).toBe(false);
  });

  it('is refused for an API key row and for a missing row (never creates one)', async () => {
    const { db } = makeDb();
    await db.create(apiKey({ subNeedsReconnect: false }));
    expect(await db.acquireSubLease('key-1', 'A', NOW, 90_000)).toBe(false);
    expect(await db.acquireSubLease('nope', 'A', NOW, 90_000)).toBe(false);
    expect(await db.get('nope')).toBeNull();
  });

  it('extends only for its owner, and release only removes the owner\'s lease', async () => {
    const { db } = makeDb();
    await db.create(sub());
    await db.acquireSubLease('sub-1', 'A', NOW, 90_000);
    expect(await db.extendSubLease('sub-1', 'B', NOW + 10, 90_000)).toBe(false);
    expect(await db.extendSubLease('sub-1', 'A', NOW + 10, 90_000)).toBe(true);
    expect((await db.get('sub-1'))?.subLeaseUntil).toBe(NOW + 10 + 90_000);
    await db.releaseSubLease('sub-1', 'B');
    expect((await db.get('sub-1'))?.subLeaseOwner).toBe('A');
    await db.releaseSubLease('sub-1', 'A');
    expect((await db.get('sub-1'))?.subLeaseOwner).toBeUndefined();
    expect(await db.acquireSubLease('sub-1', 'B', NOW + 20, 90_000)).toBe(true);
  });

  it('cannot be extended after a revoke', async () => {
    const { db } = makeDb();
    await db.create(sub());
    await db.acquireSubLease('sub-1', 'A', NOW, 90_000);
    await db.revoke('sub-1', { userId: 'user-1' }, ISO(NOW + 5));
    expect(await db.extendSubLease('sub-1', 'A', NOW + 10, 90_000)).toBe(false);
  });
});

describe('save-back (compare-and-swap)', () => {
  const save = (db: any, over: Record<string, unknown> = {}) =>
    db.saveSubCredentials('sub-1', { owner: 'A', expectedVersion: 1, sealed: SEAL('1'), health: HEALTH, nowIso: ISO(NOW + 1), ...over });

  it('replaces the blob, bumps the version and refreshes the health fields', async () => {
    const { db } = makeDb();
    await db.create(sub());
    await db.acquireSubLease('sub-1', 'A', NOW, 90_000);
    expect(await save(db)).toBe('ok');
    expect(await db.get('sub-1')).toMatchObject({ sealed: SEAL('1'), subVersion: 2, subType: 'max', subRefreshExpiresAtMs: HEALTH.refreshExpiresAtMs });
  });

  it('refuses a stale version: two saves from the same starting point cannot both land', async () => {
    const { db } = makeDb();
    await db.create(sub());
    await db.acquireSubLease('sub-1', 'A', NOW, 90_000);
    expect(await save(db)).toBe('ok');
    expect(await save(db, { sealed: SEAL('2') })).toBe('stale');
    expect((await db.get('sub-1'))?.sealed).toEqual(SEAL('1'));
  });

  it('refuses a save from a process that no longer holds the lease (a late watcher write)', async () => {
    const { db } = makeDb();
    await db.create(sub());
    await db.acquireSubLease('sub-1', 'A', NOW, 90_000);
    await db.acquireSubLease('sub-1', 'B', NOW + 90_001, 90_000);
    expect(await save(db, { owner: 'A' })).toBe('stale');
    expect((await db.get('sub-1'))?.sealed).toEqual(SEAL('0'));
  });

  it('says "revoked" and writes nothing once the connection is revoked', async () => {
    const { db } = makeDb();
    await db.create(sub());
    await db.acquireSubLease('sub-1', 'A', NOW, 90_000);
    await db.revoke('sub-1', { userId: 'user-1' }, ISO(NOW + 5));
    expect(await save(db)).toBe('revoked');
    expect((await db.get('sub-1'))?.sealed).toBeUndefined();
  });

  it('never writes to an API key row', async () => {
    const { db } = makeDb();
    await db.create(apiKey());
    expect(await db.saveSubCredentials('key-1', { owner: 'A', expectedVersion: 1, sealed: SEAL('x'), health: HEALTH, nowIso: ISO(NOW) })).not.toBe('ok');
    expect((await db.get('key-1'))?.sealed).toEqual(SEAL('k'));
  });
});

describe('reconnect in place', () => {
  const replace = (db: any, over: Record<string, unknown> = {}) =>
    db.replaceSubCredentials('sub-1', { expectedVersion: 1, sealed: SEAL('new'), health: HEALTH, nowMs: NOW + 10, nowIso: ISO(NOW + 10), ...over });

  it('swaps the login, clears the flag and reactivates an expired connection, keeping the id', async () => {
    const { db } = makeDb();
    await db.create(sub({ status: 'expired', subNeedsReconnect: true, subReconnectReason: 'cli_login_expired' }));
    expect(await replace(db)).toBe(true);
    const row = (await db.get('sub-1'))!;
    expect(row).toMatchObject({ connectionId: 'sub-1', status: 'active', subNeedsReconnect: false, subVersion: 2, sealed: SEAL('new') });
    expect(row.subReconnectReason).toBeUndefined();
  });

  it('is refused while another process holds the live copy, on a stale version, and after a revoke', async () => {
    const { db } = makeDb();
    await db.create(sub());
    await db.acquireSubLease('sub-1', 'A', NOW, 90_000);
    expect(await replace(db)).toBe(false);
    await db.releaseSubLease('sub-1', 'A');
    expect(await replace(db, { expectedVersion: 7 })).toBe(false);
    await db.revoke('sub-1', { userId: 'user-1' }, ISO(NOW + 20));
    expect(await replace(db)).toBe(false);
  });
});

describe('health transitions', () => {
  it('flags needs-reconnect only for the version the caller saw, so a good copy saved meanwhile is never flagged', async () => {
    const { db } = makeDb();
    await db.create(sub());
    await db.acquireSubLease('sub-1', 'A', NOW, 90_000);
    await db.saveSubCredentials('sub-1', { owner: 'A', expectedVersion: 1, sealed: SEAL('1'), health: HEALTH, nowIso: ISO(NOW) });
    expect(await db.markSubNeedsReconnect('sub-1', 1, 'cli_login_expired', ISO(NOW))).toBe(false);
    expect((await db.get('sub-1'))?.subNeedsReconnect).toBe(false);
    expect(await db.markSubNeedsReconnect('sub-1', 2, 'cli_login_expired', ISO(NOW))).toBe(true);
    expect(await db.get('sub-1')).toMatchObject({ subNeedsReconnect: true, subReconnectReason: 'cli_login_expired' });
  });

  it('does not create a row or flag a revoked connection', async () => {
    const { db } = makeDb();
    expect(await db.markSubNeedsReconnect('ghost', 1, 'x', ISO(NOW))).toBe(false);
    expect(await db.get('ghost')).toBeNull();
    await db.create(sub());
    await db.revoke('sub-1', { userId: 'user-1' }, ISO(NOW));
    expect(await db.markSubNeedsReconnect('sub-1', 1, 'x', ISO(NOW))).toBe(false);
  });

  it('expires only an active connection whose fixed refresh lifetime has passed', async () => {
    const { db } = makeDb();
    await db.create(sub({ subRefreshExpiresAtMs: NOW - 1 }));
    await db.create(sub({ connectionId: 'sub-2', subRefreshExpiresAtMs: NOW + 1000 }));
    expect(await db.markSubExpired('sub-1', NOW, ISO(NOW))).toBe(true);
    expect(await db.markSubExpired('sub-2', NOW, ISO(NOW))).toBe(false);
    expect((await db.get('sub-1'))?.status).toBe('expired');
    expect(await db.markSubExpired('sub-1', NOW, ISO(NOW))).toBe(false);
  });

  it('lists Claude logins only', async () => {
    const { db } = makeDb();
    await db.create(sub());
    await db.create(apiKey());
    expect((await db.listSubscriptions()).map((r) => r.connectionId)).toEqual(['sub-1']);
  });
});

describe('API-key-only writes never touch a Claude login', () => {
  it('sharing with an org and a provider-key check are refused for a subscription row', async () => {
    const { db } = makeDb();
    await db.create(sub());
    expect(await db.setSharedOrg('sub-1', 'org-1', ISO(NOW))).toBe(false);
    expect(await db.recordCheck('sub-1', { result: 'invalid_key', status: 'invalid', ok: false }, ISO(NOW))).toBe(false);
    expect(await db.get('sub-1')).toMatchObject({ status: 'active' });
    expect((await db.get('sub-1'))?.orgId).toBeUndefined();
  });

  it('still works for an API key row', async () => {
    const { db } = makeDb();
    await db.create(apiKey());
    expect(await db.setSharedOrg('key-1', 'org-1', ISO(NOW))).toBe(true);
    expect(await db.recordCheck('key-1', { result: 'ok', status: 'active', ok: true }, ISO(NOW))).toBe(true);
  });
});

describe('expressions are valid for real DynamoDB (the in-memory double cannot check this)', () => {
  // `subType` is a DynamoDB reserved word: bare use failed on the real service (found by the ENG-2110 live test).
  it('references every Claude-login attribute through an alias, and defines every alias it uses', async () => {
    const { db } = makeDb();
    const seen: Array<{ UpdateExpression: string; ConditionExpression: string; ExpressionAttributeNames?: Record<string, string> }> = [];
    const client = (db as any).client;
    const realUpdate = client.update.bind(client);
    client.update = (params: any) => { seen.push(params); return realUpdate(params); };
    await db.create(sub());
    await db.acquireSubLease('sub-1', 'A', NOW, 90_000);
    await db.extendSubLease('sub-1', 'A', NOW, 90_000);
    await db.saveSubCredentials('sub-1', { owner: 'A', expectedVersion: 1, sealed: SEAL('1'), health: HEALTH, nowIso: ISO(NOW), contentHash: 'h' });
    await db.replaceSubCredentials('sub-1', { expectedVersion: 2, sealed: SEAL('2'), health: HEALTH, nowMs: NOW + 1e9, nowIso: ISO(NOW), contentHash: 'h' });
    await db.markSubNeedsReconnect('sub-1', 3, 'x', ISO(NOW));
    await db.markSubExpired('sub-1', NOW, ISO(NOW));
    await db.releaseSubLease('sub-1', 'A');
    expect(seen.length).toBeGreaterThanOrEqual(7);
    for (const p of seen) {
      for (const expr of [p.UpdateExpression, p.ConditionExpression]) {
        expect(expr.replace(/#\w+|:\w+/g, '')).not.toMatch(/\b(sub[A-Z]\w*|sealed)\b/); // nothing bare
        for (const alias of expr.match(/#\w+/g) ?? []) expect(p.ExpressionAttributeNames).toHaveProperty([alias]); // nothing undefined
      }
      for (const alias of Object.keys(p.ExpressionAttributeNames ?? {})) {
        expect(`${p.UpdateExpression} ${p.ConditionExpression}`).toContain(alias); // nothing unused: DynamoDB rejects unused names
      }
    }
  });
});

