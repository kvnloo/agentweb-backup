import { settingsService } from "./settingsService";
import { userDb, orgDb } from "./db";
import { CUSTOMER_PORTAL_PAGES } from "./customerPortalPages";
import { skillService } from "./skillService";
import { hasOwnLiveSubscription } from "./orgAuthz";
import type { LlmUsagePolicy } from "./llmUsagePolicyService";
import type { LlmUsageTopUpConfig } from './llmUsageTopUpService';

export interface SubscriptionType {
  name: string;
  allowedPages: string[]; // Array of page paths (e.g., ["/marketing/research", "/marketing/blog"]) or ["*"] for all
  hiddenPages?: string[]; // Array of page paths to hide entirely (not shown as locked); subset of pages not in allowedPages
  allowedSkills: string[]; // Array of skill IDs (e.g., ["skill-uuid-1", "skill-uuid-2"]) or ["*"] for all
  allowedConnectedAccounts?: string[]; // Array of platform types (e.g., ["linkedin", "gmail"]) or ["*"] for all; undefined = all
  allowedFeatures?: string[]; // Stable product feature IDs or ["*"]; undefined = legacy row (all current features)
  allowedFunctionCalls?: string[]; // Deprecated — kept for on-read migration from old configs
  /** ENG-1978, observation only, never persisted: true when the stored row carried NO
   *  `allowedSkills` and it was defaulted to ["*"] on read. Set by getSubscriptionTypeConfig so
   *  the skills path can record that silent full-registry grant without this function's ~18 other
   *  callers each emitting a duplicate for the same malformed row. */
  allowedSkillsDefaulted?: boolean;
  monthlyTokenAllowance?: number | null; // Monthly token limit; null/undefined = unlimited
  monthlyCostAllowance?: number | null; // Monthly LLM spend limit in USD (cost-based cap; guards higher-cost models); null/undefined = unlimited
  monthlyExtraCostAllowance?: number | null; // Monthly extra API cost limit in USD (enrichment, etc.); null/undefined = unlimited
  llmUsagePolicy?: LlmUsagePolicy; // Versioned admin-managed full-choice/optimized/paused policy
  llmUsageTopUp?: LlmUsageTopUpConfig; // Admin-priced packages that extend this month's hard ceiling
}

// Default pages that are always available regardless of subscription type
// These match the routes in customer-portal/src/App.tsx
export const DEFAULT_PAGES = [
  "/", // Agent Mode home
  "/agent-mode", // Agent Mode
  "/settings", // Settings page
  "/guide", // User Guide
];

// ─── Tier Fallback ──────────────────────────────────────────────────────
// The canonical tier definitions now live in DynamoDB (admin-managed via
// the "subscription_types" setting).  getSubscriptionTypeConfig() reads
// them.  The constant below is only used as a last-resort fallback when
// the DB config cannot be reached (e.g. during initial bootstrap).

const FREE_TIER_FALLBACK: SubscriptionType = {
  name: "Free",
  allowedPages: [...DEFAULT_PAGES],
  allowedSkills: [], // No premium skills on Free tier
};

export const SUBSCRIPTION_FEATURES = {
  SCHEDULED_CHATS: "scheduled_chats",
} as const;

/**
 * ENG-1978 — observation only, no behaviour change.
 *
 * Several paths through this file resolve to `["*"]`, which grants every registered tool: an
 * unknown tier name, a malformed `subscription_types` row, an empty allowedSkills list, and any
 * thrown error. Only the explicit `["*"]` in a tier config is deliberate.
 *
 * Whether those paths ever actually fire in production is unknown, because nothing has ever
 * recorded them — the error cases log a bare `console.error` with no user and no marker, and the
 * non-error cases log nothing at all. "We have never had a problem" is therefore not evidence:
 * a silent over-grant looks exactly like normal operation from the outside.
 *
 * This records them so the question can be answered with data before anyone changes the
 * behaviour. Deliberately NOT a fix — see the PR for the fail-closed change this is meant to
 * de-risk, and why shipping that blind was judged too risky.
 *
 * Sink is injectable so this can be routed at a real alerting surface without this module
 * reaching for one (same shape as usageWriteFailureMonitor's `setDroppedWriteAlertSink`). There
 * is no metrics facade in this codebase; a greppable marker prefix is the house convention.
 */
