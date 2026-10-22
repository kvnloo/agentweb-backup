const mockResolution = jest.fn();
const mockTier = jest.fn();
jest.mock('../../subscriptionService', () => ({
  SUBSCRIPTION_FEATURES: { HOT_LEAD_CALL: 'hot_lead_call' },
  getUserSubscriptionResolution: (...a: unknown[]) => mockResolution(...a),
  getSubscriptionTypeConfig: (...a: unknown[]) => mockTier(...a),
}));

import { assertHotLeadCallEntitled, isHotLeadCallEntitled, HOT_LEAD_CALL_NOT_ENTITLED_MESSAGE } from '../hotLeadCallEntitlement';

const ORG = { ownerUserId: 'org-owner' };

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockResolution.mockResolvedValue({ subscriptionType: 'Pro', resolved: true });
  mockTier.mockResolvedValue({ name: 'Pro', allowedFeatures: ['scheduled_chats', 'hot_lead_call'] });
});
afterEach(() => jest.restoreAllMocks());

describe('isHotLeadCallEntitled', () => {
  it('is true when the org owner’s tier lists the feature, and reads the OWNER’s plan', async () => {
    expect(await isHotLeadCallEntitled(ORG)).toBe(true);
    expect(mockResolution).toHaveBeenCalledWith('org-owner');
    expect(mockTier).toHaveBeenCalledWith('Pro');
  });

  it('is true for a tier with the wildcard', async () => {
    mockTier.mockResolvedValue({ name: 'Enterprise', allowedFeatures: ['*'] });
    expect(await isHotLeadCallEntitled(ORG)).toBe(true);
  });

  it('is false for a tier that lists other features only', async () => {
    mockTier.mockResolvedValue({ name: 'Free', allowedFeatures: ['scheduled_chats', 'model_compare'] });
    expect(await isHotLeadCallEntitled(ORG)).toBe(false);
  });

  it('is false for a legacy tier with no saved feature list, unlike the other features', async () => {
    mockTier.mockResolvedValue({ name: 'Free' });
    expect(await isHotLeadCallEntitled(ORG)).toBe(false);
  });

  it.each([
    ['no tier row', () => mockTier.mockResolvedValue(null)],
    ['an unresolved plan', () => mockResolution.mockResolvedValue({ subscriptionType: 'Free', resolved: false })],
    ['a failing plan lookup', () => mockResolution.mockRejectedValue(new Error('ddb down'))],
    ['a failing tier lookup', () => mockTier.mockRejectedValue(new Error('ddb down'))],
  ])('fails closed on %s', async (_name, arrange) => {
    arrange();
    expect(await isHotLeadCallEntitled(ORG)).toBe(false);
  });

  it('is false without an org owner and never looks anything up', async () => {
    expect(await isHotLeadCallEntitled({})).toBe(false);
    expect(mockResolution).not.toHaveBeenCalled();
  });
});

describe('assertHotLeadCallEntitled', () => {
  it('throws the plain refusal when not entitled and resolves when entitled', async () => {
    await expect(assertHotLeadCallEntitled(ORG)).resolves.toBeUndefined();
    mockTier.mockResolvedValue({ name: 'Free', allowedFeatures: [] });
    await expect(assertHotLeadCallEntitled(ORG)).rejects.toThrow(HOT_LEAD_CALL_NOT_ENTITLED_MESSAGE);
  });
});
