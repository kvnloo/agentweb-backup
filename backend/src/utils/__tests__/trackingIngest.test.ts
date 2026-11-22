/**
 * ENG-2315 — the public ingest body contract: only allow-listed keys are ever stored, every field is
 * bounded, identity uses the shared 48h/5min window, and the SERVER owns classification.
 */
import { parseIngestBody, buildSessionRow, clean, int } from '../trackingIngest';

const NOW = 1_800_000_000_000;
const base = (extra: Record<string, unknown> = {}) => ({
  listId: 'list_1790938330308_abc', event: 'lp_view', sessionId: 'abcd1234-ef56-7890', sessionStartMs: NOW - 5000,
  eventCount: 1, landingUrl: 'https://go.example.com/p?utm_source=instagram&utm_medium=bio&utm_campaign=c1', referrer: '', ...extra,
});
const parse = (b: unknown) => parseIngestBody(b, NOW);
const ok = (b: unknown) => { const r = parse(b); if (!r.ok) throw new Error(`${r.code}: ${r.message}`); return r.value; };

describe('parseIngestBody: rejection', () => {
  it.each([
    ['not an object', 'x'],
    ['array', []],
    ['null', null],
  ])('%s -> invalid_body', (_l, b) => expect(parse(b)).toMatchObject({ ok: false, code: 'invalid_body' }));

  it.each([
    ['missing listId', { ...base(), listId: undefined }, 'invalid_list'],
    ['listId wrong type', base({ listId: { $ne: 1 } }), 'invalid_list'],
    ['listId too long', base({ listId: 'l'.repeat(81) }), 'invalid_list'],
    ['unknown event', base({ event: 'purchase' }), 'invalid_event'],
    ['event wrong type', base({ event: ['lp_view'] }), 'invalid_event'],
    ['bad sessionId', base({ sessionId: 'short' }), 'invalid_session'],
    ['sessionStartMs missing', base({ sessionStartMs: undefined }), 'invalid_session'],
    ['sessionStartMs fractional', base({ sessionStartMs: NOW - 5000.5 }), 'invalid_session'],
    ['sessionStartMs Infinity-sized', base({ sessionStartMs: 1e300 }), 'invalid_session'],
    ['sessionStartMs not a number', base({ sessionStartMs: 'soon' }), 'invalid_session'],
    ['custom without name', base({ event: 'custom' }), 'invalid_name'],
    ['custom name not a slug', base({ event: 'custom', name: 'has space' }), 'invalid_name'],
    ['custom name too long', base({ event: 'custom', name: 'a'.repeat(33) }), 'invalid_name'],
  ])('%s -> %s', (_l, b, code) => expect(parse(b)).toMatchObject({ ok: false, code }));
});

describe('parseIngestBody: ENG-2324 device clock', () => {
  it('a start outside the window is accepted with a substitute; an in-window one is untouched', () => {
    const v = ok(base({ sessionStartMs: NOW - 5 * 24 * 3600_000 }));
    expect(v.identity.sessionStartMs).toBeGreaterThan(NOW - 24 * 3600_000);
    expect(v.identity.sessionStartMs).toBeLessThanOrEqual(NOW);
    expect(ok(base()).identity).toEqual({ sessionId: 'abcd1234-ef56-7890', sessionStartMs: NOW - 5000 });
  });

  it('clientNowMs >5min ahead of the server makes even an in-window start substituted (and a missing / garbage one is ignored)', () => {
    expect(ok(base({ clientNowMs: NOW + 10 * 60_000 })).identity.sessionStartMs).not.toBe(NOW - 5000);
    expect(ok(base({ clientNowMs: String(NOW + 10 * 60_000) })).identity.sessionStartMs).not.toBe(NOW - 5000);
    for (const v of [NOW, NOW + 60_000, 'x', {}, null, -5]) expect(ok(base({ clientNowMs: v })).identity.sessionStartMs).toBe(NOW - 5000);
  });

  it('clientNowMs is never stored on the row', () => {
    expect(JSON.stringify(ok(base({ clientNowMs: NOW }))).includes('clientNowMs')).toBe(false);
  });
});

