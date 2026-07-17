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
  verifyGtmInjection,
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

  // A malformed layout with neither <head> nor <body> — a real, if rare, shape v0's
  // unbounded generation could produce (e.g. a fragment-only component). Both insertion
  // branches in injectGtmIntoLayout no-op on this input, so nothing is actually injected —
  // but the OLD injectGtmIntoLayoutFiles returned `true` regardless, purely because a
  // layout.tsx file existed and a containerId was supplied. That's a false "installed"
  // signal: trackingInstalled=true gets persisted for a page that shipped with zero tracking.
  it('reports NOT installed when the layout has neither <head> nor <body> to insert into', () => {
    const fragmentOnlyLayout = `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <>{children}</>;\n}\n`;
    const files = [
      { path: 'app/layout.tsx', content: Buffer.from(fragmentOnlyLayout) },
    ];
    const before = files[0].content.toString();
    const injected = injectGtmIntoLayoutFiles(files, 'GTM-ABCD1');
    expect(injected).toBe(false);
    // Must not silently ship a half-mutated file — untouched on verification failure.
    expect(files[0].content.toString()).toBe(before);
  });
});

describe('ENG-334 — injectGtmIntoLayout size guard (regex-safety hardening)', () => {
  // A real Next.js layout.tsx is a few KB. GitHub's own Contents API caps single-file writes
  // at 1MB (see CONTENTS_API_LIMIT in landingPageGeneration.ts). The non-greedy [\s\S]*? used
  // to strip/locate GTM blocks isn't catastrophic-backtracking-prone (a single wildcard between
  // two literal anchors, not nested/ambiguous quantifiers), but there's no reason to ever run
  // it against an unbounded blob — bail out before touching the regex at all.
  it('leaves an oversized layout untouched instead of running the regex on it', () => {
    // Padded with a real <head>/<body> layout so injection WOULD normally succeed —
    // isolates the guard's own effect from the separate "no anchor to insert into" case.
    const huge = V0_LAYOUT + '// padding\n'.repeat(70_000); // well over 500KB
    expect(huge.length).toBeGreaterThan(500_000);
    const out = injectGtmIntoLayout(huge, 'GTM-ABCD1');
    expect(out).toBe(huge); // untouched — no insertion attempted, size guard tripped first
  });

  it('a layout right at the boundary (under the cap) still injects normally', () => {
    // Padding comfortably under the cap so this isn't a boundary-off-by-one test —
    // just confirms the guard doesn't clip legitimate, realistically-sized layouts.
    const padded = V0_LAYOUT + '// padding\n'.repeat(1000); // ~11KB, nowhere near 500KB
    const out = injectGtmIntoLayout(padded, 'GTM-ABCD1');
    expect(verifyGtmInjection(out, 'GTM-ABCD1')).toBe(true);
  });
});

describe('ENG-334 — verifyGtmInjection (fail loud, not silent, on a broken insert)', () => {
  it('is true for a normal successful injection', () => {
    const out = injectGtmIntoLayout(V0_LAYOUT, 'GTM-ABCD1');
    expect(verifyGtmInjection(out, 'GTM-ABCD1')).toBe(true);
  });

  it('is true for a normal successful removal (containerId "")', () => {
    const injected = injectGtmIntoLayout(V0_LAYOUT, 'GTM-ABCD1');
    const removed = injectGtmIntoLayout(injected, '');
    expect(verifyGtmInjection(removed, '')).toBe(true);
  });

  it('is false when a containerId was requested but nothing was actually inserted', () => {
    // Simulates the fragment-only-layout case: injectGtmIntoLayout no-ops, content unchanged.
    const fragmentOnlyLayout = `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <>{children}</>;\n}\n`;
    expect(verifyGtmInjection(fragmentOnlyLayout, 'GTM-ABCD1')).toBe(false);
  });

  it('is false when removal was requested but a GTM block is still present', () => {
    const injected = injectGtmIntoLayout(V0_LAYOUT, 'GTM-ABCD1');
    // Removal was supposed to happen but didn't (simulated by NOT running the strip).
    expect(verifyGtmInjection(injected, '')).toBe(false);
  });

  it('is scoped to OUR delimiter markers, not fooled by unrelated pre-existing text', () => {
    // A layout whose own (unrelated) content happens to mention the exact loader URL string —
    // e.g. v0-generated marketing copy about analytics tooling. A naive whole-file substring
    // count would see 2 occurrences and wrongly report failure on a real, correct injection.
    const layoutWithUnrelatedMention = V0_LAYOUT.replace(
      '<link rel="icon" href="/favicon.ico" />',
      '<link rel="icon" href="/favicon.ico" /><p>We use gtm.js?id=OTHER-THING for our own site</p>',
    );
    const out = injectGtmIntoLayout(layoutWithUnrelatedMention, 'GTM-ABCD1');
    expect(verifyGtmInjection(out, 'GTM-ABCD1')).toBe(true);
  });
});
