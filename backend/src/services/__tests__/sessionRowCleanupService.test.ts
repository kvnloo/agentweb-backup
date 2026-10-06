/**
 * Data-integrity invariants for the admin session-row cleanup (ENG-2314).
 *
 * crmDb is replaced by an in-memory fake that honours the same contracts as the real
 * methods (paginated query, consistent get, per-key setLeadFields, guarded delete with
 * leadCount). It CANNOT validate DynamoDB expression syntax — that is covered by the
 * out-of-repo dynamodb-local run described in the PR.
 */
const store: { lists: Record<string, any>; rows: Record<string, Record<string, any>> } = {
  lists: {},
  rows: {},
};
const calls = { setLeadFields: [] as any[], deleteLeadGuarded: [] as any[] };
let failSetFieldsFor: string | null = null;
let skipWrites = false;

jest.mock('../db', () => ({
  crmDb: {
    getLeadListById: jest.fn(async (listId: string) => store.lists[listId] ?? null),
    getLeadsByListId: jest.fn(async (listId: string, limit?: number, start?: any) => {
      const all = Object.values(store.rows[listId] ?? {}).sort((a: any, b: any) =>
        a.leadId < b.leadId ? -1 : 1,
      );
      const from = start ? all.findIndex((r: any) => r.leadId === start.leadId) + 1 : 0;
      const page = all.slice(from, from + (limit ?? all.length));
      const more = from + page.length < all.length;
      return {
        items: JSON.parse(JSON.stringify(page)),
        lastEvaluatedKey: more ? { listId, leadId: (page[page.length - 1] as any).leadId } : null,
        hasMore: more,
      };
    }),
    getLeadById: jest.fn(async (listId: string, leadId: string) => {
      const r = store.rows[listId]?.[leadId];
      return r ? JSON.parse(JSON.stringify(r)) : null;
    }),
    setLeadFields: jest.fn(async (listId: string, leadId: string, o: any) => {
      calls.setLeadFields.push({ listId, leadId, o });
      if (failSetFieldsFor === leadId) throw new Error('boom');
      if (skipWrites) return;
      const r = store.rows[listId]?.[leadId];
      if (!r) return;
      Object.assign(r.customFields ?? (r.customFields = {}), o.customFields ?? {});
      for (const [k, v] of Object.entries(o.topLevel ?? {})) {
        if (!o.ifNotExists || r[k] === undefined) r[k] = v;
      }
      r.updatedAt = '2099-01-01T00:00:00.000Z';
    }),
    deleteLeadGuarded: jest.fn(async (listId: string, leadId: string, expectedUpdatedAt?: string) => {
      calls.deleteLeadGuarded.push({ listId, leadId });
      const r = store.rows[listId]?.[leadId];
      if (!r) return { status: 'not_found' };
      if (r.updatedAt !== expectedUpdatedAt) return { status: 'changed' };
      delete store.rows[listId][leadId];
      store.lists[listId].leadCount -= 1;
      return { status: 'deleted', item: r, leadCountDecremented: true };
    }),
  },
}));

import {
  mergeSessionRows,
  sessionIdentity,
  previewDedupe,
  applyDedupe,
  previewExplicitDelete,
  applyExplicitDelete,
  SessionCleanupError,
} from '../sessionRowCleanupService';

const LIST = 'list-A';
const OTHER = 'list-B';
const quiet = { log: () => undefined };

function row(leadId: string, sid: string | null, cf: Record<string, any>, extra: Record<string, any> = {}) {
  return {
    listId: LIST,
    leadId,
    email: sid ? `s-${sid}@sessions.go.dramabreak.ai` : `person-${leadId}@example.com`,
    source: 'lp-session',
    createdAt: `2026-10-01T00:00:00.${leadId.replace(/\D/g, '').padStart(3, '0').slice(-3)}Z`,
    updatedAt: `2026-10-01T00:00:01.${leadId.replace(/\D/g, '').padStart(3, '0').slice(-3)}Z`,
    customFields: { ...(sid ? { sessionId: sid } : {}), ...cf },
    ...extra,
  };
}

function seed(listId: string, rows: any[]) {
  store.lists[listId] = { listId, name: 'LP Sessions - test', leadCount: rows.length };
  store.rows[listId] = Object.fromEntries(rows.map((r) => [r.leadId, { ...r, listId }]));
}

