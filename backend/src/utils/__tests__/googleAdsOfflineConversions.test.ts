/**
 * ENG-1325 — Google Ads offline conversion import.
 *
 * Failure paths first (Rule 2). The formatting rules here are the whole risk: Google
 * rejects a conversion whose datetime is a millisecond off the expected shape, and the
 * error it returns names a field, not a reason. Everything below is a pure function so
 * the rules are provable without a network boundary — the same reason
 * googleAdsConversionActions.ts exists.
 */
import {
  formatConversionDateTime,
  buildClickConversion,
  summarizePartialFailure,
} from '../googleAdsOfflineConversions';

const ACTION = 'customers/2883029950/conversionActions/7724987234';
const GCLID = 'Cj0KCQjw_ZeeBhDIARIsAJlCFountainOfClicks';

describe('formatConversionDateTime — Google will not accept an ISO string', () => {
  // The API wants "yyyy-mm-dd hh:mm:ss+hh:mm" in the ACCOUNT's time zone. An ISO 8601
  // string, a Z suffix, or milliseconds are all rejected — and the rejection names the
  // field, not the reason, so getting this wrong costs a debugging session.
  it('emits the exact shape Google documents', () => {
    const out = formatConversionDateTime(new Date('2026-08-20T07:04:05.000Z'), 'Asia/Calcutta');
    expect(out).toBe('2026-08-20 12:34:05+05:30');
  });

  it('never emits milliseconds', () => {
    expect(formatConversionDateTime(new Date('2026-08-20T07:04:05.123Z'), 'Asia/Calcutta'))
      .not.toMatch(/\.\d/);
  });

  it('never emits a Z suffix or a T separator', () => {
    const out = formatConversionDateTime(new Date('2026-08-20T07:04:05Z'), 'UTC');
    expect(out).not.toContain('T');
    expect(out).not.toContain('Z');
    expect(out).toBe('2026-08-20 07:04:05+00:00');
  });

  it('renders a negative offset with its sign', () => {
    expect(formatConversionDateTime(new Date('2026-08-20T16:00:00Z'), 'America/New_York'))
      .toBe('2026-08-20 12:00:00-04:00');
  });

  it('refuses an invalid date rather than emitting "Invalid Date"', () => {
    expect(() => formatConversionDateTime(new Date('nonsense'), 'UTC')).toThrow(/valid date/i);
  });

  it('refuses an unknown time zone rather than silently falling back to UTC', () => {
    // A silent fallback shifts every conversion by the account's real offset, which
    // reports as "conversions attributed to the wrong day" and nothing else.
    expect(() => formatConversionDateTime(new Date(), 'Mars/Olympus')).toThrow(/time zone/i);
  });
});

