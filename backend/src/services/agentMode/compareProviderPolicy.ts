/**
 * ENG-55: data-collection policy for "Compare models" OpenRouter calls.
 *
 * Compare sends the user's prompt plus recent chat history to several vendors. When the AW-Settings row
 * `model_compare_deny_data_collection` is exactly 'true' (trim, case-insensitive), Compare calls add
 * `provider.data_collection = 'deny'` (https://openrouter.ai/docs/features/provider-routing) on top of the
 * repo's normal provider preferences. Absent / any other value / a cold-start read failure => no policy,
 * i.e. exactly today's request. A successful read is cached ~60s; a failed refresh keeps the last-known value.
 * Normal chat never reads this switch: only the Compare call path passes the policy to callLLM.
 *
 * Pure module apart from the injected settings reader, so it is unit-testable without the service graph.
 */
import { isProviderNoEndpointsError } from '../../utils/agentModeErrors';

export const COMPARE_DENY_DATA_COLLECTION_SETTING = 'model_compare_deny_data_collection';
export const COMPARE_PROVIDER_POLICY_UNAVAILABLE_CODE = 'provider_policy_unavailable';
export const COMPARE_PROVIDER_POLICY_UNAVAILABLE_MESSAGE = 'No provider for this model accepts the privacy setting right now.';

export interface CompareProviderPolicy {
  data_collection: 'deny';
}

export const DENY_DATA_COLLECTION_POLICY: Readonly<CompareProviderPolicy> = Object.freeze({ data_collection: 'deny' });

const CACHE_TTL_MS = 60_000;
/** After a failed refresh, retry sooner than a full window but not on every request. */
const ERROR_RETRY_MS = 5_000;

/** Merge the policy into an OpenRouter `provider` object without dropping any existing key. */
export function applyProviderPolicy<T extends object>(
  provider: T,
  policy: CompareProviderPolicy | null | undefined,
): T & Partial<CompareProviderPolicy> {
  return policy ? { ...provider, ...policy } : { ...provider };
}

/** True only when the policy was applied AND OpenRouter reports no routable endpoint. */
export function isProviderPolicyUnavailableError(error: unknown, policy: CompareProviderPolicy | null | undefined): boolean {
  return !!policy && isProviderNoEndpointsError(error);
}

export interface CompareProviderPolicyDeps {
  getSetting(name: string): Promise<{ settingValue?: unknown } | null>;
  now(): number;
  log(message: string, fields?: Record<string, unknown>): void;
}

export function createCompareProviderPolicy(deps: CompareProviderPolicyDeps) {
  let known = false; // last successfully read value; cold start => off
  let validUntil = 0;

  async function getPolicy(): Promise<CompareProviderPolicy | null> {
    const now = deps.now();
    if (now >= validUntil) {
      try {
        const row = await deps.getSetting(COMPARE_DENY_DATA_COLLECTION_SETTING);
        known = String(row?.settingValue ?? '').trim().toLowerCase() === 'true';
        validUntil = now + CACHE_TTL_MS;
      } catch (error) {
        deps.log('ModelCompare: failed to read data-collection switch; keeping last-known value (off if none)', {
          errorClass: (error as Error)?.name ?? 'Error',
          known,
        });
        validUntil = now + ERROR_RETRY_MS;
      }
    }
    return known ? DENY_DATA_COLLECTION_POLICY : null;
  }

  return { getPolicy };
}
