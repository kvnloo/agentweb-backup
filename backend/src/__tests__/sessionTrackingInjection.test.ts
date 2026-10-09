/**
 * ENG-2327 — injector contract for the session-tracking SDK tag.
 *
 * Pins: placement for several real-looking layout shapes (incl. ones already carrying GTM / Meta
 * pixel / Google Ads), static HTML with and without <head>, refusal of pages that already carry a
 * tracker, idempotency, removal, and the verify function.
 */
import {
  SessionTrackingInjectionError,
  extractInstalledListId,
  findExistingTracker,
  injectSessionTrackingIntoHtml,
  injectSessionTrackingIntoLayout,
  sdkScriptUrl,
  verifySessionTrackingInjection,
} from '../utils/sessionTrackingInjection';
import { injectGtmIntoLayout, verifyGtmInjection } from '../utils/gtmInjection';
import { injectPixelIntoLayout, verifyPixelInjection } from '../utils/pixelInjection';
import { injectGoogleAdsIntoLayout, verifyGoogleAdsInjection } from '../utils/googleAdsInjection';

const LIST = 'list_1700000000000_abc123xyz';
const START = '{/* AgentWeb Session Tracking */}';
const END = '{/* End AgentWeb Session Tracking */}';

const V0_LAYOUT = `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Compare", description: "" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="theme-color" content="#000" />
      </head>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
`;
const NO_HEAD_LAYOUT = `export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        {children}
      </body>
    </html>
  )
}
`;
const SELF_CLOSING_HEAD_LAYOUT = `export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head />
      <body>{children}</body>
    </html>
  )
}
`;
const HEADER_ELEMENT_LAYOUT = `export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <header className="top">hi</header>
        {children}
      </body>
    </html>
  )
}
`;
const NO_ANCHOR = `export default function RootLayout({ children }) { return children }\n`;

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('injectSessionTrackingIntoLayout', () => {
  it('inserts one block right after <head> with the SDK url and list id', () => {
    const out = injectSessionTrackingIntoLayout(V0_LAYOUT, LIST);
    expect(count(out, START)).toBe(1);
    expect(out).toContain(`<script src="${sdkScriptUrl()}" data-aw-list="${LIST}" async />`);
    expect(out.indexOf('<head>')).toBeLessThan(out.indexOf(START));
    expect(out.indexOf(START)).toBeLessThan(out.indexOf('<meta name="theme-color"'));
    expect(verifySessionTrackingInjection(out, 'layout', LIST)).toBe(true);
    // Round trip: removing the block gives the original file back byte for byte.
    expect(injectSessionTrackingIntoLayout(out, '')).toBe(V0_LAYOUT);
  });

  it('places the block as the first child of <body> when the layout has no <head>', () => {
    const out = injectSessionTrackingIntoLayout(NO_HEAD_LAYOUT, LIST);
    expect(out.indexOf('<body')).toBeLessThan(out.indexOf(START));
    expect(out.indexOf(END)).toBeLessThan(out.indexOf('{children}'));
    expect(injectSessionTrackingIntoLayout(out, '')).toBe(NO_HEAD_LAYOUT);
  });

  it('expands a self-closing <head /> instead of leaving the script as a sibling of it', () => {
    const out = injectSessionTrackingIntoLayout(SELF_CLOSING_HEAD_LAYOUT, LIST);
    expect(out).toMatch(/<head>\s*\{\/\* AgentWeb Session Tracking \*\/\}[\s\S]*<\/head>/);
    expect(out).not.toContain('<head />');
    expect(verifySessionTrackingInjection(out, 'layout', LIST)).toBe(true);
  });

  it('does not mistake <header> for <head> (falls back to <body>)', () => {
    const out = injectSessionTrackingIntoLayout(HEADER_ELEMENT_LAYOUT, LIST);
    expect(out.indexOf('<body>')).toBeLessThan(out.indexOf(START));
    expect(out.indexOf(END)).toBeLessThan(out.indexOf('<header'));
  });

  it('is idempotent: a second run is byte-identical and never duplicates the block', () => {
    for (const src of [V0_LAYOUT, NO_HEAD_LAYOUT, SELF_CLOSING_HEAD_LAYOUT, HEADER_ELEMENT_LAYOUT]) {
      const once = injectSessionTrackingIntoLayout(src, LIST);
      const twice = injectSessionTrackingIntoLayout(once, LIST);
      expect(twice).toBe(once);
      expect(count(twice, START)).toBe(1);
    }
  });

  it('replaces the list id when re-run with a different one (still exactly one block)', () => {
    const a = injectSessionTrackingIntoLayout(V0_LAYOUT, LIST);
    const b = injectSessionTrackingIntoLayout(a, 'list_other_id_999');
    expect(count(b, START)).toBe(1);
    expect(b).not.toContain(LIST);
    expect(extractInstalledListId(b, 'layout')).toBe('list_other_id_999');
  });

  it('coexists with GTM, Meta pixel and Google Ads blocks in either order, leaving each verifiable', () => {
    const third = injectGoogleAdsIntoLayout(injectPixelIntoLayout(injectGtmIntoLayout(V0_LAYOUT, 'GTM-ABCD12'), '1234567890'), 'AW-123456789');
    const withUs = injectSessionTrackingIntoLayout(third, LIST);
    expect(verifySessionTrackingInjection(withUs, 'layout', LIST)).toBe(true);
    expect(verifyGtmInjection(withUs, 'GTM-ABCD12')).toBe(true);
    expect(verifyPixelInjection(withUs, '1234567890')).toBe(true);
    expect(verifyGoogleAdsInjection(withUs, 'AW-123456789')).toBe(true);

    // Other direction: ours first, then the other injectors run over it.
    const ours = injectSessionTrackingIntoLayout(V0_LAYOUT, LIST);
    const later = injectGoogleAdsIntoLayout(injectPixelIntoLayout(injectGtmIntoLayout(ours, 'GTM-ABCD12'), '1234567890'), 'AW-123456789');
    expect(verifySessionTrackingInjection(later, 'layout', LIST)).toBe(true);
    expect(verifyGtmInjection(later, 'GTM-ABCD12')).toBe(true);
    expect(verifyPixelInjection(later, '1234567890')).toBe(true);
    // Removing ours must not disturb theirs.
    const removed = injectSessionTrackingIntoLayout(later, '');
    expect(verifySessionTrackingInjection(removed, 'layout', '')).toBe(true);
    expect(verifyGtmInjection(removed, 'GTM-ABCD12')).toBe(true);
    expect(verifyPixelInjection(removed, '1234567890')).toBe(true);
  });

  it('refuses a layout with nothing to anchor on, with a clear error', () => {
    expect(() => injectSessionTrackingIntoLayout(NO_ANCHOR, LIST)).toThrow(SessionTrackingInjectionError);
    try {
      injectSessionTrackingIntoLayout(NO_ANCHOR, LIST);
    } catch (e: any) {
      expect(e.code).toBe('unsupported_shape');
      expect(e.message).toMatch(/no <head> or <body>/);
    }
  });

  it.each([
    ['an SDK tag placed by hand', `<head><script src="https://api.agentweb.pro/sdk/v1/aw.js" data-aw-list="list_old_000001" async></script></head>`, 'data-aw-list'],
    ['the bespoke aw_sess_ tracker', `<head></head><body><script>var k = "aw_sess_" + id;</script></body>`, 'aw_sess_'],
    ['the bespoke session_start_ms tracker', `<head></head><body><script>var t = session_start_ms;</script></body>`, 'session_start_ms'],
    ['the SDK url alone', `<head><script src="/sdk/v1/aw.js"></script></head>`, '/sdk/v1/aw.js'],
  ])('refuses a layout that already carries %s', (_name, extra, signature) => {
    const layout = V0_LAYOUT.replace('<head>', `<head>${extra}`).replace('<body', `<body data-x="1"`);
    expect(findExistingTracker(layout, 'layout')).toBe(signature);
    expect(() => injectSessionTrackingIntoLayout(layout, LIST)).toThrow(/already carries its own tracker/);
    try { injectSessionTrackingIntoLayout(layout, LIST); } catch (e: any) { expect(e.code).toBe('existing_tracker'); }
  });

  it('honours an explicit override, and still never doubles up OUR block', () => {
    const foreign = V0_LAYOUT.replace('<head>', '<head><script>var k="aw_sess_"</script>');
    const out = injectSessionTrackingIntoLayout(foreign, LIST, { overrideExistingTracker: true });
    expect(count(out, START)).toBe(1);
    expect(out).toContain('aw_sess_');
  });

  it('our own block is never mistaken for a foreign tracker', () => {
    const ours = injectSessionTrackingIntoLayout(V0_LAYOUT, LIST);
    expect(findExistingTracker(ours, 'layout')).toBeNull();
  });

  it('refuses an orphaned half block (start marker without end) instead of stacking on it', () => {
    const broken = V0_LAYOUT.replace('<head>', `<head>\n        ${START}\n        <script data-aw-list="${LIST}" />`);
    expect(() => injectSessionTrackingIntoLayout(broken, LIST)).toThrow(/already carries its own tracker/);
  });

  it.each(['', 'a', 'list id with spaces', 'x"onload="1', "list_'};alert(1);//aaaa", 'a'.repeat(81)])(
    'rejects an unsafe or implausible list id %p without touching the file',
    (bad) => {
      if (bad === '') return; // '' is the removal path
      expect(() => injectSessionTrackingIntoLayout(V0_LAYOUT, bad)).toThrow(SessionTrackingInjectionError);
    },
  );

  it('refuses an oversized file', () => {
    expect(() => injectSessionTrackingIntoLayout(V0_LAYOUT + ' '.repeat(600_000), LIST)).toThrow(/larger than/);
  });

  it('refuses when BACKEND_URL would produce an unsafe src', () => {
    const prev = process.env.BACKEND_URL;
    process.env.BACKEND_URL = 'https://x.test/"><script>alert(1)</script>';
    try {
      expect(() => injectSessionTrackingIntoLayout(V0_LAYOUT, LIST)).toThrow(/safe SDK script URL/);
    } finally {
      if (prev === undefined) delete process.env.BACKEND_URL; else process.env.BACKEND_URL = prev;
    }
  });

  it.each(['http://api.example.com', 'ftp://api.example.com', 'https://', 'api.example.com'])(
    'refuses a non-https (or malformed) BACKEND_URL %p, but allows loopback http for local development',
    (url) => {
      const prev = process.env.BACKEND_URL;
      process.env.BACKEND_URL = url;
      try {
        expect(() => injectSessionTrackingIntoLayout(V0_LAYOUT, LIST)).toThrow(/safe SDK script URL/);
        process.env.BACKEND_URL = 'http://localhost:3001';
        expect(injectSessionTrackingIntoLayout(V0_LAYOUT, LIST)).toContain('http://localhost:3001/sdk/v1/aw.js');
      } finally {
        if (prev === undefined) delete process.env.BACKEND_URL; else process.env.BACKEND_URL = prev;
      }
    },
  );

  it('removal on a page with no block is a no-op, even with a foreign tracker present', () => {
    const foreign = V0_LAYOUT.replace('<head>', '<head><script>var k="aw_sess_"</script>');
    expect(injectSessionTrackingIntoLayout(foreign, '')).toBe(foreign);
  });
});

