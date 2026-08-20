/**
 * ENG-1328 — Google Ads base tag injection.
 *
 * Failure paths first (Rule 2, and this ticket's AC6). The happy path is the easy
 * half; every incident behind this module came from a shape the insertion could not
 * anchor on and reported success anyway.
 *
 * The collision cases matter more here than for Meta: GTM and gtag are both Google,
 * both load from googletagmanager.com, and a regex that is merely "about right"
 * silently eats the other one's block.
 */
import {
  injectGoogleAdsIntoLayout,
  verifyGoogleAdsInjection,
  injectGoogleAdsIntoLayoutFiles,
} from '../utils/googleAdsInjection';
import { injectGtmIntoLayout, verifyGtmInjection } from '../utils/gtmInjection';
import { injectPixelIntoLayout, verifyPixelInjection } from '../utils/pixelInjection';

const AW = 'AW-18192751758';
const LAYOUT_WITH_HEAD = `export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <title>Test</title>
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  )
}`;
const LAYOUT_NO_HEAD = `export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  )
}`;

describe('injectGoogleAdsIntoLayout — failure paths', () => {
  it('leaves an oversized layout untouched rather than running a regex over it', () => {
    const huge = `${LAYOUT_WITH_HEAD}\n${'x'.repeat(500_001)}`;
    expect(injectGoogleAdsIntoLayout(huge, AW)).toBe(huge);
  });

  it('reports not-installed for an oversized layout, rather than claiming success', () => {
    const huge = `${LAYOUT_WITH_HEAD}\n${'x'.repeat(500_001)}`;
    expect(verifyGoogleAdsInjection(injectGoogleAdsIntoLayout(huge, AW), AW)).toBe(false);
  });

  it('cannot anchor on a layout with neither <head> nor <body>, and says so', () => {
    // The exact silent-success shape verify exists to catch: the splice no-ops and
    // without the check the caller records "tracking installed" for a blind page.
    const shapeless = 'export default function Layout({ children }) { return children }';
    const out = injectGoogleAdsIntoLayout(shapeless, AW);
    expect(out).toBe(shapeless);
    expect(verifyGoogleAdsInjection(out, AW)).toBe(false);
  });

  it('verify fails when the block carries a different conversion id than requested', () => {
    const injected = injectGoogleAdsIntoLayout(LAYOUT_WITH_HEAD, 'AW-111111111');
    expect(verifyGoogleAdsInjection(injected, AW)).toBe(false);
  });

  it('verify fails on an empty layout', () => {
    expect(verifyGoogleAdsInjection('', AW)).toBe(false);
  });
});

describe('injectGoogleAdsIntoLayout — idempotence and removal (AC4)', () => {
  it('never yields two blocks when run twice', () => {
    const once = injectGoogleAdsIntoLayout(LAYOUT_WITH_HEAD, AW);
    const twice = injectGoogleAdsIntoLayout(once, AW);
    expect(twice).toBe(once);
    expect(twice.match(/\{\/\* Google Ads Tag \*\/\}/g)).toHaveLength(1);
    expect(verifyGoogleAdsInjection(twice, AW)).toBe(true);
  });

  it('replaces an existing id rather than appending a second block', () => {
    const old = injectGoogleAdsIntoLayout(LAYOUT_WITH_HEAD, 'AW-111111111');
    const swapped = injectGoogleAdsIntoLayout(old, AW);
    expect(swapped.match(/\{\/\* Google Ads Tag \*\/\}/g)).toHaveLength(1);
    expect(swapped).not.toContain('AW-111111111');
    expect(verifyGoogleAdsInjection(swapped, AW)).toBe(true);
  });

  it('an empty id removes the block cleanly and verifies as removed', () => {
    const injected = injectGoogleAdsIntoLayout(LAYOUT_WITH_HEAD, AW);
    const removed = injectGoogleAdsIntoLayout(injected, '');
    expect(removed).not.toContain('Google Ads Tag');
    expect(removed).not.toContain(AW);
    expect(verifyGoogleAdsInjection(removed, '')).toBe(true);
  });

  it('removal from a layout that never had a block is a no-op, not a corruption', () => {
    expect(injectGoogleAdsIntoLayout(LAYOUT_WITH_HEAD, '')).toBe(LAYOUT_WITH_HEAD);
  });
});

