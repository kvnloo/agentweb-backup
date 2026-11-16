import { supersession } from './agentMode/modelSupersession';
import { LLM_MODEL_REGISTRY, LEGACY_MODEL_ALIASES, type LLMModelConfig } from './agentMode/llmModelRegistry';
import { IMAGE_MODEL_IDS } from './imageModelRegistry';

export const MODEL_ROLES = ['chat', 'enrichment', 'image', 'embedding', 'scoring_judge', 'content_generation', 'research', 'voice'] as const;
export type ModelRole = typeof MODEL_ROLES[number];
export type ModelRoles = Partial<Record<ModelRole, string>>;
export type ModelCapability = 'text' | 'vision' | 'image-out' | 'embedding' | 'live-audio';

// Use the same dominance policy as the chat picker, without importing the service.
const successors = supersession(Object.entries(LLM_MODEL_REGISTRY)
  .filter(([, m]) => !m.isLive && !m.adminOnly && !m.internalOnly)
  .map(([id, m]) => ({ id, ...m })));

// Whether a text/live model can run the role at all. The picker additionally hides
// superseded and legacy models, which only steers new selections.
function llmCanRunRole(m: Readonly<LLMModelConfig>, role: ModelRole): boolean {
  return !m.adminOnly && !m.internalOnly &&
    (role === 'voice' ? m.isLive === true : !m.isLive) &&
    (role !== 'chat' && role !== 'research' || m.supportsTools !== false);
}

export function getRoleModelOptions(role: ModelRole): string[] {
  if (role === 'image') return IMAGE_MODEL_IDS.filter(id => !id.endsWith('-preview') || id === 'gemini-3-pro-image-preview');
  // Same dimensions alone do NOT make two embedding spaces compatible. Only the
  // existing OpenRouter model is selectable until a separate reindex migration exists.
  if (role === 'embedding') return ['openai/text-embedding-3-large'];
  const options = Object.entries(LLM_MODEL_REGISTRY).filter(([id, m]) =>
    !successors.has(id) && !m.legacy && llmCanRunRole(m, role),
  ).map(([id]) => id);
  // The role's own default is always a valid choice, even when the picker would hide it as
  // superseded. Otherwise an org cannot save the default (the PUT 400s) and an override of it
  // resolves to its successor (ENG-2720: gpt-5.6-luna -> gpt-6-luna).
  const roleDefault = FALLBACKS[role];
  return options.includes(roleDefault) || !canRunPersistedDefault(role, roleDefault) ? options : [...options, roleDefault];
}

// A persisted admin default is honoured even when the picker hides it (a legacy
// model, or the image preview alias), as long as the role can still run it.
function canonicalModelId(id: string): string {
  return Object.prototype.hasOwnProperty.call(LEGACY_MODEL_ALIASES, id) ? LEGACY_MODEL_ALIASES[id] : id;
}

function canRunPersistedDefault(role: ModelRole, rawId: string): boolean {
  // A stored default may hold a renamed model's old id; callLLM maps it forward, so judge the canonical id.
  const id = canonicalModelId(rawId);
  if (role === 'image') return (IMAGE_MODEL_IDS as readonly string[]).includes(id);
  if (role === 'embedding') return false; // Only the compatible space in getRoleModelOptions.
  // Own keys only: a setting value such as "constructor" must not match Object.prototype.
  return Object.prototype.hasOwnProperty.call(LLM_MODEL_REGISTRY, id) && llmCanRunRole(LLM_MODEL_REGISTRY[id], role);
}

export function modelCapabilities(id: string): ModelCapability[] {
  if ((IMAGE_MODEL_IDS as readonly string[]).includes(id)) return ['image-out'];
  if (getRoleModelOptions('embedding').includes(id)) return ['embedding'];
  const m = LLM_MODEL_REGISTRY[id];
  return !m ? [] : m.isLive ? ['live-audio'] : m.supportsVision ? ['text', 'vision'] : ['text'];
}

