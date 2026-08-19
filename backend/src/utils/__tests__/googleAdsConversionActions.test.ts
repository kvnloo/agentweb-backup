/**
 * ENG-1322 — Emma can build an entire Google Ads campaign and then cannot make it
 * measurable. `call_google_ads_api` exposes ten entity types and CONVERSION_ACTION
 * is not one of them, so the object a launch is optimised toward can only be created
 * by a human in the Google Ads UI. Meanwhile RULE 7.5 blocks the launch when no tag
 * is found — a gate that refuses to launch, with no tool to fix what it refuses over.
 *
 * These cover the pure half: the rules that decide whether a create is safe, what the
 * caller gets back, and whether what Google stored is what we asked for.
 *
 * Scope is CREATE / LIST / UPDATE. REMOVE is deliberately absent (Harsha, ENG-1329):
 * removing a conversion action severs historical attribution in the customer's
 * account and is the one operation whose damage we cannot undo from our side.
 */
import {
  assertCountingType,
  assertConversionActionStatus,
  describeGoogleAdsError,
  parseTagSnippets,
  diffConversionAction,
} from '../googleAdsConversionActions';

describe('assertCountingType (ENG-1322 AC3 — never infer)', () => {
  // The failure this guards is silent: ONE_PER_CLICK vs EVERY changes the reported
  // number, smart bidding optimises toward the wrong one, and nothing errors. A
  // default would pick a side of that on the customer's behalf.
  it('refuses an absent counting type rather than defaulting', () => {
    expect(() => assertCountingType(undefined)).toThrow(/counting_type/i);
  });

  it('names both choices and their consequence, so the caller can decide', () => {
    let message = '';
    try { assertCountingType(undefined); } catch (e: any) { message = e.message; }
    expect(message).toMatch(/ONE_PER_CLICK/);
    expect(message).toMatch(/MANY_PER_CLICK/);
    // Naming the values is not enough — the caller has to know what picking wrong costs.
    expect(message).toMatch(/count|double|every/i);
  });

  it('refuses an unrecognised value instead of passing it to Google', () => {
    expect(() => assertCountingType('ONCE')).toThrow(/ONCE/);
  });

  it('refuses an empty string, which is absence wearing a value’s clothes', () => {
    expect(() => assertCountingType('')).toThrow(/counting_type/i);
  });

  it('accepts the two Google actually supports', () => {
    expect(assertCountingType('ONE_PER_CLICK')).toBe('ONE_PER_CLICK');
    expect(assertCountingType('MANY_PER_CLICK')).toBe('MANY_PER_CLICK');
  });
});

describe('parseTagSnippets (ENG-1322 AC2 — the create must hand back the tag)', () => {
  // A resource name is not enough to install tracking. The page needs AW-<id>/<label>,
  // and that pair exists nowhere else — without this the caller still has to go
  // hunting in the Google Ads UI, which is the whole problem this ticket exists for.
  const snippet = (sendTo: string) => ({
    type: 'WEBPAGE',
    pageFormat: 'HTML',
    globalSiteTag: `<script async src="https://www.googletagmanager.com/gtag/js?id=AW-18192751758"></script>`,
    eventSnippet: `<script>gtag('event','conversion',{'send_to':'${sendTo}'});</script>`,
  });

  it('extracts the conversion id and label from the event snippet', () => {
    const out = parseTagSnippets([snippet('AW-18192751758/qAnwCOLmx-McEI65_eJD')]);
    expect(out).toEqual({
      conversionId: 'AW-18192751758',
      conversionLabel: 'qAnwCOLmx-McEI65_eJD',
      sendTo: 'AW-18192751758/qAnwCOLmx-McEI65_eJD',
    });
  });

  it('returns null when Google has not generated snippets yet', () => {
    // A freshly created action can come back before its snippets exist. Returning
    // null says "not available"; inventing a label would be worse than saying so.
    expect(parseTagSnippets([])).toBeNull();
    expect(parseTagSnippets(undefined)).toBeNull();
  });

  it('returns null rather than guessing when no send_to is present', () => {
    expect(parseTagSnippets([{ type: 'WEBPAGE', eventSnippet: '<script>nothing here</script>' }])).toBeNull();
  });

  it('ignores an AMP variant that carries no parseable send_to and uses the one that does', () => {
    const amp = { type: 'WEBPAGE', pageFormat: 'AMP', eventSnippet: '"vars": { "gtag_id": "AW-18192751758" }' };
    const out = parseTagSnippets([amp, snippet('AW-18192751758/qAnwCOLmx-McEI65_eJD')]);
    expect(out?.conversionLabel).toBe('qAnwCOLmx-McEI65_eJD');
  });

  it('skips a snippet that carries no event snippet at all', () => {
    // Google returns variants; some have only a global site tag. Skipping them is
    // how the WEBPAGE/HTML one still gets found.
    const out = parseTagSnippets([
      { type: 'WEBPAGE', globalSiteTag: '<script src="...id=AW-18192751758"></script>' },
      snippet('AW-18192751758/qAnwCOLmx-McEI65_eJD'),
    ]);
    expect(out?.conversionLabel).toBe('qAnwCOLmx-McEI65_eJD');
  });

  it('tolerates a null entry in the snippets array', () => {
    // Defensive: the array comes straight off a Google payload we do not control.
    const out = parseTagSnippets([null as any, snippet('AW-18192751758/qAnwCOLmx-McEI65_eJD')]);
    expect(out?.conversionLabel).toBe('qAnwCOLmx-McEI65_eJD');
  });

  it('returns null when every snippet lacks an event snippet', () => {
    expect(parseTagSnippets([{ type: 'WEBPAGE', globalSiteTag: '<script></script>' }])).toBeNull();
  });

  it('refuses to return a half-parsed pair', () => {
    // 'AW-123/' has an id and no label. Half a send_to installs tracking that never
    // matches a conversion action — worse than reporting nothing.
    expect(parseTagSnippets([snippet('AW-18192751758/')])).toBeNull();
  });
});

