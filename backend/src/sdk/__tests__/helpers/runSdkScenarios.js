/**
 * Runs the REAL aw.js (the exact string the route serves) in jsdom for awSdk.test.ts.
 *
 * Why a child process: jsdom's dependency chain is ESM-only and this repo's jest config does not
 * transform node_modules (same reason as __tests__/helpers/runSmokeDiscovery.js). Plain node loads
 * it fine, so the jest test shells out here once and asserts on the JSON that comes back.
 *
 * Protocol: JSON on stdin `{ source }` -> JSON on stdout `{ results: { [scenario]: any } }`.
 * A scenario that throws is reported as `{ __error }` so the test fails on that scenario alone.
 */
const { JSDOM } = require('jsdom');

const LIST = 'list_1790938330308_abc';
const SRC = 'https://api.example.test/sdk/v1/aw.js';
const URL_ = 'https://go.example.com/p?utm_source=instagram&utm_medium=bio&lp_variant=v2';
let SOURCE = '';

function setup(opts) {
  opts = opts || {};
  const dom = new JSDOM(
    '<!doctype html><html><body>' + (opts.html || '') + '<script src="' + SRC + '" data-aw-list="' + LIST + '" ' + (opts.scriptAttrs || '') + '></script></body></html>',
    { url: opts.url || URL_, referrer: opts.referrer === undefined ? 'https://l.instagram.com/' : opts.referrer, runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const win = dom.window;
  const sent = [];
  const now = { t: 1800000000000 };
  win.Date.now = function () { return now.t; };
  const record = function (via, url, body, init) { sent.push({ url: url, via: via, body: JSON.parse(String(body)), init: init }); };

  const beacon = opts.beacon || 'ok';
  if (beacon !== 'missing') {
    const RealBlob = win.Blob;
    win.Blob = function (parts, o) { const b = new RealBlob(parts, o); b.__text = parts.join(''); b.__type = o && o.type; return b; };
    win.navigator.sendBeacon = function (url, blob) {
      if (beacon === 'throws') throw new Error('beacon blocked');
      if (beacon === 'false') return false;
      sent.push({ url: url, via: 'beacon', body: JSON.parse(blob.__text), blobType: blob.__type });
      return true;
    };
  }
  if (opts.fetch !== false) {
    win.fetch = function (url, init) { record('fetch', url, init.body, init); return Promise.resolve({ ok: true }); };
  } else {
    win.fetch = undefined;
    win.XMLHttpRequest = function () {
      let u = '';
      if (opts.xhrThrows) throw new Error('xhr blocked');
      return { open: function (_m, url) { u = url; }, setRequestHeader: function () {}, send: function (b) { record('xhr', u, b); } };
    };
  }
  Object.keys(opts.seed || {}).forEach(function (k) { win.localStorage.setItem(k, opts.seed[k]); });
  Object.keys(opts.sessionSeed || {}).forEach(function (k) { win.sessionStorage.setItem(k, opts.sessionSeed[k]); });
  if (opts.storageThrows) {
    const boom = function () { throw new Error('SecurityError: storage disabled'); };
    Object.defineProperty(win, 'localStorage', { get: boom, configurable: true });
    Object.defineProperty(win, 'sessionStorage', { get: boom, configurable: true });
    Object.defineProperty(win.document, 'cookie', { get: boom, set: boom, configurable: true });
  }
  if (opts.dnt) Object.defineProperty(win.navigator, 'doNotTrack', { value: '1', configurable: true });
  return { dom: dom, sent: sent, win: win, now: now, load: function () { win.eval(SOURCE); } };
}
function setVisibility(win, v) {
  Object.defineProperty(win.document, 'visibilityState', { value: v, configurable: true });
  win.document.dispatchEvent(new win.Event('visibilitychange'));
}
const click = (e, id) => e.win.document.getElementById(id).dispatchEvent(new e.win.MouseEvent('click', { bubbles: true }));
const bodies = (e) => e.sent.map(function (s) { return s.body; });
const threw = (fn) => { try { fn(); return false; } catch (err) { return String(err && err.message || err); } };

const scenarios = {
  firstLoad() { const e = setup(); e.load(); return { sent: e.sent }; },

  sessionSequence() {
    const e = setup({ html: '<a id="a" href="/x">Buy</a><button id="b">Go</button>' });
    e.load();
    e.now.t += 4000; e.win.awTrack('gate_view');
    e.now.t += 4000; click(e, 'a');
    e.now.t += 4000; click(e, 'b'); click(e, 'b');
    e.win.awTrack('app_cta_click');
    setVisibility(e.win, 'hidden');
    return { sent: bodies(e) };
  },

  secondPageLoad() {
    const first = setup(); first.load();
    first.now.t += 2000; first.win.awTrack('gate_view');
    const stored = first.win.sessionStorage.getItem('aw_s_' + LIST);
    const second = setup({ sessionSeed: { ['aw_s_' + LIST]: stored } });
    second.now.t = first.now.t + 1000;
    second.load();
    const afterLoad = second.sent.length;
    second.win.awTrack('app_cta_click');
    return { first: bodies(first), afterLoad: afterLoad, second: bodies(second) };
  },

  staleSession() {
    const first = setup(); first.load();
    const stored = first.win.sessionStorage.getItem('aw_s_' + LIST);
    const later = setup({ sessionSeed: { ['aw_s_' + LIST]: stored } });
    later.now.t = first.now.t + 25 * 3600000;
    later.load();
    return { first: bodies(first), later: bodies(later), laterNow: later.now.t };
  },

  visitorId() {
    const e = setup({ seed: { aw_vid: 'not valid!!', aw_vcount: '4' } }); e.load();
    const again = setup({ seed: { aw_vid: e.sent[0].body.visitorId } }); again.load();
    return { sent: bodies(e), stored: e.win.localStorage.getItem('aw_vid'), cookie: e.win.document.cookie, again: bodies(again) };
  },

  visitorFromCookie() {
    const e = setup(); e.win.document.cookie = 'aw_vid=cookie-visitor-1234; path=/'; e.load();
    return { sent: bodies(e) };
  },

  firstTouch() {
    const e = setup(); e.load();
    const later = setup({ seed: { aw_ft_ref: 'l.instagram.com', aw_ft_url: URL_ }, url: 'https://go.example.com/other', referrer: 'https://www.google.com/' });
    later.load();
    return { storedRef: e.win.localStorage.getItem('aw_ft_ref'), storedUrl: e.win.localStorage.getItem('aw_ft_url'), later: bodies(later) };
  },

  pageExitFull() {
    const e = setup({ html: '<video id="v"></video>' }); e.load();
    const v = e.win.document.getElementById('v');
    const tick = function (c) { Object.defineProperty(v, 'currentTime', { value: c, configurable: true }); v.dispatchEvent(new e.win.Event('timeupdate')); };
    tick(0); tick(1); tick(2); tick(3.5); tick(60);
    Object.defineProperty(e.win.document.documentElement, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(e.win, 'innerHeight', { value: 1000, configurable: true });
    Object.defineProperty(e.win, 'pageYOffset', { value: 500, configurable: true });
    e.win.dispatchEvent(new e.win.Event('scroll'));
    e.now.t += 30000;
    setVisibility(e.win, 'hidden');
    return { sent: bodies(e) };
  },

  activeTime() {
    const e = setup(); e.load();
    e.now.t += 10000; setVisibility(e.win, 'hidden');
    e.now.t += 50000; setVisibility(e.win, 'visible');
    e.now.t += 5000; setVisibility(e.win, 'hidden');
    return { sent: bodies(e) };
  },

  hiddenThenPagehide() {
    const e = setup(); e.load();
    e.now.t += 10000; setVisibility(e.win, 'hidden');
    e.now.t += 10000; e.win.dispatchEvent(new e.win.Event('pagehide'));
    return { sent: bodies(e) };
  },

  pagehide() {
    const e = setup(); e.load();
    e.now.t += 3000; e.win.dispatchEvent(new e.win.Event('pagehide'));
    return { sent: bodies(e) };
  },

  beaconOk() { const e = setup(); e.load(); return { sent: e.sent }; },
  beaconFalse() { const e = setup({ beacon: 'false' }); e.load(); return { sent: e.sent }; },
  beaconThrows() { const e = setup({ beacon: 'throws' }); e.load(); return { sent: e.sent }; },
  beaconMissing() { const e = setup({ beacon: 'missing' }); e.load(); return { sent: e.sent }; },
  xhrOnly() { const e = setup({ beacon: 'missing', fetch: false }); e.load(); return { sent: e.sent }; },

  payloadCap() {
    const e = setup({ html: '<button id="b">' + 'x'.repeat(500) + '</button>' }); e.load();
    for (let i = 0; i < 250; i++) click(e, 'b');
    return { sizes: bodies(e).map(function (b) { return JSON.stringify(b).length; }), count: e.sent.length, last: e.sent[e.sent.length - 1].body };
  },

  manyEvents() {
    const e = setup({ html: '<button id="b">go</button>' }); e.load();
    for (let i = 0; i < 130; i++) click(e, 'b');
    return { counts: bodies(e).map(function (b) { return b.eventCount; }), journeyLen: bodies(e)[130].journey.split(' > ').length };
  },

  quotesPayload() {
    // JSON escaping doubles every quote: the worst case for the ingest's 16kb cap.
    const e = setup({ html: '<button id="b">' + '"'.repeat(100) + '</button>', url: 'https://go.example.com/p?x=' + 'a'.repeat(950), referrer: 'https://l.instagram.com/' + 'b'.repeat(950) }); e.load();
    for (let i = 0; i < 100; i++) click(e, 'b');
    const props = {}; for (let i = 0; i < 10; i++) props['k' + i] = '\u65e5\u672c'.repeat(60); // 3 bytes per character
    e.win.awTrack('big_props', props);
    const raw = e.sent.map(function (s) { return Buffer.byteLength(JSON.stringify(s.body), 'utf8'); });
    return { sizes: raw, count: e.sent.length, lastHasClickLabel: !!e.sent[e.sent.length - 2].body.clickLabel, last: e.sent[e.sent.length - 1].body };
  },

  cjkLabel() {
    const e = setup({ html: '<button id="b">\u8cfc\u5165 Buy \u4eca\u3059\u3050</button>' }); e.load(); click(e, 'b');
    return { sent: bodies(e) };
  },

  storageThrows() {
    const e = setup({ storageThrows: true });
    const loadErr = threw(function () { e.load(); });
    const trackErr = threw(function () { e.win.awTrack('app_cta_click'); });
    const hideErr = threw(function () { setVisibility(e.win, 'hidden'); });
    return { loadErr: loadErr, trackErr: trackErr, hideErr: hideErr, sent: bodies(e) };
  },

  corruptSession() {
    const e = setup({ sessionSeed: { ['aw_s_' + LIST]: '{"id": 5, "startMs": "x"' } });
    const err = threw(function () { e.load(); });
    return { err: err, sent: bodies(e) };
  },

  brokenTransport() {
    const e = setup({ beacon: 'throws', fetch: false, xhrThrows: true });
    return { loadErr: threw(function () { e.load(); }), trackErr: threw(function () { e.win.awTrack('lead_submit'); }) };
  },

  noListAttr() {
    const dom = new JSDOM('<script src="https://api.example.test/sdk/v1/aw.js"></script>', { url: URL_, runScripts: 'outside-only' });
    const err = threw(function () { dom.window.eval(SOURCE); });
    return { err: err, hasAwTrack: typeof dom.window.awTrack !== 'undefined' };
  },

  loadedTwice() { const e = setup(); e.load(); e.load(); return { sent: e.sent }; },

  awTrackApi() {
    const e = setup(); e.load();
    const r = {
      standard: e.win.awTrack('lead_submit'),
      custom: e.win.awTrack('Signup Clicked!', { plan: 'pro', n: 2, nested: { a: 1 }, fn: function () {} }),
      empty: e.win.awTrack(''),
      nul: e.win.awTrack(null),
      junk: e.win.awTrack('###'),
      lpViewAgain: e.win.awTrack('lp_view'),
    };
    return { returns: r, sent: bodies(e) };
  },

  clickLabels() {
    const e = setup({ html: '<div data-aw-section="hero"><a id="a" href="https://shop.test/x" data-aw-label="Hero CTA">ignored text</a><button id="t">' + 'T'.repeat(100) + '</button></div>' });
    e.load(); click(e, 'a'); click(e, 't');
    return { sent: bodies(e) };
  },

  videoPlay() {
    const e = setup({ html: '<video id="v"></video><video id="bg" muted loop></video>' }); e.load();
    const play = function (id) { e.win.document.getElementById(id).dispatchEvent(new e.win.Event('play')); };
    play('bg'); play('v'); play('v');
    return { sent: bodies(e) };
  },

  awqReplay() {
    const e = setup(); e.win.awq = [['app_cta_click', {}], ['early_thing', { a: 1 }]]; e.load();
    return { sent: bodies(e) };
  },

  superProps() {
    const e = setup();
    e.win.awSuper = { funnel_type: 'free_trial', is_login: false, session_intent_score: 3, bad: { x: 1 } };
    e.load();
    e.win.awRegister({ funnel_type: 'funnel_review' });
    e.win.awTrack('cta_click', { cta_name: 'x' });
    setVisibility(e.win, 'hidden');
    const stored = e.win.sessionStorage.getItem('aw_s_' + LIST);
    const second = setup({ sessionSeed: { ['aw_s_' + LIST]: stored } });
    second.load();
    second.win.awTrack('next_page');
    return { sent: bodies(e), second: bodies(second) };
  },

  superNonAscii() {
    // Opslane run 1360: 20 x 300 katakana registered values are ~7k characters but ~19k UTF-8 bytes.
    const e = setup();
    const sup = {}; for (let i = 0; i < 20; i++) sup['k' + i] = '\u30c6'.repeat(300);
    e.win.awSuper = sup;
    e.load();
    return { sizes: e.sent.map(function (s) { return Buffer.byteLength(JSON.stringify(s.body), 'utf8'); }), sent: bodies(e) };
  },

  dntDefault() { const e = setup({ dnt: true }); e.load(); return { sent: bodies(e) }; },
  dntOptIn() {
    const e = setup({ dnt: true, scriptAttrs: 'data-aw-respect-dnt' }); e.load();
    const r = e.win.awTrack('app_cta_click');
    return { sent: bodies(e), returned: r };
  },
};

const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
SOURCE = input.source;
const results = {};
Object.keys(scenarios).forEach(function (name) {
  try { results[name] = scenarios[name](); } catch (err) { results[name] = { __error: String(err && err.stack || err) }; }
});
process.stdout.write(JSON.stringify({ results: results }));
