/**
 * ENG-669: tier-gated model selection.
 *
 * Product rule: the user (or admin) chooses the model and only that model runs. A model outside the owner's
 * subscription tier is refused visibly (422 `model_unavailable`, reason `not_in_plan`), never swapped for another.
 *
 * Data: `SubscriptionType.allowedModels?: string[]` in the AW-Settings `subscription_types` JSON. Entries are
 * canonical registry ids, plus two reserved values:
 *  - `'*'` every non-admin catalog model (exactly today's behaviour);
 *  - `'agentweb-model'` the id reserved for the future AgentWeb router (ENG-669 PR-C). It is NOT a registry key, so
 *    until that router exists it matches nothing runnable: a tier listing only it can run its system models only.
 * Absent field = `'*'`. Legacy aliases are resolved on read as well as on the admin write.
 *
 * Switch: AW-Settings `model_tier_allowlist_enabled`. ONLY the exact string 'true' enables the gate; absent / any
 * other value / a cold-start read failure => off, i.e. byte-identical to before (nothing here is read). A successful
 * read is cached ~60s; a failed refresh keeps the last-known value (same pattern as workPlanStepModels.ts).
 *
 * Who is checked: the SESSION OWNER (or schedule / plan owner), never the caller, so an admin or a delegated caller
 * acting on a user's session gets that user's plan. Admin owners bypass. `anon_` owners get the Free tier's list.
 * Org members get the org owner's tier unless they hold their own live subscription (getUserSubscriptionResolution).
 *
 * Exempt: SYSTEM models, i.e. AgentWeb's choice rather than the user's (configured defaults, admin-authored plan pins;
 * see modelAccessInstance.ts systemModelsFor). Only a check that would otherwise refuse ever computes that set.
 *
 * Never blocks on infrastructure: an unreadable tier uses this owner's last-known access; with none at all the model
 * is allowed and one deduped on-call alert fires.
 *
 * This module has no dependency on the service graph (unit-testable); the process-wide instance lives in
 * modelAccessInstance.ts.
 */
import { ModelUnavailableError } from './modelUnavailable';

export const MODEL_TIER_ALLOWLIST_SETTING = 'model_tier_allowlist_enabled';
/** Every non-admin catalog model. */
export const ALL_MODELS = '*' as const;
/** Reserved for the AgentWeb router (PR-C). Not a registry key: matches nothing runnable until then. */
export const AGENTWEB_MODEL_ID = 'agentweb-model';

export type AllowedModels = string[] | typeof ALL_MODELS;

export interface ModelAccess {
  /** Effective tier name (null when no tier could be read and nothing was known). */
  tier: string | null;
  allowedModels: AllowedModels;
  isAdmin: boolean;
  /** `last_known`: the live read failed and this owner's previous answer is served. `unavailable`: nothing known, allowed. */
  source: 'admin' | 'tier' | 'last_known' | 'unavailable';
}

/** The slice of a SubscriptionType this module reads. */
export interface TierModelsConfig {
  name: string;
  allowedModels?: unknown;
}

const CACHE_TTL_MS = 60_000;
/** After a failed switch refresh, retry sooner than a full window but not on every request. */
const ERROR_RETRY_MS = 5_000;
/** A fresh per-owner answer is reused this long, so one turn (resolver + final gate) reads the tier once. */
const ACCESS_TTL_MS = 10_000;
/** Bound on remembered owners (fresh cache + last-known); the oldest is dropped first. */
const MAX_REMEMBERED_OWNERS = 5_000;
const UNREADABLE_ALERT_WINDOW_MS = 60 * 60 * 1000;
export const TIER_UNREADABLE_ALERT_DEDUPE_KEY = 'model_tier_allowlist:tier_unreadable';