describe('diffConversionAction (ENG-1322 AC4 — read back, do not trust the create)', () => {
  // ENG-1293 is the precedent: createAdGroup and createAd hardcode status ENABLED,
  // so a PAUSED request returned success and stored ENABLED. Two of five objects
  // drifted that way during the ENG-1182 run and were only caught by a read-back.
  const requested = { name: 'Submit lead form', category: 'SUBMIT_LEAD_FORM', countingType: 'ONE_PER_CLICK', status: 'ENABLED' };

  it('reports no drift when Google stored what was asked', () => {
    expect(diffConversionAction(requested, {
      name: 'Submit lead form', category: 'SUBMIT_LEAD_FORM', countingType: 'ONE_PER_CLICK', status: 'ENABLED',
    })).toEqual([]);
  });

  it('names the field, the requested value and what was actually stored', () => {
    const drift = diffConversionAction(requested, {
      name: 'Submit lead form', category: 'SUBMIT_LEAD_FORM', countingType: 'MANY_PER_CLICK', status: 'ENABLED',
    });
    expect(drift).toEqual([
      { field: 'countingType', requested: 'ONE_PER_CLICK', stored: 'MANY_PER_CLICK' },
    ]);
  });

  it('catches the ENG-1293 shape — a status silently stored as something else', () => {
    const drift = diffConversionAction({ ...requested, status: 'PAUSED' }, {
      name: 'Submit lead form', category: 'SUBMIT_LEAD_FORM', countingType: 'ONE_PER_CLICK', status: 'ENABLED',
    });
    expect(drift).toEqual([{ field: 'status', requested: 'PAUSED', stored: 'ENABLED' }]);
  });

  it('treats a null stored record as total drift rather than crashing', () => {
    // A read-back can legitimately return nothing; every requested field is then
    // unverified, which is drift — not a pass.
    const drift = diffConversionAction({ name: 'Submit lead form', status: 'PAUSED' }, null as any);
    expect(drift).toEqual([
      { field: 'name', requested: 'Submit lead form', stored: undefined },
      { field: 'status', requested: 'PAUSED', stored: undefined },
    ]);
  });

  it('reports every drifted field, not just the first', () => {
    const drift = diffConversionAction(requested, {
      name: 'Something else', category: 'DOWNLOAD', countingType: 'MANY_PER_CLICK', status: 'PAUSED',
    });
    expect(drift.map((d) => d.field).sort()).toEqual(['category', 'countingType', 'name', 'status']);
  });

  it('does not report a field the caller never asked for', () => {
    // Only fields we requested can drift. Google fills in plenty we said nothing
    // about, and reporting those as drift would make the signal useless.
    const drift = diffConversionAction({ name: 'Submit lead form' }, {
      name: 'Submit lead form', category: 'SUBMIT_LEAD_FORM', countingType: 'ONE_PER_CLICK', status: 'ENABLED',
    });
    expect(drift).toEqual([]);
  });

  it('ignores a requested field explicitly set to undefined', () => {
    // Callers build the requested map from optional params; an omitted option
    // arrives as undefined and must not be reported as drift against a stored value.
    const drift = diffConversionAction({ name: 'Submit lead form', status: undefined }, {
      name: 'Submit lead form', status: 'ENABLED',
    });
    expect(drift).toEqual([]);
  });

  it('treats a missing stored field as drift rather than a match', () => {
    const drift = diffConversionAction({ name: 'Submit lead form', status: 'PAUSED' }, { name: 'Submit lead form' });
    expect(drift).toEqual([{ field: 'status', requested: 'PAUSED', stored: undefined }]);
  });
});

