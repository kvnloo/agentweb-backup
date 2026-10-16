/**
 * ENG-2313: contract tests for the tagged-link generator.
 *
 * The load-bearing test is the ROUND TRIP: for every preset, the link we generate must classify
 * back to the intended channel through classifyTraffic, with no referrer, with the platform's real
 * referrer origin, and (where the platform has one) its in-app browser User-Agent. That is the
 * guarantee that links handed to the team for launch actually attribute.
 */
import { classifyTraffic, CHANNELS, ORGANIC_MEDIUMS } from '../trafficSource';
import {
  MAX_BULK_ROWS,
  TaggedLinkError,
  buildTaggedLink,
  buildTaggedLinks,
  listTaggedLinkPresets,
  slugify,
  type TaggedLinkErrorCode,
  type TaggedLinkInput,
} from '../taggedLink';

const BASE = 'https://go.dramabreak.ai/guilty-before-the-mic-v2';
const IN_APP_UA: Record<string, string> = {
  tiktok: 'Mozilla/5.0 (iPhone) Mobile/15E148 musical_ly_35.1.0 BytedanceWebview/d8a21c6',
  instagram: 'Mozilla/5.0 (iPhone) Mobile/15E148 Instagram 330.0.0.20.113',
  facebook: 'Mozilla/5.0 (Linux; Android 13) [FB_IAB/FB4A;FBAV/450.0.0.38.108;]',
  linkedin: 'Mozilla/5.0 (iPhone) Mobile/15E148 LinkedInApp',
};
const input = (over: Partial<TaggedLinkInput> = {}): TaggedLinkInput => ({
  baseUrl: BASE, platform: 'tiktok', campaign: 'launch', content: 'ep3 teaser', postId: '1009', ...over,
});
const codeOf = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return e instanceof TaggedLinkError ? e.code : `non-TaggedLinkError: ${String(e)}`; }
  return undefined;
};

describe('buildTaggedLink: output contract', () => {
  it('produces the documented TikTok link (utm_content like tt-ep3-teaser-1009)', () => {
    const link = buildTaggedLink(input());
    expect(link.url).toBe(`${BASE}?utm_source=tiktok&utm_medium=bio&utm_campaign=launch&utm_content=tt-ep3-teaser-1009`);
    expect(link.params).toEqual({ utm_source: 'tiktok', utm_medium: 'bio', utm_campaign: 'launch', utm_content: 'tt-ep3-teaser-1009' });
    expect(link).toMatchObject({ platform: 'tiktok', channel: 'TikTok', channelKey: 'tiktok', channelGroup: 'Organic Social' });
  });

  it.each([
    ['Ep3 Teaser!!', 'ep3-teaser'], ['  Épisode_3 / Final  ', 'episode-3-final'], ['---a---b---', 'a-b'], ['日本語', ''], [undefined, ''],
  ])('slugify(%j) = %j', (raw, slug) => {
    expect(slugify(raw)).toBe(slug);
  });

  it('utm_content is just the platform code when no content/postId is given', () => {
    expect(buildTaggedLink(input({ content: undefined, postId: undefined })).params.utm_content).toBe('tt');
  });

  it('uses the preset default medium and accepts any organic medium', () => {
    expect(buildTaggedLink(input({ platform: 'youtube' })).params.utm_medium).toBe('description');
    expect(buildTaggedLink(input({ platform: 'newsletter' })).params.utm_medium).toBe('email');
    expect(buildTaggedLink(input({ medium: 'Story' })).params.utm_medium).toBe('story');
  });

  it('agency:<name> -> utm_source agency-<slug>, medium agency', () => {
    const link = buildTaggedLink(input({ platform: 'agency:Acme Media' }));
    expect(link.params).toMatchObject({ utm_source: 'agency-acme-media', utm_medium: 'agency', utm_content: expect.stringMatching(/^ag-/) });
    expect(link).toMatchObject({ platform: 'agency:acme-media', channel: 'Agency', channelGroup: 'Agency' });
  });

  it('preserves existing query params and the fragment, appending after them', () => {
    const link = buildTaggedLink(input({ baseUrl: `${BASE}?lang=en&Ref=x%20y#watch`, extra: { lp_variant: 'v2' } }));
    expect(link.url).toBe(`${BASE}?lang=en&Ref=x%20y&utm_source=tiktok&utm_medium=bio&utm_campaign=launch&utm_content=tt-ep3-teaser-1009&lp_variant=v2#watch`);
  });

  it('percent-encodes extra values', () => {
    expect(buildTaggedLink(input({ extra: { note: 'a b&c=d' } })).url).toContain('note=a%20b%26c%3Dd');
  });

  it('lists the presets the portal needs', () => {
    expect(listTaggedLinkPresets().map((p) => p.platform).sort()).toEqual(
      ['agency', 'facebook', 'instagram', 'linkedin', 'newsletter', 'pinterest', 'reddit', 'tiktok', 'x', 'youtube'],
    );
  });
});

