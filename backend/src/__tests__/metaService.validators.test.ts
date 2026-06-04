import { MetaService } from '../services/metaService';

describe('MetaService static validators', () => {
  // ===================== validateCampaignParams =====================
  describe('validateCampaignParams', () => {
    it('passes for a valid CREATE payload', () => {
      expect(() =>
        MetaService.validateCampaignParams('CREATE', {
          name: 'My Campaign',
          objective: 'OUTCOME_TRAFFIC',
          special_ad_categories: ['NONE']
        })
      ).not.toThrow();
    });

    it('is a no-op for non-CREATE actions', () => {
      // UPDATE / DELETE have no required field rules in this validator
      expect(() => MetaService.validateCampaignParams('UPDATE', {})).not.toThrow();
      expect(() => MetaService.validateCampaignParams('DELETE', {})).not.toThrow();
    });

    it('throws when name is missing', () => {
      expect(() =>
        MetaService.validateCampaignParams('CREATE', {
          objective: 'OUTCOME_TRAFFIC',
          special_ad_categories: []
        })
      ).toThrow('Campaign CREATE requires "name".');
    });

    it('throws when objective is missing', () => {
      expect(() =>
        MetaService.validateCampaignParams('CREATE', { name: 'My Campaign' })
      ).toThrow('Campaign CREATE requires "objective".');
    });

    it('throws for an invalid objective value', () => {
      expect(() =>
        MetaService.validateCampaignParams('CREATE', {
          name: 'My Campaign',
          objective: 'INVALID_OBJECTIVE'
        })
      ).toThrow('Invalid objective "INVALID_OBJECTIVE".');
    });

    it('throws when special_ad_categories is not an array', () => {
      expect(() =>
        MetaService.validateCampaignParams('CREATE', {
          name: 'My Campaign',
          objective: 'OUTCOME_SALES',
          special_ad_categories: 'NONE' as any
        })
      ).toThrow('special_ad_categories" must be an array');
    });

    it('accepts all valid objective values', () => {
      const validObjectives = [
        'OUTCOME_TRAFFIC',
        'OUTCOME_AWARENESS',
        'OUTCOME_ENGAGEMENT',
        'OUTCOME_SALES',
        'OUTCOME_LEADS',
        'OUTCOME_APP_PROMOTION'
      ];
      for (const objective of validObjectives) {
        expect(() =>
          MetaService.validateCampaignParams('CREATE', { name: 'C', objective })
        ).not.toThrow();
      }
    });
  });

  // ===================== validateCreativeParams =====================
  describe('validateCreativeParams', () => {
    it('is a no-op for non-CREATE actions', () => {
      expect(() => MetaService.validateCreativeParams('UPDATE', {})).not.toThrow();
    });

    it('throws when name is missing', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          page_id: 'p1',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com',
          image_url: 'https://example.com/img.jpg'
        })
      ).toThrow('Ad Creative CREATE requires "name".');
    });

    it('throws when page_id is missing', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com',
          image_url: 'https://example.com/img.jpg'
        })
      ).toThrow('Ad Creative CREATE requires "page_id".');
    });

    it('throws when body is missing', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          title: 'title',
          link_url: 'https://example.com',
          image_url: 'https://example.com/img.jpg'
        })
      ).toThrow('Ad Creative CREATE requires "body".');
    });

    // --- Image creative ---
    it('passes for a valid image creative using image_url', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com',
          image_url: 'https://example.com/img.jpg'
        })
      ).not.toThrow();
    });

    it('passes for a valid image creative using image_hash', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com',
          image_hash: 'abc123hash'
        })
      ).not.toThrow();
    });

    it('throws when title is missing for an image creative', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          link_url: 'https://example.com',
          image_url: 'https://example.com/img.jpg'
        })
      ).toThrow('Ad Creative CREATE requires "title".');
    });

    it('throws when link_url is missing for an image creative', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          title: 'title',
          image_url: 'https://example.com/img.jpg'
        })
      ).toThrow('Ad Creative CREATE requires "link_url".');
    });

    it('throws when no creative type is specified', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com'
        })
      ).toThrow('must specify a creative type');
    });

    // --- Video creative ---
    it('passes for a valid video creative with image_hash thumbnail', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com',
          video_id: 'vid_123',
          image_hash: 'hash_abc'
        })
      ).not.toThrow();
    });

    it('passes for a valid video creative with image_url thumbnail', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com',
          video_id: 'vid_123',
          image_url: 'https://example.com/thumb.jpg'
        })
      ).not.toThrow();
    });

    it('throws when video creative is missing thumbnail', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com',
          video_id: 'vid_123'
        })
      ).toThrow('video creatives require a thumbnail');
    });

    it('throws when both video_id and carousel_cards are provided', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com',
          video_id: 'vid_123',
          image_hash: 'hash_abc',
          carousel_cards: [
            { image_url: 'https://example.com/img1.jpg', title: 'c1', link_url: 'https://example.com' },
            { image_url: 'https://example.com/img2.jpg', title: 'c2', link_url: 'https://example.com' }
          ]
        })
      ).toThrow('mutually exclusive');
    });

    // --- Carousel creative ---
    it('passes for a valid carousel creative without top-level title/link_url', () => {
      // The fix: carousel should NOT require top-level title and link_url
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          // intentionally omitting title and link_url
          carousel_cards: [
            { image_url: 'https://example.com/img1.jpg', title: 'c1', link_url: 'https://example.com' },
            { image_url: 'https://example.com/img2.jpg', title: 'c2', link_url: 'https://example.com' }
          ]
        })
      ).not.toThrow();
    });

    it('throws for a carousel with fewer than 2 cards', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          carousel_cards: [
            { image_url: 'https://example.com/img1.jpg', title: 'c1', link_url: 'https://example.com' }
          ]
        })
      ).toThrow('must be an array of 2–10 items');
    });

    it('throws for a carousel with more than 10 cards', () => {
      const cards = Array.from({ length: 11 }, (_, i) => ({
        image_url: `https://example.com/img${i}.jpg`,
        title: `Card ${i}`,
        link_url: 'https://example.com'
      }));
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          carousel_cards: cards
        })
      ).toThrow('must be an array of 2–10 items');
    });

    it('throws when a carousel card has no media', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          carousel_cards: [
            { title: 'c1', link_url: 'https://example.com' }, // no media
            { image_url: 'https://example.com/img2.jpg', title: 'c2', link_url: 'https://example.com' }
          ]
        })
      ).toThrow('carousel_cards[0] must have at least one of image_hash, image_url, or video_id');
    });

    // --- Placement-customized creative (asset_feed_spec) ---
    it('passes for a valid placement_assets creative (square default + 9:16 stories/reels)', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com',
          placement_assets: [
            { image_hash: 'square_hash', is_default: true },
            { image_hash: 'vertical_hash', placements: ['story', 'reels'] }
          ]
        })
      ).not.toThrow();
    });

    it('treats an asset with no placements as the default', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com',
          placement_assets: [
            { image_hash: 'square_hash' }, // implicit default
            { image_hash: 'vertical_hash', placements: ['stories'] }
          ]
        })
      ).not.toThrow();
    });

    it('throws when placement_assets has fewer than 2 items', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com',
          placement_assets: [{ image_hash: 'square_hash', is_default: true }]
        })
      ).toThrow('must be an array of at least 2 items');
    });

    it('throws when a placement asset has no image', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com',
          placement_assets: [
            { is_default: true } as any,
            { image_hash: 'vertical_hash', placements: ['reels'] }
          ]
        })
      ).toThrow('placement_assets[0] must have image_hash or image_url');
    });

    it('throws when no default placement asset is designated', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com',
          placement_assets: [
            { image_hash: 'feed_hash', placements: ['feed'] },
            { image_hash: 'vertical_hash', placements: ['reels'] }
          ]
        })
      ).toThrow('exactly one default/fallback image');
    });

    it('throws when more than one default placement asset is designated', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com',
          placement_assets: [
            { image_hash: 'a', is_default: true },
            { image_hash: 'b', is_default: true }
          ]
        })
      ).toThrow('exactly one default/fallback image');
    });

    it('throws for an unknown placement token', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com',
          placement_assets: [
            { image_hash: 'square_hash', is_default: true },
            { image_hash: 'vertical_hash', placements: ['banner_ad'] }
          ]
        })
      ).toThrow('unknown placement "banner_ad"');
    });

    it('throws when placement_assets is combined with video_id (mutually exclusive)', () => {
      expect(() =>
        MetaService.validateCreativeParams('CREATE', {
          name: 'Creative',
          page_id: 'p1',
          body: 'body',
          title: 'title',
          link_url: 'https://example.com',
          video_id: 'vid_123',
          image_hash: 'thumb',
          placement_assets: [
            { image_hash: 'square_hash', is_default: true },
            { image_hash: 'vertical_hash', placements: ['reels'] }
          ]
        })
      ).toThrow('mutually exclusive');
    });
  });

  // ===================== validatePlacementAssets (direct) =====================
  describe('validatePlacementAssets', () => {
    it('exposes the supported placement tokens', () => {
      expect(MetaService.supportedPlacementTokens).toEqual(
        expect.arrayContaining(['feed', 'story', 'stories', 'reels', 'instagram_reels'])
      );
    });

    it('accepts a raw customization_spec escape hatch without a known token', () => {
      expect(() =>
        MetaService.validatePlacementAssets([
          { image_hash: 'square', is_default: true },
          { image_hash: 'vertical', placements: ['anything'], customization_spec: { publisher_platforms: ['instagram'] } }
        ])
      ).not.toThrow();
    });
  });

  // ===================== validateAdParams =====================
  describe('validateAdParams', () => {
    it('is a no-op for non-CREATE actions', () => {
      expect(() => MetaService.validateAdParams('UPDATE', {})).not.toThrow();
      expect(() => MetaService.validateAdParams('DELETE', {})).not.toThrow();
    });

    it('passes for a valid CREATE payload', () => {
      expect(() =>
        MetaService.validateAdParams('CREATE', {
          name: 'My Ad',
          creative_id: 'creative_123',
          adset_id: 'adset_456'
        })
      ).not.toThrow();
    });

    it('throws when name is missing', () => {
      expect(() =>
        MetaService.validateAdParams('CREATE', {
          creative_id: 'creative_123',
          adset_id: 'adset_456'
        })
      ).toThrow('Ad CREATE requires "name".');
    });

    it('throws when creative_id is missing', () => {
      expect(() =>
        MetaService.validateAdParams('CREATE', {
          name: 'My Ad',
          adset_id: 'adset_456'
        })
      ).toThrow('Ad CREATE requires "creative_id".');
    });

    it('throws when adset_id is missing', () => {
      expect(() =>
        MetaService.validateAdParams('CREATE', {
          name: 'My Ad',
          creative_id: 'creative_123'
        })
      ).toThrow('Ad CREATE requires "ad_set_id"');
    });
  });
});
