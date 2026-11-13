import {
  ledgerForOrg,
  reducePlaybookLedger,
  PlaybookLedgerEvent,
} from '../marketingPlaybookLedger';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-01T00:00:00Z');
const NOW = T0 + 30 * DAY;

const base: PlaybookLedgerEvent[] = [
  { type: 'created', orgId: 'orgA', playbookId: 'pb1', version: 1, evidenceIds: ['ev2', 'ev1'], at: T0 },
  {
    type: 'version_published',
    orgId: 'orgA',
    playbookId: 'pb1',
    version: 2,
    parentVersion: 1,
    evidenceIds: [],
    at: T0 + DAY,
  },
  { type: 'applied', orgId: 'orgA', playbookId: 'pb1', version: 1, campaignId: 'c1', actionEnvelopeId: 'a1', at: T0 + 2 * DAY },
  { type: 'applied', orgId: 'orgA', playbookId: 'pb1', version: 1, campaignId: 'c2', actionEnvelopeId: 'a2', at: T0 + 3 * DAY },
  { type: 'applied', orgId: 'orgA', playbookId: 'pb1', version: 1, campaignId: 'c1', actionEnvelopeId: 'a3', at: T0 + 5 * DAY },
  { type: 'outcome', orgId: 'orgA', playbookId: 'pb1', version: 1, verdict: 'win', at: T0 + 6 * DAY },
  { type: 'outcome', orgId: 'orgA', playbookId: 'pb1', version: 1, verdict: 'loss', at: T0 + 6 * DAY },
  { type: 'outcome', orgId: 'orgA', playbookId: 'pb1', version: 1, verdict: 'neutral', at: T0 + 7 * DAY },
  { type: 'created', orgId: 'orgB', playbookId: 'pb2', version: 1, evidenceIds: ['evB'], at: T0 },
  { type: 'applied', orgId: 'orgB', playbookId: 'pb2', version: 1, campaignId: 'cB', actionEnvelopeId: 'aB', at: T0 + DAY },
];

describe('reducePlaybookLedger', () => {
  it('returns empty ledger for empty input', () => {
    expect(reducePlaybookLedger([], NOW)).toEqual({ entries: [], rejected: [] });
  });

  it('computes per-version usage, campaigns, timestamps and outcomes', () => {
    const { entries, rejected } = reducePlaybookLedger(base, NOW);
    expect(rejected).toEqual([]);
    const v1 = entries.find((e) => e.playbookId === 'pb1' && e.version === 1)!;
    expect(v1).toMatchObject({
      usageCount: 3,
      distinctCampaigns: 2,
      campaignIds: ['c1', 'c2'],
      firstUsedAt: T0 + 2 * DAY,
      lastUsedAt: T0 + 5 * DAY,
      daysSinceLastUse: 25,
      outcomes: { win: 1, loss: 1, neutral: 1 },
    });
    const v2 = entries.find((e) => e.playbookId === 'pb1' && e.version === 2)!;
    expect(v2).toMatchObject({ usageCount: 0, firstUsedAt: null, lastUsedAt: null, daysSinceLastUse: 29 });
  });

  it('records provenance and flags versions without evidence', () => {
    const { entries } = reducePlaybookLedger(base, NOW);
    const v1 = entries.find((e) => e.playbookId === 'pb1' && e.version === 1)!;
    const v2 = entries.find((e) => e.playbookId === 'pb1' && e.version === 2)!;
    expect(v1.evidenceIds).toEqual(['ev1', 'ev2']);
    expect(v1.parentVersion).toBeNull();
    expect(v1.flags).toEqual([]);
    expect(v2.parentVersion).toBe(1);
    expect(v2.flags).toEqual(['missing_provenance']);
  });

  it('isolates tenants and rejects cross-org events with org_mismatch', () => {
    const events: PlaybookLedgerEvent[] = [
      ...base,
      { type: 'applied', orgId: 'orgB', playbookId: 'pb1', version: 1, campaignId: 'cX', actionEnvelopeId: 'aX', at: T0 + 8 * DAY },
      { type: 'outcome', orgId: 'orgB', playbookId: 'pb1', version: 1, verdict: 'win', at: T0 + 8 * DAY },
      { type: 'created', orgId: 'orgB', playbookId: 'pb1', version: 1, evidenceIds: ['evil'], at: T0 + 9 * DAY },
    ];
    const ledger = reducePlaybookLedger(events, NOW);
    expect(ledger.rejected.map((r) => r.reason)).toEqual(['org_mismatch', 'org_mismatch', 'org_mismatch']);
    const v1 = ledger.entries.find((e) => e.playbookId === 'pb1' && e.version === 1)!;
    expect(v1.usageCount).toBe(3);
    expect(v1.campaignIds).not.toContain('cX');
    expect(v1.outcomes.win).toBe(1);
    expect(ledgerForOrg(ledger, 'orgB').map((e) => e.playbookId)).toEqual(['pb2']);
    expect(ledgerForOrg(ledger, 'orgA').every((e) => e.orgId === 'orgA')).toBe(true);
  });

  it('is order-independent and deterministic for out-of-order input', () => {
    const shuffled = [...base].reverse();
    const a = reducePlaybookLedger(base, NOW);
    const b = reducePlaybookLedger(shuffled, NOW);
    expect(b.entries).toEqual(a.entries);
    expect(b.rejected).toEqual([]);
    expect(a.entries.map((e) => `${e.orgId}/${e.playbookId}/${e.version}`)).toEqual([
      'orgA/pb1/1',
      'orgA/pb1/2',
      'orgB/pb2/1',
    ]);
  });

  it('rejects malformed, future, unknown and bad-verdict events without counting', () => {
    const events = [
      base[0],
      { type: 'applied', orgId: 'orgA', playbookId: 'pb1', version: 1, campaignId: '', actionEnvelopeId: 'a', at: T0 },
      { type: 'applied', orgId: 'orgA', playbookId: 'pb1', version: 1, campaignId: 'c', actionEnvelopeId: 'a', at: NOW + 1 },
      { type: 'applied', orgId: 'orgA', playbookId: 'pb1', version: 1, campaignId: 'c', actionEnvelopeId: 'a', at: 'nope' },
      { type: 'applied', orgId: 'orgA', playbookId: 'pbX', version: 1, campaignId: 'c', actionEnvelopeId: 'a', at: T0 },
      { type: 'applied', orgId: 'orgA', playbookId: 'pb1', version: 9, campaignId: 'c', actionEnvelopeId: 'a', at: T0 },
      { type: 'outcome', orgId: 'orgA', playbookId: 'pb1', version: 1, verdict: 'great', at: T0 },
    ] as PlaybookLedgerEvent[];
    const { entries, rejected } = reducePlaybookLedger(events, NOW);
    expect(rejected.map((r) => r.reason)).toEqual([
      'malformed_event',
      'future_event',
      'invalid_timestamp',
      'unknown_playbook',
      'unknown_version',
      'unknown_verdict',
    ]);
    expect(entries[0].usageCount).toBe(0);
    expect(entries[0].outcomes).toEqual({ win: 0, loss: 0, neutral: 0 });
  });
});
