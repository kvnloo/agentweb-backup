/**
 * ENG-239 — LinkedIn UTM auto-append.
 *
 * LinkedIn has no native tracking/append field and no click-time macros, so UTMs
 * must be literally appended to each destination-URL string at create time. This
 * suite exercises all eight destination-URL call sites in linkedInAdsService.ts:
 *
 *   1. createPost              — carousel card landingPage
 *   2. createPost              — contentLandingPage
 *   3. createCreative          — text-ad landingPage
 *   4. createCreativeInline    — carousel card landingPage
 *   5. createCreativeInline    — contentLandingPage
 *   6. createInMailContent     — callToActionLandingPageUrl
 *   7. createDynamicCreative   — spotlight landingPage
 *   8. createConversationAdContent — button landingPage
 *
 * Invariants asserted throughout:
 *   - utm_content is NEVER emitted (LinkedIn has no ad-id macro; buildUtmSpec drops it).
 *   - utm_source=linkedin, utm_medium=paid on every tagged URL.
 *   - AC4: a UTM key the user already set is preserved, never overwritten; a URL
 *     carrying every key comes back unchanged.
 *   - A missing/undefined URL never crashes ad creation.
 *   - A malformed user URL never crashes ad creation (passes through untagged).
 */

const mockAxiosFn = jest.fn();

jest.mock('axios', () => {
  const fn = (...args: any[]) => mockAxiosFn(...args);
  (fn as any).post = jest.fn();
  (fn as any).get = jest.fn();
  (fn as any).put = jest.fn().mockResolvedValue({ data: {} });
  (fn as any).create = jest.fn().mockReturnValue(fn);
  return { __esModule: true, default: fn };
});

jest.mock('../config/integrations', () => ({
  INTEGRATION_CONFIG: {
    linkedinAds: {
      apiVersion: '202603',
      tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    },
  },
}));

import * as svc from '../services/linkedInAdsService';

const ACCESS_TOKEN = 'test-access-token';
const ACCOUNT_ID = '123456789';
const CAMPAIGN = 'camp-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockAxiosFn.mockResolvedValue({ data: {}, headers: { 'x-restli-id': 'urn:li:x:1' }, status: 201 });
});

/** The request body sent to LinkedIn on the first (only) call. */
function body(): any {
  return mockAxiosFn.mock.calls[0][0].data;
}

