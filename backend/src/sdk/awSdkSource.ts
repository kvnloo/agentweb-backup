/**
 * ENG-2315: the browser tracker served at GET /sdk/v1/aw.js.
 *
 * It is a TypeScript string constant rather than a .js file on purpose: `tsc` emits only what it
 * compiles, and the Elastic Beanstalk bundle ships `dist` + package.json — a plain
 * `src/sdk/aw.js` (or `public/`) would build, pass every test, and be a 404 in production. A string
 * constant is part of the compiled module, so it is in `dist` by construction.
 *
 * Rules for editing the source below (a test enforces them):
 *   - plain ES5: no let/const/arrow/template literals/classes; it runs in old in-app browsers;
 *   - no backtick and no "${" anywhere (it lives inside a template literal);
 *   - no external dependencies; never throws into the host page; every payload is bounded.
 * Bump the path version (/sdk/v1 -> /sdk/v2) for any change that is not backward compatible with
 * the ingest contract; a pasted <script> tag cannot be updated by us.
 */
export const AW_SDK_SOURCE: string = String.raw`/* AgentWeb tracker v1. One session row per visit; events are best-effort beacons. */
(function (win, doc) {
  'use strict';
  try {
    if (win.__awTrackerLoaded) return;

    var script = doc.currentScript;
    if (!script) {
      var all = doc.getElementsByTagName('script');
      for (var si = all.length - 1; si >= 0; si--) {
        if (all[si].getAttribute && all[si].getAttribute('data-aw-list')) { script = all[si]; break; }
      }
    }
    var listId = script && script.getAttribute ? script.getAttribute('data-aw-list') : '';
    var base = /^(https?:\/\/[^\/?#]+)/i.exec((script && script.src) || '');
    if (!listId || !base) return;
    var endpoint = base[1] + '/api/track/event';

    // Do-Not-Track is OFF by default (consistent with the existing landing pages, which never honoured
    // it). A site that wants it adds data-aw-respect-dnt to the script tag; GPC is honoured with it.
    var respectDnt = !!(script.hasAttribute && script.hasAttribute('data-aw-respect-dnt'));
    var nav = win.navigator || {};
    var dnt = nav.doNotTrack === '1' || win.doNotTrack === '1' || nav.msDoNotTrack === '1' || nav.globalPrivacyControl === true;
    win.__awTrackerLoaded = true;
    if (respectDnt && dnt) { win.awTrack = function () { return false; }; return; }

    var MAX_EVENTS = 300;      // per session, then only page_exit: a runaway page cannot flood the list
    var MAX_JOURNEY = 120;
    var MAX_JOURNEY_CHARS = 2900;
    var MAX_CLICKS = 80;
    var SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // the ingest only accepts sessions started in the last 48h
    var ORDER = ['lp_view', 'play_start', 'episode_complete', 'gate_view', 'app_cta_click', 'lead_submit'];
    var STANDARD = ['lp_view', 'play_start', 'episode_complete', 'gate_view', 'app_cta_click', 'lead_submit', 'click', 'page_exit'];
    var ID_RE = /^[a-z0-9-]{8,64}$/i;

    function uuid() {
      try { if (win.crypto && win.crypto.randomUUID) return win.crypto.randomUUID(); } catch (e) {}
      try {
        if (win.crypto && win.crypto.getRandomValues) {
          var b = new Uint8Array(16), s = '';
          win.crypto.getRandomValues(b);
          for (var i = 0; i < 16; i++) s += (b[i] + 256).toString(16).slice(1);
          return s;
        }
      } catch (e2) {}
      return String(Date.now()) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    function lsGet(k) { try { return win.localStorage.getItem(k) || ''; } catch (e) { return ''; } }
    function lsSet(k, v) { try { win.localStorage.setItem(k, v); } catch (e) {} }
    function ssGet(k) { try { return win.sessionStorage.getItem(k) || ''; } catch (e) { return ''; } }
    function ssSet(k, v) { try { win.sessionStorage.setItem(k, v); } catch (e) {} }
    function qp(name) {
      var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(win.location.search || '');
      if (!m) return '';
      try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) { return m[1]; }
    }
    function hostOf(u) { var m = /^https?:\/\/([^\/?#:]+)/i.exec(u || ''); return m ? m[1].toLowerCase().replace(/^www\./, '') : ''; }

    // visitorId: localStorage first, cookie as fallback, regex-validated, 1 year.
    function visitorId() {
      var v = lsGet('aw_vid');
      if (!v) {
        try {
          var m = /(?:^|; )aw_vid=([^;]*)/.exec(doc.cookie || '');
          v = m ? decodeURIComponent(m[1]) : '';
        } catch (e) { v = ''; }
      }
      if (!ID_RE.test(v)) v = uuid();
      lsSet('aw_vid', v);
      try {
        doc.cookie = 'aw_vid=' + v + '; path=/; max-age=31536000; SameSite=Lax' + (win.location.protocol === 'https:' ? '; Secure' : '');
      } catch (e2) {}
      return v;
    }
    var vid = visitorId();

    // First touch: the FIRST landing URL and referrer host this browser ever had. The server
    // classifies them; the SDK never decides a channel. aw_ft_ch (written by older page-local
    // trackers) is passed through if present.
    function firstTouch() {
      var land = lsGet('aw_ft_url'), ref = lsGet('aw_ft_ref');
      if (!land && !ref) {
        var r = '';
        try { r = hostOf(doc.referrer); } catch (e) {}
        if (r === hostOf(win.location.href)) r = '';
        land = String(win.location.href || '').slice(0, 1000);
        ref = r || 'direct';
        lsSet('aw_ft_url', land); lsSet('aw_ft_ref', ref);
      }
      return { url: land, ref: ref, ch: lsGet('aw_ft_ch') };
    }
    var ft = firstTouch();

    var sk = 'aw_s_' + listId;
    function newSession() {
      var n = (parseInt(lsGet('aw_vcount'), 10) || 0) + 1;
      lsSet('aw_vcount', String(n));
      var ref = '';
      try { ref = doc.referrer || ''; } catch (e) {}
      return {
        id: uuid(), startMs: Date.now(), visitNo: n, count: 0, stage: -1, sent: {},
        journey: [], jlen: 0, clicks: [], nclicks: 0,
        landing: String(win.location.href || '').slice(0, 1000), ref: String(ref).slice(0, 1000),
        lpVariant: (qp('lp_variant') || qp('utm_content')).slice(0, 80),
        creativeId: (qp('creative_id') || qp('ad_id') || qp('utm_term')).slice(0, 80)
      };
    }
    var st = null;
    try { st = JSON.parse(ssGet(sk) || 'null'); } catch (e) { st = null; }
    // sessionStartMs is minted ONCE per browser session and reused on every event: a changing start
    // time would change the server's row id and split one session into duplicates.
    if (!st || typeof st.id !== 'string' || !ID_RE.test(st.id) || typeof st.startMs !== 'number' ||
        Date.now() - st.startMs > SESSION_MAX_AGE_MS || st.startMs > Date.now() + 60000) {
      st = newSession();
    }
    // ENG-2689: pages viewed this session including this one (super property session_page_num).
    st.pages = (typeof st.pages === 'number' && st.pages >= 0 ? st.pages : 0) + 1;
    function save() { try { ssSet(sk, JSON.stringify(st)); } catch (e) {} }
    save();

    var t0 = Date.now();
    var dw = { act: 0, vis: doc.visibilityState !== 'hidden' ? Date.now() : 0, vid: 0, scr: 0 };
    var videoPrev = [];
    var videoPrevEls = [];

    // UTF-8 byte size of a string: the ingest limit is in bytes, and non-ASCII registered values take 2-4
    // bytes per character, so a character count under-measures them (Opslane run 1360).
    function utf8Bytes(str) {
      var n = 0;
      for (var bi = 0; bi < str.length; bi++) {
        var c = str.charCodeAt(bi);
        n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c < 0xe000) ? 2 : 3;
      }
      return n;
    }

    function transmit(body) {
      var s = JSON.stringify(body);
      // The ingest rejects > 16kb (bytes). Shed the cumulative strings first, keep the event.
      if (utf8Bytes(s) > 15000) {
        body.journey = ''; body.clickLog = ''; body.showsClicked = '';
        s = JSON.stringify(body);
      }
      // Registered super values (site-owner awSuper/awRegister) can still push it over: drop them, keep
      // the automatic ones (#url, #title, ...) and the event.
      if (utf8Bytes(s) > 15000 && body['super']) {
        body['super'] = superProps(false);
        s = JSON.stringify(body);
      }
      try {
        if (nav.sendBeacon && nav.sendBeacon(endpoint, new Blob([s], { type: 'text/plain;charset=UTF-8' }))) return true;
      } catch (e) {}
      try {
        if (win.fetch) {
          // keepalive so the request survives the page being unloaded; text/plain keeps it a "simple"
          // request (no CORS preflight). The result is deliberately ignored.
          win.fetch(endpoint, { method: 'POST', body: s, keepalive: true, mode: 'cors', credentials: 'omit',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' } })['catch'](function () {});
          return true;
        }
      } catch (e2) {}
      try {
        var x = new XMLHttpRequest();
        x.open('POST', endpoint, true);
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(s);
        return true;
      } catch (e3) {}
      return false;
    }

    // ENG-2689: super properties attached to every event. Presets the browser knows, plus whatever the
    // host page registers with awRegister({...}) (registered values win). The ingest keeps only the names
    // in its fixed super-property table, typed and bounded, so unknown keys here are harmless.
    var superReg = {}, superN = 0;
    function superProps(includeRegistered) {
      var o = {}, k;
      try {
        o['#event_time'] = Date.now();
        o['#lib'] = 'js'; o['#lib_version'] = '1';
        o['#device_id'] = vid;
        o['#url'] = String(win.location.href).slice(0, 1000);
        if (doc.referrer) o['#referrer'] = String(doc.referrer).slice(0, 1000);
        if (doc.title) o['#title'] = String(doc.title).slice(0, 300);
        if (nav.userAgent) o['#ua'] = String(nav.userAgent).slice(0, 300);
        if (nav.language) o['#system_language'] = String(nav.language).slice(0, 2).toLowerCase();
        if (win.screen && win.screen.width) { o['#screen_width'] = win.screen.width; o['#screen_height'] = win.screen.height; }
        o['#zone_offset'] = -new Date().getTimezoneOffset() / 60;
        o.site_domain = String(win.location.hostname).replace(/^www\./, '').slice(0, 120);
        o.session_page_num = st.pages || 1;
      } catch (e) {}
      if (includeRegistered !== false) {
        for (k in superReg) if (Object.prototype.hasOwnProperty.call(superReg, k)) o[k] = superReg[k];
      }
      return o;
    }
    function register(p) {
      try {
        if (!p || typeof p !== 'object') return false;
        for (var k in p) {
          if (!Object.prototype.hasOwnProperty.call(p, k) || typeof k !== 'string' || k.length > 40) continue;
          var v = p[k], ok;
          if (typeof v === 'string') { v = v.slice(0, 300); ok = true; }
          else ok = (typeof v === 'number' && isFinite(v)) || typeof v === 'boolean';
          // Count a key only once its value is accepted, so invalid values never consume a slot.
          if (!ok) continue;
          if (!Object.prototype.hasOwnProperty.call(superReg, k)) { if (superN >= 60) continue; superN++; }
          superReg[k] = v;
        }
        return true;
      } catch (e) { return false; }
    }
    win.awRegister = register;
    // Registered before the script loaded: window.awSuper = { funnel_type: 'free_trial', ... }
    try { if (win.awSuper) register(win.awSuper); } catch (e) {}

    function baseBody(ev) {
      // clientNowMs: the device clock NOW, so the server can tell a clock that is ahead (its startMs is rejected as
      // future until the clock catches up, which would move the session to a new row mid-session) from a normal one.
      var b = {
        listId: listId, event: ev, sessionId: st.id, sessionStartMs: st.startMs, clientNowMs: Date.now(), visitorId: vid, visitNo: st.visitNo,
        eventCount: st.count, landingUrl: st.landing, referrer: st.ref,
        firstTouchLanding: ft.url, firstTouchReferrer: ft.ref
      };
      if (ft.ch) b.firstTouchChannel = ft.ch;
      if (st.stage >= 0) b.furthestStage = ORDER[st.stage];
      if (st.last) b.lastEvent = st.last; // cumulative, like furthestStage: lets a click/page_exit keep it right if events overtake each other
      if (st.lpVariant) b.lpVariant = st.lpVariant;
      if (st.creativeId) b.creativeId = st.creativeId;
      if (st.journey.length) b.journey = st.journey.join(' > ');
      // Cumulative on EVERY event, like journey: the server guards them with eventCount, so a click that
      // is overtaken on the wire by a later event must not be the only carrier of the click log.
      if (st.nclicks) { b.clickCount = st.nclicks; b.clickLog = st.clicks.join(' > ').slice(-4000); }
      b['super'] = superProps();
      return b;
    }

    function scalarProps(p) {
      var out = {}, n = 0;
      if (!p || typeof p !== 'object') return out;
      for (var k in p) {
        if (n >= 10) break;
        if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
        var v = p[k];
        if (typeof v === 'string') out[k] = v.slice(0, 120);
        else if (typeof v === 'number' && isFinite(v)) out[k] = v;
        else if (typeof v === 'boolean') out[k] = v;
        else continue;
        n++;
      }
      return out;
    }

    // One funnel/custom/click event. "once" events are sent at most once per session.
    function send(ev, extra, once, customName) {
      try {
        var key = ev + (customName ? ':' + customName : '');
        if (once && st.sent[key]) return false;
        if (st.count >= MAX_EVENTS) return false;
        st.sent[key] = 1;
        var i = ORDER.indexOf(ev);
        if (i > st.stage) st.stage = i;
        st.count++;
        if (ev !== 'click') st.last = ev === 'custom' ? 'custom:' + customName : ev;
        var secs = Math.round((Date.now() - st.startMs) / 1000);
        var label = ev === 'click' ? 'click:' + String((extra && extra.clickLabel) || '').slice(0, 40) : ev === 'custom' ? 'custom:' + customName : ev;
        var entry = label + ' +' + secs + 's';
        if (st.journey.length < MAX_JOURNEY && st.jlen + entry.length + 3 <= MAX_JOURNEY_CHARS) {
          st.journey.push(entry);
          st.jlen += entry.length + 3;
        }
        if (ev === 'click' && extra) {
          st.nclicks++;
          st.clicks.push(extra.clickLabel + ' (' + (extra.clickSection || 'page') + ') +' + secs + 's');
          if (st.clicks.length > MAX_CLICKS) st.clicks.shift();
        }
        var body = baseBody(ev);
        if (customName) { body.name = customName; if (extra && extra.props) body.props = extra.props; }
        if (ev === 'click' && extra) {
          body.clickLabel = extra.clickLabel; body.clickSection = extra.clickSection; body.clickUrl = extra.clickUrl;
        }
        if (extra && extra.ep) body.ep = extra.ep;
        save();
        return transmit(body);
      } catch (e) { return false; }
    }

    // Cumulative dwell (total / active-while-visible / video / max scroll). Sent on every hide, so the
    // last one wins; it carries the CURRENT eventCount and does not count as a journey event.
    var lastFlush = 0;
    function flushDwell() {
      try {
        var now = Date.now();
        if (now - lastFlush < 500) return;
        lastFlush = now;
        if (dw.vis) { dw.act += now - dw.vis; dw.vis = 0; }
        var b = baseBody('page_exit');
        b.dwellSec = Math.round((now - t0) / 1000);
        b.activeSec = Math.round(dw.act / 1000);
        b.videoWatchSec = Math.round(dw.vid);
        b.maxScrollPct = dw.scr;
        transmit(b);
      } catch (e) {}
    }

    function onVisibility() {
      try {
        if (doc.visibilityState === 'hidden') flushDwell(); else dw.vis = Date.now();
      } catch (e) {}
    }
    doc.addEventListener('visibilitychange', onVisibility);
    win.addEventListener('pagehide', flushDwell);

    win.addEventListener('scroll', function () {
      try {
        var el = doc.documentElement;
        var h = el.scrollHeight - (win.innerHeight || 0);
        if (h > 0) dw.scr = Math.max(dw.scr, Math.min(100, Math.round(100 * (win.pageYOffset || 0) / h)));
      } catch (e) {}
    }, true);

    // Video: seconds actually played (a jump or seek larger than 2s is not watch time).
    win.addEventListener('timeupdate', function (e) {
      try {
        var v = e.target;
        if (!v || v.tagName !== 'VIDEO' || (v.muted && v.loop)) return;
        var ix = videoPrevEls.indexOf(v);
        if (ix < 0) { videoPrevEls.push(v); videoPrev.push(v.currentTime); return; }
        var c = v.currentTime, p = videoPrev[ix];
        if (c > p && c - p < 2) dw.vid += c - p;
        videoPrev[ix] = c;
      } catch (e2) {}
    }, true);
    win.addEventListener('play', function (e) {
      try {
        var v = e.target;
        if (!v || v.tagName !== 'VIDEO' || (v.muted && v.loop)) return;
        send('play_start', null, true);
      } catch (e2) {}
    }, true);

    // Clicks: links and buttons. Label = data-aw-label, else aria-label, else visible text (capped).
    function labelOf(el) {
      var holder = el, a = '';
      while (holder && holder.getAttribute) {
        a = holder.getAttribute('data-aw-label');
        if (a) break;
        holder = holder.parentNode;
      }
      var t = (a || (el.getAttribute && el.getAttribute('aria-label')) || el.innerText || el.value || el.textContent || el.tagName || '');
      // ASCII only: the ingest keeps only [\w.@+:/ -] anyway, and a 3-byte character would eat the payload budget.
      return String(t).replace(/\s+/g, ' ').replace(/[^\x20-\x7e]/g, '').replace(/^ | $/g, '').slice(0, 60);
    }
    function closest(el, sel) {
      while (el && el.nodeType === 1) {
        var m = el.matches || el.msMatchesSelector || el.webkitMatchesSelector;
        if (m && m.call(el, sel)) return el;
        el = el.parentNode;
      }
      return null;
    }
    win.addEventListener('click', function (e) {
      try {
        var el = closest(e.target, 'a,button,[role=button],input[type=submit],[data-aw-label]');
        if (!el) return;
        var a = closest(el, 'a');
        var sec = '';
        var sx = closest(el, '[data-aw-section]');
        if (sx) sec = String(sx.getAttribute('data-aw-section') || '').slice(0, 40);
        send('click', { clickLabel: labelOf(el), clickSection: sec, clickUrl: a && a.href ? String(a.href).slice(0, 300) : '' }, false);
      } catch (e2) {}
    }, true);

    // Public API. Standard funnel names are sent as themselves; anything else becomes a "custom" event.
    function track(name, props) {
      try {
        if (typeof name !== 'string' || !name) return false;
        var n = name.toLowerCase();
        if (STANDARD.indexOf(n) >= 0 && n !== 'click' && n !== 'page_exit') {
          return send(n, null, n === 'lp_view' || n === 'play_start');
        }
        var slug = n.replace(/[^a-z0-9_-]/g, '_').replace(/^[^a-z0-9]+/, '').slice(0, 32);
        if (!slug) return false;
        return send('custom', { props: scalarProps(props) }, false, slug);
      } catch (e) { return false; }
    }
    win.awTrack = track;

    // Calls made before the script loaded: window.awq = window.awq || []; awq.push(['name', {props}])
    try {
      var q = win.awq;
      if (q && q.length) for (var qi = 0; qi < q.length; qi++) if (q[qi] && q[qi].length) track(q[qi][0], q[qi][1]);
      win.awq = { push: function (a) { if (a && a.length) track(a[0], a[1]); } };
    } catch (e3) {}

    send('lp_view', null, true);
  } catch (err) { /* a tracker must never break the page */ }
})(window, document);
`;