describe('buildTaggedLink: never emits a duplicate or contradictory parameter', () => {
  const keysOf = (url: string) => [...new URL(url).searchParams.keys()];

  it.each(listTaggedLinkPresets().map((p) => p.platform === 'agency' ? 'agency:acme' : p.platform))('%s: each key appears once', (platform) => {
    const keys = keysOf(buildTaggedLink(input({ platform, extra: { lp_variant: 'v2' } })).url);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k === 'utm_source')).toHaveLength(1);
  });

  it.each([
    ['utm_source', 'base_url_reserved_param'], ['UTM_Medium', 'base_url_reserved_param'], ['utm_campaign', 'base_url_reserved_param'],
    ['fbclid', 'base_url_reserved_param'], ['gclid', 'base_url_reserved_param'], ['ad_id', 'base_url_reserved_param'], ['aw_lander', 'base_url_reserved_param'],
  ])('base URL already carrying %s is refused (never overwritten, never duplicated)', (key, code) => {
    expect(codeOf(() => buildTaggedLink(input({ baseUrl: `${BASE}?${key}=1` })))).toBe(code);
  });

  it.each(['utm_source', 'utm_term', 'gclid', 'fbclid', 'ttclid', 'li_fat_id', 'msclkid', 'ad_id', 'adset_id', 'campaign_id', 'aw_lander', 'AW_LANDER'])(
    'extra key %s is reserved', (key) => {
      expect(codeOf(() => buildTaggedLink(input({ extra: { [key]: '1' } })))).toBe('invalid_extra');
    },
  );

  it('extra cannot collide with a param already on the base URL', () => {
    expect(codeOf(() => buildTaggedLink(input({ baseUrl: `${BASE}?lang=en`, extra: { LANG: 'fr' } })))).toBe('invalid_extra');
  });
});

