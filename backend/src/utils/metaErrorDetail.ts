/**
 * Meta's error detail, in one line, for any shape a failed Graph/SDK call arrives in.
 *
 * Meta's top-level `message` is often just "Invalid parameter"; the field that is wrong is only
 * named in error_user_title / error_user_msg / error_subcode. Results that carried only
 * `error.message` gave the caller nothing to act on, so every Meta failure that reaches a tool
 * result goes through here.
 *
 * Shapes handled: handleError's `structuredError`, the SDK's FacebookRequestError (`response` is
 * the Graph error body), an axios error (`response.data.error`), our re-thrown `metaError`, and a
 * bare Graph error body.
 */
export interface MetaErrorFields {
  message?: string;
  code?: number | string;
  error_subcode?: number | string;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object';

function pick(source: any): MetaErrorFields | null {
  if (!isObject(source)) return null;
  const fields: MetaErrorFields = {};
  for (const key of ['message', 'code', 'error_subcode', 'error_user_title', 'error_user_msg', 'fbtrace_id'] as const) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') (fields as any)[key] = value;
  }
  return Object.keys(fields).length ? fields : null;
}

/** Meta's error fields from a thrown error or error body; null when none are present. */
export function metaErrorFields(error: unknown): MetaErrorFields | null {
  if (!isObject(error)) return null;
  const candidates = [
    error.structuredError,
    error.metaError,
    error.response?.data?.error,
    // FacebookRequestError: `response` is the Graph error body itself.
    isObject(error.response) && ('error_subcode' in error.response || 'fbtrace_id' in error.response || 'error_user_msg' in error.response || 'code' in error.response)
      ? error.response
      : undefined,
    error.error,
    'error_subcode' in error || 'fbtrace_id' in error || 'error_user_msg' in error ? error : undefined,
  ];
  let merged: MetaErrorFields | null = null;
  for (const candidate of candidates) {
    const fields = pick(candidate);
    if (fields) merged = { ...fields, ...(merged ?? {}) };
  }
  if (!merged) return null;
  // Keep a structured detail only when it carries more than a bare message.
  return Object.keys(merged).some((k) => k !== 'message') ? merged : null;
}

/**
 * "Invalid parameter — <title>: <user message> (code 100, subcode 1885183, fbtrace_id X)".
 * Falls back to the error's own message when no Meta fields are present.
 */
export function describeMetaError(error: unknown, fallback = 'Meta request failed.'): string {
  const fields = metaErrorFields(error);
  const own = isObject(error) && typeof error.message === 'string' ? error.message : typeof error === 'string' ? error : '';
  if (!fields) return own || fallback;
  const head = String(fields.message || own || fallback);
  const user = [fields.error_user_title, fields.error_user_msg].filter((s) => s && !head.includes(String(s))).join(': ');
  const ids = [
    fields.code !== undefined ? `code ${fields.code}` : '',
    fields.error_subcode !== undefined ? `subcode ${fields.error_subcode}` : '',
    fields.fbtrace_id ? `fbtrace_id ${fields.fbtrace_id}` : '',
  ].filter(Boolean).join(', ');
  return `${head}${user ? ` — ${user}` : ''}${ids ? ` (${ids})` : ''}`;
}
