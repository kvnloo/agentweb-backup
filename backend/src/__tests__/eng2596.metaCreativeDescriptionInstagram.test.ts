import { MetaService } from '../services/metaService';
import { AdAccount } from 'facebook-nodejs-business-sdk';
import { buildUnappliedFieldsMessage, findUnappliedCreativeFields } from '../services/agentMode/metaCreativeFieldsCheck';

jest.mock('facebook-nodejs-business-sdk', () => ({
  FacebookAdsApi: { init: jest.fn() },
  AdAccount: jest.fn().mockImplementation(() => ({ createAdCreative: jest.fn() })),
  AdCreative: Object.assign(jest.fn().mockImplementation(() => ({ get: jest.fn() })), {
    Fields: { name: 'name', object_story_spec: 'object_story_spec' },
  }),
  Campaign: jest.fn(), AdSet: jest.fn(), Ad: jest.fn(), CustomAudience: jest.fn(), User: jest.fn(),
}));
jest.mock('../utils/secretsManager', () => ({ getMetaCredentials: jest.fn() }));

describe('ENG-2596 AD_CREATIVE CREATE carries description and instagram_user_id', () => {
  let service: MetaService;
  let create: jest.Mock;
  const base = {
    name: 'c', page_id: 'p1', instagram_user_id: 'ig1', image_hash: 'h',
    body: 'b', title: 't', link_url: 'https://example.com', description: 'The marketing OS',
  };

  beforeEach(() => {
    service = MetaService.getInstance();
    create = jest.fn().mockResolvedValue({ _data: { id: 'c1' } });
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ createAdCreative: create }));
  });

  it('writes both onto a single-image creative', async () => {
    await service.createAdCreative('1', 't', base);
    const spec = create.mock.calls[0][1].object_story_spec;
    expect(spec.instagram_user_id).toBe('ig1');
    expect(spec.link_data.description).toBe('The marketing OS');
  });

  it('omits both when not supplied', async () => {
    const { description: _d, instagram_user_id: _i, ...rest } = base;
    await service.createAdCreative('1', 't', rest);
    const spec = create.mock.calls[0][1].object_story_spec;
    expect(spec).not.toHaveProperty('instagram_user_id');
    expect(spec.link_data).not.toHaveProperty('description');
  });

  it('writes link_description and instagram_user_id on a video creative', async () => {
    await service.createAdCreative('1', 't', { ...base, video_id: 'v1' });
    const spec = create.mock.calls[0][1].object_story_spec;
    expect(spec.instagram_user_id).toBe('ig1');
    expect(spec.video_data.link_description).toBe('The marketing OS');
  });

  it('writes asset_feed_spec.descriptions on a placement creative', async () => {
    await service.createAdCreative('1', 't', {
      ...base,
      image_hash: undefined,
      placement_assets: [
        { image_hash: 'a', is_default: true },
        { image_hash: 'b', placements: ['story'] },
      ],
    });
    const arg = create.mock.calls[0][1];
    expect(arg.asset_feed_spec.descriptions).toEqual([{ text: 'The marketing OS' }]);
    expect(arg.object_story_spec.instagram_user_id).toBe('ig1');
  });
});

describe('findUnappliedCreativeFields', () => {
  const req = { instagram_user_id: 'ig1', description: 'D' };

  it('flags both when the live creative lacks them', () => {
    expect(findUnappliedCreativeFields(req, { object_story_spec: { link_data: {} } }))
      .toEqual(['instagram_user_id', 'description']);
  });

  it('is empty when both are present', () => {
    expect(findUnappliedCreativeFields(req, {
      object_story_spec: { instagram_user_id: 'ig1', link_data: { description: 'D' } },
    })).toEqual([]);
  });

  it('checks video link_description and asset_feed_spec descriptions', () => {
    expect(findUnappliedCreativeFields({ description: 'D', video_id: 'v' },
      { object_story_spec: { video_data: { link_description: 'D' } } })).toEqual([]);
    expect(findUnappliedCreativeFields({ description: 'D', placement_assets: [{}] },
      { asset_feed_spec: { descriptions: [{ text: 'D' }] } })).toEqual([]);
  });

  it('always flags a carousel description (no slot to write it), and ignores unrequested fields', () => {
    expect(findUnappliedCreativeFields({ description: 'D', carousel_cards: [{}, {}] }, {})).toEqual(['description']);
    expect(findUnappliedCreativeFields({ carousel_cards: [{}, {}] }, {})).toEqual([]);
    expect(findUnappliedCreativeFields({}, {})).toEqual([]);
  });

  it('does nothing when the read-back is unavailable', () => {
    expect(findUnappliedCreativeFields(req, undefined)).toEqual([]);
  });
});

describe('findUnappliedCreativeFields comparison and precedence', () => {
  it('ignores edge whitespace and number-vs-string instagram ids', () => {
    expect(findUnappliedCreativeFields({ instagram_user_id: '178', description: ' D ' }, {
      object_story_spec: { instagram_user_id: 178 as unknown as string, link_data: { description: 'D' } },
    })).toEqual([]);
  });

  it('checks a video+carousel request as video, the way the writer builds it', () => {
    expect(findUnappliedCreativeFields({ description: 'D', video_id: 'v', carousel_cards: [{}] },
      { object_story_spec: { video_data: { link_description: 'D' } } })).toEqual([]);
  });
});

describe('buildUnappliedFieldsMessage', () => {
  const creative = { id: 'c9', name: 'N' };
  it('names the id and says to fix rather than duplicate for a genuine drop', () => {
    const m = buildUnappliedFieldsMessage(creative, { description: 'D' }, ['description']);
    expect(m).toContain('id c9');
    expect(m).toContain('Meta did NOT store: description');
    expect(m).not.toMatch(/recreate it/i);
  });
  it('does not blame Meta or suggest recreating for a carousel description', () => {
    const m = buildUnappliedFieldsMessage(creative, { description: 'D', carousel_cards: [{}, {}] }, ['description']);
    expect(m).toContain('carousel_cards[].description');
    expect(m).not.toContain('Meta did NOT store');
  });
});

