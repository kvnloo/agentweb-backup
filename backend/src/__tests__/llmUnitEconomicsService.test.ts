/**
 * ENG-1139 — per-billing-subject unit economics.
 *
 * The two things most likely to go quietly wrong here are both about honesty
 * rather than arithmetic, so they are asserted first:
 *
 *  - thresholds must come from the LIVE policy, never a constant. The ticket's
 *    table was written against Starter $60 / Pro $150 and production moved to
 *    $80 / $200 on 2026-09-01, with Super Premium never having had a row. A
 *    report that disagrees with the enforcer about where the cap sits is worse
 *    than no report.
 *  - vendor spend must not be presented as all-in. Most ENG-666 vendors write
 *    no ledger rows, so a summed "all-in" figure would read as the overhead
 *    envelope being comfortably met when it is simply unmeasured.
 */

import * as fs from 'fs';
import * as path from 'path';

const mockScanByDateRange = jest.fn();
const mockGetAllUsers = jest.fn();
const mockGetSubscriptionTypeConfig = jest.fn();

jest.mock('../services/usageRecordDb', () => ({
  ...jest.requireActual('../services/usageRecordDb'),
  usageRecordDb: { scanByDateRange: (...a: any[]) => mockScanByDateRange(...a) },
}));
jest.mock('../services/db', () => ({
  userDb: { getAllUsers: (...a: any[]) => mockGetAllUsers(...a) },
}));
jest.mock('../services/subscriptionService', () => ({
  getSubscriptionTypeConfig: (...a: any[]) => mockGetSubscriptionTypeConfig(...a),
}));

import {
  buildUnitEconomicsReport,
  buildUnitEconomicsCsv,
  computeTargetFields,
  monthBounds,
  TIER_OVERHEAD_ENVELOPE_USD,
} from '../services/llmUnitEconomicsService';

const llmRow = (billingUserId: string, costMicroUsd: number, model = 'gpt-5.4') => ({
  userId: billingUserId, billingUserId, sk: `2026-09-05#${model}#agent_task`,
  date: '2026-09-05', model, feature: 'agent_task', costMicroUsd, callCount: 1,
  totalTokens: 100, updatedAt: '', ttl: 0,
});
const vendorRow = (billingUserId: string, costMicroUsd: number) => ({
  userId: billingUserId, billingUserId, sk: '2026-09-05#twitter:read#social',
  date: '2026-09-05', model: 'twitter:read', feature: 'social', costMicroUsd,
  callCount: 1, updatedAt: '', ttl: 0, provider: 'twitter', unit: 'read', quantity: 3,
});

const PRO_POLICY = { llmUsagePolicy: { enforcementState: 'hard_only', hardCostThresholdMicroUsd: 200_000_000 } };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSubscriptionTypeConfig.mockResolvedValue(PRO_POLICY);
});

describe('monthBounds', () => {
  it('covers the whole month including a 31st and a leap February', () => {
    expect(monthBounds('2026-09')).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    expect(monthBounds('2026-01')).toEqual({ start: '2026-01-01', end: '2026-01-31' });
    expect(monthBounds('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(monthBounds('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });
  it('rejects anything that is not YYYY-MM', () => {
    for (const bad of ['2026', '2026-13', '2026-00', 'nope']) {
      expect(() => monthBounds(bad)).toThrow();
    }
  });
});

describe('thresholds come from the live policy, never a constant', () => {
  it('uses whatever hardCostThresholdMicroUsd the tier currently carries', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 50_000_000)]);
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', email: 'a@x.com', subscriptionType: 'Pro' }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].includedThresholdUsd).toBe(200);
    expect(r.rows[0].percentUsed).toBe(25);
  });

  it('follows the policy when it moves, rather than the ticket’s old table', async () => {
    // Starter's ticket value was $60; production moved it to $80.
    mockGetSubscriptionTypeConfig.mockResolvedValue({
      llmUsagePolicy: { enforcementState: 'hard_only', hardCostThresholdMicroUsd: 80_000_000 },
    });
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 40_000_000)]);
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', email: 'a@x.com', subscriptionType: 'Starter' }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].includedThresholdUsd).toBe(80);
    expect(r.rows[0].percentUsed).toBe(50);
  });

  it('reports a tier with no policy as uncapped and alerts on it', async () => {
    mockGetSubscriptionTypeConfig.mockResolvedValue({});
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 300_000_000)]);
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', email: 'm@x.com', subscriptionType: 'Managed' }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].includedThresholdUsd).toBeNull();
    expect(r.rows[0].percentUsed).toBeNull();
    expect(r.alerts.find((a) => a.kind === 'uncapped_tier')?.count).toBe(1);
  });
});

