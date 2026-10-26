/**
 * ENG-2315 — the browser SDK, run for real (the exact string the route serves) inside jsdom.
 * Contract: one stable session identity across events, a counter the server guard can rely on,
 * a cumulative page_exit, a transport that degrades, and a host page that never sees an exception.
 *
 * jsdom runs in a child process (helpers/runSdkScenarios.js — its dependency chain is ESM-only,
 * see that file); this file asserts on the JSON it returns.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import * as ts from 'typescript';
import { AW_SDK_SOURCE } from '../awSdkSource';

const HELPER = path.join(__dirname, 'helpers', 'runSdkScenarios.js');
const LIST = 'list_1790938330308_abc';
const URL_ = 'https://go.example.com/p?utm_source=instagram&utm_medium=bio&lp_variant=v2';

let out: Record<string, any>;
beforeAll(() => {
  const child = spawnSync(process.execPath, [HELPER], {
    input: JSON.stringify({ source: AW_SDK_SOURCE }), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(`sdk scenario helper failed (status ${child.status}):\n${child.stderr}`);
  out = JSON.parse(child.stdout).results;
}, 120_000);

const got = (name: string): any => {
  const r = out[name];
  if (r?.__error) throw new Error(`scenario ${name} threw: ${r.__error}`);
  return r;
};
const events = (sent: any[]) => sent.map((s) => (s.body ?? s).event);
const body = (s: any) => s.body ?? s;

describe('aw.js: identity and counters', () => {
  it("sends lp_view on load to the endpoint on the SCRIPT's own origin, raw signals only, no classification", () => {
    const { sent } = got('firstLoad');
    expect(sent).toHaveLength(1);
    const { url, body: b, via } = sent[0];
    expect(via).toBe('beacon');
    expect(url).toBe('https://api.example.test/api/track/event');
    expect(b).toMatchObject({
      listId: LIST, event: 'lp_view', eventCount: 1, visitNo: 1, landingUrl: URL_, referrer: 'https://l.instagram.com/',
      lpVariant: 'v2', firstTouchReferrer: 'l.instagram.com', firstTouchLanding: URL_, furthestStage: 'lp_view',
    });
    expect(b.sessionId).toMatch(/^[a-z0-9-]{8,64}$/i);
    expect(b.visitorId).toMatch(/^[a-z0-9-]{8,64}$/i);
    for (const k of ['trafficType', 'channel', 'channelGroup', 'referrerHost', 'sourceLink', 'sourceDetail', 'classifierVersion', 'device']) {
      expect(b).not.toHaveProperty(k);
    }
    expect(Number.isSafeInteger(b.sessionStartMs)).toBe(true);
    // ENG-2324: the device clock at send time rides every event (the server's sticky "clock is ahead" signal)
    expect(Number.isSafeInteger(b.clientNowMs)).toBe(true);
    expect(b.clientNowMs - b.sessionStartMs).toBeGreaterThanOrEqual(0); // same (page) clock as the minted start
    expect(b.clientNowMs - b.sessionStartMs).toBeLessThan(60_000);
  });

  it('uses the SAME sessionStartMs and sessionId on every event, with a non-decreasing numeric eventCount', () => {
    const { sent } = got('sessionSequence');
    expect(events(sent)).toEqual(['lp_view', 'gate_view', 'click', 'click', 'click', 'app_cta_click', 'page_exit']);
    expect(new Set(sent.map((s: any) => s.sessionStartMs)).size).toBe(1);
    expect(new Set(sent.map((s: any) => s.sessionId)).size).toBe(1);
    const counts = sent.map((s: any) => s.eventCount);
    expect(counts.every((c: unknown) => typeof c === 'number')).toBe(true);
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 6]); // page_exit repeats the CURRENT count and is not a journey event
    // the click log is cumulative on EVERY event, so a click overtaken on the wire cannot be its only carrier
    expect(sent.slice(2).map((s: any) => s.clickCount)).toEqual([1, 2, 3, 3, 3]);
    expect(sent[6].clickLog.split(' > ')).toHaveLength(3);
    // every event carries the cumulative "last funnel event", so a click that overtakes a funnel event on the wire cannot lose it
    expect(sent.map((s: any) => s.lastEvent)).toEqual(['lp_view', 'gate_view', 'gate_view', 'gate_view', 'gate_view', 'app_cta_click', 'app_cta_click']);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
  });

  it('a second page load in the same browser session reuses sessionId, sessionStartMs and the counter', () => {
    const r = got('secondPageLoad');
    expect(r.afterLoad).toBe(0); // lp_view is once per session
    expect(r.second[0].sessionId).toBe(r.first[0].sessionId);
    expect(r.second[0].sessionStartMs).toBe(r.first[0].sessionStartMs);
    expect(r.second[0].eventCount).toBe(3);
  });

  it('starts a NEW session when the stored one is older than the ingest accepts (24h)', () => {
    const r = got('staleSession');
    expect(r.later[0].sessionId).not.toBe(r.first[0].sessionId);
    expect(r.later[0].sessionStartMs).toBe(r.laterNow);
    expect(r.later[0].eventCount).toBe(1);
  });

  it('visitorId: regex-validated, kept in localStorage AND the cookie, stable across visits; visitNo counts sessions', () => {
    const r = got('visitorId');
    const vid = r.sent[0].visitorId;
    expect(vid).toMatch(/^[a-z0-9-]{8,64}$/i);
    expect(vid).not.toBe('not valid!!');
    expect(r.stored).toBe(vid);
    expect(r.cookie).toContain(`aw_vid=${vid}`);
    expect(r.sent[0].visitNo).toBe(5);
    expect(r.again[0].visitorId).toBe(vid);
  });

  it('recovers the visitorId from the cookie when localStorage is empty', () => {
    expect(got('visitorFromCookie').sent[0].visitorId).toBe('cookie-visitor-1234');
  });

  it('first touch is written once and never overwritten by a later visit', () => {
    const r = got('firstTouch');
    expect(r.storedRef).toBe('l.instagram.com');
    expect(r.storedUrl).toBe(URL_);
    expect(r.later[0]).toMatchObject({ firstTouchReferrer: 'l.instagram.com', firstTouchLanding: URL_, referrer: 'https://www.google.com/' });
  });
});

describe('aw.js: page_exit', () => {
  it('flushes cumulative dwell / active / video / scroll when the tab is hidden, and is not a journey event', () => {
    const { sent } = got('pageExitFull');
    const exit = sent[sent.length - 1];
    expect(exit).toMatchObject({ event: 'page_exit', dwellSec: 30, activeSec: 30, videoWatchSec: 4, maxScrollPct: 50 }); // the 3.5s->60s jump is a seek
    expect(exit.sessionStartMs).toBe(sent[0].sessionStartMs);
    expect(exit.eventCount).toBe(sent.filter((s: any) => s.event !== 'page_exit').length);
  });

  it('active time excludes hidden time; a later hide sends the cumulative total', () => {
    const exits = got('activeTime').sent.filter((s: any) => s.event === 'page_exit');
    expect(exits[0]).toMatchObject({ dwellSec: 10, activeSec: 10 });
    expect(exits[1]).toMatchObject({ dwellSec: 65, activeSec: 15 });
  });

  it('hidden time is never counted as active, even when pagehide follows a hide', () => {
    const exits = got('hiddenThenPagehide').sent.filter((s: any) => s.event === 'page_exit');
    expect(exits).toHaveLength(2);
    expect(exits[0]).toMatchObject({ dwellSec: 10, activeSec: 10 });
    expect(exits[1]).toMatchObject({ dwellSec: 20, activeSec: 10 });
  });

  it('pagehide also flushes', () => {
    expect(events(got('pagehide').sent)).toEqual(['lp_view', 'page_exit']);
  });
});

describe('aw.js: transport', () => {
  it('sends via sendBeacon as a "simple" text/plain request (no CORS preflight)', () => {
    const [s] = got('beaconOk').sent;
    expect(s.via).toBe('beacon');
    expect(s.blobType).toMatch(/^text\/plain/);
  });

  it.each([['returns false', 'beaconFalse'], ['throws', 'beaconThrows'], ['is missing', 'beaconMissing']])('falls back to fetch keepalive when sendBeacon %s', (_l, name) => {
    const { sent } = got(name);
    expect(sent).toHaveLength(1);
    expect(sent[0].via).toBe('fetch');
    expect(sent[0].init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit', mode: 'cors' });
    expect(sent[0].init.headers['Content-Type']).toMatch(/^text\/plain/);
  });

  it('falls back to XHR when there is neither beacon nor fetch', () => {
    expect(got('xhrOnly').sent[0].via).toBe('xhr');
  });

  it('keeps every payload under the ingest 16kb cap after many long clicks, and stops after the per-session event cap', () => {
    const r = got('payloadCap');
    for (const n of r.sizes) expect(n).toBeLessThan(15_000);
    expect(r.count).toBeLessThanOrEqual(300);
    expect(r.last.journey.length).toBeLessThanOrEqual(2900);
    expect(r.last.clickLog.length).toBeLessThanOrEqual(4000);
  });
});

describe('aw.js: counter and size bounds', () => {
  it('eventCount keeps increasing past the 120-entry journey cap (the server guard needs a non-decreasing counter)', () => {
    const { counts, journeyLen } = got('manyEvents');
    expect(counts).toHaveLength(131);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBe(counts[i - 1] + 1);
    expect(journeyLen).toBeLessThanOrEqual(120);
  });

  it('worst-case JSON escaping (all-quote labels) still stays under the ingest 16kb cap, and the event is still sent', () => {
    const r = got('quotesPayload');
    for (const n of r.sizes) expect(n).toBeLessThan(16 * 1024); // UTF-8 BYTES, as the server's limit counts them
    expect(r.lastHasClickLabel).toBe(true);
    expect(Math.max(...r.sizes)).toBeLessThan(15_500); // the SDK sheds the cumulative strings at 15000, well inside the server's 16384
    expect(r.last).toMatchObject({ event: 'custom', name: 'big_props' }); // 10 x 120 three-byte characters of props still arrive
  });

  it('non-ASCII label text is dropped client-side (the server would strip it, and it costs 3 bytes a character)', () => {
    const click = got('cjkLabel').sent.find((s: any) => s.event === 'click');
    expect(click.clickLabel).toBe('Buy');
  });
});

describe('aw.js: never throws into the host page', () => {
  it('works with localStorage, sessionStorage and cookies all throwing; the session still holds for the page', () => {
    const r = got('storageThrows');
    expect([r.loadErr, r.trackErr, r.hideErr]).toEqual([false, false, false]);
    expect(events(r.sent)).toEqual(['lp_view', 'app_cta_click', 'page_exit']);
    expect(new Set(r.sent.map((s: any) => s.sessionStartMs)).size).toBe(1);
  });

  it('survives a corrupt stored session and a transport that throws everywhere', () => {
    const c = got('corruptSession');
    expect(c.err).toBe(false);
    expect(c.sent[0].eventCount).toBe(1);
    const t = got('brokenTransport');
    expect([t.loadErr, t.trackErr]).toEqual([false, false]);
  });

  it('a script tag without data-aw-list does nothing', () => {
    expect(got('noListAttr')).toEqual({ err: false, hasAwTrack: false });
  });

  it('loading the tag twice does not double-send', () => {
    expect(got('loadedTwice').sent).toHaveLength(1);
  });
});

describe('aw.js: public API and DOM events', () => {
  it('awTrack: standard names are themselves, anything else becomes a bounded custom event, junk is refused', () => {
    const { returns, sent } = got('awTrackApi');
    expect(returns).toEqual({ standard: true, custom: true, empty: false, nul: false, junk: false, lpViewAgain: false });
    const custom = sent.find((s: any) => s.event === 'custom');
    expect(custom.name).toBe('signup_clicked_');
    expect(custom.props).toEqual({ plan: 'pro', n: 2 });
    expect(sent.find((s: any) => s.event === 'lead_submit').furthestStage).toBe('lead_submit');
  });

  it('click label: data-aw-label wins over text; long text capped at 60; section from data-aw-section; clickLog accumulates', () => {
    const [, a, t] = got('clickLabels').sent;
    expect(a).toMatchObject({ clickLabel: 'Hero CTA', clickSection: 'hero', clickUrl: 'https://shop.test/x', clickCount: 1 });
    expect(t.clickLabel).toHaveLength(60);
    expect(t.clickCount).toBe(2);
    expect(t.clickLog).toContain('Hero CTA (hero)');
  });

  it('the first <video> play sends play_start once; a muted looping background video is ignored', () => {
    expect(events(got('videoPlay').sent)).toEqual(['lp_view', 'play_start']);
  });

  it('events queued on window.awq before load are replayed', () => {
    expect(events(got('awqReplay').sent).sort()).toEqual(['app_cta_click', 'custom', 'lp_view']);
  });

  it('Do-Not-Track is NOT honoured by default, and IS when the page opts in with data-aw-respect-dnt', () => {
    expect(got('dntDefault').sent).toHaveLength(1);
    const on = got('dntOptIn');
    expect(on.sent).toHaveLength(0);
    expect(on.returned).toBe(false);
  });
});

describe('aw.js: the served source itself', () => {
  it('is plain ES5 with no template literals, so it runs in old in-app browsers and fits its TS wrapper', () => {
    expect(AW_SDK_SOURCE).not.toContain('`');
    expect(AW_SDK_SOURCE).not.toContain('${');
    const sf = ts.createSourceFile('aw.js', AW_SDK_SOURCE, ts.ScriptTarget.ES5, true, ts.ScriptKind.JS);
    const bad: string[] = [];
    const visit = (n: ts.Node): void => {
      const k = ts.SyntaxKind[n.kind];
      if (['ArrowFunction', 'ClassDeclaration', 'ClassExpression', 'TemplateExpression', 'NoSubstitutionTemplateLiteral', 'SpreadElement', 'SpreadAssignment', 'ForOfStatement', 'AwaitExpression', 'YieldExpression', 'ObjectBindingPattern', 'ArrayBindingPattern', 'ShorthandPropertyAssignment', 'ComputedPropertyName', 'QuestionQuestionToken', 'QuestionDotToken'].includes(k)) bad.push(k);
      if (ts.isVariableDeclarationList(n) && (n.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) bad.push('let/const');
      if (ts.isMethodDeclaration(n) && ts.isObjectLiteralExpression(n.parent)) bad.push('method shorthand');
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(Array.from(new Set(bad))).toEqual([]);
    expect((sf as any).parseDiagnostics).toHaveLength(0);
  });

  it('is small enough to ship on every page view', () => {
    expect(AW_SDK_SOURCE.length).toBeLessThan(20_000);
  });
});

describe('aw.js: ENG-2689 super properties', () => {
  it('attaches presets and pre-load registered super properties to every event; later registrations win', () => {
    const { sent, second } = got('superProps');
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const b of sent) {
      expect(b.super).toMatchObject({
        '#lib': 'js', '#device_id': b.visitorId, '#url': URL_, site_domain: 'go.example.com', is_login: false, session_intent_score: 3,
      });
      expect(Number.isSafeInteger(b.super['#event_time'])).toBe(true);
      expect(b.super).not.toHaveProperty('bad');
    }
    expect(sent[0].super.funnel_type).toBe('free_trial');
    expect(sent[sent.length - 1].super.funnel_type).toBe('funnel_review');
    expect(sent[0].super.session_page_num).toBe(1);
    expect(second[0].super.session_page_num).toBe(2);
  });

  it('non-ASCII registered values over the byte cap are shed by BYTES, keeping presets and the event', () => {
    const { sizes, sent } = got('superNonAscii');
    expect(sent).toHaveLength(1);
    expect(sizes[0]).toBeLessThan(16 * 1024);
    expect(sent[0].event).toBe('lp_view');
    expect(sent[0].super).not.toHaveProperty('k0');
    expect(sent[0].super).toMatchObject({ '#lib': 'js', '#url': URL_ });
  });
});