function defaultSeed() {
  seed(LIST, [
    // Split pair: keeper has view+dwell, donor has play_start + longer journey.
    row('l001', 'S1', { journey: 'lp_view', eventCount: '1', dwellSec: '9', lp_view_at: '2026-10-01T00:00:00.100Z', forwardedAt: '2026-10-01T00:00:00.300Z', channel: 'meta' }),
    row('l002', 'S1', { journey: 'lp_view>play_start', eventCount: '2', dwellSec: '10', play_start_at: '2026-10-01T00:00:05.000Z', lp_view_at: '2026-10-01T00:00:00.200Z', forwardedAt: '2026-10-01T00:00:00.100Z', clickLog: '[1]', clickCount: '1', trafficType: 'paid' }),
    // Triple.
    row('l010', 'S2', { eventCount: '3', journey: 'a>b>c' }),
    row('l011', 'S2', { eventCount: '1', journey: 'a' }),
    row('l012', 'S2', { eventCount: '2', journey: 'a>b' }),
    // Singleton, no-identity rows.
    row('l020', 'S3', { eventCount: '1' }),
    row('l030', null, { note: 'real lead' }, { source: 'manual' }),
    row('l031', null, { note: 'real lead 2' }),
  ]);
  seed(OTHER, [row('o001', 'S1', { eventCount: '1' }), row('o002', 'S1', { eventCount: '5' })]);
}

beforeEach(() => {
  calls.setLeadFields.length = 0;
  calls.deleteLeadGuarded.length = 0;
  failSetFieldsFor = null;
  skipWrites = false;
  defaultSeed();
});

describe('merge rules', () => {
  const [keeper, donor] = [
    row('l001', 'S1', { journey: 'lp_view', eventCount: '1', clickCount: '3', clickLog: 'L3', showsClicked: 'x', dwellSec: '9', maxScrollPct: '100', activeSec: 'n/a', lp_view_at: '2026-10-01T00:00:00.200Z', last_seen_at: '2026-10-01T00:00:01.000Z', forwardedAt: '2026-10-01T00:00:00.900Z', channel: '', utm: 'k' }),
    row('l002', 'S1', { journey: 'lp_view>play_start', eventCount: '2', clickCount: '1', clickLog: 'L1', showsClicked: 'y', dwellSec: '10', maxScrollPct: '40', activeSec: '7', lp_view_at: '2026-10-01T00:00:00.100Z', last_seen_at: '2026-10-01T00:00:09.000Z', forwardedAt: '2026-10-01T00:00:00.100Z', channel: 'meta', utm: 'z', extra: 'e' }, { firstTouch: { src: 'ad' }, utm_source: 'fb' }),
  ];
  const { merged, writes, topLevelWrites } = mergeSessionRows([keeper, donor]);

  it('journey/eventCount from highest eventCount row', () => {
    expect(merged.journey).toBe('lp_view>play_start');
    expect(merged.eventCount).toBe('2');
  });
  it('click bundle from highest clickCount row, independent of the event bundle', () => {
    expect([merged.clickLog, merged.clickCount, merged.showsClicked]).toEqual(['L3', '3', 'x']);
  });
  it('numeric-string engagement fields use numeric max ("10" > "9")', () => {
    expect(merged.dwellSec).toBe('10');
    expect(merged.maxScrollPct).toBe('100');
    expect(merged.activeSec).toBe('7'); // non-numeric keeper value ignored
  });
  it('<event>_at earliest wins; last_* latest wins; forwardedAt earliest', () => {
    expect(merged.lp_view_at).toBe('2026-10-01T00:00:00.100Z');
    expect(merged.last_seen_at).toBe('2026-10-01T00:00:09.000Z');
    expect(merged.forwardedAt).toBe('2026-10-01T00:00:00.100Z');
  });
  it('other fields: keeper wins, blanks and absent keys are filled', () => {
    expect(merged.utm).toBe('k');
    expect(merged.channel).toBe('meta');
    expect(merged.extra).toBe('e');
  });
  it('top-level attribution is filled when the keeper lacks it, never overwritten', () => {
    expect(topLevelWrites).toEqual({ firstTouch: { src: 'ad' }, utm_source: 'fb' });
    expect(writes.utm).toBeUndefined(); // keeper value unchanged => not written
  });
});

describe('sessionIdentity', () => {
  it('uses customFields.sessionId, falls back to synthetic email, flags conflicts, ignores others', () => {
    expect(sessionIdentity({ customFields: { sessionId: 'a' } })).toEqual({ sessionId: 'a' });
    expect(sessionIdentity({ email: 'S-xyz@sessions.go.dramabreak.ai' })).toEqual({ sessionId: 'xyz' });
    expect(sessionIdentity({ email: 's-a@sessions.go.dramabreak.ai', customFields: { sessionId: 'b' } })).toEqual({ conflict: true });
    expect(sessionIdentity({ email: 'a@b.com', customFields: {} })).toBeNull();
    expect(sessionIdentity({ source: 'manual', customFields: { sessionId: 'a' } })).toBeNull();
  });
});