describe('all-in cost (AC3) — coverage is now complete', () => {
  // The prior invariant ("coverage partial, so never sum an all-in") no longer
  // applies: as of 2026-09-14 every paid vendor writes to the ledger, so the
  // all-in figure is honest. The enduring invariant is that all-in still
  // SEPARATES its parts rather than presenting one opaque number.
  it('sums an honest all-in and keeps the parts separable', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 10_000_000), vendorRow('u1', 2_000_000)]);
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', email: 'a@x.com', subscriptionType: 'Pro' }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].llmCostUsd).toBe(10);
    expect(r.rows[0].vendorCostUsd).toBe(2);
    expect(r.rows[0].vendorCoverage).toBe('complete');
    // The all-in is the sum, and the parts remain individually readable.
    expect(r.rows[0].allInCostUsd).toBe(12);
    expect(r.rows[0].llmCostUsd + r.rows[0].vendorCostUsd).toBe(r.rows[0].allInCostUsd);
    expect(r.vendorCoverageNote).toMatch(/complete/i);
  });

  it('per-account infrastructure is $0 — shared overhead is not per-account attributable', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 10_000_000), vendorRow('u1', 2_000_000)]);
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', email: 'a@x.com', subscriptionType: 'Pro' }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].infrastructureUsd).toBe(0);
  });

  it('measures admitted-work overrun against the effective cap', async () => {
    // Pro cap is $200; $250 of LLM spend admitted before the boundary => $50 overrun.
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 250_000_000)]);
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', email: 'a@x.com', subscriptionType: 'Pro' }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].admittedWorkOverrunUsd).toBe(50);
  });

  it('reports $0 overrun for an account within its cap', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 10_000_000)]);
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', email: 'a@x.com', subscriptionType: 'Pro' }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].admittedWorkOverrunUsd).toBe(0);
  });

  it('reports $0 overrun for an uncapped tier — it cannot overrun a cap it does not have', async () => {
    mockGetSubscriptionTypeConfig.mockResolvedValue({}); // no llmUsagePolicy
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 999_000_000)]);
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', email: 'a@x.com', subscriptionType: 'Unpriced' }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].admittedWorkOverrunUsd).toBe(0);
    expect(r.rows[0].allInCostUsd).toBe(999);
  });
});

describe('credit ledger and the cap arithmetic', () => {
  it('subtracts the migration offset from what the cap counts, and adds credits to the ceiling', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 250_000_000)]);
    mockGetAllUsers.mockResolvedValue([{
      userId: 'u1', email: 'a@x.com', subscriptionType: 'Pro',
      llmUsageCredits: {
        month: '2026-09', totalMigrationOffsetMicroUsd: 50_000_000,
        totalPurchasedMicroUsd: 60_000_000, totalPurchasedReversedMicroUsd: 0,
        totalAdminGrantedMicroUsd: 40_000_000,
      },
    }]);
    const r = await buildUnitEconomicsReport('2026-09');
    const row = r.rows[0];
    expect(row.llmCostUsd).toBe(250);
    expect(row.policyCostUsd).toBe(200);          // 250 - 50 offset
    expect(row.effectiveThresholdUsd).toBe(300);  // 200 + 60 purchased + 40 admin
    expect(row.percentUsed).toBeCloseTo(66.67, 1);
    expect(row.purchasedCredits).toBe(true);
  });

  it('ignores a credit ledger from a different month', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 10_000_000)]);
    mockGetAllUsers.mockResolvedValue([{
      userId: 'u1', email: 'a@x.com', subscriptionType: 'Pro',
      llmUsageCredits: { month: '2026-08', totalPurchasedMicroUsd: 999_000_000, totalMigrationOffsetMicroUsd: 999_000_000 },
    }]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0].purchasedCreditsUsd).toBe(0);
    expect(r.rows[0].migrationOffsetUsd).toBe(0);
    expect(r.rows[0].policyCostUsd).toBe(10);
  });
});

// AC2 (ledger vs the legacy counter) was retired with the counter: ENG-1250 AC7. The cap
// enforces on the ledger itself, so there is nothing left to reconcile against.