export interface ModelAccessDeps {
  getSetting(name: string): Promise<{ settingValue?: unknown } | null>;
  /** The owner's user record (only `isAdmin` is read). */
  getUser(userId: string): Promise<{ isAdmin?: boolean } | null | undefined>;
  /** Effective (org-aware) tier name; `resolved: false` when it could not be confirmed. */
  resolveTier(userId: string): Promise<{ subscriptionType: string; resolved: boolean }>;
  /** The tier's config, or null when unreadable / not configured. */
  getTierConfig(tierName: string): Promise<TierModelsConfig | null>;
  /** Every configured tier, in admin order (for `upgradeRequired`). */
  listTiers(): Promise<TierModelsConfig[]>;
  normalizeModelId(id: string): string;
  /** Deduped by the caller-supplied key; must not throw. */
  alertTierUnreadable(input: { ownerUserId: string; tier: string | null; dedupeKey: string; dedupeWindowMs: number }): Promise<unknown>;
  now(): number;
  log(message: string, fields?: Record<string, unknown>): void;
}

/**
 * The stored field as the gate reads it: absent (or not a list) = every model; a list containing `'*'` = every
 * model; otherwise trimmed, alias-resolved, de-duplicated ids. A present-but-malformed value is treated as absent
 * (fail open, logged by the caller) - the admin write refuses it, so only an out-of-band edit can produce one.
 */
export function normalizeAllowedModels(raw: unknown, normalizeModelId: (id: string) => string): AllowedModels {
  if (!Array.isArray(raw)) return ALL_MODELS;
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed === ALL_MODELS) return ALL_MODELS;
    const canonical = trimmed === AGENTWEB_MODEL_ID ? trimmed : normalizeModelId(trimmed);
    if (typeof canonical === 'string' && canonical && !ids.includes(canonical)) ids.push(canonical);
  }
  return ids;
}

/** Whether the access allows this CANONICAL id (resolve legacy aliases first). Admins bypass. */
export function isModelAllowed(access: ModelAccess, canonicalId: string): boolean {
  if (access.isAdmin || access.allowedModels === ALL_MODELS) return true;
  return access.allowedModels.includes(canonicalId);
}

/** How many of `catalogIds` (canonical, runnable) the access allows, plus the always-runnable system ids. */
export function countAllowedRunnable(access: ModelAccess, catalogIds: readonly string[], systemIds: readonly string[] = []): number {
  const catalog = new Set(catalogIds);
  if (access.isAdmin || access.allowedModels === ALL_MODELS) return catalog.size;
  const runnable = new Set<string>();
  for (const id of [...access.allowedModels, ...systemIds]) if (catalog.has(id)) runnable.add(id);
  return runnable.size;
}

/**
 * An admin-authored Work Plan (created through the admin routes, i.e. built-in, or published as a system plan): its
 * pins are AgentWeb's choice, so they are not checked against the launching user's plan. A user plan stays
 * user-authored after review/approval to `public`.
 */
export function isSystemAuthoredPlan(plan: { visibility?: unknown; isBuiltIn?: unknown } | null | undefined): boolean {
  return !!plan && (plan.isBuiltIn === true || plan.visibility === 'system');
}

