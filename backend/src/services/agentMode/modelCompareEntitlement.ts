/**
 * "Compare models" plan-gated add-on (ENG-55 follow-up).
 *
 * Two independent controls:
 *  - AW-Settings `model_compare_requires_entitlement` ('true' enables enforcement). Absent or any
 *    other value means "not required": behaviour is exactly what shipped before this change.
 *  - the `model_compare` subscription feature id, ticked per tier in the admin Subscription Types editor.
 *
 * When enforcement is on a caller is entitled when they are an admin, or the effective (org-aware)
 * subscription of that user includes the feature. An unreadable tier denies (fail closed). The settings
 * read is cached for ~60s and a failed refresh keeps the last-known value, so a settings outage can
 * never flip behaviour. A failed read with NO last-known value (cold start during an outage) is treated
 * as REQUIRED (fail closed): the switch may really be 'true', and admins plus tiers that include the
 * feature still pass. A failure is never cached as a success; it is retried after ERROR_RETRY_MS. Only a
 * successful read of an absent/blank/non-'true' row means "not required".
 */
import type { SubscriptionFeatureId } from '../subscriptionService';
import { settingsService } from '../settingsService';

export const MODEL_COMPARE_REQUIRES_ENTITLEMENT_SETTING = 'model_compare_requires_entitlement';
export const MODEL_COMPARE_FEATURE_ID: SubscriptionFeatureId = 'model_compare';
export const MODEL_COMPARE_NOT_ENTITLED_CODE = 'model_compare_not_entitled';
export const MODEL_COMPARE_NOT_ENTITLED_MESSAGE = 'Compare models is not available on your current plan.';

const CACHE_TTL_MS = 60_000;
/** After a failed refresh, retry sooner than a full window but not on every request. */
const ERROR_RETRY_MS = 5_000;

export interface ModelCompareEntitlementDeps {
  getSetting(name: string): Promise<{ settingValue?: unknown } | null>;
  isFeatureEnabledForUser(userId: string, feature: SubscriptionFeatureId): Promise<boolean | null>;
  now(): number;
  log(message: string, fields?: Record<string, unknown>): void;
}

export interface ModelCompareEntitlement {
  isRequired(): Promise<boolean>;
  isEntitled(user: { userId: string; isAdmin?: boolean }): Promise<boolean>;
}

export function createModelCompareEntitlement(deps: ModelCompareEntitlementDeps): ModelCompareEntitlement {
  let known: boolean | null = null; // last successfully read value; null = never read
  let validUntil = 0;

  async function isRequired(): Promise<boolean> {
    const now = deps.now();
    if (now < validUntil) return known !== false;
    try {
      const row = await deps.getSetting(MODEL_COMPARE_REQUIRES_ENTITLEMENT_SETTING);
      known = String(row?.settingValue ?? '').trim().toLowerCase() === 'true';
      validUntil = now + CACHE_TTL_MS;
    } catch (error) {
      deps.log('ModelCompare: failed to read entitlement switch; keeping last-known value, or failing closed (required) if none', {
        errorClass: (error as Error)?.name ?? 'Error',
        known,
      });
      validUntil = now + ERROR_RETRY_MS;
    }
    return known !== false; // null (never read successfully) => fail closed
  }

  async function isEntitled(user: { userId: string; isAdmin?: boolean }): Promise<boolean> {
    if (!(await isRequired())) return true;
    if (user.isAdmin === true) return true;
    try {
      return (await deps.isFeatureEnabledForUser(user.userId, MODEL_COMPARE_FEATURE_ID)) === true;
    } catch (error) {
      deps.log('ModelCompare: tier lookup failed; denying', { errorClass: (error as Error)?.name ?? 'Error' });
      return false;
    }
  }

  return { isRequired, isEntitled };
}

/** Process-wide instance used by the controller and GET /api/auth/me (one cache, one answer). */
export const modelCompareEntitlement = createModelCompareEntitlement({
  getSetting: (name) => settingsService.getSetting(name),
  // Lazy: the subscription service pulls in the data layer; it is only needed when enforcement is on.
  isFeatureEnabledForUser: async (userId, feature) =>
    (await import('../subscriptionService')).isSubscriptionFeatureEnabled(userId, feature),
  now: () => Date.now(),
  log: (message, fields) => console.error(message, fields),
});
