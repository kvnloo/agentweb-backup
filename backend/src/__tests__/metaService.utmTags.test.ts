import { MetaService, computeRetagUrlTags } from '../services/metaService';
import { AdAccount, AdCreative } from 'facebook-nodejs-business-sdk';

// Mock the facebook-nodejs-business-sdk (mirrors metaService.test.ts, scoped to the
// creative-creation surface this suite exercises).
jest.mock('facebook-nodejs-business-sdk', () => {
    return {
        FacebookAdsApi: {
            init: jest.fn(),
        },
        AdAccount: jest.fn().mockImplementation(() => ({
            createAdCreative: jest.fn(),
        })),
        AdCreative: Object.assign(
            jest.fn().mockImplementation(() => ({ get: jest.fn() })),
            {
                Fields: {
                    name: 'name',
                    object_story_spec: 'object_story_spec',
                },
            }
        ),
        // Constructors referenced at module load time in metaService.ts.
        Campaign: jest.fn(),
        AdSet: jest.fn(),
        Ad: jest.fn(),
        CustomAudience: jest.fn(),
        User: jest.fn(),
    };
});

jest.mock('../utils/secretsManager', () => ({
    getMetaCredentials: jest.fn(),
}));

/**
 * ENG-239 — Meta auto-generation of `url_tags` (UTM append rules).
 *
 * The single-image/video/carousel path lives in `createAdCreative`; the
 * placement-customized (asset_feed_spec) path lives in
 * `createPlacementCustomizedCreative`. Both must auto-generate `url_tags` when
 * the caller omits it, and both must respect an explicitly-supplied value.
 */
describe('MetaService — auto-generated url_tags (ENG-239)', () => {
    let service: MetaService;
    const mockAccessToken = 'mock_access_token';
    const mockAdAccountId = '1234567890';

    // Deterministic UTM string Emma stamps when the caller supplies nothing.
    // Macros ({{campaign.id}}, {{ad.id}}) MUST reach Meta un-encoded so it can
    // resolve them at click time.
    const FULL_TAGS = 'utm_source=meta&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}';

    let mockCreateCreative: jest.Mock;

    const setupCreateMock = () => {
        mockCreateCreative = jest.fn().mockResolvedValue({ _data: { id: 'creative_new' } });
        (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
            createAdCreative: mockCreateCreative,
        }));
    };

    const lastUrlTags = (): string | undefined => mockCreateCreative.mock.calls[0][1].url_tags;

    beforeEach(() => {
        service = MetaService.getInstance();
        jest.clearAllMocks();
        // clearAllMocks wipes the AdCreative.Fields implementation only if it were a
        // mock fn; the static Fields object survives, so no re-seed needed.
        setupCreateMock();
    });

    const baseParams = {
        name: 'New Creative',
        page_id: 'page_123',
        image_url: 'http://example.com/image.jpg',
        body: 'Ad Body',
        title: 'Ad Title',
        link_url: 'https://example.com/landing',
        call_to_action_type: 'LEARN_MORE',
    };

    it('generates the full UTM url_tags when the caller supplies none (happy path)', async () => {
        await service.createAdCreative(mockAdAccountId, mockAccessToken, { ...baseParams });

        expect(lastUrlTags()).toBe(FULL_TAGS);
        // Macros must be un-encoded — percent-encoded braces break click-time resolution.
        expect(lastUrlTags()).toContain('{{campaign.id}}');
        expect(lastUrlTags()).toContain('{{ad.id}}');
    });

    it('omits a UTM key that link_url already carries (AC4 — no duplicate param)', async () => {
        await service.createAdCreative(mockAdAccountId, mockAccessToken, {
            ...baseParams,
            link_url: 'https://example.com/landing?utm_source=newsletter',
        });

        const tags = lastUrlTags()!;
        // utm_source is already on link_url; Meta would append a second copy → omit it.
        expect(tags).not.toContain('utm_source');
        expect(tags).toBe('utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}');
    });

    it('writes no url_tags when link_url already carries every UTM key', async () => {
        await service.createAdCreative(mockAdAccountId, mockAccessToken, {
            ...baseParams,
            link_url:
                'https://example.com/landing?utm_source=fb&utm_medium=paid&utm_campaign=c1&utm_content=a1&utm_term=t1',
        });

        // utmQueryString returns "" → the field must be absent, not empty.
        expect(mockCreateCreative.mock.calls[0][1]).not.toHaveProperty('url_tags');
    });

    it('never clobbers an explicitly-supplied url_tags', async () => {
        const explicit = 'utm_source=partner&utm_campaign=hand_written';
        await service.createAdCreative(mockAdAccountId, mockAccessToken, {
            ...baseParams,
            url_tags: explicit,
        });

        expect(lastUrlTags()).toBe(explicit);
    });

    it('generates url_tags on the placement-customized (asset_feed_spec) path', async () => {
        await service.createAdCreative(mockAdAccountId, mockAccessToken, {
            name: 'Placement Creative',
            page_id: 'page_123',
            body: 'Ad Body',
            title: 'Ad Title',
            link_url: 'https://example.com/landing',
            call_to_action_type: 'LEARN_MORE',
            placement_assets: [
                { image_hash: 'square_hash', is_default: true },
                { image_hash: 'vertical_hash', placements: ['story', 'reels'] },
            ],
        });

        // Sanity: this really went through the asset_feed_spec path.
        expect(mockCreateCreative.mock.calls[0][1]).toHaveProperty('asset_feed_spec');
        expect(lastUrlTags()).toBe(FULL_TAGS);
    });

    it('references the first carousel card link_url when the top-level link_url is absent', async () => {
        await service.createAdCreative(mockAdAccountId, mockAccessToken, {
            name: 'Carousel Creative',
            page_id: 'page_123',
            body: 'Ad Body',
            title: 'Ad Title',
            // No top-level link_url — carousel relies on per-card links.
            link_url: undefined as unknown as string,
            call_to_action_type: 'LEARN_MORE',
            carousel_cards: [
                { image_hash: 'h1', title: 'Card 1', link_url: 'https://example.com/a?utm_source=preexisting' },
                { image_hash: 'h2', title: 'Card 2', link_url: 'https://example.com/b' },
            ],
        });

        const tags = lastUrlTags()!;
        // First card already has utm_source → omit it (AC4 reference = first card link).
        expect(tags).not.toContain('utm_source');
        expect(tags).toBe('utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}');
    });

    it('emits the full UTM set when no reference URL exists at all (omit nothing)', async () => {
        // Neither a top-level link_url nor any card link_url → no reference URL to
        // dedupe against, so nothing is omitted and the full set is emitted.
        await service.createAdCreative(mockAdAccountId, mockAccessToken, {
            name: 'Carousel Creative',
            page_id: 'page_123',
            body: 'Ad Body',
            title: 'Ad Title',
            link_url: undefined as unknown as string,
            call_to_action_type: 'LEARN_MORE',
            carousel_cards: [
                { image_hash: 'h1', title: 'Card 1' },
                { image_hash: 'h2', title: 'Card 2' },
            ],
        });

        expect(lastUrlTags()).toBe(FULL_TAGS);
    });
});