describe('diffConversionAction — Google Ads INT64 fields arrive as JSON strings', () => {
  // Not a spec reading: this service already knows it. `createBudget` sends
  // `amountMicros: String(...)`, `listBudgets` declares the read-back as string,
  // and listCampaigns/listBiddingStrategies both wrap the INT64 `id` in String().
  // `clickThroughLookbackWindowDays` is INT64 too, so a 90 we sent reads back "90".
  // Comparing those by identity reported drift on a write that was stored exactly
  // as asked — a false alarm on the one signal that exists to be trusted.

  it('does not report drift when an INT64 reads back as its string form', () => {
    expect(diffConversionAction(
      { clickThroughLookbackWindowDays: 90 },
      { clickThroughLookbackWindowDays: '90' },
    )).toEqual([]);
  });

  it('still reports drift when the stored number genuinely differs', () => {
    expect(diffConversionAction(
      { clickThroughLookbackWindowDays: 90 },
      { clickThroughLookbackWindowDays: '30' },
    )).toEqual([{ field: 'clickThroughLookbackWindowDays', requested: 90, stored: '30' }]);
  });

  it('treats an empty string as drift, not as zero', () => {
    // Number('') is 0. A coercion loose enough to call that a match would report
    // "stored exactly as asked" for a field Google never stored at all.
    expect(diffConversionAction(
      { clickThroughLookbackWindowDays: 0 },
      { clickThroughLookbackWindowDays: '' },
    )).toEqual([{ field: 'clickThroughLookbackWindowDays', requested: 0, stored: '' }]);
  });

  it('treats a non-numeric string as drift', () => {
    expect(diffConversionAction(
      { clickThroughLookbackWindowDays: 90 },
      { clickThroughLookbackWindowDays: 'NINETY' },
    )).toEqual([{ field: 'clickThroughLookbackWindowDays', requested: 90, stored: 'NINETY' }]);
  });

  it('treats a missing INT64 as drift rather than coercing absence to a match', () => {
    expect(diffConversionAction(
      { clickThroughLookbackWindowDays: 90 },
      {},
    )).toEqual([{ field: 'clickThroughLookbackWindowDays', requested: 90, stored: undefined }]);
  });

  it('does not loosen booleans — primaryForGoal is a real JSON boolean', () => {
    // Only INT64 is string-encoded. A boolean arriving as the string "true" means
    // something upstream is wrong, and that is worth reporting rather than hiding.
    expect(diffConversionAction(
      { primaryForGoal: true },
      { primaryForGoal: 'true' },
    )).toEqual([{ field: 'primaryForGoal', requested: true, stored: 'true' }]);
  });

  it('does not treat a boolean stored value as a numeric match', () => {
    expect(diffConversionAction(
      { clickThroughLookbackWindowDays: 1 },
      { clickThroughLookbackWindowDays: true },
    )).toEqual([{ field: 'clickThroughLookbackWindowDays', requested: 1, stored: true }]);
  });

  it('still matches when Google returns the INT64 as an actual number', () => {
    // The API is not guaranteed to be consistent across transports, and the
    // gRPC/library path hands back a number. Both shapes must read as stored.
    expect(diffConversionAction(
      { clickThroughLookbackWindowDays: 90 },
      { clickThroughLookbackWindowDays: 90 },
    )).toEqual([]);
  });
});

