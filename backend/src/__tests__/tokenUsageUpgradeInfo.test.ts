import { describe, expect, it, beforeEach } from '@jest/globals';
import { getQuotaUpgradeInfo } from '../services/tokenUsageService';

describe('getQuotaUpgradeInfo', () => {
  beforeEach(() => {
    process.env.CUSTOMER_FRONTEND_URL = 'https://app.agentweb.pro';
  });

  it('recommends Starter with an account-scoped checkout path for Free', () => {
    const info = getQuotaUpgradeInfo('Free', { used: 100, effectiveAllowance: 100 });
    expect(info.nextTier).toBe('Starter');
    expect(info.upgradeUrl).toBe('https://app.agentweb.pro/pricing?upgrade=starter&source=mcp');
    expect(info.remainingAllowance).toBe(0);
  });

  it('recommends Pro for Starter and preserves the remaining allowance', () => {
    const info = getQuotaUpgradeInfo('Starter', { used: 80, effectiveAllowance: 100 });
    expect(info.nextTier).toBe('Pro');
    expect(info.upgradeUrl).toContain('/pricing?upgrade=pro&source=mcp');
    expect(info.remainingAllowance).toBe(20);
  });

  it('returns a support path instead of a fake next tier at the top', () => {
    const info = getQuotaUpgradeInfo('Enterprise', { used: 1, effectiveAllowance: 1 });
    expect(info.nextTier).toBeNull();
    expect(info.upgradeUrl).toMatch(/^mailto:/);
  });

  it('does not expose a numeric remainder for unlimited plans', () => {
    expect(getQuotaUpgradeInfo('Free', { used: 999, effectiveAllowance: null }).remainingAllowance).toBeNull();
  });
});
