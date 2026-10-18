/**
 * ENG-2313: contract tests for the server-side traffic-source classifier.
 *
 * Three groups, each answering a different review question:
 *   1. V1 PARITY   - inputs where the original client-side classifier (LP PRs #30/#31) and this
 *                    implementation must agree, so rows already written by V1 stay comparable.
 *                    Expected values were produced by running the V1 source itself.
 *   2. INTENTIONAL - every deliberate difference from V1, with the reason.
 *   3. INVARIANTS  - taxonomy/alignment properties and "never throws".
 */
import { buildUtmSpec, UTM_MEDIUM_PAID } from '../adUtm';
import { matchRoutingRules } from '../trackingConfig';
import { splitPaidChannel,
  CHANNELS,
  CHANNEL_GROUPS,
  ORGANIC_MEDIUMS,
  TRAFFIC_CLASSIFIER_VERSION,
  classifyTraffic,
  getTrafficTaxonomy,
  paidMediumToken,
  type ClassifyTrafficInput,
} from '../trafficSource';

const LP = 'https://go.dramabreak.ai/guilty-before-the-mic-v2';
const lp = (q = '') => (q ? `${LP}?${q}` : LP);

const UA = {
  tiktok: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 musical_ly_35.1.0 BytedanceWebview/d8a21c6',
  instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 330.0.0.20.113',
  facebook: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.38.108;]',
  linkedin: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 LinkedInApp',
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  crawler: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
};

type Expect = Partial<ReturnType<typeof classifyTraffic>>;
const run = (input: ClassifyTrafficInput) => classifyTraffic(input);