describe('buildClickConversion — refuses what Google would reject', () => {
  // Fixed and firmly in the past: a fixture dated 'today' starts failing the moment the
  // clock passes it, which is a brittle test rather than a real signal.
  const at = new Date('2026-06-15T07:04:05Z');
  const ok = { gclid: GCLID, conversionActionResourceName: ACTION, conversionAt: at, timeZone: 'Asia/Calcutta' };

  it('requires a gclid — without one there is no click to attribute', () => {
    expect(() => buildClickConversion({ ...ok, gclid: '' })).toThrow(/gclid/i);
  });

  it('requires a conversion action to upload against', () => {
    expect(() => buildClickConversion({ ...ok, conversionActionResourceName: '' })).toThrow(/conversionActionResourceName/i);
  });

  it('rejects a conversion action that is not a resource name', () => {
    expect(() => buildClickConversion({ ...ok, conversionActionResourceName: '7724987234' }))
      .toThrow(/customers\//);
  });

  it('refuses a conversion dated in the future', () => {
    // Google rejects these, and a future-dated upload usually means a timezone bug
    // rather than a real conversion.
    const future = new Date(Date.now() + 60 * 60 * 1000);
    expect(() => buildClickConversion({ ...ok, conversionAt: future })).toThrow(/future/i);
  });

  it('requires a currency when a value is given', () => {
    // A value without a currency is silently treated as the account currency, which
    // misstates revenue for any account that does not use it.
    expect(() => buildClickConversion({ ...ok, value: 500 })).toThrow(/currency/i);
  });

  it('refuses a negative value', () => {
    expect(() => buildClickConversion({ ...ok, value: -1, currencyCode: 'INR' })).toThrow(/negative/i);
  });

  it('builds the documented payload for a valid conversion', () => {
    expect(buildClickConversion(ok)).toEqual({
      gclid: GCLID,
      conversionAction: ACTION,
      conversionDateTime: '2026-06-15 12:34:05+05:30',
    });
  });

  it('carries value and currency when both are supplied', () => {
    expect(buildClickConversion({ ...ok, value: 500, currencyCode: 'inr' })).toMatchObject({
      conversionValue: 500,
      currencyCode: 'INR',
    });
  });

  it('carries orderId so a browser conversion and this upload cannot double-count', () => {
    // Same key the browser fires as transaction_id (ENG-1328). Google dedupes the pair.
    expect(buildClickConversion({ ...ok, orderId: 'evt-123' })).toMatchObject({ orderId: 'evt-123' });
  });

  it('omits orderId entirely rather than sending an empty one', () => {
    expect('orderId' in buildClickConversion({ ...ok, orderId: '' })).toBe(false);
  });

  it('accepts a zero value, which is a real conversion with no revenue', () => {
    expect(buildClickConversion({ ...ok, value: 0, currencyCode: 'INR' })).toMatchObject({ conversionValue: 0 });
  });
});

describe('summarizePartialFailure — one bad row must not hide the others', () => {
  // partialFailure is on deliberately: a batch of 50 where one gclid expired should
  // upload 49, not zero. That only helps if the caller can see which row failed.
  it('reports nothing when the response carries no partial failure', () => {
    expect(summarizePartialFailure({ results: [{}, {}] })).toEqual([]);
  });

  it('names the failing row index and its message', () => {
    const out = summarizePartialFailure({
      results: [{}, {}],
      partialFailureError: {
        details: [{
          '@type': 'type.googleapis.com/google.ads.googleads.v24.errors.GoogleAdsFailure',
          errors: [{
            message: 'The click is too old to be imported.',
            errorCode: { conversionUploadError: 'EXPIRED_CLICK' },
            location: { fieldPathElements: [{ fieldName: 'conversions', index: 1 }] },
          }],
        }],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ index: 1, errorCode: 'EXPIRED_CLICK' });
    expect(out[0].message).toMatch(/too old/);
  });

  it('survives a malformed partial failure rather than throwing inside the caller', () => {
    expect(summarizePartialFailure({ partialFailureError: { details: 'nope' } })).toEqual([]);
    expect(summarizePartialFailure({})).toEqual([]);
    expect(summarizePartialFailure(null)).toEqual([]);
  });

  it('reports a row with no index as index -1 rather than guessing zero', () => {
    // Guessing 0 would blame the first conversion for another row's failure.
    const out = summarizePartialFailure({
      partialFailureError: { details: [{ errors: [{ message: 'boom' }] }] },
    });
    expect(out[0].index).toBe(-1);
  });
});

describe('malformed input and responses must not throw inside a background sweep', () => {
  // This runs unattended. A throw here does not surface as "one bad lead" — it aborts
  // the sweep, so every lead behind it silently never uploads.
  const at = new Date('2026-06-15T07:04:05Z');
  const ok = { gclid: GCLID, conversionActionResourceName: ACTION, conversionAt: at, timeZone: 'Asia/Calcutta' };

  it('refuses a null input object', () => {
    expect(() => buildClickConversion(null as any)).toThrow(/gclid/i);
  });

  it('refuses a missing gclid', () => {
    expect(() => buildClickConversion({ ...ok, gclid: undefined as any })).toThrow(/gclid/i);
  });

  it('refuses a whitespace-only gclid rather than uploading a blank click id', () => {
    expect(() => buildClickConversion({ ...ok, gclid: '   ' })).toThrow(/gclid/i);
  });

  it('refuses a missing conversion action', () => {
    expect(() => buildClickConversion({ ...ok, conversionActionResourceName: undefined as any }))
      .toThrow(/conversionActionResourceName/i);
  });

  it('handles a details entry whose errors is not an array', () => {
    expect(summarizePartialFailure({ partialFailureError: { details: [{ errors: 'nope' }] } })).toEqual([]);
  });

  it('handles an error with no location at all', () => {
    const out = summarizePartialFailure({
      partialFailureError: { details: [{ errors: [{ message: 'boom' }] }] },
    });
    expect(out).toEqual([{ index: -1, errorCode: undefined, message: 'boom' }]);
  });

  it('handles a location whose fieldPathElements name something else', () => {
    const out = summarizePartialFailure({
      partialFailureError: { details: [{ errors: [{
        message: 'boom', location: { fieldPathElements: [{ fieldName: 'operations', index: 3 }] },
      }] }] },
    });
    expect(out[0].index).toBe(-1);
  });

  it('handles an errorCode that is not an object', () => {
    const out = summarizePartialFailure({
      partialFailureError: { details: [{ errors: [{ message: 'boom', errorCode: 'FLAT' }] }] },
    });
    expect(out[0].errorCode).toBeUndefined();
  });

  it('defaults the message when Google sends none', () => {
    const out = summarizePartialFailure({ partialFailureError: { details: [{ errors: [{}] }] } });
    expect(out[0].message).toMatch(/Unknown conversion upload error/);
  });

  it('handles a null error entry', () => {
    expect(summarizePartialFailure({ partialFailureError: { details: [{ errors: [null] }] } }))
      .toEqual([{ index: -1, errorCode: undefined, message: 'Unknown conversion upload error.' }]);
  });
});

describe('null holes in the response shape', () => {
  it('survives a null entry in details', () => {
    expect(summarizePartialFailure({ partialFailureError: { details: [null, undefined] } })).toEqual([]);
  });

  it('survives a null entry inside fieldPathElements', () => {
    const out = summarizePartialFailure({
      partialFailureError: { details: [{ errors: [{
        message: 'boom', location: { fieldPathElements: [null, { fieldName: 'conversions', index: 2 }] },
      }] }] },
    });
    expect(out[0].index).toBe(2);
  });
});