describe('assertConversionActionStatus — a conversion action does not pause', () => {
  // Found by the ENG-1329 end-to-end against the real account, not by review. CREATE with
  // status PAUSED returned a bare 400; Google's own body named it:
  //   Invalid value at 'operations[0].create.status'
  //   (ConversionActionStatusEnum.ConversionActionStatus), "PAUSED"
  // ConversionActionStatus is ENABLED | REMOVED | HIDDEN. PAUSED is a CAMPAIGN status, and
  // assuming the two enums match is the obvious mistake — the ENG-1329 verification plan
  // made it too.

  it('accepts the three values Google actually defines', () => {
    for (const s of ['ENABLED', 'REMOVED', 'HIDDEN']) {
      expect(assertConversionActionStatus(s)).toBe(s);
    }
  });

  it('normalises case and surrounding whitespace', () => {
    expect(assertConversionActionStatus('  enabled ')).toBe('ENABLED');
  });

  it('refuses PAUSED by name, and says what to use instead', () => {
    // The whole point: PAUSED is the value a human will reach for first.
    expect(() => assertConversionActionStatus('PAUSED')).toThrow(/PAUSED/);
    expect(() => assertConversionActionStatus('PAUSED')).toThrow(/HIDDEN/);
  });

  it('refuses any other unknown value, listing the valid ones', () => {
    expect(() => assertConversionActionStatus('ARCHIVED')).toThrow(/ENABLED, REMOVED, HIDDEN/);
  });

  it('refuses a non-string rather than coercing it', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      expect(() => assertConversionActionStatus(bad)).toThrow();
    }
  });

  it('refuses an empty string rather than defaulting', () => {
    expect(() => assertConversionActionStatus('   ')).toThrow();
  });
});

describe('describeGoogleAdsError — Google says which field is wrong; surface it', () => {
  // callApi logged the detail and rethrew the raw axios error, so the caller only ever saw
  // "Request failed with status code 400". The field-level cause existed the whole time and
  // was invisible exactly when it mattered most.

  it('extracts the message and the offending field', () => {
    const err: any = { message: 'Request failed with status code 400', response: { data: { error: {
      code: 400, status: 'INVALID_ARGUMENT',
      message: 'Invalid value at \'operations[0].create.status\'',
      details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [
        { field: 'operations[0].create.status', description: 'Invalid value ... "PAUSED"' },
      ] }],
    } } } };
    const out = describeGoogleAdsError(err);
    expect(out).toContain('INVALID_ARGUMENT');
    expect(out).toContain('operations[0].create.status');
  });

  it('never echoes request headers back out of the axios config', () => {
    // The raw error carries the whole request config, headers included. Anything that
    // serialises the error wholesale drags them along into logs and API responses.
    const err: any = {
      message: 'Request failed with status code 400',
      config: { headers: { Authorization: 'Bearer ya29.SECRET', 'developer-token': 'DEVTOKEN' } },
      response: { data: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad' } } },
    };
    const out = describeGoogleAdsError(err);
    expect(out).not.toContain('ya29.SECRET');
    expect(out).not.toContain('DEVTOKEN');
    expect(out).not.toContain('Bearer');
  });

  it('falls back to the plain message when there is no structured detail', () => {
    expect(describeGoogleAdsError({ message: 'socket hang up' })).toContain('socket hang up');
  });

  it('survives an error with no message at all', () => {
    expect(typeof describeGoogleAdsError({})).toBe('string');
    expect(describeGoogleAdsError({}).length).toBeGreaterThan(0);
  });

  it('reports several field violations, not just the first', () => {
    const err: any = { response: { data: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'm',
      details: [{ fieldViolations: [
        { field: 'a.status', description: 'bad status' },
        { field: 'a.category', description: 'bad category' },
      ] }] } } } };
    const out = describeGoogleAdsError(err);
    expect(out).toContain('a.status');
    expect(out).toContain('a.category');
  });
});

describe('describeGoogleAdsError — Google Ads business errors, not just proto validation', () => {
  // Two shapes arrive from the same endpoint. The PAUSED failure was proto-level and
  // carried `fieldViolations`. A permission or policy failure is a Google Ads BUSINESS
  // error and carries `errors[]` with an errorCode object instead. Handling only the
  // first left half of all failures as a bare status line.
  it('reports an errorCode and message from the errors[] shape', () => {
    const err: any = { response: { data: { error: { code: 403, status: 'PERMISSION_DENIED',
      message: 'The caller does not have permission',
      details: [{ errors: [{
        errorCode: { authorizationError: 'USER_PERMISSION_DENIED' },
        message: 'User does not have permission to access customer.',
      }] }] } } } };
    const out = describeGoogleAdsError(err);
    expect(out).toContain('USER_PERMISSION_DENIED');
    expect(out).toContain('User does not have permission to access customer.');
  });

  it('falls back to the message when an error carries no errorCode', () => {
    const err: any = { response: { data: { error: { status: 'INTERNAL', message: 'boom',
      details: [{ errors: [{ message: 'something broke' }] }] } } } };
    expect(describeGoogleAdsError(err)).toContain('something broke');
  });

  it('reads both shapes when a response somehow carries each', () => {
    const err: any = { response: { data: { error: { status: 'INVALID_ARGUMENT', message: 'm',
      details: [
        { fieldViolations: [{ field: 'a.status', description: 'bad' }] },
        { errors: [{ errorCode: { rangeError: 'TOO_LOW' }, message: 'too low' }] },
      ] } } } };
    const out = describeGoogleAdsError(err);
    expect(out).toContain('a.status');
    expect(out).toContain('TOO_LOW');
  });
});

