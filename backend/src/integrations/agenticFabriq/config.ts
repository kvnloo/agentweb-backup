/**
 * Config + the spike's double gate (env flag AND per-user allowlist).
 *
 * ENG-1685 AC5: "No production traffic routes through Fabriq until Harsha
 * reviews the spike results and explicitly approves rollout beyond the flag."
 * A single env var is one accidental deploy-config change away from being
 * flipped for everyone, so the spike is gated on TWO independent conditions —
 * both default OFF/EMPTY — rather than one:
 *
 *   AGENTIC_FABRIQ_GMAIL_SPIKE_ENABLED=true      (master switch, default false)
 *   AGENTIC_FABRIQ_SPIKE_USER_IDS=<uid1,uid2>    (explicit allowlist, default empty)
 *
 * Even if the master switch is somehow true in production, an empty (or
 * missing) allowlist means the branch never fires for anyone. This mirrors
 * the house convention for a built-but-gated agent-loop change (see
 * AGENT_TOOL_GATEWAY_ENFORCE in loop-agentmode-restructure.md) rather than
 * inventing a new flag mechanism for a one-connector spike.
 */

import { httpsOrigin } from './transport';
import { getSecret, secretExists } from '../../utils/secretsManager';

let cachedCreds: { appId: string; appSecret: string } | null = null;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

export function isAgenticFabriqSpikeEnabled(): boolean {
  return env('AGENTIC_FABRIQ_GMAIL_SPIKE_ENABLED') === 'true';
}

/** Parses the comma-separated allowlist. Never throws on a malformed value — treats it as empty. */
export function getAgenticFabriqSpikeAllowlist(): Set<string> {
  const raw = env('AGENTIC_FABRIQ_SPIKE_USER_IDS');
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * The single predicate toolDispatch.ts's flagged branch checks. Both conditions
 * must hold — this is intentionally NOT short-circuit-simplifiable to just the
 * master flag, so a future refactor can't accidentally drop the allowlist half.
 */
export function isUserEligibleForAgenticFabriqSpike(userId: string | undefined): boolean {
  if (!userId) return false;
  if (!isAgenticFabriqSpikeEnabled()) return false;
  return getAgenticFabriqSpikeAllowlist().has(userId);
}

export function getAgenticFabriqApiBaseUrl(): string {
  const base = env('AGENTIC_FABRIQ_API_BASE_URL');
  if (!base) {
    throw new Error(
      'AGENTIC_FABRIQ_API_BASE_URL is not set. This must be the exact API host from the ' +
      'Agentic Fabriq dashboard (app-scoped REST + /mcp/external base) — never guessed or hardcoded.',
    );
  }
  return httpsOrigin(base);
}

/**
 * Resolves AF_APP_ID / AF_APP_SECRET: env first (local dev), else AWS Secrets
 * Manager at `{env}/AgentWeb/AgenticFabriq` (house convention — see .env.example's
 * OpenRouter fallback note), matching how every other shared-app-credential
 * service in this codebase resolves. Cached per process; never logged.
 */
export async function getAgenticFabriqAppCredentials(): Promise<{ appId: string; appSecret: string }> {
  if (cachedCreds) return cachedCreds;

  const envAppId = env('AF_APP_ID');
  const envAppSecret = env('AF_APP_SECRET');
  if (envAppId && envAppSecret) {
    cachedCreds = { appId: envAppId, appSecret: envAppSecret };
    return cachedCreds;
  }

  const secretName = env('AF_SECRETS_NAME') ||
    `${process.env.NODE_ENV === 'production' ? 'prod' : 'dev'}/AgentWeb/AgenticFabriq`;

  if (!(await secretExists(secretName))) {
    throw new Error(
      `Agentic Fabriq app credentials are not configured: no AF_APP_ID/AF_APP_SECRET env vars ` +
      `and no Secrets Manager entry at "${secretName}". Register the app at ` +
      `dashboard.agenticfabriq.com and set these before enabling the spike flag.`,
    );
  }

  const raw = await getSecret(secretName);
  const parsed = JSON.parse(raw) as { AF_APP_ID?: string; AF_APP_SECRET?: string };
  if (!parsed.AF_APP_ID || !parsed.AF_APP_SECRET) {
    throw new Error(`Secrets Manager entry "${secretName}" is missing AF_APP_ID or AF_APP_SECRET.`);
  }
  cachedCreds = { appId: parsed.AF_APP_ID, appSecret: parsed.AF_APP_SECRET };
  return cachedCreds;
}

/** Optional — only present if the Ed25519 signed-assertion path has been enabled. */
export async function getAgenticFabriqPrivateKeyPem(): Promise<string | undefined> {
  return env('AF_PRIVATE_KEY');
}

/** Optional — only present if webhook signature verification is wired up for this deployment. */
export function getAgenticFabriqWebhookSigningSecret(): string | undefined {
  return env('AF_WEBHOOK_SIGNING_SECRET');
}

/** Test-only: clears the process-level credential cache. */
export function __resetAgenticFabriqConfigCacheForTests(): void {
  cachedCreds = null;
}