describe('injectGoogleAdsIntoLayout — anchoring', () => {
  it('installs inside <head> when one exists', () => {
    const out = injectGoogleAdsIntoLayout(LAYOUT_WITH_HEAD, AW);
    expect(out.indexOf('Google Ads Tag')).toBeGreaterThan(out.indexOf('<head>'));
    expect(out.indexOf('Google Ads Tag')).toBeLessThan(out.indexOf('</head>'));
    expect(verifyGoogleAdsInjection(out, AW)).toBe(true);
  });

  it('falls back to before <body> when the layout has no <head>', () => {
    const out = injectGoogleAdsIntoLayout(LAYOUT_NO_HEAD, AW);
    expect(verifyGoogleAdsInjection(out, AW)).toBe(true);
    expect(out.indexOf('Google Ads Tag')).toBeLessThan(out.indexOf('<body'));
  });

  it('emits both the loader and the config call for the id', () => {
    // A loader without a config call defines gtag but configures nothing, so the
    // conversion never has a destination — and RULE 7.5 would still see "AW-".
    const out = injectGoogleAdsIntoLayout(LAYOUT_WITH_HEAD, AW);
    expect(out).toContain(`googletagmanager.com/gtag/js?id=${AW}`);
    expect(out).toContain(`gtag('config', '${AW}')`);
  });
});

describe('coexistence with GTM and Meta — neither may eat the other (AC4/AC5)', () => {
  it('does not disturb an existing GTM block, and GTM does not disturb it', () => {
    // Both are Google and both load googletagmanager.com. Delimiter scoping is the
    // only thing keeping them apart.
    let content = injectGtmIntoLayout(LAYOUT_WITH_HEAD, 'GTM-ABCD123');
    content = injectGoogleAdsIntoLayout(content, AW);
    expect(verifyGtmInjection(content, 'GTM-ABCD123')).toBe(true);
    expect(verifyGoogleAdsInjection(content, AW)).toBe(true);
  });

  it('survives GTM being re-injected on top of it', () => {
    let content = injectGoogleAdsIntoLayout(LAYOUT_WITH_HEAD, AW);
    content = injectGtmIntoLayout(content, 'GTM-ABCD123');
    expect(verifyGoogleAdsInjection(content, AW)).toBe(true);
    expect(verifyGtmInjection(content, 'GTM-ABCD123')).toBe(true);
  });

  it('removing the Google Ads tag leaves GTM and Meta intact', () => {
    let content = injectGtmIntoLayout(LAYOUT_WITH_HEAD, 'GTM-ABCD123');
    content = injectPixelIntoLayout(content, '123456789');
    content = injectGoogleAdsIntoLayout(content, AW);
    content = injectGoogleAdsIntoLayout(content, '');
    expect(verifyGtmInjection(content, 'GTM-ABCD123')).toBe(true);
    expect(verifyPixelInjection(content, '123456789')).toBe(true);
    expect(verifyGoogleAdsInjection(content, '')).toBe(true);
  });

  it('all three coexist in one layout', () => {
    let content = injectGtmIntoLayout(LAYOUT_WITH_HEAD, 'GTM-ABCD123');
    content = injectPixelIntoLayout(content, '123456789');
    content = injectGoogleAdsIntoLayout(content, AW);
    expect(verifyGtmInjection(content, 'GTM-ABCD123')).toBe(true);
    expect(verifyPixelInjection(content, '123456789')).toBe(true);
    expect(verifyGoogleAdsInjection(content, AW)).toBe(true);
  });

  it('is not fooled by marketing copy that mentions googletagmanager', () => {
    // Why the delimiters exist: a bare substring search would match this.
    const copy = LAYOUT_WITH_HEAD.replace(
      '<title>Test</title>',
      '<title>We load googletagmanager.com/gtag/js?id=AW-99999999 for you</title>',
    );
    expect(verifyGoogleAdsInjection(copy, 'AW-99999999')).toBe(false);
  });
});

