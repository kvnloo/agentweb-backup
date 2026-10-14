/** ENG-2494: DramaBreak first-touch accuracy, Google Search vs Ads split, NOVA = paid. */
import { classifyTraffic } from '../trafficSource';

const LP = 'https://go.dramabreak.ai/guilty-before-the-mic-v2';
const CREATOR = `${LP}?utm_source=agency-rise&utm_medium=agency&utm_campaign=launch`;
const TT_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 musical_ly_35.1.0 BytedanceWebview/d8a21c6';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
const ft = (referrer: string, userAgent = DESKTOP, landingUrl = CREATOR) =>
  classifyTraffic({ landingUrl, referrer, userAgent, sourceOrder: 'referrer_first' });

describe('ENG-2494 first touch (referrer_first) with one creator UTM', () => {
  it('TikTok referrer -> TikTok', () => expect(ft('https://www.tiktok.com/').channel).toBe('TikTok'));
  it('TikTok in-app browser, no referrer -> TikTok', () => expect(ft('', TT_UA).channel).toBe('TikTok'));
  it('YouTube referrer -> YouTube', () => expect(ft('https://www.youtube.com/').channel).toBe('YouTube'));
  it('no referrer/UA signal falls back to the link utm_source', () => expect(ft('').channel).toBe('Agency'));
  it('default (utm_first) order is unchanged: agency link stays Agency', () =>
    expect(classifyTraffic({ landingUrl: CREATOR, referrer: 'https://www.tiktok.com/' }).channel).toBe('Agency'));
});

describe('ENG-2494 Google split', () => {
  it('organic Google referrer -> Google Search, organic', () => {
    const r = classifyTraffic({ landingUrl: LP, referrer: 'https://www.google.com/' });
    expect([r.channel, r.trafficType]).toEqual(['Google Search', 'organic']);
  });
  it.each(['gclid', 'gbraid', 'wbraid'])('%s -> Google Ads, paid', (k) => {
    const r = classifyTraffic({ landingUrl: `${LP}?${k}=abc`, referrer: 'https://www.google.com/' });
    expect([r.channel, r.trafficType]).toEqual(['Google Ads', 'paid']);
  });
  it('utm_source=google&utm_medium=cpc -> Google Ads', () =>
    expect(classifyTraffic({ landingUrl: `${LP}?utm_source=google&utm_medium=cpc` }).channel).toBe('Google Ads'));
});

describe('ENG-2494 NOVA (NewsBreak ads) is paid', () => {
  it.each([
    'utm_source=nova',
    'utm_source=newsbreak&utm_medium=nova',
    'utm_source=newsbreak&utm_campaign=nova_guilty_v2',
  ])('%s -> paid NewsBreak', (q) => {
    const r = classifyTraffic({ landingUrl: `${LP}?${q}` });
    expect(r.trafficType).toBe('paid');
    expect(r.channelGroup).toBe('Paid');
    expect(r.channel).toBe('NewsBreak');
    expect(r.paidSignal).toBe('utm:nova');
  });
  it('organic NewsBreak referrer stays organic', () => {
    const r = classifyTraffic({ landingUrl: LP, referrer: 'https://www.newsbreak.com/' });
    expect([r.channel, r.trafficType]).toEqual(['NewsBreak', 'organic']);
  });
  it('"supernova" campaign is not a NOVA token', () =>
    expect(classifyTraffic({ landingUrl: `${LP}?utm_campaign=supernova` }).trafficType).toBe('organic'));
});
