import {
  percentile,
  buildCampaignVolumeReport,
  buildLeadVolumeReport,
  MIN_HISTORY_DAYS,
  OBSERVATION_WINDOW_DAYS,
} from '../services/leadVolumeMonitor';
import type { AdsMetricsSnapshotRow } from '../services/adsMetricsDb';

function campaignRow(overrides: Partial<AdsMetricsSnapshotRow> = {}): AdsMetricsSnapshotRow {
  return {
    entityKey: 'meta#act123#camp1',
    date: '2026-08-01',
    rowType: 'campaign',
    platform: 'meta',
    accountId: 'act123',
    parentAccountId: null,
    userId: 'user1',
    currency: 'USD',
    reportingTimezone: 'America/New_York',
    dataQuality: 'exact',
    campaignId: 'camp1',
    campaignName: 'Test Campaign',
    spend: 100,
    impressions: 1000,
    clicks: 50,
    leadCount: 2,
    platformMetrics: {},
    snapshotSource: 'daily',
    capturedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function accountDayRow(overrides: Partial<AdsMetricsSnapshotRow> = {}): AdsMetricsSnapshotRow {
  return {
    entityKey: 'meta#act123#__account_day__',
    date: '2026-08-01',
    rowType: 'account_day',
    platform: 'meta',
    accountId: 'act123',
    parentAccountId: null,
    userId: 'user1',
    currency: 'USD',
    reportingTimezone: 'America/New_York',
    dataQuality: 'exact',
    campaignId: null,
    campaignName: '',
    spend: 100,
    impressions: 1000,
    clicks: 50,
    totalLeadCount: 3,
    unattributedLeadCount: 1,
    campaignsReported: 1,
    platformMetrics: {},
    snapshotSource: 'daily',
    capturedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Builds N days of campaign rows starting at a fixed date, with the given per-day lead counts. */
function daysOf(leads: number[], startDate = '2026-08-01'): AdsMetricsSnapshotRow[] {
  const start = new Date(startDate + 'T00:00:00.000Z');
  return leads.map((leadCount, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return campaignRow({ date: d.toISOString().slice(0, 10), leadCount });
  });
}

describe('percentile', () => {
  it('throws on an empty array', () => {
    expect(() => percentile([], 5)).toThrow(/non-empty/);
  });

  it('throws on an out-of-range percentile', () => {
    expect(() => percentile([1, 2, 3], -1)).toThrow(/within \[0, 100\]/);
    expect(() => percentile([1, 2, 3], 101)).toThrow(/within \[0, 100\]/);
  });

  it('returns the single value for a length-1 array regardless of p', () => {
    expect(percentile([7], 5)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
  });

  it('returns the min at p=0 and max at p=100', () => {
    const arr = [1, 2, 3, 4, 5];
    expect(percentile(arr, 0)).toBe(1);
    expect(percentile(arr, 100)).toBe(5);
  });

  it('interpolates the median correctly for an even-length array', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5, 5);
  });

  it('computes p5 of a mostly-zero distribution as zero — the exact real-world shape from the card', () => {
    // 39 zero-lead days out of 59 (Maintenance Triage's real measured distribution).
    const leads = [...Array(39).fill(0), ...Array(20).fill(1)];
    expect(percentile(leads, 5)).toBe(0);
  });
});

describe('buildCampaignVolumeReport', () => {
  it('throws on an empty row array', () => {
    expect(() => buildCampaignVolumeReport([])).toThrow(/at least one row/);
  });

  it('reports insufficient_history when baseline (excluding the trailing window) is below MIN_HISTORY_DAYS', () => {
    const rows = daysOf(Array(MIN_HISTORY_DAYS - 1 + OBSERVATION_WINDOW_DAYS).fill(1));
    const report = buildCampaignVolumeReport(rows);
    expect(report.status).toBe('insufficient_history');
    expect(report.historicalP5DailyLeads).toBeNull();
    expect(report.observedWindowLeads).toBeNull();
    expect(report.requiresTrackingValidation).toBe(false);
  });

  it('reports normal at exactly MIN_HISTORY_DAYS baseline + observation window with steady volume', () => {
    const rows = daysOf(Array(MIN_HISTORY_DAYS + OBSERVATION_WINDOW_DAYS).fill(2));
    const report = buildCampaignVolumeReport(rows);
    expect(report.status).toBe('normal');
    expect(report.historyDays).toBe(MIN_HISTORY_DAYS + OBSERVATION_WINDOW_DAYS);
  });

  it('does NOT flag a drought on a naturally sparse (mostly-zero) campaign holding steady', () => {
    // Same shape as Maintenance Triage: median-zero baseline, and the trailing window matches
    // that same sparse pattern rather than degrading further — must not fire on this alone.
    const baseline = [...Array(39).fill(0), ...Array(20).fill(1)]; // baseline p5 = 0
    const window = Array(OBSERVATION_WINDOW_DAYS).fill(1);
    const rows = daysOf([...baseline, ...window]);
    const report = buildCampaignVolumeReport(rows);
    expect(report.historicalP5DailyLeads).toBe(0);
    expect(report.status).toBe('normal');
  });

  it('flags a drought when the trailing window genuinely falls below the BASELINE floor, not diluted by including itself', () => {
    // 30 baseline days steady at 5 leads/day (baseline p5 = 5, computed WITHOUT the trailing
    // window), then a trailing window of true zeros. This is the case a red-check caught: an
    // earlier version computed the percentile over the whole series INCLUDING these zero days,
    // which pulled the floor down to meet them and scored this 'normal' instead of 'drought'.
    const baseline = Array(30).fill(5);
    const collapsed = Array(OBSERVATION_WINDOW_DAYS).fill(0);
    const rows = daysOf([...baseline, ...collapsed]);
    const report = buildCampaignVolumeReport(rows);
    expect(report.historicalP5DailyLeads).toBe(5);
    expect(report.status).toBe('drought');
    expect(report.requiresTrackingValidation).toBe(true);
    expect(report.reason).toMatch(/Conversion Tracking Validator/);
  });

  it('a leadCount of undefined on a row is treated as 0, not dropped', () => {
    const rows = daysOf(Array(MIN_HISTORY_DAYS + OBSERVATION_WINDOW_DAYS).fill(1));
    rows[0] = { ...rows[0], leadCount: undefined };
    const report = buildCampaignVolumeReport(rows);
    expect(report.days[0].leads).toBe(0);
    expect(report.historyDays).toBe(MIN_HISTORY_DAYS + OBSERVATION_WINDOW_DAYS); // row still counted
  });

  it('computes totalSpend/totalLeads/costPerLead correctly', () => {
    const rows = [
      campaignRow({ date: '2026-08-01', spend: 100, leadCount: 2 }),
      campaignRow({ date: '2026-08-02', spend: 50, leadCount: 0 }),
    ];
    const report = buildCampaignVolumeReport(rows);
    expect(report.totalSpend).toBe(150);
    expect(report.totalLeads).toBe(2);
    expect(report.costPerLead).toBe(75);
  });

  it('costPerLead is null, not Infinity or NaN, when totalLeads is zero', () => {
    const rows = [campaignRow({ leadCount: 0 })];
    const report = buildCampaignVolumeReport(rows);
    expect(report.costPerLead).toBeNull();
  });
});

describe('buildLeadVolumeReport', () => {
  it('groups mixed-campaign rows correctly, never leaking one campaign into another', () => {
    const campA = daysOf(Array(MIN_HISTORY_DAYS).fill(5), '2026-08-01').map(r => ({ ...r, campaignId: 'campA', entityKey: 'meta#act123#campA' }));
    const campB = daysOf(Array(MIN_HISTORY_DAYS).fill(0), '2026-08-01').map(r => ({ ...r, campaignId: 'campB', entityKey: 'meta#act123#campB' }));
    const report = buildLeadVolumeReport({
      platform: 'meta',
      accountId: 'act123',
      windowStart: '2026-08-01',
      windowEnd: '2026-08-14',
      campaignRows: [...campA, ...campB],
      accountDayRows: [],
    });
    expect(report.campaigns).toHaveLength(2);
    const a = report.campaigns.find(c => c.campaignId === 'campA')!;
    const b = report.campaigns.find(c => c.campaignId === 'campB')!;
    expect(a.totalLeads).toBe(5 * MIN_HISTORY_DAYS);
    expect(b.totalLeads).toBe(0);
  });

  it('keeps unattributed context separate from every campaign — never folded into totalLeads', () => {
    const camp = daysOf(Array(MIN_HISTORY_DAYS).fill(2));
    const accountDays = [
      accountDayRow({ date: '2026-08-01', totalLeadCount: 5, unattributedLeadCount: 3 }),
      accountDayRow({ date: '2026-08-02', totalLeadCount: 4, unattributedLeadCount: 2 }),
    ];
    const report = buildLeadVolumeReport({
      platform: 'meta',
      accountId: 'act123',
      windowStart: '2026-08-01',
      windowEnd: '2026-08-14',
      campaignRows: camp,
      accountDayRows: accountDays,
    });
    expect(report.totalUnattributedLeads).toBe(5);
    expect(report.campaigns[0].totalLeads).toBe(2 * MIN_HISTORY_DAYS); // untouched by unattributed count
    expect(report.unattributedContext).toHaveLength(2);
  });

  it('a nonzero unattributedLeadCount never triggers a drought verdict on a healthy campaign', () => {
    const camp = daysOf(Array(MIN_HISTORY_DAYS + OBSERVATION_WINDOW_DAYS).fill(3)); // steady healthy campaign
    const accountDays = [accountDayRow({ unattributedLeadCount: 999 })]; // huge unattributed count
    const report = buildLeadVolumeReport({
      platform: 'meta',
      accountId: 'act123',
      windowStart: '2026-08-01',
      windowEnd: '2026-08-14',
      campaignRows: camp,
      accountDayRows: accountDays,
    });
    expect(report.campaigns[0].status).toBe('normal');
  });

  it('returns an empty campaigns array for an account with no campaign rows', () => {
    const report = buildLeadVolumeReport({
      platform: 'meta',
      accountId: 'act123',
      windowStart: '2026-08-01',
      windowEnd: '2026-08-14',
      campaignRows: [],
      accountDayRows: [],
    });
    expect(report.campaigns).toEqual([]);
    expect(report.totalUnattributedLeads).toBe(0);
  });

  it('sorts campaign rows into date order internally even when passed out of order', () => {
    const rows = daysOf(Array(MIN_HISTORY_DAYS).fill(1));
    const shuffled = [rows[5], rows[0], rows[10], ...rows.slice(1, 5), ...rows.slice(6, 10), ...rows.slice(11)];
    const report = buildLeadVolumeReport({
      platform: 'meta',
      accountId: 'act123',
      windowStart: '2026-08-01',
      windowEnd: '2026-08-14',
      campaignRows: shuffled,
      accountDayRows: [],
    });
    const dates = report.campaigns[0].days.map(d => d.date);
    const sortedDates = [...dates].sort();
    expect(dates).toEqual(sortedDates);
  });
});
