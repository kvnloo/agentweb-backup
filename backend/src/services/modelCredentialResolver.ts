/**
 * ENG-2955 (slice of ENG-2851): pure model-credential resolver.
 *
 * Decides which credential *reference* (opaque ref id, never key material)
 * Yugo/Hue/Remy use while serving an org, and who is billed. No storage, no
 * secrets, no network. Persistence/encryption/billing policy stay with ENG-2851.
 */

export type ModelProvider = 'anthropic' | 'openai';

export const SUPPORTED_MODEL_PROVIDERS: readonly ModelProvider[] = ['anthropic', 'openai'];

export type OrgCredentialRefKind = 'api_key' | 'subscription_oauth';

export interface OrgCredentialRef {
  /** Opaque reference id. Never key material. */
  ref: string;
  orgId: string;
  provider: string;
  kind: OrgCredentialRefKind;
}

export type ModelCredentialResolution =
  | { source: 'customer'; ref: string; billTo: 'customer_direct'; orgId: string; provider: ModelProvider }
  | { source: 'platform'; ref: string; billTo: 'agentweb_metered'; orgId: string; provider: ModelProvider };

export type ModelCredentialErrorCode = 'UNKNOWN_PROVIDER' | 'SUBSCRIPTION_LOGIN_REJECTED' | 'INVALID_INPUT';

export class ModelCredentialError extends Error {
  constructor(
    public readonly code: ModelCredentialErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelCredentialError';
  }
}

export interface ResolveModelCredentialInput {
  orgId: string;
  provider: string;
  orgCredentialRefs: readonly OrgCredentialRef[];
  /** Platform default ref per provider. */
  platformDefault: Partial<Record<ModelProvider, string>>;
}

function isSupportedProvider(p: string): p is ModelProvider {
  return (SUPPORTED_MODEL_PROVIDERS as readonly string[]).includes(p);
}

export function resolveModelCredential(input: ResolveModelCredentialInput): ModelCredentialResolution {
  const { orgId, provider, orgCredentialRefs, platformDefault } = input;
  if (!orgId) throw new ModelCredentialError('INVALID_INPUT', 'orgId is required');
  if (!isSupportedProvider(provider)) {
    throw new ModelCredentialError('UNKNOWN_PROVIDER', `Unsupported model provider: ${provider}`);
  }

  // Cross-tenant guard: only this org's refs for this provider are ever considered.
  const candidates = orgCredentialRefs.filter((r) => r.orgId === orgId && r.provider === provider);

  if (candidates.some((r) => r.kind === 'subscription_oauth')) {
    throw new ModelCredentialError(
      'SUBSCRIPTION_LOGIN_REJECTED',
      `Subscription/OAuth logins cannot be used as model credentials (${provider})`,
    );
  }

  const byok = candidates.find((r) => r.kind === 'api_key' && r.ref);
  if (byok) {
    return { source: 'customer', ref: byok.ref, billTo: 'customer_direct', orgId, provider };
  }

  const ref = platformDefault[provider];
  if (!ref) throw new ModelCredentialError('INVALID_INPUT', `No platform default ref for ${provider}`);
  return { source: 'platform', ref, billTo: 'agentweb_metered', orgId, provider };
}