describe('buildTaggedLink: validation', () => {
  const bad: Array<[string, Partial<TaggedLinkInput>, TaggedLinkErrorCode]> = [
    ['empty baseUrl', { baseUrl: '' }, 'invalid_base_url'],
    ['non-string baseUrl', { baseUrl: 5 as unknown as string }, 'invalid_base_url'],
    ['relative baseUrl', { baseUrl: '/guilty' }, 'invalid_base_url'],
    ['http', { baseUrl: 'http://go.dramabreak.ai/x' }, 'base_url_not_https'],
    ['javascript:', { baseUrl: 'javascript:alert(1)' }, 'base_url_not_https'],
    ['credentials', { baseUrl: 'https://u:p@go.dramabreak.ai/x' }, 'invalid_base_url'],
    ['localhost', { baseUrl: 'https://localhost/x' }, 'invalid_base_url'],
    ['IP literal', { baseUrl: 'https://10.0.0.1/x' }, 'invalid_base_url'],
    ['baseUrl too long', { baseUrl: `https://go.dramabreak.ai/${'a'.repeat(1900)}` }, 'base_url_too_long'],
    ['host not in allow-list', { allowedHosts: ['dramabreak.ai'] }, 'base_url_host_not_allowed'],
    ['lookalike host vs wildcard', { baseUrl: 'https://evil-dramabreak.ai/x', allowedHosts: ['*.dramabreak.ai'] }, 'base_url_host_not_allowed'],
    ['unknown platform', { platform: 'myspace' }, 'unknown_platform'],
    ['prototype-key platform', { platform: 'constructor' }, 'unknown_platform'],
    ['agency without a name', { platform: 'agency' }, 'invalid_agency_name'],
    ['agency name too long', { platform: `agency:${'a'.repeat(40)}` }, 'invalid_agency_name'],
    ['missing campaign', { campaign: '' }, 'invalid_campaign'],
    ['campaign that slugs to nothing', { campaign: '!!!' }, 'invalid_campaign'],
    ['campaign too long', { campaign: 'a'.repeat(61) }, 'field_too_long'],
    ['content too long', { content: 'a'.repeat(41) }, 'field_too_long'],
    ['postId too long', { postId: 'a'.repeat(33) }, 'field_too_long'],
    ['paid medium', { medium: 'cpc' }, 'invalid_medium'],
    ['unlisted medium', { medium: 'carrier-pigeon' }, 'invalid_medium'],
    ['bad extra key', { extra: { 'bad key': '1' } }, 'invalid_extra'],
    ['empty extra value', { extra: { lp_variant: ' ' } }, 'invalid_extra'],
    ['too many extras', { extra: { a: '1', b: '1', c: '1', d: '1', e: '1', f: '1' } }, 'invalid_extra'],
    ['extra not an object', { extra: 'x' as unknown as Record<string, string> }, 'invalid_extra'],
  ];
  it.each(bad)('%s -> %s', (_n, over, code) => {
    expect(codeOf(() => buildTaggedLink(input(over)))).toBe(code);
  });

  it('coerces finite numbers for campaign/content/postId (JSON and CSV send numbers)', () => {
    expect(buildTaggedLink(input({ content: 'ep3 teaser', postId: 1009 as unknown as string })).params.utm_content).toBe('tt-ep3-teaser-1009');
    expect(buildTaggedLink(input({ campaign: 2026 as unknown as string })).params.utm_campaign).toBe('2026');
    expect(buildTaggedLink(input({ content: 3 as unknown as string, postId: 0 as unknown as string })).params.utm_content).toBe('tt-3-0');
    expect(buildTaggedLink(input({ content: null as unknown as string, postId: undefined })).params.utm_content).toBe('tt');
  });

  it.each([
    ['campaign', { campaign: {} }], ['campaign', { campaign: true }], ['campaign', { campaign: ['a'] }],
    ['content', { content: {} }], ['content', { content: NaN }], ['content', { content: Infinity }],
    ['postId', { postId: [1009] }], ['postId', { postId: false }], ['postId', { postId: {} }],
  ])('a non-string/non-number %s is a named error, never a silent drop', (field, over) => {
    let err: unknown;
    try { buildTaggedLink(input(over as unknown as Partial<TaggedLinkInput>)); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TaggedLinkError);
    expect((err as TaggedLinkError).code).toBe('invalid_field');
    expect((err as TaggedLinkError).message).toContain(field);
  });

  it.each([['x'], [5], [{}], [[1]], [['a'.repeat(254)]], [Array(21).fill('a.com')]])('allowedHosts of bad shape %j is a TaggedLinkError', (bad) => {
    expect(codeOf(() => buildTaggedLink(input({ allowedHosts: bad as unknown as string[] })))).toBe('invalid_allowed_hosts');
  });

  it('allow-list accepts exact and wildcard hosts', () => {
    expect(codeOf(() => buildTaggedLink(input({ allowedHosts: ['go.dramabreak.ai'] })))).toBeUndefined();
    expect(codeOf(() => buildTaggedLink(input({ allowedHosts: ['*.dramabreak.ai'] })))).toBeUndefined();
  });

  it('refuses a result over the URL length cap', () => {
    const long = `https://go.dramabreak.ai/x?${'q=1&'.repeat(5)}z=${'a'.repeat(1700)}`;
    expect(codeOf(() => buildTaggedLink(input({ baseUrl: long, extra: { n: 'b'.repeat(100) }, content: 'c'.repeat(40), postId: 'd'.repeat(32), campaign: 'e'.repeat(60) })))).toBe('url_too_long');
  });

  it('does not mutate its input', () => {
    const i = input({ extra: { lp_variant: 'v2' } });
    const snap = JSON.stringify(i);
    buildTaggedLink(i);
    expect(JSON.stringify(i)).toBe(snap);
  });
});

