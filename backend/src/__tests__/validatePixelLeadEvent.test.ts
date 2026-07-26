/**
 * Checks whether v0's generated form component actually fires the Meta Pixel Lead event on
 * submit, per the prompt instruction added to buildBrandEnrichedPrompt. Unlike
 * validateV0Output this can only be verified, not guaranteed — v0 authors the form freeform,
 * there is no platform-owned seam to inject the call into.
 */

import { validatePixelLeadEvent } from '../services/v0Service';

describe('validatePixelLeadEvent', () => {
  it('fails when no fbq Lead call exists anywhere in the generated .tsx files', () => {
    const files = [
      { path: 'app/page.tsx', content: Buffer.from('export default function Page() { return <div>hi</div>; }') },
    ];
    const result = validatePixelLeadEvent(files);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("fbq");
  });

  it('fails when fbq is called with a different event name (e.g. PageView, not Lead)', () => {
    const files = [
      { path: 'app/page.tsx', content: Buffer.from(`fbq('track', 'PageView');`) },
    ];
    expect(validatePixelLeadEvent(files).ok).toBe(false);
  });

  it('fails when only .css/.json files are present (no .tsx/.ts at all)', () => {
    const files = [
      { path: 'app/globals.css', content: Buffer.from(`fbq('track', 'Lead');`) },
    ];
    expect(validatePixelLeadEvent(files).ok).toBe(false);
  });

  it('passes when a .tsx file calls fbq(\'track\',\'Lead\')', () => {
    const files = [
      { path: 'app/components/LeadForm.tsx', content: Buffer.from(`window.fbq && window.fbq('track', 'Lead', {}, { eventID: eventId });`) },
    ];
    expect(validatePixelLeadEvent(files).ok).toBe(true);
  });

  it('passes when the call uses single or double quotes interchangeably', () => {
    const files = [
      { path: 'app/components/LeadForm.tsx', content: Buffer.from(`fbq("track", "Lead");`) },
    ];
    expect(validatePixelLeadEvent(files).ok).toBe(true);
  });

  it('passes when the call is in a plain .ts file, not just .tsx', () => {
    const files = [
      { path: 'lib/track.ts', content: Buffer.from(`export const fireLead = () => fbq('track', 'Lead');`) },
    ];
    expect(validatePixelLeadEvent(files).ok).toBe(true);
  });

  // ENG-449 follow-up: v0 is now instructed to call the platform-owned fireLeadTracking()
  // helper instead of hand-authoring fbq() (see buildTrackingHelper/buildBrandEnrichedPrompt).
  // Both patterns must keep validating true — an EXISTING page generated before this change
  // still ships the old inline fbq() code and must not start reporting
  // pixelLeadEventVerified:false on a later re-validation (e.g. iterateLandingPage) just
  // because the check got stricter. This is the explicit no-regression requirement.
  it('passes when the form calls fireLeadTracking({ pixelId: ... }) instead of writing fbq() itself (new pattern)', () => {
    const files = [
      {
        path: 'app/components/LeadForm.tsx',
        content: Buffer.from(`await fireLeadTracking({ email, eventId, pixelId: "1430870751246428" });`),
      },
    ];
    expect(validatePixelLeadEvent(files).ok).toBe(true);
  });

  it('still fails when fireLeadTracking is called WITHOUT a pixelId (pixel not actually wired)', () => {
    const files = [
      { path: 'app/components/LeadForm.tsx', content: Buffer.from(`await fireLeadTracking({ email, bridgeOutUrl: "https://x.com" });`) },
    ];
    expect(validatePixelLeadEvent(files).ok).toBe(false);
  });
});
