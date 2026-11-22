/**
 * ENG-55: data-collection policy for "Compare models" OpenRouter calls.
 *
 * Compare sends the user's prompt plus recent chat history to several vendors. When the AW-Settings row
 * `model_compare_deny_data_collection` is exactly the string 'true' (no trim, no case folding), Compare calls add
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

function errorText(error: unknown): string {
  const e = error as any;
  return [error instanceof Error ? error.message : String(error), e?.originalMessage, e?.originalError?.message]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
}

/**
 * Conservative: true ONLY when the policy was applied, the model is a known registry id, and the failure is the
 * GENERIC "no endpoints" 404. Compare always sends `require_parameters: true`, so OpenRouter's "No endpoints found
 * that can handle the requested parameters" and an unknown/retired-model "No endpoints found for <slug>" use the
 * same prefix but are NOT privacy problems; both are excluded. We have no documented wording for the data-policy
 * 404 (no OpenRouter docs sentence to cite), so no data-policy keyword is used as evidence.
 */
export function isProviderPolicyUnavailableError(
  error: unknown,
  policy: CompareProviderPolicy | null | undefined,
  modelKnown: boolean,
): boolean {
  if (!policy || !modelKnown || !isProviderNoEndpointsError(error)) return false;
  const text = errorText(error);
  if (text.includes('parameter')) return false;
  if (/no (?:allowed )?endpoints? (?:found|available) for\b/.test(text)) return false;
  return true;
}

export interface CompareProviderPolicyDeps {
  getSetting(name: string): Promise<{ settingValue?: unknown } | null>;
  now(): number;
  log(message: string, fields?: Record<string, unknown>): void;
}

export function createCompareProviderPolicy(deps: CompareProviderPolicyDeps) {
  let known = false; // last successfully read value; cold start => off
  let validUntil = 0;
  let inFlight: Promise<void> | null = null; // one refresh at a time, shared by parallel columns

  async function refresh(now: number): Promise<void> {
    try {
      const row = await deps.getSetting(COMPARE_DENY_DATA_COLLECTION_SETTING);
      known = row?.settingValue === 'true';
      validUntil = now + CACHE_TTL_MS;
    } catch (error) {
      deps.log('ModelCompare: failed to read data-collection switch; keeping last-known value (off if none)', {
        errorClass: (error as Error)?.name ?? 'Error',
        known,
      });
      validUntil = now + ERROR_RETRY_MS;
    }
  }

  async function getPolicy(): Promise<CompareProviderPolicy | null> {
    const now = deps.now();
    if (now >= validUntil) {
      inFlight ??= refresh(now).finally(() => { inFlight = null; });
      await inFlight;
    }
    return known ? DENY_DATA_COLLECTION_POLICY : null;
  }

  return { getPolicy };
}
