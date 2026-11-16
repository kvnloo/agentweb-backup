import { evaluatePlaybookPolicy, PlaybookOutcomeRecord } from '../marketingPlaybookPolicy';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-03T00:00:00Z');

let seq = 0;
function rec(p: Partial<PlaybookOutcomeRecord> & { daysAgo?: number }): PlaybookOutcomeRecord {
  seq += 1;
  return {
    id: p.id ?? `r${String(seq).padStart(3, '0')}`,
    orgId: p.orgId ?? 'orgA',
    campaignId: p.campaignId ?? 'c1',
    actionKind: p.actionKind ?? 'pause_ad',
    verdict: p.verdict ?? 'win',
    evaluatedAt: p.evaluatedAt ?? NOW - (p.daysAgo ?? 1) * DAY,
  };
}
const wins = (n: number, p: Partial<PlaybookOutcomeRecord> & { daysAgo?: number } = {}) =>
  Array.from({ length: n }, () => rec({ ...p, verdict: 'win' }));

const find = (out: ReturnType<typeof evaluatePlaybookPolicy>, q: Record<string, unknown>) =>
  out.find((d) => Object.entries(q).every(([k, v]) => (d as unknown as Record<string, unknown>)[k] === v));

describe('evaluatePlaybookPolicy (ENG-2793)', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('AC2: evidence from org A never contributes to org B', () => {
    const a = wins(4, { orgId: 'orgA', campaignId: 'c1' }).concat(wins(4, { orgId: 'orgA', campaignId: 'c2' }));
    const b = [rec({ orgId: 'orgB', campaignId: 'c1' })];
    const out = evaluatePlaybookPolicy([...a, ...b], { now: NOW });
    const aIds = new Set(a.map((r) => r.id));
    for (const d of out.filter((x) => x.orgId === 'orgB')) {
      expect(d.evidenceIds.some((id) => aIds.has(id))).toBe(false);
      expect(d.decision).toBe('hold');
    }
    expect(find(out, { orgId: 'orgA', scope: 'tenant' })?.decision).toBe('promote_tenant');
    expect(find(out, { orgId: 'orgB', scope: 'tenant' })?.evidenceIds).toEqual([b[0].id]);
    // Same campaign id in a different org is still a separate group.
    expect(find(out, { orgId: 'orgB', scope: 'campaign', campaignId: 'c1' })?.reasonCodes).toContain(
      'insufficient_evidence',
    );
  });

  it('AC3: single-campaign evidence promotes only to campaign scope', () => {
    const out = evaluatePlaybookPolicy(wins(10, { campaignId: 'c1' }), { now: NOW });
    expect(find(out, { scope: 'campaign', campaignId: 'c1' })?.decision).toBe('promote_campaign');
    const t = find(out, { scope: 'tenant' });
    expect(t?.decision).toBe('hold');
    expect(t?.reasonCodes).toContain('insufficient_campaigns');
  });

  it('AC3: tenant scope needs a stricter threshold across >=2 campaigns', () => {
    // 3 wins per campaign meets campaign threshold; 6 total meets tenant evidence count.
    const ok = evaluatePlaybookPolicy(
      [...wins(3, { campaignId: 'c1' }), ...wins(3, { campaignId: 'c2' })],
      { now: NOW },
    );
    expect(find(ok, { scope: 'tenant' })?.decision).toBe('promote_tenant');

    // 4/5 per campaign = 0.8 >= campaign 0.75 but < tenant 0.85.
    const strict = evaluatePlaybookPolicy(
      [
        ...wins(4, { campaignId: 'c1' }),
        rec({ campaignId: 'c1', verdict: 'neutral' }),
        ...wins(4, { campaignId: 'c2' }),
        rec({ campaignId: 'c2', verdict: 'neutral' }),
      ],
      { now: NOW },
    );
    expect(find(strict, { scope: 'campaign', campaignId: 'c1' })?.decision).toBe('promote_campaign');
    expect(find(strict, { scope: 'tenant' })?.decision).toBe('hold');
    expect(find(strict, { scope: 'tenant' })?.reasonCodes).toEqual(['below_win_rate']);
  });

  it('AC3: never emits a global scope', () => {
    const out = evaluatePlaybookPolicy(
      [...wins(5, { orgId: 'o1', campaignId: 'a' }), ...wins(5, { orgId: 'o2', campaignId: 'b' })],
      { now: NOW },
    );
    expect(out.every((d) => d.scope === 'campaign' || d.scope === 'tenant')).toBe(true);
  });

  it('AC4: stale and expire by newest evidence age, with configurable windows', () => {
    const stale = evaluatePlaybookPolicy(wins(5, { daysAgo: 40 }), { now: NOW });
    expect(find(stale, { scope: 'campaign' })?.decision).toBe('stale');
    expect(find(stale, { scope: 'tenant' })?.reasonCodes).toEqual(['evidence_stale']);

    const expired = evaluatePlaybookPolicy(wins(5, { daysAgo: 120 }), { now: NOW });
    expect(find(expired, { scope: 'campaign' })?.decision).toBe('expire');

    const custom = evaluatePlaybookPolicy(wins(5, { daysAgo: 10 }), {
      now: NOW,
      staleAfterMs: 5 * DAY,
      expireAfterMs: 8 * DAY,
    });
    expect(find(custom, { scope: 'campaign' })?.decision).toBe('expire');

    // One fresh record keeps the group fresh.
    const mixed = evaluatePlaybookPolicy([...wins(4, { daysAgo: 60 }), ...wins(1, { daysAgo: 1 })], { now: NOW });
    expect(find(mixed, { scope: 'campaign' })?.decision).toBe('promote_campaign');
  });

  it('AC5: contradictory evidence below threshold holds with reason code', () => {
    const out = evaluatePlaybookPolicy(
      [...wins(2), rec({ verdict: 'loss' }), rec({ verdict: 'loss' })],
      { now: NOW },
    );
    const c = find(out, { scope: 'campaign' });
    expect(c?.decision).toBe('hold');
    expect(c?.reasonCodes).toContain('contradictory_evidence');
  });

  it('drops malformed and future-dated records; is deterministic; reads no clock', () => {
    const spy = jest.spyOn(Date, 'now');
    const input = [
      ...wins(3),
      rec({ verdict: 'maybe' }),
      rec({ orgId: '' }),
      rec({ evaluatedAt: 'not-a-date' }),
      rec({ evaluatedAt: NOW + DAY }),
    ];
    const a = evaluatePlaybookPolicy(input, { now: NOW });
    const b = evaluatePlaybookPolicy([...input].reverse(), { now: NOW });
    expect(a).toEqual(b);
    expect(find(a, { scope: 'campaign' })?.evidenceIds).toEqual(['r001', 'r002', 'r003']);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(() => evaluatePlaybookPolicy([], { now: NaN })).toThrow();
  });
});
