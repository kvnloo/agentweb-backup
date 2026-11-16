import { SUBSCRIPTION_FEATURES, getSubscriptionTypeConfig, getUserSubscriptionResolution } from '../subscriptionService';

export const HOT_LEAD_CALL_NOT_ENTITLED_MESSAGE =
  'Hot lead calls are not included in your organization’s current plan, so this cannot be set up or turned on. Contact support to add them.';

export const HOT_LEAD_CALL_SUBSCRIBE_MESSAGE =
  'Hot lead calls need the hot lead calls add-on ($70 per month, includes one calling number and 150 lead calls per month, billed to your subscription). Ask Emma in Agent Mode to turn on hot lead calls: she shows the price and you approve it.';

/**
 * Kill switch for the paid add-on (ENG-2783). Billing is required ONLY when HOT_LEAD_CALL_BILLING_REQUIRED is
 * exactly 'true'; unset or any other value means the add-on is not checked, so deploying the billing code changes
 * nothing for existing orgs until an operator sets it. Read on every call so it can be flipped without a code change.
 */
export function isHotLeadCallBillingRequired(): boolean {
  return process.env.HOT_LEAD_CALL_BILLING_REQUIRED === 'true';
}

/** Minimum of an org needed here; `hotLeadCallBilling` may be absent because the caller read a projection or only has the id. */
export interface HotLeadCallEntitlementOrg {
  ownerUserId?: string;
  orgId?: string;
  hotLeadCallBilling?: { status: string };
}

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
export async function isHotLeadCallPlanEntitled(org: { ownerUserId?: string }): Promise<boolean> {
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

/**
 * Whether the org's paid add-on lets it call: true when billing is not required (the default), otherwise only when
 * the mirrored add-on status is 'active'. When the caller holds only an org id the stored mirror is read; anything
 * unreadable is not active. The test override covers the plan check only, so tests can exercise this one.
 */
export async function isHotLeadCallBillingActive(org: HotLeadCallEntitlementOrg): Promise<boolean> {
  if (!isHotLeadCallBillingRequired()) return true;
  let billing = org.hotLeadCallBilling;
  if (billing === undefined && org.orgId) {
    try {
      const { orgDb } = await import('../db');
      billing = (await orgDb.getOrgById(org.orgId, ['orgId', 'hotLeadCallBilling'], true))?.hotLeadCallBilling;
    } catch (err) {
      console.warn('[hotLeadCall] billing lookup failed; treating the add-on as not active', err instanceof Error ? err.name : 'error');
      return false;
    }
  }
  return billing?.status === 'active';
}

/**
 * Whether calls may be placed: the owner's plan lists hot_lead_call AND the add-on is active (when billing is
 * required). This is what dispatch, retries, callbacks and the read-out use. Turning calling on and the setup
 * steps before it use the plan check alone, because the add-on is bought at the "turn calling on" approval.
 */
export async function isHotLeadCallEntitled(org: HotLeadCallEntitlementOrg): Promise<boolean> {
  return (await isHotLeadCallPlanEntitled(org)) && (await isHotLeadCallBillingActive(org));
}

/** Throws the plain refusal shown to the user when the org's plan does not include hot-lead calls (setup steps; billing is checked when calling is turned on). */
export async function assertHotLeadCallEntitled(org: { ownerUserId?: string }): Promise<void> {
  if (!await isHotLeadCallPlanEntitled(org)) throw new Error(HOT_LEAD_CALL_NOT_ENTITLED_MESSAGE);
}