describe('preview', () => {
  it('groups across pages, picks earliest keeper, writes nothing', async () => {
    const plan = await previewDedupe(LIST, { pageSize: 2 });
    expect(plan.counts).toMatchObject({ rowsScanned: 8, sessions: 3, duplicatedSessions: 2, rowsToDelete: 3, rowsWithoutIdentity: 2 });
    const s1 = plan.groups.find((g) => g.sessionId === 'S1')!;
    expect(s1.keeper.leadId).toBe('l001');
    expect(s1.remove.map((r) => r.leadId)).toEqual(['l002']);
    expect(plan.groups.find((g) => g.sessionId === 'S2')!.keeper.leadId).toBe('l010');
    expect(calls.setLeadFields).toHaveLength(0);
    expect(calls.deleteLeadGuarded).toHaveLength(0);
  });
  it('planHash is deterministic and changes when a row changes', async () => {
    const a = await previewDedupe(LIST);
    const b = await previewDedupe(LIST, { pageSize: 3 });
    expect(a.planHash).toBe(b.planHash);
    store.rows[LIST].l002.customFields.dwellSec = '99';
    expect((await previewDedupe(LIST)).planHash).not.toBe(a.planHash);
  });
  it('per-list scoping: other list is never read into this plan', async () => {
    const plan = await previewDedupe(LIST);
    expect(plan.groups.flatMap((g) => g.remove.map((r) => r.leadId))).not.toContain('o001');
    expect(plan.counts.rowsScanned).toBe(8);
  });
  it('404 for an unknown list', async () => {
    await expect(previewDedupe('nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('apply', () => {
  async function planAndReq() {
    const plan = await previewDedupe(LIST);
    return { plan, req: { listId: LIST, planHash: plan.planHash, expectedRowsToDelete: plan.counts.rowsToDelete, confirm: true } };
  }

  it('refuses without confirm===true, on hash mismatch and on count mismatch, mutating nothing', async () => {
    const { req } = await planAndReq();
    for (const bad of [
      { ...req, confirm: false },
      { ...req, confirm: 'true' as any },
      { ...req, planHash: 'deadbeef' },
      { ...req, expectedRowsToDelete: req.expectedRowsToDelete + 1 },
    ]) {
      await expect(applyDedupe(bad, quiet)).rejects.toBeInstanceOf(SessionCleanupError);
    }
    expect(calls.setLeadFields).toHaveLength(0);
    expect(calls.deleteLeadGuarded).toHaveLength(0);
    expect(store.lists[LIST].leadCount).toBe(8);
  });

  it('refuses when the list changed between preview and apply', async () => {
    const { req } = await planAndReq();
    store.rows[LIST].l011.updatedAt = '2026-10-02T00:00:00.000Z';
    await expect(applyDedupe(req, quiet)).rejects.toMatchObject({ status: 409, code: 'plan_mismatch' });
    expect(calls.deleteLeadGuarded).toHaveLength(0);
  });

  it('merges into the keeper, deletes only donors, decrements leadCount exactly, returns full backup', async () => {
    const { req } = await planAndReq();
    const donorBefore = JSON.parse(JSON.stringify(store.rows[LIST].l002));
    const res = await applyDedupe(req, quiet);
    expect(res.deletedCount).toBe(3);
    expect(res.groups.every((g) => g.status === 'merged_and_deleted')).toBe(true);
    expect(Object.keys(store.rows[LIST]).sort()).toEqual(['l001', 'l010', 'l020', 'l030', 'l031']);
    expect(store.lists[LIST].leadCount).toBe(5);
    const k = store.rows[LIST].l001.customFields;
    expect(k).toMatchObject({ journey: 'lp_view>play_start', eventCount: '2', dwellSec: '10', clickCount: '1', trafficType: 'paid', forwardedAt: '2026-10-01T00:00:00.100Z', lp_view_at: '2026-10-01T00:00:00.100Z', play_start_at: '2026-10-01T00:00:05.000Z' });
    expect(store.rows[LIST].l010.customFields.journey).toBe('a>b>c');
    expect(res.backup.map((b) => b.leadId).sort()).toEqual(['l002', 'l011', 'l012']);
    expect(res.backup.find((b) => b.leadId === 'l002')!.item).toEqual(donorBefore);
    expect(res.groups.find((g) => g.sessionId === 'S1')!.keeperBefore.customFields.journey).toBe('lp_view');
    // keepers never passed to delete; other list and identity-less rows untouched
    expect(calls.deleteLeadGuarded.map((c) => c.leadId)).not.toEqual(expect.arrayContaining(['l001']));
    expect(calls.deleteLeadGuarded.every((c) => c.listId === LIST)).toBe(true);
    expect(calls.setLeadFields.every((c) => c.listId === LIST)).toBe(true);
    expect(Object.keys(store.rows[OTHER])).toHaveLength(2);
    expect(store.lists[OTHER].leadCount).toBe(2);
  });

  it('is idempotent: a second preview+apply deletes nothing', async () => {
    const { req } = await planAndReq();
    await applyDedupe(req, quiet);
    const { req: req2, plan } = await planAndReq();
    expect(plan.counts.rowsToDelete).toBe(0);
    calls.setLeadFields.length = 0;
    const res2 = await applyDedupe(req2, quiet);
    expect(res2.deletedCount).toBe(0);
    expect(calls.setLeadFields).toHaveLength(0);
    expect(store.lists[LIST].leadCount).toBe(5);
  });

  it('an error in one group does not abort the others and deletes nothing in the failed group', async () => {
    failSetFieldsFor = 'l001';
    const { req } = await planAndReq();
    const res = await applyDedupe(req, quiet);
    const s1 = res.groups.find((g) => g.sessionId === 'S1')!;
    expect(s1.status).toBe('error');
    expect(s1.deletedLeadIds).toEqual([]);
    expect(store.rows[LIST].l002).toBeDefined();
    expect(res.groups.find((g) => g.sessionId === 'S2')!.status).toBe('merged_and_deleted');
    expect(store.lists[LIST].leadCount).toBe(6);
  });

  it('does not delete donors when the keeper write did not really land (swallowed conditional failure)', async () => {
    skipWrites = true;
    const { req } = await planAndReq();
    const res = await applyDedupe(req, quiet);
    expect(res.groups.find((g) => g.sessionId === 'S1')!.status).toBe('error');
    expect(store.rows[LIST].l002).toBeDefined();
  });

  it('skips a donor modified after the guard read instead of deleting it', async () => {
    const { req } = await planAndReq();
    const real = jest.requireMock('../db').crmDb.deleteLeadGuarded as jest.Mock;
    real.mockImplementationOnce(async () => ({ status: 'changed' }));
    const res = await applyDedupe(req, quiet);
    expect(res.groups.some((g) => g.status === 'partial' && g.notDeleted[0].reason === 'changed')).toBe(true);
    expect(res.deletedCount).toBe(2);
  });

  it('caps deletes per call and requires re-preview to continue', async () => {
    const { req } = await planAndReq();
    const res = await applyDedupe(req, { ...quiet, maxDeletes: 2 });
    expect(res.deletedCount).toBe(1);
    expect(res.continuationRequired).toBe(true);
    expect(res.remainingRowsToDelete).toBe(2);
    const plan2 = await previewDedupe(LIST);
    expect(plan2.counts.rowsToDelete).toBe(2);
  });
});

describe('explicit-ID mode', () => {
  it('refuses ids that do not belong to the list (nothing planned, nothing deleted)', async () => {
    await expect(previewExplicitDelete(LIST, ['l020', 'o001'])).rejects.toMatchObject({ status: 422, details: { unknownLeadIds: ['o001'] } });
    await expect(applyExplicitDelete({ listId: LIST, leadIds: ['o001'], planHash: 'x', expectedRowsToDelete: 1, confirm: true }, quiet)).rejects.toMatchObject({ status: 422 });
    expect(calls.deleteLeadGuarded).toHaveLength(0);
    expect(Object.keys(store.rows[OTHER])).toHaveLength(2);
  });
  it('validates shape and the 200 cap', async () => {
    await expect(previewExplicitDelete(LIST, [])).rejects.toMatchObject({ status: 400 });
    await expect(previewExplicitDelete(LIST, [1 as any])).rejects.toMatchObject({ status: 400 });
    await expect(previewExplicitDelete(LIST, Array.from({ length: 201 }, (_, i) => `x${i}`))).rejects.toMatchObject({ code: 'too_many_lead_ids' });
  });
  it('requires confirm + matching hash/count, then deletes exactly those rows with backup', async () => {
    const plan = await previewExplicitDelete(LIST, ['l030', 'l031', 'l030']);
    expect(plan.counts.rowsToDelete).toBe(2);
    const base = { listId: LIST, leadIds: ['l030', 'l031'], planHash: plan.planHash, expectedRowsToDelete: 2 };
    await expect(applyExplicitDelete({ ...base, confirm: false }, quiet)).rejects.toMatchObject({ status: 400 });
    await expect(applyExplicitDelete({ ...base, expectedRowsToDelete: 1, confirm: true }, quiet)).rejects.toMatchObject({ status: 409 });
    expect(calls.deleteLeadGuarded).toHaveLength(0);
    const res = await applyExplicitDelete({ ...base, confirm: true }, quiet);
    expect(res.deletedCount).toBe(2);
    expect(res.backup.map((b) => b.item.customFields.note).sort()).toEqual(['real lead', 'real lead 2']);
    expect(store.lists[LIST].leadCount).toBe(6);
    expect(store.rows[LIST].l001).toBeDefined();
  });
});
