/**
 * ENG-903: the ONE rule set for an explicit model pin (a schedule's llmModel /
 * llmBackupModel, a Work Plan's `defaultModel`). Extracted verbatim from the
 * controller's `validateScheduleModelPin` so schedule writes, plan writes and plan
 * launches cannot drift: same registry check (key or honoured alias), same
 * selectability check (internalOnly / live-voice fail for everyone; adminOnly clears
 * only for an admin), same ModelUnavailableError reasons.
 */
import { ModelUnavailableError } from './modelUnavailable';

/** The slice of AgentModeService the pin rules read (all optional: older unit-test doubles are partial). */
export interface ModelPinRegistry {
  resolveGenerationModel?: (model: string) => { model: string; fellBack: boolean; requestedModel: string };
  isModelSelectableBy?: (modelId: string, isAdmin: boolean) => boolean;
  getModelDisplayName?: (modelId: string) => string | undefined;
}

/**
 * A request-body llmModel that is not a string (array, number, object...) is still an
 * explicit selection, but it must never reach the registry lookups, which coerce keys
 * (['gpt-5.5'] would match 'gpt-5.5' and then blow up later as a 500). Give it a
 * stable string form so it is refused like any other unserved id. null/undefined/blank
 * stay "no selection".
 */
export function normalizeRequestedLlmModel(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'string') return raw.trim() || undefined;
  try {
    return JSON.stringify(raw) ?? String(raw);
  } catch {
    return String(typeof raw);
  }
}

/**
 * Canonical registry id for a stored/requested pin, or undefined when it does not resolve
 * (retired / not served) or the registry double cannot resolve. Never throws.
 */
export function canonicalPinId(registry: ModelPinRegistry, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (typeof registry.resolveGenerationModel !== 'function') return undefined;
  try {
    const r = registry.resolveGenerationModel(value.trim());
    return r.fellBack ? undefined : r.model;
  } catch {
    return undefined;
  }
}

/**
 * Returns the id to persist ('' = no pin): the CANONICAL registry id when the registry can
 * resolve it (so a legacy alias is never stored), otherwise the trimmed requested id (partial
 * registry doubles). Throws ModelUnavailableError when the id is not
 * a string, not served, or not selectable by this user. `isAdmin` is only invoked when
 * the model is adminOnly (the one gate an admin can clear).
 */
export async function validateModelPin(
  registry: ModelPinRegistry,
  isAdmin: () => Promise<boolean>,
  raw: unknown,
): Promise<string> {
  const requested = normalizeRequestedLlmModel(raw);
  if (!requested) return '';
  if (typeof raw !== 'string') throw new ModelUnavailableError(requested, 'not_served');
  if (typeof registry.resolveGenerationModel !== 'function' || typeof registry.isModelSelectableBy !== 'function') {
    return requested;
  }
  const resolution = registry.resolveGenerationModel(requested);
  if (resolution.fellBack) throw new ModelUnavailableError(requested, 'not_served');
  if (!registry.isModelSelectableBy(resolution.model, false)) {
    const adminCanSelect = registry.isModelSelectableBy(resolution.model, true) && await isAdmin();
    if (!adminCanSelect) throw new ModelUnavailableError(requested, 'not_selectable');
  }
  return resolution.model || requested;
}

/**
 * Launch-time resolution of a Work Plan's `defaultModel`. Empty/absent = no pin
 * (undefined: the caller keeps the account default). Otherwise the pin must be served
 * and selectable by the LAUNCHING user or this throws ModelUnavailableError; on success
 * the canonical registry id is returned (so an honoured alias is stored canonically).
 */
export async function resolvePlanLaunchModel(
  registry: ModelPinRegistry,
  isAdmin: () => Promise<boolean>,
  rawPlanModel: unknown,
): Promise<string | undefined> {
  const pin = await validateModelPin(registry, isAdmin, rawPlanModel);
  if (!pin) return undefined;
  if (typeof registry.resolveGenerationModel !== 'function') return pin;
  const resolution = registry.resolveGenerationModel(pin);
  return resolution.fellBack ? pin : resolution.model;
}

