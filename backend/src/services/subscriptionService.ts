import { settingsService } from "./settingsService";
import { userDb, orgDb } from "./db";
import { CUSTOMER_PORTAL_PAGES } from "./customerPortalPages";
import { skillService } from "./skillService";
import { hasOwnLiveSubscription } from "./orgAuthz";
import type { LlmUsagePolicy } from "./llmUsagePolicyService";
import type { LlmUsageTopUpConfig } from './llmUsageTopUpService';
import type { SubscriptionPaygOverageConfig } from './paygOverage';
import type { SeatPricingConfig } from './orgSeatService';

export interface SubscriptionType {
  name: string;
  allowedPages: string[]; // Array of page paths (e.g., ["/marketing/research", "/marketing/blog"]) or ["*"] for all
  hiddenPages?: string[]; // Array of page paths to hide entirely (not shown as locked); subset of pages not in allowedPages
  allowedSkills: string[]; // Array of skill IDs (e.g., ["skill-uuid-1", "skill-uuid-2"]) or ["*"] for all
  allowedConnectedAccounts?: string[]; // Array of platform types (e.g., ["linkedin", "gmail"]) or ["*"] for all; undefined = all
  allowedFeatures?: string[]; // Stable product feature IDs or ["*"]; undefined = legacy row (all current features except the opt-in-only ones)
  /**
   * ENG-669: chat models this tier may select (canonical registry ids), or ["*"] for every non-admin catalog model.
   * The reserved id "agentweb-model" names the future AgentWeb router and matches nothing runnable until it exists.
   * undefined = every model. Enforced only while AW-Settings `model_tier_allowlist_enabled` is 'true'
   * (services/agentMode/modelAccess.ts); system-chosen models (configured defaults) are always allowed.
   */
  allowedModels?: string[];
  allowedFunctionCalls?: string[]; // Deprecated — kept for on-read migration from old configs
  /** ENG-1978, observation only, never persisted: true when the stored row carried NO
   *  `allowedSkills` and it was defaulted to ["*"] on read. Set by getSubscriptionTypeConfig so
   *  the skills path can record that silent full-registry grant without this function's ~18 other
   *  callers each emitting a duplicate for the same malformed row. */
  allowedSkillsDefaulted?: boolean;
  monthlyTokenAllowance?: number | null; // Monthly token limit; null/undefined = unlimited
  monthlyCostAllowance?: number | null; // Monthly LLM spend limit in USD (cost-based cap; guards higher-cost models); null/undefined = unlimited
  llmUsagePolicy?: LlmUsagePolicy; // Versioned admin-managed full-choice/optimized/paused policy
  llmUsageTopUp?: LlmUsageTopUpConfig; // Admin-priced packages that extend this month's hard ceiling
  /**
   * Seat-based billing (ENG-2243..2246), Phase 2. Admin-configured pricing for
   * extra seats beyond this tier's free base. `priceCents` is the full monthly
   * charge per extra seat; `usageCreditMicroUsd` is the portion of that charge
   * (a separate ticket) grants back as shared LLM usage credit. `baseSeats`
   * mirrors `orgSeatService.baseSeatsForTier` for this tier so the admin UI
   * and any future caller can read it from config instead of the hardcoded
   * lookup — `orgSeatService.baseSeatsForTier` remains the source of truth
   * used for enforcement today; this field is not yet wired to replace it.
   */
  seatPricing?: SeatPricingConfig;
  /** ENG-668: whether this tier's billing owners may opt into pay-as-you-go overages. Absent = not offered. */
  paygOverage?: SubscriptionPaygOverageConfig;
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
  MODEL_COMPARE: "model_compare",
  HOT_LEAD_CALL: "hot_lead_call",
} as const;

