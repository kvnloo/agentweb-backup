/**
 * ENG-449 — Auto-wire Meta Pixel + CAPI into Emma-generated landers.
 *
 * Mirrors ENG-334's GTM injection tests (`gtmInjection.test.ts`) 1:1. The Meta Pixel base
 * snippet (init + PageView) used to require a manual post-deploy step (there wasn't even
 * one — Pixel had zero support anywhere). Paid Meta campaigns hit freshly generated landers
 * with no pixel at all, so "0 conversions" was structurally unmeasurable (the RankAI/ENG-443
 * incident). The fix mirrors ENG-334 exactly: a shared, pure util run in the push path at
 * generation time, driven by the site's resolved `metaPixelId`. These tests pin the
 * behavioral contract for that util:
 *   1. Pixel is injected into the layout the site actually ships (v0's own layout.tsx).
 *   2. Injection is idempotent — a subpage inheriting the same root layout never duplicates it.
 *   3. The manual remove path (empty pixel id) still strips the block.
 *   4. No pixel id => no injection, no fallback pixel.
 *   5. Coexists with an existing GTM block without either injection corrupting the other.
 */

import {
  injectPixelIntoLayout,
  injectPixelIntoLayoutFiles,
  verifyPixelInjection,
} from '../utils/pixelInjection';
import { injectGtmIntoLayout } from '../utils/gtmInjection';

// A layout in the shape v0 actually emits — has both <head> and <body>.
const V0_LAYOUT = `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Compare", description: "" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body>{children}</body>
    </html>
  );
}
`;