/**
 * Two DISTINCT kinds, deliberately not summable:
 *
 *  - `wildcard-grant`   every registered tool was just granted because something failed.
 *                       This is the number that answers "how risky is the current fail-open?"
 *  - `unconfirmed-tier` the tier could not be CONFIRMED for this user, but the grant that
 *                       followed may have been perfectly normal and restricted.
 *
 * Keeping them apart matters more than it looks. `unconfirmed-tier` is expected to be the
 * highest-volume reason, and it frequently accompanies a *restricted* result — an unreadable
 * user row still resolves to a real Free tier with a real skill list. Counting those as
 * over-grants would oversize the risk and argue for the fail-closed change on false evidence,
 * which is the opposite of what this instrumentation is for.
 */
// Round-2 review: grep both markers, not just WILDCARD-GRANT, and break down by `kind` — do not
// sum them. `[entitlement]` is the shared prefix precisely so one grep catches both.
export type EntitlementObservationKind = "wildcard-grant" | "unconfirmed-tier";

export interface EntitlementObservationEvent {
  kind: EntitlementObservationKind;
  reason: string;
  userId: string;
  detail: Record<string, unknown>;
}

export type WildcardGrantSink = (event: EntitlementObservationEvent) => void;

const DEFAULT_ENTITLEMENT_SINK: WildcardGrantSink = (event) => {
  // Both markers share the `[entitlement]` prefix on purpose — `grep '\[entitlement\]'` catches
  // both kinds; then break down by the `kind` field in each JSON line rather than summing them.
  const marker =
    event.kind === "wildcard-grant"
      ? "[entitlement] WILDCARD-GRANT granting all tools without a confirmed entitlement:"
      : "[entitlement] UNCONFIRMED-TIER entitlement resolved from an unconfirmed tier:";
  console.warn(marker, JSON.stringify(event));
};

let emitWildcardGrant: WildcardGrantSink = DEFAULT_ENTITLEMENT_SINK;

/** Route entitlement observations somewhere other than the console (tests, alerting). */
export function setWildcardGrantSink(sink: WildcardGrantSink): void {
  emitWildcardGrant = sink;
}

/** Restore the console sink. Tests must call this rather than installing a silent stub, or every
 *  test declared after theirs runs with observation disabled. */
export function resetWildcardGrantSink(): void {
  emitWildcardGrant = DEFAULT_ENTITLEMENT_SINK;
  unconfirmedTierWindow = null;
}

function emitEntitlementObservation(event: EntitlementObservationEvent): void {
  try {
    // `Promise.resolve(...)` on purpose: the sink is typed `=> void`, but TypeScript happily
    // accepts an `async` function there, and a rejected promise would escape this synchronous
    // catch entirely — surfacing as an unhandled rejection, which under Node's default in EB
    // terminates the process. Observation must never be the reason the SERVER fails, not just
    // the reason a check fails.
    void Promise.resolve(emitWildcardGrant(event)).catch(() => {});
  } catch {
    // A synchronous throw from the sink.
  }
}

/**
 * `unconfirmed-tier` windowed dedupe (round-2 review, finding #4).
 *
 * `settingsService.getSetting` is uncached, so a DynamoDB brownout wide enough to hit the users
 * table also hits it — every `getAllowedSkills` call then emits one line, and this runs on every
 * agent turn, `/me`, and every Emma turn with an active skill. Unthrottled, a sustained incident
 * fills the EB instance's capped journald (`SystemMaxUse=200M`, `.ebextensions/06-log-retention`)
 * in hours, evicting the logs `request-environment-info --info-type tail/bundle` reads — the
 * production debugging path documented in this repo's own CLAUDE.md. That file's own comment on
 * those caps: "the app fix removes the source; these bound the blast radius regardless" — i.e.
 * the house rule is fix the source, not lean on the caps.
 *
 * `wildcard-grant` stays per-event: it is low-volume by construction (a genuine full-registry
 * grant, not a routine unresolved lookup) and per-user attribution is load-bearing there — the
 * PR's whole point is knowing whether an over-grant hit one user or four hundred.
 */
const UNCONFIRMED_TIER_WINDOW_MS = 60_000;

interface UnconfirmedTierWindow {
  count: number;
  distinctUserIds: Set<string>;
  byReason: Record<string, number>;
  firstAt: string;
  lastAt: string;
  sampleUserId: string;
  startedAt: number;
}