describe('parseIngestBody: bounded fields', () => {
  it('ignores unknown keys entirely (they cannot reach customFields)', () => {
    const v = ok(base({ isAdmin: true, __proto__x: 1, ['k'.repeat(10_000)]: 'v', customFields: { evil: 1 }, email: 'a@b.co' }));
    expect(Object.keys(v.client)).not.toEqual(expect.arrayContaining(['isAdmin', 'email', 'customFields']));
    const row = buildSessionRow(v, { userAgent: 'Mozilla/5.0', nowIso: 'T' }).customFields;
    expect(Object.keys(row).some((k) => k.length > 40)).toBe(false);
    expect(row).not.toHaveProperty('email');
    expect(row).not.toHaveProperty('isAdmin');
    expect(row).not.toHaveProperty('evil');
  });

  it('caps strings, strips disallowed characters, clamps numbers, drops wrong types', () => {
    const v = ok(base({
      event: 'page_exit',
      visitorId: 'not a valid id!!',
      visitNo: 'abc',
      eventCount: 1e12,
      lpVariant: `${'v'.repeat(500)}<script>`,
      dwellSec: 9_999_999,
      activeSec: -5,
      videoWatchSec: '12.6',
      maxScrollPct: 250,
      journey: 'x'.repeat(10_000),
      furthestStage: 'drop table',
    }));
    expect(v.client.visitorId).toBeUndefined();
    expect(v.client.visitNo).toBeUndefined();
    expect(v.client.eventCount).toBe(1_000_000);
    expect(String(v.client.lpVariant).length).toBe(80);
    expect(String(v.client.lpVariant)).not.toMatch(/[<>]/);
    expect(v.client.dwellSec).toBe(86_400);
    expect(v.client.activeSec).toBe(0);
    expect(v.client.videoWatchSec).toBe(13);
    expect(v.client.maxScrollPct).toBe(100);
    expect(String(v.client.journey).length).toBe(3000);
    expect(v.client.furthestStage).toBeUndefined();
  });

  it('engagement fields are only read from the event that owns them', () => {
    expect(ok(base({ event: 'lp_view', dwellSec: 9, clickLabel: 'x' })).client).not.toHaveProperty('dwellSec');
    expect(ok(base({ event: 'lp_view', dwellSec: 9, clickLabel: 'x' })).client).not.toHaveProperty('lastClickLabel');
    expect(ok(base({ event: 'click', clickLabel: 'Buy', clickCount: 3 })).client).toMatchObject({ lastClickLabel: 'Buy', clickCount: 3 });
    // ...except the cumulative click state, which every event carries so the guarded merge never loses it
    expect(ok(base({ event: 'app_cta_click', clickCount: 3, clickLog: 'a (x) +1s > b (y) +2s' })).client).toMatchObject({ clickCount: 3, clickLog: 'a (x) +1s > b (y) +2s' });
  });

  it('custom props: <=10 scalar keys with valid names, serialised into ONE capped field', () => {
    const props: Record<string, unknown> = { plan: 'pro', n: 3, ok: true, nested: { a: 1 }, 'bad key': 1, arr: [1] };
    for (let i = 0; i < 30; i++) props[`k${i}`] = 'v';
    const v = ok(base({ event: 'custom', name: 'Signup_Click', props }));
    expect(v.customName).toBe('signup_click');
    const parsed = JSON.parse(String(v.client.lastCustomProps));
    expect(Object.keys(parsed).length).toBeLessThanOrEqual(10);
    expect(parsed).not.toHaveProperty('nested');
    expect(parsed).not.toHaveProperty('bad key');
    expect(String(v.client.lastCustomProps).length).toBeLessThanOrEqual(500);
  });

  it('URLs must be http(s); control characters are stripped', () => {
    const v = ok(base({ landingUrl: 'javascript:alert(1)', referrer: 'data:text/html,x' }));
    expect(v.landingUrl).toBe('');
    expect(v.referrer).toBe('');
    expect(ok(base({ landingUrl: 'https://a.com/\u0000x<y>' })).landingUrl).toBe('https://a.com/xy');
  });

  it('clean() and int() helpers', () => {
    expect(clean('a<b>c"d', 10)).toBe('abcd');
    expect(clean(5 as any)).toBe('');
    expect(int('7', 0, 5)).toBe(5);
    expect(int(NaN, 0, 5)).toBeUndefined();
    expect(int({}, 0, 5)).toBeUndefined();
    expect(int('1e9', 0, 5)).toBeUndefined();
  });
});

