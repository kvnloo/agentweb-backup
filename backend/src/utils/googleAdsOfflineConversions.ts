/**
 * Pure rules for Google Ads offline conversion import (ENG-1325).
 *
 * Kept out of `googleAdsService` for the same reason as `googleAdsConversionActions.ts`:
 * these are the rules that decide whether an upload is well-formed, and they should be
 * provable without a network boundary or a mocked service.
 *
 * Why this path exists at all: browser-side tracking only records what happens on the
 * page. A booking that confirms later, a CRM qualification, a closed deal — those reach
 * Google ONLY through offline import keyed on gclid. Without it smart bidding optimises
 * toward form submits, and it will faithfully buy more of whatever it can see, so an
 * account with browser-only tracking bids systematically toward the cheapest low-intent
 * leads.
 */

export interface ClickConversionInput {
  /** The click id captured at first touch and persisted on the lead. */
  gclid: string;
  /** Full resource name — an offline import must name the action it counts against. */
  conversionActionResourceName: string;
  /** When the conversion actually happened, not when we noticed. */
  conversionAt: Date;
  /** The ACCOUNT's time zone. Google interprets the timestamp in it. */
  timeZone: string;
  value?: number;
  currencyCode?: string;
  /**
   * The same key the browser conversion sends as `transaction_id` (ENG-1328). Google
   * deduplicates an uploaded conversion against a web conversion carrying the same
   * value, which is what stops one lead counting twice across the two channels.
   */
  orderId?: string;
}

/**
 * Render a timestamp the way the Google Ads API demands: `yyyy-mm-dd hh:mm:ss+hh:mm`,
 * in the account's own time zone.
 *
 * An ISO 8601 string is rejected. So is a `Z` suffix, and so are milliseconds. The
 * rejection names the field and not the reason, so getting this wrong costs a debugging
 * session rather than producing an obvious error — which is exactly why it is a pure
 * function with its own tests rather than an inline `toISOString()` call.
 */
export function formatConversionDateTime(at: Date, timeZone: string): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new Error('conversionAt must be a valid date.');
  }

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    // Never fall back to UTC. A silent fallback shifts every conversion by the account's
    // real offset, and the only symptom is conversions landing on the wrong day.
    throw new Error(`Unknown time zone "${timeZone}" — cannot place the conversion in the account's local time.`);
  }

  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const stamp = `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
  return `${stamp}${offsetFor(at, timeZone)}`;
}

/** The zone's UTC offset at that instant, as `+hh:mm` — DST-correct because it is sampled at `at`. */
function offsetFor(at: Date, timeZone: string): string {
  const asZone = new Date(at.toLocaleString('en-US', { timeZone }));
  const asUtc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
  const minutes = Math.round((asZone.getTime() - asUtc.getTime()) / 60000);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Build one ClickConversion, refusing anything Google would reject.
 *
 * Refusing locally matters more here than elsewhere: an upload runs long after the lead
 * was captured, often from a background sweep with nobody watching, so a rejected batch
 * is discovered as "conversions never appeared" days later.
 */
export function buildClickConversion(input: ClickConversionInput): Record<string, unknown> {
  if (!input?.gclid?.trim()) {
    throw new Error('gclid is required — without a click id there is nothing to attribute the conversion to.');
  }
  const action = input.conversionActionResourceName?.trim();
  if (!action) {
    throw new Error('conversionActionResourceName is required — an offline conversion must name the action it counts against.');
  }
  if (!/^customers\/\d+\/conversionActions\/\d+$/.test(action)) {
    throw new Error(
      `conversionActionResourceName must be a full resource name like `
      + `customers/1234567890/conversionActions/987654321, not ${JSON.stringify(input.conversionActionResourceName)}.`,
    );
  }
  if (input.conversionAt instanceof Date && input.conversionAt.getTime() > Date.now()) {
    // Google rejects these, and in practice a future-dated conversion means a time zone
    // bug rather than a real event — worth naming so it is not read as a transient error.
    throw new Error('conversionAt is in the future — Google rejects these, and it usually means a time zone bug rather than a real conversion.');
  }
  if (input.value !== undefined) {
    if (input.value < 0) throw new Error('conversion value cannot be negative.');
    if (!input.currencyCode?.trim()) {
      // Without one Google assumes the account currency, quietly misstating revenue for
      // any account that does not use it.
      throw new Error('currencyCode is required whenever a conversion value is supplied.');
    }
  }

  const conversion: Record<string, unknown> = {
    gclid: input.gclid.trim(),
    conversionAction: action,
    conversionDateTime: formatConversionDateTime(input.conversionAt, input.timeZone),
  };
  if (input.value !== undefined) {
    conversion.conversionValue = input.value;
    conversion.currencyCode = input.currencyCode!.trim().toUpperCase();
  }
  // Omitted rather than sent empty: an empty orderId is not a dedup key, and sending one
  // would let a browser conversion and this upload both count.
  if (input.orderId?.trim()) conversion.orderId = input.orderId.trim();
  return conversion;
}

export interface ConversionUploadFailure {
  /** Index of the failing conversion in the submitted batch, or -1 when Google did not say. */
  index: number;
  errorCode?: string;
  message: string;
}

/**
 * Pull the per-row failures out of a partial-failure response.
 *
 * `partialFailure` is enabled deliberately: a batch of fifty where one gclid has expired
 * should upload forty-nine, not zero. That only helps if the caller can see WHICH row
 * failed — otherwise the batch reports success and some conversions silently never
 * arrive, which is indistinguishable from the tracking gap this feature exists to close.
 */
export function summarizePartialFailure(response: any): ConversionUploadFailure[] {
  const details = response?.partialFailureError?.details;
  if (!Array.isArray(details)) return [];

  const failures: ConversionUploadFailure[] = [];
  for (const detail of details) {
    for (const err of Array.isArray(detail?.errors) ? detail.errors : []) {
      const field = (err?.location?.fieldPathElements || [])
        .find((f: any) => f?.fieldName === 'conversions');
      failures.push({
        // -1 rather than 0 when Google does not say: guessing zero blames the first
        // conversion for another row's failure.
        index: typeof field?.index === 'number' ? field.index : -1,
        errorCode: err?.errorCode && typeof err.errorCode === 'object'
          ? (Object.values(err.errorCode)[0] as string | undefined)
          : undefined,
        message: err?.message ?? 'Unknown conversion upload error.',
      });
    }
  }
  return failures;
}