describe('AC1 — filters', () => {
  const seed = () => {
    mockScanByDateRange.mockResolvedValue([
      llmRow('u1', 10_000_000, 'gpt-5.4'),
      llmRow('u2', 20_000_000, 'gemini-3.5-flash'),
    ]);
    mockGetAllUsers.mockResolvedValue([
      { userId: 'u1', email: 'alpha@x.com', subscriptionType: 'Pro' },
      { userId: 'u2', email: 'beta@y.com', subscriptionType: 'Starter',
        llmUsageCredits: { month: '2026-09', totalPurchasedMicroUsd: 5_000_000 } },
    ]);
  };
  it('filters by tier', async () => { seed();
    expect((await buildUnitEconomicsReport('2026-09', { tier: 'Starter' })).rows.map(r => r.email)).toEqual(['beta@y.com']); });
  it('filters by account substring on id or email', async () => { seed();
    expect((await buildUnitEconomicsReport('2026-09', { account: 'ALPHA' })).rows.map(r => r.email)).toEqual(['alpha@x.com']); });
  it('filters by model', async () => { seed();
    expect((await buildUnitEconomicsReport('2026-09', { model: 'gemini-3.5-flash' })).rows.map(r => r.email)).toEqual(['beta@y.com']); });
  it('filters to accounts that purchased credits', async () => { seed();
    expect((await buildUnitEconomicsReport('2026-09', { purchasedOnly: true })).rows.map(r => r.email)).toEqual(['beta@y.com']); });
  it('does not leak the internal model set into the response', async () => { seed();
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.rows[0]).not.toHaveProperty('_models'); });
});

describe('AC5 — alerting is aggregate, not per-account', () => {
  it('emits one counted alert rather than one entry per heavy account', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 300_000_000), llmRow('u2', 400_000_000)]);
    mockGetAllUsers.mockResolvedValue([
      { userId: 'u1', email: 'a@x.com', subscriptionType: 'Pro' },
      { userId: 'u2', email: 'b@x.com', subscriptionType: 'Pro' },
    ]);
    const r = await buildUnitEconomicsReport('2026-09');
    const over = r.alerts.filter((a) => a.kind === 'over_threshold');
    expect(over).toHaveLength(1);
    expect(over[0].count).toBe(2);
  });
});