describe('buildSessionRow: the server owns classification', () => {
  const CHROME = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120';
  it('overwrites every client-supplied classification field and stamps classifierVersion', () => {
    const v = ok(base({
      // the client tries to claim a paid Google Search session and to inject server-owned fields
      trafficType: 'paid', channel: 'Google Search', channelGroup: 'Paid', referrerHost: 'google.com',
      sourceLink: 'https://evil.test', sourceDetail: 'spoof', classifierVersion: '0.0.0', lp_view_at: 'x', device: 'toaster',
      page: 'spoofed',
    }));
    const { customFields: f } = buildSessionRow(v, { userAgent: CHROME, pageLabel: 'Real Page', nowIso: '2026-10-06T00:00:00.000Z' });
    expect(f).toMatchObject({
      trafficType: 'organic', channel: 'Instagram', channelKey: 'instagram', channelGroup: 'Organic Social',
      classifierVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/), device: 'desktop', page: 'Real Page',
      lp_view_at: '2026-10-06T00:00:00.000Z', source: 'tracker-sdk',
    });
    expect(f.sourceDetail).toBe('utm_source=instagram | utm_medium=bio | utm_campaign=c1');
    expect(f).not.toHaveProperty('referrerHost');
    expect(f).not.toHaveProperty('sourceLink');
    expect(f.utmSource).toBe('instagram');
  });

  it('a click id on the landing URL makes the session paid; the User-Agent header can decide the channel', () => {
    const paid = buildSessionRow(ok(base({ landingUrl: 'https://go.example.com/?gclid=abc&utm_source=google' })), { userAgent: CHROME, nowIso: 'T' });
    expect(paid.classification).toMatchObject({ trafficType: 'paid', channelGroup: 'Paid' });
    const inApp = buildSessionRow(ok(base({ landingUrl: 'https://go.example.com/' })), { userAgent: 'Mozilla/5.0 (iPhone) Instagram 300.0', nowIso: 'T' });
    expect(inApp.customFields).toMatchObject({ channel: 'Instagram', device: 'ios' });
  });

  it('lastEvent tracks funnel events only; click and page_exit do not overwrite it', () => {
    const ctx = { userAgent: CHROME, nowIso: 'T' };
    expect(buildSessionRow(ok(base({ event: 'play_start' })), ctx).customFields.lastEvent).toBe('play_start');
    expect(buildSessionRow(ok(base({ event: 'click', clickLabel: 'x' })), ctx).customFields).not.toHaveProperty('lastEvent');
    expect(buildSessionRow(ok(base({ event: 'page_exit' })), ctx).customFields).not.toHaveProperty('lastEvent');
    const custom = buildSessionRow(ok(base({ event: 'custom', name: 'signup' })), ctx).customFields;
    expect(custom).toMatchObject({ lastEvent: 'custom:signup', lastCustomName: 'signup', custom_at: 'T' });
  });

  it('a click or page_exit carries the client\'s cumulative lastEvent; an invalid one is dropped', () => {
    const ctx = { userAgent: CHROME, nowIso: 'T' };
    expect(buildSessionRow(ok(base({ event: 'click', clickLabel: 'x', lastEvent: 'gate_view' })), ctx).customFields.lastEvent).toBe('gate_view');
    expect(buildSessionRow(ok(base({ event: 'page_exit', lastEvent: 'custom:signup' })), ctx).customFields.lastEvent).toBe('custom:signup');
    expect(buildSessionRow(ok(base({ event: 'click', clickLabel: 'x', lastEvent: 'click' })), ctx).customFields).not.toHaveProperty('lastEvent');
    expect(buildSessionRow(ok(base({ event: 'click', clickLabel: 'x', lastEvent: '<b>x</b>' })), ctx).customFields).not.toHaveProperty('lastEvent');
    // a funnel event's own name wins over whatever the client claims
    expect(buildSessionRow(ok(base({ event: 'play_start', lastEvent: 'lead_submit' })), ctx).customFields.lastEvent).toBe('play_start');
  });

  it('the set of keys a row can ever carry is fixed (custom events mint no new columns)', () => {
    const ctx = { userAgent: CHROME, nowIso: 'T' };
    const a = buildSessionRow(ok(base({ event: 'custom', name: 'one' })), ctx).customFields;
    const b = buildSessionRow(ok(base({ event: 'custom', name: 'two_other' })), ctx).customFields;
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });

  it('first-touch channel is classified server-side from the stored first landing URL + referrer host', () => {
    const v = ok(base({ firstTouchLanding: 'https://go.example.com/?utm_source=tiktok', firstTouchReferrer: 'l.instagram.com', firstTouchChannel: 'Spoof' }));
    // 2.2.0: the observed first referrer (Instagram) beats the link's tiktok tag.
    expect(buildSessionRow(v, { userAgent: CHROME, nowIso: 'T' }).customFields.firstTouchChannel).toBe('Instagram');
    const legacy = ok(base({ firstTouchChannel: 'Facebook' }));
    expect(buildSessionRow(legacy, { userAgent: CHROME, nowIso: 'T' }).customFields.firstTouchChannel).toBe('Facebook');
  });
  it('ENG-2494: on the first visit, first touch comes from THIS landing session, not SDK-stored state', () => {
    const creator = 'https://go.dramabreak.ai/g?utm_source=tiktok&utm_medium=social';
    const stale = { firstTouchLanding: 'https://go.dramabreak.ai/g', firstTouchReferrer: 'youtube.com', firstTouchChannel: 'YouTube' };
    const yt = ok(base({ visitNo: 1, landingUrl: creator, referrer: 'https://www.youtube.com/', ...stale }));
    const row = buildSessionRow(yt, { userAgent: CHROME, nowIso: 'T' }).customFields;
    expect(row.firstTouchChannel).toBe('YouTube');
    expect(row.firstTouchReferrer).toBe('youtube.com');
    const ig = ok(base({ visitNo: 1, landingUrl: creator, referrer: 'https://l.instagram.com/', ...stale }));
    expect(buildSessionRow(ig, { userAgent: CHROME, nowIso: 'T' }).customFields.firstTouchChannel).toBe('Instagram');
  });
});

