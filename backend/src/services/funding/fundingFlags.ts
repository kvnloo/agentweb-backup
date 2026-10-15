/**
 * ENG-1816 F1 — funding feature flags, read from AW-Settings, not EB environment
 * variables.
 *
 * Prod EB (`Agentweb-backend-env-prod-3`) is already at CloudFormation's 4096-char
 * `EnvironmentVariables` template-parameter limit (ENG-2071): no environment variable
 * can currently be added or changed there. An env-var-based flag for this initiative
 * cannot ship. A settings row is also independently better — flipping a per-customer
 * allowlist becomes a `PutItem`, not an environment rolling restart.
 *
 * Mirrors `subscriptionService.getSubscriptionTypeConfig`'s shape: one settings row,
 * JSON-parsed, with a hardcoded all-off fallback when the row is absent, unreadable,
 * or malformed.
 */
import { settingsService } from "../settingsService";

export const FUNDING_FLAGS_SETTING_NAME = "eng1816_funding_flags";

export interface FundingFlags {
  byok: { enabled: boolean; allowUserIds: string[] };
  claudeSubscription: { enabled: boolean; allowUserIds: string[] };
  /** Forces every run to resolve to agentweb-or-stop, regardless of the flags above. */
  killSwitch: boolean;
}

const ALL_OFF: Readonly<FundingFlags> = Object.freeze({
  byok: Object.freeze({ enabled: false, allowUserIds: [] as string[] }),
  claudeSubscription: Object.freeze({ enabled: false, allowUserIds: [] as string[] }),
  killSwitch: false,
});

/**
 * Same cache shape as `deferredBillingMetering`'s billing-subject cache: short-lived,
 * so a burst of runs in the same minute reads AW-Settings once, not once per run.
 */
const CACHE_TTL_MS = 60_000;
let cachedFlags: FundingFlags | null = null;
let cachedAt = 0;

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Validates the parsed JSON shape field by field rather than trusting a cast, so a
 * partially-written or hand-edited settings row degrades to all-off instead of
 * throwing deep inside a run or silently granting an unintended allowlist.
 */
function parseFundingFlags(raw: unknown): FundingFlags | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;

  const byok = candidate.byok as Record<string, unknown> | undefined;
  const claudeSubscription = candidate.claudeSubscription as Record<string, unknown> | undefined;

  if (
    !byok ||
    typeof byok.enabled !== "boolean" ||
    !isNonEmptyStringArray(byok.allowUserIds) ||
    !claudeSubscription ||
    typeof claudeSubscription.enabled !== "boolean" ||
    !isNonEmptyStringArray(claudeSubscription.allowUserIds) ||
    typeof candidate.killSwitch !== "boolean"
  ) {
    return null;
  }

  return {
    byok: { enabled: byok.enabled, allowUserIds: [...byok.allowUserIds] },
    claudeSubscription: {
      enabled: claudeSubscription.enabled,
      allowUserIds: [...claudeSubscription.allowUserIds],
    },
    killSwitch: candidate.killSwitch,
  };
}

/**
 * Reads the funding flags, cached for CACHE_TTL_MS. Never throws: a missing row, a
 * DynamoDB read failure, or malformed JSON all resolve to ALL_OFF, matching F1's "no
 * behavior change" requirement — nothing can route off `agentweb` until a real
 * connection kind exists to route to (A1+).
 */
export async function getFundingFlags(): Promise<FundingFlags> {
  const now = Date.now();
  if (cachedFlags && now - cachedAt < CACHE_TTL_MS) {
    return cachedFlags;
  }

  let resolved: FundingFlags = ALL_OFF;
  try {
    const setting = await settingsService.getSetting(FUNDING_FLAGS_SETTING_NAME);
    if (setting) {
      const parsed = parseFundingFlags(JSON.parse(setting.settingValue));
      if (parsed) resolved = parsed;
      else console.error(`[fundingFlags] ${FUNDING_FLAGS_SETTING_NAME} is present but malformed; falling back to all-off`);
    }
  } catch (error) {
    console.error(`[fundingFlags] failed to read ${FUNDING_FLAGS_SETTING_NAME}; falling back to all-off:`, error);
  }

  cachedFlags = resolved;
  cachedAt = now;
  return resolved;
}

/** Test hook: force the next getFundingFlags() call to re-read instead of using the cache. */
/** In an allowlist, lets every user through. */
export const FUNDING_ALLOW_ALL = "*";

/**
 * Whether customer API keys (BYOK) are switched on for this user. Off when the
 * feature is disabled, when the kill switch is on, or when the user is not listed.
 */
export async function isByokEnabledFor(userId: string): Promise<boolean> {
  const flags = await getFundingFlags();
  if (flags.killSwitch || !flags.byok.enabled) return false;
  return flags.byok.allowUserIds.includes(FUNDING_ALLOW_ALL) || flags.byok.allowUserIds.includes(userId);
}

/**
 * Whether `userId` may connect and use a Claude subscription. Unlike BYOK, the `*`
 * wildcard is NOT honoured: until the shared worker machine exists (B5), logins are
 * handled on the main backend, so only users named one by one can be enabled.
 */
export async function isClaudeSubscriptionEnabledFor(userId: string): Promise<boolean> {
  const flags = await getFundingFlags();
  if (flags.killSwitch || !flags.claudeSubscription.enabled) return false;
  return userId !== FUNDING_ALLOW_ALL && flags.claudeSubscription.allowUserIds.includes(userId);
}

export function __resetFundingFlagsCacheForTests(): void {
  cachedFlags = null;
  cachedAt = 0;
}