/** Parse the UTM query params off a tagged URL. */
function utm(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  new URL(url).searchParams.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/** Assert a URL carries the standard LinkedIn 3-param UTM set and never utm_content. */
function expectLinkedInTagged(url: string, campaign = CAMPAIGN) {
  const p = utm(url);
  expect(p.utm_source).toBe('linkedin');
  expect(p.utm_medium).toBe('paid');
  expect(p.utm_campaign).toBe(campaign);
  expect(url).not.toContain('utm_content');
  expect(p.utm_content).toBeUndefined();
}

// ─── Site 1 & 2: createPost carousel ───────────────────────────────────────────

describe('UTM — createPost carousel', () => {
  const cards = [
    { image_urn: 'urn:li:image:1', title: 'A', landing_page: 'https://example.com/a' },
    { image_urn: 'urn:li:image:2', title: 'B', landing_page: 'https://example.com/b' },
  ];

  it('tags each carousel card landingPage (site 1)', async () => {
    await svc.createPost(ACCESS_TOKEN, {
      author_urn: 'urn:li:organization:1',
      carousel_cards: cards,
      campaign_id: CAMPAIGN,
    });
    const posted = body().content.carousel.cards;
    expectLinkedInTagged(posted[0].landingPage);
    expect(utm(posted[0].landingPage).utm_campaign).toBe(CAMPAIGN);
    expectLinkedInTagged(posted[1].landingPage);
    expect(new URL(posted[1].landingPage).pathname).toBe('/b');
  });

  it('tags contentLandingPage (site 2)', async () => {
    await svc.createPost(ACCESS_TOKEN, {
      author_urn: 'urn:li:organization:1',
      carousel_cards: cards,
      campaign_id: CAMPAIGN,
    });
    expectLinkedInTagged(body().contentLandingPage);
  });

  it('leaves URLs UNTAGGED when no campaign is in scope (never emits utm_campaign=undefined)', async () => {
    await svc.createPost(ACCESS_TOKEN, {
      author_urn: 'urn:li:organization:1',
      carousel_cards: cards,
    });
    const posted = body().content.carousel.cards;
    expect(posted[0].landingPage).toBe('https://example.com/a');
    expect(body().contentLandingPage).toBe('https://example.com/a');
    expect(JSON.stringify(body())).not.toContain('utm_');
    expect(JSON.stringify(body())).not.toContain('undefined');
  });

  it('treats a blank/whitespace campaign_id as no campaign (untagged, never utm_campaign=)', async () => {
    await svc.createPost(ACCESS_TOKEN, {
      author_urn: 'urn:li:organization:1',
      carousel_cards: cards,
      campaign_id: '   ',
    });
    expect(body().content.carousel.cards[0].landingPage).toBe('https://example.com/a');
    expect(JSON.stringify(body())).not.toContain('utm_');
  });

  it('does not crash when a card landing_page is missing', async () => {
    await svc.createPost(ACCESS_TOKEN, {
      author_urn: 'urn:li:organization:1',
      carousel_cards: [{ image_urn: 'urn:li:image:1', title: 'A' }],
      campaign_id: CAMPAIGN,
    });
    // Missing URL stays missing (undefined), no throw, no utm_campaign=undefined.
    expect(body().content.carousel.cards[0].landingPage).toBeUndefined();
  });
});

// ─── Site 3: createCreative text ad ────────────────────────────────────────────

describe('UTM — createCreative text ad landingPage (site 3)', () => {
  it('tags the text-ad landingPage using the required campaign_id', async () => {
    await svc.createCreative(ACCESS_TOKEN, {
      campaign_id: CAMPAIGN,
      ad_account_id: ACCOUNT_ID,
      headline: 'Click Here',
      landing_page: 'https://example.com/lp',
    });
    expectLinkedInTagged(body().content.textAd.landingPage);
  });

  it('extracts the numeric id from a sponsoredCampaign URN for utm_campaign', async () => {
    await svc.createCreative(ACCESS_TOKEN, {
      campaign_id: 'urn:li:sponsoredCampaign:98765',
      ad_account_id: ACCOUNT_ID,
      headline: 'Click Here',
      landing_page: 'https://example.com/lp',
    });
    expectLinkedInTagged(body().content.textAd.landingPage, '98765');
  });

  it('does not crash when landing_page is undefined', async () => {
    await svc.createCreative(ACCESS_TOKEN, {
      campaign_id: CAMPAIGN,
      ad_account_id: ACCOUNT_ID,
      headline: 'Click Here',
    });
    expect(body().content.textAd.landingPage).toBeUndefined();
  });

  it('passes a malformed URL through UNTAGGED rather than crashing ad creation', async () => {
    const result = await svc.createCreative(ACCESS_TOKEN, {
      campaign_id: CAMPAIGN,
      ad_account_id: ACCOUNT_ID,
      headline: 'Click Here',
      landing_page: 'not a valid url',
    });
    expect(result.success).toBe(true);
    expect(body().content.textAd.landingPage).toBe('not a valid url');
  });
});

// ─── Site 4 & 5: createCreativeInline carousel ─────────────────────────────────

describe('UTM — createCreativeInline carousel', () => {
  const base = {
    ad_account_id: ACCOUNT_ID,
    campaign_id: CAMPAIGN,
    author_urn: 'urn:li:organization:1',
    carousel_cards: [
      { image_urn: 'urn:li:image:1', landing_page: 'https://example.com/a' },
      { image_urn: 'urn:li:image:2', landing_page: 'https://example.com/b' },
    ],
  };

  it('tags each carousel card landingPage (site 4)', async () => {
    await svc.createCreativeInline(ACCESS_TOKEN, base);
    const cards = body().creative.inlineContent.post.content.carousel.cards;
    expectLinkedInTagged(cards[0].landingPage);
    expectLinkedInTagged(cards[1].landingPage);
  });

  it('tags contentLandingPage (site 5)', async () => {
    await svc.createCreativeInline(ACCESS_TOKEN, base);
    expectLinkedInTagged(body().creative.inlineContent.post.contentLandingPage);
  });
});

// ─── Site 6: createInMailContent ───────────────────────────────────────────────

describe('UTM — createInMailContent callToActionLandingPageUrl (site 6)', () => {
  const valid = {
    ad_account_id: ACCOUNT_ID,
    name: 'Test InMail',
    sender: 'urn:li:person:abc',
    subject: 'Hi',
    htmlBody: '<p>Body</p>',
    callToActionText: 'Learn More',
    callToActionLandingPageUrl: 'https://example.com/lp',
  };

  it('tags the CTA landing page when campaign_id supplied', async () => {
    await svc.createInMailContent(ACCESS_TOKEN, { ...valid, campaign_id: CAMPAIGN });
    expectLinkedInTagged(body().subContent.regular.callToActionLandingPageUrl);
  });

  it('leaves the CTA landing page untagged when no campaign is in scope', async () => {
    await svc.createInMailContent(ACCESS_TOKEN, valid);
    expect(body().subContent.regular.callToActionLandingPageUrl).toBe('https://example.com/lp');
  });
});

// ─── Site 7: createDynamicCreative spotlight ───────────────────────────────────

describe('UTM — createDynamicCreative spotlight landingPage (site 7)', () => {
  it('tags the spotlight landingPage using the required campaign_id', async () => {
    await svc.createDynamicCreative(ACCESS_TOKEN, ACCOUNT_ID, {
      campaign_id: CAMPAIGN,
      format: 'SPOTLIGHT',
      headline: 'See our work',
      call_to_action: 'Visit',
      landing_page: 'https://example.com/lp',
      logo_urn: 'urn:li:image:logo',
    });
    expectLinkedInTagged(body().content.spotlight.landingPage);
  });
});

// ─── Site 8: createConversationAdContent buttons ───────────────────────────────

describe('UTM — createConversationAdContent button landingPage (site 8)', () => {
  it('tags OPEN_URL button URLs when campaign_id supplied', async () => {
    await svc.createConversationAdContent(ACCESS_TOKEN, 'urn:li:conversationAd:ca-1', {
      body: 'Hello',
      campaign_id: CAMPAIGN,
      buttons: [
        { text: 'Yes', action: 'SEND_MESSAGE' },
        { text: 'Visit', action: 'OPEN_URL', url: 'https://example.com/lp' },
      ],
    });
    const buttons = body().buttons;
    // SEND_MESSAGE button has no landingPage.
    expect(buttons[0].landingPage).toBeUndefined();
    expectLinkedInTagged(buttons[1].landingPage);
  });

  it('leaves button URLs untagged when no campaign is in scope', async () => {
    await svc.createConversationAdContent(ACCESS_TOKEN, 'urn:li:conversationAd:ca-1', {
      body: 'Hello',
      buttons: [{ text: 'Visit', action: 'OPEN_URL', url: 'https://example.com/lp' }],
    });
    expect(body().buttons[0].landingPage).toBe('https://example.com/lp');
  });
});

// ─── AC4: user-supplied UTMs respected (per-key merge) ─────────────────────────

describe('UTM — AC4 per-key merge (edge cases)', () => {
  it('preserves a utm_source the user already set, and adds the rest', async () => {
    await svc.createCreative(ACCESS_TOKEN, {
      campaign_id: CAMPAIGN,
      ad_account_id: ACCOUNT_ID,
      headline: 'H',
      landing_page: 'https://example.com/lp?utm_source=newsletter',
    });
    const url = body().content.textAd.landingPage;
    const p = utm(url);
    expect(p.utm_source).toBe('newsletter'); // user value preserved, not overwritten
    expect(p.utm_medium).toBe('paid');
    expect(p.utm_campaign).toBe(CAMPAIGN);
    expect(url).not.toContain('utm_content');
  });

  it('preserves a user-set utm_campaign (does not overwrite with ours)', async () => {
    await svc.createCreative(ACCESS_TOKEN, {
      campaign_id: CAMPAIGN,
      ad_account_id: ACCOUNT_ID,
      headline: 'H',
      landing_page: 'https://example.com/lp?utm_campaign=my_own',
    });
    const p = utm(body().content.textAd.landingPage);
    expect(p.utm_campaign).toBe('my_own');
    expect(p.utm_source).toBe('linkedin');
  });

  it('returns the URL byte-identical when all UTM keys are already present', async () => {
    const already = 'https://example.com/lp?utm_source=x&utm_medium=y&utm_campaign=z';
    await svc.createCreative(ACCESS_TOKEN, {
      campaign_id: CAMPAIGN,
      ad_account_id: ACCOUNT_ID,
      headline: 'H',
      landing_page: already,
    });
    expect(body().content.textAd.landingPage).toBe(already);
  });

  it('never emits utm_content even when the user set utm_term', async () => {
    await svc.createCreative(ACCESS_TOKEN, {
      campaign_id: CAMPAIGN,
      ad_account_id: ACCOUNT_ID,
      headline: 'H',
      landing_page: 'https://example.com/lp?utm_term=widget',
    });
    const url = body().content.textAd.landingPage;
    expect(url).not.toContain('utm_content');
    expect(utm(url).utm_term).toBe('widget');
  });
});

// ─── Regression: tagging must not break unrelated creative paths ───────────────

describe('UTM — non-URL creative paths are untouched', () => {
  it('reference (post_urn) creatives carry no UTM anywhere', async () => {
    await svc.createCreative(ACCESS_TOKEN, {
      campaign_id: CAMPAIGN,
      ad_account_id: ACCOUNT_ID,
      post_urn: 'urn:li:share:999',
    });
    expect(JSON.stringify(body())).not.toContain('utm_');
  });
});

// ─── retagCreativeUtm — single existing creative retrofit (Harsha's ask) ───────
//
// UNVERIFIED against a live account: unlike the rest of this file (which mirrors
// what LinkedIn's create-time API contract already proves out), the PARTIAL_UPDATE
// shape used here (`content.textAd.landingPage` under a nested $set) is inferred
// from the sibling campaign/campaignGroup convention, never confirmed live. Do not
// treat these passing mocked tests as proof the live API accepts this shape.
describe('retagCreativeUtm — single existing creative retrofit (Harsha\'s ask)', () => {
  function mockGet(data: any) {
    mockAxiosFn.mockResolvedValueOnce({ data, headers: {}, status: 200 });
  }

  it('propagates a failure reading the creative', async () => {
    mockAxiosFn.mockRejectedValueOnce({ response: { status: 404, data: { message: 'not found' } } });
    const result = await svc.retagCreativeUtm(ACCESS_TOKEN, ACCOUNT_ID, 'creative-1', CAMPAIGN);
    expect(result.success).toBe(false);
    expect(mockAxiosFn).toHaveBeenCalledTimes(1); // never reaches the write
  });

  it('reports UNSUPPORTED_CREATIVE_TYPE for a content.reference creative (destination lives on the post, not here)', async () => {
    mockGet({ content: { reference: 'urn:li:share:999' } });
    const result = await svc.retagCreativeUtm(ACCESS_TOKEN, ACCOUNT_ID, 'creative-1', CAMPAIGN);
    expect(result.success).toBe(false);
    expect(result.error).toContain('UNSUPPORTED_CREATIVE_TYPE');
    expect(mockAxiosFn).toHaveBeenCalledTimes(1); // read only, no write attempted
  });

  it('is a no-op when the text ad landingPage already carries every UTM key', async () => {
    const already = `https://example.com/?${['utm_source=linkedin', 'utm_medium=paid', `utm_campaign=${CAMPAIGN}`].join('&')}`;
    mockGet({ content: { textAd: { headline: 'H', landingPage: already } } });
    const result = await svc.retagCreativeUtm(ACCESS_TOKEN, ACCOUNT_ID, 'creative-1', CAMPAIGN);
    expect(result).toEqual({ success: true, alreadyTagged: true });
    expect(mockAxiosFn).toHaveBeenCalledTimes(1); // read only, no write attempted
  });

  it('retags an untagged text-ad creative (happy path)', async () => {
    mockGet({ content: { textAd: { headline: 'H', landingPage: 'https://example.com/' } } });
    mockAxiosFn.mockResolvedValueOnce({ data: {}, headers: {}, status: 200 }); // the PARTIAL_UPDATE write

    const result = await svc.retagCreativeUtm(ACCESS_TOKEN, ACCOUNT_ID, 'creative-1', CAMPAIGN);

    expect(result.success).toBe(true);
    expect(mockAxiosFn).toHaveBeenCalledTimes(2);
    const writeCall = mockAxiosFn.mock.calls[1][0];
    expect(writeCall.method).toBe('POST');
    expect(writeCall.headers['X-RestLi-Method']).toBe('PARTIAL_UPDATE');
    const newUrl = writeCall.data.patch.$set['content.textAd.landingPage'];
    expect(utm(newUrl).utm_source).toBe('linkedin');
    expect(utm(newUrl).utm_medium).toBe('paid');
    expect(utm(newUrl).utm_content).toBeUndefined();
  });
});