export function createModelAccess(deps: ModelAccessDeps) {
  // ---- switch (same shape as workPlanStepModels.ts) ----
  let known = false; // last successfully read value; cold start => off
  let validUntil = 0;
  let inFlight: Promise<void> | null = null;

  async function refresh(now: number): Promise<void> {
    try {
      const row = await deps.getSetting(MODEL_TIER_ALLOWLIST_SETTING);
      known = row?.settingValue === 'true';
      validUntil = now + CACHE_TTL_MS;
    } catch (error) {
      deps.log('ModelAccess: failed to read the tier-allowlist switch; keeping last-known value (off if none)', {
        errorClass: (error as Error)?.name ?? 'Error',
        known,
      });
      validUntil = now + ERROR_RETRY_MS;
    }
  }

  async function isEnabled(): Promise<boolean> {
    const now = deps.now();
    if (now >= validUntil) {
      inFlight ??= refresh(now).finally(() => { inFlight = null; });
      await inFlight;
    }
    return known;
  }

  // ---- per-owner access: fresh for ACCESS_TTL_MS, then kept as the last-known answer ----
  const remembered = new Map<string, { access: ModelAccess; at: number }>();

  function remember(ownerKey: string, access: ModelAccess, at: number): void {
    remembered.delete(ownerKey); // re-insert so Map order is oldest-first
    remembered.set(ownerKey, { access, at });
    if (remembered.size > MAX_REMEMBERED_OWNERS) {
      const oldest = remembered.keys().next().value;
      if (oldest !== undefined) remembered.delete(oldest);
    }
  }

  function unreadable(ownerKey: string, ownerUserId: string, tier: string | null, why: string): ModelAccess {
    const last = remembered.get(ownerKey);
    if (last) {
      deps.log('ModelAccess: tier unreadable; serving the last-known access', { why, tier: last.access.tier });
      return { ...last.access, source: 'last_known' };
    }
    deps.log('ModelAccess: tier unreadable and nothing known; allowing every model', { why, tier });
    void deps.alertTierUnreadable({
      ownerUserId,
      tier,
      dedupeKey: TIER_UNREADABLE_ALERT_DEDUPE_KEY,
      dedupeWindowMs: UNREADABLE_ALERT_WINDOW_MS,
    }).catch(() => { /* the alert sink must never fail a turn */ });
    return { tier, allowedModels: ALL_MODELS, isAdmin: false, source: 'unavailable' };
  }

  async function readAccess(ownerUserId: string): Promise<ModelAccess> {
    const anonymous = ownerUserId.startsWith('anon_');
    // All anonymous visitors share the Free tier's answer, so they also share one cache entry.
    const ownerKey = anonymous ? 'anon_' : ownerUserId;
    const now = deps.now();
    const cached = remembered.get(ownerKey);
    if (cached && now - cached.at < ACCESS_TTL_MS) return cached.access;

    let tier: string | null = null;
    try {
      if (!anonymous) {
        const user = await deps.getUser(ownerUserId);
        if (user?.isAdmin === true) {
          const access: ModelAccess = { tier: null, allowedModels: ALL_MODELS, isAdmin: true, source: 'admin' };
          remember(ownerKey, access, now);
          return access;
        }
      }
      const resolution = anonymous ? { subscriptionType: 'Free', resolved: true } : await deps.resolveTier(ownerUserId);
      tier = resolution.subscriptionType;
      if (!resolution.resolved) return unreadable(ownerKey, ownerUserId, tier, 'tier_unconfirmed');
      const config = await deps.getTierConfig(tier);
      if (!config) return unreadable(ownerKey, ownerUserId, tier, 'tier_config_unavailable');
      if (config.allowedModels !== undefined && !Array.isArray(config.allowedModels)) {
        deps.log('ModelAccess: malformed allowedModels on a tier; treating it as every model', { tier });
      }
      const access: ModelAccess = {
        tier,
        allowedModels: normalizeAllowedModels(config.allowedModels, deps.normalizeModelId),
        isAdmin: false,
        source: 'tier',
      };
      remember(ownerKey, access, now);
      return access;
    } catch (error) {
      return unreadable(ownerKey, ownerUserId, tier, (error as Error)?.name ?? 'Error');
    }
  }

  /** The owner's model access. Callers check `isEnabled()` first; this does not read the switch. */
  async function getModelAccess(ownerUserId: string): Promise<ModelAccess> {
    return readAccess(ownerUserId);
  }

  /** Tier names (admin order) whose allowlist includes at least one of these canonical ids. Never throws (empty on failure). */
  async function tiersAllowingModels(canonicalIds: readonly string[]): Promise<string[]> {
    try {
      const tiers = await deps.listTiers();
      return tiers
        .filter((t) => t && typeof t.name === 'string')
        .filter((t) => {
          const allowed = normalizeAllowedModels(t.allowedModels, deps.normalizeModelId);
          return allowed === ALL_MODELS || canonicalIds.some((id) => allowed.includes(id));
        })
        .map((t) => t.name);
    } catch (error) {
      deps.log('ModelAccess: failed to list tiers for upgradeRequired', { errorClass: (error as Error)?.name ?? 'Error' });
      return [];
    }
  }

  /** Tier names (admin order) that run at least `minimum` of `catalogIds` (with the always-runnable `systemIds`). */
  async function tiersRunningAtLeast(minimum: number, catalogIds: readonly string[], systemIds: readonly string[] = []): Promise<string[]> {
    try {
      const tiers = await deps.listTiers();
      return tiers
        .filter((t) => t && typeof t.name === 'string')
        .filter((t) => {
          const access: ModelAccess = {
            tier: t.name,
            allowedModels: normalizeAllowedModels(t.allowedModels, deps.normalizeModelId),
            isAdmin: false,
            source: 'tier',
          };
          return countAllowedRunnable(access, catalogIds, systemIds) >= minimum;
        })
        .map((t) => t.name);
    } catch (error) {
      deps.log('ModelAccess: failed to list tiers for upgradeRequired', { errorClass: (error as Error)?.name ?? 'Error' });
      return [];
    }
  }

  /** Tier names (admin order) whose allowlist includes this canonical id: the 422's `upgradeRequired`. */
  async function tiersAllowingModel(canonicalId: string): Promise<string[]> {
    return tiersAllowingModels([canonicalId]);
  }

  /**
   * THE gate. Throws ModelUnavailableError(`not_in_plan`) when the switch is on, the owner is not an admin, the
   * CANONICAL id is not in the owner's allowlist, and it is not a system model. `isSystemModel` is evaluated only
   * when the allowlist would refuse (it may read settings). Resolves (allowed) in every other case.
   */
  async function assertModelAllowed(input: {
    ownerUserId: string;
    /** What the caller asked for (echoed in the 422 as `requestedModel`). */
    requestedModel: string;
    /** The registry id after legacy-alias resolution; the allowlist is matched on this. */
    canonicalModel: string;
    isSystemModel?: (canonicalModel: string) => Promise<boolean>;
  }): Promise<void> {
    if (!(await isEnabled())) return;
    const access = await readAccess(input.ownerUserId);
    if (isModelAllowed(access, input.canonicalModel)) return;
    if (input.isSystemModel && (await input.isSystemModel(input.canonicalModel))) return;
    throw new ModelUnavailableError(input.requestedModel, 'not_in_plan', {
      model: input.canonicalModel,
      tier: access.tier,
      allowedModels: access.allowedModels === ALL_MODELS ? [] : [...access.allowedModels],
      upgradeRequired: await tiersAllowingModel(input.canonicalModel),
    });
  }

  /**
   * `ids` (canonical) narrowed to what the owner may run, order kept; a system model (`isSystemModel`, asked only
   * about ids the allowlist would drop) stays. Switch off, an admin owner or a wildcard tier => `ids` unchanged.
   */
  async function filterAllowedModels(
    ownerUserId: string,
    ids: readonly string[],
    isSystemModel?: (canonicalModel: string) => Promise<boolean>,
  ): Promise<string[]> {
    if (!(await isEnabled())) return [...ids];
    const access = await readAccess(ownerUserId);
    const kept: string[] = [];
    for (const id of ids) {
      if (isModelAllowed(access, id) || (isSystemModel && (await isSystemModel(id)))) kept.push(id);
    }
    return kept;
  }

  /** Forget cached access and the switch (tests). */
  function reset(): void {
    remembered.clear();
    known = false;
    validUntil = 0;
    inFlight = null;
  }

  return {
    isEnabled, getModelAccess, tiersAllowingModel, tiersAllowingModels, tiersRunningAtLeast, assertModelAllowed, filterAllowedModels, reset,
  };
}

export type ModelAccessService = ReturnType<typeof createModelAccess>;
