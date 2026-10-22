import { SUBSCRIPTION_FEATURES, getSubscriptionTypeConfig, getUserSubscriptionResolution } from '../subscriptionService';

export const HOT_LEAD_CALL_NOT_ENTITLED_MESSAGE =
  'Hot lead calls are not included in your organization’s current plan, so this cannot be set up or turned on. Contact support to add them.';

let override: boolean | null = null;

/** Tests only. Pass null to restore the real plan check. */
export function setHotLeadCallEntitledOverride(entitled: boolean | null): void {
  override = entitled;
}

/**
 * Whether the org's plan includes hot-lead calls, the feature that makes AgentWeb pay Twilio. It is
 * the `hot_lead_call` product feature of the subscription tier of the org's billing owner (the
 * subscription editor in the admin area ticks it per tier), so members and admins follow the owner's plan.
 *
 * Unlike the other features, a tier row that predates feature entitlements (no saved allowedFeatures
 * list) is NOT entitled: this one spends money per call, so it needs an explicit tick or "*". Anything
 * that cannot be resolved (no owner, unreadable tier, lookup error) is not entitled.
 */
export async function isHotLeadCallEntitled(org: { ownerUserId?: string }): Promise<boolean> {
  if (override !== null) return override;
  if (!org.ownerUserId) return false;
  try {
    const { subscriptionType, resolved } = await getUserSubscriptionResolution(org.ownerUserId);
    if (!resolved) return false;
    const features = (await getSubscriptionTypeConfig(subscriptionType))?.allowedFeatures;
    return Array.isArray(features) && (features.includes('*') || features.includes(SUBSCRIPTION_FEATURES.HOT_LEAD_CALL));
  } catch (err) {
    console.warn('[hotLeadCall] entitlement lookup failed; treating the org as not entitled', err instanceof Error ? err.name : 'error');
    return false;
  }
}

/** Throws the plain refusal shown to the user when the org's plan does not include hot-lead calls. */
export async function assertHotLeadCallEntitled(org: { ownerUserId?: string }): Promise<void> {
  if (!await isHotLeadCallEntitled(org)) throw new Error(HOT_LEAD_CALL_NOT_ENTITLED_MESSAGE);
}
