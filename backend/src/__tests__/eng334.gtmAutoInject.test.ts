/**
 * ENG-334 — Emma-generated landers ship with zero conversion tracking.
 *
 * The GTM head+noscript snippet used to be injected ONLY by a manual post-deploy "Add GTM"
 * step (saveGtmForPage). Paid traffic hit freshly generated landers with no tag at all, so
 * "0 conversions" was structurally unmeasurable.
 *
 * The fix extracts the injection logic into a shared, pure util and runs it in the push path
 * at generation time, driven by the site's saved `gtmContainerId`. These tests pin the
 * behavioral contract for that util:
 *   1. GTM is injected into the layout the site actually ships (v0's own layout.tsx).
 *   2. Injection is idempotent — a subpage inheriting the same root layout never duplicates it.
 *   3. The manual remove path (empty container id) still strips the block.
 *   4. No container id => no injection, no platform-GA4 fallback.
 */

import {
  injectGtmIntoLayout,
  injectGtmIntoLayoutFiles,
} from '../utils/gtmInjection';

// A layout in the shape v0 actually emits — has both <head> and <body>. This is the
// "common case the current fallback misses" (criterion 1).
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

describe('ENG-334 — injectGtmIntoLayout (shared util)', () => {
  it('injects the GTM head + noscript snippets for a configured container', () => {
    const out = injectGtmIntoLayout(V0_LAYOUT, 'GTM-ABCD1');
    // gtm.js loader in <head>, carrying the customer's container id
    expect(out).toContain("https://www.googletagmanager.com/gtm.js?id='+i");
    expect(out).toContain("'GTM-ABCD1'");
    // noscript iframe fallback for the same container
    expect(out).toContain('https://www.googletagmanager.com/ns.html?id=GTM-ABCD1');
    // preserved the original head content
    expect(out).toContain('rel="icon"');
  });

  it('is idempotent — re-injecting never duplicates the block (criterion 5 / subpage inherit)', () => {
    const once = injectGtmIntoLayout(V0_LAYOUT, 'GTM-ABCD1');
    const twice = injectGtmIntoLayout(once, 'GTM-ABCD1');
    const thrice = injectGtmIntoLayout(twice, 'GTM-ABCD1');
    // never duplicated — exactly one head loader and one noscript, no matter how many runs
    for (const out of [once, twice, thrice]) {
      expect(out.match(/gtm\.js\?id=/g)).toHaveLength(1);
      expect(out.match(/ns\.html\?id=/g)).toHaveLength(1);
    }
    // reaches a stable fixpoint (any whitespace normalization settles after the first re-run)
    expect(thrice).toBe(twice);
  });

  it('inserts the head snippet before <body> when the layout has no <head>', () => {
    const noHead = V0_LAYOUT.replace(/<head>[\s\S]*?<\/head>\n/, '');
    const out = injectGtmIntoLayout(noHead, 'GTM-ABCD1');
    expect(out).toContain("https://www.googletagmanager.com/gtm.js?id='+i");
    expect(out).toContain('https://www.googletagmanager.com/ns.html?id=GTM-ABCD1');
  });

  it('an empty container id strips any existing block (manual remove path)', () => {
    const injected = injectGtmIntoLayout(V0_LAYOUT, 'GTM-ABCD1');
    const removed = injectGtmIntoLayout(injected, '');
    expect(removed).not.toContain('googletagmanager.com');
    expect(removed).toContain('rel="icon"'); // untouched original content survives
  });
});

describe('ENG-334 — injectGtmIntoLayoutFiles (files array passed to the GitHub push)', () => {
  const filesWithV0Layout = () => [
    { path: 'app/page.tsx', content: Buffer.from('export default () => null;') },
    { path: 'app/layout.tsx', content: Buffer.from(V0_LAYOUT) },
  ];

  it('injects into the v0 layout in the files array and reports it installed', () => {
    const files = filesWithV0Layout();
    const injected = injectGtmIntoLayoutFiles(files, 'GTM-ABCD1');
    expect(injected).toBe(true);
    const layout = files.find((f) => f.path === 'app/layout.tsx')!.content.toString();
    expect(layout).toContain('https://www.googletagmanager.com/ns.html?id=GTM-ABCD1');
  });

  it('does NOT inject and reports not-installed when there is no container id', () => {
    const files = filesWithV0Layout();
    const before = files.find((f) => f.path === 'app/layout.tsx')!.content.toString();
    expect(injectGtmIntoLayoutFiles(files, undefined)).toBe(false);
    expect(injectGtmIntoLayoutFiles(files, '')).toBe(false);
    const after = files.find((f) => f.path === 'app/layout.tsx')!.content.toString();
    expect(after).toBe(before); // untouched — no platform-GA4 fallback
    expect(after).not.toContain('googletagmanager.com');
  });

  it('reports not-installed when there is no layout file to inject into', () => {
    const files = [{ path: 'app/page.tsx', content: Buffer.from('x') }];
    expect(injectGtmIntoLayoutFiles(files, 'GTM-ABCD1')).toBe(false);
  });
});
