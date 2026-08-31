import {
  describeScope,
  buildListMessage,
  describeIgnoredCampaignScope,
  buildListResult,
} from '../services/agentMode/metaListScope';

/**
 * ENG-1476 / ENG-1584 — the extracted list-scope helpers.
 *
 * These were pulled out of `agentModeService.ts` rather than added to it, per that file's path
 * instruction. The payoff is here: no Meta SDK, no credentials, no database, no mocks — the
 * rules that decide whether a list can be read as complete are testable directly.
 */

describe('ENG-1476 describeScope', () => {
  it('names the ad set, which is the narrowest scope', () => {
    expect(describeScope({ adSetId: 'as1' }, { campaignScopable: true })).toBe(' in ad set as1');
  });

  it('prefers the ad set over the campaign when both are present', () => {
    expect(describeScope({ adSetId: 'as1', campaignId: 'c1' }, { campaignScopable: true }))
      .toBe(' in ad set as1');
  });

  it('states account breadth explicitly rather than saying nothing', () => {
    // Silence is what made "Found 25 ad(s)" read as "these are all the ads".
    expect(describeScope({}, { campaignScopable: true })).toBe(' in this ad account');
    expect(describeScope(undefined, { campaignScopable: true })).toBe(' in this ad account');
  });

  it('ignores a campaign scope on an edge that cannot honour one', () => {
    // AD_CREATIVE LIST: Meta has no campaign->adcreatives edge, so claiming campaign scope
    // there would be a lie about what was read.
    expect(describeScope({ campaignId: 'c1' }, { campaignScopable: false })).toBe(' in this ad account');
  });
});

describe('ENG-1476 buildListMessage', () => {
  it('marks a complete list as complete', () => {
    expect(buildListMessage({ noun: 'ad(s)', totalCount: 14, scope: { campaignId: 'c1' }, campaignScopable: true }))
      .toBe('Found 14 ad(s) in campaign c1 (complete list).');
  });

  it('puts the incompleteness in prose, not only in a field', () => {
    const m = buildListMessage({ noun: 'ad(s)', totalCount: 2500, truncated: true, campaignScopable: true });
    expect(m).toContain('INCOMPLETE');
    expect(m).toContain('Do NOT conclude an ad is absent');
    expect(m).not.toContain('complete list');
  });

  it('tells a truncated caller how to get a usable answer', () => {
    // A warning with no remedy just leaves the model stuck; narrowing is the actual fix.
    expect(buildListMessage({ noun: 'ad(s)', totalCount: 9, truncated: true, campaignScopable: true }))
      .toContain('Narrow the request with campaign_id or ad_set_id');
  });

  it('says "a creative" for the creative edge', () => {
    expect(buildListMessage({ noun: 'ad creative(s)', totalCount: 5, truncated: true, campaignScopable: false }))
      .toContain('Do NOT conclude a creative is absent');
  });

  // ENG-1625 — widened absentNounFor beyond the original ad/creative pair so the same
  // "do not conclude X is absent" prose is pointed at the right noun for every list edge
  // this follow-up fixed, not a generic fallback.
  it.each([
    ['campaign(s)', 'a campaign is absent'],
    ['ad set(s)', 'an ad set is absent'],
    ['custom audience(s)', 'a custom audience is absent'],
    ['pixel(s)', 'a pixel is absent'],
  ])('says the right noun for %s', (noun, expected) => {
    expect(buildListMessage({ noun, totalCount: 5, truncated: true, campaignScopable: false }))
      .toContain(`Do NOT conclude ${expected}`);
  });

  it('never claims completeness for a zero-result truncated read', () => {
    // "Found 0" plus "complete" is the most dangerous sentence this module can produce.
    const m = buildListMessage({ noun: 'ad(s)', totalCount: 0, truncated: true, campaignScopable: true });
    expect(m).not.toContain('complete list');
  });
});

describe('ENG-1476 describeIgnoredCampaignScope', () => {
  it('names the scope it could not apply and points at the supported route', () => {
    const note = describeIgnoredCampaignScope('120240930011430395');
    expect(note).toContain('120240930011430395');
    expect(note).toContain('NOT applied');
    expect(note).toContain('use AD LIST with campaign_id');
  });
});

describe('ENG-1476 buildListResult', () => {
  const big = Array.from({ length: 50 }, (_, i) => ({ id: String(i) }));

  it('serializes every completeness field ahead of the payload', () => {
    /*
     * ⚠ This is the whole reason the assembly lives in one function. A large ad list is
     * offloaded to S3 and the model receives a SEALED fixed-length PREFIX of this JSON, so any
     * field after the payload array is simply absent — and it would be absent on exactly the
     * lists whose incompleteness most needs stating.
     */
    const json = JSON.stringify(buildListResult({
      payloadKey: 'ads', payload: big, message: 'm', truncated: true, scope: { campaignId: 'c1' },
    }));
    const ads = json.indexOf('"ads"');
    for (const field of ['"message"', '"complete"', '"hasMore"', '"totalCount"', '"scope"']) {
      expect(json.indexOf(field)).toBeGreaterThan(-1);
      expect(json.indexOf(field)).toBeLessThan(ads);
    }
  });

  it('keeps scopeIgnored ahead of the payload too', () => {
    const json = JSON.stringify(buildListResult({
      payloadKey: 'creatives', payload: big, message: 'm', scopeIgnored: { campaign_id: 'c1' },
    }));
    expect(json.indexOf('"scopeIgnored"')).toBeLessThan(json.indexOf('"creatives"'));
  });

  it('omits scopeIgnored entirely when nothing was ignored', () => {
    const r = buildListResult({ payloadKey: 'ads', payload: [], message: 'm' });
    expect(r).not.toHaveProperty('scopeIgnored');
  });

  it('derives totalCount from the payload rather than trusting a passed count', () => {
    // A count that can disagree with the array is a count that eventually will.
    expect(buildListResult({ payloadKey: 'ads', payload: big, message: 'm' }).totalCount).toBe(50);
  });

  it('reports complete/hasMore as exact opposites', () => {
    const done = buildListResult({ payloadKey: 'ads', payload: [], message: 'm' });
    expect(done.complete).toBe(true);
    expect(done.hasMore).toBe(false);

    const partial = buildListResult({ payloadKey: 'ads', payload: [], message: 'm', truncated: true });
    expect(partial.complete).toBe(false);
    expect(partial.hasMore).toBe(true);
  });

  // ENG-1625 — payloadKey widened from 'ads' | 'creatives' to also cover the campaign, ad
  // set, custom audience, and pixel list edges fixed in this follow-up. Same field-order
  // guarantee applies to all of them — the S3 offload cut does not care which noun a large
  // list happens to be.
  it.each(['campaigns', 'adSets', 'audiences', 'pixels'] as const)(
    'serializes completeness fields ahead of the %s payload too',
    (payloadKey) => {
      const json = JSON.stringify(buildListResult({
        payloadKey, payload: big, message: 'm', truncated: true,
      }));
      const payloadIndex = json.indexOf(`"${payloadKey}"`);
      for (const field of ['"message"', '"complete"', '"hasMore"', '"totalCount"']) {
        expect(json.indexOf(field)).toBeGreaterThan(-1);
        expect(json.indexOf(field)).toBeLessThan(payloadIndex);
      }
    },
  );
});
