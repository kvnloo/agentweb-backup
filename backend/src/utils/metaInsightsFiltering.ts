/**
 * Meta Insights request/response shaping (ENG-630).
 *
 * Two pure helpers, no I/O and no clock, so both are exhaustively unit-testable
 * without touching Meta — which matters because OPS-79 means our own connection
 * cannot currently make a live Insights call at all.
 *
 * 1. `normalizeMetaInsightsFiltering` — the Graph API requires `filtering` to be
 *    a LIST of filter objects. The model that calls `call_meta_ads_insights_api`
 *    routinely emits it as a bare object or as pre-serialized JSON text instead,
 *    which produced two different production failures:
 *      - a JSON string has a truthy `.length`, so it went to Meta as a string and
 *        came back `(#100) param filtering must be an array`;
 *      - a bare object has NO `.length`, so the old `filtering?.length &&` guard
 *        dropped the key silently and Meta returned whole-account rows that read
 *        to the model as campaign-scoped. A wrong answer is worse than an error.
 *    Anything we cannot faithfully convert throws rather than being dropped.
 *
 * 2. `describeMetaGraphApiError` — an axios rejection stringifies to
 *    "Request failed with status code 400", which tells the model nothing it can
 *    act on. Meta's real explanation lives in `response.data.error`. We surface
 *    it, minus the credential material Meta echoes back.
 */

/** Filter operators the Graph API accepts on an insights query. */
const ALLOWED_FILTER_OPERATORS = [
  'EQUAL',
  'NOT_EQUAL',
  'GREATER_THAN',
  'GREATER_THAN_OR_EQUAL',
  'LESS_THAN',
  'LESS_THAN_OR_EQUAL',
  'IN',
  'NOT_IN',
  'CONTAIN',
  'NOT_CONTAIN',
  'STARTS_WITH',
  'ANY',
  'ALL',
  'NONE',
] as const;

/** Operators whose `value` Meta requires to be a list. */
const LIST_VALUED_OPERATORS = new Set(['IN', 'NOT_IN', 'ANY', 'ALL', 'NONE']);

export interface MetaInsightsFilter {
  field: string;
  operator: string;
  value: unknown;
}

/**
 * Raised when a caller-supplied `filtering` argument cannot be turned into a
 * shape Meta accepts. Distinct class so the caller can tell "your filter is
 * wrong" apart from "Meta rejected the call".
 */
export class MetaInsightsFilteringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaInsightsFilteringError';
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Coerce whatever the caller supplied into the array of filter objects the Meta
 * Insights API expects.
 *
 * Returns `undefined` when there is genuinely nothing to filter on, so the
 * caller can omit the parameter entirely rather than sending an empty list.
 *
 * @throws {MetaInsightsFilteringError} when the input names a filter we cannot
 *   honour. Never returns `undefined` for a filter the caller meant to apply —
 *   silently widening the query is the failure mode this exists to prevent.
 */
export function normalizeMetaInsightsFiltering(
  raw: unknown
): MetaInsightsFilter[] | undefined {
  if (raw === undefined || raw === null) return undefined;

  let candidate: unknown = raw;

  // The model sometimes hands us the JSON text instead of the value.
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (!trimmed) return undefined;

    try {
      candidate = JSON.parse(trimmed);
    } catch {
      throw new MetaInsightsFilteringError(
        'The `filtering` argument was a string that could not be parsed as JSON. ' +
          'Pass an array of {field, operator, value} objects.'
      );
    }
  }

  if (isPlainObject(candidate)) candidate = [candidate];

  if (!Array.isArray(candidate)) {
    throw new MetaInsightsFilteringError(
      'The `filtering` argument must be an array of {field, operator, value} objects ' +
        `(received ${typeof candidate}).`
    );
  }

  // Index against the caller's original array so error messages point at the
  // entry they actually wrote.
  const normalized: MetaInsightsFilter[] = [];
  candidate.forEach((entry, index) => {
    if (entry === null || entry === undefined) return;
    normalized.push(normalizeFilterEntry(entry, index));
  });

  return normalized.length ? normalized : undefined;
}

function normalizeFilterEntry(entry: unknown, index: number): MetaInsightsFilter {
  const at = `filtering[index ${index}]`;

  if (!isPlainObject(entry)) {
    throw new MetaInsightsFilteringError(
      `${at} must be an object with field, operator and value.`
    );
  }

  const { field, operator, value } = entry as Record<string, unknown>;

  if (typeof field !== 'string' || !field.trim()) {
    throw new MetaInsightsFilteringError(`${at} is missing a non-empty \`field\`.`);
  }
  if (typeof operator !== 'string' || !operator.trim()) {
    throw new MetaInsightsFilteringError(`${at} is missing a non-empty \`operator\`.`);
  }
  if (value === undefined || value === null) {
    throw new MetaInsightsFilteringError(`${at} is missing a \`value\`.`);
  }

  const upperOperator = operator.trim().toUpperCase();
  if (!(ALLOWED_FILTER_OPERATORS as readonly string[]).includes(upperOperator)) {
    throw new MetaInsightsFilteringError(
      `${at} uses unsupported operator "${operator}". Allowed: ${ALLOWED_FILTER_OPERATORS.join(', ')}.`
    );
  }

  let normalizedValue: unknown = value;
  if (LIST_VALUED_OPERATORS.has(upperOperator)) {
    // A scalar under IN/NOT_IN is the same shape defect one level down.
    normalizedValue = Array.isArray(value) ? [...value] : [value];
    if ((normalizedValue as unknown[]).length === 0) {
      // An empty list matches nothing, so Meta would return a clean, empty
      // report for a question the user really did ask.
      throw new MetaInsightsFilteringError(
        `${at} uses ${upperOperator} with an empty list, which can never match. ` +
          'Supply at least one value or drop the filter.'
      );
    }
  }

  return { field: field.trim(), operator: upperOperator, value: normalizedValue };
}

/** Meta echoes credentials into error text; never pass one through verbatim. */
function redactSecrets(text: string): string {
  return text
    .replace(/access_token=[^&\s"']+/gi, 'access_token=[redacted]')
    .replace(/\bEAA[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract an actionable, sanitized description of a Meta Graph API failure.
 *
 * Returns `undefined` when the rejection carries no Graph error envelope (a
 * socket hang-up, a bug in our own code), so the caller keeps its own message
 * rather than reporting a misleading Meta explanation.
 */
export function describeMetaGraphApiError(error: unknown): string | undefined {
  const graphError = (error as any)?.response?.data?.error;
  if (!isPlainObject(graphError)) return undefined;

  const { message, error_user_title, error_user_msg, code, error_subcode, type } =
    graphError as Record<string, unknown>;

  const parts: string[] = [];

  const codeBits: string[] = [];
  if (code !== undefined && code !== null) codeBits.push(`code ${code}`);
  if (error_subcode !== undefined && error_subcode !== null) {
    codeBits.push(`subcode ${error_subcode}`);
  }
  if (typeof type === 'string' && type.trim()) codeBits.push(type.trim());

  if (typeof message === 'string' && message.trim()) parts.push(message.trim());
  if (typeof error_user_title === 'string' && error_user_title.trim()) {
    parts.push(error_user_title.trim());
  }
  if (typeof error_user_msg === 'string' && error_user_msg.trim()) {
    parts.push(error_user_msg.trim());
  }

  // No usable text means nothing actionable to add over the caller's message.
  if (!parts.length) return undefined;

  const suffix = codeBits.length ? ` (${codeBits.join(', ')})` : '';
  return redactSecrets(`Meta API error${suffix}: ${parts.join(' — ')}`);
}
