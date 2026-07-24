/**
 * Checks whether v0's generated form component actually redirects to the configured
 * bridge-out URL with the submitted email forwarded, per the prompt instruction added to
 * buildBrandEnrichedPrompt. Unlike validateV0Output this can only be verified, not
 * guaranteed — v0 authors the form freeform, there is no platform-owned seam to inject the
 * redirect into.
 */

import { validateBridgeOutRedirect } from '../services/v0Service';

const BRIDGE_URL = 'https://rankai.ai/book-a-call';

describe('validateBridgeOutRedirect', () => {
  it('fails when the bridge-out URL does not appear anywhere in the generated .tsx files', () => {
    const files = [
      { path: 'app/page.tsx', content: Buffer.from('export default function Page() { return <div>hi</div>; }') },
    ];
    const result = validateBridgeOutRedirect(files, BRIDGE_URL);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Bridge-out URL');
  });

  it('fails when the URL is present but no email= query param forwarding was detected', () => {
    const files = [
      { path: 'app/components/LeadForm.tsx', content: Buffer.from(`window.location.href = "${BRIDGE_URL}";`) },
    ];
    const result = validateBridgeOutRedirect(files, BRIDGE_URL);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('email=');
  });

  it('fails when only .css/.json files are present (no .tsx/.ts at all)', () => {
    const files = [
      { path: 'app/globals.css', content: Buffer.from(`${BRIDGE_URL}?email=test`) },
    ];
    expect(validateBridgeOutRedirect(files, BRIDGE_URL).ok).toBe(false);
  });

  it('passes when a .tsx file redirects to the bridge-out URL with an email= param', () => {
    const files = [
      {
        path: 'app/components/LeadForm.tsx',
        content: Buffer.from(`window.location.href = \`${BRIDGE_URL}?email=\${encodeURIComponent(email)}\`;`),
      },
    ];
    expect(validateBridgeOutRedirect(files, BRIDGE_URL).ok).toBe(true);
  });

  it('passes when the redirect is in a plain .ts file, not just .tsx', () => {
    const files = [
      { path: 'lib/redirect.ts', content: Buffer.from(`export const bridgeOut = (email: string) => \`${BRIDGE_URL}?email=\${email}\`;`) },
    ];
    expect(validateBridgeOutRedirect(files, BRIDGE_URL).ok).toBe(true);
  });

  it('passes when the bridge-out URL already has its own query string and email is appended with &', () => {
    const urlWithQuery = 'https://rankai.ai/book-a-call?ref=lp';
    const files = [
      { path: 'app/components/LeadForm.tsx', content: Buffer.from(`window.location.href = "${urlWithQuery}&email=" + encodeURIComponent(email);`) },
    ];
    expect(validateBridgeOutRedirect(files, urlWithQuery).ok).toBe(true);
  });

  // ENG-449 follow-up: v0 is now instructed to call the platform-owned fireLeadTracking()
  // helper instead of hand-authoring the redirect (see buildTrackingHelper). Both patterns
  // must keep validating true — an EXISTING page generated before this change still ships
  // the old inline redirect code and must not start reporting bridgeOutVerified:false on a
  // later re-validation just because the check got stricter (explicit no-regression
  // requirement).
  it('passes when the form calls fireLeadTracking({ bridgeOutUrl: ... }) instead of writing the redirect itself (new pattern) — no literal email= required, fireLeadTracking guarantees it', () => {
    const files = [
      {
        path: 'app/components/LeadForm.tsx',
        content: Buffer.from(`await fireLeadTracking({ email, eventId, bridgeOutUrl: "${BRIDGE_URL}" });`),
      },
    ];
    expect(validateBridgeOutRedirect(files, BRIDGE_URL).ok).toBe(true);
  });

  it('still fails when fireLeadTracking is called but with a DIFFERENT bridgeOutUrl than the one configured', () => {
    const files = [
      { path: 'app/components/LeadForm.tsx', content: Buffer.from(`await fireLeadTracking({ email, bridgeOutUrl: "https://wrong-destination.com" });`) },
    ];
    expect(validateBridgeOutRedirect(files, BRIDGE_URL).ok).toBe(false);
  });
});
