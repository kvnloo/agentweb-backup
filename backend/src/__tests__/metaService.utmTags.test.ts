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

/** MetaService is only the HTTP boundary; AgentMode supplies already-resolved tags. */
describe('MetaService — resolved url_tags boundary', () => {
    let service: MetaService;
    let mockCreateCreative: jest.Mock;

    const baseParams = {
        name: 'New Creative',
        page_id: 'page_123',
        image_url: 'http://example.com/image.jpg',
        body: 'Ad Body',
        title: 'Ad Title',
        link_url: 'https://example.com/landing',
        call_to_action_type: 'LEARN_MORE',
    };

    beforeEach(() => {
        service = MetaService.getInstance();
        jest.clearAllMocks();
        mockCreateCreative = jest.fn().mockResolvedValue({ _data: { id: 'creative_new' } });
        (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
            createAdCreative: mockCreateCreative,
        }));
    });

    it('leaves url_tags absent when the caller has no resolved configuration', async () => {
        await service.createAdCreative('123', 'token', baseParams);
        expect(mockCreateCreative.mock.calls[0][1]).not.toHaveProperty('url_tags');
    });

    it('forwards shared-resolver output verbatim', async () => {
        const resolved = 'utm_source=customer&gclid=click-id&aw_lander=1';
        await service.createAdCreative('123', 'token', { ...baseParams, url_tags: resolved });
        expect(mockCreateCreative.mock.calls[0][1].url_tags).toBe(resolved);
    });

    it('forwards resolved tags on the placement-customized path', async () => {
        const resolved = 'utm_campaign=override&aw_lander=1';
        await service.createAdCreative('123', 'token', {
            ...baseParams,
            placement_assets: [
                { image_hash: 'square_hash', is_default: true },
                { image_hash: 'vertical_hash', placements: ['story', 'reels'] },
            ],
            url_tags: resolved,
        });
        expect(mockCreateCreative.mock.calls[0][1].url_tags).toBe(resolved);
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

  it('does not touch anything when a link URL is unparseable (never risk a duplicate), and flags it as unreadable rather than a plain no-op (Greptile)', () => {
    // changed:false alone is ambiguous -- it also means "genuinely already
    // tagged". A caller collapsing both into alreadyTagged:true would tell an
    // operator whose ad has a malformed destination that it's fully covered,
    // when it was actually never verified at all.
    const result = computeRetagUrlTags('utm_source=meta', ['not a url']);
    expect(result).toEqual({ urlTags: 'utm_source=meta', changed: false, unreadable: true });
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
