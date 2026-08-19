/**
 * ENG-1328 — what the platform TELLS v0 to do.
 *
 * The helper accepting a googleAds parameter is only half of AC3; nothing fires unless
 * the prompt instructs v0 to pass it. These pin that instruction, and the invariant that
 * v0 is never asked to author a gtag call itself.
 */
import { buildBrandEnrichedPrompt } from '../services/v0Service';

const brand = { brandName: 'Acme' } as any;
const AW = 'AW-18192751758';
const LABEL = 'qAnwCOLmx-McEI65_eJD';
const ga = { conversionId: AW, conversionLabel: LABEL };
const build = (opts: { pixel?: string; bridge?: string; ga?: any; list?: string } = {}) =>
  buildBrandEnrichedPrompt('p', brand, opts.list ?? 'list1', undefined, opts.pixel, opts.bridge, opts.ga);

describe('buildBrandEnrichedPrompt — Google Ads instruction', () => {
  it('tells v0 to pass both halves into fireLeadTracking', () => {
    const p = build({ ga });
    expect(p).toContain(`googleAds: { conversionId: "${AW}", conversionLabel: "${LABEL}" }`);
    expect(p).toContain('fireLeadTracking');
  });

  it('emits the tracking block for a Google-Ads-only site', () => {
    // Before this, the block was gated on (pixel || bridgeOut), so a site whose only
    // tracking was Google Ads got no instruction at all and fired nothing.
    const p = build({ ga });
    expect(p).toContain('LEAD TRACKING — IMPORTANT ARCHITECTURE');
    expect(p).toContain('crypto.randomUUID()');
  });

  it('forbids hand-authored gtag calls, not just fbq', () => {
    const p = build({ ga });
    expect(p).toContain("gtag('event', ...)");
    expect(p).toContain("gtag('config', ...)");
  });

  it('says nothing about Google Ads when none is configured', () => {
    const p = build({ pixel: '123' });
    expect(p).not.toContain('googleAds:');
    expect(p).not.toContain(AW);
  });

  it('omits the pair when the label is missing — half a pair is worse than none', () => {
    // An id with no label fires a conversion matching no conversion action: reported as
    // fired, attributing nothing. Silence is the honest outcome.
    const p = build({ ga: { conversionId: AW, conversionLabel: '' } });
    expect(p).not.toContain('googleAds:');
    expect(p).not.toContain(AW);
  });

  it('omits the pair when the id is missing', () => {
    const p = build({ ga: { conversionId: '', conversionLabel: LABEL } });
    expect(p).not.toContain('googleAds:');
  });

  it('carries all three legs together when the site has everything', () => {
    const p = build({ pixel: '123456', bridge: 'https://cal.example/x', ga });
    expect(p).toContain('pixelId: "123456"');
    expect(p).toContain('googleAds: {');
    expect(p).toContain('bridgeOutUrl: "https://cal.example/x"');
  });

  it('emits no tracking block at all without a lead list', () => {
    // No form, nothing to fire on.
    const p = buildBrandEnrichedPrompt('p', brand, undefined, undefined, undefined, undefined, ga);
    expect(p).not.toContain('LEAD TRACKING — IMPORTANT ARCHITECTURE');
  });

  it('still tells v0 to import the helper it will need', () => {
    // The gate that decides this instruction MUST match the gate that ships
    // lib/agentweb-track.ts into the commit. If the instruction ships without the file,
    // the page fails its Vercel build outright with "Module not found".
    const p = build({ ga });
    expect(p).toContain('import { fireLeadTracking } from "@/lib/agentweb-track"');
  });
});