describe('injectGoogleAdsIntoLayoutFiles', () => {
  const files = () => [
    { path: 'app/layout.tsx', content: Buffer.from(LAYOUT_WITH_HEAD, 'utf-8') },
    { path: 'app/page.tsx', content: Buffer.from('export default function P(){return null}', 'utf-8') },
  ];

  it('returns false and writes nothing when no conversion id is configured', () => {
    const f = files();
    expect(injectGoogleAdsIntoLayoutFiles(f, undefined)).toBe(false);
    expect(f[0].content.toString('utf-8')).toBe(LAYOUT_WITH_HEAD);
  });

  it('returns false when the file set has no layout at all', () => {
    const f = [{ path: 'app/page.tsx', content: Buffer.from('x', 'utf-8') }];
    expect(injectGoogleAdsIntoLayoutFiles(f, AW)).toBe(false);
  });

  it('leaves the file untouched when verification fails, rather than half-writing', () => {
    const f = [{ path: 'app/layout.tsx', content: Buffer.from('no anchors here', 'utf-8') }];
    expect(injectGoogleAdsIntoLayoutFiles(f, AW)).toBe(false);
    expect(f[0].content.toString('utf-8')).toBe('no anchors here');
  });

  it('injects into a nested layout path and reports true', () => {
    const f = [{ path: 'some/prefix/app/layout.tsx', content: Buffer.from(LAYOUT_WITH_HEAD, 'utf-8') }];
    expect(injectGoogleAdsIntoLayoutFiles(f, AW)).toBe(true);
    expect(verifyGoogleAdsInjection(f[0].content.toString('utf-8'), AW)).toBe(true);
  });

  it('mutates the layout in place and touches no other file', () => {
    const f = files();
    expect(injectGoogleAdsIntoLayoutFiles(f, AW)).toBe(true);
    expect(verifyGoogleAdsInjection(f[0].content.toString('utf-8'), AW)).toBe(true);
    expect(f[1].content.toString('utf-8')).toBe('export default function P(){return null}');
  });
});

describe('conversionId is untrusted input spliced into generated source (CodeRabbit, #2481)', () => {
  // Reproduced before fixing: injectGoogleAdsIntoLayout('...', 'AW-1`); alert(1); //')
  // emitted a layout containing alert(1). The value is interpolated into a JSX template
  // literal AND into dangerouslySetInnerHTML, so a backtick, ${ or quote terminates the
  // literal and lands arbitrary code on the customer's deployed page.
  //
  // The route validates the format, but the module is also called from the generation and
  // sub-page paths with whatever the site record holds — so the guard belongs here, at
  // the point the string becomes source code, not only at one caller.

  const hostile = [
    'AW-1`); alert(1); //',
    'AW-1${alert(1)}',
    "AW-1'); alert(1); //",
    'AW-1</script><script>alert(1)</script>',
    'AW-1"; alert(1); //',
  ];

  it.each(hostile)('leaves the layout untouched for %j', (bad) => {
    expect(injectGoogleAdsIntoLayout(LAYOUT_WITH_HEAD, bad)).toBe(LAYOUT_WITH_HEAD);
  });

  it.each(hostile)('never emits the payload for %j', (bad) => {
    expect(injectGoogleAdsIntoLayout(LAYOUT_WITH_HEAD, bad)).not.toContain('alert(1)');
  });

  it.each(hostile)('reports not-installed for %j rather than claiming success', (bad) => {
    expect(verifyGoogleAdsInjection(injectGoogleAdsIntoLayout(LAYOUT_WITH_HEAD, bad), bad)).toBe(false);
  });

  it('refuses a well-formed-looking id that is too short', () => {
    // Matches RULE 7.5's own detector: AW- plus at least six digits.
    expect(injectGoogleAdsIntoLayout(LAYOUT_WITH_HEAD, 'AW-123')).toBe(LAYOUT_WITH_HEAD);
  });

  it('refuses a GTM container id in the Google Ads slot', () => {
    expect(injectGoogleAdsIntoLayout(LAYOUT_WITH_HEAD, 'GTM-ABCD123')).toBe(LAYOUT_WITH_HEAD);
  });

  it('does not strip an existing valid block when handed a hostile id', () => {
    // Strip-then-reinject would otherwise remove a working tag and refuse to replace it,
    // silently un-tracking a live page.
    const installed = injectGoogleAdsIntoLayout(LAYOUT_WITH_HEAD, AW);
    expect(injectGoogleAdsIntoLayout(installed, 'AW-1`); alert(1); //')).toBe(installed);
    expect(verifyGoogleAdsInjection(installed, AW)).toBe(true);
  });

  it('still allows the empty string, which is the documented removal path', () => {
    const installed = injectGoogleAdsIntoLayout(LAYOUT_WITH_HEAD, AW);
    expect(injectGoogleAdsIntoLayout(installed, '')).not.toContain('Google Ads Tag');
  });
});

