/**
 * ENG-449 — validatePixelLeadEvent.
 *
 * Checks whether v0's generated form component actually fires the Meta Pixel Lead event on
 * submit, per the prompt instruction added to buildBrandEnrichedPrompt. Unlike
 * validateV0Output this can only be verified, not guaranteed — v0 authors the form freeform,
 * there is no platform-owned seam to inject the call into.
 */

import { validatePixelLeadEvent } from '../services/v0Service';

describe('ENG-449 — validatePixelLeadEvent', () => {
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
});