/**
 * ENG-1978 — fail-closed.
 *
 * Several paths through this file used to resolve to `["*"]`, which grants every registered
 * tool: an unknown tier name, a malformed `subscription_types` row, an empty allowedSkills list,
 * and any thrown error. Only the explicit `["*"]` in a well-formed tier config is deliberate —
 * every other path now returns `null` (unresolved) instead, and callers fail closed on it.
 *
 * This shipped in two stages. PR #2947 (observation only, merged 2026-09-16) added this same
 * instrumentation with zero behaviour change, specifically to answer whether these paths fire in
 * production before anyone changed what they return — "we have never had a problem" was not
 * evidence, since a silent over-grant looks identical to normal operation from the outside. 14
 * days of production logs (through 2026-10-12) showed the over-grant path (then still called
 * `wildcard-grant`, PR #2947's name for it) firing only from one internal verification account,
 * never from real customer traffic, and `unconfirmed-tier` firing once for a real user — the
 * "effectively never fires" case the parked fail-closed branch's own decision record called the
 * free-win trigger. This change is that cherry-pick, re-ported onto current main (the original
 * branch was ~2970 commits stale).
 *
 * Renamed `wildcard-grant` -> `entitlement-denied` here, same flip as the behaviour: the old name
 * described what the path USED to do (grant everything); after this change it denies. Keeping the
 * old name would have made a dashboard built on "WILDCARD-GRANT count" silently start meaning the
 * opposite of what it meant when PR #2947 shipped it, with no signal that the meaning had flipped.
 * Any saved grep/dashboard against the literal string `WILDCARD-GRANT` breaks here, on purpose —
 * update it to `ENTITLEMENT-DENIED`.
 *
 * Sink is injectable so this can be routed at a real alerting surface without this module
 * reaching for one (same shape as usageWriteFailureMonitor's `setDroppedWriteAlertSink`). There
 * is no metrics facade in this codebase; a greppable marker prefix is the house convention.
 */
/**
 * Two DISTINCT kinds, deliberately not summable:
 *
 *  - `entitlement-denied` a case that used to silently grant every registered tool now instead
 *                       fails CLOSED (ENG-1978) — this is the number that answers "how often
 *                       does the fail-closed gate actually fire, now that it's live?"
 *  - `unconfirmed-tier` the tier could not be CONFIRMED for this user, but the grant that
 *                       followed may have been perfectly normal and restricted — this path's
 *                       behaviour is deliberately unchanged, see getAllowedSkills.
 *
 * Keeping them apart matters more than it looks. `unconfirmed-tier` is expected to be the
 * highest-volume reason, and it frequently accompanies a *restricted* result — an unreadable
 * user row still resolves to a real Free tier with a real skill list. Counting those as
 * over-grants would oversize the risk and argue against the fail-closed change on false
 * evidence, which is the opposite of what this instrumentation is for. Pre-flip (PR #2947, as
 * `wildcard-grant`) this counted over-grants; post-flip (`entitlement-denied`) it counts denials.
 */
// Round-2 review: grep both markers, not just ENTITLEMENT-DENIED, and break down by `kind` — do not
// sum them. `[entitlement]` is the shared prefix precisely so one grep catches both.
export type EntitlementObservationKind = "entitlement-denied" | "unconfirmed-tier";

export interface EntitlementObservationEvent {
  kind: EntitlementObservationKind;
  reason: string;
  userId: string;
  detail: Record<string, unknown>;
}

export type EntitlementDeniedSink = (event: EntitlementObservationEvent) => void;

const DEFAULT_ENTITLEMENT_SINK: EntitlementDeniedSink = (event) => {
  // Both markers share the `[entitlement]` prefix on purpose — `grep '\[entitlement\]'` catches
  // both kinds; then break down by the `kind` field in each JSON line rather than summing them.
  // ENG-1978 fail-closed: this marker was WILDCARD-GRANT under PR #2947 (observation only, meant
  // "granted everything"). Renamed to ENTITLEMENT-DENIED because the behaviour it describes
  // flipped — keeping the old name would have left a grep/dashboard built against "WILDCARD-GRANT"
  // silently reporting the opposite of what it used to mean, with nothing to signal the flip.
  const marker =
    event.kind === "entitlement-denied"
      ? "[entitlement] ENTITLEMENT-DENIED entitlement unresolved, withholding tools:"
      : "[entitlement] UNCONFIRMED-TIER entitlement resolved from an unconfirmed tier:";
  console.warn(marker, JSON.stringify(event));
};

let emitEntitlementDenied: EntitlementDeniedSink = DEFAULT_ENTITLEMENT_SINK;

/** Route entitlement observations somewhere other than the console (tests, alerting). */
export function setEntitlementDeniedSink(sink: EntitlementDeniedSink): void {
  emitEntitlementDenied = sink;
}

/** Restore the console sink. Tests must call this rather than installing a silent stub, or every
 *  test declared after theirs runs with observation disabled. */
export function resetEntitlementDeniedSink(): void {
  emitEntitlementDenied = DEFAULT_ENTITLEMENT_SINK;
  unconfirmedTierWindow = null;
}

