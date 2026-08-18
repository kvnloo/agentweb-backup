import { buildUsageBlockInfo, buildUsageBlockInfoForUser } from '../services/usageBlockMessageService';
import { settingsService } from '../services/settingsService';
import { getUserSubscriptionType } from '../services/subscriptionService';

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
  },
}));

jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionType: jest.fn(),
}));

const mockGetSetting = settingsService.getSetting as jest.Mock;
const mockGetUserSubscriptionType = getUserSubscriptionType as jest.Mock;

describe('buildUsageBlockInfo (ENG-1344)', () => {
  const REAL_DATE = Date;

  afterEach(() => {
    jest.clearAllMocks();
    global.Date = REAL_DATE;
  });

  function freezeDate(iso: string) {
    const fixed = new Date(iso);
    class FrozenDate extends REAL_DATE {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(fixed.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }
      static now() {
        return fixed.getTime();
      }
    }
    // @ts-ignore
    global.Date = FrozenDate;
  }

  it('names a cost block in dollars, never raw token counts (AC1)', async () => {
    mockGetSetting.mockResolvedValue(null);
    freezeDate('2026-08-18T12:00:00.000Z');

    const info = await buildUsageBlockInfo({
      currentTierName: 'Basic',
      blockedByCost: true,
      costUsed: 42.5,
      costAllowance: 50,
      used: 999999,
      allowance: 1000000,
    });

    expect(info.exhausted).toBe('cost');
    expect(info.usedLabel).toContain('$42.50');
    expect(info.usedLabel).toContain('$50.00');
    expect(info.usedLabel).not.toMatch(/\d{4,}\s*tokens/i);
  });

  it('names a token block in a ratio, never a raw internal identifier (AC1)', async () => {
    mockGetSetting.mockResolvedValue(null);
    freezeDate('2026-08-18T12:00:00.000Z');

    const info = await buildUsageBlockInfo({
      currentTierName: 'Basic',
      blockedByCost: false,
      used: 1000000,
      allowance: 1000000,
    });

    expect(info.exhausted).toBe('tokens');
    expect(info.usedLabel).not.toMatch(/1000000|1,000,000/);
    expect(info.usedLabel).toMatch(/100%/);
  });

  it('states a concrete reset date for the standard monthly cap (AC2)', async () => {
    mockGetSetting.mockResolvedValue(null);
    freezeDate('2026-08-18T12:00:00.000Z');

    const info = await buildUsageBlockInfo({
      currentTierName: 'Basic',
      blockedByCost: false,
      used: 100,
      allowance: 100,
    });

    expect(info.resetsAutomatically).toBe(true);
    expect(info.resetsAt).toBe(new Date(Date.UTC(2026, 8, 1)).toISOString());
  });

  it('carries an account-scoped upgrade action that resolves when a higher tier exists (AC3, AC6 input)', async () => {
    mockGetSetting.mockResolvedValue({
      settingValue: JSON.stringify([
        { name: 'Basic', monthlyCostAllowance: 50 },
        { name: 'Pro', monthlyCostAllowance: 200 },
      ]),
    });
    freezeDate('2026-08-18T12:00:00.000Z');

    const info = await buildUsageBlockInfo({
      currentTierName: 'Basic',
      blockedByCost: true,
      costUsed: 50,
      costAllowance: 50,
      userId: 'user-abc',
    });

    expect(info.hasNextTier).toBe(true);
    expect(info.upgradeUrl).toContain('/settings');
    expect(info.upgradeUrl).toContain('user-abc');
  });

  it('gives honest guidance instead of a broken upsell when no higher tier exists (AC4)', async () => {
    mockGetSetting.mockResolvedValue({
      settingValue: JSON.stringify([
        { name: 'Basic', monthlyCostAllowance: 50 },
        { name: 'Enterprise', monthlyCostAllowance: 50 },
      ]),
    });
    freezeDate('2026-08-18T12:00:00.000Z');

    const info = await buildUsageBlockInfo({
      currentTierName: 'Enterprise',
      blockedByCost: true,
      costUsed: 50,
      costAllowance: 50,
      userId: 'user-abc',
    });

    expect(info.hasNextTier).toBe(false);
    expect(info.upgradeUrl).toBeNull();
    expect(info.supportUrl).toBeTruthy();
  });

  it('treats an unlimited allowance on another tier as strictly higher (AC4 boundary)', async () => {
    mockGetSetting.mockResolvedValue({
      settingValue: JSON.stringify([
        { name: 'Basic', monthlyCostAllowance: 50 },
        { name: 'Enterprise', monthlyCostAllowance: null },
      ]),
    });
    freezeDate('2026-08-18T12:00:00.000Z');

    const info = await buildUsageBlockInfo({
      currentTierName: 'Basic',
      blockedByCost: true,
      costUsed: 50,
      costAllowance: 50,
      userId: 'user-abc',
    });

    expect(info.hasNextTier).toBe(true);
  });

  it('falls back to token comparison when the block is a token cap, not cost (AC4 dimension match)', async () => {
    mockGetSetting.mockResolvedValue({
      settingValue: JSON.stringify([
        { name: 'Basic', monthlyTokenAllowance: 100000 },
        { name: 'Pro', monthlyTokenAllowance: 500000 },
      ]),
    });
    freezeDate('2026-08-18T12:00:00.000Z');

    const info = await buildUsageBlockInfo({
      currentTierName: 'Basic',
      blockedByCost: false,
      used: 100000,
      allowance: 100000,
      userId: 'user-abc',
    });

    expect(info.hasNextTier).toBe(true);
  });

  it('is tolerant of a malformed subscription_types setting (fails loud to no-next-tier, not a crash)', async () => {
    mockGetSetting.mockResolvedValue({ settingValue: 'not json' });
    freezeDate('2026-08-18T12:00:00.000Z');

    const info = await buildUsageBlockInfo({
      currentTierName: 'Basic',
      blockedByCost: true,
      costUsed: 50,
      costAllowance: 50,
      userId: 'user-abc',
    });

    expect(info.hasNextTier).toBe(false);
    expect(info.upgradeUrl).toBeNull();
  });

  describe('buildUsageBlockInfoForUser', () => {
    it('derives cost-vs-token attribution and the caller tier so 429 call sites stay one-liners', async () => {
      mockGetSetting.mockResolvedValue(null);
      mockGetUserSubscriptionType.mockResolvedValue('Basic');
      freezeDate('2026-08-18T12:00:00.000Z');

      const info = await buildUsageBlockInfoForUser('user-abc', {
        costAllowance: 50,
        costPercentUsed: 100,
        costUsed: 50,
        costEnforced: true,
      });

      expect(mockGetUserSubscriptionType).toHaveBeenCalledWith('user-abc');
      expect(info.exhausted).toBe('cost');
      expect(info.usedLabel).toContain('$50.00');
    });
  });
});