describe('verifySessionTrackingInjection', () => {
  const ok = injectSessionTrackingIntoLayout(V0_LAYOUT, LIST);
  it('true only for exactly one block with that exact list id', () => {
    expect(verifySessionTrackingInjection(ok, 'layout', LIST)).toBe(true);
    expect(verifySessionTrackingInjection(ok, 'layout', 'list_other_id_999')).toBe(false);
    expect(verifySessionTrackingInjection(V0_LAYOUT, 'layout', LIST)).toBe(false);
    expect(verifySessionTrackingInjection(ok + ok, 'layout', LIST)).toBe(false);
  });
  it('removal verification: zero blocks', () => {
    expect(verifySessionTrackingInjection(V0_LAYOUT, 'layout', '')).toBe(true);
    expect(verifySessionTrackingInjection(ok, 'layout', '')).toBe(false);
  });
  it('rejects a block that sits before any opening <head>/<body>', () => {
    const block = ok.match(/\{\/\* AgentWeb Session Tracking \*\/\}[\s\S]*?\{\/\* End AgentWeb Session Tracking \*\/\}/)![0];
    expect(verifySessionTrackingInjection(`${block}\n${V0_LAYOUT}`, 'layout', LIST)).toBe(false);
  });
  it('reads the installed list id back', () => {
    expect(extractInstalledListId(ok, 'layout')).toBe(LIST);
    expect(extractInstalledListId(V0_LAYOUT, 'layout')).toBeNull();
    expect(extractInstalledListId(ok + ok, 'layout')).toBeNull();
  });
});