describe('a tag we did not install is still a tag (ENG-1328 e2e finding)', () => {
  // Found by probing the real ENG-1182 lander before running the e2e. Its layout carries
  // a hand-written gtag under the comment "{/* Google tag (gtag.js) … */}" — not our
  // delimiter — so every check we had returned false and injection ADDED a second block.
  //
  // Same id: two gtag/js loaders on one page.
  // Different id: TWO DISTINCT AW ids firing from one page — the ENG-910 double-count
  // this guard exists to prevent, walked straight past because the guard only ever
  // looked for its own handiwork.
  const FOREIGN = LAYOUT_WITH_HEAD.replace(
    '<title>Test</title>',
    `<title>Test</title>
        {/* Google tag (gtag.js) — hand-installed by the customer */}
        <script async src="https://www.googletagmanager.com/gtag/js?id=AW-11112222333" />
        <script dangerouslySetInnerHTML={{ __html: \`gtag('config', 'AW-11112222333');\` }} />`,
  );

  it('refuses to add a DIFFERENT id alongside one already on the page', () => {
    expect(injectGoogleAdsIntoLayout(FOREIGN, AW)).toBe(FOREIGN);
  });

  it('never lets two distinct AW ids end up in one layout', () => {
    const out = injectGoogleAdsIntoLayout(FOREIGN, AW);
    expect([...new Set(out.match(/AW-[0-9]+/g) || [])]).toEqual(['AW-11112222333']);
  });

  it('reports not-installed for that refusal, so nothing claims success', () => {
    expect(verifyGoogleAdsInjection(injectGoogleAdsIntoLayout(FOREIGN, AW), AW)).toBe(false);
  });

  it('treats a hand-written tag carrying OUR id as already installed', () => {
    // The page is genuinely measurable with the right id. Refusing here would report
    // not-installed for a tracked page and have RULE 7.5 block a launch that is fine.
    const ours = LAYOUT_WITH_HEAD.replace(
      '<title>Test</title>',
      `<title>Test</title>
        <script async src="https://www.googletagmanager.com/gtag/js?id=${AW}" />
        <script dangerouslySetInnerHTML={{ __html: \`gtag('config', '${AW}');\` }} />`,
    );
    expect(injectGoogleAdsIntoLayout(ours, AW)).toBe(ours);
    expect(verifyGoogleAdsInjection(ours, AW)).toBe(true);
  });

  it('does not duplicate the loader when our id is already hand-written', () => {
    const ours = LAYOUT_WITH_HEAD.replace(
      '<title>Test</title>',
      `<title>Test</title>
        <script async src="https://www.googletagmanager.com/gtag/js?id=${AW}" />
        <script dangerouslySetInnerHTML={{ __html: \`gtag('config', '${AW}');\` }} />`,
    );
    const out = injectGoogleAdsIntoLayout(ours, AW);
    expect((out.match(/gtag\/js\?id=/g) || []).length).toBe(1);
  });

  it('still lets removal clear OUR block even when a foreign tag is present', () => {
    // Removal must stay possible; we just must not touch markup we did not write.
    const mixed = injectGoogleAdsIntoLayout(LAYOUT_WITH_HEAD, AW).replace(
      '<title>Test</title>',
      `<title>Test</title>
        <script async src="https://www.googletagmanager.com/gtag/js?id=AW-11112222333" />`,
    );
    const out = injectGoogleAdsIntoLayout(mixed, '');
    expect(out).not.toContain('Google Ads Tag');
    expect(out).toContain('AW-11112222333');
  });
});
