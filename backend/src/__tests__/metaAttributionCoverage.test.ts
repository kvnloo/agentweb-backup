/**
 * ENG-926 §F / AC5 — "percentage of leads carrying a click ID is queryable per account and
 * trending, not discovered during a post-mortem."
 *
 * RankAI's post-mortem found zero of four CRM leads carried any `utm_*` or `fbclid`. That
 * number existed the whole time; nobody was counting it. This makes it a number you can
 * ask for.
 *
 * The field read is the TOP-LEVEL `clickIds` map, not `firstTouch.clickIds`. leadSchema.ts
 * is explicit about why: `clickIds` is written only when a non-empty value was captured,
 * so `attribute_exists(clickIds)` answers "did a paid click acquire this lead?" — the
 * question `firstTouch` cannot answer, because a `firstTouch` exists for organic visitors
 * too. An empty map would count an organic lead as attributed.
 */

import { computeClickIdCoverage } from '../services/metaAttributionCoverage';

const lead = (createdAt: string, clickIds?: Record<string, string>) => ({
  leadId: `lead_${createdAt}_${Math.random()}`,
  createdAt,
  ...(clickIds ? { clickIds } : {}),
});

const deps = (lists: any[], leadsByList: Record<string, any[]>) => ({
  getLeadLists: jest.fn().mockResolvedValue(lists),
  getLeads: jest.fn(async (listId: string) => ({
    items: leadsByList[listId] || [],
    lastEvaluatedKey: null,
  })),
  now: Date.parse('2026-08-15T12:00:00Z'),
});

describe('computeClickIdCoverage — what counts as attributed', () => {
  it('counts a lead carrying a click ID', async () => {
    const d = deps([{ listId: 'L1', name: 'Inbound' }], {
      L1: [lead('2026-08-14T10:00:00Z', { fbclid: 'abc' })],
    });
    const result = await computeClickIdCoverage('u1', 30, d as any);
    expect(result.totals.withClickId).toBe(1);
    expect(result.totals.leads).toBe(1);
    expect(result.totals.coverage).toBe(1);
  });

  it('does NOT count an EMPTY clickIds map as attributed', async () => {
    // The exact trap leadSchema warns about: `{ clickIds: {} }` holds as much attribution
    // as `{}` does. Counting it would report an organic lead as paid-acquired and make a
    // broken lander look like a working one.
    const d = deps([{ listId: 'L1' }], { L1: [lead('2026-08-14T10:00:00Z', {})] });
    const result = await computeClickIdCoverage('u1', 30, d as any);
    expect(result.totals.withClickId).toBe(0);
    expect(result.totals.leads).toBe(1);
  });

  it('does not count a map whose only values are empty strings', async () => {
    const d = deps([{ listId: 'L1' }], { L1: [lead('2026-08-14T10:00:00Z', { fbclid: '' })] });
    expect((await computeClickIdCoverage('u1', 30, d as any)).totals.withClickId).toBe(0);
  });

  it('counts any click ID, not only Meta ones', async () => {
    // clickIds is deliberately a map so a new ad platform needs no schema change
    // (ENG-1176 AC3). Coverage is an attribution-health measure, not a Meta measure.
    const d = deps([{ listId: 'L1' }], {
      L1: [lead('2026-08-14T10:00:00Z', { gclid: 'g' }), lead('2026-08-14T11:00:00Z', { liFatId: 'l' })],
    });
    expect((await computeClickIdCoverage('u1', 30, d as any)).totals.withClickId).toBe(2);
  });

  it('treats a lead with no clickIds attribute as uncovered, not as missing data', async () => {
    const d = deps([{ listId: 'L1' }], { L1: [lead('2026-08-14T10:00:00Z')] });
    const result = await computeClickIdCoverage('u1', 30, d as any);
    expect(result.totals).toMatchObject({ leads: 1, withClickId: 0, coverage: 0 });
  });
});

