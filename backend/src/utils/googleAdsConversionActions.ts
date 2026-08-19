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
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      drift.push({ field, requested: want, stored: got });
    }
  }
  return drift;
}