/**
 * Edge cases the first pass missed. Both fail in the DANGEROUS direction — one
 * aborts an ad build, the other corrupts attribution with a duplicate param — so
 * they matter more than their size suggests.
 */
describe('MetaService — url_tags edge cases', () => {
  it('creates the creative untagged rather than throwing when link_url is unparseable', async () => {
    // `example.com` (no scheme) fails `new URL()`. Tagging must never be the thing
    // that breaks an ad build: let Meta reject the bad URL with its own error.
    const params: any = {
      name: 'c', link_url: 'example.com', message: 'm', title: 't', image_hash: 'h', page_id: 'p',
    };
    const tags = (MetaService as any).resolveUrlTags(params);
    expect(tags).toBeUndefined();
  });

  it('does not duplicate a UTM key that ANY carousel card already carries', async () => {
    // url_tags is creative-level: Meta appends it to EVERY link on the creative. If
    // card 2 already has utm_source and we emit one in url_tags, card 2's click URL
    // gets utm_source twice — which corrupts the attribution this feature exists to
    // produce. A duplicate is worse than an under-tagged card, so a key present on
    // ANY card is omitted.
    const params: any = {
      name: 'c', page_id: 'p',
      carousel_cards: [
        { link_url: 'https://a.com/1', image_hash: 'h1' },
        { link_url: 'https://a.com/2?utm_source=partner', image_hash: 'h2' },
      ],
    };
    const tags = (MetaService as any).resolveUrlTags(params);
    expect(tags).not.toContain('utm_source');
    expect(tags).toContain('utm_medium=paid');
    expect(tags).toContain('utm_campaign={{campaign.id}}');
  });

  it('skips tagging entirely when a carousel card URL is unparseable', () => {
    const params: any = {
      name: 'c', page_id: 'p',
      carousel_cards: [{ link_url: 'not a url', image_hash: 'h1' }],
    };
    expect((MetaService as any).resolveUrlTags(params)).toBeUndefined();
  });
});

describe('computeRetagUrlTags — single existing ad retrofit (Harsha\'s ask)', () => {
  it('reports unchanged when the link already carries every UTM key and there is no existing url_tags', () => {
    const result = computeRetagUrlTags(
      undefined,
      ['https://a.com/?utm_source=a&utm_medium=b&utm_campaign=c&utm_content=d&utm_term=e'],
    );
    expect(result).toEqual({ urlTags: undefined, changed: false });
  });

  it('reports unchanged when the existing url_tags already carries every required key', () => {
    const existing = 'utm_source=meta&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}';
    const result = computeRetagUrlTags(existing, ['https://a.com/']);
    expect(result).toEqual({ urlTags: existing, changed: false });
  });

  it('does not touch anything when a link URL is unparseable (never risk a duplicate)', () => {
    const result = computeRetagUrlTags('utm_source=meta', ['not a url']);
    expect(result).toEqual({ urlTags: 'utm_source=meta', changed: false });
  });

  it('builds the full UTM set when there is no existing url_tags and the link carries none (happy path)', () => {
    const result = computeRetagUrlTags(undefined, ['https://a.com/']);
    expect(result.changed).toBe(true);
    expect(result.urlTags).toBe('utm_source=meta&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}');
  });

  it('merges in only the missing keys, preserving existing url_tags content verbatim', () => {
    const result = computeRetagUrlTags('utm_source=meta&partner_id=123', ['https://a.com/']);
    expect(result.changed).toBe(true);
    expect(result.urlTags).toBe(
      'utm_source=meta&partner_id=123&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}',
    );
  });

  it('omits a key already present on the link URL even if url_tags does not have it', () => {
    const result = computeRetagUrlTags(undefined, ['https://a.com/?utm_source=partner']);
    expect(result.changed).toBe(true);
    expect(result.urlTags).not.toContain('utm_source');
    expect(result.urlTags).toContain('utm_medium=paid');
  });
});