let unconfirmedTierWindow: UnconfirmedTierWindow | null = null;

function emitUnconfirmedTierWindow(): void {
  const pending = unconfirmedTierWindow;
  unconfirmedTierWindow = null;
  if (!pending) return;
  emitEntitlementObservation({
    kind: "unconfirmed-tier",
    reason: "windowed-summary",
    userId: pending.sampleUserId,
    detail: {
      count: pending.count,
      distinctUserCount: pending.distinctUserIds.size,
      byReason: pending.byReason,
      firstAt: pending.firstAt,
      lastAt: pending.lastAt,
      windowMs: UNCONFIRMED_TIER_WINDOW_MS,
    },
  });
}

/**
 * Emit whatever the open window holds, if anything (mirrors
 * usageWriteFailureMonitor.flushDroppedWriteAlerts). Without this the LAST window of an incident
 * is never reported — `reportUnconfirmedTier` only flushes when a later call arrives after the
 * window expires, so when the failures stop, exactly when someone starts investigating, the
 * final batch sits unemitted. Call periodically (e.g. a low-frequency interval) or at shutdown;
 * not required for correctness within a sustained incident, only for its tail.
 */
export function flushUnconfirmedTierObservations(now: number = Date.now()): void {
  if (!unconfirmedTierWindow) return;
  if (now - unconfirmedTierWindow.startedAt >= UNCONFIRMED_TIER_WINDOW_MS) {
    emitUnconfirmedTierWindow();
  }
}

function reportUnconfirmedTier(
  reason: string,
  userId: string,
  detail: Record<string, unknown> = {},
  now: number = Date.now()
): void {
  if (unconfirmedTierWindow && now - unconfirmedTierWindow.startedAt >= UNCONFIRMED_TIER_WINDOW_MS) {
    emitUnconfirmedTierWindow();
  }
  if (!unconfirmedTierWindow) {
    unconfirmedTierWindow = {
      count: 0,
      distinctUserIds: new Set(),
      byReason: {},
      firstAt: new Date(now).toISOString(),
      lastAt: new Date(now).toISOString(),
      sampleUserId: userId,
      startedAt: now,
    };
  }
  unconfirmedTierWindow.count += 1;
  unconfirmedTierWindow.distinctUserIds.add(userId);
  unconfirmedTierWindow.byReason[reason] = (unconfirmedTierWindow.byReason[reason] || 0) + 1;
  unconfirmedTierWindow.lastAt = new Date(now).toISOString();
  // Not gated on `detail` — kept for parity with the per-event shape, unused by the summary.
  void detail;
}

/** Every registered tool was just granted because something could not be resolved. Per-event,
 *  not windowed — see the comment on UNCONFIRMED_TIER_WINDOW_MS for why the two kinds differ. */
function reportWildcardGrant(
  reason: string,
  userId: string,
  detail: Record<string, unknown> = {}
): void {
  emitEntitlementObservation({ kind: "wildcard-grant", reason, userId, detail });
}

export type SubscriptionFeatureId = typeof SUBSCRIPTION_FEATURES[keyof typeof SUBSCRIPTION_FEATURES];

const AVAILABLE_SUBSCRIPTION_FEATURES: ReadonlyArray<{
  id: SubscriptionFeatureId;
  label: string;
  description: string;
}> = [{
  id: SUBSCRIPTION_FEATURES.SCHEDULED_CHATS,
  label: "Scheduled chats",
  description: "Create, edit, test, resume, and execute recurring Agent Mode chats.",
}];

export function getAllAvailableSubscriptionFeatures() {
  return AVAILABLE_SUBSCRIPTION_FEATURES.map((feature) => ({ ...feature }));
}

/**
 * Get tier configuration by name — reads from DynamoDB first, falls back
 * to a minimal Free config if the DB is unreachable or the tier is not
 * defined.  Replaces the old hardcoded TIER_CONFIGS / getDefaultTierConfig.
 */
export async function getTierConfig(tierName: string): Promise<SubscriptionType | null> {
  const dbConfig = await getSubscriptionTypeConfig(tierName);
  if (dbConfig) return dbConfig;

  // Graceful fallback: only Free tier has a built-in fallback
  if (tierName === "Free") return { ...FREE_TIER_FALLBACK };

  return null;
}