/**
 * Whether the plan OWNER's admin status may clear an adminOnly pin: only a private plan
 * owned by an admin and not org-scoped. System/public plans, other owners' plans and
 * org-shared private plans (`orgId` set: org members launch them) are launched by
 * non-admins too, so an adminOnly pin there would 422 every such launch.
 */
export function planAdminStatusApplies(plan: { visibility?: string; ownerId?: string; orgId?: string }): boolean {
  return plan.visibility === 'private' && !!plan.ownerId && !plan.orgId;
}

/** Admin flag for a user id; never throws (failed read = non-admin, same as the resolver). */
export async function isUserAdminSafe(userId: string | undefined): Promise<boolean> {
  if (!userId || userId.startsWith('anon_')) return false;
  try {
    const { userDb } = require('../db') as typeof import('../db');
    if (typeof userDb?.getUserById !== 'function') return false;
    return (await userDb.getUserById(userId))?.isAdmin === true;
  } catch (error) {
    console.error(`modelPin: failed to resolve admin status for ${userId}; treating as non-admin:`, error);
    return false;
  }
}

/**
 * Write-time handling of a plan's `defaultModel` (create/update), mirroring the schedule
 * update rules: undefined/null = field untouched; '' / whitespace = explicit clear; an
 * UNCHANGED stored value is tolerated (a since-retired model must not block unrelated
 * edits); anything else is validated. Returns `{ touched:false }` or the value to store.
 */
export async function validatePlanDefaultModelWrite(
  registry: ModelPinRegistry,
  isAdmin: () => Promise<boolean>,
  incoming: unknown,
  stored?: unknown,
): Promise<{ touched: false } | { touched: true; value: string }> {
  if (incoming === undefined || incoming === null) return { touched: false };
  const trimmed: unknown = typeof incoming === 'string' ? incoming.trim() : incoming;
  if (trimmed === '') return { touched: true, value: '' };
  const storedTrimmed = typeof stored === 'string' ? stored.trim() : '';
  if (trimmed === storedTrimmed) return { touched: true, value: storedTrimmed };
  // Same model as the stored value under its canonical form (stored alias, canonical resent,
  // or the reverse): unchanged, so no re-validation (a later selectability change must not block it).
  const storedCanonical = canonicalPinId(registry, storedTrimmed);
  if (storedCanonical && typeof trimmed === 'string' && (trimmed === storedCanonical || canonicalPinId(registry, trimmed) === storedCanonical)) {
    return { touched: true, value: trimmed === storedCanonical ? trimmed : storedTrimmed };
  }
  return { touched: true, value: await validateModelPin(registry, isAdmin, trimmed) };
}

/**
 * Route-level wrapper for plan writes: lazily loads the registry (only when a model value
 * is actually being validated, so unrelated plan edits never pay for it), and maps a
 * refusal to the shared 422 body. Returns `{ ok:true, ... }` or `{ ok:false, body }`.
 */
export async function checkPlanDefaultModelWrite(
  isAdmin: () => Promise<boolean>,
  incoming: unknown,
  stored?: unknown,
): Promise<
  | { ok: true; touched: false }
  | { ok: true; touched: true; value: string | undefined }
  | { ok: false; body: import('./modelUnavailable').ModelUnavailableBody }
> {
  if (incoming === undefined || incoming === null) return { ok: true, touched: false };
  const { agentModeService } = await import('../agentModeService');
  const { isModelUnavailableError, buildModelUnavailableBody } = await import('./modelUnavailable');
  try {
    const r = await validatePlanDefaultModelWrite(agentModeService, isAdmin, incoming, stored);
    if (!r.touched) return { ok: true, touched: false };
    return { ok: true, touched: true, value: r.value || undefined };
  } catch (error) {
    if (!isModelUnavailableError(error)) throw error;
    const display = typeof agentModeService.getModelDisplayName === 'function'
      ? agentModeService.getModelDisplayName(error.requestedModel)
      : undefined;
    return { ok: false, body: buildModelUnavailableBody(error, display, 'work_plan_pin') };
  }
}
