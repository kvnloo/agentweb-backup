/**
 * The paywall in front of "make it live" writes decides from the raw arguments, while the X write
 * validator coerces `action` with String(): an array action ["ACTIVATE"] used to skip the paywall and
 * still run as an ACTIVATE. The paywall now coerces the same way. Mock-only.
 */
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));

import { handleMetaToolkitCall, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { ZomaNotReadyError } from '../mcp/zomaErrors';
import { isZomaPublishWrite } from '../mcp/zomaBilling';

const NOW = Date.parse('2026-11-20T00:00:00Z');
const prev = process.env.ZOMA_X_ADS_ENABLED;
afterEach(() => {
  if (prev === undefined) delete process.env.ZOMA_X_ADS_ENABLED;
  else process.env.ZOMA_X_ADS_ENABLED = prev;
  jest.clearAllMocks();
});

const deps = (assertPublishAllowed: jest.Mock): MetaToolkitGatewayDeps => ({
  validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1' }),
  validateOAuthToken: jest.fn().mockResolvedValue(null),
  listAccounts: jest.fn().mockResolvedValue([]),
  execute: jest.fn() as any,
  recordUsage: jest.fn().mockResolvedValue(true) as any,
  recordWrite: jest.fn().mockResolvedValue(true) as any,
  now: () => NOW,
  rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) } as any,
  assertPublishAllowed,
});

describe('X Ads paywall: the action is coerced the way the validator coerces it', () => {
  it('isZomaPublishWrite sees an ACTIVATE however the action is spelled as a value', () => {
    expect(isZomaPublishWrite('x_ads', { action: 'ACTIVATE' })).toBe(true);
    expect(isZomaPublishWrite('x_ads', { action: ['ACTIVATE'] })).toBe(true);
    expect(isZomaPublishWrite('x_ads', { action: 'PAUSE' })).toBe(false);
    expect(isZomaPublishWrite('x_ads', { action: ['PAUSE'] })).toBe(false);
    expect(isZomaPublishWrite('x_ads', {})).toBe(false);
  });

  it('an array action does not bypass assertZomaPublishAllowed: the paywall refuses before X is reached', async () => {
    process.env.ZOMA_X_ADS_ENABLED = 'true';
    const paywall = jest.fn().mockRejectedValue(new ZomaNotReadyError('Start your Zoma plan to go live.'));
    const d = deps(paywall);
    for (const action of ['ACTIVATE', ['ACTIVATE']]) {
      await expect(
        handleMetaToolkitCall({ authorization: 'Bearer aw_good', toolName: 'x_ads_write', args: { entity_type: 'CAMPAIGN', action, campaign_id: 'c1' } }, d),
      ).rejects.toThrow(MetaToolkitRefusal);
    }
    expect(paywall).toHaveBeenCalledTimes(2);
    expect(paywall).toHaveBeenCalledWith('u1', { platform: 'x_ads', toolName: 'x_ads_write' });
    expect(d.listAccounts).not.toHaveBeenCalled();
    expect(d.recordWrite).not.toHaveBeenCalled();
  });
});