/**
 * Get subscription type for a user (defaults to "Free" if not set)
 */
async function resolveUserSubscriptionType(userId: string): Promise<{
  subscriptionType: string;
  resolved: boolean;
}> {
  try {
    const user = await userDb.getUserById(userId);
    if (!user) {
      return { subscriptionType: "Free", resolved: false };
    }
    const ownSubscriptionType = user?.subscriptionType || "Free";
    // Org members inherit the org owner's tier dynamically — the org's effective
    // tier is whatever the owner currently holds (orgs carry no tier field).
    // Resolving at read time (instead of snapshotting the owner's tier onto the
    // member on invite-accept) keeps members in sync when the owner up/downgrades
    // and automatically revokes access the moment they leave the org (orgId/
    // orgRole are cleared on leave/remove). This is the ENG-288 root cause: the
    // /me endpoint already resolved a member's tier from the owner, but the
    // member-id call sites (agent mode, Emma) read the member's own record.
    // A member riding their own active/trialing Stripe subscription is not
    // riding the org's — accepting an invite touches no billing state (see
    // routes/org.ts accept-invite), so a member can independently pay for a
    // tier that differs from their owner's. Only resolve to the owner when
    // the member has no live subscription of their own; otherwise their own
    // tier governs (matches the "active"/"trialing" = entitling convention
    // already used throughout stripeService.ts).
    // ENG-1084: shared with `resolveBillingUserId` via `inheritsOrgBilling` so a
    // member's tier and their quota counter can never again answer "whose plan is
    // this?" differently — the local copy of this test is what drifted last time.
    const hasOwnActiveSubscription = hasOwnLiveSubscription(user);
    // Anchored on the org's billing root (Organization.ownerUserId), NOT on a role.
    // This used to read `user.orgRole === "member"` as a stand-in for "not the
    // owner", which silently breaks the moment a third role exists: an admin is
    // neither "member" nor the billing root, so they fell through to :103 and were
    // downgraded to their own (usually empty) subscription — Free tier, no error,
    // no log. Every org member except the billing root inherits, which is correct
    // for members, admins, and second owners alike.
    if (user?.orgId && !hasOwnActiveSubscription && orgDb?.getOrgById) {
      // Isolated from the outer catch: a transient failure resolving the org
      // (network blip, throttling) must fall back to the user's own already-
      // fetched tier, not the hard "Free" default — we have real user data in
      // hand at this point, discarding it on an unrelated lookup failure would
      // wrongly downgrade a paying member for the duration of the blip.
      try {
        const org = await orgDb.getOrgById(user.orgId);
        if (org?.ownerUserId && org.ownerUserId !== userId) {
          // Reads the owner's raw stored field directly, not resolved
          // recursively through this same function — the owner's
          // subscriptionType is the canonical source of truth for what the
          // org pays for (kept in sync by Stripe webhooks / admin panel
          // writes, not by this resolution logic), and an org owner can't
          // themselves be a member of another org (see routes/org.ts create),
          // so there is no owner-of-owner chain to walk. A stale owner field
          // (e.g. their own Stripe sub canceled but subscriptionType wasn't
          // updated) would propagate as-is — an accepted limitation of the
          // current data model, not something this function can detect.
          const owner = await userDb.getUserById(org.ownerUserId);
          if (!owner) {
            return { subscriptionType: ownSubscriptionType, resolved: false };
          }
          return { subscriptionType: owner.subscriptionType || "Free", resolved: true };
        }
      } catch (orgLookupError) {
        console.error("Error resolving org owner for subscription type:", orgLookupError);
        return { subscriptionType: ownSubscriptionType, resolved: false };
      }
    }
    return { subscriptionType: ownSubscriptionType, resolved: true };
  } catch (error) {
    console.error("Error getting user subscription type:", error);
    return { subscriptionType: "Free", resolved: false };
  }
}

export async function getUserSubscriptionType(userId: string): Promise<string> {
  return (await getUserSubscriptionResolution(userId)).subscriptionType;
}

/** Resolve the effective subscription and whether the lookup completed successfully. */
export async function getUserSubscriptionResolution(userId: string): Promise<{
  subscriptionType: string;
  resolved: boolean;
}> {
  return resolveUserSubscriptionType(userId);
}