function emitEntitlementObservation(event: EntitlementObservationEvent): void {
  try {
    // `Promise.resolve(...)` on purpose: the sink is typed `=> void`, but TypeScript happily
    // accepts an `async` function there, and a rejected promise would escape this synchronous
    // catch entirely — surfacing as an unhandled rejection, which under Node's default in EB
    // terminates the process. Observation must never be the reason the SERVER fails, not just
    // the reason a check fails.
    void Promise.resolve(emitEntitlementDenied(event)).catch(() => {});
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
 * `entitlement-denied` stays per-event: it is low-volume by construction (a genuine full-registry
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
function reportEntitlementDenied(
  reason: string,
  userId: string,
  detail: Record<string, unknown> = {}
): void {
  emitEntitlementObservation({ kind: "entitlement-denied", reason, userId, detail });
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
}, {
  id: SUBSCRIPTION_FEATURES.MODEL_COMPARE,
  label: "Compare models",
  description: "Send one prompt to several models and compare their answers side by side.",
}, {
  id: SUBSCRIPTION_FEATURES.HOT_LEAD_CALL,
  label: "Hot lead calls",
  description: "Phone a team member when a hot lead arrives and connect them to the lead.",
}];

/**
 * Features that cost AgentWeb money per use (paid vendors). Every "all features" expansion or default
 * (legacy rows, new tiers, an omitted list) leaves these out, so only an explicit tick, or a saved
 * "*", grants them. A new paid-vendor feature joins this list.
 */
const OPT_IN_ONLY_SUBSCRIPTION_FEATURES: ReadonlyArray<SubscriptionFeatureId> = [
  SUBSCRIPTION_FEATURES.HOT_LEAD_CALL,
];

export function getAllAvailableSubscriptionFeatures() {
  return AVAILABLE_SUBSCRIPTION_FEATURES.map((feature) => ({
    ...feature,
    optInOnly: OPT_IN_ONLY_SUBSCRIPTION_FEATURES.includes(feature.id),
  }));
}

/** The feature ids an absent or legacy feature list stands for: everything except opt-in-only features. */
export function getDefaultSubscriptionFeatureIds(): SubscriptionFeatureId[] {
  return AVAILABLE_SUBSCRIPTION_FEATURES
    .map((feature) => feature.id)
    .filter((id) => !OPT_IN_ONLY_SUBSCRIPTION_FEATURES.includes(id));
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
  // behavior until an admin explicitly saves this field, except for opt-in-only features.
  if (!Array.isArray(config.allowedFeatures)) return getDefaultSubscriptionFeatureIds();
  if (config.allowedFeatures.includes("*")) {
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
  if (!Array.isArray(config.allowedFeatures)) return !OPT_IN_ONLY_SUBSCRIPTION_FEATURES.includes(feature);
  if (config.allowedFeatures.includes("*")) return true;

  return config.allowedFeatures.includes(feature);
}

/**
 * Last good read of the `subscription_types` setting, used ONLY when the live read fails.
 *
 * The read is deliberately uncached in normal operation so an admin edit applies at once. But a
 * transient DynamoDB error used to make every entitlement check unresolvable for its duration, and
 * since ENG-1978 an unresolvable tier fails closed — so a blip would strip paid tools from users
 * mid-conversation. Serving the config we read moments ago keeps those users on the plan they were
 * on. It is bounded: past the max age (or on a cold process with nothing to serve) we fail closed
 * as before, so a long outage can never keep honouring a plan an admin has since changed.
 */
type SubscriptionTypesSetting = Awaited<ReturnType<typeof settingsService.getSetting>>;
const SUBSCRIPTION_TYPES_STALE_MAX_AGE_MS = 15 * 60 * 1000;
const STALE_CONFIG_WARN_INTERVAL_MS = 60 * 1000;
let lastKnownSubscriptionTypes: { setting: SubscriptionTypesSetting; at: number } | null = null;
let lastStaleConfigWarnAt = 0;

/** Forget the last good read (tests; a read that must not be served stale). */
export function resetLastKnownSubscriptionTypes(): void {
  lastKnownSubscriptionTypes = null;
  lastStaleConfigWarnAt = 0;
}

async function readSubscriptionTypesSetting(): Promise<SubscriptionTypesSetting> {
  try {
    const setting = await settingsService.getSetting("subscription_types");
    lastKnownSubscriptionTypes = { setting, at: Date.now() };
    return setting;
  } catch (error) {
    const last = lastKnownSubscriptionTypes;
    const now = Date.now();
    if (!last || now - last.at > SUBSCRIPTION_TYPES_STALE_MAX_AGE_MS) throw error;
    if (now - lastStaleConfigWarnAt >= STALE_CONFIG_WARN_INTERVAL_MS) {
      lastStaleConfigWarnAt = now;
      console.warn(
        `[entitlement] STALE-CONFIG serving the last-known subscription_types (${Math.round(
          (now - last.at) / 1000
        )}s old) after a failed read:`,
        (error as any)?.message || String(error)
      );
    }
    return last.setting;
  }
}

/**
 * ENG-669: the raw `allowedModels` of one tier, for the tier model allowlist. Unlike getSubscriptionTypeConfig this
 * keeps "the tier has no row" (`configured: false`: nothing narrows it, every model) apart from "the setting could
 * not be read": that THROWS (after the same bounded last-known fallback as every entitlement read), so the caller can
 * serve its own last-known answer instead of mistaking an outage for a configuration.
 */
export async function readTierAllowedModels(tierName: string): Promise<{ configured: boolean; allowedModels?: unknown }> {
  const setting = await readSubscriptionTypesSetting();
  if (!setting?.settingValue) return { configured: false };
  const tiers: unknown = JSON.parse(setting.settingValue);
  const tier = Array.isArray(tiers)
    ? tiers.find((t: any) => t && typeof t === 'object' && t.name === tierName)
    : undefined;
  return tier ? { configured: true, allowedModels: (tier as SubscriptionType).allowedModels } : { configured: false };
}

/**
 * Get subscription type configuration
 */
export async function getSubscriptionTypeConfig(
  subscriptionTypeName: string
): Promise<SubscriptionType | null> {
  try {
    const setting = await readSubscriptionTypesSetting();
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
 * allow the skill. Fails OPEN (reachable=true) when no tier config exists, so absent config never
 * raises a false alarm.
 *
 * Deliberately the opposite polarity from `getAllowedSkills`, which fails CLOSED (ENG-1978). Both
 * are correct: there, failing open would GRANT access; here, it only weakens a warning shown to an
 * admin about to publish. This comment previously described the two as mirroring each other — they
 * no longer do, and should not be "made consistent" without re-reading which direction each one's
 * failure actually points.
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
        // ENG-1978: a tier without an allowedSkills list is malformed and the runtime refuses to
        // resolve it (getAllowedSkills returns null), so it reaches nothing. Do not report it as
        // allowing the skill — that would hide the very problem this warning exists to surface.
        const allowedSkills: string[] = Array.isArray(tier.allowedSkills) ? tier.allowedSkills : [];
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
export async function getAllowedSkills(userId: string): Promise<string[] | null> {
  try {
    // Anonymous/public users use the public skills config
    if (userId.startsWith("anon_")) {
      return getPublicAllowedSkills();
    }

    // ENG-1978: use the RESOLUTION, not the bare name. `resolveUserSubscriptionType` already
    // distinguishes "this user is on Free" from "I could not read this user and am defaulting to
    // Free" — but `getUserSubscriptionType` discards that flag and returns only the string.
    //
    // Deliberately NOT gating on `resolved: false` here (ENG-1978 fail-closed, corrected before
    // merge). The flag is overloaded across four cases, and two of them (unreadable org owner,
    // org-lookup blip) still carry a real, usable tier — the subscriptionTypeName below. Denying
    // on the flag would strip every tool from a paying org member during a routine blip, strictly
    // worse than the downgrade this function's own comment above exists to prevent. Record it as
    // an unconfirmed tier (not an entitlement-denied: the assumed tier below is frequently real and
    // restricted) and keep going with the assumed name.
    const { subscriptionType: subscriptionTypeName, resolved } =
      await getUserSubscriptionResolution(userId);
    if (!resolved) {
      reportUnconfirmedTier("subscription-type-unresolved", userId, {
        assumedSubscriptionType: subscriptionTypeName,
      });
    }

    const subscriptionType = await getSubscriptionTypeConfig(subscriptionTypeName);

    if (!subscriptionType) {
      // ENG-1978: unresolved, NOT grant-all. getSubscriptionTypeConfig returns null for an
      // unknown tier name, a malformed `subscription_types` setting, or a failed read — none of
      // which is evidence that this user is entitled to everything. Callers distinguish null
      // (couldn't resolve) from [] (resolved: no skills); see the doc comment above.
      reportEntitlementDenied("subscription-type-config-unavailable", userId, {
        subscriptionTypeName,
      });
      return null;
    }

    // If all skills are allowed, return wildcard
    if (subscriptionType.allowedSkills.includes("*")) {
      // Distinguish "an admin deliberately typed ["*"]" from "the row carried no allowedSkills at
      // all and was defaulted to ["*"] on read" — the latter is a silent full-registry grant and
      // the likeliest real malformation, being the documented pre-`allowedSkills` config shape.
      // ENG-1978: that silent default is no longer granted — it fails closed like every other
      // unresolvable case above.
      if (subscriptionType.allowedSkillsDefaulted) {
        // Two distinct causes share the flag; kept separable in the data by name rather than
        // subscriptionTypeName alone ("Basic" is itself a real tier name a config could also use).
        const reason =
          subscriptionTypeName === "Basic"
            ? "legacy-basic-fallback-no-tier-config"
            : "tier-config-missing-allowed-skills";
        reportEntitlementDenied(reason, userId, { subscriptionTypeName });
        return null;
      }
      return ["*"];
    }

    // ENG-1978: an empty list means NO skills, not all of them. This previously returned ["*"],
    // which inverted the intent of every tier that lists nothing -- most visibly FREE_TIER_FALLBACK
    // above, whose `allowedSkills: []` is commented "No premium skills on Free tier" and which
    // therefore granted every registered tool whenever the DB config was unreachable. 14 days of
    // production telemetry (round-2's windowed/per-event observation) never once saw a live tier
    // hit this path, so there is no observed behaviour this flip can be regressing.
    return subscriptionType.allowedSkills;
  } catch (error: any) {
    // Deliberately fail closed. An error must never grant more access than success does, and the
    // assembler that consumes this already declares the same policy for itself
    // (agentModeService.getFilteredTools: "DO NOT return all tools on error as it's a security
    // risk"). Returning ["*"] here silently defeated that.
    console.error("Error getting allowed skills:", error);
    reportEntitlementDenied("allowed-skills-lookup-failed", userId, {
      error: error?.message || String(error),
    });
    return null;
  }
}

/**
 * Resolve skill IDs to their constituent tool names
 * For __other_skills__, returns tools not associated with any published skill
 * Returns ["*"] if input contains "*"
 */
export async function resolveSkillsToToolNames(
  skillIds: string[] | null,
  /** ENG-1978 observation only — attributes the event below. Optional so no caller is forced to
   *  change; when absent the event is still emitted, just unattributed. */
  userIdForObservation?: string
): Promise<string[] | null> {
  // ENG-1978: an unresolved entitlement stays unresolved. Previously the null/error paths
  // upstream arrived here as ["*"], which expanded to every tool.
  if (skillIds === null) return null;

  try {
    if (skillIds.includes("*")) {
      return ["*"];
    }

    const publishedSkills = await skillService.getPublishedSkills();
    const toolNames = new Set<string>();

    for (const skillId of skillIds) {
      if (skillId === "__other_skills__") {
        // ENG-2299: pass the full published catalog; scoping by the caller's tier would leak higher-tier tools into the catch-all.
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
    // Fail closed (ENG-1978). getPublishedSkills rethrows on a DynamoDB error, and converting that
    // into ["*"] granted every registered tool on a transient blip.
    console.error("Error resolving skills to tool names:", error);
    reportEntitlementDenied("skill-to-tool-resolution-failed", userIdForObservation || "(unattributed)", {
      skillIds,
      error: error?.message || String(error),
    });
    return null;
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
): Promise<string[] | null> {
  try {
    const allowedSkillIds = await getAllowedSkills(userId);
    // `return await`, not bare `return`: a returned rejected promise is adopted OUTSIDE the try
    // block, so the catch below could never see it (pre-existing, unrelated to the observation).
    return await resolveSkillsToToolNames(allowedSkillIds, userId);
  } catch (error: any) {
    // Fail closed (ENG-1978) — see getAllowedSkills' own catch for the reasoning.
    //
    // Honest note: this catch is defence in depth and is NOT reachable today — both calls above
    // now swallow their own errors and return null rather than throwing. Hand-verified by
    // temporarily flipping this to ["*"]: no test goes red, because nothing reaches it. It is
    // kept so a future change that makes either call throw cannot silently reintroduce a
    // grant-all, but do not mistake it for a tested path.
    console.error("Error getting allowed function calls:", error);
    reportEntitlementDenied("allowed-function-calls-failed", userId, {
      error: error?.message || String(error),
    });
    return null;
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
