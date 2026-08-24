/**
 * ENG-1527 — the two AW/GA4 detectors read different inputs, so their correct scopes run
 * in OPPOSITE directions. Both halves were wrong before this change, in opposite ways.
 *
 *   RULE 7.5's gate reads SERVED HTML and must be NARROWED: an id in rendered body text is
 *   prose, and treating it as a tag passes a launch for a page that fires nothing.
 *
 *   The injector's guard reads layout.tsx SOURCE and must be WIDENED: an id in a module
 *   const is live code, and missing it double-counts conversions (ENG-910).
 *
 * A single shared rule cannot satisfy both. This suite pins each direction, and pins the
 * boundary that stops either fix from overshooting into the other's failure mode.
 */
import { detectTrackingSnippets } from '../services/googleAdsTrackingPreflight';
import { injectGoogleAdsIntoLayout, verifyGoogleAdsInjection } from '../utils/googleAdsInjection';

const LAYOUT = `export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head><title>Test</title></head>
      <body>{children}</body>
    </html>
  );
}`;

describe('ENG-1527 gate (served HTML) — narrowed to markup', () => {
  it('does not treat a conversion id in body copy as a working tag', () => {
    // Pre-fix this returned ['AW:AW-11112222333'] and the page passed RULE 7.5 while
    // firing nothing — the ENG-334 failure mode arriving through the AW door.
    const html = '<html><body><p>Ask your rep for conversion id AW-11112222333.</p></body></html>';
    expect(detectTrackingSnippets(html)).toEqual([]);
  });

  it('does not treat a GA4 id in body copy as a working tag', () => {
    const html = '<html><body><p>Our measurement id is G-KKJE0Q33LF, ask support.</p></body></html>';
    expect(detectTrackingSnippets(html)).toEqual([]);
  });

  it('still detects an id carried only by a <link rel=preload>, not a <script>', () => {
    // Taken from live www.agentweb.pro. Narrowing the gate to <script> elements — the
    // obvious fix — would have false-BLOCKED our own correctly tagged marketing site.
    const html =
      '<html><head><link rel="preload" as="script" ' +
      'href="https://www.googletagmanager.com/gtag/js?id=G-KKJE0Q33LF"/></head><body>hi</body></html>';
    expect(detectTrackingSnippets(html)).toContain('GA4:G-KKJE0Q33LF');
  });

  it('still detects an id inside an attribute of a self-closing tag', () => {
    const html = '<html><body><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-ABCD123"/></body></html>';
    expect(detectTrackingSnippets(html)).toContain('GTM:GTM-ABCD123');
  });

  it('still detects an id inside a <script> body', () => {
    const html = `<html><head><script>gtag('config', 'AW-123456789');</script></head></html>`;
    expect(detectTrackingSnippets(html)).toContain('AW:AW-123456789');
  });

  it('falls back to raw text when the response carries no markup at all', () => {
    // A bare script body or JSON payload is not an HTML document. Narrowing it to nothing
    // would report "no tag" for a response that may well carry one — the wrong direction
    // for a gate that must refuse launches it cannot vouch for.
    expect(detectTrackingSnippets(`gtag('config', 'AW-123456789');`)).toContain('AW:AW-123456789');
  });
});

describe('ENG-1527 injector guard (layout source) — widened to whole file', () => {
  it('refuses to inject when a foreign id is held in a module const', () => {
    // The ordinary App Router shape: the id is nowhere near a <script> literal, so the
    // pre-fix script-scoped guard saw nothing, injected ours, and shipped TWO distinct AW
    // ids on one page. That is ENG-910 walked past a second time.
    const withConst =
      `const GA_ADS_ID = "AW-11112222333";\n` +
      'export const metadata = {};\n' +
      LAYOUT.replace(
        '<body>',
        '<body><Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ADS_ID}`} />',
      );

    const out = injectGoogleAdsIntoLayout(withConst, 'AW-99999999');
    expect(out).toBe(withConst);
    expect(out).not.toContain('Google Ads Tag');
    expect(out).not.toContain('AW-99999999');
  });

  it('still injects into a layout that carries no Google Ads id at all', () => {
    const out = injectGoogleAdsIntoLayout(LAYOUT, 'AW-99999999');
    expect(out).toContain('AW-99999999');
    expect(out).toContain('Google Ads Tag');
  });

  it('leaves a layout alone when the const already holds the id we were asked to install', () => {
    // Refusing here would mark a measurable page untracked and have RULE 7.5 block a
    // launch that is perfectly fine.
    const already = `const ID = "AW-99999999";\n` + LAYOUT;
    expect(injectGoogleAdsIntoLayout(already, 'AW-99999999')).toBe(already);
  });
});

describe('ENG-1527 verify (layout source) — deliberately NOT widened with the guard', () => {
  it('does not report marketing copy in a <title> as an installed tag', () => {
    // Widening verify alongside the guard regressed exactly this: an id in copy would
    // read as installed, handing RULE 7.5 a pass for a page that fires nothing.
    const copy = LAYOUT.replace(
      '<title>Test</title>',
      '<title>We load googletagmanager.com/gtag/js?id=AW-99999999 for you</title>',
    );
    expect(verifyGoogleAdsInjection(copy, 'AW-99999999')).toBe(false);
  });

  it('does not report a const-held id as installed, so injection is attempted and refused', () => {
    // The safe answer. Verify says no -> we try to inject -> the wide guard refuses ->
    // a human looks. Nothing is double-counted and nothing is silently blessed.
    const withConst = `const ID = "AW-11112222333";\n` + LAYOUT;
    expect(verifyGoogleAdsInjection(withConst, 'AW-11112222333')).toBe(false);
  });

  it('still reports a hand-written script tag carrying the id as installed', () => {
    const handWritten = LAYOUT.replace(
      '<head>',
      `<head><script async src="https://www.googletagmanager.com/gtag/js?id=AW-99999999"></script>`,
    );
    expect(verifyGoogleAdsInjection(handWritten, 'AW-99999999')).toBe(true);
  });
});