/** Return product features for the user's effective, org-aware subscription. */
export async function getAllowedFeatures(userId: string): Promise<string[]> {
  const subscriptionTypeName = await getUserSubscriptionType(userId);
  const config = await getTierConfig(subscriptionTypeName);
  if (!config) return [];

  // Existing subscription rows predate feature entitlements. Preserve their
  // behavior until an admin explicitly saves this field.
  if (!Array.isArray(config.allowedFeatures) || config.allowedFeatures.includes("*")) {
    return AVAILABLE_SUBSCRIPTION_FEATURES.map((feature) => feature.id);
  }

  const knownFeatures = new Set(AVAILABLE_SUBSCRIPTION_FEATURES.map((feature) => feature.id));
  return config.allowedFeatures.filter((feature) => knownFeatures.has(feature as SubscriptionFeatureId));
}

export async function isSubscriptionFeatureEnabled(
  userId: string,
  feature: SubscriptionFeatureId
): Promise<boolean | null> {
  const subscriptionResolution = await resolveUserSubscriptionType(userId);
  if (!subscriptionResolution.resolved) return null;

  const config = await getSubscriptionTypeConfig(subscriptionResolution.subscriptionType);

  // Keep explicit denial distinct from an unavailable/malformed admin setting.
  // Interactive entry points still fail closed on null, while background jobs
  // can retry later without permanently pausing a permitted schedule.
  if (!config) return null;
  if (!Array.isArray(config.allowedFeatures) || config.allowedFeatures.includes("*")) {
    return true;
  }

  return config.allowedFeatures.includes(feature);
}

/**
 * Get subscription type configuration
 */
export async function getSubscriptionTypeConfig(
  subscriptionTypeName: string
): Promise<SubscriptionType | null> {
  try {
    const setting = await settingsService.getSetting("subscription_types");
    let subscriptionTypes: SubscriptionType[] = [];

    if (setting) {
      try {
        subscriptionTypes = JSON.parse(setting.settingValue);
      } catch (error) {
        console.error("Error parsing subscription types:", error);
        return null;
      }
    }

    // If no subscription types defined, return built-in fallbacks
    if (subscriptionTypes.length === 0) {
      if (subscriptionTypeName === "Free") {
        return { ...FREE_TIER_FALLBACK };
      }
      // Legacy: users stored as "Basic" before tier system was introduced get full access
      if (subscriptionTypeName === "Basic") {
        return {
          name: "Basic",
          allowedPages: getAllAvailablePages(),
          allowedSkills: ["*"],
          // ENG-1978 (observation only): this ["*"] is hardcoded here, not authored by an admin
          // in the subscription_types config — it only fires when that setting is entirely
          // absent, a degraded bootstrap state. Flagged the same as the missing-allowedSkills
          // case in the well-formed branch below, so getAllowedSkills can record it.
          allowedSkillsDefaulted: true,
        };
      }
      return null;
    }

    const subscriptionType = subscriptionTypes.find(
      (type: any) => type.name === subscriptionTypeName
    );

    if (!subscriptionType) {
      return null;
    }

    // Backward compatibility: if config has allowedFunctionCalls but no allowedSkills,
    // treat as all skills allowed (wildcard)
    const allowedSkills = subscriptionType.allowedSkills || ["*"];

    // ENG-1978 (observation only): flag the legacy shape rather than reporting it here.
    //
    // This function has ~18 callers across unrelated subsystems — token usage, LLM usage policy,
    // unit economics, Stripe, the evaluation store, plus allowedPages/Features/HiddenPages — so
    // emitting from this point would fire on every one of them for a single malformed row, which
    // is a firehose, not an observation. The report belongs to the skills path only, so the fact
    // is carried out and recorded by getAllowedSkills instead.
    const allowedSkillsDefaulted = !subscriptionType.allowedSkills;

    // Normalize paths: remove "/marketing" prefix from allowedPages
    return {
      ...subscriptionType,
      allowedSkills,
      allowedSkillsDefaulted,
      allowedPages: subscriptionType.allowedPages.map((page: string) => {
        if (page.startsWith('/marketing/')) {
          return page.replace('/marketing', '');
        }
        return page;
      })
    };
  } catch (error) {
    console.error("Error getting subscription type config:", error);
    return null;
  }
}


