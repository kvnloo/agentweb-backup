/**
 * ENG-2915 — the Meta-side half of multi-variant creatives (asset_feed_spec builder +
 * validator, shared with Emma's validateMetaActionParams) and the SSRF-safe media probe.
 */
import { MetaService } from '../services/metaService';
import { probePublicMediaUrl, SsrfBlockedError } from '../utils/ssrfGuard';

const base = { name: 'n', page_id: '42', link_url: 'https://shop.example.com', body: '', title: '' } as any;

describe('buildMultiVariantAssetFeedSpec', () => {
  it('maps every option into asset_feed_spec with a flexible format for mixed media', () => {
    const spec = MetaService.buildMultiVariantAssetFeedSpec({
      ...base, body: undefined, title: undefined,
      headlines: ['H1', 'H2'], bodies: ['B1'], descriptions: ['D1', 'D2'],
      image_hashes: ['ih1'], video_ids: ['111'], video_thumbnails: { '111': 'https://scontent/t.jpg' }, call_to_action_type: 'SHOP_NOW',
    });
    expect(spec).toEqual({
      titles: [{ text: 'H1' }, { text: 'H2' }],
      bodies: [{ text: 'B1' }],
      descriptions: [{ text: 'D1' }, { text: 'D2' }],
      images: [{ hash: 'ih1' }],
      videos: [{ video_id: '111', thumbnail_url: 'https://scontent/t.jpg' }],
      link_urls: [{ website_url: 'https://shop.example.com' }],
      call_to_action_types: ['SHOP_NOW'],
      ad_formats: ['AUTOMATIC_FORMAT'],
      optimization_type: 'DEGREES_OF_FREEDOM',
    });
  });

  it('uses SINGLE_IMAGE / SINGLE_VIDEO when only one media kind is present', () => {
    const img = MetaService.buildMultiVariantAssetFeedSpec({ ...base, body: undefined, title: undefined, headlines: ['H'], bodies: ['B'], image_hashes: ['a', 'b'] });
    expect(img.ad_formats).toEqual(['SINGLE_IMAGE']);
    expect(img.videos).toBeUndefined();
    const vid = MetaService.buildMultiVariantAssetFeedSpec({
      ...base, body: undefined, title: undefined, headlines: ['H'], bodies: ['B'], video_ids: ['1'], video_thumbnails: { '1': 'https://t' },
    });
    expect(vid.ad_formats).toEqual(['SINGLE_VIDEO']);
    expect(vid.images).toBeUndefined();
  });

  it('the shared validator accepts a multi-variant creative and refuses a video with no thumbnail', () => {
    const ok = { ...base, body: undefined, title: undefined, headlines: ['H'], bodies: ['B'], image_hashes: ['a'] };
    expect(() => MetaService.validateCreativeParams('CREATE', ok)).not.toThrow();
    expect(() => MetaService.validateCreativeParams('CREATE', { ...ok, video_ids: ['9'] })).toThrow(/video 9 has no thumbnail/);
    expect(() => MetaService.validateCreativeParams('CREATE', { ...ok, headlines: [] })).toThrow(/at least one entry in "headlines"/);
    expect(() => MetaService.validateCreativeParams('CREATE', { ...ok, image_hashes: ['a', 'a'] })).toThrow(/duplicate/);
  });

  it('leaves single-media creatives on the existing validator', () => {
    expect(MetaService.isMultiVariantCreative({ ...base, image_hash: 'h' })).toBe(false);
    expect(() => MetaService.validateCreativeParams('CREATE', { ...base, body: 'b', title: 't', image_hash: 'h' })).not.toThrow();
  });
});

describe('probePublicMediaUrl', () => {
  const pinned = { hostname: 'h', address: '104.18.1.1', family: 4 };

  it('follows redirects, re-resolving every hop, and returns the final URL + headers', async () => {
    const resolvePinned = jest.fn().mockResolvedValue(pinned);
    const requestHeaders = jest.fn()
      .mockResolvedValueOnce({ status: 302, headers: { location: 'https://cdn.example.com/v.mp4' } })
      .mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'video/mp4; codecs=avc1', 'content-length': '1234' } });
    const r = await probePublicMediaUrl('https://ugc.example.com/v/1', { resolvePinned, requestHeaders });
    expect(r).toEqual({ finalUrl: 'https://cdn.example.com/v.mp4', status: 200, contentType: 'video/mp4', contentLength: 1234 });
    expect(resolvePinned).toHaveBeenNthCalledWith(1, 'https://ugc.example.com/v/1');
    expect(resolvePinned).toHaveBeenNthCalledWith(2, 'https://cdn.example.com/v.mp4');
  });

  it('refuses a redirect to a private address before connecting to it', async () => {
    const resolvePinned = jest.fn()
      .mockResolvedValueOnce(pinned)
      .mockRejectedValueOnce(new SsrfBlockedError());
    const requestHeaders = jest.fn().mockResolvedValueOnce({ status: 301, headers: { location: 'https://169.254.169.254/latest' } });
    await expect(probePublicMediaUrl('https://ugc.example.com/v/1', { resolvePinned, requestHeaders })).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(requestHeaders).toHaveBeenCalledTimes(1);
  });

  it('refuses a downgrade to http and endless redirects', async () => {
    const resolvePinned = jest.fn().mockResolvedValue(pinned);
    await expect(probePublicMediaUrl('https://a.example.com', {
      resolvePinned,
      requestHeaders: jest.fn().mockResolvedValue({ status: 302, headers: { location: 'http://a.example.com/x' } }),
    })).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(probePublicMediaUrl('https://a.example.com', {
      resolvePinned,
      requestHeaders: jest.fn().mockResolvedValue({ status: 302, headers: { location: '/loop' } }),
    })).rejects.toThrow(/Too many redirects/);
  });
});