describe('ENG-2494 first touch on agency links and follow-up events (Opslane run 590)', () => {
  const CHROME = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120';
  const agency = 'https://go.dramabreak.ai/g?utm_source=agency-rise&utm_medium=agency';
  const ctx = { userAgent: CHROME, nowIso: 'T' };
  it('first visit on an agency link: first touch is the click platform, last touch stays Agency', () => {
    for (const [ref, want] of [['https://www.tiktok.com/', 'TikTok'], ['https://www.youtube.com/', 'YouTube'], ['https://l.instagram.com/', 'Instagram']]) {
      const row = buildSessionRow(ok(base({ visitNo: 1, eventCount: 1, landingUrl: agency, referrer: ref })), ctx).customFields;
      expect(row.firstTouchChannel).toBe(want);
      expect(row.channel).toBe('Agency');
    }
    const ig = buildSessionRow(ok(base({ visitNo: 1, eventCount: 1, landingUrl: agency })), { userAgent: 'Mozilla/5.0 (iPhone) Instagram 300.0', nowIso: 'T' }).customFields;
    expect(ig.firstTouchChannel).toBe('Instagram');
  });
  it('return visit: stored agency landing + stored TikTok referrer gives TikTok', () => {
    const row = buildSessionRow(ok(base({ visitNo: 2, eventCount: 1, landingUrl: 'https://go.dramabreak.ai/g', referrer: 'https://www.youtube.com/', firstTouchLanding: agency, firstTouchReferrer: 'tiktok.com', firstTouchChannel: 'Agency' })), ctx).customFields;
    expect(row.firstTouchChannel).toBe('TikTok');
  });
  it('agency link with no observable signal stays Agency; paid links keep the ad platform', () => {
    expect(buildSessionRow(ok(base({ visitNo: 1, eventCount: 1, landingUrl: agency })), ctx).customFields.firstTouchChannel).toBe('Agency');
  });
  it('a later event in the first visit without an external signal does not overwrite first touch', () => {
    const later = buildSessionRow(ok(base({ visitNo: 1, eventCount: 3, event: 'click', clickLabel: 'x', landingUrl: 'https://go.dramabreak.ai/g', referrer: 'https://go.dramabreak.ai/' })), ctx).customFields;
    expect(later).not.toHaveProperty('firstTouchChannel');
    expect(later).not.toHaveProperty('firstTouchReferrer');
  });
});

describe('repairEscapedQuery (HTML-escaped share links)', () => {
  const { repairEscapedQuery } = require('../trackingIngest');
  it('recovers UTMs from a link whose & became amp;', () => {
    const fixed = repairEscapedQuery('https://go.dramabreak.ai/x?utm_source=dramabreakamp;utm_medium=socialamp;utm_campaign=gbtm_launchamp;utm_content=sunny');
    expect(Object.fromEntries(new URL(fixed).searchParams)).toEqual({ utm_source: 'dramabreak', utm_medium: 'social', utm_campaign: 'gbtm_launch', utm_content: 'sunny' });
  });
  it('recovers &amp; and keeps the hash', () => {
    expect(repairEscapedQuery('https://a.b/x?utm_source=a&amp;utm_medium=b#h')).toBe('https://a.b/x?utm_source=a&utm_medium=b#h');
  });
  it('leaves clean links and values that only contain "amp" unchanged', () => {
    expect(repairEscapedQuery('https://a.b/x?utm_source=ok&utm_medium=s')).toBe('https://a.b/x?utm_source=ok&utm_medium=s');
    expect(repairEscapedQuery('https://a.b/x?utm_source=campamp;x')).toBe('https://a.b/x?utm_source=campamp;x');
  });
});
