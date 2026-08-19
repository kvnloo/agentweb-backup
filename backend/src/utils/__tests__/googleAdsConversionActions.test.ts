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

  it('treats a missing stored field as drift rather than a match', () => {
    const drift = diffConversionAction({ name: 'Submit lead form', status: 'PAUSED' }, { name: 'Submit lead form' });
    expect(drift).toEqual([{ field: 'status', requested: 'PAUSED', stored: undefined }]);
  });
});