/**
 * ENG-173 publish guardrail: determine whether a skill is reachable by any user.
 *
 * A published skill is invisible to a non-wildcard user unless its skillId appears
 * in that user's subscription tier's `allowedSkills` — so a skill published without
 * being added to any tier's allow-list is entitled to nobody. This reads the same
 * `subscription_types` setting the runtime filter uses and reports which tiers (if any)
 * allow the skill. Fails OPEN (reachable=true) when no tier config exists, mirroring
 * getAllowedSkills' default-allow behavior so absent config never raises a false alarm.
 */
export async function findTiersAllowingSkill(
  skillId: string
): Promise<{ reachable: boolean; allowingTiers: string[]; totalTiers: number }> {
  try {
    const setting = await settingsService.getSetting("subscription_types");
    if (!setting) {
      return { reachable: true, allowingTiers: [], totalTiers: 0 };
    }

    let tiers: SubscriptionType[] = [];
    try {
      tiers = JSON.parse(setting.settingValue);
    } catch (error) {
      console.error("Error parsing subscription types:", error);
      return { reachable: true, allowingTiers: [], totalTiers: 0 };
    }

    if (tiers.length === 0) {
      return { reachable: true, allowingTiers: [], totalTiers: 0 };
    }

    const allowingTiers = tiers
      .filter((tier: any) => {
        // Backward compat: a tier without allowedSkills is treated as wildcard.
        const allowedSkills: string[] = tier.allowedSkills || ["*"];
        return allowedSkills.includes("*") || allowedSkills.includes(skillId);
      })
      .map((tier: any) => tier.name);

    return {
      reachable: allowingTiers.length > 0,
      allowingTiers,
      totalTiers: tiers.length,
    };
  } catch (error) {
    console.error("Error checking tiers for skill:", error);
    return { reachable: true, allowingTiers: [], totalTiers: 0 };
  }
}

/**
 * Get all available function calls from agent mode service
 */
export async function getAllAvailableFunctionCalls(): Promise<string[]> {
  try {
    const { agentModeService } = await import("./agentModeService");
    const tools = agentModeService.getAvailableTools();
    return tools
      .filter((tool: any) => tool?.type === "function" && tool?.function?.name)
      .map((tool: any) => tool.function?.name)
      .filter((name: string) => name); // Filter out undefined/null
  } catch (error) {
    console.error("Error getting all available function calls:", error);
    return [];
  }
}

/**
 * Get all available skills (published skill IDs + __other_skills__ virtual entry)
 * Used by admin UI to populate skill selection checkboxes
 */
export async function getAllAvailableSkills(): Promise<string[]> {
  try {
    const publishedSkills = await skillService.getPublishedSkills();
    const skillIds = publishedSkills.map((s) => s.skillId);
    return [...skillIds, "__other_skills__"];
  } catch (error) {
    console.error("Error getting all available skills:", error);
    return [];
  }
}

/**
 * Get allowed skill IDs for a user based on their subscription type.
 * Anonymous users (anon_*) use the public allowed skills config.
 * Returns the actual list of skill IDs or ["*"] for all.
 */