describe('ROUND TRIP: generated link -> classifyTraffic -> intended channel', () => {
  const presets = listTaggedLinkPresets();

  it.each(presets.map((p) => [p.platform, p] as const))('%s', (_name, preset) => {
    const platform = preset.platform === 'agency' ? 'agency:acme' : preset.platform;
    const link = buildTaggedLink(input({ platform }));
    const expected = { channel: preset.channel, channelKey: preset.channelKey, channelGroup: preset.channelGroup, trafficType: 'organic' as const };

    // no referrer (in-app browser / email / privacy mode)
    expect(classifyTraffic({ landingUrl: link.url })).toMatchObject({ ...expected, matchedBy: 'utm_source' });
    // the platform's real referrer origin
    if (preset.referrerOrigin) {
      expect(classifyTraffic({ landingUrl: link.url, referrer: preset.referrerOrigin })).toMatchObject(expected);
    }
    // 2.2.0 (DramaBreak decision, 2026-10-14): an OBSERVED contradictory referrer wins over the link's
    // tag (one link per creator is reposted across platforms); the tag survives as linkChannel.
    // Agency links are the exception: the agency is the attribution, whatever platform it posted on.
    const contra = classifyTraffic({ landingUrl: link.url, referrer: 'https://www.reddit.com/' });
    if (preset.channelKey === 'agency' || preset.channelKey === 'reddit') expect(contra).toMatchObject(expected);
    else expect(contra).toMatchObject({ channel: 'Reddit', matchedBy: 'referrer', linkChannel: preset.channel });
    // the platform's in-app browser UA, where there is one
    const ua = IN_APP_UA[preset.channelKey];
    if (ua) {
      expect(classifyTraffic({ landingUrl: link.url, userAgent: ua })).toMatchObject(expected);
      expect(classifyTraffic({ landingUrl: link.url, referrer: preset.referrerOrigin ?? undefined, userAgent: ua })).toMatchObject(expected);
    }
    // sanity: sourceDetail carries the full placement tag
    expect(classifyTraffic({ landingUrl: link.url }).sourceDetail).toContain(`utm_content=${link.params.utm_content}`);
  });

  it('every mediums x every preset still classifies organic to the intended channel', () => {
    for (const p of presets) {
      for (const medium of ORGANIC_MEDIUMS) {
        const link = buildTaggedLink(input({ platform: p.platform === 'agency' ? 'agency:acme' : p.platform, medium }));
        expect(classifyTraffic({ landingUrl: link.url })).toMatchObject({ channelKey: p.channelKey, trafficType: 'organic' });
      }
    }
  });

  it('presets cover every taggable channel in the taxonomy', () => {
    const taggable = CHANNELS.filter((c) => c.link).map((c) => c.key).sort();
    expect(presets.map((p) => p.channelKey).sort()).toEqual(taggable);
  });

  it('a preserved base query (including a pinned lp_variant) does not disturb classification', () => {
    const link = buildTaggedLink(input({ platform: 'instagram', baseUrl: `${BASE}?lp_variant=v2&lang=en#x`, extra: { src: 'bio' } }));
    expect(classifyTraffic({ landingUrl: link.url, referrer: 'https://l.instagram.com/' })).toMatchObject({ channel: 'Instagram', trafficType: 'organic' });
  });
});

describe('buildTaggedLinks (bulk / CSV rows)', () => {
  it('returns one result per row in order; a bad row does not fail the batch', () => {
    const results = buildTaggedLinks(
      [{ platform: 'tiktok', content: 'a' }, { platform: 'nope' }, { platform: 'x', campaign: 'override', content: '' }],
      { baseUrl: BASE, campaign: 'launch' },
    );
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1]).toMatchObject({ index: 1, ok: false, error: { code: 'unknown_platform' } });
    expect(results[2]).toMatchObject({ ok: true, link: { params: { utm_campaign: 'override', utm_content: 'x' } } });
  });

  it('treats blank CSV cells as absent so defaults apply', () => {
    const [r] = buildTaggedLinks([{ platform: 'tiktok', campaign: '', baseUrl: '  ' }], { baseUrl: BASE, campaign: 'launch' });
    expect(r).toMatchObject({ ok: true });
  });

  it('a row-level allowedHosts of bad shape is that row\'s error, not a crash', () => {
    const results = buildTaggedLinks([{ platform: 'tiktok', campaign: 'a', allowedHosts: 'x' as unknown as string[] }, { platform: 'tiktok' }], { baseUrl: BASE, campaign: 'c' });
    expect(results[0]).toMatchObject({ ok: false, error: { code: 'invalid_allowed_hosts' } });
    expect(results[1]).toMatchObject({ ok: true });
  });

  it('an unexpected non-TaggedLinkError becomes a generic row error and is logged, never thrown', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = { platform: 'tiktok', get campaign(): string { throw new Error('secret internal detail'); } };
    const results = buildTaggedLinks([boom, { platform: 'x' }], { baseUrl: BASE, campaign: 'c' });
    expect(results[0]).toEqual({ index: 0, ok: false, error: { code: 'invalid_row', message: 'row could not be processed' } });
    expect(JSON.stringify(results[0])).not.toContain('secret');
    expect(results[1]).toMatchObject({ ok: true });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('non-object rows are per-row errors', () => {
    const results = buildTaggedLinks([null as never, 'x' as never], { baseUrl: BASE, campaign: 'c' });
    expect(results.every((r) => !r.ok)).toBe(true);
  });

  it('caps at MAX_BULK_ROWS and rejects an empty batch', () => {
    const row = { platform: 'tiktok' };
    expect(buildTaggedLinks(Array(MAX_BULK_ROWS).fill(row), { baseUrl: BASE, campaign: 'c' })).toHaveLength(200);
    expect(codeOf(() => buildTaggedLinks(Array(MAX_BULK_ROWS + 1).fill(row)))).toBe('too_many_rows');
    expect(codeOf(() => buildTaggedLinks([]))).toBe('invalid_rows');
  });
});