// enrichment ran on gpt-5-chat-2 (aliased to gpt-5.5) before model roles (ENG-2184). ENG-2720 moved
// it to gpt-5.6-luna for cost; the benchmark and its quality trade-offs are on that ticket. The picker
// may hide a superseded model, so the default is honoured through the same runnable check as a
// persisted default.
const FALLBACKS: Record<ModelRole, string> = {
  chat: 'gemini-3.8-flash', enrichment: 'openrouter/openai/gpt-5.6-luna',
  image: 'gemini-3-pro-image-preview', embedding: 'openai/text-embedding-3-large',
  scoring_judge: 'gemini-3.1-flash-lite', content_generation: 'gemini-3.8-flash',
  research: 'gemini-3.8-flash', voice: 'gemini-3.1-flash-live-preview',
};
const SETTING_KEYS: Partial<Record<ModelRole, readonly string[]>> = {
  chat: ['agent_mode_default_model'], image: ['agent_mode_image_api_default_model', 'default_image_model'],
  content_generation: ['agent_mode_content_model'], scoring_judge: ['default-scoring-model'],
};

export async function getRoleDefault(role: ModelRole): Promise<string> {
  // CRM_ENRICH_V3_DEFAULT_MODEL is the enrichment rollback: set it on the environment to move every
  // org without its own override back to e.g. gpt-5.5 without a code deploy. Unusable values fall
  // through to FALLBACKS below.
  const enrichmentOverride = role === 'enrichment' ? process.env.CRM_ENRICH_V3_DEFAULT_MODEL?.trim() : undefined;
  let candidate = role === 'embedding' ? getRoleModelOptions(role)[0] : enrichmentOverride || FALLBACKS[role];
  const keys = SETTING_KEYS[role];
  if (keys) {
    try {
      const { settingsService } = await import('./settingsService');
      for (const key of keys) {
        const value = (await settingsService.getSetting(key))?.settingValue;
        if (typeof value === 'string' && value.trim()) { candidate = value.trim(); break; }
      }
    } catch { console.warn(`[modelRoles] Default lookup unavailable for ${role}; using registry default`); }
  }
  candidate = canonicalModelId(candidate);
  const options = getRoleModelOptions(role);
  if (options.includes(candidate) || canRunPersistedDefault(role, candidate)) return candidate;
  if (options.includes(FALLBACKS[role])) return FALLBACKS[role];
  throw new Error(`No usable default for model role ${role}`);
}

export function sanitizeModelRoles(value: unknown): ModelRoles {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, v]) =>
    MODEL_ROLES.includes(key as ModelRole) && typeof v === 'string',
  ));
}

const cache = new Map<string, { expires: number; value: ModelRoles }>();
export function invalidateModelRoles(orgId: string): void { cache.delete(orgId); }

export async function resolveModelForRole(orgId: string | undefined, role: ModelRole): Promise<string> {
  let overrides: ModelRoles = {};
  if (orgId) {
    const cached = cache.get(orgId);
    if (cached && cached.expires > Date.now()) overrides = cached.value;
    else {
      const { orgDb } = await import('./db');
      try {
        overrides = sanitizeModelRoles((await orgDb.getOrgById(orgId, ['modelRoles']))?.modelRoles);
      } catch {
        console.warn('[modelRoles] Organization lookup unavailable; using role default');
        return getRoleDefault(role); // Never cache a transient storage failure.
      }
      if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
      cache.set(orgId, { expires: Date.now() + 15_000, value: overrides });
    }
  }
  const override = overrides[role];
  const options = getRoleModelOptions(role);
  if (override && options.includes(override)) return override;
  const successor = override && successors.get(override)?.find(id => options.includes(id));
  return successor || getRoleDefault(role);
}

// Membership is used only for model preferences, never as an authorization cache.
const memberships = new Map<string, { expires: number; orgId: string | undefined }>();
export async function resolveModelForUser(userId: string | undefined, role: ModelRole): Promise<string> {
  if (!userId) return resolveModelForRole(undefined, role);
  let membership = memberships.get(userId);
  if (!membership || membership.expires <= Date.now()) {
    const { userDb } = await import('./db');
    try {
      const user = await userDb.getUserById(userId);
      membership = { expires: Date.now() + 15_000, orgId: typeof user?.orgId === 'string' ? user.orgId : undefined };
      if (memberships.size >= 1000) memberships.delete(memberships.keys().next().value!);
      memberships.set(userId, membership);
    } catch {
      console.warn('[modelRoles] Membership lookup unavailable; using role default');
      return getRoleDefault(role);
    }
  }
  return resolveModelForRole(membership.orgId, role);
}
