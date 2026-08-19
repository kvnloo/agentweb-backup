/**
 * Pure helpers for Google Ads conversion actions (ENG-1322).
 *
 * Kept out of `googleAdsService` deliberately, mirroring `pixelInjection.ts` and
 * `gtmInjection.ts`: these are the rules that decide whether a create is safe and
 * whether what Google stored is what we asked for, and they should be provable
 * without a network boundary or a mocked service.
 *
 * Scope is CREATE / LIST / UPDATE. REMOVE is intentionally not implemented
 * (Harsha, ENG-1329): removing a conversion action severs historical attribution in
 * the customer's account, and it is the one operation whose damage we cannot undo
 * from our side. Pausing via UPDATE covers what an operator actually needs.
 */

/** The only two values Google accepts, and the only two we will send. */
export const COUNTING_TYPES = ['ONE_PER_CLICK', 'MANY_PER_CLICK'] as const;
export type CountingType = (typeof COUNTING_TYPES)[number];

/**
 * Require an explicit counting type. Never infer one.
 *
 * This is the field whose wrong value fails silently: `MANY_PER_CLICK` on a lead
 * form counts every repeat submission, the reported conversion number inflates,
 * smart bidding optimises toward it, and nothing errors. By the time anyone
 * notices, the spend is gone. A default would make that choice on the customer's
 * behalf, so an absent value is refused with both options and their consequence.
 */
export function assertCountingType(value: unknown): CountingType {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      'counting_type is required and is never inferred. Pass ONE_PER_CLICK to count one ' +
      'conversion per ad click (correct for lead forms and sign-ups), or MANY_PER_CLICK to ' +
      'count every conversion (correct for purchases). Choosing wrong inflates reported ' +
      'conversions and silently misdirects smart bidding — nothing will error.',
    );
  }
  const normalised = value.trim().toUpperCase() as CountingType;
  if (!COUNTING_TYPES.includes(normalised)) {
    throw new Error(
      `Unrecognised counting_type "${value}". Supported values: ${COUNTING_TYPES.join(', ')}.`,
    );
  }
  return normalised;
}

/**
 * The only values Google's ConversionActionStatus defines. There is no PAUSED.
 *
 * Found by the ENG-1329 end-to-end against a real account, not by review: CREATE with
 * status PAUSED came back a bare 400, and Google's own body named the cause —
 *   Invalid value at 'operations[0].create.status'
 *   (ConversionActionStatusEnum.ConversionActionStatus), "PAUSED"
 *
 * PAUSED is a CAMPAIGN status. Assuming the two enums line up is the natural mistake, and
 * the ENG-1329 verification plan made it as well. HIDDEN is the value people actually
 * want: the action stops appearing in the UI's list and stops counting toward goals,
 * without severing history the way REMOVE does.
 */
export const CONVERSION_ACTION_STATUSES = ['ENABLED', 'REMOVED', 'HIDDEN'] as const;
export type ConversionActionStatus = (typeof CONVERSION_ACTION_STATUSES)[number];

/**
 * Validate a conversion action status before it reaches Google.
 *
 * Same discipline as `assertCountingType`, applied for a different reason. A wrong
 * counting_type fails SILENTLY, so it must never be inferred. A wrong status fails
 * LOUDLY — but as an opaque 400 that names no field unless you read the server log, so
 * the caller is left guessing at exactly the moment they need telling.
 */
export function assertConversionActionStatus(value: unknown): ConversionActionStatus {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `status must be one of ${CONVERSION_ACTION_STATUSES.join(', ')}.`,
    );
  }
  // Compared as a plain string before the cast: narrowing it to the union first makes
  // the PAUSED check look like dead code to the compiler, when PAUSED is exactly the
  // value a caller is most likely to send.
  const normalised = value.trim().toUpperCase();
  if (!(CONVERSION_ACTION_STATUSES as readonly string[]).includes(normalised)) {
    if (normalised === 'PAUSED') {
      throw new Error(
        'A conversion action cannot be PAUSED — that is a campaign status, and Google\'s '
        + 'ConversionActionStatus does not define it. Use HIDDEN to stop it counting toward '
        + 'goals and drop it from the UI list while keeping its history, or REMOVED to retire '
        + 'it permanently (which severs historical attribution and cannot be undone).',
      );
    }
    throw new Error(
      `Unrecognised conversion action status "${value}". Supported values: `
      + `${CONVERSION_ACTION_STATUSES.join(', ')}.`,
    );
  }
  return normalised as ConversionActionStatus;
}

/**
 * Turn a Google Ads API failure into something the caller can act on.
 *
 * The REST API answers a bad field with a 400 whose BODY names the exact field and why —
 * but axios's own `message` is only "Request failed with status code 400". `callApi`
 * logged the body and rethrew the raw error, so that detail reached the server log and
 * nothing else. An operator saw an opaque 400 precisely when Google had already told us
 * which argument was wrong.
 *
 * Reads ONLY the response body. Never the error object at large: axios attaches the full
 * request config, headers included, so serialising the whole error would push request
 * details into logs and API responses that have no business being there.
 */