describe('classifyTraffic: V1 parity (must not change)', () => {
  const cases: Array<[string, ClassifyTrafficInput, Expect]> = [
    ['utm_source=tiktok', { landingUrl: lp('utm_source=tiktok&utm_medium=bio') }, { trafficType: 'organic', channel: 'TikTok', channelGroup: 'Organic Social' }],
    ['utm_source mixed case', { landingUrl: lp('utm_source=TikTok') }, { channel: 'TikTok', sourceDetail: 'utm_source=TikTok' }],
    ['utm_source instagram_stories (substring in V1)', { landingUrl: lp('utm_source=instagram_stories') }, { channel: 'Instagram' }],
    ['utm_source tiktokads (substring in V1)', { landingUrl: lp('utm_source=tiktokads') }, { channel: 'TikTok' }],
    ['utm_source chatgpt.com', { landingUrl: lp('utm_source=chatgpt.com') }, { channel: 'ChatGPT', channelGroup: 'AI Assistant' }],
    ['utm_source l.instagram.com', { landingUrl: lp('utm_source=l.instagram.com') }, { channel: 'Instagram' }],
    ['utm_source out.reddit.com', { landingUrl: lp('utm_source=out.reddit.com') }, { channel: 'Reddit' }],
    ['utm_source t.co', { landingUrl: lp('utm_source=t.co') }, { channel: 'X' }],
    ['unknown utm_source stays raw, group Referral', { landingUrl: lp('utm_source=creator_john') }, { channel: 'creator_john', channelGroup: 'Referral' }],
    ['unknown utm_source + known referrer -> referrer decides', { landingUrl: lp('utm_source=creator_john'), referrer: 'https://l.instagram.com/' }, { channel: 'Instagram' }],
    // 2.2.0: observed referrer beats the link's tag; the tag is kept as linkChannel.
    ['observed referrer beats utm_source (2.2.0)', { landingUrl: lp('utm_source=tiktok'), referrer: 'https://l.instagram.com/' }, { channel: 'Instagram', linkChannel: 'TikTok', detectedChannel: 'Instagram', matchedBy: 'referrer' }],
    ['utm_source is capped at 40 chars in the fallback channel', { landingUrl: lp(`utm_source=${'a'.repeat(80)}`) }, { channel: 'a'.repeat(40) }],
    ['referrer l.instagram.com', { landingUrl: lp(), referrer: 'https://l.instagram.com/' }, { channel: 'Instagram', referrerHost: 'l.instagram.com', sourceLink: '' }],
    ['referrer lm.facebook.com', { landingUrl: lp(), referrer: 'https://lm.facebook.com/' }, { channel: 'Facebook' }],
    ['referrer lnkd.in', { landingUrl: lp(), referrer: 'https://lnkd.in/abc' }, { channel: 'LinkedIn' }],
    ['referrer t.co', { landingUrl: lp(), referrer: 'https://t.co/xyz' }, { channel: 'X' }],
    ['referrer youtu.be', { landingUrl: lp(), referrer: 'https://youtu.be/q' }, { channel: 'YouTube' }],
    ['referrer out.reddit.com', { landingUrl: lp(), referrer: 'https://out.reddit.com/t3_x' }, { channel: 'Reddit' }],
    ['referrer pinterest.co.uk', { landingUrl: lp(), referrer: 'https://www.pinterest.co.uk/' }, { channel: 'Pinterest' }],
    ['referrer google.co.uk search', { landingUrl: lp(), referrer: 'https://www.google.co.uk/search?q=drama' }, { channel: 'Google Search', channelGroup: 'Organic Search' }],
    ['referrer duckduckgo', { landingUrl: lp(), referrer: 'https://duckduckgo.com/' }, { channel: 'DuckDuckGo' }],
    ['referrer search.yahoo.com', { landingUrl: lp(), referrer: 'https://search.yahoo.com/' }, { channel: 'Other Search' }],
    ['referrer chat.openai.com', { landingUrl: lp(), referrer: 'https://chat.openai.com/' }, { channel: 'ChatGPT' }],
    ['referrer claude.ai', { landingUrl: lp(), referrer: 'https://claude.ai/chat/1' }, { channel: 'Claude' }],
    ['referrer gemini.google.com (not Google Search)', { landingUrl: lp(), referrer: 'https://gemini.google.com/app' }, { channel: 'Gemini' }],
    ['referrer perplexity', { landingUrl: lp(), referrer: 'https://www.perplexity.ai/search/x' }, { channel: 'Perplexity' }],
    ['referrer copilot.microsoft.com', { landingUrl: lp(), referrer: 'https://copilot.microsoft.com/' }, { channel: 'Copilot' }],
    ['referrer meta.ai', { landingUrl: lp(), referrer: 'https://meta.ai/' }, { channel: 'Other AI' }],
    ['referrer threads.net', { landingUrl: lp(), referrer: 'https://www.threads.net/' }, { channel: 'Other Social' }],
    ['unknown referrer host -> host, Referral', { landingUrl: lp(), referrer: 'https://random-blog.example/post/1' }, { channel: 'random-blog.example', channelGroup: 'Referral', referrerHost: 'random-blog.example', sourceLink: 'https://random-blog.example/post/1' }],
    ['source_link only with a path', { landingUrl: lp(), referrer: 'https://www.reddit.com/r/drama/comments/abc/title/' }, { sourceLink: 'https://www.reddit.com/r/drama/comments/abc/title/' }],
    ['origin-only referrer without trailing slash has no source_link', { landingUrl: lp(), referrer: 'https://www.reddit.com' }, { sourceLink: '' }],
    ['in-app UA TikTok', { landingUrl: lp(), userAgent: UA.tiktok }, { channel: 'TikTok', channelGroup: 'Organic Social' }],
    ['in-app UA Instagram', { landingUrl: lp(), userAgent: UA.instagram }, { channel: 'Instagram' }],
    ['in-app UA Facebook', { landingUrl: lp(), userAgent: UA.facebook }, { channel: 'Facebook' }],
    ['in-app UA LinkedIn', { landingUrl: lp(), userAgent: UA.linkedin }, { channel: 'LinkedIn' }],
    ['plain desktop UA is direct', { landingUrl: lp(), userAgent: UA.desktop }, { channel: 'Direct', channelGroup: 'Direct' }],
    ['link-preview crawler UA is not Facebook in-app', { landingUrl: lp(), userAgent: UA.crawler }, { channel: 'Direct' }],
    // 2.2.0: the in-app browser is where the visitor physically is; it beats the referrer.
    ['in-app UA beats referrer (2.2.0)', { landingUrl: lp(), referrer: 'https://www.reddit.com/', userAgent: UA.tiktok }, { channel: 'TikTok', matchedBy: 'user_agent' }],
    ['unknown referrer + in-app UA -> UA decides', { landingUrl: lp(), referrer: 'https://example.org/', userAgent: UA.instagram }, { channel: 'Instagram', referrerHost: 'example.org' }],
    ['direct', { landingUrl: lp() }, { trafficType: 'organic', channel: 'Direct', channelGroup: 'Direct', referrerHost: '', sourceLink: '', sourceDetail: '' }],
    ['source_detail lists all keys in V1 order', { landingUrl: lp('post=p&utm_term=t&utm_content=tt-1&utm_campaign=c&utm_medium=bio&utm_source=tiktok&ref=r&src=s') }, { sourceDetail: 'utm_source=tiktok | utm_medium=bio | utm_campaign=c | utm_content=tt-1 | utm_term=t | ref=r | src=s | post=p' }],
    ['duplicate utm_source: first wins', { landingUrl: lp('utm_source=tiktok&utm_source=instagram') }, { channel: 'TikTok' }],
    ['internal referrer (same host) is no source', { landingUrl: lp(), referrer: 'https://go.dramabreak.ai/other' }, { channel: 'Direct', referrerHost: '' }],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(run(input)).toMatchObject(expected);
  });

  it('paid: every V1 click id marks the visit paid and forces group Paid', () => {
    for (const id of ['fbclid', 'ad_id', 'adset_id', 'campaign_id', 'gclid', 'gbraid', 'wbraid', 'ttclid', 'li_fat_id', 'msclkid']) {
      const r = run({ landingUrl: lp(`utm_source=tiktok&${id}=abc`) });
      expect(r).toMatchObject({ trafficType: 'paid', channel: 'TikTok', channelGroup: 'Paid', paidSignal: `click_id:${id}` });
    }
  });

  it.each([
    ['cpc', true], ['ppc', true], ['cpm', true], ['paid', true], ['Paid', true], ['paid_social', true], ['paid-social', true],
    ['paidsocial', true], ['display', true], ['ad', true], ['ads', true], ['organic', false], ['bio', false], ['unpaid', false], ['email', false], ['', false],
  ])('utm_medium=%s paid=%s', (medium, paid) => {
    expect(run({ landingUrl: lp(`utm_source=facebook&utm_medium=${medium}`) }).trafficType).toBe(paid ? 'paid' : 'organic');
  });
});