describe('injectSessionTrackingIntoHtml', () => {
  const WITH_HEAD = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Drama</title>
</head>
<body><h1>hi</h1></body>
</html>
`;
  const NO_HEAD = `<!doctype html>\n<html lang="en">\n<body><h1>hi</h1></body>\n</html>\n`;
  const BODY_ONLY = `<body><h1>hi</h1></body>\n`;

  it('inserts after <head> with an HTML comment block, and is idempotent + reversible', () => {
    const out = injectSessionTrackingIntoHtml(WITH_HEAD, LIST);
    expect(out).toContain(`<script src="${sdkScriptUrl()}" data-aw-list="${LIST}" async></script>`);
    expect(out.indexOf('<head>')).toBeLessThan(out.indexOf('<!-- AgentWeb Session Tracking -->'));
    expect(out.indexOf('<!-- End AgentWeb Session Tracking -->')).toBeLessThan(out.indexOf('<meta charset'));
    expect(verifySessionTrackingInjection(out, 'html', LIST)).toBe(true);
    expect(injectSessionTrackingIntoHtml(out, LIST)).toBe(out);
    expect(injectSessionTrackingIntoHtml(out, '')).toBe(WITH_HEAD);
  });

  it('creates a <head> under <html> when the page has none', () => {
    const out = injectSessionTrackingIntoHtml(NO_HEAD, LIST);
    expect(out).toMatch(/<html lang="en">\n  <head>\n[\s\S]*<\/head>\n<body>/);
    expect(verifySessionTrackingInjection(out, 'html', LIST)).toBe(true);
    expect(injectSessionTrackingIntoHtml(out, LIST)).toBe(out);
  });

  it('falls back to before <body> when there is no <html> either', () => {
    const out = injectSessionTrackingIntoHtml(BODY_ONLY, LIST);
    expect(out.indexOf('<!-- AgentWeb')).toBeLessThan(out.indexOf('<body>'));
    expect(injectSessionTrackingIntoHtml(out, '')).toBe(BODY_ONLY);
  });

  it('refuses a fragment with no head, html or body', () => {
    expect(() => injectSessionTrackingIntoHtml('<div>just a fragment</div>', LIST)).toThrow(/no <head>, <html> or <body>/);
  });

  it('refuses a page that already carries a tracker (the DramaBreak case) unless overridden', () => {
    const drama = WITH_HEAD.replace('</head>', '<script>localStorage.setItem("aw_sess_" + pid, id)</script></head>');
    expect(() => injectSessionTrackingIntoHtml(drama, LIST)).toThrow(/already carries its own tracker/);
    const sdk = WITH_HEAD.replace('</head>', `<script src="https://api.agentweb.pro/sdk/v1/aw.js" data-aw-list="list_old_000001"></script></head>`);
    expect(() => injectSessionTrackingIntoHtml(sdk, LIST)).toThrow(/already carries its own tracker/);
    expect(injectSessionTrackingIntoHtml(drama, LIST, { overrideExistingTracker: true })).toContain(LIST);
  });

  it('does not match <header> as <head>', () => {
    const page = `<html><body><header>x</header></body></html>`;
    const out = injectSessionTrackingIntoHtml(page, LIST);
    expect(out).toMatch(/<html>\s*<head>[\s\S]*<\/head><body><header>/);
  });
});
