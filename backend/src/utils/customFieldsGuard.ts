/**
 * Guard utilities for CRM lead `customFields`.
 *
 * Prevents the char-indexed corruption pattern (e.g. `{"0":"{","1":"\"",…}`)
 * that arises when a code path object-spreads a string into customFields.
 * Detection rule: anything that is not a plain `Object.prototype`-prototyped
 * object is coerced to `{}` and logged via console.error with a stack trace.
 * Never throws — corruption recovery is intentionally silent so writes
 * proceed and the upstream bug source is identifiable from logs.
 *
 * Non-goals: no read-time auto-heal of already-corrupted DDB rows; no
 * JSON-recovery attempts; no env-dependent behavior.
 */

export type LogContext = {
  source: string;
  listId?: string;
  leadId?: string;
};

export function isPlainCustomFieldsObject(v: unknown): v is Record<string, any> {
  if (v === null || v === undefined) return false;
  if (typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  return Object.getPrototypeOf(v) === Object.prototype;
}

export function sanitizeCustomFields(
  v: unknown,
  ctx: LogContext,
): Record<string, any> {
  if (isPlainCustomFieldsObject(v)) return v;
  console.error('[customFieldsGuard] non-object customFields coerced to {}', {
    source: ctx.source,
    listId: ctx.listId,
    leadId: ctx.leadId,
    type: typeof v,
    isArray: Array.isArray(v),
    stack: new Error().stack,
  });
  return {};
}

export function mergeCustomFields(
  existing: unknown,
  patch: unknown,
  ctx: LogContext,
): Record<string, any> {
  return {
    ...sanitizeCustomFields(existing, ctx),
    ...sanitizeCustomFields(patch, ctx),
  };
}
