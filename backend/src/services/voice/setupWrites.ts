/**
 * Conditional-write helpers for the system-managed hot-lead-call org attributes (verification and number
 * provisioning). Every write to those attributes is "only if nobody changed what I just read", so two
 * racing requests cannot both win.
 */

interface UpdateCondition {
  expression: string;
  names: Record<string, string>;
  values?: Record<string, unknown>;
}

/**
 * Requires each attribute to still equal what the caller read (absent stays absent). The aliases carry a
 * `previous` prefix on purpose: orgDb.updateOrg binds the new values as `:<attribute>` and merges these
 * after them, so an un-prefixed alias would silently overwrite the value being written.
 */
export function unchangedSince(reads: Record<string, unknown>): UpdateCondition {
  const clauses: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  for (const [attribute, previous] of Object.entries(reads)) {
    const alias = `previous${attribute[0].toUpperCase()}${attribute.slice(1)}`;
    names[`#${alias}`] = attribute;
    if (previous === undefined) {
      clauses.push(`attribute_not_exists(#${alias})`);
    } else {
      clauses.push(`#${alias} = :${alias}`);
      values[`:${alias}`] = previous;
    }
  }
  return { expression: clauses.join(' AND '), names, ...(Object.keys(values).length ? { values } : {}) };
}

/** The error's `code` when it has a string one (AWS SDK errors do), else undefined. */
export function errorCode(err: unknown): string | undefined {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

export function isConditionalFailure(err: unknown): boolean {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  return errorCode(err) === 'ConditionalCheckFailedException' || name === 'ConditionalCheckFailedException';
}
