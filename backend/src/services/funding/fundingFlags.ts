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
/** After a failed read, the (stale or all-off) answer is reused for this long before trying again. */
const FAILED_READ_RETRY_MS = 5_000;
let lastGoodFlags: FundingFlags | null = null;
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
 * Reads the funding flags, cached for CACHE_TTL_MS. Never throws. A missing row is
 * all-off (nothing can route off `agentweb` until someone turns it on). A failed or
 * malformed read keeps the last value that was read successfully, so a DynamoDB blip
 * cannot flip a customer who is already on their own key to AgentWeb funding; only a
 * process that has never read the flags falls back to all-off.
 */
export async function getFundingFlags(): Promise<FundingFlags> {
  const now = Date.now();
  if (cachedFlags && now - cachedAt < CACHE_TTL_MS) {
    return cachedFlags;
  }

  let resolved: FundingFlags = ALL_OFF;
  let readFailed = false;
  try {
    const setting = await settingsService.getSetting(FUNDING_FLAGS_SETTING_NAME);
    if (setting) {
      const parsed = parseFundingFlags(JSON.parse(setting.settingValue));
      if (parsed) resolved = parsed;
      else {
        readFailed = true;
        console.error(`[fundingFlags] ${FUNDING_FLAGS_SETTING_NAME} is present but malformed`);
      }
    }
  } catch (error) {
    readFailed = true;
    console.error(`[fundingFlags] failed to read ${FUNDING_FLAGS_SETTING_NAME}:`, error);
  }

  if (readFailed) {
    // A failed read must not flip a customer who is already on their own key to AgentWeb
    // funding for a whole cache window: keep the last value that was read successfully,
    // and retry soon. Only a process that has never read the flags falls back to all-off.
    resolved = lastGoodFlags ?? ALL_OFF;
    cachedFlags = resolved;
    cachedAt = now - CACHE_TTL_MS + FAILED_READ_RETRY_MS;
    return resolved;
  }

  lastGoodFlags = resolved;
  cachedFlags = resolved;
  cachedAt = now;
  return resolved;
}

/**
 * Reads the flags straight from AW-Settings: never cached, never the last good value.
 * Throws when the read fails or the row is malformed, so a caller that must not act on
 * a stale answer (a write on a subscription connection) can refuse instead. An absent
 * row is a definite "all off".
 */
export async function readFundingFlagsFresh(): Promise<FundingFlags> {
  const setting = await settingsService.getSettingConsistent(FUNDING_FLAGS_SETTING_NAME);
  if (!setting) return ALL_OFF;
  const parsed = parseFundingFlags(JSON.parse(setting.settingValue));
  if (!parsed) throw new Error(`${FUNDING_FLAGS_SETTING_NAME} is malformed`);
  return parsed;
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

/** `isClaudeSubscriptionEnabledFor` on a fresh read; throws when the flags cannot be read. */
export async function isClaudeSubscriptionEnabledForFresh(userId: string): Promise<boolean> {
  const flags = await readFundingFlagsFresh();
  if (flags.killSwitch || !flags.claudeSubscription.enabled) return false;
  return userId !== FUNDING_ALLOW_ALL && flags.claudeSubscription.allowUserIds.includes(userId);
}

export function __resetFundingFlagsCacheForTests(): void {
  cachedFlags = null;
  cachedAt = 0;
  lastGoodFlags = null;
}