describe('describeGoogleAdsError — malformed payloads must not throw', () => {
  // This runs inside a catch block. If it throws on a shape it did not expect, it
  // replaces a real API error with its own stack trace and the original cause is lost.
  it('handles details that is not an array', () => {
    expect(describeGoogleAdsError({ response: { data: { error: {
      status: 'X', message: 'm', details: 'nope' } } } })).toContain('X');
  });

  it('handles a details entry whose fieldViolations is not an array', () => {
    expect(describeGoogleAdsError({ response: { data: { error: {
      status: 'X', message: 'm', details: [{ fieldViolations: 'nope' }] } } } })).toContain('m');
  });

  it('handles a details entry whose errors is not an array', () => {
    expect(describeGoogleAdsError({ response: { data: { error: {
      status: 'X', message: 'm', details: [{ errors: 7 }] } } } })).toContain('X');
  });

  it('skips a fieldViolation with no field', () => {
    const out = describeGoogleAdsError({ response: { data: { error: {
      status: 'X', message: 'm', details: [{ fieldViolations: [{ description: 'orphan' }] }] } } } });
    expect(out).not.toContain('orphan');
  });

  it('defaults a fieldViolation with no description', () => {
    expect(describeGoogleAdsError({ response: { data: { error: {
      status: 'X', message: 'm', details: [{ fieldViolations: [{ field: 'a.b' }] }] } } } }))
      .toContain('a.b: invalid');
  });

  it('handles an errorCode that is not an object', () => {
    expect(describeGoogleAdsError({ response: { data: { error: {
      status: 'X', message: 'm', details: [{ errors: [{ errorCode: 'FLAT', message: 'boom' }] }] } } } }))
      .toContain('boom');
  });

  it('defaults an error entry with no message', () => {
    expect(describeGoogleAdsError({ response: { data: { error: {
      status: 'X', message: 'm', details: [{ errors: [{}] }] } } } })).toContain('error');
  });

  it('falls back when the body carries an error object with nothing usable in it', () => {
    // parts is empty, so the join yields '' — the fallback must still produce a string.
    expect(describeGoogleAdsError({ message: 'axios said so', response: { data: { error: {} } } }))
      .toBe('axios said so');
  });

  it('produces a message even when there is no message anywhere', () => {
    expect(describeGoogleAdsError({ response: { data: { error: {} } } }))
      .toBe('Google Ads API request failed.');
  });

  it('produces a message for an error with no response at all', () => {
    expect(describeGoogleAdsError({})).toBe('Google Ads API request failed.');
  });
});

describe('describeGoogleAdsError — null receivers', () => {
  // Every optional chain in here has a null path, and this runs inside a catch block:
  // `throw null` and `Promise.reject()` are both legal, and an axios interceptor can
  // hand back a details array with holes in it.
  it('survives a null error', () => {
    expect(describeGoogleAdsError(null)).toBe('Google Ads API request failed.');
  });

  it('survives an undefined error', () => {
    expect(describeGoogleAdsError(undefined)).toBe('Google Ads API request failed.');
  });

  it('survives null entries in details', () => {
    expect(describeGoogleAdsError({ response: { data: { error: {
      status: 'X', message: 'm', details: [null, undefined] } } } })).toContain('X');
  });

  it('survives null entries inside fieldViolations', () => {
    expect(describeGoogleAdsError({ response: { data: { error: {
      status: 'X', message: 'm', details: [{ fieldViolations: [null] }] } } } })).toContain('m');
  });

  it('survives null entries inside errors', () => {
    const out = describeGoogleAdsError({ response: { data: { error: {
      status: 'X', message: 'm', details: [{ errors: [null] }] } } } });
    expect(out).toContain('error');
  });
});