describe('computeClickIdCoverage — trending', () => {
  it('buckets by the day the lead was created', async () => {
    const d = deps([{ listId: 'L1' }], {
      L1: [
        lead('2026-08-14T10:00:00Z', { fbclid: 'a' }),
        lead('2026-08-14T23:00:00Z'),
        lead('2026-08-13T10:00:00Z', { fbclid: 'b' }),
      ],
    });

    const result = await computeClickIdCoverage('u1', 30, d as any);
    const byDay = Object.fromEntries(result.daily.map((x: any) => [x.date, x]));

    expect(byDay['2026-08-14']).toMatchObject({ leads: 2, withClickId: 1, coverage: 0.5 });
    expect(byDay['2026-08-13']).toMatchObject({ leads: 1, withClickId: 1, coverage: 1 });
  });

  it('returns days oldest-first so a trend reads left to right', async () => {
    const d = deps([{ listId: 'L1' }], {
      L1: [lead('2026-08-14T10:00:00Z'), lead('2026-08-12T10:00:00Z'), lead('2026-08-13T10:00:00Z')],
    });
    const result = await computeClickIdCoverage('u1', 30, d as any);
    expect(result.daily.map((x: any) => x.date)).toEqual(['2026-08-12', '2026-08-13', '2026-08-14']);
  });

  it('excludes leads older than the requested window', async () => {
    const d = deps([{ listId: 'L1' }], {
      L1: [lead('2026-08-14T10:00:00Z', { fbclid: 'a' }), lead('2026-01-01T10:00:00Z', { fbclid: 'b' })],
    });
    expect((await computeClickIdCoverage('u1', 7, d as any)).totals.leads).toBe(1);
  });

  it('reports undated leads separately instead of silently dropping them', async () => {
    // A lead with no usable createdAt cannot be placed on a trend line, but pretending it
    // does not exist would quietly overstate coverage.
    const d = deps([{ listId: 'L1' }], {
      L1: [{ leadId: 'x' }, { leadId: 'y', createdAt: 'not-a-date' }],
    });
    const result = await computeClickIdCoverage('u1', 30, d as any);
    expect(result.totals.undated).toBe(2);
    expect(result.totals.leads).toBe(0);
  });
});

describe('computeClickIdCoverage — coverage with no leads', () => {
  it('reports null coverage rather than 0% when there is nothing to measure', async () => {
    // 0% reads as "every lead is unattributed", which is an alarm. No leads is not an
    // alarm, and the two must not render the same.
    const d = deps([{ listId: 'L1' }], { L1: [] });
    const result = await computeClickIdCoverage('u1', 30, d as any);
    expect(result.totals.leads).toBe(0);
    expect(result.totals.coverage).toBeNull();
  });
});

describe('computeClickIdCoverage — per list', () => {
  it('breaks coverage down per list so a single broken lander is findable', async () => {
    // The fleet number hides the actionable one: one lander that stopped capturing looks
    // like a small dip across the account.
    const d = deps([{ listId: 'L1', name: 'Working' }, { listId: 'L2', name: 'Broken' }], {
      L1: [lead('2026-08-14T10:00:00Z', { fbclid: 'a' }), lead('2026-08-14T11:00:00Z', { fbclid: 'b' })],
      L2: [lead('2026-08-14T10:00:00Z'), lead('2026-08-14T11:00:00Z')],
    });

    const result = await computeClickIdCoverage('u1', 30, d as any);
    const byList = Object.fromEntries(result.lists.map((l: any) => [l.listId, l]));

    expect(byList.L1).toMatchObject({ name: 'Working', leads: 2, withClickId: 2, coverage: 1 });
    expect(byList.L2).toMatchObject({ name: 'Broken', leads: 2, withClickId: 0, coverage: 0 });
  });
});

describe('computeClickIdCoverage — resilience', () => {
  it('follows pagination rather than reading only the first page', async () => {
    const getLeads = jest
      .fn()
      .mockResolvedValueOnce({ items: [lead('2026-08-14T10:00:00Z', { fbclid: 'a' })], lastEvaluatedKey: { k: 1 } })
      .mockResolvedValueOnce({ items: [lead('2026-08-14T11:00:00Z')], lastEvaluatedKey: null });

    const result = await computeClickIdCoverage('u1', 30, {
      getLeadLists: jest.fn().mockResolvedValue([{ listId: 'L1' }]),
      getLeads,
      now: Date.parse('2026-08-15T12:00:00Z'),
    } as any);

    expect(getLeads).toHaveBeenCalledTimes(2);
    expect(result.totals.leads).toBe(2);
  });

  it('one unreadable list does not lose the others', async () => {
    const getLeads = jest.fn(async (listId: string) => {
      if (listId === 'L1') throw new Error('dynamo down');
      return { items: [lead('2026-08-14T10:00:00Z', { fbclid: 'a' })], lastEvaluatedKey: null };
    });

    const result = await computeClickIdCoverage('u1', 30, {
      getLeadLists: jest.fn().mockResolvedValue([{ listId: 'L1' }, { listId: 'L2' }]),
      getLeads,
      now: Date.parse('2026-08-15T12:00:00Z'),
    } as any);

    expect(result.totals.leads).toBe(1);
    expect(result.unreadableLists).toEqual(['L1']);
  });

  it('returns an empty result when the user has no lists', async () => {
    const result = await computeClickIdCoverage('u1', 30, deps([], {}) as any);
    expect(result.totals.leads).toBe(0);
    expect(result.lists).toEqual([]);
  });
});