export function describeGoogleAdsError(err: any): string {
  const error = err?.response?.data?.error;
  if (!error) return String(err?.message || 'Google Ads API request failed.');

  const parts: string[] = [];
  if (error.status) parts.push(String(error.status));
  if (error.message) parts.push(String(error.message));

  const violations: string[] = [];
  for (const detail of Array.isArray(error.details) ? error.details : []) {
    for (const v of Array.isArray(detail?.fieldViolations) ? detail.fieldViolations : []) {
      if (v?.field) violations.push(`${v.field}: ${v.description ?? 'invalid'}`);
    }
  }
  if (violations.length > 0) parts.push(violations.join('; '));

  return parts.join(' — ') || String(err?.message || 'Google Ads API request failed.');
}

export interface ConversionTagPair {
  /** The `AW-…` half — the Google tag id that goes in the page's base snippet. */
  conversionId: string;
  /** The half after the slash — identifies WHICH conversion action fired. */
  conversionLabel: string;
  /** Both, exactly as they appear in `send_to`. */
  sendTo: string;
}

/**
 * Pull the `AW-<id>/<label>` pair out of a conversion action's tag snippets.
 *
 * This is the whole point of the create returning something useful: a resource name
 * cannot be installed on a page. Without this pair the caller still has to open the
 * Google Ads UI and copy it by hand, which is the gap ENG-1322 exists to close.
 *
 * Returns null rather than guessing. A freshly created action can be read back
 * before Google has generated its snippets, and an AMP variant carries the tag id
 * without a parseable `send_to` — reporting "not available yet" is honest; a
 * half-parsed pair would install tracking that never matches any conversion action.
 */
export interface ConversionTagSnippet {
  /** WEBPAGE | WEBPAGE_ONCLICK — which install shape this snippet is for. */
  type?: string;
  /** HTML | AMP — the AMP variant carries the tag id but no parseable send_to. */
  pageFormat?: string;
  eventSnippet?: string;
  globalSiteTag?: string;
}

export function parseTagSnippets(
  snippets: ConversionTagSnippet[] | undefined | null,
): ConversionTagPair | null {
  if (!Array.isArray(snippets)) return null;

  for (const snippet of snippets) {
    const source = snippet?.eventSnippet;
    if (typeof source !== 'string') continue;
    // The label group is one-or-more, so a match cannot yield an empty label —
    // `AW-123/` simply fails to match and falls through to the next snippet.
    const match = source.match(/['"]?send_to['"]?\s*:\s*['"](AW-[0-9]+)\/([^'"\s]+)['"]/);
    if (!match) continue;
    const [, conversionId, conversionLabel] = match;
    return { conversionId, conversionLabel, sendTo: `${conversionId}/${conversionLabel}` };
  }
  return null;
}

export interface ConversionActionDrift {
  field: string;
  requested: unknown;
  stored: unknown;
}

/**
 * Compare what we asked Google to store against what it actually stored.
 *
 * Not paranoia — precedent. `createAdGroup` and `createAd` hardcode
 * `status: 'ENABLED'` (ENG-1293), so a PAUSED request returns success and stores
 * ENABLED. During the ENG-1182 run two of five deployed objects drifted exactly
 * that way, and only a read-back caught it.
 *
 * Only fields the caller actually requested are compared. Google fills in many it
 * was never asked about, and reporting those as drift would bury the real signal.
 * A field that is missing from the stored record counts as drift, not as a match —
 * absent is not the same as equal.
 */
export function diffConversionAction(
  requested: Record<string, unknown>,
  stored: Record<string, unknown>,
): ConversionActionDrift[] {
  const drift: ConversionActionDrift[] = [];
  for (const [field, want] of Object.entries(requested)) {
    if (want === undefined) continue;
    const got = stored?.[field];
    if (!storedMatchesRequested(want, got)) {
      drift.push({ field, requested: want, stored: got });
    }
  }
  return drift;
}

/** A JSON number, exactly — no blank, no whitespace, no `0x`, no `Infinity`. */
const NUMERIC_STRING = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/**
 * Decide whether what Google stored is what we asked for.
 *
 * Identity is right for every field here but one. Google Ads serialises INT64 as a
 * JSON string — this service already relies on that elsewhere: `createBudget` sends
 * `amountMicros: String(...)`, `listBudgets` types the read-back as string, and
 * both listCampaigns and listBiddingStrategies wrap the INT64 `id` in String().
 * `clickThroughLookbackWindowDays` is INT64, so a requested 90 reads back as "90"
 * and a strict compare called a perfectly-stored write drift. A false alarm on the
 * drift check is worse than no check: it teaches the operator to ignore it.
 *
 * So the loosening is deliberately narrow — a requested NUMBER against a stored
 * canonical numeric STRING, and nothing else. Everything JS would otherwise call
 * equal stays drift: '' is not 0, true is not 1, and an absent field is still
 * absent rather than silently equal.
 */
function storedMatchesRequested(want: unknown, got: unknown): boolean {
  if (typeof want === 'number' && typeof got === 'string' && NUMERIC_STRING.test(got)) {
    return Number(got) === want;
  }
  return JSON.stringify(got) === JSON.stringify(want);
}