export async function getAllowedSkills(userId: string): Promise<string[]> {
  try {
    // Anonymous/public users use the public skills config
    if (userId.startsWith("anon_")) {
      return getPublicAllowedSkills();
    }

    // ENG-1978 (observation only): `resolved: false` means the tier could not be confirmed —
    // a missing user row, an unreadable org owner, or an org-lookup blip. Behaviour is unchanged;
    // we still use the tier name exactly as before. This only records that the grant below rests
    // on an unconfirmed tier.
    const { subscriptionType: subscriptionTypeName, resolved } =
      await getUserSubscriptionResolution(userId);
    if (!resolved) {
      // NOT a wildcard-grant: the assumed tier below is frequently a real, restricted one, so
      // this is recorded under its own kind and must not be summed with the over-grants.
      // Windowed (not per-event): expected to be the highest-volume reason, and unlike
      // wildcard-grant it is not itself a security-relevant over-grant, so a summary with a
      // count/distinct-user-count is a better 2-week signal than one line per occurrence.
      reportUnconfirmedTier("subscription-type-unresolved", userId, {
        assumedSubscriptionType: subscriptionTypeName,
      });
    }

    const subscriptionType = await getSubscriptionTypeConfig(subscriptionTypeName);

    if (!subscriptionType) {
      // If subscription type not found, return wildcard for all
      reportWildcardGrant("subscription-type-config-unavailable", userId, {
        subscriptionTypeName,
      });
      return ["*"];
    }

    // If all skills are allowed, return wildcard
    if (subscriptionType.allowedSkills.includes("*")) {
      // Distinguish "an admin deliberately typed ["*"]" from "the row carried no allowedSkills at
      // all and was defaulted to ["*"] on read" — the latter is a silent full-registry grant and
      // the likeliest real malformation, being the documented pre-`allowedSkills` config shape.
      if (subscriptionType.allowedSkillsDefaulted) {
        // Two distinct causes share the flag; kept separable in the data by name rather than
        // subscriptionTypeName alone ("Basic" is itself a real tier name a config could also use).
        const reason =
          subscriptionTypeName === "Basic"
            ? "legacy-basic-fallback-no-tier-config"
            : "tier-config-missing-allowed-skills";
        reportWildcardGrant(reason, userId, { subscriptionTypeName });
      }
      return ["*"];
    }

    // An empty list currently means "everything", not "nothing". That is almost certainly
    // inverted (FREE_TIER_FALLBACK is `allowedSkills: []`, commented "No premium skills on Free
    // tier"), but no live tier is empty today, so this records the case instead of changing it.
    if (subscriptionType.allowedSkills.length === 0) {
      reportWildcardGrant("empty-allowed-skills-treated-as-wildcard", userId, {
        subscriptionTypeName,
      });
      return ["*"];
    }

    return subscriptionType.allowedSkills;
  } catch (error: any) {
    console.error("Error getting allowed skills:", error);
    // Default to allowing all skills on error
    reportWildcardGrant("allowed-skills-lookup-failed", userId, {
      error: error?.message || String(error),
    });
    return ["*"];
  }
}

/**
 * Resolve skill IDs to their constituent tool names
 * For __other_skills__, returns tools not associated with any published skill
 * Returns ["*"] if input contains "*"
 */
export async function resolveSkillsToToolNames(
  skillIds: string[],
  /** ENG-1978 observation only — attributes the event below. Optional so no caller is forced to
   *  change; when absent the event is still emitted, just unattributed. */
  userIdForObservation?: string
): Promise<string[]> {
  try {
    if (skillIds.includes("*")) {
      return ["*"];
    }

    const publishedSkills = await skillService.getPublishedSkills();
    const toolNames = new Set<string>();

    for (const skillId of skillIds) {
      if (skillId === "__other_skills__") {
        // Get tools not associated with any published skill
        const { agentModeService } = await import("./agentModeService");
        const unassociatedTools = agentModeService.getUnassociatedToolNames(publishedSkills);
        unassociatedTools.forEach((name: string) => toolNames.add(name));
      } else {
        const skill = publishedSkills.find((s) => s.skillId === skillId);
        if (skill?.toolNames) {
          skill.toolNames.forEach((t: string) => toolNames.add(t));
        }
      }
    }

    return Array.from(toolNames);
  } catch (error: any) {
    console.error("Error resolving skills to tool names:", error);
    reportWildcardGrant("skill-to-tool-resolution-failed", userIdForObservation || "(unattributed)", {
      skillIds,
      error: error?.message || String(error),
    });
    return ["*"];
  }
}

/**
 * Get allowed skill IDs for public/anonymous users.
 * Reads from the "public_allowed_skills" setting.
 * Returns ["*"] (all skills) if no setting exists.
 */
export async function getPublicAllowedSkills(): Promise<string[]> {
  try {
    const setting = await settingsService.getSetting("public_allowed_skills");
    if (setting) {
      const skills = JSON.parse(setting.settingValue);
      if (Array.isArray(skills)) {
        return skills;
      }
    }
    // Default: no skills available to public
    return [];
  } catch (error) {
    console.error("Error getting public allowed skills:", error);
    return [];
  }
}

/**
 * All connected account platform types that can be gated per subscription.
 * "instagram" is a separate UI entry even though it uses the "meta" OAuth flow.
 */
export function getAllAvailableConnectedAccounts(): string[] {
  return ['linkedin', 'unipile', 'meta', 'gmail', 'outlook', 'calendly', 'youtube', 'fathom', 'instagram', 'twitter', 'hubspot', 'attio', 'google_ads', 'google_drive', 'linkedin_ads'];
}

