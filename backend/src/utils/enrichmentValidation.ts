/**
 * Input bounds for user-controlled enrichment payloads.
 *
 * These caps are deliberate guardrails against:
 *   - prompt-injection via unbounded `instruction` strings,
 *   - cost runaways via huge `outputFields` arrays (each field ≈ one LLM call),
 *   - field-name collisions with reserved DB attributes,
 *   - injection of unsafe characters into prompt templates.
 *
 * A request that violates a cap should be rejected with HTTP 400 by the route.
 */

export const MAX_INSTRUCTION_CHARS = 4000;
export const MAX_TEMPLATE_CHARS = 1000;
export const MAX_GOAL_CHARS = 2000;
export const MAX_OUTPUT_FIELDS = 50;
export const MAX_FIELD_NAME_CHARS = 64;
export const MAX_FIELD_DESCRIPTION_CHARS = 300;

// Field names share storage with built-in lead attributes; reserve those names
// so a malicious or careless caller can't overwrite `email` / `customFields`
// / metadata blobs via the enrichment pipeline.
export const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set([
  'email', 'firstName', 'lastName', 'company', 'phone', 'title',
  'linkedin', 'notes', 'status', 'dealValue', 'dealCurrency',
  'createdAt', 'updatedAt', 'leadId', 'listId', 'userId',
  'customFields', 'enrichmentMetadata', 'enrichmentData',
  'syncMetadata', 'engagements', '__proto__', 'constructor', 'prototype',
]);

const FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const ALLOWED_SOURCES = new Set(['web_search', 'linkedin', 'existing_data']);

export class EnrichmentInputError extends Error {
  status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = 'EnrichmentInputError';
  }
}

/** Throws EnrichmentInputError if `name` isn't a safe field name. */
export function validateFieldName(name: unknown, label = 'field'): string {
  if (typeof name !== 'string') {
    throw new EnrichmentInputError(`${label} must be a string`);
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw new EnrichmentInputError(`${label} is required`);
  }
  if (trimmed.length > MAX_FIELD_NAME_CHARS) {
    throw new EnrichmentInputError(`${label} exceeds ${MAX_FIELD_NAME_CHARS} chars`);
  }
  if (!FIELD_NAME_RE.test(trimmed)) {
    throw new EnrichmentInputError(`${label} "${trimmed}" must match ${FIELD_NAME_RE}`);
  }
  if (RESERVED_FIELD_NAMES.has(trimmed)) {
    throw new EnrichmentInputError(`${label} "${trimmed}" is reserved`);
  }
  return trimmed;
}

export function validateOutputFields(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new EnrichmentInputError('outputFields must be an array');
  }
  if (raw.length === 0) {
    throw new EnrichmentInputError('outputFields cannot be empty');
  }
  if (raw.length > MAX_OUTPUT_FIELDS) {
    throw new EnrichmentInputError(`outputFields exceeds max of ${MAX_OUTPUT_FIELDS}`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    const name = validateFieldName(v, 'outputFields[]');
    if (seen.has(name)) continue; // dedup silently
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function validateInstruction(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') {
    throw new EnrichmentInputError('instruction must be a string');
  }
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  if (trimmed.length > MAX_INSTRUCTION_CHARS) {
    throw new EnrichmentInputError(`instruction exceeds ${MAX_INSTRUCTION_CHARS} chars`);
  }
  return trimmed;
}

export function validateOptionalTemplate(raw: unknown, label: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new EnrichmentInputError(`${label} must be a string`);
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_TEMPLATE_CHARS) {
    throw new EnrichmentInputError(`${label} exceeds ${MAX_TEMPLATE_CHARS} chars`);
  }
  return trimmed;
}

export function validateSources(raw: unknown, fallback: string[] = ['web_search']): string[] {
  if (raw === undefined || raw === null) return fallback;
  if (!Array.isArray(raw) || raw.length === 0) return fallback;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !ALLOWED_SOURCES.has(v)) {
      throw new EnrichmentInputError(`sources contains invalid value "${String(v)}"`);
    }
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Validate the per-field source map. Keys must be valid field names; values
 * must be valid source arrays. Returns the normalized map or undefined.
 *
 * Lenient on key shape: keys that don't match the field-name rules (reserved
 * standard-attribute names, malformed strings) are silently dropped rather
 * than rejected. The map is auxiliary — only outputFields entries actually
 * drive enrichment, so extra/stale keys are no-ops. Hard validation stays on
 * outputFields. Source values, however, are still strictly validated.
 */
export function validateSourcesPerField(raw: unknown): Record<string, string[]> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EnrichmentInputError('sourcesPerField must be an object');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_OUTPUT_FIELDS) {
    throw new EnrichmentInputError(`sourcesPerField exceeds max of ${MAX_OUTPUT_FIELDS} fields`);
  }
  const out: Record<string, string[]> = {};
  for (const [key, value] of entries) {
    let name: string;
    try {
      name = validateFieldName(key, 'sourcesPerField key');
    } catch {
      // Silently drop invalid/reserved keys — stale config from a prior session
      // shouldn't break the request. The matching outputFields entry (if any)
      // is what drives enrichment, and that path validates strictly.
      continue;
    }
    out[name] = validateSources(value);
  }
  return out;
}

/**
 * Validate the per-field descriptions map. Keys must be valid field names;
 * values must be non-empty strings under MAX_FIELD_DESCRIPTION_CHARS. Used by
 * the cluster service to build per-field web search queries for ungrouped
 * fields. Returns the normalized map or undefined.
 */
export function validateFieldDescriptions(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EnrichmentInputError('fieldDescriptions must be an object');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_OUTPUT_FIELDS) {
    throw new EnrichmentInputError(`fieldDescriptions exceeds max of ${MAX_OUTPUT_FIELDS} fields`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    // Lenient on keys (auxiliary map): drop reserved/invalid silently rather
    // than rejecting the whole request. Stale config or LLM suggestions can
    // include standard-attribute names; ignoring is safer than 400-ing.
    let name: string;
    try {
      name = validateFieldName(key, 'fieldDescriptions key');
    } catch {
      continue;
    }
    if (typeof value !== 'string') {
      throw new EnrichmentInputError(`fieldDescriptions["${name}"] must be a string`);
    }
    const trimmed = value.trim();
    if (!trimmed) continue; // empty descriptions silently dropped
    if (trimmed.length > MAX_FIELD_DESCRIPTION_CHARS) {
      throw new EnrichmentInputError(
        `fieldDescriptions["${name}"] exceeds ${MAX_FIELD_DESCRIPTION_CHARS} chars`
      );
    }
    out[name] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function validateGoal(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new EnrichmentInputError('goal is required');
  }
  const trimmed = raw.trim();
  if (!trimmed) throw new EnrichmentInputError('goal is required');
  if (trimmed.length > MAX_GOAL_CHARS) {
    throw new EnrichmentInputError(`goal exceeds ${MAX_GOAL_CHARS} chars`);
  }
  return trimmed;
}