describe('classifyTraffic: intentional differences from V1', () => {
  const cases: Array<[string, ClassifyTrafficInput, Expect]> = [
    // utm_source aliases: V1 only had substring rules, so these fell through to a raw-string channel.
    ['alias ig', { landingUrl: lp('utm_source=ig') }, { channel: 'Instagram', channelGroup: 'Organic Social' }],
    ['alias fb', { landingUrl: lp('utm_source=fb') }, { channel: 'Facebook' }],
    ['alias yt', { landingUrl: lp('utm_source=yt') }, { channel: 'YouTube' }],
    ['alias tt', { landingUrl: lp('utm_source=tt') }, { channel: 'TikTok' }],
    ['alias li', { landingUrl: lp('utm_source=li') }, { channel: 'LinkedIn' }],
    ['alias x (V1 only had ^x.com)', { landingUrl: lp('utm_source=x') }, { channel: 'X' }],
    ['alias twitter', { landingUrl: lp('utm_source=Twitter') }, { channel: 'X' }],
    ['alias separators: tik-tok', { landingUrl: lp('utm_source=tik-tok') }, { channel: 'TikTok' }],
    ['bare gemini (V1 needed gemini.google)', { landingUrl: lp('utm_source=gemini') }, { channel: 'Gemini', channelGroup: 'AI Assistant' }],
    ['bare claude (V1 needed claude.ai)', { landingUrl: lp('utm_source=claude') }, { channel: 'Claude' }],
    ['bare copilot (V1 needed copilot.microsoft)', { landingUrl: lp('utm_source=copilot') }, { channel: 'Copilot' }],
    ['bare google (adUtm.ts emits utm_source=google)', { landingUrl: lp('utm_source=google') }, { channel: 'Google Search', channelGroup: 'Organic Search' }],
    ['bare meta (adUtm.ts emits utm_source=meta)', { landingUrl: lp('utm_source=meta') }, { channel: 'Meta' }],
    ['newsletter is Email', { landingUrl: lp('utm_source=newsletter') }, { channel: 'Email', channelGroup: 'Email' }],
    ['whitespace around utm_source is trimmed', { landingUrl: lp('utm_source=%20tiktok%20') }, { channel: 'TikTok', sourceDetail: 'utm_source=tiktok' }],
    ['UTM_SOURCE key case is ignored', { landingUrl: lp('UTM_SOURCE=tiktok') }, { channel: 'TikTok' }],
    ['literal "undefined" (template bug) is no source', { landingUrl: lp('utm_source=undefined') }, { channel: 'Direct', sourceDetail: '' }],
    ['structured utm wins over landing URL', { landingUrl: lp('utm_source=tiktok'), utm: { source: 'reddit' } }, { channel: 'Reddit' }],

    // Unanchored regexes that matched unintended hosts.
    ['you.com regex no longer matches bayou.com (host)', { landingUrl: lp(), referrer: 'https://bayou.com/' }, { channel: 'bayou.com', channelGroup: 'Referral' }],
    ['you.com regex no longer matches bayou.com (utm)', { landingUrl: lp('utm_source=bayou.com') }, { channel: 'bayou.com' }],
    ['meta.ai regex no longer matches xmeta.ai', { landingUrl: lp(), referrer: 'https://xmeta.ai/' }, { channel: 'xmeta.ai' }],
    ['bing. regex no longer matches dubbing.com', { landingUrl: lp(), referrer: 'https://www.dubbing.com/' }, { channel: 'dubbing.com' }],
    ['youtube lookalike host is not YouTube', { landingUrl: lp(), referrer: 'https://www.youtube.com.evil.com/' }, { channel: 'youtube.com.evil.com', channelGroup: 'Referral' }],
    ['keyword in referrer path/query no longer classifies', { landingUrl: lp(), referrer: 'https://example.com/blog/best-instagram-tips' }, { channel: 'example.com' }],
    ['keyword in referrer query no longer classifies', { landingUrl: lp(), referrer: 'https://example.com/?u=tiktok' }, { channel: 'example.com' }],
    ['subdomain of x.com (V1 ^x.com)', { landingUrl: lp(), referrer: 'https://mobile.x.com/home' }, { channel: 'X' }],
    ['openai.com site is not ChatGPT', { landingUrl: lp(), referrer: 'https://openai.com/index/x' }, { channel: 'openai.com', channelGroup: 'Referral' }],
    ['brave.com site is not Brave Search', { landingUrl: lp(), referrer: 'https://www.brave.com/blog' }, { channel: 'brave.com' }],
    ['Google News is not Google Search', { landingUrl: lp(), referrer: 'https://news.google.com/x' }, { channel: 'news.google.com', channelGroup: 'Referral' }],
    ['Gmail web is Email, not Google Search', { landingUrl: lp(), referrer: 'https://mail.google.com/mail/u/0/' }, { channel: 'Email', channelGroup: 'Email' }],
    ['threads.com (renamed from threads.net)', { landingUrl: lp(), referrer: 'https://www.threads.com/' }, { channel: 'Other Social' }],

    // bing.com/chat was unreachable with origin-only referrers; it works when a path IS sent, and is anchored to the host.
    ['bing.com/chat with a path is Copilot', { landingUrl: lp(), referrer: 'https://www.bing.com/chat' }, { channel: 'Copilot', channelGroup: 'AI Assistant' }],
    ['bing.com/search is still Bing', { landingUrl: lp(), referrer: 'https://www.bing.com/search?q=chat' }, { channel: 'Bing Search' }],
    ['origin-only bing.com stays Bing (cannot see /chat)', { landingUrl: lp(), referrer: 'https://www.bing.com/' }, { channel: 'Bing Search' }],
    ['"bing.com/chat" in a foreign path is not Copilot', { landingUrl: lp(), referrer: 'https://example.com/redirect/bing.com/chat' }, { channel: 'example.com' }],

    // android-app referrers
    ['Gmail app', { landingUrl: lp(), referrer: 'android-app://com.google.android.gm' }, { channel: 'Email', referrerHost: 'com.google.android.gm', sourceLink: '' }],
    ['Google app is search', { landingUrl: lp(), referrer: 'android-app://com.google.android.googlequicksearchbox' }, { channel: 'Google Search', sourceLink: '' }],
    ['Instagram app', { landingUrl: lp(), referrer: 'android-app://com.instagram.android/' }, { channel: 'Instagram' }],
    ['utm_source host-like android-app', { landingUrl: lp(), utm: { source: 'android-app://com.google.android.gm' } }, { channel: 'Email' }],
    ['unknown android-app package falls back to the package id', { landingUrl: lp(), referrer: 'android-app://com.example.app' }, { channel: 'com.example.app', channelGroup: 'Referral' }],

    // internal referrers
    ['internal referrer path keyword is ignored (V1: Instagram)', { landingUrl: lp(), referrer: 'https://go.dramabreak.ai/instagram-story-drama' }, { channel: 'Direct', referrerHost: '', sourceLink: '' }],
    ['parent-domain referrer is internal', { landingUrl: lp(), referrer: 'https://dramabreak.ai/' }, { channel: 'Direct', referrerHost: '' }],
    ['www on either side is ignored', { landingUrl: lp(), referrer: 'https://www.go.dramabreak.ai/' }, { channel: 'Direct' }],
    ['explicit hostname param is honoured', { referrer: 'https://app.example.com/x', hostname: 'app.example.com' }, { channel: 'Direct' }],
    ['multi-tenant suffix siblings are NOT internal', { landingUrl: 'https://a.vercel.app/x', referrer: 'https://b.vercel.app/' }, { channel: 'b.vercel.app' }],
    ['a different site that merely ends alike is not internal', { landingUrl: 'https://go.dramabreak.ai/x', referrer: 'https://notdramabreak.ai/' }, { channel: 'notdramabreak.ai' }],
    ['internal referrer does not hide a real utm_source', { landingUrl: lp('utm_source=tiktok'), referrer: 'https://go.dramabreak.ai/x' }, { channel: 'TikTok' }],

    // garbage referrers
    ['free text referrer is not matched (V1: TikTok)', { landingUrl: lp(), referrer: 'i saw this on tiktok' }, { channel: 'Direct', sourceLink: '' }],
    ['about:blank / null referrers are nothing', { landingUrl: lp(), referrer: 'about:blank' }, { channel: 'Direct', sourceLink: '' }],
    ['scheme-less host referrer is accepted', { landingUrl: lp(), referrer: 'www.tiktok.com/@x/video/1' }, { channel: 'TikTok', referrerHost: 'tiktok.com', sourceLink: 'www.tiktok.com/@x/video/1' }],

    // agency tags outrank the referrer
    ['agency-<slug> outranks the platform referrer', { landingUrl: lp('utm_source=agency-acme&utm_medium=agency'), referrer: 'https://www.tiktok.com/' }, { channel: 'Agency', channelGroup: 'Agency', referrerHost: 'tiktok.com' }],

    // click ids
    ['fbclid with no other signal names Meta (V1: Direct/Paid)', { landingUrl: lp('fbclid=IwAR1') }, { trafficType: 'paid', channel: 'Meta', channelGroup: 'Paid', matchedBy: 'click_id' }],
    ['gclid with no other signal names Google Ads', { landingUrl: lp('gclid=abc') }, { trafficType: 'paid', channel: 'Google Ads', channelKey: 'google_ads', channelGroup: 'Paid' }],
    ['google referrer + gclid is Google Ads', { landingUrl: lp('gclid=abc'), referrer: 'https://www.google.com/' }, { channel: 'Google Ads', channelKey: 'google_ads' }],
    ['utm_source=adwords&utm_medium=cpc is Google Ads', { landingUrl: lp('utm_source=adwords&utm_medium=cpc') }, { channel: 'Google Ads', channelGroup: 'Paid' }],
    ['organic google referrer stays Google Search', { landingUrl: lp(), referrer: 'https://www.google.com/' }, { trafficType: 'organic', channel: 'Google Search', channelKey: 'google_search', channelGroup: 'Organic Search' }],
    ['paid youtube is YouTube Ads', { landingUrl: lp('utm_source=youtube&utm_medium=cpv') }, { channel: 'YouTube Ads', channelKey: 'youtube_ads', channelGroup: 'Paid' }],
    ['organic youtube stays YouTube', { landingUrl: lp('utm_source=youtube&utm_medium=description') }, { channel: 'YouTube', channelKey: 'youtube', trafficType: 'organic' }],
    ['ttclid names TikTok', { landingUrl: lp('ttclid=E.C.P') }, { channel: 'TikTok', channelGroup: 'Paid' }],
    ['ad_id alone cannot name a platform: still Direct/Paid', { landingUrl: lp('ad_id=123') }, { trafficType: 'paid', channel: 'Direct', channelGroup: 'Paid' }],
    ['click id never overrides an explicit utm_source', { landingUrl: lp('utm_source=creator_john&gclid=abc') }, { channel: 'creator_john', channelGroup: 'Paid' }],
    ['whitespace-only click id is not a click id (V1: paid)', { landingUrl: lp('fbclid=%20') }, { trafficType: 'organic' }],
    ['click ids can come structured (liFatId)', { clickIds: { liFatId: '7' } }, { trafficType: 'paid', channel: 'LinkedIn', paidSignal: 'click_id:li_fat_id' }],

    // paid medium
    ['"non-paid" is not paid (V1: paid)', { landingUrl: lp('utm_source=facebook&utm_medium=non-paid') }, { trafficType: 'organic' }],
    ['"no_ads" is not paid (V1: paid)', { landingUrl: lp('utm_source=facebook&utm_medium=no_ads') }, { trafficType: 'organic' }],
    ['cpv is paid', { landingUrl: lp('utm_source=youtube&utm_medium=cpv') }, { trafficType: 'paid', paidSignal: 'utm_medium:cpv' }],
    ['retargeting is paid', { landingUrl: lp('utm_source=facebook&utm_medium=retargeting') }, { trafficType: 'paid' }],

    // fbclid is a WEAK paid signal: Facebook/Instagram append it to organic outbound clicks too.
    ['fbclid + utm_medium=bio is organic Instagram (our own tagged link)', { landingUrl: lp('utm_source=instagram&utm_medium=bio&utm_campaign=x&fbclid=AAA'), referrer: 'https://l.instagram.com/' }, { trafficType: 'organic', channel: 'Instagram', channelGroup: 'Organic Social', paidSignal: null }],
    ['fbclid + referrer l.facebook.com + medium=post is organic Facebook', { landingUrl: lp('utm_medium=post&fbclid=AAA'), referrer: 'https://l.facebook.com/' }, { trafficType: 'organic', channel: 'Facebook', channelGroup: 'Organic Social' }],
    ['fbclid + ad_id is paid (strong wins)', { landingUrl: lp('utm_source=instagram&fbclid=AAA&ad_id=1') }, { trafficType: 'paid', paidSignal: 'click_id:ad_id' }],
    ['fbclid + utm_medium=paid is paid', { landingUrl: lp('utm_source=instagram&utm_medium=paid&fbclid=AAA') }, { trafficType: 'paid', paidSignal: 'utm_medium:paid' }],
    ['fbclid + medium=bio + ad_id is paid (strong wins over organic medium)', { landingUrl: lp('utm_source=instagram&utm_medium=bio&fbclid=AAA&ad_id=1') }, { trafficType: 'paid', paidSignal: 'click_id:ad_id' }],
    ['fbclid alone (untagged) is paid, as in V1', { landingUrl: lp('fbclid=AAA') }, { trafficType: 'paid', channelGroup: 'Paid', paidSignal: 'click_id:fbclid' }],
    ['fbclid + a non-organic custom medium is paid', { landingUrl: lp('utm_source=instagram&utm_medium=social&fbclid=AAA') }, { trafficType: 'paid' }],
    ['fbclid + structured organic medium is organic', { utm: { source: 'instagram', medium: 'Story' }, clickIds: { fbclid: 'AAA' } }, { trafficType: 'organic', channel: 'Instagram' }],

    // hostOf: a path-only landing URL has no host (was a bogus host via https:///path)
    ['path-only landingUrl has no host, so a same-named referrer is not "internal"', { landingUrl: '/guilty-before-the-mic-v2?x=1', referrer: 'https://guilty-before-the-mic-v2/' }, { channel: 'guilty-before-the-mic-v2', referrerHost: 'guilty-before-the-mic-v2' }],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(run(input)).toMatchObject(expected);
  });

  it('keeps the known V1 limitation: UNTAGGED fbclid alone is paid even on organic Facebook/Instagram clicks', () => {
    // Facebook appends fbclid to ALL outbound clicks, organic included, so an untagged fbclid-only
    // visit cannot be separated from a paid one. Pinned (not "fixed"); tagged organic links are handled above.
    expect(run({ landingUrl: lp('fbclid=IwAR1'), userAgent: UA.instagram })).toMatchObject({ trafficType: 'paid', channel: 'Instagram', channelGroup: 'Paid' });
  });
});