/**
 * Get allowed connected account platforms for a user based on their subscription type.
 * Returns the actual list of platform strings.
 */
export async function getAllowedConnectedAccounts(userId: string): Promise<string[]> {
  try {
    const subscriptionTypeName = await getUserSubscriptionType(userId);
    const subscriptionType = await getSubscriptionTypeConfig(subscriptionTypeName);

    if (!subscriptionType) {
      return getAllAvailableConnectedAccounts();
    }

    const allowed = subscriptionType.allowedConnectedAccounts;
    if (!allowed || allowed.includes('*') || allowed.length === 0) {
      return getAllAvailableConnectedAccounts();
    }

    return allowed;
  } catch (error) {
    console.error('Error getting allowed connected accounts:', error);
    return getAllAvailableConnectedAccounts();
  }
}

/**
 * Get all available customer portal pages
 */
export function getAllAvailablePages(): string[] {
  // Include default pages plus all customer portal pages
  const defaultPages = ["/", "/agent-mode", "/settings", "/guide"];
  const customerPages = CUSTOMER_PORTAL_PAGES.map((page) => page.path);
  return [...defaultPages, ...customerPages];
}

/**
 * Get hidden pages for a user based on their subscription type.
 * Hidden pages are not shown at all in the sidebar (not even as locked/upgrade prompts).
 */
export async function getHiddenPages(userId: string): Promise<string[]> {
  try {
    const subscriptionTypeName = await getUserSubscriptionType(userId);
    const subscriptionType = await getSubscriptionTypeConfig(subscriptionTypeName);

    if (!subscriptionType || !subscriptionType.hiddenPages) {
      return [];
    }

    return subscriptionType.hiddenPages;
  } catch (error) {
    console.error("Error getting hidden pages:", error);
    return [];
  }
}

/**
 * Get allowed function calls for a user based on their subscription type.
 * Bridge function: resolves the user's allowed skills to individual tool names.
 * Keeps the same signature so existing callers (agentModeController.ts scheduled chat,
 * function-calls endpoint) continue to work unchanged.
 */
export async function getAllowedFunctionCalls(
  userId: string
): Promise<string[]> {
  try {
    const allowedSkillIds = await getAllowedSkills(userId);
    // `return await`, not bare `return`: a returned rejected promise is adopted OUTSIDE the try
    // block, so the catch below could never see it (pre-existing, unrelated to the observation).
    return await resolveSkillsToToolNames(allowedSkillIds, userId);
  } catch (error: any) {
    console.error("Error getting allowed function calls:", error);
    // Default to allowing all functions on error
    reportWildcardGrant("allowed-function-calls-failed", userId, {
      error: error?.message || String(error),
    });
    return ["*"];
  }
}

/**
 * Get allowed pages for a user based on their subscription type
 * Returns the actual list of pages (expands "*" to all available)
 */
export async function getAllowedPages(userId: string): Promise<string[]> {
  try {
    const subscriptionTypeName = await getUserSubscriptionType(userId);
    const subscriptionType = await getSubscriptionTypeConfig(subscriptionTypeName);

    if (!subscriptionType) {
      // If subscription type not found, return all available pages
      return getAllAvailablePages();
    }

    // If all pages are allowed, return all available pages
    if (
      subscriptionType.allowedPages.includes("*") ||
      subscriptionType.allowedPages.length === 0
    ) {
      return getAllAvailablePages();
    }

    // Return normalized pages (remove "/marketing" prefix if present)
    return subscriptionType.allowedPages.map((page: string) => {
      if (page.startsWith('/marketing/')) {
        return page.replace('/marketing', '');
      }
      return page;
    });
  } catch (error) {
    console.error("Error getting allowed pages:", error);
    // Default to allowing all pages on error
    return getAllAvailablePages();
  }
}

/**
 * Filter function calls based on subscription type
 */
export function filterFunctionCalls(
  allFunctionCalls: any[],
  allowedFunctionCalls: string[]
): any[] {
  // If wildcard is present, return all tools
  if (allowedFunctionCalls.includes("*")) {
    return allFunctionCalls;
  }

  // Filter function calls
  return allFunctionCalls.filter((tool) => {
    if (tool.type !== "function") return true;
    const functionName = tool.function?.name;
    if (!functionName) return true;
    return allowedFunctionCalls.includes(functionName);
  });
}