describe('ENG-449 — injectPixelIntoLayout (shared util)', () => {
  it('injects the Meta Pixel base snippet for a configured pixel id', () => {
    const out = injectPixelIntoLayout(V0_LAYOUT, '1430870751246428');
    // fbq init carrying the customer's pixel id
    expect(out).toContain("fbq('init', '1430870751246428')");
    expect(out).toContain("fbq('track', 'PageView')");
    // noscript img fallback for the same pixel
    expect(out).toContain('https://www.facebook.com/tr?id=1430870751246428&ev=PageView&noscript=1');
    // preserved the original head content
    expect(out).toContain('rel="icon"');
  });

  it('is idempotent — re-injecting never duplicates the block', () => {
    const once = injectPixelIntoLayout(V0_LAYOUT, '1430870751246428');
    const twice = injectPixelIntoLayout(once, '1430870751246428');
    const thrice = injectPixelIntoLayout(twice, '1430870751246428');
    for (const out of [once, twice, thrice]) {
      expect(out.match(/fbq\('init',/g)).toHaveLength(1);
      expect(out.match(/facebook\.com\/tr\?id=/g)).toHaveLength(1);
    }
    expect(thrice).toBe(twice);
  });

  it('inserts the snippet before <body> when the layout has no <head>', () => {
    const noHead = V0_LAYOUT.replace(/<head>[\s\S]*?<\/head>\n/, '');
    const out = injectPixelIntoLayout(noHead, '1430870751246428');
    expect(out).toContain("fbq('init', '1430870751246428')");
    expect(out).toContain('https://www.facebook.com/tr?id=1430870751246428&ev=PageView&noscript=1');
  });

  it('an empty pixel id strips any existing block (manual remove path)', () => {
    const injected = injectPixelIntoLayout(V0_LAYOUT, '1430870751246428');
    const removed = injectPixelIntoLayout(injected, '');
    expect(removed).not.toContain('facebook.com');
    expect(removed).not.toContain('fbq(');
    expect(removed).toContain('rel="icon"'); // untouched original content survives
  });

  it('coexists with an existing GTM block without corrupting it (AC4 no-regression guard)', () => {
    const withGtm = injectGtmIntoLayout(V0_LAYOUT, 'GTM-ABCD1');
    const withBoth = injectPixelIntoLayout(withGtm, '1430870751246428');
    // GTM block untouched
    expect(withBoth).toContain("'GTM-ABCD1'");
    expect(withBoth.match(/gtm\.js\?id=/g)).toHaveLength(1);
    // Pixel block present too
    expect(withBoth).toContain("fbq('init', '1430870751246428')");
    expect(withBoth.match(/fbq\('init',/g)).toHaveLength(1);
  });
});

describe('ENG-449 — injectPixelIntoLayoutFiles (files array passed to the GitHub push)', () => {
  const filesWithV0Layout = () => [
    { path: 'app/page.tsx', content: Buffer.from('export default () => null;') },
    { path: 'app/layout.tsx', content: Buffer.from(V0_LAYOUT) },
  ];

  it('injects into the v0 layout in the files array and reports it installed', () => {
    const files = filesWithV0Layout();
    const injected = injectPixelIntoLayoutFiles(files, '1430870751246428');
    expect(injected).toBe(true);
    const layout = files.find((f) => f.path === 'app/layout.tsx')!.content.toString();
    expect(layout).toContain('https://www.facebook.com/tr?id=1430870751246428&ev=PageView&noscript=1');
  });

  it('does NOT inject and reports not-installed when there is no pixel id', () => {
    const files = filesWithV0Layout();
    const before = files.find((f) => f.path === 'app/layout.tsx')!.content.toString();
    expect(injectPixelIntoLayoutFiles(files, undefined)).toBe(false);
    expect(injectPixelIntoLayoutFiles(files, '')).toBe(false);
    const after = files.find((f) => f.path === 'app/layout.tsx')!.content.toString();
    expect(after).toBe(before); // untouched — no fallback pixel
    expect(after).not.toContain('facebook.com');
  });

  it('reports not-installed when there is no layout file to inject into', () => {
    const files = [{ path: 'app/page.tsx', content: Buffer.from('x') }];
    expect(injectPixelIntoLayoutFiles(files, '1430870751246428')).toBe(false);
  });

  it('reports NOT installed when the layout has neither <head> nor <body> to insert into', () => {
    const fragmentOnlyLayout = `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <>{children}</>;\n}\n`;
    const files = [
      { path: 'app/layout.tsx', content: Buffer.from(fragmentOnlyLayout) },
    ];
    const before = files[0].content.toString();
    const injected = injectPixelIntoLayoutFiles(files, '1430870751246428');
    expect(injected).toBe(false);
    // Must not silently ship a half-mutated file — untouched on verification failure.
    expect(files[0].content.toString()).toBe(before);
  });
});

describe('ENG-449 — injectPixelIntoLayout size guard (regex-safety hardening)', () => {
  it('leaves an oversized layout untouched instead of running the regex on it', () => {
    const huge = V0_LAYOUT + '// padding\n'.repeat(70_000); // well over 500KB
    expect(huge.length).toBeGreaterThan(500_000);
    const out = injectPixelIntoLayout(huge, '1430870751246428');
    expect(out).toBe(huge); // untouched — no insertion attempted, size guard tripped first
  });

  it('a layout right at the boundary (under the cap) still injects normally', () => {
    const padded = V0_LAYOUT + '// padding\n'.repeat(1000); // ~11KB, nowhere near 500KB
    const out = injectPixelIntoLayout(padded, '1430870751246428');
    expect(verifyPixelInjection(out, '1430870751246428')).toBe(true);
  });
});

describe('ENG-449 — verifyPixelInjection (fail loud, not silent, on a broken insert)', () => {
  it('is true for a normal successful injection', () => {
    const out = injectPixelIntoLayout(V0_LAYOUT, '1430870751246428');
    expect(verifyPixelInjection(out, '1430870751246428')).toBe(true);
  });

  it('is true for a normal successful removal (pixelId "")', () => {
    const injected = injectPixelIntoLayout(V0_LAYOUT, '1430870751246428');
    const removed = injectPixelIntoLayout(injected, '');
    expect(verifyPixelInjection(removed, '')).toBe(true);
  });

  it('is false when a pixelId was requested but nothing was actually inserted', () => {
    const fragmentOnlyLayout = `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <>{children}</>;\n}\n`;
    expect(verifyPixelInjection(fragmentOnlyLayout, '1430870751246428')).toBe(false);
  });

  it('is false when removal was requested but a Pixel block is still present', () => {
    const injected = injectPixelIntoLayout(V0_LAYOUT, '1430870751246428');
    expect(verifyPixelInjection(injected, '')).toBe(false);
  });

  it('is scoped to OUR delimiter markers, not fooled by unrelated pre-existing text', () => {
    const layoutWithUnrelatedMention = V0_LAYOUT.replace(
      '<link rel="icon" href="/favicon.ico" />',
      '<link rel="icon" href="/favicon.ico" /><p>We use facebook.com/tr?id=OTHER-THING for our own site</p>',
    );
    const out = injectPixelIntoLayout(layoutWithUnrelatedMention, '1430870751246428');
    expect(verifyPixelInjection(out, '1430870751246428')).toBe(true);
  });
});
