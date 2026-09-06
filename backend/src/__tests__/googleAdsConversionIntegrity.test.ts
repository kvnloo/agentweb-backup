/**
 * ENG-1524 + ENG-1525 — two ways a page ends up carrying a Google Ads tag that
 * reports nothing, both of which currently succeed silently.
 *
 * They share a failure shape: the base tag stays on the page, so RULE 7.5 keeps
 * passing and every indicator stays green, while the thing that actually records a
 * conversion is absent. Nothing in the system notices.
 */

import { validateGoogleAdsConversion } from '../services/v0Service';

const f = (content: string, path = 'app/page.tsx') => ({ path, content: Buffer.from(content, 'utf-8') });

describe('ENG-1524 — the generated form must actually ask for the conversion', () => {
  // The exact shape that motivated the ticket: pixelId present, googleAds omitted.
  // validatePixelLeadEvent passes on this, which is why it shipped unnoticed.
  it('rejects a fireLeadTracking call that omits googleAds', () => {
    const r = validateGoogleAdsConversion([
      f(`const onSubmit = async () => {
           const res = await fetch('/api/capture', { method: 'POST', body: JSON.stringify({ email, eventId }) });
           if (res.ok) await fireLeadTracking({ email, eventId, pixelId });
         };`),
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/googleAds/);
  });

  it('accepts the helper carrying the googleAds argument', () => {
    const r = validateGoogleAdsConversion([
      f(`if (res.ok) await fireLeadTracking({ email, eventId, pixelId, googleAds });`),
    ]);
    expect(r.ok).toBe(true);
  });

  // Older pages, and anything the coding agent wrote before the helper existed, fire
  // gtag directly. Tightening to only the new shape would fail them on the next
  // regeneration — the same reasoning validatePixelLeadEvent records for its OR.
  it('accepts a hand-authored gtag conversion', () => {
    const r = validateGoogleAdsConversion([
      f(`gtag('event', 'conversion', { send_to: 'AW-123456789/abcDEF' });`),
    ]);
    expect(r.ok).toBe(true);
  });

  it('rejects a page with no conversion call at all', () => {
    const r = validateGoogleAdsConversion([f(`export default function Page() { return <form/>; }`)]);
    expect(r.ok).toBe(false);
  });

  // The base tag is injected into layout.tsx deterministically, so its presence proves
  // nothing about whether a conversion is ever fired. That gap IS the bug.
  it('is not satisfied by the base tag alone', () => {
    const r = validateGoogleAdsConversion([
      f(`<script src={\`https://www.googletagmanager.com/gtag/js?id=AW-18192751758\`} />
         <script dangerouslySetInnerHTML={{ __html: \`gtag('config','AW-18192751758');\` }} />`,
        'app/layout.tsx'),
    ]);
    expect(r.ok).toBe(false);
  });

  it('only reads ts/tsx sources', () => {
    const r = validateGoogleAdsConversion([
      f(`fireLeadTracking({ googleAds })`, 'README.md'),
    ]);
    expect(r.ok).toBe(false);
  });
});