describe('AC3 — target comparison (live hard threshold + overhead envelope)', () => {
  const policyFor = (usd: number) => ({
    llmUsagePolicy: { enforcementState: 'hard_only', hardCostThresholdMicroUsd: usd * 1_000_000 },
  });
  // Live caps as of 2026-11-16, served per tier name like getSubscriptionTypeConfig.
  let LIVE: Record<string, ReturnType<typeof policyFor> | null> = {};
  beforeEach(() => {
    LIVE = { Free: policyFor(5), Starter: policyFor(80), Pro: policyFor(200) };
    mockGetSubscriptionTypeConfig.mockImplementation(async (t: string) => LIVE[t] ?? null);
  });
  const run = async (tier: string, costUsd: number, vendorUsd = 0) => {
    mockScanByDateRange.mockResolvedValue([
      llmRow('u1', costUsd * 1_000_000),
      ...(vendorUsd ? [vendorRow('u1', vendorUsd * 1_000_000)] : []),
    ]);
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', email: 'a@x.com', subscriptionType: tier }]);
    return buildUnitEconomicsReport('2026-09');
  };

  it('resolves Free $7, Starter $93, Pro $230, Super Premium $230 from the live caps', async () => {
    const got: Record<string, number | null> = {};
    for (const tier of ['Free', 'Starter', 'Pro', 'Super Premium']) {
      got[tier] = (await run(tier, 1)).rows[0].targetAllInUsd;
    }
    expect(got).toEqual({ Free: 7, Starter: 93, Pro: 230, 'Super Premium': 230 });
  });

  it('follows the policy when the cap moves (never a hardcoded threshold)', async () => {
    LIVE.Starter = policyFor(100);
    expect((await run('Starter', 1)).rows[0].targetAllInUsd).toBe(113);
  });

  it('computes variance = actual - target and flags overTarget only above it', async () => {
    const under = (await run('Pro', 100, 5)).rows[0];
    expect(under).toMatchObject({ allInCostUsd: 105, targetAllInUsd: 230, varianceUsd: -125, overTarget: false });
    const at = (await run('Pro', 200, 30)).rows[0];
    expect(at).toMatchObject({ varianceUsd: 0, overTarget: false });
    const over = (await run('Pro', 220, 15)).rows[0];
    expect(over).toMatchObject({ allInCostUsd: 235, varianceUsd: 5, overTarget: true });
  });

  it('counts vendor spend toward the comparison, not only LLM', async () => {
    const r = (await run('Free', 5, 3)).rows[0];
    expect(r).toMatchObject({ allInCostUsd: 8, targetAllInUsd: 7, varianceUsd: 1, overTarget: true });
  });

  it('gives an unknown or unpriced tier no target and never flags it', async () => {
    const r = (await run('Managed', 900)).rows[0];
    expect(r).toMatchObject({ targetAllInUsd: null, varianceUsd: null, overTarget: false });
  });

  it('prefers a Super Premium policy row of its own over the Pro fallback', async () => {
    LIVE['Super Premium'] = policyFor(300);
    expect((await run('Super Premium', 1)).rows[0].targetAllInUsd).toBe(330);
  });

  it('aggregates per tier: summed target, variance, and an over-target account count', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 250_000_000), llmRow('u2', 10_000_000)]);
    mockGetAllUsers.mockResolvedValue([
      { userId: 'u1', email: 'a@x.com', subscriptionType: 'Pro' },
      { userId: 'u2', email: 'b@x.com', subscriptionType: 'Pro' },
    ]);
    const t = (await buildUnitEconomicsReport('2026-09')).byTier[0];
    expect(t).toMatchObject({ targetAllInUsd: 460, varianceUsd: -200, overTarget: false, overTargetAccounts: 1 });
  });

  it('alerts once per kind (aggregate), flagging tiers and a count of accounts', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 250_000_000), llmRow('u2', 260_000_000)]);
    mockGetAllUsers.mockResolvedValue([
      { userId: 'u1', email: 'a@x.com', subscriptionType: 'Pro' },
      { userId: 'u2', email: 'b@x.com', subscriptionType: 'Pro' },
    ]);
    const r = await buildUnitEconomicsReport('2026-09');
    const tiers = r.alerts.filter((a) => a.kind === 'tier_over_target');
    expect(tiers).toHaveLength(1);
    expect(tiers[0].detail).toContain('Pro');
    const acct = r.alerts.filter((a) => a.kind === 'account_over_target');
    expect(acct).toHaveLength(1);
    expect(acct[0].count).toBe(2);
    expect(acct[0].detail).not.toMatch(/u1|u2|@x\.com/);
  });

  it('returns empty tiers, no alerts and a header-only CSV for a month with no rows', async () => {
    mockScanByDateRange.mockResolvedValue([]);
    mockGetAllUsers.mockResolvedValue([]);
    const r = await buildUnitEconomicsReport('2026-09');
    expect(r.byTier).toEqual([]);
    expect(r.alerts).toEqual([]);
    expect(buildUnitEconomicsCsv(r).trim().split('\n')).toHaveLength(1);
  });

  it('has no target (and says so) when the policy is missing but the envelope is known', async () => {
    LIVE.Pro = null;
    const r = await run('Pro', 900);
    expect(r.rows[0]).toMatchObject({ targetAllInUsd: null, varianceUsd: null, overTarget: false });
    expect(r.byTier[0]).toMatchObject({ targetAllInUsd: null, varianceUsd: null, overTarget: false });
    const a = r.alerts.find((x) => x.kind === 'tier_no_target');
    expect(a).toMatchObject({ count: 1 });
    expect(a?.detail).toContain('Pro');
    expect(a?.detail).not.toMatch(/u1|a@x\.com/);
  });

  it('gives Super Premium no target when neither its own row nor Pro has a policy', async () => {
    LIVE.Pro = null;
    const r = await run('Super Premium', 5);
    expect(r.rows[0].targetAllInUsd).toBeNull();
    expect(r.alerts.some((x) => x.kind === 'tier_no_target')).toBe(true);
  });

  it('raises tier_no_target for a tier missing from the envelope map', async () => {
    const r = await run('Managed', 5);
    expect(r.alerts.find((x) => x.kind === 'tier_no_target')?.detail).toContain('Managed');
  });

  it('renders a null target as empty CSV cells', async () => {
    const csv = buildUnitEconomicsCsv(await run('Managed', 5));
    expect(csv.trim().split('\n')[1]).toBe('u1,a@x.com,Managed,5,0,0,0,5,,,false');
  });

  it('quotes emails with a quote or newline and leaves negative variance unprefixed', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 10_000_000)]);
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', email: 'a"b\nc@x.com', subscriptionType: 'Pro' }]);
    const csv = buildUnitEconomicsCsv(await buildUnitEconomicsReport('2026-09'));
    expect(csv).toContain('u1,"a""b\nc@x.com",Pro,10,0,0,0,10,230,-220,false');
  });

  it('keeps tier and account alerts independent across mixed tiers', async () => {
    mockScanByDateRange.mockResolvedValue([
      llmRow('u1', 250_000_000), // Pro, over its own $230
      llmRow('u2', 1_000_000), // Pro, under
      llmRow('u3', 1_000_000), // Starter, under
      llmRow('u4', 6_000_000), // Free, under its $7
    ]);
    mockGetAllUsers.mockResolvedValue([
      { userId: 'u1', subscriptionType: 'Pro' },
      { userId: 'u2', subscriptionType: 'Pro' },
      { userId: 'u3', subscriptionType: 'Starter' },
      { userId: 'u4', subscriptionType: 'Free' },
    ]);
    const r = await buildUnitEconomicsReport('2026-09');
    // Pro aggregate: 251 actual vs 460 target => tier under, but one account over.
    expect(r.alerts.find((a) => a.kind === 'tier_over_target')).toBeUndefined();
    expect(r.alerts.find((a) => a.kind === 'account_over_target')?.count).toBe(1);
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 500_000_000), llmRow('u3', 1_000_000)]);
    const r2 = await buildUnitEconomicsReport('2026-09');
    const t = r2.alerts.find((a) => a.kind === 'tier_over_target');
    expect(t?.count).toBe(1);
    expect(t?.detail).toContain('Pro');
    expect(t?.detail).not.toContain('Starter');
  });

  it('computeTargetFields is pure arithmetic over a resolved threshold', () => {
    expect(computeTargetFields('Starter', 80_000_000, 100)).toEqual({ targetAllInUsd: 93, varianceUsd: 7, overTarget: true });
    expect(computeTargetFields('Starter', null, 100)).toEqual({ targetAllInUsd: null, varianceUsd: null, overTarget: false });
    expect(computeTargetFields('Nope', 80_000_000, 100).targetAllInUsd).toBeNull();
  });

  it('builds the note from the envelope constant, with no withheld wording', async () => {
    const note = (await run('Pro', 1)).vendorCoverageNote;
    for (const [tier, usd] of Object.entries(TIER_OVERHEAD_ENVELOPE_USD)) {
      expect(note).toContain(`${tier} $${usd}`);
    }
  });

  it('exports separated parts and actual vs target as CSV, escaping hostile emails', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 220_000_000), vendorRow('u1', 15_000_000)]);
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', email: '=HYPERLINK("x"),y@x.com', subscriptionType: 'Pro' }]);
    const csv = buildUnitEconomicsCsv(await buildUnitEconomicsReport('2026-09'));
    const [header, line] = csv.trim().split('\n');
    expect(header).toBe(
      'billingUserId,email,tier,llmCostUsd,nonLlmVendorCostUsd,admittedWorkOverrunUsd,infrastructureUsd,actualAllInUsd,targetAllInUsd,varianceUsd,overTarget',
    );
    expect(line).toBe('u1,"\'=HYPERLINK(""x""),y@x.com",Pro,220,15,20,0,235,230,5,true');
  });

  it('prefixes an email that starts with a line feed so a spreadsheet cannot read it as a formula', async () => {
    mockScanByDateRange.mockResolvedValue([llmRow('u1', 10_000_000)]);
    mockGetAllUsers.mockResolvedValue([{ userId: 'u1', email: '\n=1+1@x.com', subscriptionType: 'Pro' }]);
    const csv = buildUnitEconomicsCsv(await buildUnitEconomicsReport('2026-09'));
    expect(csv).toContain('"\'\n=1+1@x.com"');
  });
});

describe('AC6 — customer-facing code never reaches the target or cost economics', () => {
  // The ONLY non-test source files allowed to mention the unit-economics service
  // or its target fields. Adding a file here means exposing COGS targets from it:
  // it must be admin-gated. Customer APIs must never carry these (AC6).
  const ADMIN_ONLY_ALLOW_LIST = ['routes/adminUsage.ts', 'services/llmUnitEconomicsService.ts'];

  it('no other source file imports the service or mentions target fields', () => {
    const src = path.join(__dirname, '..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p);
        } else if (/\.tsx?$/.test(e.name)) {
          const text = fs.readFileSync(p, 'utf8');
          if (/llmUnitEconomicsService|targetAllInUsd|TIER_OVERHEAD_ENVELOPE_USD/.test(text)) {
            hits.push(path.relative(src, p));
          }
        }
      }
    };
    walk(src);
    expect(hits.sort()).toEqual(ADMIN_ONLY_ALLOW_LIST);
  });
});