describe('classifyTraffic: invariants', () => {
  it('stamps the classifier version', () => {
    expect(run({}).classifierVersion).toBe(TRAFFIC_CLASSIFIER_VERSION);
  });

  it('never throws and returns a Direct/organic result on garbage of any type', () => {
    const junk: unknown[] = [undefined, null, 0, 1, true, '', ' ', 'x', [], {}, () => 1, Symbol('s'), 'http://', 'https://[', '\u0000', '%', '?', '?&&==', 'a'.repeat(100000)];
    for (const v of junk) {
      for (const input of [
        { landingUrl: v, referrer: v, userAgent: v, hostname: v, utm: v, clickIds: v },
        { utm: { source: v, medium: v }, clickIds: { gclid: v } },
      ]) {
        const r = classifyTraffic(input as unknown as ClassifyTrafficInput);
        expect(['paid', 'organic']).toContain(r.trafficType);
        expect(CHANNEL_GROUPS).toContain(r.channelGroup);
        expect(r.sourceDetail.length).toBeLessThanOrEqual(300);
        expect(r.sourceLink.length).toBeLessThanOrEqual(300);
      }
    }
    expect(classifyTraffic(null as unknown as ClassifyTrafficInput).channel).toBe('Direct');
  });

  it('is deterministic and does not mutate its input', () => {
    const input: ClassifyTrafficInput = { landingUrl: lp('utm_source=tiktok'), utm: { medium: 'bio' }, clickIds: { gclid: 'x' }, referrer: 'https://t.co/a' };
    const snapshot = JSON.stringify(input);
    expect(run(input)).toEqual(run(input));
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('taxonomy: keys are unique and every channel group is a declared group', () => {
    const keys = CHANNELS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of CHANNELS) expect(CHANNEL_GROUPS).toContain(c.group);
    expect(getTrafficTaxonomy().channels).toBe(CHANNELS);
  });

  it('taxonomy: the utm_source each platform should use classifies back to that channel', () => {
    for (const c of CHANNELS.filter((x) => x.utmSource && !x.utmSource.includes('<'))) {
      expect(run({ landingUrl: lp(`utm_source=${c.utmSource}`) })).toMatchObject({ channelKey: c.key, channel: c.name, channelGroup: c.group });
    }
  });

  it('taxonomy: every alias, host and app package classifies to its own channel', () => {
    for (const c of CHANNELS) {
      for (const a of c.utmAliases) expect(run({ landingUrl: lp(`utm_source=${a}`) }).channelKey).toBe(c.key);
      for (const h of c.hosts) expect(run({ referrer: `https://${h}/`, hostname: 'lp.example' }).channelKey).toBe(c.key);
      for (const p of c.appPackages ?? []) expect(run({ referrer: `android-app://${p}`, hostname: 'lp.example' }).channelKey).toBe(c.key);
    }
  });

  it('every organic utm_medium we publish reads as organic', () => {
    for (const m of ORGANIC_MEDIUMS) {
      expect(paidMediumToken(m)).toBeNull();
      expect(run({ landingUrl: lp(`utm_source=tiktok&utm_medium=${m}`) }).trafficType).toBe('organic');
    }
  });

  it('splitPaidChannel is idempotent and leaves organic/other channels alone (backfill-safe)', () => {
    expect(splitPaidChannel('Google Search', 'google_search', true)).toEqual({ channel: 'Google Ads', channelKey: 'google_ads' });
    expect(splitPaidChannel('Google Ads', 'google_ads', true)).toEqual({ channel: 'Google Ads', channelKey: 'google_ads' });
    expect(splitPaidChannel('Google Search', 'google_search', false)).toEqual({ channel: 'Google Search', channelKey: 'google_search' });
    expect(splitPaidChannel('Meta', 'meta', true)).toEqual({ channel: 'Meta', channelKey: 'meta' });
  });

  it('aligns with adUtm.ts: ad links Emma builds classify as paid on their platform', () => {
    for (const [platform, channel] of [['meta', 'Meta'], ['google', 'Google Ads'], ['linkedin', 'LinkedIn']] as const) {
      const spec = buildUtmSpec(platform, { campaign: 'c1' });
      expect(spec.medium).toBe(UTM_MEDIUM_PAID);
      expect(run({ utm: { source: spec.source, medium: spec.medium, campaign: spec.campaign } })).toMatchObject({
        trafficType: 'paid', channel, channelGroup: 'Paid',
      });
    }
  });
});

describe('paid channel split: routing compatibility', () => {
  it('a pre-2.1.0 google_search rule still routes paid Google Ads sessions; google_ads rule routes only paid', () => {
    const paid = classifyTraffic({ landingUrl: 'https://lp.example.com/?gclid=x' });
    const organic = classifyTraffic({ landingUrl: 'https://lp.example.com/', referrer: 'https://www.google.com/' });
    const rules = [
      { id: 'a', match: { channel: 'google_search' }, childListId: 'any-google' },
      { id: 'b', match: { channel: 'google_ads' }, childListId: 'ads-only' },
    ];
    expect(matchRoutingRules(rules, paid).sort()).toEqual(['ads-only', 'any-google']);
    expect(matchRoutingRules(rules, organic)).toEqual(['any-google']);
  });
});

describe('2.2.0 DramaBreak attribution decisions', () => {
  it('Rise case: TikTok-tagged link opened from YouTube reports YouTube, keeps TikTok as linkChannel', () => {
    expect(classifyTraffic({ landingUrl: lp('utm_source=tiktok&utm_medium=bio'), referrer: 'https://www.youtube.com/' }))
      .toMatchObject({ channel: 'YouTube', linkChannel: 'TikTok', detectedChannel: 'YouTube', trafficType: 'organic' });
  });
  it('Facebook-tagged link inside the Instagram app reports Instagram', () => {
    expect(classifyTraffic({ landingUrl: lp('utm_source=facebook'), userAgent: UA.instagram }))
      .toMatchObject({ channel: 'Instagram', linkChannel: 'Facebook', matchedBy: 'user_agent' });
  });
  it('no referrer, no in-app UA: falls back to the link tag', () => {
    expect(classifyTraffic({ landingUrl: lp('utm_source=tiktok') })).toMatchObject({ channel: 'TikTok', matchedBy: 'utm_source', detectedChannel: '' });
  });
  it('nothing at all: Direct', () => {
    expect(classifyTraffic({ landingUrl: lp() })).toMatchObject({ channel: 'Direct', linkChannel: '', detectedChannel: '' });
  });
  it('paid link keeps its ad platform even when opened in another app', () => {
    expect(classifyTraffic({ landingUrl: lp('utm_source=meta&utm_medium=paid_social'), userAgent: UA.instagram }))
      .toMatchObject({ channel: 'Meta', channelGroup: 'Paid', trafficType: 'paid' });
  });
  it('Nova ads without utm_source=nova are still paid Nova via is_nova / nb_cid / nvss_ (2.3.0)', () => {
    for (const q of ['is_nova=true', 'nb_cid=2049718437503352834', 'utm_content=nvss_ABC_123']) {
      expect(classifyTraffic({ landingUrl: lp(q), referrer: 'https://www.newsbreak.com/' }))
        .toMatchObject({ channelKey: 'nova', channelGroup: 'Paid', trafficType: 'paid', paidSignal: 'url:nova', matchedBy: 'url:nova', linkChannel: '' });
      expect(classifyTraffic({ landingUrl: lp(q) })).toMatchObject({ channelKey: 'nova', trafficType: 'paid' });
    }
    expect(classifyTraffic({ landingUrl: lp(''), referrer: 'https://www.newsbreak.com/' }))
      .toMatchObject({ channelKey: 'newsbreak', trafficType: 'organic' });
    // An explicit, unrecognised utm_source still wins over the Nova URL fallback.
    expect(classifyTraffic({ landingUrl: lp('utm_source=creator_john&is_nova=true') }).channelKey).not.toBe('nova');
  });

  it('Nova is paid by construction and its own channel', () => {
    expect(classifyTraffic({ landingUrl: lp('utm_source=nova&utm_campaign=gbtm'), referrer: 'https://www.newsbreak.com/' }))
      .toMatchObject({ channel: 'Nova (NewsBreak Ads)', channelKey: 'nova', channelGroup: 'Paid', trafficType: 'paid', paidSignal: 'utm_source:nova' });
  });
  it('organic newsbreak.com referrer is NewsBreak.com, not Direct', () => {
    expect(classifyTraffic({ landingUrl: lp(), referrer: 'https://www.newsbreak.com/' })).toMatchObject({ channel: 'NewsBreak.com', trafficType: 'organic' });
  });
  it('Google: search vs ads stay split', () => {
    expect(classifyTraffic({ landingUrl: lp(), referrer: 'https://www.google.com/' })).toMatchObject({ channel: 'Google Search' });
    expect(classifyTraffic({ landingUrl: lp('gclid=x'), referrer: 'https://www.google.com/' })).toMatchObject({ channel: 'Google Ads', trafficType: 'paid' });
  });
});
